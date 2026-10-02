import { RepoRef } from '../../src/shared-kernel';
import {
  AnswerIssue,
  HandleForgeEvent,
  MaintenanceEventHandlers,
  ProposeFix,
  RepositoryPolicies,
  ReviewChangeRequest,
  RunNextJob,
} from '../../src/maintenance/application';
import { DEFAULT_HOST_LIMITS, ForgeEvent, IssueKind, ProposedChange, Review, Verdict } from '../../src/maintenance/domain';
import { AccountAllowList } from '../../src/shared-kernel';
import {
  DirectUnitOfWork,
  FakeAgents,
  FakeForge,
  FakeModelHealth,
  FakePolicyValidator,
  FakePublisher,
  FakeSanitizer,
  FakeWorkspaces,
  fakeModels,
  FixedClock,
  MemoryLogger,
  RecordingPublisher,
  SequentialIds,
} from './fakes';
import { MemoryJobRepository } from './memory-repositories';
import { REPO, T0 } from './builders';

/** Wires the maintenance use cases to fakes, as the composition root does with adapters. */
export function maintenanceHarness(opts: { allowList?: string } = {}) {
  const clock = new FixedClock(T0);
  const log = new MemoryLogger();
  const forge = new FakeForge();
  const state = forge.add(REPO);
  const jobs = new MemoryJobRepository();
  const validator = new FakePolicyValidator();
  const workspaces = new FakeWorkspaces();
  const agents = new FakeAgents();
  const publisher = new FakePublisher();
  const sanitizer = new FakeSanitizer();
  const health = new FakeModelHealth();
  const events = new RecordingPublisher();
  const uow = new DirectUnitOfWork();
  const ids = new SequentialIds('job');
  const policies = new RepositoryPolicies(validator, DEFAULT_HOST_LIMITS, log);
  const handlers = new MaintenanceEventHandlers(forge, log);
  events.subscribers.push((e) => handlers.handle(e));

  const handle = new HandleForgeEvent({
    forge, policies, jobs, allowList: AccountAllowList.parse(opts.allowList ?? ''), limits: DEFAULT_HOST_LIMITS,
    ids, clock, uow, events, log,
  });
  const common = { workspaces, agents, sanitizer, models: fakeModels, log };
  const run = new RunNextJob({
    jobs, forge, policies, modelHealth: health, ids, clock, uow, events, log, maxRuns: 3, retryDelayMs: 1000,
    handlers: [
      new AnswerIssue({ ...common, stepLimit: 30 }),
      new ProposeFix({ ...common, publisher }),
      new ReviewChangeRequest({ ...common, stepLimit: 40 }),
    ],
  });

  return {
    clock, log, forge, state, jobs, validator, workspaces, agents, publisher, sanitizer, health, events, handle, run,
    send: (event: ForgeEvent) => handle.execute({ connectionId: 'c1', event }),
    addIssue(n: number, over: Partial<{ title: string; body: string; author: string; role: 'maintainer' | 'other'; labels: string[]; open: boolean }> = {}) {
      state.issues.set(n, {
        number: n, title: over.title ?? `Issue ${n}`, body: over.body ?? 'It breaks.', authorLogin: over.author ?? 'alice',
        authorRole: over.role ?? 'maintainer', labels: over.labels ?? [], isOpen: over.open ?? true,
        fingerprint: `fp:${over.body ?? 'It breaks.'}`,
      });
    },
    verdict: (kind: IssueKind, answer = `Analysis of the ${kind}.`) => agents.verdicts.push({ ok: true, value: Verdict.of(kind, answer, 'change x') }),
    change: (title = 'fix: handle empty input', body = 'Handles the empty case.') => agents.changes.push({ ok: true, value: ProposedChange.of('changes.patch', title, body) }),
    review: (r: Review) => agents.reviews.push({ ok: true, value: r }),
    async drain(max = 10) {
      const results = [];
      for (let i = 0; i < max; i++) {
        const r = await run.execute();
        if (r.kind !== 'ran') break;
        results.push(r);
      }
      return results;
    },
    repo: REPO as RepoRef,
  };
}
