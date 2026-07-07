import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Driver, isInt } from 'neo4j-driver';
import { NEO4J_DRIVER, TenantKnexService } from '@megadulces/platform-core';

/**
 * MAAT.10 — Grafo de proveedores (colusión / red) en Neo4j.
 *
 * Modelo bipartito, alimentado desde `analytics.expense_documents`:
 *   (:Beneficiario {tenant_id, name, total}) -[:USA_RFC {docs, importe}]-> (:Rfc {tenant_id, rfc})
 *
 * Captura sin esfuerzo:
 *   - fan-in:  un RFC con ≥2 beneficiarios  → fragmentación / split-invoicing
 *   - fan-out: un beneficiario con ≥2 RFC   → shell / error de captura
 *   - anillos: beneficiario→rfc→beneficiario→rfc… (multi-hop) → red de colusión
 *
 * FUTURO (data forense — hoy NO ingerida; el 201 de Kepler es plano). Cuando se
 * ingiera, es solo agregar aristas al MISMO grafo (el resto de las queries ya
 * las aprovecha vía el recorrido genérico):
 *   (:Beneficiario)-[:USA_CUENTA]->(:CuentaBancaria {clabe})
 *   (:Beneficiario)-[:REP_LEGAL]->(:Persona {rfc})
 *   (:Beneficiario)-[:DOMICILIO]->(:Direccion {hash})
 *
 * Degrada solo: sin NEO4J_URI el driver es null → `available()` false → el tool
 * `maat_red_proveedores` cae al CTE recursivo en Postgres (misma capacidad por
 * RFC/nombre). Este servicio nunca lanza: ante error, loguea y devuelve vacío.
 */
@Injectable()
export class MaatProviderGraphService {
  private readonly logger = new Logger(MaatProviderGraphService.name);
  private schemaReady = false;

  constructor(
    @Optional() @Inject(NEO4J_DRIVER) private readonly driver: Driver | null,
    private readonly tk: TenantKnexService,
  ) {}

  available(): boolean {
    return !!this.driver;
  }

