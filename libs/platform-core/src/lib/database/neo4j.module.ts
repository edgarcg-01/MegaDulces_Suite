import { Global, Module, Logger, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import neo4j, { Driver } from 'neo4j-driver';

/**
 * Conexión al **grafo de proveedores** (Neo4j) — MAAT.10 (colusión / red).
 *
 * Es una DB de grafos SEPARADA (servicio propio: Neo4j Aura o contenedor). El
 * motor de colusión de Maat (`maat_red_proveedores`) la usa para recorridos
 * multi-hop sobre atributos COMPARTIDOS entre proveedores (RFC/nombre hoy;
 * cuenta bancaria / representante legal / domicilio cuando se ingiera la data
 * forense). Aislarla del OLTP permite consultas de grafo sin contención.
 *
 * Vars necesarias:
 *   - `NEO4J_URI`      — ej. `neo4j+s://xxxx.databases.neo4j.io` (Aura) o `bolt://host:7687`
 *   - `NEO4J_USER`     — default 'neo4j'
 *   - `NEO4J_PASSWORD` — required si hay URI
 *
 * Si `NEO4J_URI` falta, el provider entrega `null` y `maat_red_proveedores`
 * cae al CTE recursivo en Postgres (misma capacidad por RFC/nombre, sin infra).
 * Así el código compila y queda dormido hasta provisionar Neo4j.
 */
export const NEO4J_DRIVER = 'NEO4J_DRIVER';

function buildDriver(): Driver | null {
  const logger = new Logger('Neo4jModule');
  const uri = process.env.NEO4J_URI;
  if (!uri) {
    logger.warn(
      'NEO4J_URI no configurada — maat_red_proveedores usará el CTE en Postgres. Setear para activar el grafo de colusión.',
    );
    return null;
  }
  const user = process.env.NEO4J_USER || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || '';
  try {
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      maxConnectionPoolSize: 10,
      connectionAcquisitionTimeout: 15_000,
    });
    logger.log(`Driver Neo4j inicializado (uri=${uri.replace(/\/\/.*@/, '//')}).`);
    return driver;
  } catch (e: any) {
    logger.error(`No se pudo crear el driver Neo4j: ${e?.message || e}. Fallback a CTE.`);
    return null;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: NEO4J_DRIVER,
      useFactory: (): Driver | null => buildDriver(),
    },
  ],
  exports: [NEO4J_DRIVER],
})
export class Neo4jModule implements OnModuleDestroy {
  constructor(@Optional() @Inject(NEO4J_DRIVER) private readonly driver: Driver | null) {}
  async onModuleDestroy(): Promise<void> {
    if (this.driver) await this.driver.close().catch(() => undefined);
  }
}
