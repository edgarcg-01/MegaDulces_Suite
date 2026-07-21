import { Module } from '@nestjs/common';
import { DbHealthController } from './db-health.controller';
import { DbHealthService } from './db-health.service';

/**
 * Módulo de salud de DB (Administración). Depende de KNEX_NEW_DB_ADMIN, provisto por
 * NewDatabaseModule (@Global), así que solo se wirea bajo ENABLE_MULTITENANT.
 */
@Module({
  controllers: [DbHealthController],
  providers: [DbHealthService],
})
export class DbHealthModule {}
