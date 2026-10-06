import "reflect-metadata";
import { loadConfig } from "../adapters/config/server-config";
import { runCli } from "./cli";
import { buildApp } from "./container";
import { createHttpServer } from "./server";

async function main(): Promise<void> {
	const config = loadConfig(process.env);
	const app = await buildApp(config);
	await app.init();
	const http = await createHttpServer(app);
	(app as unknown as { httpClose: () => Promise<void> }).httpClose = () =>
		http.close();
	await http.listen(config.PORT, "0.0.0.0");
	if (app.settings) app.worker.start(app.periodic);
	app.log.info(
		app.settings
			? "maintainer-agent server started"
			: "maintainer-agent server started in SAFE MODE: fix settings.yml on /admin/settings",
		{
			port: config.PORT,
			settings: app.settingsAdmin.path,
			publicUrl: app.settings?.server.publicUrl,
			repositories: app.settings
				? Object.keys(app.settings.repositories).length
				: 0,
			runnerImage: app.settings?.server.runnerImage,
		},
	);
	const shutdown = async (signal: string) => {
		app.log.info("shutting down", { signal });
		await http.close();
		await app.close();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
	process.once("SIGINT", () => void shutdown("SIGINT"));
}

// `node main.js validate-config ...` and `schema ...` run the CLI instead.
const command = process.argv[2];
if (command === "validate-config" || command === "schema") {
	process.exit(runCli(process.argv.slice(2), process.env));
}
main().catch((err: Error) => {
	process.stderr.write(`${err.message}\n`);
	process.exit(1);
});
