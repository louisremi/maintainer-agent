import { lstat, open } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Reads a file an agent container may have written. The agent controls that
 * directory, so the file must be a regular file (not a symlink, FIFO or
 * device), inside the directory, and small.
 */
export async function readAgentFile(dir: string, name: string, maxBytes: number): Promise<string | null> {
  const path = resolve(dir, name);
  const rel = relative(resolve(dir), path);
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '') throw new Error(`refusing to read outside the output directory: ${name}`);
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null;
  }
  if (!st.isFile()) throw new Error(`${name} is not a regular file`);
  if (st.size > maxBytes) throw new Error(`${name} is too large (${st.size} > ${maxBytes} bytes)`);
  const fd = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    await fd.read(buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}

export function jobPaths(dataDir: string, jobId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`invalid job id: ${jobId}`);
  const root = join(dataDir, 'jobs', jobId);
  return {
    root,
    /** The checkout, mounted into agent containers. */
    repo: join(root, 'repo'),
    /** task.json and diff.patch, mounted read-only. */
    task: join(root, 'task'),
    /** Where the agent writes its result (untrusted). */
    out: join(root, 'out'),
    /** Logs and trajectories kept for the operator. */
    logs: join(root, 'logs'),
  };
}