  private num(v: any): number {
    return isInt(v) ? v.toNumber() : Number(v || 0);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady || !this.driver) return;
    const s = this.driver.session();
    try {
      await s.run('CREATE INDEX maat_benef_idx IF NOT EXISTS FOR (b:Beneficiario) ON (b.tenant_id, b.name)');
      await s.run('CREATE INDEX maat_rfc_idx IF NOT EXISTS FOR (r:Rfc) ON (r.tenant_id, r.rfc)');
      this.schemaReady = true;
    } catch (e: any) {
      this.logger.warn(`ensureSchema Neo4j: ${e?.message || e}`);
    } finally {
      await s.close();
    }
  }

  /**
   * Reconstruye el subgrafo del tenant desde Postgres (idempotente: wipe + rebuild).
   * Lee vía TenantKnexService (RLS). Devuelve conteos.
   */
  async sync(tenantId: string): Promise<{ synced: boolean; beneficiarios: number; rfcs: number; aristas: number; nota?: string }> {
    if (!this.driver) return { synced: false, beneficiarios: 0, rfcs: 0, aristas: 0, nota: 'Neo4j no configurado (NEO4J_URI).' };
    await this.ensureSchema();

    const rows: Array<{ name: string; rfc: string; docs: number; importe: number }> = await this.tk.run(async (trx) =>
      trx('analytics.expense_documents')
        .where('tenant_id', tenantId)
        .whereRaw("NULLIF(btrim(rfc),'') IS NOT NULL")
        .whereRaw("NULLIF(btrim(beneficiario),'') IS NOT NULL")
        .groupByRaw('upper(btrim(beneficiario)), upper(btrim(rfc))')
        .select(
          trx.raw('upper(btrim(beneficiario)) AS name'),
          trx.raw('upper(btrim(rfc)) AS rfc'),
          trx.raw('count(*)::int AS docs'),
          trx.raw('ROUND(SUM(importe)::numeric,2)::float8 AS importe'),
        ),
    );

    const pairs = rows.map((r) => ({ name: r.name, rfc: r.rfc, docs: Number(r.docs), importe: Number(r.importe) }));
    const s = this.driver.session();
    try {
      // Wipe scoped al tenant, luego rebuild en lotes.
      await s.run('MATCH (n) WHERE n.tenant_id = $t DETACH DELETE n', { t: tenantId });
      const CHUNK = 1000;
      for (let i = 0; i < pairs.length; i += CHUNK) {
        await s.run(
          `UNWIND $rows AS row
           MERGE (b:Beneficiario {tenant_id: $t, name: row.name})
             ON CREATE SET b.total = row.importe
             ON MATCH  SET b.total = coalesce(b.total, 0) + row.importe
           MERGE (r:Rfc {tenant_id: $t, rfc: row.rfc})
           MERGE (b)-[u:USA_RFC]->(r)
             SET u.docs = row.docs, u.importe = row.importe`,
          { t: tenantId, rows: pairs.slice(i, i + CHUNK) },
        );
      }
      const counts = await s.run(
        `MATCH (b:Beneficiario {tenant_id:$t}) WITH count(b) AS nb
         MATCH (r:Rfc {tenant_id:$t}) WITH nb, count(r) AS nr
         MATCH (:Beneficiario {tenant_id:$t})-[u:USA_RFC]->(:Rfc {tenant_id:$t}) RETURN nb, nr, count(u) AS ne`,
        { t: tenantId },
      );
      const rec = counts.records[0];
      const out = {
        synced: true,
        beneficiarios: rec ? this.num(rec.get('nb')) : 0,
        rfcs: rec ? this.num(rec.get('nr')) : 0,
        aristas: rec ? this.num(rec.get('ne')) : 0,
      };
      this.logger.log(`grafo sync: ${out.beneficiarios} beneficiarios, ${out.rfcs} RFC, ${out.aristas} aristas.`);
      return out;
    } catch (e: any) {
      this.logger.error(`sync Neo4j falló: ${e?.message || e}`);
      return { synced: false, beneficiarios: 0, rfcs: 0, aristas: 0, nota: `Error de grafo: ${e?.message || e}` };
    } finally {
      await s.close();
    }
  }

  /** Recorrido multi-hop desde un beneficiario foco (anillo de colusión). */
  async network(tenantId: string, foco: string, hops = 4, limit = 20): Promise<Array<{ proveedor: string; saltos: number; via_rfc?: string }> | null> {
    if (!this.driver) return null;
    const maxRels = Math.min(12, Math.max(2, hops * 2)); // cada salto = beneficiario→rfc→beneficiario (2 rels)
    const s = this.driver.session();
    try {
      const res = await s.run(
        `MATCH (start:Beneficiario {tenant_id:$t})
         WHERE toLower(start.name) CONTAINS toLower($foco)
         MATCH path = (start)-[:USA_RFC*1..${maxRels}]-(other:Beneficiario {tenant_id:$t})
         WHERE other <> start
         WITH other, min(length(path)) AS rels
         RETURN other.name AS proveedor, (rels/2) AS saltos
         ORDER BY saltos, proveedor
         LIMIT $limit`,
        { t: tenantId, foco, limit: Math.min(50, Math.max(1, limit)) },
      );
      return res.records.map((r) => ({ proveedor: r.get('proveedor'), saltos: this.num(r.get('saltos')) }));
    } catch (e: any) {
      this.logger.warn(`network Neo4j falló (${e?.message || e}); fallback a CTE.`);
      return null;
    } finally {
      await s.close();
    }
  }

  /** Estructuras sospechosas globales (fan-in / fan-out) desde el grafo. */
  async rings(tenantId: string, limit = 20): Promise<{
    rfc_multi_nombre: Array<{ rfc: string; nombres: number; ejemplos: string[]; importe: number }>;
    nombre_multi_rfc: Array<{ nombre: string; rfcs: number; importe: number }>;
  } | null> {
    if (!this.driver) return null;
    const lim = Math.min(50, Math.max(1, limit));
    const s = this.driver.session();
    try {
      const rfcRes = await s.run(
        `MATCH (b:Beneficiario {tenant_id:$t})-[u:USA_RFC]->(r:Rfc {tenant_id:$t})
         WITH r, collect(DISTINCT b.name) AS nombres, sum(u.importe) AS importe
         WHERE size(nombres) >= 2
         RETURN r.rfc AS rfc, size(nombres) AS nombres, nombres[0..5] AS ejemplos, importe
         ORDER BY importe DESC LIMIT $lim`,
        { t: tenantId, lim },
      );
      const nomRes = await s.run(
        `MATCH (b:Beneficiario {tenant_id:$t})-[u:USA_RFC]->(r:Rfc {tenant_id:$t})
         WITH b, collect(DISTINCT r.rfc) AS rfcs, sum(u.importe) AS importe
         WHERE size(rfcs) >= 2
         RETURN b.name AS nombre, size(rfcs) AS rfcs, importe
         ORDER BY importe DESC LIMIT $lim`,
        { t: tenantId, lim },
      );
      return {
        rfc_multi_nombre: rfcRes.records.map((r) => ({
          rfc: r.get('rfc'), nombres: this.num(r.get('nombres')), ejemplos: r.get('ejemplos'), importe: this.num(r.get('importe')),
        })),
        nombre_multi_rfc: nomRes.records.map((r) => ({
          nombre: r.get('nombre'), rfcs: this.num(r.get('rfcs')), importe: this.num(r.get('importe')),
        })),
      };
    } catch (e: any) {
      this.logger.warn(`rings Neo4j falló (${e?.message || e}); fallback a CTE.`);
      return null;
    } finally {
      await s.close();
    }
  }
}
