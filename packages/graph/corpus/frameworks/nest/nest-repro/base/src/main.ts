import { NestFactory } from '@nestjs/core';
import { UsersController } from './users.controller'; // oxlint-disable-line no-unused-vars
async function bootstrap() { const app = await NestFactory.create(class M {}); await app.listen(3000); }
bootstrap();
