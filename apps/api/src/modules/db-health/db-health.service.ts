import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import type { Knex } from 'knex';

/**
 * Salud/frescura de la DB de la app (la que tenga configurada el backend: local o prod).
 * Para cada fuente crítica infiere "cuándo corrió el feed" vía max(<ts>) — updated_at es
 * la huella de que el importer escribió. Compara la antigüedad contra la cadencia esperada
 * y clasifica ok/warn/critical. Objetivo: que una congelada silenciosa (ej. 20 días sin
 * feed) salte de inmediato en el tablero de Administración, no semanas después.
 *
 * Usa KNEX_NEW_DB_ADMIN (superuser) para leer max() sin filtro RLS. Cross-tenant a
 * propósito: la salud del feed es infraestructura, no dato de un tenant.
 */

type Status = 'ok' | 'warn' | 'critical' | 'unknown';

interface SourceCfg {
  key: string;
  label: string;
  table: string;         // schema.tabla
  tsCandidates: string[]; // columnas de fecha en orden de preferencia
  warnH: number;         // antigüedad (horas) a partir de la cual = warn
  critH: number;         // antigüedad (horas) a partir de la cual = critical
  cadence: string;       // texto legible de la cadencia esperada
}

const SOURCES: SourceCfg[] = [
  { key: 'sales_daily',     label: 'Ventas (Command Center)', table: 'analytics.sales_daily',          tsCandidates: ['updated_at'],                warnH: 26,  critH: 50,  cadence: 'intradía + nightly' },
  { key: 'stock',           label: 'Stock sucursales',        table: 'commercial.stock',               tsCandidates: ['updated_at', 'created_at'],  warnH: 3,   critH: 8,   cadence: 'cada 30 min' },
  { key: 'stock_movements', label: 'Movimientos inventario',  table: 'analytics.stock_movements',      tsCandidates: ['imported_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'in_transit',      label: 'OC en tránsito',          table: 'analytics.purchase_in_transit',  tsCandidates: ['computed_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'sales_stats',     label: 'Sell-out ABC',            table: 'analytics.product_sales_stats',  tsCandidates: ['computed_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'reorder_policy',  label: 'Política de reorden',     table: 'commercial.reorder_policy',      tsCandidates: ['updated_at', 'computed_at'], warnH: 200, critH: 400, cadence: 'nightly / semanal' },
  { key: 'products',        label: 'Catálogo de productos',   table: 'catalog.products',               tsCandidates: ['updated_at', 'created_at'],  warnH: 360, critH: 720, cadence: 'semanal' },
];

const RANK: Record<Status, number> = { ok: 0, warn: 1, unknown: 2, critical: 3 };

export interface SourceHealth {
  key: string;
  label: string;
  table: string;
  ts_col: string | null;
  last_update: string | null;
  age_seconds: number | null;
  status: Status;
  cadence: string;
  rows: number | null;
  note?: string;
}

export interface DbHealthReport {
  checked_at: string;
  db_label: string;
  overall: Status;
  sources: SourceHealth[];
}

@Injectable()
export class DbHealthService {
  private readonly logger = new Logger(DbHealthService.name);

  constructor(@Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null) {}

  private dbLabel(): string {
    const host = String((this.knex?.client?.config?.connection as { host?: string; connectionString?: string })?.host
      ?? (this.knex?.client?.config?.connection as { connectionString?: string })?.connectionString
      ?? '');
    return /rlwy\.net|railway/i.test(host) ? 'prod (Railway)' : 'local';
  }

  private async pickTsCol(schema: string, table: string, cands: string[]): Promise<string | null> {
    const { rows } = await this.knex!.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?`,
      [schema, table],
    );
    const have = new Set(rows.map((r: { column_name: string }) => r.column_name));
    return cands.find((c) => have.has(c)) ?? null;
  }

  private classify(ageSec: number | null, warnH: number, critH: number): Status {
    if (ageSec == null) return 'critical';
    const h = ageSec / 3600;
    if (h >= critH) return 'critical';
    if (h >= warnH) return 'warn';
    return 'ok';
  }

  async getReport(): Promise<DbHealthReport> {
    const checked_at = new Date().toISOString();
    if (!this.knex) {
      return { checked_at, db_label: 'no configurada', overall: 'unknown', sources: [] };
    }

    const sources: SourceHealth[] = [];
    for (const s of SOURCES) {
      const [schema, table] = s.table.split('.');
      const base: SourceHealth = {
        key: s.key, label: s.label, table: s.table, ts_col: null,
        last_update: null, age_seconds: null, status: 'unknown', cadence: s.cadence, rows: null,
      };
      try {
        const reg = await this.knex.raw(`SELECT to_regclass(?) AS t`, [s.table]);
        if (!reg.rows[0]?.t) { sources.push({ ...base, note: 'tabla no existe' }); continue; }

        const tsCol = await this.pickTsCol(schema, table, s.tsCandidates);
        if (!tsCol) { sources.push({ ...base, note: 'sin columna de fecha' }); continue; }

        const { rows } = await this.knex.raw(
          `SELECT max("${tsCol}") AS last_update, count(*)::bigint AS rows FROM ${s.table}`,
        );
        const last = rows[0]?.last_update ? new Date(rows[0].last_update) : null;
        const ageSec = last ? Math.max(0, Math.floor((Date.now() - last.getTime()) / 1000)) : null;
        sources.push({
          ...base,
          ts_col: tsCol,
          last_update: last ? last.toISOString() : null,
          age_seconds: ageSec,
          status: this.classify(ageSec, s.warnH, s.critH),
          rows: rows[0]?.rows != null ? Number(rows[0].rows) : null,
        });
      } catch (e) {
        this.logger.warn(`db-health ${s.table}: ${(e as Error).message}`);
        sources.push({ ...base, note: 'error al consultar' });
      }
    }

    const overall = sources.reduce<Status>(
      (worst, s) => (RANK[s.status] > RANK[worst] ? s.status : worst), 'ok');
    return { checked_at, db_label: this.dbLabel(), overall, sources };
  }
}
