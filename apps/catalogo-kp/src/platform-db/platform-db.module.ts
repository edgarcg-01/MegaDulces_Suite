import { Global, Module, Logger } from '@nestjs/common';
import knex from 'knex';
import { KNEX_PLATFORM } from './platform-db.constants';

/**
 * Conexión a `postgres_platform` — la base de PROD de la Suite.
 *
 * **Repuntada desde `KP_CONCENTRADA` (CV.22, review del PR #62).** Este app leía
 * el espejo `kp.*` de una base copia en `192.168.0.245`; ahora lee `kepler_ods.*`
 * en la misma base donde vive la plataforma, que es la fuente canónica del
 * proyecto (regla #1: cero copias, todo del ODS) y la refresca el CDC al segundo.
 *
 * Dos consecuencias del cambio, ambas buscadas:
 *
 *  1. **Se cae la restricción de LAN.** `KP_CONCENTRADA` sólo era alcanzable
 *     desde la red de Mega Dulces; `postgres_platform` en Railway se alcanza
 *     desde donde sea. El README de este app decía "no tiene alternativa Docker"
 *     por esa razón — ya no aplica.
 *  2. **Sus tablas propias** (`admin.*`, `tienda.*`, `monitor.*`) pasan a vivir
 *     en esta misma base, versionadas como migraciones Knex en
 *     `database/migrations-newdb/` en vez de los `sql/*.sql` corridos a mano.
 *
 * A diferencia de `KeplerConsolidadoModule` (cron opcional en apps/api, null-safe
 * si el env falta), esta conexión ES la aplicación: no hay "el resto del app" que
 * siga funcionando sin ella. Por eso el factory hace **throw** en boot si falta el
 * connection string — falla ruidoso al arrancar, no con 500s intermitentes.
 *
 * `DATABASE_URL_NEW` es el mismo nombre de env que usa `database/knexfile-newdb.js`,
 * para que una sola variable describa "la base de la plataforma" en todo el repo.
 * SSL se prende salvo contra hosts locales/LAN, igual que ese knexfile: Railway lo
 * exige y un Postgres on-prem no lo soporta (`the server does not support SSL`).
 *
 * `pool.max=10` iguala el default de `pg.Pool` que usaba el proyecto origen
 * (preserva el comportamiento bajo carga).
 */
@Global()
@Module({
  providers: [
    {
      provide: KNEX_PLATFORM,
      useFactory: () => {
        const logger = new Logger('PlatformDbModule');
        const connStr = process.env.DATABASE_URL_NEW;
        if (!connStr) {
          throw new Error(
            'DATABASE_URL_NEW no seteado — catalogo-kp no puede arrancar sin la base de la plataforma.',
          );
        }
        // Mismo criterio que database/knexfile-newdb.js: local/LAN sin SSL, remoto con.
        const esLocal = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(connStr);
        logger.log(`Conexión a postgres_platform lista (ssl=${!esLocal}).`);
        return knex({
          client: 'pg',
          connection: esLocal
            ? { connectionString: connStr }
            : { connectionString: connStr, ssl: { rejectUnauthorized: false } },
          pool: { min: 0, max: 10 },
        });
      },
    },
  ],
  exports: [KNEX_PLATFORM],
})
export class PlatformDbModule {}
