/** GitLab source kind (gitlab.com or a self-hosted server): todo and note polling, replies as notes, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type ChannelRef, type OutboundMessage, type Trigger } from '../core/index.ts'
import { GitlabAccountsSchema, gitlabOf } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'

export const SOURCE = 'gitlab'
const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(15).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>

const UserSchema = z.looseObject({ username: z.string(), bot: z.boolean().nullish() })
/** A pending to-do of the agent account; `target` is the Issue or merge request and `body` the note or title that raised it. */
export const TodoSchema = z.looseObject({
  id: z.number(), action_name: z.string(), target_type: z.enum(['Issue', 'MergeRequest']), body: z.string().nullish(),
  target_url: z.string().nullish(), created_at: z.string(), author: UserSchema,
  project: z.looseObject({ path_with_namespace: z.string() }),
  target: z.looseObject({ iid: z.number(), title: z.string(), description: z.string().nullish(), web_url: z.string() }),
})
export type GitlabTodo = z.infer<typeof TodoSchema>
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), system: z.boolean().nullish(), author: UserSchema.nullish(),
  created_at: z.string(), updated_at: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>

/** Issues and merge requests number independently, so a Thread id names its kind: `issue-5`, `mr-5`. */
export type Kind = 'issue' | 'mr'
export const threadId = (kind: Kind, iid: number): string => `${kind}-${iid}`
const parseThread = (id: string): { kind: Kind; iid: number } | undefined => {
  const match = /^(issue|mr)-(\d+)$/.exec(id)
  return match ? { kind: match[1] as Kind, iid: Number(match[2]) } : undefined
}
const collection = (kind: Kind): string => kind === 'mr' ? 'merge_requests' : 'issues'
const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const channelOf = (kind: Kind, iid: number, url?: string | null): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${threadId(kind, iid)}`, address: { kind, iid: String(iid), ...url ? { url } : {} } })
const human = (user: z.infer<typeof UserSchema>, agent: string): boolean => !user.bot && !sameName(user.username, agent)

/** To-do actions that ask the agent for something: it was assigned, asked to review, or mentioned. */
const ACTIONS: Record<string, 'mention' | 'direct'> = { assigned: 'direct', review_requested: 'direct', mentioned: 'mention', directly_addressed: 'mention' }
/** The Trigger of one to-do; to-dos of other actions (such as `build_failed`) produce none. */
export function todoTrigger(todo: GitlabTodo, agent: string): Trigger | undefined {
  const addressed = ACTIONS[todo.action_name]
  if (!addressed || sameName(todo.author.username, agent)) return undefined
  const kind: Kind = todo.target_type === 'MergeRequest' ? 'mr' : 'issue'
  const { iid, title, description, web_url } = todo.target
  const opened = todo.action_name === 'assigned' || todo.action_name === 'review_requested'
  const url = todo.target_url ?? web_url
  return { id: key('gitlab-todo', String(todo.id)), source: SOURCE, threads: [{ source: SOURCE, id: threadId(kind, iid) }],
    actor: { source: SOURCE, id: todo.author.username }, human: human(todo.author, agent), addressed, at: todo.created_at,
    text: opened ? `${title}\n\n${description ?? ''}`.trim() : todo.body ?? title,
    channel: channelOf(kind, iid, url), url, meta: { kind, iid, todo: todo.id, action: todo.action_name } }
}
/** The Trigger of a note written on a subscribed Thread; system notes (label changes and the like) and the agent's own produce none. */
export function noteTrigger(note: GitlabNote, kind: Kind, iid: number, url: string, agent: string): Trigger | undefined {
  const body = note.body ?? ''
  if (note.system || !note.author || !body || sameName(note.author.username, agent)) return undefined
  const link = `${url}#note_${note.id}`
  return { id: key('gitlab-note', link, note.updated_at ?? note.created_at), source: SOURCE, threads: [{ source: SOURCE, id: threadId(kind, iid) }],
    actor: { source: SOURCE, id: note.author.username }, human: human(note.author, agent),
    ...mentions(body, agent) ? { addressed: 'mention' as const } : {}, at: note.updated_at ?? note.created_at, text: body,
    channel: channelOf(kind, iid, link), url: link, meta: { kind, iid, noteId: note.id } }
}

/** HTTP status of a failed `glab api` call: glab prints it as `404 Not Found`. */
const statusOf = (error: unknown): number | undefined =>
  error instanceof CliError ? error.code ?? (Number(/\b([45]\d\d)\b/.exec(error.message)?.[1]) || undefined) : undefined
/** Calls the GitLab API with the agent's glab; `path` is under `projects/<project>/` unless it is the to-do list or a to-do action. */
async function api<T>(commands: Commands, schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T> {
  const { cli, host, project } = gitlabOf(commands.deployment)
  if (/^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)) throw new Error('GitLab calls are restricted to the configured project')
  const endpoint = path.startsWith('todos') ? path : `projects/${encodeURIComponent(project)}/${path}`
  return schema.parse(JSON.parse(await commands.run(cli, ['api', '--hostname', host, endpoint, ...flags])))
}

