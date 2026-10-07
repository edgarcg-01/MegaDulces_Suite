import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Fase PR-perf (ADR-075) — Rollup de sell-out servido con DuckDB+Parquet.
 *
 * POR QUÉ: `proposeGrowth`/`proposePlan` (Presupuestos) leían las vistas VIVAS del ODS
 * (`v_sellout_daily × v_retail_calendar × v_sales_entity`) por AÑO completo → medido 76s en prod,
 * rompía el gate de <1s. Este servicio precomputa el rollup por (tenant × entidad × canal × año
 * fiscal × periodo 13×4) a un Parquet (chico, ~600 filas) y lo consulta con DuckDB embebido en <30ms.
 *
 * DISCIPLINAS del ADR-075 (medidas en el spike): (1) sin trampa de zona horaria — la clave es
 * año/periodo ENTEROS que el calendario ya resolvió, no un timestamp; (2) `monto` en DECIMAL, nunca
 * double; (3) frescura DECLARADA (`data_as_of`) — es un snapshot, el periodo en curso va atrás; (4)
 * la verdad sigue siendo PG (paridad verificada 2024/2025 exacta), esto es una caché de lectura.
 *
 * RLS: `analytics.*` NO tiene RLS forzado → el refresco filtra `tenant_id` explícito (usa `KNEX_NEW_DB`
 * directo, sin contexto de request, para poder correr en background). El Parquet no tiene RLS → el serve
 * filtra `tenant_id` por archivo (un Parquet por tenant).
 *
 * INFRA: el archivo vive en `BUDGET_ROLLUP_DIR` (en Railway = un volumen montado; default os.tmpdir()).
 * Refresco LAZY en background: sirve el snapshot actual al instante; si falta o está viejo dispara el
 * rebuild async y lo intercambia (rename atómico). El primer request sin Parquet DECLARA «generando».
 */

export interface RollupRealRow { entity_key: string; channel: string; year: number; period: number; monto: number }

@Injectable()
export class SelloutRollupService {
  private readonly log = new Logger('SelloutRollup');
  private duckInstance: unknown = null;
  private readonly dir = process.env.BUDGET_ROLLUP_DIR || path.join(os.tmpdir(), 'md-budget-rollup');
  private readonly ttlMs = Number(process.env.BUDGET_ROLLUP_TTL_MS) || 12 * 60 * 60 * 1000;
  private readonly asOf = new Map<string, number>();            // tenant → epoch ms del último refresco OK
  private readonly building = new Map<string, Promise<void>>(); // lock de refresco por tenant

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  private file(tenantId: string): string { return path.join(this.dir, `sellout_rollup_${tenantId}.parquet`); }
  private p(s: string): string { return s.replace(/\\/g, '/'); } // rutas para SQL de DuckDB (POSIX)

  /** Import del módulo nativo ESM. webpack lo marca external de tipo `import` (ver webpack.config.js)
   *  → queda como `import()` en runtime (el bundle CJS puede cargar ESM así) y entra a generatePackageJson. */
  private async duckdb(): Promise<any> {
    if (!this.duckInstance) {
      const mod: any = await import('@duckdb/node-api');
      const DuckDBInstance = mod.DuckDBInstance || mod.default?.DuckDBInstance;
      this.duckInstance = await DuckDBInstance.create(':memory:');
    }
    return this.duckInstance;
  }

  /** Frescura declarada del snapshot del tenant (ISO) o null si no hay. */
  dataAsOf(tenantId: string): string | null {
    const t = this.asOf.get(tenantId) || this.mtime(tenantId);
    return t ? new Date(t).toISOString() : null;
  }
  private mtime(tenantId: string): number { try { return fs.statSync(this.file(tenantId)).mtimeMs; } catch { return 0; } }

  /** ¿Hay snapshot servible? Dispara refresco en background si falta o está viejo. */
  private ensureFresh(tenantId: string): boolean {
    const exists = fs.existsSync(this.file(tenantId));
    const stamp = this.asOf.get(tenantId) || (exists ? this.mtime(tenantId) : 0);
    if (!exists || Date.now() - stamp > this.ttlMs) this.refreshInBackground(tenantId);
    return exists;
  }

  refreshInBackground(tenantId: string): void {
    if (this.building.has(tenantId)) return;
    const job = this.refresh(tenantId)
      .catch((e) => this.log.error(`refresh rollup ${tenantId}: ${e?.message || e}`))
      .finally(() => this.building.delete(tenantId));
    this.building.set(tenantId, job);
  }

