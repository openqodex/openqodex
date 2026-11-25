import { Controller, Get } from "@nestjs/common";

@Controller("shared")
export class SharedController {
  @Get()
  info(): string {
    return "shared, edited";
  }
}
