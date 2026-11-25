import type { Type } from "@nestjs/common";
import { Controller, Get, Module } from "./decorators";

@Controller("local")
export class LocalController {
  @Get(":id")
  find(): string {
    return "local";
  }
}

@Module({ controllers: [LocalController] })
export class LocalModule {}

export const kind: Type | null = null;
