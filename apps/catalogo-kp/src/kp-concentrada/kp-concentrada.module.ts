import { Global, Module, Logger } from '@nestjs/common';
import knex from 'knex';
import { KNEX_KP_CONCENTRADA } from './kp-concentrada.constants';

/**
 * Conexión a `KP_CONCENTRADA` (Postgres en 192.168.0.245, schema `kp.*` +
 * los propios `admin.*`/`tienda.*`/`monitor.*` de este app).
 *
 * A diferencia de `KeplerConsolidadoModule` (cron opcional en apps/api, que
 * queda null-safe si el env falta), esta conexión ES la aplicación: no hay
 * "el resto del app" que siga funcionando sin ella. Por eso el factory hace
 * **throw** en boot si `DATABASE_URL_KP_CONCENTRADA` no está seteado, en vez
 * de devolver null — falla ruidoso en el arranque, no con 500s intermitentes.
 *
 * Rol: `catalogo_kp_runtime` (dedicado, NO `app_runtime` compartido con
 * postgres_platform — ver docs/GOTCHAS.md §24 y sql/007_rol_dedicado.sql).
 * `pool.max=10` iguala el default de `pg.Pool` que usaba el proyecto origen
 * (preserva el comportamiento bajo carga).
 */
@Global()
@Module({
  providers: [
    {
      provide: KNEX_KP_CONCENTRADA,
      useFactory: () => {
        const logger = new Logger('KpConcentradaModule');
        const connStr = process.env.DATABASE_URL_KP_CONCENTRADA;
        if (!connStr) {
          throw new Error(
            'DATABASE_URL_KP_CONCENTRADA no seteado — catalogo-kp no puede arrancar sin su base.',
          );
        }
        logger.log('Conexión a KP_CONCENTRADA lista.');
        return knex({
          client: 'pg',
          connection: { connectionString: connStr },
          pool: { min: 0, max: 10 },
        });
      },
    },
  ],
  exports: [KNEX_KP_CONCENTRADA],
})
export class KpConcentradaModule {}
