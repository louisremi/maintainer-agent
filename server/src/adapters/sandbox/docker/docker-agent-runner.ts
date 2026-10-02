import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AgentOutcome,
  AgentRunner,
  AgentRunOptions,
  Workspace,
} from '../../../maintenance/application';
import { ISSUE_KINDS, IssueKind, ProposedChange, Review, Verdict } from '../../../maintenance/domain';
import { jobPaths, readAgentFile } from '../../workspace/job-files';
import { DockerSandbox, SandboxResult } from './sandbox';

const VerdictFile = z.object({
  kind: z.enum(ISSUE_KINDS as [IssueKind, ...IssueKind[]]),
  answer: z.string().min(1).max(60_000),
  change_summary: z.string().max(20_000).default(''),
});
const ChangeFile = z.object({ title: z.string().min(1).max(500), body: z.string().max(60_000) });
const ReviewFile = z.object({
  summary: z.string().min(1).max(60_000),
  comments: z.array(z.object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    side: z.enum(['RIGHT', 'LEFT']).default('RIGHT'),
    body: z.string().min(1).max(8_000),
  })).max(200).default([]),
});

export interface AgentRunnerConfig {
  readonly dataDir: string;
  /** Extra environment for the model client (e.g. LLM_API_KEY); never forge credentials. */
  readonly modelEnv: Readonly<Record<string, string>>;
  readonly memoryMb: { issue: number; fix: number; review: number };
  readonly timeoutMs: { issue: number; fix: number; review: number };
}

/** Exit codes of runner/run-agent.sh. */
const EXIT = { ok: 0, noOutput: 1, badInput: 2, modelUnavailable: 75 } as const;

function hostOf(apiBase: string): string {
  return new URL(apiBase).hostname;
}

/**
 * Runs the mini-swe-agent roles of the runner image. The agent container
 * gets the checkout, the task, an output directory, and egress to the model
 * endpoint (plus, for fixes, the policy's hosts). No forge credential.
 */
export class DockerAgentRunner implements AgentRunner {
  constructor(private readonly sandbox: DockerSandbox, private readonly config: AgentRunnerConfig) {}

  async answerIssue(ws: Workspace, o: AgentRunOptions): Promise<AgentOutcome<Verdict>> {
    const r = await this.run('issue', ws, o);
    if (!r.ok) return r;
    const v = await this.parse(ws, 'verdict.json', VerdictFile);
    if (!v.ok) return v;
    return { ok: true, value: Verdict.of(v.value.kind, v.value.answer, v.value.change_summary) };
  }

  async proposeFix(ws: Workspace, o: AgentRunOptions): Promise<AgentOutcome<ProposedChange>> {
    const r = await this.run('fix', ws, o);
    if (!r.ok) return r;
    const out = jobPaths(this.config.dataDir, ws.id).out;
    const patch = await readAgentFile(out, 'changes.patch', 2 * 1024 * 1024).catch((e: Error) => { throw e; });
    if (!patch || !patch.trim()) {
      const note = await readAgentFile(out, 'summary.md', 64 * 1024).catch(() => null);
      return { ok: false, reason: 'the agent made no change', transient: false, ...(note ? { explanation: note } : {}) };
    }
    const c = await this.parse(ws, 'pr.json', ChangeFile);
    if (!c.ok) return c;
    return { ok: true, value: ProposedChange.of('changes.patch', c.value.title, c.value.body) };
  }

  async reviewChange(ws: Workspace, o: AgentRunOptions): Promise<AgentOutcome<Review>> {
    const r = await this.run('review', ws, o);
    if (!r.ok) return r;
    const v = await this.parse(ws, 'review.json', ReviewFile);
    if (!v.ok) return v;
    try {
      return { ok: true, value: Review.of(v.value.summary, v.value.comments) };
    } catch (err) {
      return { ok: false, reason: `invalid review: ${(err as Error).message}`, transient: false };
    }
  }

  private async run(mode: 'issue' | 'fix' | 'review', ws: Workspace, o: AgentRunOptions): Promise<AgentOutcome<SandboxResult>> {
    const p = jobPaths(this.config.dataDir, ws.id);
    const egress = [hostOf(o.model.apiBase), ...(mode === 'fix' ? o.extraEgress : [])];
    let result: SandboxResult;
    try {
      result = await this.sandbox.run({
        role: `${mode}-agent`,
        runId: ws.id,
        args: [],
        env: {
          ...this.config.modelEnv,
          LLM_API_BASE: o.model.apiBase,
          LLM_MODEL: o.model.model,
          MSWEA_STEP_LIMIT: String(o.stepLimit),
        },
        mounts: [
          { host: p.repo, container: '/work/repo', readOnly: mode !== 'fix' },
          { host: p.task, container: '/work/task', readOnly: true },
          { host: p.out, container: '/out', readOnly: false },
        ],
        egress,
        memoryMb: this.config.memoryMb[mode],
        timeoutMs: this.config.timeoutMs[mode],
        readOnlyRoot: mode !== 'fix',
        tmpfs: mode === 'fix'
          ? { '/tmp': 'rw,exec,mode=1777,size=2g' }
          : { '/tmp': 'rw,exec,mode=1777,size=512m', '/home/agent': 'rw,uid=10001,gid=10001,mode=0700,size=64m' },
        egressLogFile: `${p.logs}/${mode}-egress.log`,
      });
    } catch (err) {
      return { ok: false, reason: `sandbox error: ${(err as Error).message}`, transient: true };
    }
    await appendFile(`${p.logs}/${mode}-agent.log`, `${result.stdout}\n--- stderr ---\n${result.stderr}`).catch(() => undefined);
    if (result.timedOut) return { ok: false, reason: `the ${mode} agent timed out`, transient: false };
    if (result.exitCode === EXIT.modelUnavailable) return { ok: false, reason: 'model endpoint unavailable', transient: true };
    if (result.exitCode === EXIT.badInput) return { ok: false, reason: `the runner rejected its input: ${tail(result.stderr)}`, transient: false };
    if (result.exitCode !== EXIT.ok && result.exitCode !== EXIT.noOutput) {
      return { ok: false, reason: `the ${mode} agent exited with ${result.exitCode}: ${tail(result.stderr)}`, transient: result.exitCode >= 125 };
    }
    return { ok: true, value: result };
  }

  private async parse<T>(ws: Workspace, name: string, schema: z.ZodType<T>): Promise<AgentOutcome<T>> {
    let raw: string | null;
    try {
      raw = await readAgentFile(jobPaths(this.config.dataDir, ws.id).out, name, 256 * 1024);
    } catch (err) {
      return { ok: false, reason: `unusable ${name}: ${(err as Error).message}`, transient: false };
    }
    if (raw === null) return { ok: false, reason: `the agent wrote no ${name}`, transient: false };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `${name} is not valid JSON`, transient: false };
    }
    const r = schema.safeParse(json);
    if (!r.success) return { ok: false, reason: `${name} does not match the expected shape: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)}`, transient: false };
    return { ok: true, value: r.data };
  }
}

function tail(s: string): string {
  return s.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
}
