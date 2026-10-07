import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

/**
 * `[AU.0]` `OrgController` entra acá y no en un módulo propio: comparte el
 * mismo par de permisos (`USUARIOS_VER` / `USUARIOS_GESTIONAR`) y las mismas
 * dependencias (`KNEX_CONNECTION`, `TenantContextService`). Un módulo aparte
 * sería una carpeta más para el mismo dominio.
 */
@Module({
  controllers: [UsersController, OrgController],
  providers: [UsersService, OrgService],
})
export class UsersModule {}
