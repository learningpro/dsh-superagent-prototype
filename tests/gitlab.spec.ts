import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { resolveDeployment, resolveGitlab, type Machine, type Probe } from '../src/deployment.ts'
import { writeEnvironment, workerGitConfig, workerBin } from '../src/infra/environment.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { gitlabKind, noteTrigger, pollRound, sendGitlab, todoTrigger, TodoSchema } from '../src/sources/gitlab.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SetupError } from '../src/setup.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const GITLAB = { cli: '/bin/true', host: 'git.example.com', project: 'team/widgets', login: 'agent-bot', noreply: '7-agent-bot@users.noreply.git.example.com' }
const todo = (id: number, over: Record<string, unknown> = {}) => ({ id, action_name: 'mentioned', target_type: 'Issue', body: '@agent-bot please fix it',
  target_url: `https://git.example.com/team/widgets/-/issues/12#note_${id}`, created_at: '2026-10-01T00:00:00Z', author: { username: 'alice' },
  project: { path_with_namespace: 'team/widgets' }, target: { iid: 12, title: 'Broken margin', description: 'It is off', web_url: 'https://git.example.com/team/widgets/-/issues/12' },
  ...over })
const note = (id: number, over: Record<string, unknown> = {}) => ({ id, body: 'looks wrong', system: false, author: { username: 'alice' }, created_at: '2026-10-01T00:00:10Z', ...over })

function host() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { gitlab: { enabled: true, config: { host: GITLAB.host, project: GITLAB.project, cli: GITLAB.cli } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'alice' }] } } } }))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const deployment = testDeployment({ repository: '', github: undefined, gitlab: GITLAB })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  return { ...sourceContextOf(deps, gitlabKind), store, engine, commands, receive }
}
type Host = ReturnType<typeof host>
/** Stubs `glab api` calls; `routes` maps `<METHOD> <endpoint under the project>` to its answer, and the calls are returned in order. */
function glab(h: Host, routes: Record<string, unknown>): string[] {
  const calls: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
    const endpoint = args[3]!.replace(/^projects\/team%2Fwidgets\//, '')
    calls.push(`${method} ${endpoint}`)
    const answer = routes[`${method} ${endpoint}`]
    if (answer === undefined) throw commandError({ stderr: `glab: 404 Not Found`, code: 1 })
    return JSON.stringify(answer)
  })
  return calls
}

