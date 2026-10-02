import { Logger } from '../../shared-kernel';
import { HostLimits, POLICY_FILE_CANDIDATES, RepositoryPolicy } from '../domain';
import { ForgeSession, PolicyValidator } from './ports';

export type PolicyLookup =
  | { readonly ok: true; readonly policy: RepositoryPolicy; readonly source: string | null }
  | { readonly ok: false; readonly source: string; readonly errors: readonly string[] };

/**
 * Finds a repository's policy file on its default branch and validates it in
 * isolation. No file means defaults; an invalid file means the server does
 * nothing in that repository until it is fixed (typos must never silently
 * switch a safeguard off).
 */
export class RepositoryPolicies {
  constructor(
    private readonly validator: PolicyValidator,
    private readonly limits: HostLimits,
    private readonly log: Logger,
  ) {}

  async load(session: ForgeSession, defaultBranch: string): Promise<PolicyLookup> {
    for (const path of POLICY_FILE_CANDIDATES) {
      const raw = await session.readFile(path, defaultBranch);
      if (raw === null) continue;
      const result = await this.validator.validate(raw);
      if (!result.ok) {
        this.log.warn('invalid repository policy; ignoring the repository', {
          repo: session.repo.key,
          path,
          errors: result.errors,
        });
        return { ok: false, source: path, errors: result.errors };
      }
      return { ok: true, policy: RepositoryPolicy.from(result.data, this.limits), source: path };
    }
    return { ok: true, policy: RepositoryPolicy.defaults(this.limits), source: null };
  }
}
