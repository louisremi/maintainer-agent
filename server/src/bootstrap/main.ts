import 'reflect-metadata';
import { loadConfig } from '../adapters/config/server-config';
import { buildApp } from './container';
import { createHttpServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp(config);
  await app.init();
  const http = await createHttpServer(app);
  await http.listen(config.PORT, '0.0.0.0');
  app.worker.start(app.periodic);
  app.log.info('maintainer-agent server started', {
    port: config.PORT,
    publicUrl: config.PUBLIC_URL,
    admin: `${config.PUBLIC_URL}/admin`,
    model: config.LLM_MODEL,
    runnerImage: config.RUNNER_IMAGE,
  });
  const shutdown = async (signal: string) => {
    app.log.info('shutting down', { signal });
    await http.close();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
