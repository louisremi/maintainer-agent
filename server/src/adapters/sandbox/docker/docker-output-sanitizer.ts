import { z } from "zod";
import type {
	OutputSanitizer,
	SanitizedText,
	SanitizeOptions,
} from "../../../maintenance/application";
import type { DockerSandbox } from "./sandbox";

const Result = z.object({
	results: z.array(
		z.object({
			text: z.string(),
			held: z.boolean(),
			reasons: z.array(z.string()),
		}),
	),
});

/**
 * Sanitises agent text with the runner's `sanitize` role in a container
 * without network (see runner/sanitize.py for what it removes and holds).
 */
export class DockerOutputSanitizer implements OutputSanitizer {
	constructor(private readonly sandbox: DockerSandbox) {}

	async sanitize(
		texts: readonly string[],
		options: SanitizeOptions,
	): Promise<SanitizedText[]> {
		if (texts.length === 0) return [];
		const r = await this.sandbox.run({
			role: "sanitize",
			runId: `sanitize-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			args: ["--json"],
			env: {
				SANITIZE_REPO_URL: options.webUrl,
				SANITIZE_EXTRA_LINK_PREFIXES: options.extraLinks.join(" "),
				...(options.maxChars
					? { SANITIZE_MAX_CHARS: String(options.maxChars) }
					: {}),
			},
			mounts: [],
			egress: [],
			memoryMb: 256,
			timeoutMs: 60_000,
			readOnlyRoot: true,
			stdin: JSON.stringify({ texts }),
		});
		if (r.exitCode !== 0)
			throw new Error(
				`sanitiser failed (exit ${r.exitCode}): ${r.stderr.slice(0, 300)}`,
			);
		const parsed = Result.parse(JSON.parse(r.stdout));
		if (parsed.results.length !== texts.length)
			throw new Error("sanitiser returned the wrong number of results");
		return parsed.results;
	}
}
