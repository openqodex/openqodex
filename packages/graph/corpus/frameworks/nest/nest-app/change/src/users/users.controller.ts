import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import * as common from "@nestjs/common";
import { AuthGuard } from "../auth.guard";
import { USERS } from "../paths";

const ME = "me";

@UseGuards(AuthGuard)
@Controller(USERS)
export class UsersController {
  @Get()
  list(): string[] {
    return [];
  }

  @Get(ME)
  me(): string {
    return "me";
  }

  @Get(":id")
  getUser(@Param("id") id: string): string {
    return `user ${id}`;
  }

  @Post()
  create(@Body() body: string): string {
    return body;
  }

  @common.Delete(":id")
  remove(@Param("id") id: string): string {
    return id;
  }

  @Get(process.env.EXTRA_PATH)
  extra(): null {
    return null;
  }
}
