import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB_ADMIN, TenantContextService } from '@megadulces/platform-core';
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
  // Señal de frescura por SQL custom (sobre la DB de la app). Cuando está presente se usa
  // en vez de max(<tsCandidates>). Sirve para medir la FECHA DEL DATO (business_date/sale_date)
  // y no solo cuándo se escribió la fila: un feed puede correr a diario y NO avanzar la data
  // (rollback por ECONNRESET) → updated_at se ve fresco pero el dato está congelado.
  // Debe devolver { last_update } y opcionalmente { note_extra }.
  sql?: string;
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
  // Etiquetas de anaquel (precios pieza/paq/caja desde Kepler c90/91/92). CARA AL CLIENTE:
  // si el feed (import-label-data) se atrasa, el anaquel imprime precios viejos (bug ago-2026:
  // quedó fuera del nightly → ~10% abajo del vigente, caja bajo costo). Cadencia nightly.
  { key: 'label_prices',    label: 'Precios de etiqueta (anaquel)', table: 'commercial.product_label_prices', tsCandidates: ['updated_at', 'computed_at'], warnH: 50, critH: 96, cadence: 'nightly' },
  // Espejo crudo Kepler (SYNC.3): replicate-ods-live lee los replicas lógicos locales y empuja
  // a kepler_ods.* de forma CONTINUA (~15s, tarea OdsLiveLoop). La marca last_push_at se escribe
  // en cada corrida (aunque no cambie nada) → detecta si el pipe se detuvo. Umbral realtime.
  { key: 'kepler_ods',      label: 'Espejo crudo Kepler (kepler_ods)', table: 'kepler_ods._sync_status', tsCandidates: ['last_push_at'], warnH: 0.25, critH: 1, cadence: 'continuo ~15s (tarea OdsLiveLoop)' },
  // kepler_ods POR-SUCURSAL: el _sync_status de arriba prueba que la LOOP corre, pero con la
  // replicación lógica (SYNC.3) apareció un modo de falla nuevo: si UN replica (subscription)
  // se congela, la loop sigue shipeando data VIEJA de esa sucursal → last_push_at fresco pero
  // el dato de esa sucursal parado. El agregado no lo ve (otras sucursales avanzan). Esto mira
  // la última VENTA (c4=10) por sucursal en horario de tienda y alarma si UNA se atrasa mientras
  // la red sigue activa (calca wincaja_branch_stale). Excluye CEDIS 00 (0 venta pública).
  {
    key: 'kepler_ods_branch_stale', label: 'Kepler ODS — sucursal congelada (replica)', table: 'kepler_ods.kdm1', tsCandidates: [],
    sql: `WITH w AS (
            SELECT (now() AT TIME ZONE 'America/Mexico_City')::time AS mx_time,
                   (now() AT TIME ZONE 'America/Mexico_City')::date AS mx_date
          ),
          per_branch AS (
            SELECT k.sucursal,
                   (max(k.c9::date + k.c62::time) AT TIME ZONE 'America/Mexico_City') AS last_sale
              FROM kepler_ods.kdm1 k, w
             WHERE k.c2='U' AND k.c3='D' AND k.c4=10
               AND k.sucursal <> '00'
               AND k.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
               AND k.c9::date = w.mx_date
             GROUP BY k.sucursal
          ),
          agg AS (
            SELECT max(last_sale) AS net_last, min(last_sale) AS stale_last, count(*)::int AS activas,
                   (array_agg(sucursal ORDER BY last_sale ASC))[1] AS stale_suc
              FROM per_branch
          )
          SELECT CASE
                   WHEN (SELECT mx_time FROM w) NOT BETWEEN '10:00' AND '21:30' THEN now()
                   WHEN agg.net_last IS NULL OR agg.net_last < now() - interval '45 min' THEN now()
                   ELSE agg.stale_last
                 END AS last_update,
                 'activas ' || coalesce(agg.activas,0) || '/6 · más atrasada ' ||
                   coalesce(agg.stale_suc,'—') || ' ' ||
                   coalesce(to_char(agg.stale_last AT TIME ZONE 'America/Mexico_City','HH24:MI'),'—') ||
                   ' · red ' || coalesce(to_char(agg.net_last AT TIME ZONE 'America/Mexico_City','HH24:MI'),'—') AS note_extra
            FROM agg`,
    warnH: 3, critH: 6, cadence: 'continuo en horario (detecta 1 replica caído)',
  },
  // ── Frescura por FECHA DEL DATO (detecta feed que corre pero no avanza) ──
  // Wincaja: el feed on-prem escribe a prod y a veces se congela por ECONNRESET (rollback) →
  // corre a diario pero la última venta se queda pegada. Medimos max(business_date), no updated_at.
  {
    key: 'wincaja_feed', label: 'Feed Wincaja (venta POS)', table: 'wincaja.v_sales_lines', tsCandidates: [],
    // OJO: hay tickets con fecha FUTURA (errores de captura del POS) → ventana [hoy-30, hoy]
    // (acota el scan a rango indexable ~2s Y descarta la basura futura; si el feed lleva >30 días
    // muerto, no hay filas → last_update null → critical, que es lo correcto).
    sql: `SELECT max(business_date)::timestamp AS last_update,
                 'última venta ' || coalesce(to_char(max(business_date),'DD/MM'),'—') ||
                 ' · ' || count(DISTINCT source_branch)::text || ' sucursales' AS note_extra
          FROM wincaja.v_sales_lines WHERE business_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE`,
    warnH: 48, critH: 96, cadence: 'diario (feed on-prem Wincaja → prod)',
  },
  // Venta consolidada (Kepler + Wincaja) por FECHA de venta — que el dato avance día a día.
  {
    key: 'sales_daily_date', label: 'Ventas — último día con dato', table: 'analytics.sales_daily', tsCandidates: [],
    sql: `SELECT max(sale_date)::timestamp AS last_update,
                 'último día con venta ' || coalesce(to_char(max(sale_date),'DD/MM'),'—') AS note_extra
          FROM analytics.sales_daily WHERE sale_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE`,
    warnH: 44, critH: 72, cadence: 'intradía + nightly',
  },
  // Wincaja POR-ALMACÉN — el max(business_date) GLOBAL (wincaja_feed) NO ve un hueco de UN almacén:
  // si 32/50 están al día, el agregado se ve fresco aunque 30 esté muerto (bug jul-2026: MD-30 sin
  // julio, invisible al monitoreo global). Estas dos fuentes miran las 3 sucursales wincaja_only
  // (30/32/50) por separado.
  //  (a) REZAGO ACTUAL: la MÁS vieja de las 3 (min de max business_date) → un almacén que dejó de
  //      alimentar salta aunque los otros estén frescos.
  {
    key: 'wincaja_branch_stale', label: 'Wincaja — almacén rezagado (30/32/50)', table: 'wincaja.v_sales_lines', tsCandidates: [],
    sql: `SELECT min(last_sale)::timestamp AS last_update,
                 string_agg(source_branch || ':' || to_char(last_sale,'DD/MM'), ' · ' ORDER BY source_branch) AS note_extra
          FROM (SELECT source_branch, max(business_date) AS last_sale
                  FROM wincaja.v_sales_lines
                 WHERE business_date BETWEEN CURRENT_DATE - 40 AND CURRENT_DATE
                   AND source_branch IN ('30','32','50')
                 GROUP BY source_branch) t`,
    warnH: 44, critH: 72, cadence: 'diario (feed on-prem Wincaja → prod)',
  },
  //  (b) COBERTURA DEL MES CERRADO: un HUECO en medio de la serie (feed que se recupera después) es
  //      invisible al rezago — para agosto, MD-30 volvió el 1-ago y su max se ve fresco pese al hoyo
  //      de julio. Cuenta días con venta del mes anterior por almacén; <20 días = hueco → critical
  //      (last_update viejo fuerza el estado; se auto-resuelve al hacer backfill).
  {
    key: 'wincaja_month_coverage', label: 'Wincaja — cobertura mes cerrado (hueco de feed)', table: 'wincaja.v_sales_lines', tsCandidates: [],
    sql: `WITH lm AS (
            SELECT date_trunc('month', CURRENT_DATE - interval '1 month')::date AS m_start,
                   (date_trunc('month', CURRENT_DATE) - interval '1 day')::date AS m_end,
                   to_char(CURRENT_DATE - interval '1 month','YYYY-MM') AS ym),
               exp AS (SELECT unnest(ARRAY['30','32','50']) AS source_branch),
               cov AS (
                 SELECT e.source_branch, count(DISTINCT v.business_date) AS days
                   FROM exp e
                   LEFT JOIN wincaja.v_sales_lines v
                     ON v.source_branch = e.source_branch
                    AND v.business_date BETWEEN (SELECT m_start FROM lm) AND (SELECT m_end FROM lm)
                  GROUP BY e.source_branch),
               bad AS (SELECT * FROM cov WHERE days < 20)
          SELECT CASE WHEN EXISTS (SELECT 1 FROM bad) THEN now() - interval '100 days' ELSE now() END AS last_update,
                 (SELECT ym FROM lm) || ' · ' ||
                 COALESCE((SELECT string_agg(source_branch || '=' || days || 'd', ', ' ORDER BY source_branch) FROM bad),
                          'cobertura completa 30/32/50') AS note_extra`,
    warnH: 24, critH: 48, cadence: 'mensual (verifica el mes anterior completo)',
  },
  // Tienda EN VIVO (poller POS on-prem → prod cada 25s). Detecta el poller CONGELADO
  // (proceso vivo pero mudo, visto 2026-08-04: se colgó 3h y nadie se enteró). Umbral
  // CONSCIENTE DEL HORARIO: fuera de 10:00–21:30 MX la tienda está cerrada → last_update=now()
  // (ok, no alarma nocturna). En horario mide antigüedad del último ticket de HOY; si aún no
  // hay ticket, cuenta desde la apertura (10:00) → avisa si la tienda "abrió" 45min sin vender.
  {
    key: 'store_live', label: 'Tienda en vivo (poller POS)', table: 'analytics.store_live_tickets', tsCandidates: [],
    sql: `WITH t AS (
            SELECT max(ticket_ts) AS last_ticket, count(DISTINCT warehouse_code) AS suc
              FROM analytics.store_live_tickets
             WHERE ticket_ts::date = (now() AT TIME ZONE 'America/Mexico_City')::date
          ), w AS (
            SELECT (now() AT TIME ZONE 'America/Mexico_City')::time AS mx_time,
                   ((now() AT TIME ZONE 'America/Mexico_City')::date + time '10:00')
                     AT TIME ZONE 'America/Mexico_City' AS open_ts
          )
          SELECT CASE WHEN w.mx_time NOT BETWEEN '10:00' AND '21:30' THEN now()
                      ELSE COALESCE(t.last_ticket, w.open_ts) END AS last_update,
                 'último ticket ' ||
                   coalesce(to_char(t.last_ticket AT TIME ZONE 'America/Mexico_City','DD/MM HH24:MI'),'—')
                   || ' · ' || coalesce(t.suc, 0) || ' suc hoy' AS note_extra
            FROM t, w`,
    warnH: 0.75, critH: 1.5, cadence: 'continuo en horario (poller on-prem cada 25s)',
  },
  // Ventas por ruta: el rollup analytics.sales_by_route_monthly (rutas WIN-%) que consume
  // /comercial/ventas-por-ruta. Los feeds de ruta (import-route-push-monthly/-lines/-vecinal)
  // pasaron a intraday (~1h, 24/7) → updated_at avanza cada corrida (el UPSERT hace updated_at=now()
  // sin guard). Dead-man propio porque una falla del PASO de ruta (ej. .249 mart.ventas inalcanzable)
  // NO alarma feed_intraday (falla parcial = batch 'ok'), pero aquí congela updated_at. Umbral intradía.
  {
    key: 'route_sales', label: 'Ventas por ruta (rollup intradía)', table: 'analytics.sales_by_route_monthly', tsCandidates: [],
    sql: `SELECT max(updated_at) AS last_update,
                 count(DISTINCT route_code)::text || ' rutas · mes ' ||
                   coalesce(to_char(max(month),'MM/YYYY'),'—') AS note_extra
            FROM analytics.sales_by_route_monthly WHERE route_code LIKE 'WIN-%'`,
    warnH: 3, critH: 8, cadence: 'intradía ~1h (feeds de ruta en intraday) + respaldo nightly',
  },
];

