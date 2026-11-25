import { Controller, Get, Module } from "@nestjs/common";

@Controller("ping")
export class PingController {
  @Get()
  ping(): string {
    return "pong";
  }
}

@Module({ controllers: [PingController] })
export class PingModule {}
