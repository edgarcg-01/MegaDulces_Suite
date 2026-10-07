import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';

/**
 * Conexión a la **DB dedicada del RAG** (vector store) — Fase K v2.
 *
 * Es una Postgres SEPARADA (servicio propio en Railway) con pgvector, cuya
 * única tabla relevante es `product_embeddings` (corpus denormalizado para
 * el matcher de productos). Aislarla del DB transaccional permite:
 *   - reconstruir/re-embeber sin tocar data de negocio,
 *   - tunear índices HNSW / recursos por separado,
 *   - que el matcher haga KNN sin contención con el OLTP.
 *
 * Var necesaria:
 *   - `VECTOR_DATABASE_URL` — connection string del servicio Railway dedicado.
 *
 * Si falta, el provider entrega `null` y el matcher cae a su fuente legacy
 * (KNEX_CONNECTION) para no romper el arranque ni el deploy gradual.
 */
export const KNEX_VECTOR_DB = 'KNEX_VECTOR_DB';

function buildVectorDbConfig(): Knex.Config | null {
  const logger = new Logger('VectorDatabaseModule');
  const connStr = process.env.VECTOR_DATABASE_URL;
  if (!connStr) {
    logger.warn(
      'VECTOR_DATABASE_URL no configurada — el matcher usará la fuente legacy (KNEX_CONNECTION). Setear para activar la DB vector dedicada.',
    );
    return null;
  }
  const ssl = /rlwy|railway|proxy|amazonaws|render|supabase/i.test(connStr)
    ? { rejectUnauthorized: false }
    : false;
  logger.log('Conectando a la DB vector dedicada vía VECTOR_DATABASE_URL.');
  return {
    client: 'pg',
    connection: { connectionString: connStr, ssl },
    pool: { min: 0, max: 6 },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX_VECTOR_DB,
      useFactory: (): Knex | null => {
        const cfg = buildVectorDbConfig();
        return cfg ? knex(cfg) : null;
      },
    },
  ],
  exports: [KNEX_VECTOR_DB],
})
export class VectorDatabaseModule {}
