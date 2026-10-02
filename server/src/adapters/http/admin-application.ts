import type { ConnectionSummary, RegistrationForm } from '../../connections/application';
import type { JobSummary } from '../../maintenance/application';

/** The operations the admin pages offer, implemented by the composition root. */
export interface AdminApplication {
  overview(): Promise<{
    connections: ConnectionSummary[];
    jobs: JobSummary[];
    modelAvailable: boolean;
    publicUrl: string;
    secretsEncrypted: boolean;
  }>;
  startGithubRegistration(input: { host: string; ownerAccount: string | null; isPublic: boolean }): Promise<RegistrationForm>;
  completeGithubRegistration(input: { state: string; code: string }): Promise<{ installUrl: string }>;
  resync(connectionId: string): Promise<{ watched: string[]; contested: string[]; released: string[] }>;
  setRepositoryEnabled(repoKey: string, enabled: boolean): Promise<void>;
  setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void>;
  removeConnection(connectionId: string): Promise<void>;
}
