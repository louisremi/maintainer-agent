import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ErrorsFilter } from "../adapters/http";
import type { App } from "./container";
import { HttpModule } from "./http.module";

/** Creates the Nest HTTP application around an assembled {@link App}. */
export async function createHttpServer(app: App): Promise<INestApplication> {
	const nest = await NestFactory.create<NestExpressApplication>(
		HttpModule.forApp(app),
		{
			rawBody: true,
			bodyParser: true,
			logger: ["error", "warn"],
		},
	);
	nest.useBodyParser("json", { limit: "6mb" });
	nest.useBodyParser("urlencoded", { extended: false, limit: "64kb" });
	nest.useGlobalFilters(new ErrorsFilter(app.log));
	nest.disable("x-powered-by");
	nest.enableShutdownHooks();
	return nest;
}
