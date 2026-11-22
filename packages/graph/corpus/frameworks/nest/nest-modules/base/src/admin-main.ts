import { NestFactory } from "@nestjs/core";
import { AdminModule } from "./admin/admin.module";

export async function startAdmin(): Promise<void> {
  const admin = await NestFactory.create(AdminModule);
  await admin.listen(3001);
}
