import Database from 'better-sqlite3';
import { RepoRef } from '../../../shared-kernel';
import { JobKind, JobStatus, MaintenanceJob } from '../../../maintenance/domain';
import { MaintenanceJobRepository } from '../../../maintenance/application';

interface JobRow {
  id: string; repo_key: string; kind: string; number: number; trigger_cause: string; trigger_actor: string;
  context: string; status: string; attempts: number; agent_failures: number; not_before: string;
  outcome: string | null; created_at: string; updated_at: string;
}

export class SqliteJobRepository implements MaintenanceJobRepository {
  constructor(private readonly db: Database.Database) {}

  async get(id: string) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  async save(job: MaintenanceJob) {
    const s = job.snapshot();
    this.db.prepare(`
      INSERT INTO jobs (id, repo_key, kind, number, trigger_cause, trigger_actor, context, status, attempts, agent_failures, not_before, outcome, created_at, updated_at)
      VALUES (@id, @repo_key, @kind, @number, @trigger_cause, @trigger_actor, @context, @status, @attempts, @agent_failures, @not_before, @outcome, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        context = excluded.context, status = excluded.status, attempts = excluded.attempts, agent_failures = excluded.agent_failures,
        not_before = excluded.not_before, outcome = excluded.outcome, updated_at = excluded.updated_at
    `).run({
      id: s.id,
      repo_key: s.repo.key,
      kind: s.kind,
      number: s.number,
      trigger_cause: s.trigger.cause,
      trigger_actor: s.trigger.actorLogin,
      context: JSON.stringify(s.context),
      status: s.status,
      attempts: s.attempts,
      agent_failures: s.agentFailures,
      not_before: s.notBefore.toISOString(),
      outcome: s.outcome,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    });
  }

  async claimNext(now: Date) {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' AND not_before <= ? ORDER BY created_at, id LIMIT 1`)
      .get(now.toISOString()) as JobRow | undefined;
    if (!row) return null;
    const job = toJob(row);
    job.start(now);
    await this.save(job);
    return job;
  }

  async listActive(repo: RepoRef) {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE repo_key = ? AND status IN ('queued', 'running') ORDER BY created_at`).all(repo.key) as JobRow[];
    return rows.map(toJob);
  }

  async listByStatus(status: JobStatus) {
    return (this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at').all(status) as JobRow[]).map(toJob);
  }

  async countTriggeredBy(actorLogin: string, since: Date) {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE trigger_actor = ? AND created_at >= ? AND trigger_cause NOT LIKE 'job:%'`)
      .get(actorLogin, since.toISOString()) as { n: number };
    return r.n;
  }

  async listRecent(limit: number) {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as JobRow[]).map(toJob);
  }

  async deleteFinishedBefore(before: Date) {
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE status IN ('succeeded', 'failed', 'needs-human') AND updated_at < ?`)
      .all(before.toISOString()) as { id: string }[];
    const del = this.db.prepare('DELETE FROM jobs WHERE id = ?');
    for (const r of rows) del.run(r.id);
    return rows.map((r) => r.id);
  }
}

function toJob(r: JobRow): MaintenanceJob {
  return MaintenanceJob.restore({
    id: r.id,
    repo: RepoRef.parse(r.repo_key),
    kind: r.kind as JobKind,
    number: r.number,
    trigger: { cause: r.trigger_cause, actorLogin: r.trigger_actor },
    context: JSON.parse(r.context) as Record<string, string>,
    status: r.status as JobStatus,
    attempts: r.attempts,
    agentFailures: r.agent_failures,
    notBefore: new Date(r.not_before),
    outcome: r.outcome,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  });
}
