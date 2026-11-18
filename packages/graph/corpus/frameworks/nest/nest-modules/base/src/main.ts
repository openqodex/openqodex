import { VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

const PREFIX = "api";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(PREFIX, { exclude: ["health"] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  await app.listen(3000);
}
void bootstrap();
