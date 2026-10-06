/**
 * Architecture rules (hexagonal + DDD). `pnpm arch` fails on any violation.
 *
 *   shared-kernel  <- domain <- application <- adapters <- bootstrap
 *
 * - The domain and application layers are plain TypeScript: no framework,
 *   no SDK, no Node I/O. Ports are interfaces declared in `application`.
 * - Bounded contexts (connections, maintenance) never import each other;
 *   they meet only in adapters and the composition root (bootstrap).
 * - Adapters never import the bootstrap; forge adapters are wired only there.
 */
const CORE = "^src/(shared-kernel|connections|maintenance|settings)/";

module.exports = {
	forbidden: [
		{
			name: "core-is-framework-free",
			comment:
				"shared-kernel, domain and application import nothing from npm or Node built-ins.",
			severity: "error",
			from: { path: CORE },
			to: { dependencyTypesNot: ["local"] },
		},
		{
			name: "shared-kernel-is-self-contained",
			severity: "error",
			from: { path: "^src/shared-kernel/" },
			to: { path: "^src/(?!shared-kernel/)" },
		},
		{
			name: "domain-depends-on-domain-only",
			comment:
				"A domain layer may import its own domain and the shared kernel only.",
			severity: "error",
			from: { path: "^src/(connections|maintenance|settings)/domain/" },
			to: { path: "^src/(?!shared-kernel/|$1/domain/)" },
		},
		{
			name: "application-does-not-know-adapters",
			severity: "error",
			from: { path: "^src/(connections|maintenance|settings)/application/" },
			to: { path: "^src/(?!shared-kernel/|$1/(domain|application)/)" },
		},
		{
			name: "adapters-do-not-know-bootstrap",
			severity: "error",
			from: { path: "^src/adapters/" },
			to: { path: "^src/bootstrap/" },
		},
		{
			name: "adapters-use-the-application-layer",
			comment:
				"Adapters talk to a context through its application layer (ports, use cases, DTOs) and its public domain types.",
			severity: "error",
			from: { path: "^src/adapters/" },
			to: {
				path: "^src/(connections|maintenance|settings)/(?!domain/|application/)",
			},
		},
		{
			name: "forge-adapters-are-isolated",
			comment:
				"Only the composition root may depend on a specific forge adapter (forges/<name>/).",
			severity: "error",
			from: { path: "^src/adapters/", pathNot: "^src/adapters/forges/" },
			to: { path: "^src/adapters/forges/[^/]+/" },
		},
		{
			name: "forges-do-not-depend-on-each-other",
			severity: "error",
			from: { path: "^src/adapters/forges/([^/]+)/" },
			to: {
				path: "^src/adapters/forges/[^/]+/",
				pathNot: "^src/adapters/forges/$1/",
			},
		},
		{
			name: "forges-are-transport-agnostic",
			comment:
				"Forge adapters do not know the HTTP framework or other inbound adapters.",
			severity: "error",
			from: { path: "^src/adapters/forges/" },
			to: { path: "^src/adapters/(http|worker)/" },
		},
		{
			name: "no-circular",
			severity: "error",
			from: {},
			to: { circular: true },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
		},
	},
};
