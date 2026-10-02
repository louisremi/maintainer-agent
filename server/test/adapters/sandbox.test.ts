import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ContainerEngine,
  ContainerSpec,
  DockerAgentRunner,
  DockerChangePublisher,
  DockerOutputSanitizer,
  DockerPolicyValidator,
  DockerSandbox,
  RunResult,
  toCreateOptions,
} from '../../src/adapters/sandbox/docker';
import { jobPaths, readAgentFile } from '../../src/adapters/workspace/job-files';
import { ProposedChange } from '../../src/maintenance/domain';

type Call = { op: string; spec?: ContainerSpec | (Omit<ContainerSpec, 'network'> & { network: 'bridge' }); stdin?: string; args?: unknown[] };

class FakeEngine implements ContainerEngine {
  readonly calls: Call[] = [];
  onRun: (spec: ContainerSpec, stdin?: string) => Partial<RunResult> = () => ({});
  async run(spec: ContainerSpec, o: { stdin?: string }) {
    this.calls.push({ op: 'run', spec, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...this.onRun(spec, o.stdin) };
  }
  async createInternalNetwork(name: string) { this.calls.push({ op: 'network', args: [name] }); return '172.30.5.0/24'; }
  async removeNetwork(name: string) { this.calls.push({ op: 'rm-network', args: [name] }); }
  async startDetached(spec: Omit<ContainerSpec, 'network'> & { network: 'bridge' }) { this.calls.push({ op: 'detached', spec }); }
  async connect(network: string, container: string, alias: string) { this.calls.push({ op: 'connect', args: [network, container, alias] }); }
  async exec() { return 0; }
  async logs() { return 'CONNECT model.example:443 allowed'; }
  async remove(name: string) { this.calls.push({ op: 'rm', args: [name] }); }
  async pull() {}
  async removeManaged() { return 0; }
}

const MODEL = { apiBase: 'http://10.0.0.5:8000/v1', model: 'openai/qwen' };

describe('container hardening', () => {
  const base: ContainerSpec = {
    name: 'ma-x', image: 'img', args: ['issue-agent'], env: { A: '1' }, mounts: [{ host: '/h', container: '/c', readOnly: true }],
    network: { internal: 'ma-x-net' }, memoryMb: 512, readOnlyRoot: true,
  };

  it('drops every capability, forbids privilege escalation and runs as non-root', () => {
    const o = toCreateOptions(base);
    expect(o.User).toBe('10001:10001');
    expect(o.HostConfig).toMatchObject({
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Init: true, Privileged: false, PidsLimit: 2048,
      Memory: 512 * 1024 * 1024, ReadonlyRootfs: true, NetworkMode: 'ma-x-net', Dns: ['127.0.0.1'], Binds: ['/h:/c:ro'],
    });
    expect(o.Env).toEqual(expect.arrayContaining(['A=1', 'HTTPS_PROXY=http://egress:8888', 'NO_PROXY=localhost,127.0.0.1']));
  });

  it('gives network-less containers no network and no proxy settings', () => {
    const o = toCreateOptions({ ...base, network: 'none' });
    expect(o.NetworkDisabled).toBe(true);
    expect(o.HostConfig!.NetworkMode).toBe('none');
    expect(o.HostConfig).not.toHaveProperty('Dns');
    expect(o.Env!.some((e) => e.startsWith('HTTPS_PROXY'))).toBe(false);
  });
});

describe('Docker sandbox', () => {
  let dir: string;
  let engine: FakeEngine;
  let sandbox: DockerSandbox;
  const written: Record<string, string> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ma-sbx-'));
    engine = new FakeEngine();
    sandbox = new DockerSandbox(engine, { runnerImage: 'louisremi/maintainer-agent:test', namePrefix: 'ma-' }, async (p, d) => { written[p] = d; });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function job(id: string) {
    const p = jobPaths(dir, id);
    for (const d of [p.repo, p.task, p.out, p.logs]) mkdirSync(d, { recursive: true });
    return p;
  }
  const ws = (id: string) => ({ id, baseSha: 'b'.repeat(40), headSha: null, diff: null });
  const agents = () => new DockerAgentRunner(sandbox, { dataDir: dir, modelEnv: { LLM_API_KEY: 'k' }, memoryMb: { issue: 1024, fix: 2048, review: 1024 }, timeoutMs: { issue: 1000, fix: 1000, review: 1000 } });

  it('gives the issue agent egress to the model only, a read-only checkout and no forge credential', async () => {
    const p = job('j1');
    engine.onRun = () => { writeFileSync(join(p.out, 'verdict.json'), JSON.stringify({ kind: 'question', answer: 'Do x.' })); return {}; };
    const r = await agents().answerIssue(ws('j1'), { model: MODEL, stepLimit: 30, extraEgress: ['registry.npmjs.org'] });
    expect(r).toMatchObject({ ok: true, value: { kind: 'question', answer: 'Do x.' } });

    const proxy = engine.calls.find((c) => c.op === 'detached')!.spec!;
    expect(proxy.args).toEqual(['egress']);
    expect(proxy.env).toEqual({ EGRESS_ALLOW: '10.0.0.5', EGRESS_CLIENTS: '172.30.5.0/24' });
    const run = engine.calls.find((c) => c.op === 'run')!.spec as ContainerSpec;
    expect(run.args).toEqual(['issue-agent']);
    expect(run.network).toEqual({ internal: 'ma-j1-issue-agent-net' });
    expect(run.readOnlyRoot).toBe(true);
    expect(run.mounts).toEqual([
      { host: p.repo, container: '/work/repo', readOnly: true },
      { host: p.task, container: '/work/task', readOnly: true },
      { host: p.out, container: '/out', readOnly: false },
    ]);
    expect(Object.keys(run.env).sort()).toEqual(['LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'MSWEA_STEP_LIMIT']);
    expect(JSON.stringify(run.env)).not.toMatch(/gh[soup]_|x-access-token|Authorization/i);
    expect(engine.calls.map((c) => c.op)).toEqual(['network', 'detached', 'connect', 'run', 'rm', 'rm-network']);
    expect(written[`${p.logs}/issue-egress.log`]).toContain('allowed');
  });

  it('lets the fix agent reach the policy hosts and write its checkout', async () => {
    const p = job('j2');
    engine.onRun = () => {
      writeFileSync(join(p.out, 'changes.patch'), 'diff --git a/x b/x\n');
      writeFileSync(join(p.out, 'pr.json'), JSON.stringify({ title: 'fix: x', body: 'Why.' }));
      return {};
    };
    const r = await agents().proposeFix(ws('j2'), { model: MODEL, stepLimit: 80, extraEgress: ['registry.npmjs.org'] });
    expect(r).toMatchObject({ ok: true, value: { title: 'fix: x', patchRef: 'changes.patch' } });
    expect(engine.calls.find((c) => c.op === 'detached')!.spec!.env).toEqual({ EGRESS_ALLOW: '10.0.0.5 registry.npmjs.org', EGRESS_CLIENTS: '172.30.5.0/24' });
    const run = engine.calls.find((c) => c.op === 'run')!.spec as ContainerSpec;
    expect(run.mounts[0]).toEqual({ host: p.repo, container: '/work/repo', readOnly: false });
    expect(run.env['MSWEA_STEP_LIMIT']).toBe('80');
  });

  it('reports agent output problems as non-transient failures', async () => {
    const p = job('j3');
    engine.onRun = () => { writeFileSync(join(p.out, 'review.json'), '{"summary": ""}'); return {}; };
    expect(await agents().reviewChange(ws('j3'), { model: MODEL, stepLimit: 40, extraEgress: [] })).toMatchObject({ ok: false, transient: false, reason: expect.stringMatching(/expected shape/) });

    engine.onRun = () => { symlinkSync('/etc/passwd', join(p.out, 'verdict.json')); return {}; };
    expect(await agents().answerIssue(ws('j3'), { model: MODEL, stepLimit: 30, extraEgress: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a regular file/) });

    engine.onRun = () => ({ exitCode: 75 });
    expect(await agents().answerIssue(ws('j3'), { model: MODEL, stepLimit: 30, extraEgress: [] })).toMatchObject({ ok: false, transient: true });

    engine.onRun = () => ({ timedOut: true, exitCode: 137 });
    expect(await agents().answerIssue(ws('j3'), { model: MODEL, stepLimit: 30, extraEgress: [] })).toMatchObject({ ok: false, transient: false, reason: expect.stringMatching(/timed out/) });

    engine.onRun = () => ({});
    rmSync(join(p.out, 'verdict.json'));
    expect(await agents().proposeFix(ws('j3'), { model: MODEL, stepLimit: 30, extraEgress: [] })).toMatchObject({ ok: false, reason: 'the agent made no change' });
  });

  it('publishes with a push credential, git hosts only, and no model', async () => {
    const p = job('j4');
    writeFileSync(join(p.out, 'changes.patch'), 'diff --git a/x b/x\n');
    engine.onRun = (spec) => {
      const out = spec.mounts.find((m) => m.container === '/out')!.host;
      writeFileSync(join(out, 'publish.json'), JSON.stringify({ branch: 'maintainer-agent/issue-4', commit: 'c'.repeat(40) }));
      return {};
    };
    const publisher = new DockerChangePublisher(sandbox, { dataDir: dir, gitAuthor: 'bot <bot@example.org>' });
    const git = { remoteUrl: 'https://github.com/octo/w.git', authorization: 'Basic abc', egressHosts: ['github.com', 'codeload.github.com'] };
    const change = ProposedChange.of('changes.patch', 'fix: x', 'body');
    const r = await publisher.publish({ workspace: ws('j4'), change, git, branch: 'maintainer-agent/issue-4', protectedPaths: ['.github/**', 'LICENSE'] });
    expect(r).toEqual({ ok: true, branch: 'maintainer-agent/issue-4', commitSha: 'c'.repeat(40) });
    const run = engine.calls.find((c) => c.op === 'run')!.spec as ContainerSpec;
    expect(run.args).toEqual(['publish']);
    expect(run.env).toMatchObject({ BRANCH: 'maintainer-agent/issue-4', PROTECTED_PATHS: '.github/**\nLICENSE', GIT_AUTH_HEADER: 'Authorization: Basic abc' });
    expect(run.env).not.toHaveProperty('LLM_API_BASE');
    expect(engine.calls.find((c) => c.op === 'detached')!.spec!.env).toEqual({ EGRESS_ALLOW: 'github.com codeload.github.com', EGRESS_CLIENTS: '172.30.5.0/24' });

    expect(await publisher.publish({ workspace: ws('j4'), change, git, branch: 'main', protectedPaths: [] })).toMatchObject({ ok: false, reason: 'refusing to push to main' });
    engine.onRun = () => ({ exitCode: 3, stderr: 'publish: rejected: touches protected path .github/workflows/ci.yml' });
    expect(await publisher.publish({ workspace: ws('j4'), change, git, branch: 'maintainer-agent/issue-4', protectedPaths: [] })).toEqual({ ok: false, transient: false, reason: 'publish: rejected: touches protected path .github/workflows/ci.yml' });
  });

  it('validates policies and sanitises text in network-less containers', async () => {
    engine.onRun = (spec) => spec.args[0] === 'policy'
      ? { stdout: JSON.stringify({ instructions: [], playbooks: { issue: '', implement: '', review: '' }, checks: [], egress: [], links: [], protected_paths: ['.github/**'], answer: { enabled: true, max_attempts: 2 }, fix: { enabled: true, trigger: 'label', max_attempts: 2, step_limit: 80 }, review: { enabled: true, max_comments: 20, max_diff_lines: 5000, max_attempts: 2 } }) }
      : { stdout: JSON.stringify({ results: [{ text: 'safe', held: false, reasons: [] }] }) };
    const v = await new DockerPolicyValidator(sandbox, { maxStepLimit: 120, maxAttemptsCap: 5 }).validate('version: 1');
    expect(v).toMatchObject({ ok: true, data: { fix: { trigger: 'label' } } });
    const s = await new DockerOutputSanitizer(sandbox).sanitize(['raw'], { webUrl: 'https://github.com/o/r', extraLinks: ['https://docs.example.org/'] });
    expect(s).toEqual([{ text: 'safe', held: false, reasons: [] }]);
    const runs = engine.calls.filter((c) => c.op === 'run').map((c) => c.spec as ContainerSpec);
    expect(runs.every((r) => r.network === 'none')).toBe(true);
    expect(runs[1]!.env).toMatchObject({ SANITIZE_REPO_URL: 'https://github.com/o/r', SANITIZE_EXTRA_LINK_PREFIXES: 'https://docs.example.org/' });
    expect(engine.calls.some((c) => c.op === 'detached')).toBe(false);

    engine.onRun = () => ({ exitCode: 1, stderr: 'policy error: unknown keys: bogus\n' });
    expect(await new DockerPolicyValidator(sandbox, { maxStepLimit: 120, maxAttemptsCap: 5 }).validate('bogus: 1')).toEqual({ ok: false, errors: ['unknown keys: bogus'] });
  });

  it('refuses invalid egress hosts', async () => {
    job('j5');
    await expect(sandbox.run({ role: 'issue-agent', runId: 'j5', args: [], env: {}, mounts: [], egress: ['evil host'], memoryMb: 1, timeoutMs: 1, readOnlyRoot: true })).rejects.toThrow(/invalid egress host/);
  });
});

describe('reading agent output', () => {
  it('reads regular files within limits only', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ma-out-'));
    writeFileSync(join(d, 'ok.json'), '{}');
    writeFileSync(join(d, 'big.json'), 'x'.repeat(100));
    symlinkSync('/etc/hostname', join(d, 'link.json'));
    expect(await readAgentFile(d, 'ok.json', 10)).toBe('{}');
    expect(await readAgentFile(d, 'missing.json', 10)).toBeNull();
    await expect(readAgentFile(d, 'big.json', 10)).rejects.toThrow(/too large/);
    await expect(readAgentFile(d, 'link.json', 10)).rejects.toThrow(/not a regular file/);
    await expect(readAgentFile(d, '../x', 10)).rejects.toThrow(/outside/);
    expect(() => jobPaths(d, '../etc')).toThrow(/invalid job id/);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('egress host rule', () => {
  it('refuses wildcards that open a whole top-level domain', async () => {
    const { isSafeEgressHost } = await import('../../src/adapters/sandbox/docker/sandbox');
    for (const ok of ['github.com', 'registry.npmjs.org', '*.example.org', 'cdn*.example.org', 'productionresultssa*.blob.core.windows.net', '*.example.co.uk']) {
      expect(isSafeEgressHost(ok), ok).toBe(true);
    }
    for (const bad of ['*.com', '*.co.uk', 'a*.com', 'a*.com.au', 'a.*.example.org', '*', 'localhost', 'a..b.com']) {
      expect(isSafeEgressHost(bad), bad).toBe(false);
    }
  });
});
