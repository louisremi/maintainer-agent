import { RepoRef } from '../../../shared-kernel';
import { ConnectionAccess, ForgeDirectory } from '../../../connections/application';
import { GithubAppClients } from './github-app-client';

/** Lists every repository of every installation of a GitHub App. */
export class GithubDirectory implements ForgeDirectory {
  constructor(private readonly clients: GithubAppClients) {}

  async listRepositories(access: ConnectionAccess): Promise<RepoRef[]> {
    const client = this.clients.for(access);
    const repos: RepoRef[] = [];
    for (let page = 1; page <= 20; page++) {
      const installations = await client.appRequest<{ id: number }[]>('GET', `/app/installations?per_page=100&page=${page}`);
      for (const inst of installations) {
        const token = await client.installationToken(inst.id);
        for (let rp = 1; rp <= 50; rp++) {
          const r = await client.http.request<{ repositories: { full_name: string }[] }>(
            'GET', `/installation/repositories?per_page=100&page=${rp}`, `token ${token}`,
          );
          for (const repo of r.repositories) repos.push(RepoRef.of('github', access.host, repo.full_name));
          if (r.repositories.length < 100) break;
        }
      }
      if (installations.length < 100) break;
    }
    return repos;
  }
}
