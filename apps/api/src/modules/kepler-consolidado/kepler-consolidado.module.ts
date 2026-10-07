import { Module, Logger } from '@nestjs/common';
import knex from 'knex';
import { KNEX_KEPLER_CONSOLIDADO } from './kepler-consolidado.constants';
import { KeplerConsolidadoService } from './kepler-consolidado.service';

/**
 * Módulo de la consolidación de ventas Kepler (DB `kepler_consolidado`).
 *
 * Provee la conexión Knex a esa DB y el cron de polling inteligente.
 * Null-safe: si `DATABASE_URL_KEPLER_CONSOLIDADO` no está, la conexión es
 * null y el cron queda inerte (no rompe entornos sin la consolidación).
 */
@Module({
  providers: [
    {
      provide: KNEX_KEPLER_CONSOLIDADO,
      useFactory: () => {
        const logger = new Logger('KeplerConsolidadoModule');
        const connStr = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
        if (!connStr) {
          logger.warn(
            'DATABASE_URL_KEPLER_CONSOLIDADO no seteado — cron de consolidación Kepler inactivo.',
          );
          return null;
        }
        logger.log('Conexión a kepler_consolidado lista — cron de polling activo.');
        return knex({
          client: 'pg',
          connection: { connectionString: connStr },
          pool: { min: 0, max: 2 }, // pool chico — solo cron
        });
      },
    },
    KeplerConsolidadoService,
  ],
  exports: [KeplerConsolidadoService],
})
export class KeplerConsolidadoModule {}
