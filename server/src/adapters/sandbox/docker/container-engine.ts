import Dockerode from 'dockerode';
import { PassThrough } from 'node:stream';
import { ContainerSpec, MANAGED_LABEL, toCreateOptions } from './container-spec';

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** The few Docker operations the sandbox needs; faked in tests. */
export interface ContainerEngine {
  run(spec: ContainerSpec, options: { stdin?: string; timeoutMs: number; maxOutputBytes?: number }): Promise<RunResult>;
  /** Creates an `--internal` network; returns its IPv4 subnet (CIDR). */
  createInternalNetwork(name: string): Promise<string>;
  removeNetwork(name: string): Promise<void>;
  /** Starts a long-running container on the default bridge (the egress proxy). */
  startDetached(spec: Omit<ContainerSpec, 'network'> & { network: 'bridge' }): Promise<void>;
  connect(network: string, container: string, alias: string): Promise<void>;
  /** Exit code of a command run inside a running container. */
  exec(container: string, cmd: readonly string[]): Promise<number>;
  logs(container: string): Promise<string>;
  remove(container: string): Promise<void>;
  pull(image: string): Promise<void>;
  /** Removes leftovers of earlier runs (crashes). */
  removeManaged(prefix: string): Promise<number>;
}

const limit = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '\n[output truncated]' : s);

export class DockerodeEngine implements ContainerEngine {
  constructor(private readonly docker = new Dockerode()) {}

  async run(spec: ContainerSpec, options: { stdin?: string; timeoutMs: number; maxOutputBytes?: number }): Promise<RunResult> {
    const max = options.maxOutputBytes ?? 4 * 1024 * 1024;
    const container = await this.docker.createContainer(toCreateOptions(spec));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    stdout.on('data', (b: Buffer) => { if (outBytes < max) { out.push(b); outBytes += b.length; } });
    stderr.on('data', (b: Buffer) => { if (errBytes < max) { err.push(b); errBytes += b.length; } });
    let timedOut = false;
    try {
      const stream = await container.attach({ stream: true, stdin: Boolean(spec.stdin), stdout: true, stderr: true, hijack: Boolean(spec.stdin) });
      this.docker.modem.demuxStream(stream, stdout, stderr);
      await container.start();
      if (spec.stdin) {
        stream.end(options.stdin ?? '');
      }
      const timer = setTimeout(() => {
        timedOut = true;
        container.kill().catch(() => undefined);
      }, options.timeoutMs);
      const status = (await container.wait()) as { StatusCode: number };
      clearTimeout(timer);
      await new Promise((r) => setImmediate(r));
      return {
        exitCode: status.StatusCode,
        stdout: limit(Buffer.concat(out).toString('utf8'), max),
        stderr: limit(Buffer.concat(err).toString('utf8'), max),
        timedOut,
      };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  async createInternalNetwork(name: string): Promise<string> {
    const net = await this.docker.createNetwork({ Name: name, Internal: true, Driver: 'bridge', EnableIPv6: false, Labels: { [MANAGED_LABEL]: 'true' } });
    const info = (await net.inspect()) as { IPAM?: { Config?: { Subnet?: string }[] } };
    const subnet = info.IPAM?.Config?.find((c) => c.Subnet && c.Subnet.includes('.'))?.Subnet;
    if (!subnet) throw new Error(`network ${name} has no IPv4 subnet`);
    return subnet;
  }

  async removeNetwork(name: string): Promise<void> {
    await this.docker.getNetwork(name).remove().catch(() => undefined);
  }

  async startDetached(spec: Omit<ContainerSpec, 'network'> & { network: 'bridge' }): Promise<void> {
    const opts = toCreateOptions({ ...spec, network: { internal: 'bridge' } });
    // The proxy itself must resolve and reach the allowed hosts: normal DNS, default bridge.
    delete opts.HostConfig!.Dns;
    opts.Env = (opts.Env ?? []).filter((e) => !/^(HTTPS?|NO)_PROXY=|^(https?|no)_proxy=/.test(e));
    const c = await this.docker.createContainer(opts);
    await c.start();
  }

  async connect(network: string, container: string, alias: string): Promise<void> {
    await this.docker.getNetwork(network).connect({ Container: container, EndpointConfig: { Aliases: [alias] } });
  }

  async exec(container: string, cmd: readonly string[]): Promise<number> {
    const e = await this.docker.getContainer(container).exec({ Cmd: [...cmd], AttachStdout: true, AttachStderr: true });
    const stream = await e.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => { stream.on('end', resolve); stream.on('close', resolve); stream.resume(); });
    const info = await e.inspect();
    return info.ExitCode ?? 1;
  }

  async logs(container: string): Promise<string> {
    const buf = (await this.docker.getContainer(container).logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
    // Strip Docker's 8-byte multiplexing headers.
    const parts: Buffer[] = [];
    for (let i = 0; i + 8 <= buf.length;) {
      const size = buf.readUInt32BE(i + 4);
      parts.push(buf.subarray(i + 8, i + 8 + size));
      i += 8 + size;
    }
    return Buffer.concat(parts).toString('utf8');
  }

  async remove(container: string): Promise<void> {
    await this.docker.getContainer(container).remove({ force: true }).catch(() => undefined);
  }

  async pull(image: string): Promise<void> {
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())));
  }

  async removeManaged(prefix: string): Promise<number> {
    let n = 0;
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } });
    for (const c of containers) {
      if (c.Names.some((x) => x.replace(/^\//, '').startsWith(prefix))) {
        await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
        n++;
      }
    }
    const networks = await this.docker.listNetworks({ filters: { label: [`${MANAGED_LABEL}=true`] } });
    for (const net of networks) {
      if (net.Name.startsWith(prefix)) { await this.docker.getNetwork(net.Id).remove().catch(() => undefined); n++; }
    }
    return n;
  }
}
