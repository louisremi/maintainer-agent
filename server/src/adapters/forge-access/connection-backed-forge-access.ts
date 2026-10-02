import { Platform, RepoRef } from '../../shared-kernel';
import { ConnectionAccess } from '../../connections/application';
import { ForgeAccess, ForgeSession } from '../../maintenance/application';

/** Opens a session on one forge for a repository and the connection that owns it. */
export interface ForgeSessionFactory {
  open(repo: RepoRef, access: ConnectionAccess): ForgeSession;
}

export interface RepositoryAccessResolver {
  execute(repo: RepoRef, viaConnectionId?: string): Promise<ConnectionAccess | null>;
}

/**
 * Bridges the two bounded contexts: Maintenance asks for a session on a
 * repository; Connections says which credentials own it; a forge adapter
 * builds the session.
 */
export class ConnectionBackedForgeAccess implements ForgeAccess {
  constructor(
    private readonly resolver: RepositoryAccessResolver,
    private readonly factories: Partial<Record<Platform, ForgeSessionFactory>>,
  ) {}

  async session(repo: RepoRef, viaConnectionId?: string): Promise<ForgeSession | null> {
    const access = await this.resolver.execute(repo, viaConnectionId);
    if (!access) return null;
    const factory = this.factories[access.platform];
    if (!factory) throw new Error(`no forge adapter for ${access.platform}`);
    return factory.open(repo, access);
  }
}