/** Posts a note under an Issue or merge request, with an embedded marker so a retry does not post it twice. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { kind, iid } = message.channel.address
  if (!iid || (kind !== 'issue' && kind !== 'mr')) throw new Error('Missing GitLab reply target')
  const { login } = gitlabOf(commands.deployment)
  const notes = `${collection(kind)}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    // ponytail: only the newest 100 notes are searched for the marker; a retry after 100 later notes would post twice.
    const recent = await api(commands, z.array(NoteSchema), `${notes}?sort=desc&order_by=created_at&per_page=100`)
    if (recent.some(note => sameName(note.author?.username ?? '', login) && (note.body ?? '').includes(marker))) return 'sent'
    await api(commands, z.unknown(), notes, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    // Deleted (404) targets are not retried; a locked discussion answers 403.
    const status = statusOf(error)
    if (status === 404 || status === 410 || (status === 403 && error instanceof Error && /lock/i.test(error.message))) return 'gone'
    throw error
  }
}

const PAGE = 30
/** Reads a page of an Issue's or merge request's notes, or the Issue or merge request itself for the root. */
const gitlabThreadContext: SourceKind<GitlabConfig>['threadContext'] = {
  messageId: trigger => String(trigger.meta.noteId ?? ''),
  read: async (commands, trigger, part, cursor) => {
    const kind = trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    const base = `${collection(kind)}/${Number(trigger.meta.iid)}`
    if (part === 'parent') return { messages: [], body: { status: 'no_parent', messages: [] }, status: 'no_parent' }
    if (part === 'root') {
      const root = await api(commands, z.looseObject({ title: z.string(), description: z.string().nullish(), author: UserSchema,
        created_at: z.string(), web_url: z.string() }), base)
      const messages = [{ id: root.web_url, from: root.author.username, at: root.created_at, text: `${root.title}\n\n${root.description ?? ''}`.trim(),
        ...root.author.bot ? { bot: true as const } : {}, url: root.web_url }]
      return { messages, body: { messages } }
    }
    const page = Number(cursor ?? '1')
    const notes = (await api(commands, z.array(z.unknown()), `${base}/notes?sort=asc&order_by=created_at&per_page=${PAGE}&page=${page}`))
      .flatMap(item => NoteSchema.safeParse(item).data ?? [])
    const messages = notes.filter(note => !note.system && note.author).map(note => ({ id: String(note.id), from: note.author!.username,
      at: note.created_at, text: note.body ?? '', ...note.author!.bot ? { bot: true as const } : {} }))
    const next = notes.length >= PAGE ? String(page + 1) : undefined
    return { messages, ...next ? { next } : {}, body: { messages } }
  },
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号（gitlab.com 或自建的私有化服务器）；接收项目里指派、评审请求或 @ 它的待办，并轮询已订阅 Issue 与合并请求的讨论。', en: 'The agent\'s GitLab account (gitlab.com or a self-hosted server); receives the to-dos that assign, ask for review of, or mention it in the project, and polls the discussion of the Issues and merge requests it follows.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.\\-]+(:[0-9]+)?', label: { zh: 'GitLab 服务器', en: 'GitLab server' },
      hint: { zh: '主机名，例如 gitlab.com 或 gitlab.example.com（私有化部署写自己的域名）。通过 https 访问；保存时检查智能体账号，然后重启 dsh-superagent。', en: 'Host name, such as gitlab.com or gitlab.example.com (use your own domain for a self-hosted server). It is reached over https; saving checks the agent account and then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/name（可含子组）。这个来源接收这个项目的待办和讨论；保存时检查智能体账号能否推送到它（需要 Developer 角色）。', en: 'Written group/name (subgroups allowed). This Source receives the project\'s to-dos and discussions; saving checks that the agent account can push to it (the Developer role).' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 glab', en: 'Agent glab' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。', en: 'A command name or absolute path, usually a glab wrapper script signed in as the agent account with GLAB_CONFIG_DIR. The agent acts as the account it is signed in as; the Executor calls it as glab.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 15, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
  ],
  health: [SOURCE],
  // Everything the Source receives addresses the agent (to-dos) or follows a Thread it already works on.
  scope: () => ({ listened: true, observed: false }),
  channel: { send: sendGitlab, link: address => ({ url: address.url ?? '',
    label: address.kind === 'mr' ? { zh: `GitLab !${address.iid}`, en: `GitLab !${address.iid}` } : { zh: `GitLab #${address.iid}`, en: `GitLab #${address.iid}` } }) },
  threadContext: gitlabThreadContext,
  // `#12` is Issue 12, `!12` merge request 12, and the page of either names its Thread.
  find: query => {
    const text = query.trim()
    const web = /\/-\/(issues|merge_requests)\/(\d+)/.exec(text)
    const short = /^([#!])(\d+)$/.exec(text)
    const thread = web ? threadId(web[1] === 'issues' ? 'issue' : 'mr', Number(web[2])) : short ? threadId(short[1] === '!' ? 'mr' : 'issue', Number(short[2])) : undefined
    return { threads: thread ? [`${SOURCE}:${thread}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号 @ 智能体的账号，或把 Issue、合并请求指派给它。', en: 'An account on the list mentions the agent\'s account, or assigns an Issue or merge request to it.' },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 服务器的主机名；工单不用 GitLab 时为空', en: 'Host name of the GitLab server; empty when this installation does not use GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/name。glab 以智能体账号登录，GitLab 上的操作都用 glab', en: 'The project this Source listens to, group/name. glab is signed in as the agent account; use glab for GitLab operations' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号', en: 'The agent\'s GitLab account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或合并请求编号（iid）；工单不是从 GitLab 来的时为空', en: 'The iid of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 issue 还是 mr；工单不是从 GitLab 来的时为空', en: '`issue` or `mr`, whichever started the ticket; empty when the ticket did not start on GitLab' } },
    ],
    values: ({ deployment, trigger }) => {
      const own = trigger?.source === SOURCE
      return { DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: deployment.gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.noreply ?? '',
        DSH_SUPERAGENT_GITLAB_IID: own ? String(Number(trigger.meta.iid) || '') : '', DSH_SUPERAGENT_GITLAB_KIND: own ? String(trigger.meta.kind ?? '') : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}（${deployment.gitlab.host}）`, en: `Current account @${deployment.gitlab.login} on ${deployment.gitlab.host}` },
  } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (!config) ctx.report(SOURCE, health('paused', 'sourceOff'))
      else if (!ctx.deployment.gitlab) ctx.report(SOURCE, health('paused', 'gitlabUnset'))
      else await pollRound(ctx, signal)
      failures = 0
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 1)) {
        ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

/** One polling round: the agent's pending to-dos of the project, then the new notes of each Thread it follows. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<{ todos: number; notes: number }> {
  const started = new Date().toISOString()
  const commands = signal ? ctx.commands.withSignal(signal) : ctx.commands
  const { project, login } = gitlabOf(ctx.deployment)
  const stopped = () => !!signal?.aborted || !ctx.config(SOURCE)
  const tally: Tally = { skipped: 0 }
  const failures: string[] = []
  let todos = 0
  let notes = 0
  try {
    const listed = await api(commands, z.array(z.unknown()), 'todos?state=pending&per_page=100')
    for (const todo of validItems(TodoSchema, listed, tally)) {
      if (stopped()) throw new Error('The GitLab Source stopped during the poll')
      if (!sameName(todo.project.path_with_namespace, project)) continue
      const trigger = todoTrigger(todo, login)
      if (!trigger) continue
      await ctx.receive(trigger)
      todos += 1
      const { kind, iid } = trigger.meta as { kind: Kind; iid: number }
      ctx.threads.describe(`${SOURCE}:${threadId(kind, iid)}`, { label: todo.target.title, url: todo.target.web_url })
      // The to-do is answered once stored; a failure here only leaves it pending, and its stable id makes the replay a duplicate.
      await api(commands, z.unknown(), `todos/${todo.id}/mark_as_done`, '--method', 'POST').catch(() => undefined)
    }
  } catch (error) { if (!stopped()) failures.push(`to-dos: ${String(error)}`) }
  await pollEach(ctx, SOURCE, stopped, async thread => { notes += await pollNotes(ctx, commands, thread.key, login) })
    .catch((error: unknown) => { failures.push(String(error)) })
  if (failures.length) throw new Error(failures.slice(0, 3).join('; '))
  ctx.report(SOURCE, { state: 'ready', detail: `${todos} to-dos, ${notes} notes${tally.skipped ? `; ${tally.skipped} unreadable items skipped` : ''}`, at: started })
  return { todos, notes }
}
/** Takes in the notes of one followed Thread after its cursor; a Thread without a cursor starts from when it was opened. */
async function pollNotes(ctx: SourceContext, commands: Commands, threadKey: string, agent: string): Promise<number> {
  const id = threadKey.slice(SOURCE.length + 1)
  const ref = parseThread(id)
  if (!ref) return 0
  const cursor = KV.gitlab.cursor(id)
  const after = ctx.state.get(cursor)
  const since = ctx.threads.get(threadKey)?.createdAt
  const base = `${collection(ref.kind)}/${ref.iid}`
  const { host, project } = gitlabOf(ctx.deployment)
  const url = `https://${host}/${project}/-/${collection(ref.kind)}/${ref.iid}`
  const listed = await api(commands, z.array(z.unknown()), `${base}/notes?sort=asc&order_by=created_at&per_page=100`)
  let newest = after ?? 0
  let count = 0
  for (const note of validItems(NoteSchema, listed, { skipped: 0 })) {
    if (note.id <= (after ?? 0)) continue
    // Before the first read, only notes from the Thread's opening on count, so its history is not replayed.
    const fresh = after !== undefined || !since || Date.parse(note.created_at) >= Date.parse(cursorAt(since))
    newest = Math.max(newest, note.id)
    const trigger = fresh ? noteTrigger(note, ref.kind, ref.iid, url, agent) : undefined
    if (!trigger) continue
    await ctx.receive(trigger)
    count += 1
  }
  if (newest !== after) ctx.state.set(cursor, newest)
  return count
}
