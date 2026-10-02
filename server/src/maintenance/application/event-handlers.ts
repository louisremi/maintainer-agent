import { DomainEvent, isRepositoryWatched, Logger, RepoRef } from '../../shared-kernel';
import { JobEscalated, LABEL_DEFINITIONS, Labels } from '../domain';
import { footer } from './task-builder';
import { ForgeAccess } from './ports';

/** Reacts to events from both contexts with side effects on the forge. */
export class MaintenanceEventHandlers {
  constructor(private readonly forge: ForgeAccess, private readonly log: Logger) {}

  async handle(event: DomainEvent): Promise<void> {
    try {
      if (isRepositoryWatched(event)) {
        const session = await this.forge.session(RepoRef.parse(event.repoKey));
        await session?.ensureLabels(LABEL_DEFINITIONS);
      } else if (event instanceof JobEscalated) {
        const session = await this.forge.session(RepoRef.parse(event.repoKey));
        if (!session) return;
        await session.addLabel(event.number, Labels.needsHuman);
        await session.comment(
          event.number,
          footer(
            `I could not finish this automatically and stopped. A maintainer should take a look (reason: ${event.reason.replace(/\s+/g, ' ').slice(0, 300)}). Remove the \`${Labels.needsHuman}\` label and add \`${Labels.fix}\` to let me try again.`,
          ),
        );
      }
    } catch (err) {
      this.log.warn('event handler failed', { type: event.type, reason: err instanceof Error ? err.message : String(err) });
    }
  }
}
