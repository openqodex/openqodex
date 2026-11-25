import { Controller as NestController, Get as HttpGet } from "@nestjs/common";

@NestController()
export class HealthController {
  @HttpGet("health")
  check(): string {
    return "ok";
  }
}
