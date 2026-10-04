import type { ContainerEngine, RunResult } from "./container-engine";
import {
	type ContainerSpec,
	type Mount,
	PROXY_ALIAS,
	PROXY_PORT,
} from "./container-spec";

export interface SandboxConfig {
	readonly runnerImage: string;
	/** Prefix of every container and network name, to find leftovers. */
	readonly namePrefix: string;
}

export interface SandboxRun {
	readonly role: string;
	readonly runId: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly mounts: readonly Mount[];
	/** Hosts reachable through the proxy; empty = no network at all. */
	readonly egress: readonly string[];
	readonly memoryMb: number;
	readonly timeoutMs: number;
	readonly readOnlyRoot: boolean;
	readonly tmpfs?: Readonly<Record<string, string>>;
	readonly stdin?: string;
	/** Where to write the proxy log (allowed and refused hosts). */
	readonly egressLogFile?: string;
}

export interface SandboxResult extends RunResult {
	readonly egressLog: string;
}

const HOST = /^[a-z0-9*]([a-z0-9*.-]{0,251}[a-z0-9])?$/;

/**
 * `*` may appear only in the first label and must be followed by enough plain
 * labels that it cannot open a whole top-level domain (`*.com`, `*.co.uk`):
 * two, or three when the label before the TLD is short (co, com, org...).
 * Same rule as runner/policy.py; checked here too because this is the boundary.
 */
export function isSafeEgressHost(host: string): boolean {
	if (!HOST.test(host) || host.includes("..")) return false;
	const labels = host.split(".");
	const [first, ...rest] = labels;
	if (first === undefined || rest.length < 1) return false;
	if (rest.some((l) => l.includes("*"))) return false;
	if (!first.includes("*")) return true;
	if (rest.length < 2) return false;
	return rest.length >= 3 || (rest[0]?.length ?? 0) > 3;
}

/**
 * Runs one runner role in isolation. With egress hosts, the container gets a
 * fresh `--internal` network whose only other member is an allow-list proxy
 * (the runner's `egress` role); without, it has no network at all.
 */
export class DockerSandbox {
	constructor(
		private readonly engine: ContainerEngine,
		private readonly config: SandboxConfig,
		private readonly writeFile: (path: string, data: string) => Promise<void>,
	) {}

	get image(): string {
		return this.config.runnerImage;
	}

	async run(r: SandboxRun): Promise<SandboxResult> {
		const base = `${this.config.namePrefix}${r.runId}-${r.role}`
			.replace(/[^a-zA-Z0-9_.-]/g, "-")
			.slice(0, 120);
		const spec: Omit<ContainerSpec, "network"> = {
			name: base,
			image: this.config.runnerImage,
			args: [r.role, ...r.args],
			env: r.env,
			mounts: r.mounts,
			memoryMb: r.memoryMb,
			readOnlyRoot: r.readOnlyRoot,
			...(r.tmpfs ? { tmpfs: r.tmpfs } : {}),
			...(r.stdin !== undefined ? { stdin: true } : {}),
			labels: {
				"io.maintainer-agent.role": r.role,
				"io.maintainer-agent.run": r.runId,
			},
		};
		const runOpts = {
			timeoutMs: r.timeoutMs,
			...(r.stdin !== undefined ? { stdin: r.stdin } : {}),
		};
		if (r.egress.length === 0) {
			return {
				...(await this.engine.run({ ...spec, network: "none" }, runOpts)),
				egressLog: "",
			};
		}

		const hosts = [
			...new Set(r.egress.map((h) => h.toLowerCase().replace(/:\d+$/, ""))),
		];
		for (const h of hosts)
			if (!isSafeEgressHost(h) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h))
				throw new Error(`invalid egress host: ${h}`);
		const net = `${base}-net`;
		const proxy = `${base}-egress`;
		let egressLog = "";
		const subnet = await this.engine.createInternalNetwork(net);
		if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(subnet)) {
			await this.engine.removeNetwork(net);
			throw new Error(`unexpected subnet for ${net}: ${subnet}`);
		}
		try {
			await this.engine.startDetached({
				name: proxy,
				image: this.config.runnerImage,
				args: ["egress"],
				// Only containers of this job's internal network may use the proxy.
				env: { EGRESS_ALLOW: hosts.join(" "), EGRESS_CLIENTS: subnet },
				mounts: [],
				memoryMb: 256,
				readOnlyRoot: true,
				tmpfs: { "/tmp": "rw,size=16m" },
				network: "bridge",
				labels: {
					"io.maintainer-agent.role": "egress",
					"io.maintainer-agent.run": r.runId,
				},
			});
			await this.engine.connect(net, proxy, PROXY_ALIAS);
			await this.waitForProxy(proxy);
			const result = await this.engine.run(
				{ ...spec, network: { internal: net } },
				runOpts,
			);
			egressLog = await this.engine.logs(proxy).catch(() => "");
			return { ...result, egressLog };
		} finally {
			if (!egressLog) egressLog = await this.engine.logs(proxy).catch(() => "");
			if (r.egressLogFile)
				await this.writeFile(r.egressLogFile, egressLog).catch(() => undefined);
			await this.engine.remove(proxy);
			await this.engine.removeNetwork(net);
		}
	}

	private async waitForProxy(container: string): Promise<void> {
		for (let i = 0; i < 40; i++) {
			if (
				(await this.engine
					.exec(container, ["bash", "-c", `</dev/tcp/127.0.0.1/${PROXY_PORT}`])
					.catch(() => 1)) === 0
			)
				return;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error("egress proxy did not start");
	}
}