describe('GitLab translation', () => {
  it('turns mentions and assignments into Triggers on a Thread named by kind, and ignores other to-dos and the agent itself', () => {
    const mention = todoTrigger(TodoSchema.parse(todo(1)), 'agent-bot')!
    expect(mention).toMatchObject({ id: key('gitlab-todo', '1'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue-12' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, addressed: 'mention', text: '@agent-bot please fix it' })
    const assigned = todoTrigger(TodoSchema.parse(todo(2, { action_name: 'assigned', target_type: 'MergeRequest', body: 'x' })), 'agent-bot')!
    expect(assigned).toMatchObject({ threads: [{ id: 'mr-12' }], addressed: 'direct', text: 'Broken margin\n\nIt is off' })
    expect(todoTrigger(TodoSchema.parse(todo(3, { action_name: 'build_failed' })), 'agent-bot')).toBeUndefined()
    expect(todoTrigger(TodoSchema.parse(todo(4, { author: { username: 'Agent-Bot' } })), 'agent-bot')).toBeUndefined()
  })
  it('turns notes into Triggers, except system notes and the agent\'s own', () => {
    const url = 'https://git.example.com/team/widgets/-/issues/12'
    expect(noteTrigger(note(5, { body: 'hi @agent-bot' }) as never, 'issue', 12, url, 'agent-bot')).toMatchObject({ addressed: 'mention', url: `${url}#note_5` })
    expect(noteTrigger(note(6) as never, 'issue', 12, url, 'agent-bot')?.addressed).toBeUndefined()
    expect(noteTrigger(note(7, { system: true }) as never, 'issue', 12, url, 'agent-bot')).toBeUndefined()
    expect(noteTrigger(note(8, { author: { username: 'agent-bot' } }) as never, 'issue', 12, url, 'agent-bot')).toBeUndefined()
  })
  it('finds Issues and merge requests by reference', () => {
    expect(gitlabKind.find!('!7')).toEqual({ threads: ['gitlab:mr-7'], terms: [] })
    expect(gitlabKind.find!('#7')).toEqual({ threads: ['gitlab:issue-7'], terms: [] })
    expect(gitlabKind.find!('https://git.example.com/team/widgets/-/merge_requests/9')).toEqual({ threads: ['gitlab:mr-9'], terms: [] })
  })
})

describe('GitLab polling', () => {
  it('takes in the project\'s to-dos once, marks them done, and leaves other projects\' to-dos alone', async () => {
    const h = host()
    const calls = glab(h, { 'GET todos?state=pending&per_page=100': [todo(1), todo(2, { project: { path_with_namespace: 'other/repo' } }), { id: 'broken' }],
      'POST todos/1/mark_as_done': {} })
    expect(await pollRound(h)).toEqual({ todos: 1, notes: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['GET todos?state=pending&per_page=100', 'POST todos/1/mark_as_done'])
    await pollRound(h)
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    // An allowed account that mentions the agent makes an explicit request.
    expect(h.engine.candidate(key('gitlab-todo', '1'))?.strength).toBe('explicit')
    h.store.close()
  })
  it('reads the new notes of a followed Thread after its cursor, from the Thread\'s opening on', async () => {
    const h = host()
    const opened = new Date().toISOString()
    h.store.threads.save({ key: 'gitlab:issue-12', ref: { source: 'gitlab', id: 'issue-12' }, createdAt: opened, subscriptions: ['t'], correlated: [], pending: [], meta: {} })
    const at = new Date(Date.parse(opened) + 10_000).toISOString()
    const notes = [note(1, { created_at: new Date(Date.parse(opened) - 86_400_000).toISOString() }), note(2, { system: true, created_at: at }), note(3, { created_at: at }), note(4, { author: { username: 'agent-bot' }, created_at: at })]
    glab(h, { 'GET todos?state=pending&per_page=100': [], 'GET issues/12/notes?sort=asc&order_by=created_at&per_page=100': notes })
    expect(await pollRound(h)).toEqual({ todos: 0, notes: 1 })
    expect(h.store.get(KV.gitlab.cursor('issue-12'))).toBe(4)
    expect(await pollRound(h)).toEqual({ todos: 0, notes: 0 })
    h.store.close()
  })
})

describe('GitLab replies', () => {
  const message = (text: string): OutboundMessage => ({ id: 'op-1', text, kind: 'reply', channel: { source: 'gitlab', thread: 'gitlab:mr-3', address: { kind: 'mr', iid: '3' } } })
  const recent = 'GET merge_requests/3/notes?sort=desc&order_by=created_at&per_page=100'
  it('posts a note under the merge request once, marked with the operation id', async () => {
    const h = host()
    const calls = glab(h, { [recent]: [], 'POST merge_requests/3/notes': {} })
    expect(await sendGitlab(h, message('Done'))).toBe('sent')
    expect(calls).toEqual([recent, 'POST merge_requests/3/notes'])
    const posted = vi.mocked(h.commands.run).mock.calls.at(-1)![1]
    expect(posted.at(-1)).toBe('body=Done\n\n<!-- dsh-superagent:op-1 -->')
    h.store.close()
  })
  it('does not post a note that is already there, and gives up on a deleted target', async () => {
    const h = host()
    const calls = glab(h, { [recent]: [note(9, { author: { username: 'agent-bot' }, body: 'Done\n\n<!-- dsh-superagent:op-1 -->' })] })
    expect(await sendGitlab(h, message('Done'))).toBe('sent')
    expect(calls).toEqual([recent])
    glab(h, {})
    expect(await sendGitlab(h, message('Done'))).toBe('gone')
    h.store.close()
  })
})

describe('GitLab deployment', () => {
  const machine: Machine = testMachine()
  const probe = (permissions: unknown = { project_access: { access_level: 40 } }): Probe => async argv => {
    expect(argv.slice(0, 2)).toEqual(['env', 'GITLAB_HOST=git.example.com'])
    return argv.at(-1) === 'user' ? JSON.stringify({ username: 'agent-bot', id: 7 })
      : JSON.stringify({ path_with_namespace: 'team/widgets', permissions })
  }
  const accounts = { host: 'git.example.com', project: 'team/widgets', cli: '/bin/true' }
  it('verifies the agent account on the self-hosted server and its push access', async () => {
    expect(await resolveGitlab(machine, accounts, probe())).toEqual(GITLAB)
    await expect(resolveGitlab(machine, accounts, probe({ project_access: { access_level: 20 } }))).rejects.toMatchObject({ code: 'gitlabProjectReadOnly' })
    await expect(resolveGitlab(machine, { ...accounts, cli: '' }, probe())).rejects.toMatchObject({ code: 'gitlabCliUnset' })
    await expect(resolveGitlab(machine, { ...accounts, project: '' }, probe())).rejects.toMatchObject({ code: 'gitlabProjectUnset' })
    expect(await resolveGitlab(machine, {}, probe())).toBeUndefined()
  })
  it('runs on GitLab alone once the GitHub Source is off, and still needs one of the two', async () => {
    const deployment = await resolveDeployment(machine, null, probe(), undefined, accounts)
    expect(deployment).toMatchObject({ repository: '', gitlab: GITLAB })
    expect(deployment.github).toBeUndefined()
    await expect(resolveDeployment(machine, null, probe(), undefined, {})).rejects.toBeInstanceOf(SetupError)
    await expect(resolveDeployment(machine, { repository: '', cli: '' }, probe())).rejects.toMatchObject({ code: 'repositoryUnset' })
  })
  it('writes a glab shim and the server\'s credential helper, and refuses gh without a GitHub account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-env-'))
    writeFileSync(join(dir, 'glab-agent'), '#!/bin/sh\necho glab "$@"\n', { mode: 0o755 })
    await writeEnvironment(testDeployment({ stateDir: dir, github: undefined, gitlab: { ...GITLAB, cli: join(dir, 'glab-agent') }, feishu: undefined }), [])
    const config = readFileSync(workerGitConfig(dir), 'utf8')
    expect(config).toContain('[credential "https://git.example.com"]')
    expect(config).toContain('insteadOf = git@git.example.com:')
    expect(config).not.toContain('github.com')
    const glabShim = readFileSync(join(workerBin(dir), 'glab'), 'utf8')
    expect(glabShim).toContain('glab-agent')
    expect(readFileSync(join(workerBin(dir), 'gh'), 'utf8')).toContain('no GitHub account')
  })
})
