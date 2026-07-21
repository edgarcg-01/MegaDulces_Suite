import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import { Client } from 'pg';

/**
 * Salud/frescura de datos para Administración. Dos grupos:
 *
 *  - group 'app'    → tablas de la DB de la app (la que usa el backend: local o prod).
 *                     Infiere "cuándo corrió el feed" vía max(<ts>) por tabla.
 *  - group 'source' → las DBs ORIGEN que surten la información (Docker consolidado :5433,
 *                     KP_CONCENTRADA .245, Mega_Dulces .245, las 6 sucursales Kepler).
 *                     Cada una se chequea SOLO si su connection string está en env
 *                     (en Railway no están → se saltan; on-prem/local sí las alcanza).
 *                     Sin credenciales hardcodeadas: todo por env.
 *
 * Objetivo: que una congelada en CUALQUIER eslabón (como los 20 días de KP_CONCENTRADA)
 * salte en rojo de inmediato, no semanas después.
 */

type Status = 'ok' | 'warn' | 'critical' | 'unknown';

interface SourceCfg {
  key: string; label: string; table: string; tsCandidates: string[];
  warnH: number; critH: number; cadence: string;
}

/** Fuente externa: se conecta a OTRA DB (por env) y evalúa una señal de frescura. */
interface ExtCfg {
  key: string; label: string;
  envVars: string[];        // primer env presente = connection string
  db: string;               // etiqueta legible del host/DB
  sql: string;              // debe devolver { last_update } y opcionalmente { note_extra }
  warnH: number; critH: number; cadence: string;
  reachabilityOnly?: boolean; // sin señal de fecha: ok si conecta
}

