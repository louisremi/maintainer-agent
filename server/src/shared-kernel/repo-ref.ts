import { DomainError } from "./domain-error";
import { isPlatform, type Platform } from "./platform";

const HOST =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Identifies a repository independently of the forge: `owner/name` on GitHub,
 * `group/subgroup/name` on GitLab. Immutable value object.
 */
export class RepoRef {
	private constructor(
		readonly platform: Platform,
		readonly host: string,
		readonly path: string,
	) {}

	static of(platform: Platform, host: string, path: string): RepoRef {
		const h = host.toLowerCase();
		if (!HOST.test(h)) throw new DomainError(`invalid host: ${host}`);
		const segments = path.split("/");
		if (
			segments.length < 2 ||
			segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")
		) {
			throw new DomainError(`invalid repository path: ${path}`);
		}
		return new RepoRef(platform, h, path);
	}

	/** Parses the output of {@link RepoRef.key}. */
	static parse(key: string): RepoRef {
		const [, platform = "", host = "", path = ""] =
			/^([a-z]+):([^/]+)\/(.+)$/.exec(key) ?? [];
		if (!isPlatform(platform))
			throw new DomainError(`invalid repository key: ${key}`);
		return RepoRef.of(platform, host, path);
	}

	/** Stable identity, e.g. `github:github.com/octo/repo`. */
	get key(): string {
		return `${this.platform}:${this.host}/${this.path}`;
	}

	/** The account (user, organisation or top-level group) owning the repository. */
	get owner(): string {
		return this.path.split("/")[0] ?? this.path;
	}

	/** The last path segment. */
	get name(): string {
		return this.path.split("/").at(-1) ?? this.path;
	}

	equals(other: RepoRef): boolean {
		return this.key === other.key;
	}

	toString(): string {
		return this.key;
	}
}
