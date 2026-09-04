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
  // El tránsito ya no es tabla propia: se deriva del ODS dentro del fact del pedido (GOTCHAS §25),
  // que además se refresca cada 15-30 min, no nightly.
  { key: 'in_transit',      label: 'Pedido (demanda/stock/OC)', table: 'analytics.replenishment_plan', tsCandidates: ['computed_at', 'updated_at'], warnH: 6,   critH: 14,  cadence: 'cada 15-30 min' },
  { key: 'sales_stats',     label: 'Sell-out ABC',            table: 'analytics.product_sales_stats',  tsCandidates: ['computed_at', 'updated_at'], warnH: 50,  critH: 96,  cadence: 'nightly' },
  { key: 'reorder_policy',  label: 'Política de reorden',     table: 'commercial.reorder_policy',      tsCandidates: ['updated_at', 'computed_at'], warnH: 200, critH: 400, cadence: 'nightly / semanal' },
  { key: 'products',        label: 'Catálogo de productos',   table: 'catalog.products',               tsCandidates: ['updated_at', 'created_at'],  warnH: 360, critH: 720, cadence: 'semanal' },
  // Etiquetas de anaquel (precios pieza/paq/caja desde Kepler c90/91/92). CARA AL CLIENTE:
  // si el feed (import-label-data) se atrasa, el anaquel imprime precios viejos (bug ago-2026:
  // quedó fuera del nightly → ~10% abajo del vigente, caja bajo costo). Cadencia nightly.
  { key: 'label_prices',    label: 'Precios de etiqueta (anaquel)', table: 'commercial.product_label_prices', tsCandidates: ['updated_at', 'computed_at'], warnH: 50, critH: 96, cadence: 'nightly' },
  // Espejo crudo Kepler: el carril es `replicate-ods-live` en Docker (`ops/ingest/docker-compose.yml`,
  // servicios ods-live-hot @15s + ods-live-mirror @300s), que lee los réplicas lógicos locales del
  // :5433 y empuja a kepler_ods.* por feeds-ingest. `last_push_at` la escribe el handler en cada batch
  // (raw-upsert Y raw-delete) → detecta si el pipe se detuvo. Umbral realtime.
  // HISTORIA (para no repetirla): el poll se deshabilitó el 2026-08-26 por el corrimiento +6h de los
  // timestamps, que al estar en la PK duplicaba filas contra el WAL (1,120 pólizas en kdc22608, ver
  // GOTCHAS §21); volvió corregido y el CDC WAL se retiró el 2026-09-04 (OBS.7). El dead-man's switch
  // fino de este carril son `ods_live_hot`/`ods_live_mirror` más abajo, y su COMPLETITUD `cdc_reconcile`.
  { key: 'kepler_ods',      label: 'Espejo crudo Kepler (kepler_ods)', table: 'kepler_ods._sync_status', tsCandidates: ['last_push_at'], warnH: 0.25, critH: 1, cadence: 'continuo (poll en Docker, 2 carriles)' },
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
  // [OBS.3.2] CATÁLOGO por sucursal — el hueco por el que pasaron los 6 días de 2026-08-27.
  //
  // El sensor de arriba mira `kdm1` = **venta**. Un catálogo congelado no mueve la venta, así que
  // seis días sin precios nuevos no dispararon un solo sensor por rama. Y el agregado
  // `kepler_ods._sync_status` tampoco servía: esa marca sólo se escribe cuando LLEGA un lote, y el
  // carril hash no empuja nada si no hay cambios — vieja puede ser "el carril murió" o "esa rama
  // no cambió de precio en tres días". Ambiguo no sirve para alarmar.
  //
  // `analytics.ods_branch_checks` la escribe el shipper al cerrar la pasada de CADA rama, haya o no
  // filas que mandar. Por eso acá "viejo" tiene un solo significado: **nadie miró esa rama**.
  //
  // `tables_checked` caza la deriva de configuración: si alguien deja el contenedor con
  // `--branch=03` o recorta `KP_ODS_TABLES`, el latido agregado seguiría verde (diría "1/1 ramas")
  // y esto no.
  {
    key: 'ods_branch_check_stale', label: 'ODS — sucursal sin revisar (catálogo)', table: 'analytics.ods_branch_checks', tsCandidates: [],
    sql: `WITH hot AS (
            SELECT sucursal, last_check_at, tables_checked, last_error
              FROM analytics.ods_branch_checks WHERE lane = 'ods_live_hot'
          ),
          agg AS (
            SELECT count(*)::int                                       AS ramas,
                   count(*) FILTER (WHERE last_check_at IS NULL)::int  AS nunca,
                   min(last_check_at)                                  AS mas_vieja,
                   (array_agg(sucursal ORDER BY last_check_at ASC NULLS FIRST))[1] AS suc_vieja,
                   min(tables_checked)                                 AS min_tablas,
                   max(tables_checked)                                 AS max_tablas
              FROM hot
          )
          SELECT CASE
                   -- Sin ninguna fila el sensor NO puede afirmar salud. NULL → crítico, con la
                   -- nota diciendo qué falta. Un "ok" acá sería el verde falso de siempre.
                   WHEN agg.ramas = 0 THEN NULL
                   -- Una rama que nunca se pudo revisar es lo peor que hay: se fuerza crítico.
                   WHEN agg.nunca > 0 THEN now() - interval '100 days'
                   ELSE agg.mas_vieja
                 END AS last_update,
                 CASE WHEN agg.ramas = 0
                      THEN 'sin marcas por sucursal — requiere el shipper de OBS.3.2 desplegado'
                      ELSE 'ramas ' || agg.ramas ||
                           CASE WHEN agg.nunca > 0 THEN ' · ' || agg.nunca || ' NUNCA revisada(s)' ELSE '' END ||
                           ' · más atrasada ' || coalesce(agg.suc_vieja, '—') ||
                           ' · tablas ' || coalesce(agg.min_tablas, 0) || '-' || coalesce(agg.max_tablas, 0) ||
                           CASE WHEN agg.max_tablas > agg.min_tablas
                                THEN ' ⚠ desparejo (¿config recortada?)' ELSE '' END
                 END AS note_extra
            FROM agg`,
    // El carril hot pasa cada 15 s. 1 h de holgura tolera un reinicio del contenedor sin ruido;
    // 3 h ya es un carril que dejó de mirar esa sucursal.
    warnH: 1, critH: 3, cadence: 'continuo (@15s por rama)',
  },
  // ── AUDITORÍA FRESCURA 2026-08-20 (lección sucursal 00): dead-man's switches POR-ENTIDAD que el
  //    max() GLOBAL no ve. Cada uno alarma si UNA fuente se congela mientras el resto avanza. ──
  // (P0-1) Stock CEDIS '00': el sensor 'stock' usa max(updated_at) GLOBAL → 01-06 enmascaran un freeze
  //        del '00' (Wincaja Irapuato con guard "no borra si vacío" sirve existencia vieja). El CEDIS es
  //        alta-actividad → si su stock no se movió en 24-48h es congelamiento real, no falta de venta.
  {
    key: 'stock_cedis_00', label: 'Stock CEDIS 00 (no enmascarado por 01-06)', table: 'commercial.stock', tsCandidates: [],
    sql: `SELECT max(s.updated_at)::timestamp AS last_update,
                 'CEDIS 00 · última act. ' || coalesce(to_char(max(s.updated_at) AT TIME ZONE 'America/Mexico_City','DD/MM HH24:MI'),'—') ||
                 ' · ' || count(*)::text || ' SKUs' AS note_extra
            FROM commercial.stock s
            JOIN commercial.warehouses w ON w.id=s.warehouse_id AND w.tenant_id=s.tenant_id
           WHERE w.code='00'`,
    warnH: 30, critH: 72, cadence: 'stock @15min + nightly (Wincaja Irapuato)',
  },
  // (P0-4/5) Oficinas '00' en el ODS: las vistas erp_supplier_payments/erp_collections derivan de
  //          kepler_ods.kdm1 sucursal='00'. La 00 entró a la replicación lógica 2026-08-20; este sensor
  //          detecta si vuelve a congelarse (última fecha de movimiento REAL, sin la basura futura de c9).
  {
    key: 'kepler_ods_00_stale', label: 'Kepler ODS — oficinas 00 (finanzas)', table: 'kepler_ods.kdm1', tsCandidates: [],
    sql: `SELECT max(c9::date)::timestamp AS last_update,
                 'oficinas 00 · último mov. ' || coalesce(to_char(max(c9::date),'DD/MM'),'—') AS note_extra
            FROM kepler_ods.kdm1
           WHERE sucursal='00' AND c9::date <= current_date AND c9::date > current_date - 30`,
    warnH: 48, critH: 120, cadence: 'continuo (réplica lógica md_00 → CDC WAL)',
  },
  // (AUDIT 2026-08-21) Cobertura de FINANZAS de oficinas '00' en el ODS. El ship a prod usa un whitelist
  //   (KP_ODS_TABLES); si se OMITE kdb1 (cuentas de banco), la columna Kepler de /finanzas/bancos +
  //   Cuadre de caja se congela sin aviso (vivido 2026-08-21).
  //   El mecanismo cambió y el sensor importa MÁS, no menos: antes el que hacía SKIP MUDO era
  //   `import-kepler-bank-movements` (retirado 2026-09-03); ahora `analytics.kepler_bank_movements`
  //   es una VISTA sobre kdm1⋈kdb1, así que sin kdb1 no hay "skip" — simplemente devuelve vacío al
  //   instante y en cada lectura. Este sensor es el único aviso.
  //   Este sensor lo hace RUIDOSO: kdb1 suc-00 en 0 → crítico. Es el canario de toda la capa finanzas-00
  //   (kdco/kdc3/kdpv_folio_caja/kdxd/kdxe/kdc2* viajan en el mismo whitelist).
  {
    key: 'ods_finance_00', label: 'Kepler ODS — cuentas banco oficinas 00 (kdb1)', table: 'kepler_ods.kdb1', tsCandidates: [],
    sql: `SELECT CASE WHEN count(*) > 0 THEN now() ELSE now() - interval '100 days' END::timestamp AS last_update,
                 CASE WHEN count(*) > 0 THEN count(*)::text || ' cuentas banco (00) en ODS'
                      ELSE 'kdb1 oficinas 00 VACÍA — bank feed en SKIP; falta kdb1 en KP_ODS_TABLES del runner' END AS note_extra
            FROM kepler_ods.kdb1 WHERE btrim(sucursal)='00'`,
    // (2026-08-26) Con el poll deshabilitado este modo de falla se fue: la publicación del WAL
    // (`ods_cdc_pub`) lleva TODAS las tablas de cada rama (319-350 según sucursal, verificado: 0 del
    // ODS sin publicar), así que ya no hay whitelist que pueda omitir kdb1 en silencio.
    warnH: 24, critH: 48, cadence: 'continuo (CDC WAL, sin whitelist)',
  },
  // (P0-2) Flota GPS: vehicle_positions es FUENTE ÚNICA; el FleetPoller @1min no late en cron_runs → si
  //        el poller muere (o faltan creds MAGNI en prod) el mapa sigue verde con datos viejos. Verde si
  //        no hay trackers vinculados (fleet no configurada en este env); alarma si los hay y no llega posición.
  {
    key: 'fleet_positions', label: 'Flota GPS (posiciones vivas)', table: 'logistics.vehicle_positions', tsCandidates: [],
    sql: `WITH linked AS (SELECT count(*) n FROM logistics.trackers WHERE vehicle_id IS NOT NULL AND active AND deleted_at IS NULL)
          SELECT CASE WHEN (SELECT n FROM linked)=0 THEN now()
                      ELSE (SELECT max(captured_at) FROM logistics.vehicle_positions) END::timestamp AS last_update,
                 CASE WHEN (SELECT n FROM linked)=0 THEN 'sin trackers vinculados (fleet inactiva)'
                      ELSE (SELECT n FROM linked)::text || ' trackers · última posición ' ||
                           coalesce(to_char((SELECT max(captured_at) FROM logistics.vehicle_positions) AT TIME ZONE 'America/Mexico_City','DD/MM HH24:MI'),'—') END AS note_extra`,
    warnH: 3, critH: 12, cadence: 'continuo @1min (FleetPollerService)',
  },
  // (P0-3) Conciliación bancaria: bank_statements se carga MANUAL mensual por CLI, sin cron ni latido. Un
  //        mes olvidado congela la conciliación en silencio. Sensor por MAX(period) → el último mes cargado
  //        vence a fin de mes + margen (last_update = inicio del mes siguiente al último conciliado).
  {
    key: 'bank_recon_period', label: 'Conciliación bancaria (mes cargado)', table: 'finance.bank_statements', tsCandidates: [],
    sql: `SELECT (to_date(max(period),'YYYY-MM') + interval '1 month')::timestamp AS last_update,
                 'último mes conciliado ' || coalesce(max(period),'—') AS note_extra
            FROM finance.bank_statements`,
    warnH: 720, critH: 1080, cadence: 'mensual manual (CLI por workbook)',
  },
  // ── P1 (auditoría 2026-08-20): frescura por DATO de las tablas que alimentan `@Cron` in-process SIN
  //    heartbeat propio. Un sensor por-tabla detecta "no avanzó" — superset de "el cron murió" (también
  //    caza un cron que corre pero no escribe). Todas usan computed_at/last_seen_at → avanzan cada corrida.
  //    (abc_classification apareció CONGELADA desde 2026-06-20 en el primer scan — justo el modo de falla.)
  { key: 'customer_360',           label: 'Customer 360 (RFM/Thot)',        table: 'commercial.customer_360',           tsCandidates: ['computed_at', 'updated_at'],               warnH: 30, critH: 50, cadence: 'nightly' },
  { key: 'recommended_baskets',    label: 'Canastas sugeridas (portal)',    table: 'commercial.recommended_baskets',    tsCandidates: ['computed_at', 'updated_at'],               warnH: 30, critH: 50, cadence: 'nightly 3AM MX' },
  { key: 'execution_360',          label: 'Execution 360 (Horus)',          table: 'commercial.execution_360',          tsCandidates: ['computed_at', 'updated_at'],               warnH: 30, critH: 50, cadence: 'nightly' },
  { key: 'abc_classification',     label: 'Clasificación ABC',              table: 'commercial.abc_classification',     tsCandidates: ['computed_at'],                             warnH: 50, critH: 96, cadence: 'nightly' },
  { key: 'replenishment_findings', label: 'Hallazgos de reabasto',          table: 'commercial.replenishment_findings', tsCandidates: ['last_seen_at', 'updated_at', 'created_at'], warnH: 50, critH: 96, cadence: 'nightly' },
  { key: 'maat_findings',          label: 'Hallazgos Maat (finanzas)',      table: 'finance.findings',                  tsCandidates: ['updated_at', 'created_at'],                warnH: 30, critH: 50, cadence: 'nightly 3AM (MaatScanner)' },
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
    key: 'wincaja_branch_stale', label: 'Wincaja — almacén rezagado', table: 'wincaja.v_sales_lines', tsCandidates: [],
    // La lista de sucursales NO va hardcodeada: se deriva de `wincaja.branches` con el mismo
    // predicado que usa la vista de recepciones (`kepler_code IS NULL` = sigue en Wincaja).
    // Estaba fijo en ('30','32','50') y Canindo (50) migró a Kepler (kepler_code='06') el
    // 21/08/2026: su .mdb dejó de moverse para siempre y esta alerta quedó crítica de forma
    // permanente (276 h el 24/08) — una alarma que nunca se puede apagar entrena a ignorarlas.
    sql: `SELECT min(last_sale)::timestamp AS last_update,
                 string_agg(source_branch || ':' || to_char(last_sale,'DD/MM'), ' · ' ORDER BY source_branch) AS note_extra
          FROM (SELECT source_branch, max(business_date) AS last_sale
                  FROM wincaja.v_sales_lines
                 WHERE business_date BETWEEN CURRENT_DATE - 40 AND CURRENT_DATE
                   AND source_branch IN (SELECT source_branch FROM wincaja.branches
                                          WHERE kepler_code IS NULL AND warehouse_code LIKE 'MD-%')
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
               -- misma derivación que el sensor de rezago: las que SIGUEN en Wincaja
               exp AS (SELECT source_branch FROM wincaja.branches
                        WHERE kepler_code IS NULL AND warehouse_code LIKE 'MD-%'),
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
                          'cobertura completa') AS note_extra`,
    warnH: 24, critH: 48, cadence: 'mensual (verifica el mes anterior completo)',
  },
  //  (c) EL CEDIS — el punto ciego que los dos sensores de arriba NO cubren. Ambos miran
  //      `v_sales_lines` de las sucursales con `kepler_code IS NULL`, y el CEDIS queda fuera por
  //      PARTIDA DOBLE: tiene `kepler_code='00'` (lo excluye el predicado) y **no vende** — es
  //      bodegón, cero cortes/arqueos/retiros, cero filas en v_sales_lines. Podía congelarse
  //      indefinidamente sin que nadie se enterara, y es el nodo que SURTE A LA RED.
  //      Detectado 2026-08-31: llevaba 6 días parado (último movimiento 26/08) y ninguna alerta.
  //
  //      ⚠️ El CEDIS real es **BPIRAPUATO (Irapuato) y vive en WINCAJA**, no en Kepler — la
  //      sucursal Kepler '00' es OFICINAS. Ver docs/ERP_KEPLER.md §2.3.
  //
  //      Se mide sobre MOVIMIENTOS (`maestro_mov_almacen`), no ventas. Umbrales derivados de la
  //      cadencia real, no inventados: opera lunes-sábado (73 de 90 días), hueco máximo entre
  //      días con movimiento = **2 días**, promedio 1.16. Con domingo cerrado, un lunes sano
  //      puede mostrar el sábado (~48 h) → warn a 60 h para no flapear, crítico a 96 h.
  {
    key: 'wincaja_cedis_stale', label: 'Wincaja — CEDIS Irapuato (surte la red)', table: 'wincaja.maestro_mov_almacen', tsCandidates: [],
    sql: `SELECT max(fecha)::timestamp AS last_update,
                 'BPIRAPUATO · último mov. ' ||
                 COALESCE(to_char(max(fecha), 'DD/MM'), '—') || ' · ' ||
                 count(*) FILTER (WHERE fecha >= current_date - 7)::text || ' movs 7d' AS note_extra
            FROM wincaja.maestro_mov_almacen
           WHERE source_branch = '00'`,
    warnH: 60, critH: 96, cadence: 'diario (feed on-prem Wincaja → prod)',
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
interface CronCfg {
  key: string; label: string; cadence: string; warnH: number; critH: number;
  /**
   * Horas que una corrida puede tardar antes de considerarla COLGADA. Presupuesto de
   * DURACIÓN, distinto del de frescura (`critH`).
   *
   * Antes el colgado se medía contra `critH` y solo daba `warn`: `wincaja_sync` (critH 50)
   * llevaba 28 h en 'running' —arrancó y nunca cerró— y el tablero lo pintaba **ok**,
   * mientras los sensores por-dato (`wincaja_feed`, `wincaja_branch_stale`) sí gritaban que
   * la venta estaba pegada en 19/08 y la sucursal 50 en 13/08. Un latido que empezó y no
   * cerró es la firma exacta del cuelgue de feeds on-prem (node huérfano) y tiene que verse
   * como tal.
   *
   * Sin definir → conducta anterior (nunca crítico por duración). Se pone SOLO en jobs por
   * lote con duración conocida; los loops continuos (`--watch` bajo PM2) viven en 'running'
   * por diseño y marcarlos sería ruido.
   */
  maxRunH?: number;
}
// NOTA: Consolidado (mart.refresh_state) y KP-Concentrate (kp.sync_control) YA se monitorean
// en el grupo 'source' (EXT_SOURCES) con su heartbeat nativo → no se duplican aquí.
const CRON_JOBS: CronCfg[] = [
  // On-prem (insert/update a prod) — heartbeat vía cron-heartbeat.js
  { key: 'wincaja_sync',        label: 'Wincaja sync (BRONZE+GOLD)', cadence: 'diario 05:00',   warnH: 30,  critH: 50, maxRunH: 3 },
  // Sync al-minuto (Fase SYNC): on-prem empuja deltas por feeds-ingest (ingress gratis).
  { key: 'kepler_stock',        label: 'Kepler stock vivo (multi-sucursal)', cadence: 'cada 2 min',  warnH: 3,  critH: 12 },
  { key: 'wincaja_live',        label: 'Wincaja live (existencia+ventas+movimientos)', cadence: 'cada 10 min', warnH: 3, critH: 12 },
  // Respaldo del dataset 'concentrada' (mes que rueda del 'actual'). Semanal → umbral holgado:
  // warn a ~9 días (una corrida perdida), critical a ~16 (dos). Ver wincaja_month_coverage.
  { key: 'wincaja_concentrada', label: 'Wincaja concentrada (respaldo mensual)', cadence: 'semanal domingo 03:00', warnH: 216, critH: 384, maxRunH: 3 },
  { key: 'kepler_sales_fact',   label: 'Kepler ventas (sales-fact)', cadence: 'intradía',        warnH: 6,   critH: 26 },
  { key: 'kepler_catalog_bulk', label: 'Kepler catálogo (bulk)',     cadence: 'semanal',         warnH: 200, critH: 400, maxRunH: 3 },
  // ── Latido por MODO del runner on-prem (run-prod-feeds.js) — dead-man's switch por batch.
  // Cada tarea de Windows corre un modo; si deja de correr (zombie/apagado/deshabilitada), su
  // último latido envejece y salta en rojo aquí, aunque el dato downstream aún se vea fresco.
  // Umbral = ~2-4× la cadencia de su tarea. Los modos MANUALES (finance/logistics/all) NO se
  // registran a propósito: laten pero se muestran 'ok' sin alarmar (no tienen cadencia esperada).
  { key: 'feed_live',           label: 'Feed live (venta viva)',            cadence: 'cada 30 min',  warnH: 2,   critH: 6, maxRunH: 1 },
  { key: 'feed_livefast',       label: 'Feed livefast (loop ~60s)',         cadence: 'continuo ~60s', warnH: 0.5, critH: 2 },
  { key: 'feed_stock',          label: 'Feed stock (batch existencia)',     cadence: 'cada 15 min',  warnH: 1.5, critH: 4, maxRunH: 1 },
  { key: 'feed_receipts',       label: 'Feed recepciones (XA2001)',         cadence: 'cada 1-2 min', warnH: 0.5, critH: 2, maxRunH: 1 },
  { key: 'feed_intraday',       label: 'Feed intraday (transaccionales)',   cadence: 'cada 1 h',     warnH: 3,   critH: 8, maxRunH: 2 },
  { key: 'feed_nightly',        label: 'Feed nightly (batch nocturno)',     cadence: 'diario 03:00', warnH: 30,  critH: 50, maxRunH: 4 },
  // La tarea \Kepler\Catalog es SEMANAL (MSFT_TaskWeeklyTrigger, domingos 02:00), no diaria:
  // con umbrales de 30/50 h quedaba en ROJO PERMANENTE entre corridas legítimas. Eso es peor
  // que no monitorear — un tablero que grita siempre entrena a ignorarlo, y es la explicación
  // más probable de que el feed_nightly muriera 2 noches (25 y 26-ago) sin que nadie lo viera.
  { key: 'feed_catalog',        label: 'Feed catálogo (semanal)',           cadence: 'semanal dom 02:00', warnH: 180, critH: 200, maxRunH: 3 },
  { key: 'feed_contpaqi',       label: 'Feed ContPAQi (pólizas+bancos)',    cadence: 'cada 1 min',   warnH: 0.5, critH: 2 },
  { key: 'feed_contpaqi-slow',  label: 'Feed ContPAQi lento (balanza+prov)', cadence: 'cada 2 h',    warnH: 5,   critH: 12 },
  // `cdc_wal_00..06` (CDC WAL-decode, ADR-047) SACADOS 2026-09-04 (OBS.7): el carril se retiró y sus
  // slots se dropearon. Sus 7 latidos quedaron congelados en `error` desde el 02-sep y siguieron
  // pintando ROJO durante días sin que nadie fuera a arreglarlos — un rojo permanente que nadie va a
  // atender enseña a ignorar el tablero, que es peor que no tenerlo. Lo que el WAL cubría en exclusiva
  // (propagación de DELETE) lo cubre ahora `cdc_reconcile` detectando SOBRANTES.
  // Si el carril vuelve, se vuelven a declarar acá — y su dueño sigue siendo UNO solo.
  // CDC.7 — la ÚNICA alarma de COMPLETITUD del sistema. Todo lo demás mide frescura (`max(fecha)`)
  // y por construcción no puede ver un hueco EN MEDIO con datos frescos alrededor: así el CDC perdió
  // 2-7% de las filas diarias del 26 al 31 de agosto **con los 7 latidos de arriba verdes y
  // correctos** (un latido prueba que el caño se mueve, no que llegó todo), y lo encontró un
  // humano abriendo una factura. `reconcile-ods-window --watch` compara las llaves de la ventana
  // reciente (replica vs kepler_ods), repone el delta y late acá con lo que encontró; si supera el
  // umbral escribe status='error' → CRÍTICO. Un número > 0 sostenido = se está perdiendo otra vez.
  { key: 'cdc_reconcile',       label: 'Reconciliador ODS (completitud)', cadence: 'continuo ~15 min', warnH: 1, critH: 3 },
  // OBS.1 — el carril del POLL (replicate-ods-live.js), que es el que de verdad alimentaba prod y
  // era MUDO: no escribía a cron_runs y no tenía entrada acá, así que db-health no tenía NADA que
  // vigilar. Estuvo parado del 27/08 al 02/09/2026 — 6 días, ~23,200 filas de catálogo sin shipear
  // (10,248 de costo) — y lo encontró un humano al corregir un precio a mano. Dos carriles, dos
  // umbrales: el hot corre @15s y el espejo completo @300s con pasadas de minutos.
  { key: 'ods_live_hot',        label: 'ODS carril vivo (replica→prod)',  cadence: 'continuo ~15 s',  warnH: 0.5, critH: 2 },
  { key: 'ods_live_mirror',     label: 'ODS espejo completo (replica→prod)', cadence: 'continuo ~5 min', warnH: 2, critH: 6 },
  // OBS.1 — HUÉRFANOS: estos SÍ latían, pero al no estar acá caían en el `cfg ? classify : 'ok'` de
  // checkCronRuns() y se pintaban VERDE INCONDICIONAL por viejos que estuvieran. Un latido sin
  // umbral registrado no es una alarma, es decoración. (wincaja_replica_* justo se pasó 4 días en
  // cero con los dos carriles "online" — esto es lo que lo habría gritado.)
  { key: 'wincaja_replica_inc', label: 'Wincaja réplica (incremental)', cadence: 'continuo ~2 min', warnH: 0.5, critH: 2 },
  { key: 'wincaja_replica_hash', label: 'Wincaja réplica (hash)',       cadence: 'continuo ~1 h',   warnH: 3,   critH: 8 },
  { key: 'contpaqi_add_cfdis',  label: 'ContPAQi CFDIs (ADD)',          cadence: 'cada 5 min',      warnH: 2,   critH: 8 },
  { key: 'analytics_refresh_wincaja', label: 'Refresh MVs Wincaja',     cadence: 'cada 15 min',     warnH: 1,   critH: 3 },
  { key: 'feed_guardian',       label: 'FeedGuardian (revive feeds)',   cadence: 'cada 5 min',      warnH: 0.5, critH: 2 },
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

// ── DBH.1 — SALUD DEL MOTOR (no es lo mismo que frescura del dato) ────────────
//
// Las ~45 fuentes de arriba responden "¿llegó la información?". Ninguna responde "¿cómo está la
// base?". Son preguntas distintas y se miden distinto: la frescura es una EDAD (`classify()`), y
// esto son MAGNITUDES — % de filas muertas, MB, conexiones, segundos de una consulta. Forzarlas al
// molde viejo obliga al truco de la fecha sintética (`now() - interval '100 days'`) que ya usan dos
// fuentes: legible una vez, ilegible como patrón. Por eso van con tipo, umbral y endpoint propios.
//
// Medido en prod el 2026-09-01 (22 GB, Postgres 18.6) al construir esto: `detalles_mov_almacen` con
// 1,339,125 filas muertas (13.6%) y **sin un solo autovacuum registrado**, `stock_movements` con
// 435,608 (12.0%) igual. No están abandonadas: `autovacuum_vacuum_scale_factor` es el default 0.2,
// así que una tabla de 9.8M filas junta 2M de basura antes de que se limpie sola.
export interface EngineTable {
  schema: string; table: string; live: number; dead: number; dead_pct: number | null;
  last_autovacuum: string | null; last_autoanalyze: string | null;
  size_bytes: number; size_pretty: string; status: Status;
}

export interface EngineMetric {
  key: string; label: string; display: string; status: Status; note?: string;
}

export interface EngineReport {
  checked_at: string; db_label: string; overall: Status;
  database: { name: string; size_pretty: string; version: string };
  metrics: EngineMetric[];
  bloat: EngineTable[];
  schemas: { schema: string; size_pretty: string; tables: number }[];
  autovacuum: { name: string; setting: string }[];
}

/**
 * Umbrales del motor. Cada uno lleva su porqué — un número sin razón es un número que nadie se
 * atreve a mover después.
 *
 *  · `dead_pct`: autovacuum dispara al 20% (`autovacuum_vacuum_scale_factor`). Una tabla POR ENCIMA
 *    de ese número significa que autovacuum no está alcanzando, no que falte configurarlo.
 *  · `conn_pct`: 70/85% del `max_connections` — antes del "too many clients", con margen para actuar.
 *  · `query_s` / `idle_tx_s`: 5 y 15 minutos. El `idle in transaction` importa más de lo que parece:
 *    una transacción abierta **bloquea el vacuum** de las tablas que tocó, así que es causa directa
 *    de la hinchazón de arriba, no un problema aparte.
 */
const ENGINE_LIMITS = {
  dead_pct: { warn: 20, crit: 40 },
  conn_pct: { warn: 70, crit: 85 },
  query_s: { warn: 300, crit: 900 },
  idle_tx_s: { warn: 300, crit: 900 },
} as const;

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

  /**
   * Clasifica una MAGNITUD (no una edad). Deliberadamente separada de `classify()`: aquella asume
   * que el valor son segundos y que más viejo es peor; acá el valor puede ser un porcentaje, un
   * conteo o unos segundos, y sólo comparte la forma de los umbrales. Mezclarlas obligaría a que
   * `classify` supiera de unidades.
   */
  private classifyMetric(value: number | null, warn: number, crit: number): Status {
    if (value == null || !Number.isFinite(value)) return 'unknown';
    if (value >= crit) return 'critical';
    if (value >= warn) return 'warn';
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
        // Corriendo. Se juzga contra el presupuesto de DURACIÓN (maxRunH), no contra el de
        // frescura: pasado ese tope el latido no dice "trabajando", dice COLGADO — y eso es
        // crítico, no un warn. Sin maxRunH (loops --watch, jobs sin duración conocida) se
        // mantiene la conducta vieja: warn recién al cruzar critH.
        const startAge = this.ageOf(row.last_start ? new Date(row.last_start) : null);
        const runH = startAge != null ? startAge / 3600 : null;
        if (runH != null && cfg?.maxRunH != null && runH >= cfg.maxRunH) {
          status = 'critical';
          note = `COLGADO: arrancó hace ${this.humanH(runH)} y no cerró (tope ${cfg.maxRunH} h). Revisar node huérfano en la máquina de feeds.`;
        } else if (runH != null && cfg?.maxRunH == null && cfg && runH >= cfg.critH) {
          status = 'warn';
          note = `en ejecución desde hace ${this.humanH(runH)}`;
        } else {
          status = 'ok';
          note = 'en ejecución';
        }
      } else {
        // ok → clasifica por antigüedad de la última corrida vs cadencia.
        status = cfg ? this.classify(ageSec, cfg.warnH, cfg.critH) : 'ok';
        const dur = row.duration_ms != null ? ` · ${Math.round(Number(row.duration_ms) / 1000)}s` : '';
        const filas = row.rows_affected != null ? ` · ${row.rows_affected} filas` : '';
        // La nota decía "OK" SIEMPRE, aunque `status` fuera warn o critical: el job reportó
        // éxito, y el texto repetía ese éxito ignorando que la última corrida era vieja. Así
        // `contpaqi_add_cfdis` pasó 30 h muerto mostrando "OK · 167224 filas" — el número de
        // filas de la corrida vieja, que se lee como salud. La detección funcionaba; el mensaje
        // mentía. Cuando el estado NO es ok, la nota ARRANCA por el rezago, igual que la rama
        // de `running` dice "desde hace X".
        if (status === 'ok') {
          note = `OK${dur}${filas}`;
        } else {
          const edad = ageSec != null ? this.humanH(ageSec / 3600) : 'sin fecha';
          note = `SIN CORRER hace ${edad} (cadencia ${cfg?.cadence || '—'}); la última terminó bien${dur}${filas}`;
        }
      }
      out.push({
        ...base, last_update: finish ? finish.toISOString() : null, age_seconds: ageSec,
        status, rows: row.rows_affected != null ? Number(row.rows_affected) : null, note,
      });
    }
    return out;
  }

  /** "28 h" / "45 min" — para que la nota diga cuánto lleva sin que haya que calcularlo. */
  private humanH(h: number): string {
    return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`;
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

  // ── DBH.1 — Reporte del MOTOR ───────────────────────────────────────────────
  /**
   * Estado de Postgres mismo: hinchazón por filas muertas, peso por schema, actividad y la
   * configuración de autovacuum. Lee con el knex ADMIN (rol `postgres`), que es el único que ve
   * `pg_stat_activity` de otras sesiones — y es la conexión que `new-database.module.ts` ya
   * reservaba para esto ("Operaciones de mantenimiento (VACUUM, ANALYZE, etc.)").
   *
   * Todo es SELECT sobre catálogos; no toca datos de negocio y no depende de ningún tenant.
   */
  async getEngineReport(): Promise<EngineReport> {
    const checked_at = new Date().toISOString();
    const vacio: EngineReport = {
      checked_at, db_label: 'no configurada', overall: 'unknown',
      database: { name: '—', size_pretty: '—', version: '—' },
      metrics: [], bloat: [], schemas: [], autovacuum: [],
    };
    if (!this.knex) return vacio;

    try {
      const [db, act, bloatRows, schemaRows, avRows] = await Promise.all([
        this.knex.raw(`SELECT current_database() AS name,
                              pg_size_pretty(pg_database_size(current_database())) AS size_pretty,
                              split_part(version(), ' on ', 1) AS version`),
        // `FILTER` en vez de subconsultas: una sola pasada por pg_stat_activity.
        this.knex.raw(`
          SELECT count(*)::int AS conns,
                 count(*) FILTER (WHERE state = 'active')::int AS activas,
                 count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_tx,
                 COALESCE(max(EXTRACT(EPOCH FROM (now() - query_start)))
                          FILTER (WHERE state = 'active'), 0)::int AS query_s,
                 COALESCE(max(EXTRACT(EPOCH FROM (now() - state_change)))
                          FILTER (WHERE state = 'idle in transaction'), 0)::int AS idle_tx_s,
                 (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conns
            FROM pg_stat_activity WHERE backend_type = 'client backend'`),
        this.knex.raw(`
          SELECT schemaname, relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze,
                 pg_total_relation_size(relid) AS size_bytes,
                 pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty
            FROM pg_stat_user_tables
           WHERE n_dead_tup > 0
           ORDER BY n_dead_tup DESC LIMIT 25`),
        this.knex.raw(`
          SELECT schemaname, count(*)::int AS tablas,
                 pg_size_pretty(sum(pg_total_relation_size(relid))) AS size_pretty
            FROM pg_stat_user_tables GROUP BY 1
           ORDER BY sum(pg_total_relation_size(relid)) DESC LIMIT 12`),
        this.knex.raw(`SELECT name, setting FROM pg_settings WHERE name LIKE 'autovacuum%' ORDER BY name`),
      ]);

      const a = act.rows[0] ?? {};
      const connPct = a.max_conns > 0 ? Math.round((100 * a.conns) / a.max_conns) : null;

      const metrics: EngineMetric[] = [
        {
          key: 'connections', label: 'Conexiones',
          display: `${a.conns ?? 0} de ${a.max_conns ?? '—'} (${connPct ?? '—'}%)`,
          status: this.classifyMetric(connPct, ENGINE_LIMITS.conn_pct.warn, ENGINE_LIMITS.conn_pct.crit),
          note: `${a.activas ?? 0} activas`,
        },
        {
          key: 'longest_query', label: 'Consulta más larga',
          display: this.humanSec(a.query_s ?? 0),
          status: this.classifyMetric(a.query_s, ENGINE_LIMITS.query_s.warn, ENGINE_LIMITS.query_s.crit),
          note: (a.query_s ?? 0) >= ENGINE_LIMITS.query_s.warn ? 'una consulta larga retiene su snapshot y frena el vacuum' : undefined,
        },
        {
          key: 'idle_in_transaction', label: 'Transacción abierta sin trabajar',
          display: `${a.idle_tx ?? 0} · la más vieja ${this.humanSec(a.idle_tx_s ?? 0)}`,
          status: this.classifyMetric(a.idle_tx_s, ENGINE_LIMITS.idle_tx_s.warn, ENGINE_LIMITS.idle_tx_s.crit),
          note: (a.idle_tx_s ?? 0) >= ENGINE_LIMITS.idle_tx_s.warn ? 'bloquea el vacuum de las tablas que tocó' : undefined,
        },
      ];

      const bloat: EngineTable[] = bloatRows.rows.map((r: Record<string, unknown>) => {
        const live = Number(r.n_live_tup) || 0;
        const dead = Number(r.n_dead_tup) || 0;
        const pct = live > 0 ? Math.round((1000 * dead) / live) / 10 : null;
        return {
          schema: String(r.schemaname), table: String(r.relname), live, dead, dead_pct: pct,
          last_autovacuum: r.last_autovacuum ? new Date(r.last_autovacuum as string).toISOString() : null,
          last_autoanalyze: r.last_autoanalyze ? new Date(r.last_autoanalyze as string).toISOString() : null,
          size_bytes: Number(r.size_bytes) || 0, size_pretty: String(r.size_pretty),
          status: this.classifyMetric(pct, ENGINE_LIMITS.dead_pct.warn, ENGINE_LIMITS.dead_pct.crit),
        };
      });

      const overall = [...metrics.map((m) => m.status), ...bloat.map((b) => b.status)]
        .reduce<Status>((worst, s) => (s === 'unknown' ? worst : RANK[s] > RANK[worst] ? s : worst), 'ok');

      return {
        checked_at, db_label: this.dbLabel(), overall,
        database: {
          name: String(db.rows[0]?.name ?? '—'),
          size_pretty: String(db.rows[0]?.size_pretty ?? '—'),
          version: String(db.rows[0]?.version ?? '—'),
        },
        metrics, bloat,
        schemas: schemaRows.rows.map((r: Record<string, unknown>) => ({
          schema: String(r.schemaname), size_pretty: String(r.size_pretty), tables: Number(r.tablas) || 0,
        })),
        autovacuum: avRows.rows.map((r: Record<string, unknown>) => ({
          name: String(r.name), setting: String(r.setting),
        })),
      };
    } catch (e) {
      this.logger.warn(`db-health engine: ${(e as Error).message}`);
      return { ...vacio, db_label: this.dbLabel() };
    }
  }

  /** "12 min" / "2 h 5 min" / "45 s" — el panel muestra tiempo, no segundos crudos. */
  private humanSec(s: number): string {
    if (!s || s < 60) return `${Math.max(0, Math.round(s))} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    const h = Math.floor(s / 3600);
    return `${h} h ${Math.round((s - h * 3600) / 60)} min`;
  }
}