const APP_SOURCES: SourceCfg[] = [
  { key: 'sales_daily',     label: 'Ventas (Command Center)', table: 'analytics.sales_daily',          tsCandidates: ['updated_at'],                warnH: 26,  critH: 50,  cadence: 'intradía + nightly' },
  { key: 'stock',           label: 'Stock sucursales',        table: 'commercial.stock',               tsCandidates: ['updated_at', 'created_at'],  warnH: 6,   critH: 14,  cadence: 'cada 15-30 min' },
  { key: 'stock_movements', label: 'Movimientos inventario',  table: 'analytics.stock_movements',      tsCandidates: ['imported_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'in_transit',      label: 'OC en tránsito',          table: 'analytics.purchase_in_transit',  tsCandidates: ['computed_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'sales_stats',     label: 'Sell-out ABC',            table: 'analytics.product_sales_stats',  tsCandidates: ['computed_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'reorder_policy',  label: 'Política de reorden',     table: 'commercial.reorder_policy',      tsCandidates: ['updated_at', 'computed_at'], warnH: 200, critH: 400, cadence: 'nightly / semanal' },
  { key: 'products',        label: 'Catálogo de productos',   table: 'catalog.products',               tsCandidates: ['updated_at', 'created_at'],  warnH: 360, critH: 720, cadence: 'semanal' },
];

const EXT_SOURCES: ExtCfg[] = [
  {
    key: 'consolidado', label: 'Consolidado Kepler (surte a prod)',
    envVars: ['DATABASE_URL_KEPLER_CONSOLIDADO'], db: 'Docker :5433 / kepler_consolidado',
    sql: `SELECT max(fecha)::timestamptz AS last_update FROM mart.ventas`,
    warnH: 30, critH: 54, cadence: 'intradía (sync Kepler)',
  },
  {
    key: 'kp_concentrada', label: 'KP_CONCENTRADA (ODS crudo)',
    envVars: ['KP_DEST_URL'], db: '.245 / KP_CONCENTRADA',
    sql: `SELECT max(last_run_at) AS last_update,
                 count(DISTINCT sucursal)::int || '/6 sucursales · más viejo ' ||
                 coalesce(to_char(min(last_run_at),'DD/MM HH24:MI'),'—') AS note_extra
          FROM kp.sync_control`,
    warnH: 8, critH: 48, cadence: 'cada 4h (tarea KP-Concentrate)',
  },
  {
    key: 'mega_dulces', label: 'Mega_Dulces (catálogo/precios FDW)',
    envVars: ['MEGA_DULCES_URL'], db: '.245 / Mega_Dulces',
    sql: `SELECT now() AS last_update, count(*)::text || ' productos' AS note_extra FROM public.productos_activos`,
    warnH: 0, critH: 0, cadence: 'consolidación FDW', reachabilityOnly: true,
  },
];

const RANK: Record<Status, number> = { ok: 0, warn: 1, unknown: 2, critical: 3 };

export interface SourceHealth {
  group: 'app' | 'source';
  key: string; label: string; table: string; ts_col: string | null;
  last_update: string | null; age_seconds: number | null;
  status: Status; cadence: string; rows: number | null; note?: string;
}

export interface DbHealthReport {
  checked_at: string; db_label: string; overall: Status; sources: SourceHealth[];
}

@Injectable()
export class DbHealthService {
  private readonly logger = new Logger(DbHealthService.name);

  constructor(@Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null) {}

  private dbLabel(): string {
    const conn = this.knex?.client?.config?.connection as { host?: string; connectionString?: string } | string | undefined;
    const host = typeof conn === 'string' ? conn : String(conn?.host ?? conn?.connectionString ?? '');
    return /rlwy\.net|railway/i.test(host) ? 'prod (Railway)' : 'local';
  }

  private classify(ageSec: number | null, warnH: number, critH: number): Status {
    if (ageSec == null) return 'critical';
    const h = ageSec / 3600;
    if (h >= critH) return 'critical';
    if (h >= warnH) return 'warn';
    return 'ok';
  }

  private ageOf(ts: Date | null): number | null {
    return ts ? Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000)) : null;
  }

  // ── Grupo 'app': tablas de la DB del backend ────────────────────────────────
  private async pickTsCol(schema: string, table: string, cands: string[]): Promise<string | null> {
    const { rows } = await this.knex!.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?`,
      [schema, table],
    );
    const have = new Set(rows.map((r: { column_name: string }) => r.column_name));
    return cands.find((c) => have.has(c)) ?? null;
  }

  private async checkAppSources(): Promise<SourceHealth[]> {
    const out: SourceHealth[] = [];
    for (const s of APP_SOURCES) {
      const [schema, table] = s.table.split('.');
      const base: SourceHealth = {
        group: 'app', key: s.key, label: s.label, table: s.table, ts_col: null,
        last_update: null, age_seconds: null, status: 'unknown', cadence: s.cadence, rows: null,
      };
      try {
        const reg = await this.knex!.raw(`SELECT to_regclass(?) AS t`, [s.table]);
        if (!reg.rows[0]?.t) { out.push({ ...base, note: 'tabla no existe' }); continue; }
        const tsCol = await this.pickTsCol(schema, table, s.tsCandidates);
        if (!tsCol) { out.push({ ...base, note: 'sin columna de fecha' }); continue; }
        const { rows } = await this.knex!.raw(
          `SELECT max("${tsCol}") AS last_update, count(*)::bigint AS rows FROM ${s.table}`);
        const last = rows[0]?.last_update ? new Date(rows[0].last_update) : null;
        const ageSec = this.ageOf(last);
        out.push({
          ...base, ts_col: tsCol, last_update: last ? last.toISOString() : null,
          age_seconds: ageSec, status: this.classify(ageSec, s.warnH, s.critH),
          rows: rows[0]?.rows != null ? Number(rows[0].rows) : null,
        });
      } catch (e) {
        this.logger.warn(`db-health app ${s.table}: ${(e as Error).message}`);
        out.push({ ...base, note: 'error al consultar' });
      }
    }
    return out;
  }

  // ── Grupo 'source': DBs origen (por env, con timeout corto y en paralelo) ────
  private async checkExtSource(s: ExtCfg): Promise<SourceHealth> {
    const base: SourceHealth = {
      group: 'source', key: s.key, label: s.label, table: s.db, ts_col: null,
      last_update: null, age_seconds: null, status: 'unknown', cadence: s.cadence, rows: null,
    };
    const conn = s.envVars.map((v) => process.env[v]).find(Boolean);
    if (!conn) return { ...base, note: `no configurada (falta ${s.envVars.join('/')})` };

    const c = new Client({ connectionString: conn, connectionTimeoutMillis: 3500, statement_timeout: 8000 });
    try {
      await c.connect();
      const { rows } = await c.query(s.sql);
      const last = rows[0]?.last_update ? new Date(rows[0].last_update) : null;
      const noteExtra = rows[0]?.note_extra as string | undefined;
      if (s.reachabilityOnly) {
        return { ...base, status: 'ok', note: noteExtra ? `alcanzable · ${noteExtra}` : 'alcanzable' };
      }
      const ageSec = this.ageOf(last);
      return {
        ...base, last_update: last ? last.toISOString() : null, age_seconds: ageSec,
        status: this.classify(ageSec, s.warnH, s.critH), note: noteExtra,
      };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 60);
      // No alcanzable ≠ crítico: puede ser que este backend (Railway) no ve la LAN.
      return { ...base, status: 'unknown', note: `no alcanzable: ${msg}` };
    } finally {
      await c.end().catch(() => {});
    }
  }

  async getReport(): Promise<DbHealthReport> {
    const checked_at = new Date().toISOString();
    if (!this.knex) {
      return { checked_at, db_label: 'no configurada', overall: 'unknown', sources: [] };
    }
    const [appSources, extSources] = await Promise.all([
      this.checkAppSources(),
      Promise.all(EXT_SOURCES.map((s) => this.checkExtSource(s))),
    ]);
    const sources = [...appSources, ...extSources];
    // 'unknown' (no configurada / no alcanzable) NO cuenta para el overall — solo
    // ok/warn/critical de fuentes efectivamente evaluadas.
    const overall = sources.reduce<Status>((worst, s) => {
      if (s.status === 'unknown') return worst;
      return RANK[s.status] > RANK[worst] ? s.status : worst;
    }, 'ok');
    return { checked_at, db_label: this.dbLabel(), overall, sources };
  }
}
