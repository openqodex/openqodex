import { Controller, Get, VERSION_NEUTRAL } from "@nestjs/common";

@Controller({ path: "dogs", version: ["1", VERSION_NEUTRAL] })
export class DogsController {
  @Get()
  list(): string[] {
    return [];
  }
}
