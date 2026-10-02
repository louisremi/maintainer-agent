import { RepoRef } from '../../../shared-kernel';
import { ConnectionAccess } from '../../../connections/application';
import { ForgeSession } from '../../../maintenance/application';
import { GithubAppClients } from './github-app-client';
import { GithubForgeSession } from './github-forge-session';

/** Opens GitHub sessions for connections of the `github` platform. */
export class GithubSessionFactory {
  constructor(private readonly clients: GithubAppClients) {}

  open(repo: RepoRef, access: ConnectionAccess): ForgeSession {
    return new GithubForgeSession(repo, this.clients.for(access));
  }
}
