import { Controller, Get, Version } from "@nestjs/common";

@Controller()
export class CatsController {
  @Get()
  list(): string[] {
    return [];
  }

  @Get(":id")
  find(): string {
    return "cat";
  }

  @Version("2")
  @Get("new")
  newest(): string {
    return "kitten";
  }
}
