import type Dockerode from 'dockerode';

export interface Mount {
  readonly host: string;
  readonly container: string;
  readonly readOnly: boolean;
}

/** A short-lived, hardened container. Every model container is started from one of these. */
export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: readonly Mount[];
  /** `none`, or the name of an internal network whose only exit is the egress proxy. */
  readonly network: 'none' | { readonly internal: string };
  readonly memoryMb: number;
  readonly pidsLimit?: number;
  readonly readOnlyRoot: boolean;
  readonly tmpfs?: Readonly<Record<string, string>>;
  readonly stdin?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

export const PROXY_ALIAS = 'egress';
export const PROXY_PORT = 8888;
export const MANAGED_LABEL = 'io.maintainer-agent.managed';

/**
 * The isolation every container gets. It mirrors what the v0.1 dispatcher
 * did with `docker run` flags: no capabilities, no privilege escalation,
 * PID and memory limits, an init process, non-root user. Agent containers
 * additionally sit on an `--internal` network with `--dns 127.0.0.1`: Docker's
 * embedded resolver still answers container names (the `egress` alias) but
 * forwards nothing, so DNS cannot be used to leak data; HTTP(S) goes through
 * the allow-list proxy only.
 */
export function toCreateOptions(spec: ContainerSpec): Dockerode.ContainerCreateOptions {
  const env: Record<string, string> = { ...spec.env };
  const internal = spec.network !== 'none';
  if (internal) {
    const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
    Object.assign(env, {
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
    });
  }
  return {
    name: spec.name,
    Image: spec.image,
    Cmd: [...spec.args],
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    User: '10001:10001',
    OpenStdin: Boolean(spec.stdin),
    StdinOnce: Boolean(spec.stdin),
    AttachStdin: Boolean(spec.stdin),
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Labels: { [MANAGED_LABEL]: 'true', ...(spec.labels ?? {}) },
    NetworkDisabled: !internal,
    HostConfig: {
      AutoRemove: false,
      Init: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      PidsLimit: spec.pidsLimit ?? 2048,
      Memory: spec.memoryMb * 1024 * 1024,
      MemorySwap: spec.memoryMb * 1024 * 1024,
      ReadonlyRootfs: spec.readOnlyRoot,
      Tmpfs: { ...(spec.tmpfs ?? {}) },
      NetworkMode: internal ? (spec.network as { internal: string }).internal : 'none',
      ...(internal ? { Dns: ['127.0.0.1'] } : {}),
      Binds: spec.mounts.map((m) => `${m.host}:${m.container}:${m.readOnly ? 'ro' : 'rw'}`),
      Privileged: false,
      IpcMode: 'private',
    },
  };
}
