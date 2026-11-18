import { Get, JsonController } from "routing-controllers";

@JsonController("/other")
export class OtherController {
  @Get("/:id")
  find(): string {
    return "other";
  }
}