  /** Reconstruye el Parquet del rollup desde PG (agregación pesada, 1×/refresco). */
  async refresh(tenantId: string): Promise<void> {
    const t0 = Date.now();
    const res = await this.knex.raw(
      `SELECT se.entity_key, se.channel, cal.fiscal_year::int AS fy, cal.period_no::int AS p,
              sum(sd.monto)::numeric(18,2) AS monto
         FROM analytics.v_sellout_daily sd
         JOIN analytics.v_retail_calendar cal ON cal.date = sd.business_date
         JOIN analytics.v_sales_entity se
              ON se.tenant_id = sd.tenant_id AND se.channel = sd.channel AND se.warehouse_code = sd.warehouse_code
        WHERE sd.tenant_id = ?
        GROUP BY 1, 2, 3, 4`, [tenantId]);
    const rows = (res.rows || res) as Array<{ entity_key: string; channel: string; fy: number; p: number; monto: string | number }>;
    const data = rows.map((r) => ({ entity_key: r.entity_key, channel: r.channel, fiscal_year: Number(r.fy), period_no: Number(r.p), monto: Number(r.monto) || 0 }));
    await this.writeParquet(tenantId, data);
    this.asOf.set(tenantId, Date.now());
    this.log.log(`rollup ${tenantId}: ${data.length} filas en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  private async writeParquet(tenantId: string, data: Array<{ entity_key: string; channel: string; fiscal_year: number; period_no: number; monto: number }>): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const inst = await this.duckdb();
    const conn = await inst.connect();
    const jsonPath = path.join(this.dir, `._src_${tenantId}_${Date.now()}.json`);
    const tmpParquet = this.file(tenantId) + '.tmp';
    try {
      await conn.run(`CREATE OR REPLACE TEMP TABLE rollup(entity_key VARCHAR, channel VARCHAR, fiscal_year INTEGER, period_no INTEGER, monto DECIMAL(18,2))`);
      if (data.length) {
        fs.writeFileSync(jsonPath, JSON.stringify(data));
        await conn.run(`INSERT INTO rollup SELECT entity_key, channel, fiscal_year, period_no, CAST(monto AS DECIMAL(18,2)) FROM read_json_auto('${this.p(jsonPath)}')`);
      }
      await conn.run(`COPY rollup TO '${this.p(tmpParquet)}' (FORMAT parquet, COMPRESSION zstd)`);
      fs.renameSync(tmpParquet, this.file(tenantId)); // swap atómico
    } finally {
      try { fs.unlinkSync(jsonPath); } catch { /* noop */ }
      try { if (fs.existsSync(tmpParquet)) fs.unlinkSync(tmpParquet); } catch { /* noop */ }
    }
  }

  private async query<T = Record<string, unknown>>(tenantId: string, sql: (parquet: string) => string): Promise<T[]> {
    const f = this.file(tenantId);
    if (!fs.existsSync(f)) {
      this.refreshInBackground(tenantId);
      throw new ServiceUnavailableException('El histórico de ventas se está generando (primera vez). Reintentá en un momento.');
    }
    const inst = await this.duckdb();
    const conn = await inst.connect();
    const reader = await conn.runAndReadAll(sql(this.p(f)));
    return reader.getRowObjects() as T[];
  }

  // ── API que consumen los motores de Presupuestos (misma forma que los reads viejos de PG) ──

  /** Años fiscales con real, anteriores a `fy`. */
  async yearsWithRealBefore(tenantId: string, fy: number): Promise<number[]> {
    this.ensureFresh(tenantId);
    const rows = await this.query<{ fiscal_year: number }>(tenantId, (p) => `SELECT DISTINCT fiscal_year FROM '${p}' ORDER BY fiscal_year`);
    return rows.map((r) => Number(r.fiscal_year)).filter((y) => y < fy).sort((a, b) => a - b);
  }

  /** Real por entidad × canal × año × periodo para N años. */
  async realByEntityYearPeriod(tenantId: string, years: number[]): Promise<RollupRealRow[]> {
    this.ensureFresh(tenantId);
    const ys = years.map((y) => Number(y)).filter(Number.isFinite);
    if (!ys.length) return [];
    const rows = await this.query(tenantId, (p) =>
      `SELECT entity_key, channel, fiscal_year, period_no, CAST(monto AS DOUBLE) monto FROM '${p}' WHERE fiscal_year IN (${ys.join(',')})`);
    return rows.map((r: any) => ({ entity_key: r.entity_key, channel: r.channel, year: Number(r.fiscal_year), period: Number(r.period_no), monto: Number(r.monto) || 0 }));
  }

  /** Real del año `priorYear` rolado a entidad → { periodo → monto } (agrega sobre canal). */
  async priorYearByEntityPeriod(tenantId: string, priorYear: number): Promise<Map<string, Map<number, number>>> {
    this.ensureFresh(tenantId);
    const rows = await this.query(tenantId, (p) =>
      `SELECT entity_key, period_no, CAST(sum(monto) AS DOUBLE) monto FROM '${p}' WHERE fiscal_year = ${Number(priorYear)} GROUP BY 1, 2`);
    const map = new Map<string, Map<number, number>>();
    for (const r of rows as any[]) {
      const ek = r.entity_key as string;
      if (!map.has(ek)) map.set(ek, new Map());
      map.get(ek)!.set(Number(r.period_no), Number(r.monto) || 0);
    }
    return map;
  }
}
