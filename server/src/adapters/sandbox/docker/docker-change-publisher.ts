import { z } from 'zod';
import { ChangePublisher, PublishOutcome } from '../../../maintenance/application';
import { jobPaths, readAgentFile } from '../../workspace/job-files';
import { DockerSandbox } from './sandbox';

const PublishFile = z.object({ branch: z.string(), commit: z.string().regex(/^[0-9a-f]{40,64}$/) });

export interface PublisherConfig {
  readonly dataDir: string;
  /** Commit author for agent changes, "Name <email>". */
  readonly gitAuthor: string;
}

/** Exit codes of runner/publish.sh. */
const EXIT = { ok: 0, rejected: 3, badInput: 2, pushFailed: 4 } as const;

/**
 * Pushes an agent's patch with the runner's `publish` role: a container with
 * no model, a push token for one repository, and egress to the forge's git
 * hosts only. It re-checks the patch (protected paths, symlinks, size) on a
 * fresh clone before committing, and never force-pushes.
 */
export class DockerChangePublisher implements ChangePublisher {
  constructor(private readonly sandbox: DockerSandbox, private readonly config: PublisherConfig) {}

  async publish(input: Parameters<ChangePublisher['publish']>[0]): Promise<PublishOutcome> {
    const p = jobPaths(this.config.dataDir, input.workspace.id);
    if (!/^maintainer-agent\/[A-Za-z0-9._/-]+$/.test(input.branch) || input.branch.includes('..')) {
      return { ok: false, reason: `refusing to push to ${input.branch}`, transient: false };
    }
    if (!input.git.authorization) return { ok: false, reason: 'no push credential', transient: false };
    // The patch was written by the agent: copy it through the safe reader into the task directory.
    let patch: string | null;
    try {
      patch = await readAgentFile(p.out, input.change.patchRef, 2 * 1024 * 1024);
    } catch (err) {
      return { ok: false, reason: (err as Error).message, transient: false };
    }
    if (!patch) return { ok: false, reason: 'no patch to publish', transient: false };
    const { writeFile, mkdir, chmod } = await import('node:fs/promises');
    const pubDir = `${p.root}/publish`;
    await mkdir(`${pubDir}/out`, { recursive: true });
    await writeFile(`${pubDir}/changes.patch`, patch);
    await writeFile(`${pubDir}/message.txt`, `${input.change.title}\n\n${input.change.body}`.slice(0, 20_000));
    await chmod(`${pubDir}/out`, 0o777);

    const r = await this.sandbox.run({
      role: 'publish',
      runId: input.workspace.id,
      args: [],
      env: {
        GIT_REMOTE_URL: input.git.remoteUrl,
        GIT_AUTH_HEADER: `Authorization: ${input.git.authorization}`,
        BASE_SHA: input.workspace.baseSha,
        BRANCH: input.branch,
        PROTECTED_PATHS: input.protectedPaths.join('\n'),
        GIT_AUTHOR: this.config.gitAuthor,
      },
      mounts: [
        { host: `${pubDir}/changes.patch`, container: '/in/changes.patch', readOnly: true },
        { host: `${pubDir}/message.txt`, container: '/in/message.txt', readOnly: true },
        { host: `${pubDir}/out`, container: '/out', readOnly: false },
      ],
      egress: input.git.egressHosts,
      memoryMb: 1024,
      timeoutMs: 10 * 60_000,
      readOnlyRoot: true,
      tmpfs: { '/tmp': 'rw,mode=1777,size=2g', '/home/agent': 'rw,uid=10001,gid=10001,mode=0700,size=16m' },
      egressLogFile: `${p.logs}/publish-egress.log`,
    }).catch((err: Error) => ({ exitCode: -1, stdout: '', stderr: err.message, timedOut: false, egressLog: '' }));

    if (r.exitCode === EXIT.ok) {
      const raw = await readAgentFile(`${pubDir}/out`, 'publish.json', 4096).catch(() => null);
      let json: unknown = null;
      try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      const parsed = PublishFile.safeParse(json);
      if (!parsed.success || parsed.data.branch !== input.branch) return { ok: false, reason: 'publisher returned no result', transient: false };
      return { ok: true, branch: parsed.data.branch, commitSha: parsed.data.commit };
    }
    const why = r.stderr.trim().split('\n').filter((l) => l.startsWith('publish:')).slice(-3).join(' ') || r.stderr.trim().slice(-300);
    if (r.exitCode === EXIT.rejected) return { ok: false, reason: why || 'patch rejected', transient: false };
    return { ok: false, reason: `publish failed (exit ${r.exitCode}): ${why}`, transient: r.exitCode === EXIT.pushFailed || r.exitCode < 0 };
  }
}
