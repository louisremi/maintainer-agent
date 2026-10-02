import { RepoRef } from './repo-ref';

/**
 * Accounts (users, organisations, top-level groups) whose repositories the
 * server may act on. Entries are `account` (any host) or `host/account`.
 * An empty list allows every account.
 */
export class AccountAllowList {
  private constructor(private readonly entries: readonly { host: string | null; account: string }[]) {}

  static parse(raw: string | readonly string[] | undefined): AccountAllowList {
    const items = (typeof raw === 'string' ? raw.split(/[\s,]+/) : raw ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return new AccountAllowList(
      items.map((item) => {
        const slash = item.lastIndexOf('/');
        return slash > 0
          ? { host: item.slice(0, slash), account: item.slice(slash + 1) }
          : { host: null, account: item };
      }),
    );
  }

  get isUnrestricted(): boolean {
    return this.entries.length === 0;
  }

  allows(repo: RepoRef): boolean {
    if (this.isUnrestricted) return true;
    const owner = repo.owner.toLowerCase();
    return this.entries.some((e) => e.account === owner && (e.host === null || e.host === repo.host));
  }
}