const EXT_SOURCES: ExtCfg[] = [
  {
    key: 'consolidado', label: 'Consolidado Kepler (surte a prod)',
    envVars: ['DATABASE_URL_KEPLER_CONSOLIDADO'], db: 'Docker :5433 / kepler_consolidado',
    // Heartbeat REAL: `mart.refresh_state.last_checked` se actualiza en CADA corrida del
    // refresh (cada 2 min), haya o no ventas nuevas → prueba que el pipeline está vivo.
    // Antes usábamos `max(fecha)`, pero `fecha` es DATE (solo día) → siempre se veía ~1 día
    // viejo aunque estuviera al día (falso "23h"). `last_refreshed` = última venta traída.
    sql: `SELECT max(last_checked) AS last_update,
                 (count(*) FILTER (WHERE last_checked > now() - interval '10 min'))::text || '/' ||
                 count(*)::text || ' sucursales al día · última venta ' ||
                 coalesce(to_char(max(last_refreshed),'DD/MM HH24:MI'),'—') AS note_extra
          FROM mart.refresh_state`,
    warnH: 0.25, critH: 1, cadence: 'cada 2 min (tarea RefreshConsolidado)',
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

/**
 * Crons/feeds esperados. `warnH/critH` = horas desde la última corrida OK antes de warn/critical
 * (por cadencia del job). Un job en `error` = critical inmediato. Un job del registro que aún no
 * reportó = 'unknown' (no alarma hasta que se cablee). El heartbeat lo escribe cron-heartbeat.js.
 */
interface CronCfg { key: string; label: string; cadence: string; warnH: number; critH: number; }
// NOTA: Consolidado (mart.refresh_state) y KP-Concentrate (kp.sync_control) YA se monitorean
// en el grupo 'source' (EXT_SOURCES) con su heartbeat nativo → no se duplican aquí.
const CRON_JOBS: CronCfg[] = [
  // On-prem (insert/update a prod) — heartbeat vía cron-heartbeat.js
  { key: 'wincaja_sync',        label: 'Wincaja sync (BRONZE+GOLD)', cadence: 'diario 05:00',   warnH: 30,  critH: 50 },
  // Sync al-minuto (Fase SYNC): on-prem empuja deltas por feeds-ingest (ingress gratis).
  { key: 'kepler_stock',        label: 'Kepler stock vivo (multi-sucursal)', cadence: 'cada 2 min',  warnH: 3,  critH: 12 },
  { key: 'wincaja_live',        label: 'Wincaja live (existencia+ventas+movimientos)', cadence: 'cada 10 min', warnH: 3, critH: 12 },
  // Respaldo del dataset 'concentrada' (mes que rueda del 'actual'). Semanal → umbral holgado:
  // warn a ~9 días (una corrida perdida), critical a ~16 (dos). Ver wincaja_month_coverage.
  { key: 'wincaja_concentrada', label: 'Wincaja concentrada (respaldo mensual)', cadence: 'semanal domingo 03:00', warnH: 216, critH: 384 },
  { key: 'kepler_sales_fact',   label: 'Kepler ventas (sales-fact)', cadence: 'intradía',        warnH: 6,   critH: 26 },
  { key: 'kepler_catalog_bulk', label: 'Kepler catálogo (bulk)',     cadence: 'semanal',         warnH: 200, critH: 400 },
  // ── Latido por MODO del runner on-prem (run-prod-feeds.js) — dead-man's switch por batch.
  // Cada tarea de Windows corre un modo; si deja de correr (zombie/apagado/deshabilitada), su
  // último latido envejece y salta en rojo aquí, aunque el dato downstream aún se vea fresco.
  // Umbral = ~2-4× la cadencia de su tarea. Los modos MANUALES (finance/logistics/all) NO se
  // registran a propósito: laten pero se muestran 'ok' sin alarmar (no tienen cadencia esperada).
  { key: 'feed_live',           label: 'Feed live (venta viva)',            cadence: 'cada 30 min',  warnH: 2,   critH: 6 },
  { key: 'feed_livefast',       label: 'Feed livefast (loop ~60s)',         cadence: 'continuo ~60s', warnH: 0.5, critH: 2 },
  { key: 'feed_stock',          label: 'Feed stock (batch existencia)',     cadence: 'cada 15 min',  warnH: 1.5, critH: 4 },
  { key: 'feed_receipts',       label: 'Feed recepciones (XA2001)',         cadence: 'cada 1-2 min', warnH: 0.5, critH: 2 },
  { key: 'feed_intraday',       label: 'Feed intraday (transaccionales)',   cadence: 'cada 1 h',     warnH: 3,   critH: 8 },
  { key: 'feed_nightly',        label: 'Feed nightly (batch nocturno)',     cadence: 'diario 03:00', warnH: 30,  critH: 50 },
  { key: 'feed_catalog',        label: 'Feed catálogo',                     cadence: 'diario 02:00', warnH: 30,  critH: 50 },
  { key: 'feed_contpaqi',       label: 'Feed ContPAQi (pólizas+bancos)',    cadence: 'cada 1 min',   warnH: 0.5, critH: 2 },
  { key: 'feed_contpaqi-slow',  label: 'Feed ContPAQi lento (balanza+prov)', cadence: 'cada 2 h',    warnH: 5,   critH: 12 },
  // Internos del API (@Cron NestJS)
  { key: 'analytics_refresh',   label: 'Refresh MVs analytics',      cadence: 'cada 15 min',     warnH: 1,   critH: 3 },
  { key: 'db_health_scan',      label: 'Scanner Salud BD',           cadence: 'cada 5 min',      warnH: 0.5, critH: 2 },
];

export interface SourceHealth {
  group: 'app' | 'source' | 'cron';
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

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Bandeja de alertas de salud (persistidas por DbHealthScannerService): las ABIERTAS
   * primero (críticas antes que warn) + las resueltas en los últimos 7 días. Scopeado al
   * tenant del request (admin knex bypass RLS → filtro explícito).
   */
  async listAlerts(): Promise<{ open: any[]; recent_resolved: any[] }> {
    if (!this.knex) return { open: [], recent_resolved: [] };
    const tenantId = this.tenantCtx.requireTenantId();
    const reg = await this.knex.raw(`SELECT to_regclass('analytics.db_health_alerts') AS t`);
    if (!reg.rows[0]?.t) return { open: [], recent_resolved: [] };
    const cols = ['id', 'source_key', 'source_label', 'group_key', 'status', 'age_seconds',
      'last_update', 'note', 'first_seen_at', 'last_seen_at', 'resolved_at', 'acknowledged_at'];
    const open = await this.knex('analytics.db_health_alerts')
      .where({ tenant_id: tenantId }).whereNull('resolved_at').select(cols)
      .orderByRaw(`CASE status WHEN 'critical' THEN 0 ELSE 1 END, last_seen_at DESC`);
    const recent_resolved = await this.knex('analytics.db_health_alerts')
      .where({ tenant_id: tenantId }).whereNotNull('resolved_at')
      .where('resolved_at', '>', this.knex.raw(`now() - interval '7 days'`))
      .select(cols).orderBy('resolved_at', 'desc').limit(50);
    return { open, recent_resolved };
  }

  /** Marca una alerta abierta como reconocida (ack). No la resuelve — eso lo hace el scanner. */
  async ackAlert(id: string): Promise<{ ok: boolean }> {
    if (!this.knex) return { ok: false };
    const tenantId = this.tenantCtx.requireTenantId();
    const n = await this.knex('analytics.db_health_alerts')
      .where({ id, tenant_id: tenantId })
      .update({ acknowledged_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });
    return { ok: n > 0 };
  }

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
        // Señal por SQL custom (fecha del dato). Devuelve { last_update, note_extra }.
        if (s.sql) {
          const { rows } = await this.knex!.raw(s.sql);
          const last = rows[0]?.last_update ? new Date(rows[0].last_update) : null;
          const ageSec = this.ageOf(last);
          out.push({
            ...base, ts_col: 'dato', last_update: last ? last.toISOString() : null,
            age_seconds: ageSec, status: this.classify(ageSec, s.warnH, s.critH),
            note: rows[0]?.note_extra as string | undefined,
          });
          continue;
        }
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

  // ── Grupo 'cron': estado de ejecución de cada feed (analytics.cron_runs) ────
  private async checkCronRuns(): Promise<SourceHealth[]> {
    const out: SourceHealth[] = [];
    let byKey = new Map<string, any>();
    try {
      const reg = await this.knex!.raw(`SELECT to_regclass('analytics.cron_runs') AS t`);
      if (reg.rows[0]?.t) {
        const { rows } = await this.knex!.raw(
          `SELECT job_key, label, last_start, last_finish, status, rows_affected, duration_ms, error
           FROM analytics.cron_runs`);
        byKey = new Map(rows.map((r: any) => [r.job_key, r]));
      }
    } catch (e) {
      this.logger.warn(`db-health cron_runs: ${(e as Error).message}`);
    }
    // Recorre el registro de jobs esperados + cualquier job extra que haya reportado.
    const keys = new Set<string>([...CRON_JOBS.map((j) => j.key), ...Array.from(byKey.keys())]);
    for (const key of keys) {
      const cfg = CRON_JOBS.find((j) => j.key === key);
      const row = byKey.get(key);
      const base: SourceHealth = {
        group: 'cron', key, label: cfg?.label || row?.label || key, table: 'analytics.cron_runs',
        ts_col: 'last_finish', last_update: null, age_seconds: null, status: 'unknown',
        cadence: cfg?.cadence || '—', rows: null,
      };
      if (!row) { out.push({ ...base, note: 'sin reporte aún' }); continue; }
      const finish = row.last_finish ? new Date(row.last_finish) : null;
      const ageSec = this.ageOf(finish);
      let status: Status;
      let note: string | undefined;
      if (row.status === 'error') {
        status = 'critical';
        note = `última corrida FALLÓ: ${(row.error || '').slice(0, 80)}`;
      } else if (row.status === 'running') {
        // Corriendo: ok salvo que lleve demasiado (posible colgado) → warn.
        const startAge = this.ageOf(row.last_start ? new Date(row.last_start) : null);
        status = startAge != null && cfg && startAge / 3600 >= cfg.critH ? 'warn' : 'ok';
        note = 'en ejecución';
      } else {
        // ok → clasifica por antigüedad de la última corrida vs cadencia.
        status = cfg ? this.classify(ageSec, cfg.warnH, cfg.critH) : 'ok';
        const dur = row.duration_ms != null ? ` · ${Math.round(Number(row.duration_ms) / 1000)}s` : '';
        note = `OK${dur}${row.rows_affected != null ? ` · ${row.rows_affected} filas` : ''}`;
      }
      out.push({
        ...base, last_update: finish ? finish.toISOString() : null, age_seconds: ageSec,
        status, rows: row.rows_affected != null ? Number(row.rows_affected) : null, note,
      });
    }
    return out;
  }

  async getReport(): Promise<DbHealthReport> {
    const checked_at = new Date().toISOString();
    if (!this.knex) {
      return { checked_at, db_label: 'no configurada', overall: 'unknown', sources: [] };
    }
    const [appSources, extSources, cronSources] = await Promise.all([
      this.checkAppSources(),
      Promise.all(EXT_SOURCES.map((s) => this.checkExtSource(s))),
      this.checkCronRuns(),
    ]);
    const sources = [...appSources, ...extSources, ...cronSources];
    // 'unknown' (no configurada / no alcanzable) NO cuenta para el overall — solo
    // ok/warn/critical de fuentes efectivamente evaluadas.
    const overall = sources.reduce<Status>((worst, s) => {
      if (s.status === 'unknown') return worst;
      return RANK[s.status] > RANK[worst] ? s.status : worst;
    }, 'ok');
    return { checked_at, db_label: this.dbLabel(), overall, sources };
  }
}
