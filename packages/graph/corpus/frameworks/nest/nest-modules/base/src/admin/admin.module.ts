import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { AdminController } from "./admin.controller";

@Module({ imports: [SharedModule], controllers: [AdminController] })
export class AdminModule {}
