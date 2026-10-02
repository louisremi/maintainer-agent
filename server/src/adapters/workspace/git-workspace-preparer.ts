import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AgentTask, GitAccess, Workspace, WorkspacePreparer } from '../../maintenance/application';
import { jobPaths } from './job-files';

const run = promisify(execFile);

/**
 * Clones repositories for agent runs with the host's git. The credential is
 * passed as an HTTP header through environment variables only (never in a
 * URL, never in .git/config); hooks, submodules and LFS are disabled. The
 * clone happens before any agent touches the directory, and the server never
 * runs git in it afterwards (the agent may have planted configuration).
 */
export class GitWorkspacePreparer implements WorkspacePreparer {
  constructor(
    private readonly dataDir: string,
    private readonly gitBinary = 'git',
    /** Transports git may use; tests add `file`. */
    private readonly protocols: readonly string[] = ['https', 'http'],
  ) {}

  private async git(args: string[], cwd: string | undefined, access: GitAccess | null, timeoutMs = 300_000): Promise<string> {
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_ALLOW_PROTOCOL: this.protocols.join(':'),
    };
    const config: [string, string][] = [
      ['core.hooksPath', '/dev/null'],
      ['protocol.file.allow', this.protocols.includes('file') ? 'always' : 'never'],
      ['submodule.recurse', 'false'],
      ['advice.detachedHead', 'false'],
      ['core.symlinks', 'true'],
    ];
    if (access?.authorization) config.push(['http.extraHeader', `Authorization: ${access.authorization}`]);
    env['GIT_CONFIG_COUNT'] = String(config.length);
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    try {
      const { stdout } = await run(this.gitBinary, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      const msg = (e.stderr || e.message).replace(/(Authorization: )\S+ \S+/gi, '$1[redacted]');
      throw new Error(`git ${args[0]} failed: ${msg.slice(0, 500)}`);
    }
  }

  async prepare(input: Parameters<WorkspacePreparer['prepare']>[0]): Promise<Workspace> {
    const p = jobPaths(this.dataDir, input.jobId);
    await rm(p.root, { recursive: true, force: true });
    for (const d of [p.root, p.task, p.out, p.logs]) await mkdir(d, { recursive: true });
    await mkdir(p.repo);

    await this.git(['init', '--quiet', p.repo], undefined, null);
    await this.git(['remote', 'add', 'origin', input.git.remoteUrl], p.repo, null);
    const depth = input.mode === 'review' ? '200' : '50';
    await this.git(['fetch', '--quiet', '--no-tags', '--depth', depth, 'origin', `+refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`], p.repo, input.git);
    let diff: string | null = null;
    if (input.head) {
      await this.git(['fetch', '--quiet', '--no-tags', '--depth', depth, 'origin', `+${input.head.fetchRef}:refs/remotes/origin/change`], p.repo, input.git);
      await this.git(['checkout', '--quiet', '--detach', input.head.sha], p.repo, null);
      const mergeBase = await this.git(['merge-base', input.baseSha, input.head.sha], p.repo, null).then((s) => s.trim()).catch(() => input.baseSha);
      diff = await this.git(['diff', '--no-color', '--no-ext-diff', '--find-renames', `${mergeBase}..${input.head.sha}`], p.repo, null);
      await writeFile(`${p.task}/diff.patch`, diff);
    } else {
      await this.git(['checkout', '--quiet', '--detach', input.baseSha], p.repo, null);
    }
    // The remote URL carries no credential, but agents need no remote at all.
    await this.git(['remote', 'remove', 'origin'], p.repo, null);

    // Agent containers run as uid 10001: they may write the fix checkout and
    // their output directory, never the task directory.
    await chmod(p.out, 0o777);
    if (input.mode === 'fix') await makeWritable(p.repo);
    return { id: input.jobId, baseSha: input.baseSha, headSha: input.head?.sha ?? null, diff };
  }

  async writeTask(workspace: Workspace, task: AgentTask): Promise<void> {
    const p = jobPaths(this.dataDir, workspace.id);
    await writeFile(`${p.task}/task.json`, JSON.stringify(task, null, 2));
    await this.copyTrustedFiles(workspace, task);
    await chmod(p.task, 0o755);
  }

  /**
   * The repository's instructions and playbook are trusted input, so they
   * must come from the base commit: in a review the checkout is the change's
   * head, which its author controls. They are copied from the base commit
   * (git object database, not the work tree) into task/trusted/.
   */
  private async copyTrustedFiles(workspace: Workspace, task: AgentTask): Promise<void> {
    const p = jobPaths(this.dataDir, workspace.id);
    const dir = `${p.task}/trusted`;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const wanted = [...new Set([...task.policy.instructions, task.policy.playbook, 'AGENTS.md', 'CONTRIBUTING.md', 'README.md'].filter(Boolean))];
    for (const path of wanted) {
      if (path.startsWith('/') || path.split('/').includes('..') || /[*?[]/.test(path)) continue;
      const type = await this.git(['cat-file', '-t', `${workspace.baseSha}:${path}`], p.repo, null).then((t) => t.trim()).catch(() => '');
      if (type !== 'blob') continue;
      const content = await this.git(['cat-file', 'blob', `${workspace.baseSha}:${path}`], p.repo, null);
      const target = `${dir}/${path}`;
      await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      await writeFile(target, content.slice(0, 512 * 1024));
    }
  }

  async release(workspaceId: string): Promise<void> {
    await rm(jobPaths(this.dataDir, workspaceId).repo, { recursive: true, force: true });
  }

  async dispose(workspaceId: string): Promise<void> {
    await rm(jobPaths(this.dataDir, workspaceId).root, { recursive: true, force: true });
  }
}

/** Like `chmod -R a+rwX`: adds read/write for everyone, keeps execute bits. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o777);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makeWritable(path);
    } else {
      const { mode } = await lstat(path);
      await chmod(path, (mode & 0o777) | 0o666 | (mode & 0o100 ? 0o111 : 0)).catch(() => undefined);
    }
  }
}
