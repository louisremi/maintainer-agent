import { AccountAllowList, Clock, EventPublisher, IdGenerator, Logger, Role, UnitOfWork } from '../../shared-kernel';
import { DuplicateJobPolicy, EventTriage, ForgeEvent, HostLimits, isLabelEvent, MaintenanceJob } from '../domain';
import { ForgeAccess, MaintenanceJobRepository } from './ports';
import { RepositoryPolicies } from './repository-policies';

export interface HandleForgeEventDeps {
  readonly forge: ForgeAccess;
  readonly policies: RepositoryPolicies;
  readonly jobs: MaintenanceJobRepository;
  readonly allowList: AccountAllowList;
  readonly limits: HostLimits;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly uow: UnitOfWork;
  readonly events: EventPublisher;
  readonly log: Logger;
}

export type HandleForgeEventResult =
  | { readonly kind: 'queued'; readonly jobId: string }
  | { readonly kind: 'ignored'; readonly reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Turns a forge event into at most one queued maintenance job. */
export class HandleForgeEvent {
  constructor(private readonly d: HandleForgeEventDeps) {}

  async execute(input: { connectionId: string; event: ForgeEvent }): Promise<HandleForgeEventResult> {
    const { event } = input;
    const ignored = (reason: string): HandleForgeEventResult => {
      this.d.log.info('event ignored', { repo: event.repo.key, type: event.type, number: event.number, reason });
      return { kind: 'ignored', reason };
    };

    if (!this.d.allowList.allows(event.repo)) return ignored('account not allowed on this server');
    const session = await this.d.forge.session(event.repo, input.connectionId);
    if (!session) return ignored('repository not watched through this connection, or disabled');

    const branch = await session.getDefaultBranch();
    const lookup = await this.d.policies.load(session, branch.name);
    if (!lookup.ok) return ignored(`invalid policy in ${lookup.source}`);

    const now = this.d.clock.now();
    let actorRole: Role | null = null;
    if (isLabelEvent(event) && !event.actor.isBot) actorRole = await session.roleOf(event.actor.login);
    const authorJobsToday = await this.d.jobs.countTriggeredBy(event.actor.login, new Date(now.getTime() - DAY_MS));

    const decision = EventTriage.decide(event, {
      policy: lookup.policy,
      allowList: this.d.allowList,
      ownBotLogin: session.botLogin,
      actorRole,
      authorJobsToday,
      maxJobsPerAuthorPerDay: this.d.limits.maxJobsPerAuthorPerDay,
    });
    if (decision.kind === 'ignore') return ignored(decision.reason);

    const job = await this.d.uow.run(async () => {
      const active = await this.d.jobs.listActive(event.repo);
      if (!DuplicateJobPolicy.allows(decision.job, event.number, active)) return null;
      const queued = MaintenanceJob.queue({
        id: this.d.ids.next(),
        repo: event.repo,
        kind: decision.job,
        number: event.number,
        trigger: { cause: event.type, actorLogin: event.actor.login },
        ...(event.type === 'issue-labeled' && event.subjectFingerprint ? { context: { approvedFingerprint: event.subjectFingerprint } } : {}),
        now,
      });
      await this.d.jobs.save(queued);
      return queued;
    });
    if (!job) return ignored(`a ${decision.job} job is already active for #${event.number}`);
    await this.d.events.publish(job.pullEvents());
    this.d.log.info('job queued', { jobId: job.id, repo: job.repo.key, kind: job.kind, number: job.number });
    return { kind: 'queued', jobId: job.id };
  }
}
