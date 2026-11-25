import { Controller, Get } from "@nestjs/common";

@Controller("admin")
export class AdminController {
  @Get("stats")
  stats(): number {
    return 1;
  }
}
