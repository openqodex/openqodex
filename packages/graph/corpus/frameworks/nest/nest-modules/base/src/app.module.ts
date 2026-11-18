import { forwardRef, Module } from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import { HealthController } from "./health.controller";
import { CatsModule } from "./pets/cats.module";
import { DogsModule } from "./pets/dogs.module";
import { PetsModule } from "./pets/pets.module";
import { SharedModule } from "./shared/shared.module";

@Module({
  imports: [
    PetsModule,
    CatsModule,
    DogsModule,
    forwardRef(() => SharedModule),
    RouterModule.register([
      {
        path: "pets",
        module: PetsModule,
        children: [{ path: "cats", module: CatsModule }, DogsModule],
      },
    ]),
  ],
  controllers: [HealthController],
})
export class AppModule {}
