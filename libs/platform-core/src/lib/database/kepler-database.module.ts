import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';

/**
 * Conexión READ-ONLY a la **consolidación de ventas Kepler** (`kepler_consolidado`).
 *
 * Esa DB concentra la venta real de las 6 sucursales (`mart.ventas`) + la
 * dimensión `dim.sucursales`. Es una Postgres distinta de la transaccional
 * (no hay FDW hacia ella), así que las lecturas en vivo — como el generador
 * de reportes Sell-Out — necesitan su propia conexión.
 *
 * Var necesaria:
 *   - `DATABASE_URL_KEPLER_CONSOLIDADO` — connection string de la consolidación.
 *
 * Si falta, el provider entrega `null` y quien lo consuma debe degradar a
 * estado vacío (no rompe arranque ni entornos sin consolidación).
 */
export const KNEX_KEPLER_RO = 'KNEX_KEPLER_RO';

function buildKeplerRoConfig(): Knex.Config | null {
  const logger = new Logger('KeplerDatabaseModule');
  const connStr = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
  if (!connStr) {
    logger.warn(
      'DATABASE_URL_KEPLER_CONSOLIDADO no configurada — reportes Sell-Out sin fuente (degradan a vacío).',
    );
    return null;
  }
  const ssl = /rlwy|railway|proxy|amazonaws|render|supabase/i.test(connStr)
    ? { rejectUnauthorized: false }
    : false;
  logger.log('Conectando a kepler_consolidado (RO) para lecturas en vivo.');
  return {
    client: 'pg',
    connection: {
      connectionString: connStr,
      ssl,
      // Fail-fast a nivel socket + query: si la consolidación (on-prem) no es
      // alcanzable/lenta, no colgar el request hasta el timeout del proxy (504)
      // — el service degrada a vacío con aviso.
      connectionTimeoutMillis: 8000,
      statement_timeout: 25000,
    },
    pool: { min: 0, max: 4 },
    acquireConnectionTimeout: 8000,
  };
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX_KEPLER_RO,
      useFactory: (): Knex | null => {
        const cfg = buildKeplerRoConfig();
        return cfg ? knex(cfg) : null;
      },
    },
  ],
  exports: [KNEX_KEPLER_RO],
})
export class KeplerDatabaseModule {}
