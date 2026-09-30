import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB_ADMIN, TenantContextService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import { Client } from 'pg';
import { commitDelBuild } from '../../build-info';
// [DH.1] La regla de recurrencia vive aparte, SIN dependencias, para que su candado pueda
// ejercitarla de verdad: este archivo arrastra NestJS y `@megadulces/*`, así que un test de Node
// no lo puede cargar y terminaría reimplementando la regla — que es no probarla.
import { RECURRENCIA, recurrenciaLevantaLaMano } from './db-health-recurrencia';

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
  // ⛔ SONDA RETIRADA — el sujeto que vigila dejó de existir (fecha ISO del corte + por qué).
  //
  // No se borra la entrada, y la diferencia importa: una sonda borrada no deja rastro de que
  // alguna vez existió, y el día que alguien pregunte "¿y Wincaja quién la miraba?" no hay
  // respuesta. Retirada = sigue en la lista, DECLARA su fecha de corte, y sale de la alarma.
  //
  // ⭐ Y no queda ciega: si la fuente vuelve a recibir datos POSTERIORES a `retiredOn`, la sonda
  // pasa a `warn`. Retirar algo no puede significar "dejar de mirarlo para siempre" — significa
  // "callate salvo que me sorprendas". Sin eso, reactivar un sistema retirado sería invisible.
  retiredOn?: string;
  retiredWhy?: string;
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
  // Blend consolidado (Kepler+Wincaja+rutas del ODS) = fuente de los KPIs `network*` del Command Center.
  // ⚠️ CUELGA de `mv_kepler_sales_daily`: un `DROP … CASCADE` de ese matview la mata en silencio — pasó
  // el 2026-09-08 (una migración de canal la dropeó de colateral y no la recreó) y el Command Center leyó
  // una relación inexistente hasta el 09-09. Este sensor la vigila: si el matview FALTA, db-health la
  // atrapa en el try/catch como 'unknown' (visible); si está pero el nightly no la refrescó, warn/crit por edad.
  { key: 'sales_blended',   label: 'Blend consolidado (Command Center)', table: 'analytics.mv_sales_blended', tsCandidates: ['updated_at'], warnH: 30, critH: 50, cadence: 'nightly (tras kepler+wincaja)' },
  // [DB-MEM.8] CAJA GENERAL — el feed que estuvo 5 DÍAS PARADO sin que nada lo vigilara.
  //
  // `import-caja-general.js` lee los .mdb de `\\192.168.0.245\D` con PowerShell + ACE.OLEDB.
  // VL.4b (2026-09-11) mudó sus carriles a `md`, que es Linux → dejó de correr ese mismo día.
  // Fallaba en el 100 % de los intentos (24 al día) y el tablero decía `ok`, porque el runner
  // sólo marca `error` si fallan TODOS los pasos. Nadie se enteró porque **este sensor no existía**:
  // `analytics.caja_*` no figuraba en APP_SOURCES ni en CRON_JOBS.
  //
  // Se mide `arqueo_date` de `caja_arqueos` (el arqueo de caja 20, que es el dato VIVO; las otras
  // tablas de `caja_*` son histórico o traen fechas de negocio con basura — `caja_depositos` llega
  // a 2026-12-31). Umbral de feed diario: warn al saltarse una corrida, crítico a las dos.
  //
  // ⚠️ Va a nacer en ROJO, y está bien: refleja que el dato lleva días sin llegar. Se apaga cuando
  // alguien corra el modo `finance` desde `.249` (Windows, con Z: montado), que es el único
  // sustrato donde este importer puede correr.
  { key: 'caja_general',    label: 'Caja general (arqueos .mdb — requiere Windows + Z:)', table: 'analytics.caja_arqueos', tsCandidates: ['arqueo_date'], warnH: 30, critH: 50, cadence: 'diario (modo finance, desde .249)' },
  { key: 'reorder_policy',  label: 'Política de reorden',     table: 'commercial.reorder_policy',      tsCandidates: ['updated_at', 'computed_at'], warnH: 200, critH: 400, cadence: 'nightly / semanal' },
  { key: 'products',        label: 'Catálogo de productos',   table: 'catalog.products',               tsCandidates: ['updated_at', 'created_at'],  warnH: 360, critH: 720, cadence: 'semanal' },
  // Etiquetas de anaquel (precios pieza/paq/caja desde Kepler c90/91/92). CARA AL CLIENTE:
  // si el feed (import-label-data) se atrasa, el anaquel imprime precios viejos (bug ago-2026:
  // quedó fuera del nightly → ~10% abajo del vigente, caja bajo costo). Cadencia nightly.
  { key: 'label_prices',    label: 'Precios de etiqueta (anaquel)', table: 'commercial.product_label_prices', tsCandidates: ['updated_at', 'computed_at'], warnH: 50, critH: 96, cadence: 'nightly' },
  // Espejo crudo Kepler: el carril es `replicate-ods-live` en Docker (`ops/vl/docker-compose.yml`,
  // servicios ods-live-hot @15s + ods-live-mirror @300s), que lee los réplicas lógicos locales del
  // :5433 y empuja a kepler_ods.* por feeds-ingest. `last_push_at` la escribe el handler en cada batch
  // (raw-upsert Y raw-delete) → detecta si el pipe se detuvo. Umbral realtime.
  // HISTORIA (para no repetirla): el poll se deshabilitó el 2026-08-26 por el corrimiento +6h de los
  // timestamps, que al estar en la PK duplicaba filas contra el WAL (1,120 pólizas en kdc22608, ver
  // GOTCHAS §21); volvió corregido y el CDC WAL se retiró el 2026-09-04 (OBS.8). El dead-man's switch
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
    // `[W4.3]` SIN `::timestamp` — ver el bloque ⚠️ de `wincaja_existencias_entrega` más abajo.
    // `commercial.stock.updated_at` es `timestamptz` (medido), así que el cast le quitaba 6.00 h
    // exactas a la edad. Con el sensor en `warnH: 30`, el día del barrido reportaba **29.44 h** y
    // la edad real era **35.44 h**: la alarma estaba tapada por el sesgo, no apagada por sanidad.
    sql: `SELECT max(s.updated_at) AS last_update,
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
    // `[W4.3]` SIN `::timestamp`: acá el valor es un CENTINELA (`now()` = sano / `now() - 100 días`
    // = crítico), así que el sesgo de 6 h no movía el veredicto — pero sí publicaba una **edad
    // negativa** ("hace −6.00 h", medido) en el tablero. Un número imposible en pantalla enseña a
    // desconfiar del tablero entero, que es la falla que ADR-053 existe para evitar.
    sql: `SELECT CASE WHEN count(*) > 0 THEN now() ELSE now() - interval '100 days' END AS last_update,
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
    // `[W4.3]` SIN `::timestamp`. Es el caso más grave del barrido: `captured_at` es `timestamptz`
    // (medido) y el umbral es `warnH: 3`, así que el sesgo de 6.00 h dejaba al sensor **incapaz de
    // avisar** — no podía pasar a warn hasta las 9 h reales, y por debajo de 6 h publicaba edad
    // negativa. Un dead-man's switch que no puede disparar en su propia ventana no es un sensor.
    sql: `WITH linked AS (SELECT count(*) n FROM logistics.trackers WHERE vehicle_id IS NOT NULL AND active AND deleted_at IS NULL)
          SELECT CASE WHEN (SELECT n FROM linked)=0 THEN now()
                      ELSE (SELECT max(captured_at) FROM logistics.vehicle_positions) END AS last_update,
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
  // (ítem 3 del plan de la capa) CxC snapshots: `customer-receivables-scanner` @Cron 08:30 MX
  // los escribe, y `customer-ledger` los LEE para la historia de cartera. En prod está VACÍA — que
  // es la clase de falla `customer_receivables` (populador agendado que quizá no corre). Pero no
  // podemos distinguir desde acá "feature apagada (ENABLE_CXC_SCAN=false)" de "cron muerto": una
  // tabla vacía no trae fecha. Sensor NOISE-FREE: si está vacía se DECLARA (no alarma — puede ser
  // off), y sólo alarma por REGRESIÓN (tuvo snapshots y se congelaron). Es lo contrario de un sensor
  // genérico de "tabla vacía": ese daría 131 falsos positivos (reltuples miente; casi todas tienen dato).
  {
    key: 'cxc_snapshots', label: 'CxC snapshots (historia de cartera)', table: 'analytics.customer_receivable_snapshots', tsCandidates: [],
    sql: `SELECT CASE WHEN count(*) = 0 THEN now() ELSE max(computed_at) END AS last_update,
                 CASE WHEN count(*) = 0
                        THEN 'sin snapshots — ¿ENABLE_CXC_SCAN=false o el cron 08:30 no corre? (no medible desde aquí)'
                        ELSE count(*)::text || ' snapshots · último ' ||
                             coalesce(to_char(max(snapshot_date),'DD/MM'),'—') END AS note_extra
            FROM analytics.customer_receivable_snapshots`,
    warnH: 30, critH: 50, cadence: 'diario 08:30 MX (customer-receivables-scanner)',
  },
  // `[VL.9.6]` ARCHIVADO DE WAL. Al encender pgBackRest se creó un modo de falla nuevo cuyo
  // desenlace es caro: si `archive_command` empieza a fallar, Postgres RETIENE el WAL en
  // `pg_wal` esperando poder archivarlo, el disco se llena y la base se detiene. Y el disco
  // es el mismo que usan los 9 contenedores de la ingesta.
  //
  // ⛔ EL VEREDICTO NO PUEDE SER `failed_count > 0`. Ese contador es ACUMULATIVO y no se
  // reinicia: las 9 fallas del 2026-09-22 (la config con `;`, ya arreglada) lo dejarían en
  // rojo para siempre — el rojo permanente que enseña a ignorar el tablero. Lo que dice si
  // está roto AHORA es `last_failed_time > last_archived_time`.
  //
  // La edad se mide contra el último archivado EXITOSO, que es exactamente la exposición de
  // RPO: "cuánto hace que no logro guardar un segmento". Con `archive_timeout=300` un sistema
  // sano archiva al menos cada 5 min, así que 15 min ya es anómalo.
  //
  // ⚠️ Con `archive_mode=off` NO se inventa una fecha: se devuelve el arranque del servidor,
  // que es el hecho real ("desde que arrancó, no se archivó nada"). Envejece solo y termina
  // en rojo, que es lo correcto para producción — un clúster de prod sin archivado no tiene
  // recuperación a un punto en el tiempo, y eso no es un estado aceptable en verde.
  {
    key: 'wal_archive', label: 'Archivado de WAL (pgBackRest)', table: 'pg_stat_archiver', tsCandidates: [],
    sql: `SELECT CASE WHEN current_setting('archive_mode') = 'off'
                        THEN pg_postmaster_start_time()
                      ELSE coalesce(last_archived_time, pg_postmaster_start_time()) END AS last_update,
                 CASE
                   WHEN current_setting('archive_mode') = 'off'
                     THEN 'archive_mode=off — SIN recuperacion a un punto en el tiempo'
                   WHEN last_failed_time > last_archived_time
                     THEN 'el ULTIMO intento FALLO (' || coalesce(last_failed_wal,'?') ||
                          ') — el WAL se esta acumulando en pg_wal'
                   ELSE archived_count::text || ' segmentos archivados · ' ||
                        failed_count::text || ' fallas historicas (acumulado, no reinicia) · ultimo ' ||
                        coalesce(last_archived_wal,'—')
                 END AS note_extra
            FROM pg_stat_archiver`,
    warnH: 0.25, critH: 1, cadence: 'continuo (archive_timeout=300 s)',
  },
  // ── Frescura por FECHA DEL DATO (detecta feed que corre pero no avanza) ──
  // Wincaja: el feed on-prem escribe a prod y a veces se congela por ECONNRESET (rollback) →
  // corre a diario pero la última venta se queda pegada. Medimos max(business_date), no updated_at.
  {
    key: 'wincaja_feed', label: 'Feed Wincaja (venta POS)', table: 'wincaja.v_sales_lines', tsCandidates: [],
    // ⛔ RETIRADA. Wincaja dejó de vender el 2026-09-19. El corte, medido día por día:
    //   09-18: Wincaja 30/32 = 4,334 líneas · Kepler 07/08 =   565 docs
    //   09-19: Wincaja 30/32 =     0       · Kepler 07/08 = 1,336 docs   ← la migración
    // y de ahí en adelante Wincaja en CERO todos los días. El CEDIS paró el 09-18.
    retiredOn: '2026-09-19',
    retiredWhy: 'Morelia (30/32) y el CEDIS migraron a Kepler; los carriles de réplica se detuvieron el 09-22 tras medir read 0 · wrote 0',
    // OJO: hay tickets con fecha FUTURA (errores de captura del POS) → ventana [hoy-30, hoy]
    // (acota el scan a rango indexable ~2s Y descarta la basura futura; si el feed lleva >30 días
    // muerto, no hay filas → last_update null → critical, que es lo correcto).
    sql: `SELECT max(business_date)::timestamp AS last_update,
                 'última venta ' || coalesce(to_char(max(business_date),'DD/MM'),'—') ||
                 ' · ' || count(DISTINCT source_branch)::text || ' sucursales' AS note_extra
          FROM wincaja.v_sales_lines WHERE business_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE`,
    warnH: 48, critH: 96, cadence: 'diario (feed on-prem Wincaja → prod)',
  },
  // (VP/ADR-056, deuda D) Procedencia de venta-ruta: el gold `sales_by_route_monthly` lo alimentan
  // varios universos en la MISMA llave (`WIN-50N`: push del runner .249 + branch de la réplica
  // md_06 + la era Wincaja). Desde 2026-09-10 Canindo ya no se resuelve con un `GREATEST` ciego:
  // `import-canindo-routes-monthly` COMPONE la serie (Wincaja hasta la frontera + push desde la
  // frontera) y la escribe con overwrite, y la réplica de sucursal quedó sólo como testigo —
  // medido, ve 3 de 5 rutas en ventanas sueltas. Lo que sigue importando es el modo de falla del
  // push: si el agente de una van se atora, el branch le gana una métrica y eso avisa que la
  // pierna fresca dejó de llegar. `reconcile-route-provenance.js` (nightly, on-prem) declara los
  // universos en `route_monthly_provenance`; acá disparamos si `stall` (branch>push en alguna
  // métrica = push atorado) forzando la edad, o si el reconciler dejó de correr (frescura).
  {
    key: 'route_provenance', label: 'Procedencia venta-ruta (push vs branch)', table: 'analytics.route_monthly_provenance', tsCandidates: [],
    sql: `SELECT CASE WHEN bool_or(stall) THEN now() - interval '999 hours' ELSE max(reconciled_at) END AS last_update,
                 CASE WHEN bool_or(stall)
                        THEN 'PUSH ATORADO: branch gana una métrica en ' || count(*) FILTER (WHERE stall)::text ||
                             ' llave(s) — la venta-ruta publicada pudo degradarse'
                        ELSE 'sin swap · ' || count(*)::text || ' llaves · máx que ofrecía el testigo no usado $' ||
                             coalesce(to_char(max(discarded_revenue),'FM999,999,990'),'0') || ' · reconciliado ' ||
                             coalesce(to_char(max(reconciled_at) AT TIME ZONE 'America/Mexico_City','DD/MM HH24:MI'),'—') END AS note_extra
            FROM analytics.route_monthly_provenance
           WHERE month >= (now() AT TIME ZONE 'America/Mexico_City')::date - 92`,
    warnH: 30, critH: 50, cadence: 'nightly (reconcile-route-provenance on-prem)',
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
    // ⛔ RETIRADA con el resto de Wincaja (ver `wincaja_feed`). Esta sonda hizo bien su trabajo
    // hasta el final: fue la que marcó el rezago de Madero y después el de Abastos. Lo que ya no
    // tiene sentido es medir el rezago de un sistema apagado — siempre va a crecer.
    retiredOn: '2026-09-19',
    retiredWhy: 'Wincaja se apagó; la venta de esas plazas la mide ahora el sensor de Kepler',
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
    // ⛔ RETIRADA con el resto de Wincaja (ver `wincaja_feed`). ⚠️ OJO al retirarla: septiembre-2026
    // es un mes PARTIDO (Wincaja hasta el 18, Kepler desde el 19), así que la cobertura del mes
    // cerrado va a dar un hueco REAL y permanente para ese mes. No es un feed roto: es la frontera.
    // Quien compare septiembre tiene que cruzar las dos fuentes, no una.
    retiredOn: '2026-09-19',
    retiredWhy: 'Wincaja se apagó el 09-19; septiembre-2026 queda partido entre Wincaja (1-18) y Kepler (19-30)',
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
    // ⛔ RETIRADA. Último movimiento REAL del CEDIS en Wincaja: 2026-09-18 (el `max(fecha)` crudo
    // dice 2029-08-02, que es basura de captura del POS y por eso acá se filtra `fecha <= now()`).
    retiredOn: '2026-09-19',
    retiredWhy: 'el CEDIS dejó de moverse en Wincaja el 09-18; el abasto de la red se sigue por Kepler',
    // `[W4.3]` Acá el `::timestamp` **SE QUEDA, y es load-bearing** — es el contraejemplo que hizo
    // que este barrido se midiera sensor por sensor en vez de aplicar un sed. `fecha` es
    // `timestamptz` (como en los dos sensores que sí se corrigieron), pero **no guarda un instante:
    // guarda una fecha de negocio en medianoche UTC** (medido: 3,586 de 3,586 filas de la rama 00
    // caen en 00:00 UTC y ninguna en 00:00 MX; `max(fecha)` = 04/09 00:00 UTC = 03/09 18:00 MX).
    // El cast en la sesión `Etc/UTC` la devuelve a "04/09 medianoche" naive, que node-postgres lee
    // como medianoche MX = exactamente la semántica que este sensor quiere medir. Quitarlo haría
    // envejecer el dato 6 h de más — el error en el sentido contrario.
    sql: `SELECT max(fecha)::timestamp AS last_update,
                 'BPIRAPUATO · último mov. ' ||
                 COALESCE(to_char(max(fecha), 'DD/MM'), '—') || ' · ' ||
                 count(*) FILTER (WHERE fecha >= current_date - 7)::text || ' movs 7d' AS note_extra
            FROM wincaja.maestro_mov_almacen
           WHERE source_branch = '00'`,
    warnH: 60, critH: 96, cadence: 'diario (feed on-prem Wincaja → prod)',
  },
  // `[W2.1]` ENTREGA, no proceso. El sensor de arriba mide `max(fecha)` — la fecha de NEGOCIO del
  // movimiento — con warn a 60 h porque los huecos de 2 días son normales en el CEDIS. Eso no puede
  // distinguir dos cosas distintas: *"la sucursal no movió mercancía"* y *"no cargamos"*. La que
  // separa las preguntas es `imported_at`: cuándo escribimos NOSOTROS.
  //
  // Vivido el 2026-09-07: `wincaja_sync` reportó **ok** hace 6.7 h y `wincaja.existencias` estaba en
  // **32.6 h** — la pantalla de Existencia servía el inventario de CEDIS/MD-30/MD-32 con día y medio
  // de atraso y ningún sensor lo decía. Causa (W2.2): el sync corre 05:00 y las copias del `.mdb`
  // llegan 08:45, así que cada corrida consume el archivo del día anterior; encima faltó la del
  // 05-sep. Es la misma forma que el incidente del carril de catálogos del ODS: latido de proceso,
  // no de entrega (ADR-053).
  //
  // Umbrales espejo de `wincaja_sync` (30/50 h) a propósito: es su MISMA cadencia diaria vista del
  // otro lado. Un pico sano llega a ~24 h justo antes de la corrida de las 05:00, así que 30 no
  // flapea. Si los dos divergen —el job verde y esto en rojo— el rojo es el que dice la verdad.
  //
  // Se mide el **MAX por rama y se alarma por la PEOR**, no el `max()` global: es la misma lección
  // de `stock_cedis_00` unas líneas arriba — un global enmascara la rama que se congeló mientras las
  // otras avanzan. Medido hoy: 00 → 33.6 h, 30 → 33.5 h, 32 → 33.4 h (las tres parejas, o sea el
  // problema es del carril y no de una rama).
  //
  // ⚠️ Y NO se usa `min(imported_at)` como "la rama rezagada": eso da la FILA más vieja de toda la
  // tabla (939 h medidas), que con UPSERT-sin-churn es simplemente el SKU cuyo valor no cambia
  // nunca. La primera versión de este sensor lo publicaba como "la rama más rezagada, 30/07" — un
  // número inventado, del tipo que ADR-056 prohíbe.
  //
  // ⚠️ **SIN `::timestamp`**, y no es estilo. Este servicio calcula la edad en JS
  // (`new Date(rows[0].last_update)` → `ageOf`). `imported_at` es `timestamptz`; castearlo a
  // `timestamp` tira la zona y deja el reloj de pared de la SESIÓN de pg, que en prod es `Etc/UTC`
  // (medido) — y node-postgres lo interpreta como hora LOCAL del proceso, que corre en
  // `America/Mexico_City`. Resultado medido: la edad sale **exactamente 6.00 h más joven** (33.38 h
  // reales contra 27.38 h reportadas), así que un `warnH: 30` dispararía a las 36. Sin el cast,
  // el driver recibe el timestamptz y la edad cuadra al centésimo con la de SQL.
  // ⚠️ El sesgo NO era exclusivo de este sensor: **cualquier** sensor cuyo SQL devuelva
  // `max(col)::timestamp` sobre una columna `timestamptz` lo tiene. `[W4.3]` barrió los 30 sensores
  // contra prod el 2026-09-07, preguntándole al driver el OID que devuelve cada uno y verificando
  // el TIPO de la columna de origen. Resultado:
  //   · los 15 sensores por-columna (`tsCandidates`) están **limpios**: los 15 leen `timestamptz`
  //     y ninguno castea, así que la edad en JS es el instante exacto;
  //   · 3 tenían sesgo real y se corrigieron: `stock_cedis_00` (tapaba un warn de 35.4 h reales),
  //     `fleet_positions` (`warnH: 3` que no podía disparar antes de las 9 h) y `ods_finance_00`
  //     (centinela que publicaba edad negativa);
  //   · 6 devuelven naive **con razón** y el cast se queda: `wincaja_cedis_stale` porque su
  //     `timestamptz` guarda medianoche UTC como fecha de negocio (ver su comentario), y
  //     `kepler_ods_00_stale` / `wincaja_feed` / `wincaja_branch_stale` / `sales_daily_date` /
  //     `bank_recon_period` porque derivan de un `date` y el cast es redundante, no sesgado.
  // Nota honesta: el sexto (`wincaja_branch_stale`) NO lo vio el barrido manual —el parser lo
  // saltaba— sino el candado, en su primera corrida.
  // El candado que impide que vuelva: `database/tests/test-db-health-tz-bias.js`.
  {
    key: 'wincaja_existencias_entrega',
    // ⛔ RETIRADA con el resto de Wincaja (ver `wincaja_feed`). El comentario de abajo ya venía
    // persiguiendo este apagón rama por rama ("Madero '32' migró a Kepler el 09-08"): lo que
    // parecía una lista de ramas que envejecía mal era, en realidad, un sistema muriéndose por
    // partes. El 09-19 murió la última.
    retiredOn: '2026-09-19',
    retiredWhy: 'Wincaja se apagó; la existencia de esas plazas vive en Kepler (kdik) desde el 09-19',
    label: 'Wincaja — existencia ENTREGADA (imported_at, no fecha de negocio)',
    table: 'wincaja.existencias', tsCandidates: [],
    // ⛔ La lista de ramas ya NO va hardcodeada, por la misma razón que en `wincaja_branch_stale`
    // (ver arriba, el caso Canindo). Estaba fija en ('00','30','32') y medido el 2026-09-21
    // reportaba **316 h** de rezago por culpa de Madero ('32', que migró a Kepler el 09-08) —
    // TAPANDO que el CEDIS '00', la única rama que de verdad sigue cargando, llevaba 77 h sin
    // entregar. Un sensor que no se puede apagar no avisa: enseña a ignorar el tablero, y encima
    // acá escondía el problema real detrás del falso.
    //
    // Ahora se deriva de `wincaja.branches.status = 'live_on_wincaja'` = las que todavía se
    // alimentan de un `.mdb` vivo. Las que migraron quedan en 'transition'/'legacy_on_kepler' y
    // salen solas; cuando Madero se funda como Abastos, este sensor no hay que tocarlo.
    sql: `WITH vivas AS (
            SELECT source_branch FROM wincaja.branches WHERE status = 'live_on_wincaja'
          ), r AS (
            SELECT e.source_branch, max(e.imported_at) AS ult
              FROM wincaja.existencias e
              JOIN vivas v ON v.source_branch = e.source_branch
             WHERE e.source_dataset = 'actual'
             GROUP BY e.source_branch
          )
          SELECT min(ult) AS last_update,
                 'la rama más atrasada es ' ||
                 COALESCE((SELECT source_branch FROM r ORDER BY ult LIMIT 1), '—') ||
                 ', cargada ' ||
                 COALESCE(to_char(min(ult) AT TIME ZONE 'America/Mexico_City', 'DD/MM HH24:MI'), '—') ||
                 ' · ' || count(*)::text || ' de ' ||
                 (SELECT count(*) FROM vivas)::text || ' ramas Wincaja vivas presentes' AS note_extra
            FROM r`,
    warnH: 30, critH: 50, cadence: 'diario 05:00 (mismo carril que wincaja_sync)',
  },
  // Tienda EN VIVO (poller POS on-prem → prod cada 25s). Detecta el poller CONGELADO
  // (proceso vivo pero mudo, visto 2026-08-04: se colgó 3h y nadie se enteró). Umbral
  // CONSCIENTE DEL HORARIO: fuera de 10:00–21:30 MX la tienda está cerrada → last_update=now()
  // (ok, no alarma nocturna). En horario mide antigüedad del último ticket de HOY; si aún no
  // hay ticket, cuenta desde la apertura (10:00) → avisa si la tienda "abrió" 45min sin vender.
  //
  // ⚠️ POR SUCURSAL, no global (arreglado 2026-09-09): antes medía `max(ticket_ts)` de TODAS las
  // sucursales juntas → mientras UNA vendía, el max estaba fresco y TAPABA a las muertas. Pasó de
  // verdad: el poller Kepler (00-06) murió 1 día y el sensor siguió VERDE porque Morelia Abastos
  // (Wincaja) seguía vendiendo. Ahora `last_update` = la sucursal ACTIVA HOY **más rezagada** (el
  // MIN de los últimos-ticket por sucursal) → una sola caída dispara la alarma sin que otra la tape.
  {
    key: 'store_live', label: 'Tienda en vivo (poller POS)', table: 'analytics.store_live_tickets', tsCandidates: [],
    sql: `WITH per_suc AS (
            SELECT warehouse_code, max(ticket_ts) AS last_ticket
              FROM analytics.store_live_tickets
             WHERE ticket_ts::date = (now() AT TIME ZONE 'America/Mexico_City')::date
             GROUP BY warehouse_code
          ), t AS (
            SELECT min(last_ticket) AS oldest_active, count(*) AS suc,
                   (array_agg(warehouse_code ORDER BY last_ticket))[1] AS suc_rezagada
              FROM per_suc
          ), w AS (
            SELECT (now() AT TIME ZONE 'America/Mexico_City')::time AS mx_time,
                   ((now() AT TIME ZONE 'America/Mexico_City')::date + time '10:00')
                     AT TIME ZONE 'America/Mexico_City' AS open_ts
          )
          SELECT CASE WHEN w.mx_time NOT BETWEEN '10:00' AND '21:30' THEN now()
                      ELSE COALESCE(t.oldest_active, w.open_ts) END AS last_update,
                 'más rezagada: suc ' || coalesce(t.suc_rezagada,'—') || ' @ ' ||
                   coalesce(to_char(t.oldest_active AT TIME ZONE 'America/Mexico_City','DD/MM HH24:MI'),'—')
                   || ' · ' || coalesce(t.suc, 0) || ' suc hoy' AS note_extra
            FROM t, w`,
    warnH: 0.75, critH: 1.5, cadence: 'continuo en horario (poller on-prem cada 25s), POR SUCURSAL',
  },
  // Ventas por ruta: el rollup analytics.sales_by_route_monthly (rutas WIN-%) que consume
  // /comercial/ventas-por-ruta. Los feeds de ruta (import-route-push-monthly/-lines/-vecinal)
  // pasaron a intraday (~1h, 24/7) → updated_at avanza cada corrida (el UPSERT hace updated_at=now()
  // sin guard). Dead-man propio porque una falla del PASO de ruta (ej. .249 mart.ventas inalcanzable)
  // NO alarma feed_intraday (falla parcial = batch 'ok'), pero aquí congela updated_at. Umbral intradía.
  // ⛔ 2026-09-14 — ESTE SENSOR SE ENMASCARABA A SÍ MISMO, y con el mismo mecanismo que su propio
  // comentario de arriba denuncia un piso más arriba.
  //
  // Usaba max(updated_at) sobre TODA la tabla. Pero la tabla tiene TRES escritores independientes:
  // import-route-push-monthly/-lines (camionetas, leen .249), import-kepler-vecinal-routes (lee
  // md_01) e import-canindo-routes-monthly. Con las vecinales sanas refrescando cada hora, el
  // máximo SIEMPRE es reciente — así que la pierna de camionetas puede estar muerta y el sensor
  // no se entera.
  //
  // Medido: el 12-sep se apagó el Postgres de .249 y la pierna de camionetas quedó 50.1 h sin
  // avanzar mientras las vecinales iban a 0.9 h. El sensor reportó `ok` las 49 horas. Antes de eso
  // ya llevaba 27 de 27 corridas fallando con "sin conexión al runner .249 (timeout expired)",
  // también en verde.
  //
  // Ahora mide la PEOR ruta ACTIVA, no el máximo. Un max() sobre una tabla con escritores
  // independientes es un agregado que OCULTA: basta un escritor sano para tapar a los demás.
  //
  // ⚠️ "Activa" = con datos en el mes actual o el anterior. Sin ese recorte el sensor vive en rojo
  // por rutas RETIRADAS (medido: WIN-321 jun-2026, WIN-322 jul-2026, WIN-VEC-PH-H jun-2026 con
  // 48 días), y una alarma que grita siempre se aprende a ignorar. Lo excluido NO se esconde: va
  // nombrado en la nota (ADR-056 — lo que no entra al veredicto se declara).
  //
  // ⚠️ El criterio es por ACTIVIDAD, no por patrón de nombre. Clasificar por nombre parecía obvio
  // y es una trampa: WIN-50% agarra tanto a Canindo como a las camionetas 501-505.
  {
    key: 'route_sales', label: 'Ventas por ruta (rollup intradía)', table: 'analytics.sales_by_route_monthly', tsCandidates: [],
    sql: `WITH r AS (
              SELECT route_code, max(updated_at) AS ult, max(month) AS ult_mes
                FROM analytics.sales_by_route_monthly
               WHERE route_code LIKE 'WIN-%'
               GROUP BY route_code
            ), act AS (
              SELECT * FROM r WHERE ult_mes >= date_trunc('month', CURRENT_DATE) - interval '1 month'
            ), ret AS (
              SELECT * FROM r WHERE ult_mes <  date_trunc('month', CURRENT_DATE) - interval '1 month'
            )
            SELECT (SELECT min(ult) FROM act) AS last_update,
                   (SELECT count(*) FROM act)::text || ' rutas activas · mas rezagada '
                   || coalesce((SELECT route_code || ' (' || round(extract(epoch FROM (now()-ult))/3600.0,1) || ' h)'
                                  FROM act ORDER BY ult LIMIT 1), '—')
                   || coalesce((SELECT ' · ' || count(*) || ' retirada(s) fuera de la alarma: '
                                  || string_agg(route_code, ', ' ORDER BY route_code) FROM ret), '') AS note_extra`,
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
  // ⛔ RETIRADOS 2026-09-05: los sensores `kp_concentrada` y `mega_dulces` vigilaban dos
  // concentrados que el ODS dejó sin función. Se quitan JUNTO con las bases, no después: un sensor
  // que apunta a una DB que ya no existe se pinta rojo para siempre y entrena al equipo a ignorar
  // el tablero — que es exactamente la falla que ADR-053 (Fase OBS) existe para evitar.
  //
  // Por qué quedaron sin función, medido el 2026-09-05 (no asumido):
  //   · KP_CONCENTRADA (.245, `kp.*`, 368 tablas / 7.7 GB): sus CINCO consumidores que de verdad
  //     corren — import-cash-sessions y los tres repoint-catalog-{presence,names,prices}, más
  //     import-label-data — tienen `SOURCE='ods'` por default (CANON.1.1/1.3) y `run-prod-feeds.js`
  //     no pasa `--source` a ninguno. Verificado en los logs en vivo: imprimen
  //     `Fuente: kepler_ods (same-DB prod, @min)`. Cero lectores productivos.
  //   · Mega_Dulces (.245): su ETL por archivos murió el 2026-05-20 (con el bug de fechas DD/MM).
  //     Las tres vistas `analytics_external.*_legacy` que colgaban de su FDW ya no las lee nadie:
  //     el código fue repuntado y sólo quedan los comentarios que explican por qué
  //     ("inalcanzable desde Railway", "el FDW Railway→.245 colgaba").
  //     ⚠️ CORRECCIÓN medida: `catalog.products_active` (y `public.products_active`, que la
  //     envuelve) SÍ cuelgan del FDW y SÍ se cuelgan — un `count(*)` dio statement timeout. La
  //     dependencia es transitiva, así que buscar `erp.*` en la definición de la vista de arriba no
  //     la encuentra. Y el search_path pone `catalog` ANTES que `public`: un `products_active` sin
  //     calificar resuelve a la que tiene el FDW. La mig 20260905140000 la repunta a
  //     `kepler_ods.kdii` en vez de borrarla.
  //     Los 9 consumidores reales NO se ven afectados, pero por otro motivo: leen la TABLA
  //     `inventory.products_active` (todos la califican), que llena `refresh-products-active.js`
  //     desde `catalog.products` + `kepler_ods.kdii`, explícitamente NO desde el FDW.
];

const RANK: Record<Status, number> = { ok: 0, warn: 1, unknown: 2, critical: 3 };

/**
 * Crons/feeds esperados. `warnH/critH` = horas desde la última corrida OK antes de warn/critical
 * (por cadencia del job). Un job en `error` = critical inmediato. Un job del registro que aún no
 * reportó = 'unknown' (no alarma hasta que se cablee). El heartbeat lo escribe cron-heartbeat.js.
 */
interface CronCfg {
  key: string; label: string; cadence: string; warnH: number; critH: number;
  // NOTA (2026-09-23): un carril retirado se saca de esta lista — así lo hizo `[NORM.3]` con las
  // seis llaves zombi. NO hay un `retiredOn` acá a propósito: `SourceCfg` sí lo tiene porque una
  // SONDA no se puede borrar sin perder la pregunta que hacía, y un CARRIL sí (el latido deja de
  // escribirse y la llave sin dueño cae sola en `unknown`). Dos mecanismos para lo mismo sería la
  // duplicación que ADR-056 prohíbe.
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
/**
 * `[DBH.5]` **Qué se dice de un job que NUNCA escribió un latido.** Pura a propósito: es la
 * única rama de `checkCronRuns` que no depende de la base, y sacarla acá es lo que permite
 * probarla — incluida su negativa (ADR-056: un gate sin prueba negativa es una intención).
 *
 * `declarado` = el job está en `CRON_JOBS`, o sea que alguien afirmó que debe correr.
 */
export function veredictoSinLatido(
  declarado: { cadence: string } | undefined,
): { status: Status; note: string } {
  if (!declarado) {
    // Nadie lo declaró y nunca reportó: no hay nada contra qué juzgarlo. `unknown` es correcto.
    return { status: 'unknown', note: 'sin reporte aún (no está en CRON_JOBS: no se puede juzgar)' };
  }
  return {
    status: 'warn',
    note:
      `DECLARADO Y NUNCA REPORTÓ: está en CRON_JOBS (cadencia ${declarado.cadence}) y no ha ` +
      'escrito ni un latido. O no está desplegado, o no corre, o corre y no late. ' +
      'No se puede saber cuál sin mirarlo.',
  };
}

/**
 * Veredicto de una sonda RETIRADA, o `null` si no lo está (y entonces manda `classify`).
 *
 * ⛔ POR QUÉ EXISTE, medido el 2026-09-23: las cinco sondas de Wincaja llevaban días en
 * `critical` vigilando un sistema **que ya no existe**. Wincaja se apagó el 2026-09-19 —el corte
 * es nítido: la venta de las sucursales 30/32 pasa de 4,334 líneas a CERO y Kepler 07/08 salta de
 * ~500 a ~1,300 documentos el mismo día—. Nadie tocó las sondas, así que el tablero mandaba
 * "12 crítica(s)" por carriles jubilados a propósito.
 *
 * Y eso no es cosmético: ese ruido es lo que tapó DOS fallas reales encontradas el mismo día —el
 * respaldo diario volcando la base vieja de Railway y `caja-general-ship` perdiendo dato de
 * producción—. Una alarma que grita por lo que ya no importa enseña a ignorar el tablero, y
 * entonces la que sí importa llega a un tablero que nadie mira.
 *
 * Cae en `unknown`, que el escáner **ya** excluye de las alertas a propósito ("solo cuentan
 * fallas reales: warn|critical"). No se inventa un quinto estado: `unknown` significa "no se
 * puede juzgar", y de un sistema apagado no hay frescura que juzgar. El motivo va en la nota,
 * visible en pantalla.
 *
 * ⭐ Y NO queda ciega. Si la fuente vuelve a recibir datos POSTERIORES al corte, pasa a `warn`.
 * Retirar no es "dejar de mirar para siempre", es "callate salvo que me sorprendas" — sin esto,
 * reactivar una sucursal en el sistema viejo sería invisible, que es el modo de falla opuesto y
 * tan malo como el que se está cerrando.
 */
export function veredictoRetirada(
  s: { retiredOn?: string; retiredWhy?: string } | undefined,
  last: Date | null,
): { status: Status; note: string } | null {
  if (!s?.retiredOn) return null;
  // Fin del día del corte en hora de México: un dato del MISMO día del apagón no es una sorpresa.
  const corte = new Date(`${s.retiredOn}T23:59:59-06:00`);
  if (last && last.getTime() > corte.getTime()) {
    return {
      status: 'warn',
      note: `⚠ sonda RETIRADA el ${s.retiredOn} y la fuente VOLVIÓ a recibir datos `
        + `(${last.toISOString().slice(0, 10)}) — revisar si el sistema se reactivó`,
    };
  }
  return { status: 'unknown', note: `retirada el ${s.retiredOn} · ${s.retiredWhy ?? 'sin motivo escrito'}` };
}

const CRON_JOBS: CronCfg[] = [
  // On-prem (insert/update a prod) — heartbeat vía cron-heartbeat.js
  // Sync al-minuto (Fase SYNC): on-prem empuja deltas por feeds-ingest (ingress gratis).
  // ⚠️ [DH.2] Decía "cada 2 min" y no corre así desde que `[VL.4]` lo mudó al carril `stock`
  // (`5,20,35,50 * * * *` = cada 15 min). Medido sobre 587 corridas de 7 días: p50 **15.0 min**,
  // p95 15.1, p99 29.9. Los umbrales (3 h / 12 h) siguen siendo correctos para 15 min — 12x y 48x
  // la cadencia — así que esto es sólo el rótulo, pero es el rótulo contra el que alguien decide
  // si "hace 20 minutos" es normal o es una alarma.
  { key: 'kepler_stock',        label: 'Kepler stock vivo (multi-sucursal)', cadence: 'cada 15 min', warnH: 3,  critH: 12 },
  // Respaldo del dataset 'concentrada' (mes que rueda del 'actual'). Semanal → umbral holgado:
  // warn a ~9 días (una corrida perdida), critical a ~16 (dos). Ver wincaja_month_coverage.
  // [VL.6.3] EL RESPALDO DE PROD. Era invisible: 36 job_key vigilados y ninguno era el
  // respaldo. Lo unico que lo reportaba era `LastTaskResult` del Programador de Windows, que
  // llevaba desde el 2026-09-08 diciendo 267014 (SCHED_S_TASK_TERMINATED) sin que nadie lo
  // notara -- porque el .dump quedaba con buen tamano y 'el respaldo existia', mientras sus
  // compuertas (validar el dump, piso de tablas, retencion) no corrian.
  // Umbral de job diario, mismo criterio que sales_daily: warn al saltarse una corrida,
  // critico al saltarse dos. `maxRunH: 3` porque las corridas medidas son de 69-90 min.
  // [VL.6.4] Se mudó de la tarea de Windows (17:00 en `SISTEMAS`) al contenedor `prod-backup`
  // de `md` (22:00). El `host` del latido lo distingue: `SISTEMAS` vs `md-backup`. La cadencia
  // se corrige acá porque es lo que el tablero le muestra a una persona: con la hora vieja,
  // quien viniera a ver por qué falta el respaldo lo buscaría cinco horas antes y en otra máquina.
  // `maxRunH: 3` aguanta: los cuatro respaldos reales medidos tardaron 68, 69, 89 y 74 min.
  // ─── [NORM.3] SEIS LLAVES ZOMBI RETIRADAS, 2026-09-23 ───────────────────────────────────
  // Una llave sin escritor NO se apaga sola: se queda con su último `status='ok'` ENVEJECIENDO, y
  // un `ok` de 84 h se lee igual que salud. Las seis se verificaron UNA POR UNA en `.249` antes de
  // sacarlas, no por lo que dice la prosa del README:
  //   · wincaja_sync / _live / _concentrada  → `Get-ScheduledTask`: las 3 **Disabled**
  //   · wincaja_replica_inc / _hash          → `pm2 list`: las 2 **stopped**
  //   · feed_guardian                        → ⭐ el caso raro, y NO es el que contaba el README.
  //     Su tarea estaba **Ready** y corriendo (última 16:41, resultado 0), pero su renglón tenía
  //     **25.9 h** contra un umbral de `critH: 2` — o sea que la llave estaba en **ROJO**, no en
  //     verde: la tarea corre y su latido NO se escribe. Y lo que vigila es nada: se midió que
  //     **las 13 tareas de su lista están Disabled**, así que recorría una lista apagada. Alarma
  //     inútil en las dos direcciones — roja sin motivo y ciega a la vez. Se apagó la tarea y se
  //     sacó la llave EN EL MISMO CAMBIO, que es la regla que `ops/README.md` ya enunciaba:
  //     apagar la tarea sin sacar la llave pone la alarma en rojo, y sacar la llave sin apagar la
  //     tarea deja un carril corriendo sin vigilancia.
  // ⚠️ Su escritor `run-feed-guardian.ps1` vive en C:/KeplerRunner/, FUERA del repo — por eso un
  //   grep no lo encontraba y parecía una llave sin dueño.
  { key: 'backup_prod',         label: 'Respaldo diario de prod (pg_dump)', cadence: 'diario 22:00 (md)', warnH: 26, critH: 50, maxRunH: 3 },
  // [VL.9.10] Respaldo del CLÚSTER con pgBackRest: diferencial a diario 23:30, completo los
  // domingos. Distinto de `backup_prod`, que es el volcado portátil — éste es el que da
  // recuperación a un punto en el tiempo. ⚠️ Y es el que hace que el WAL EXPIRE: sin un
  // respaldo nuevo, el WAL archivado se acumula sin tope (medido: 4 GB → 12 GB en 3 horas).
  // 26 h de warn porque es diario; 50 h antes de crítico da margen a una noche perdida.
  { key: 'pgbackrest_backup',   label: 'Respaldo pgBackRest (PITR)', cadence: 'diario 23:30 (md)', warnH: 26, critH: 50, maxRunH: 2 },
  // ── [NORM.3] EL FACT DE VENTA, AHORA CON UN EMISOR POR LLAVE ────────────────────────────────
  // Hasta el 2026-09-23 esta llave la escribían DOS carriles con ventanas distintas (`livefast`
  // @60 s = 2 días · `nightly` @03:00 = 13 meses) y, por la regresión de env de [VL.4], también
  // `live` @30 min. La PK de `analytics.cron_runs` es `(tenant_id, job_key)` SIN host: se pisaban
  // el renglón. Consecuencias medidas en prod sobre 7 días:
  //   · 304 de 6,296 corridas (4.8 %) quedaron en `error` con "la corrida anterior no reportó
  //     cierre" — errores INVENTADOS por el cruce, no fallas. 16× más que cualquier otra llave.
  //   · `duration_ms` mentía: se calcula `now() - last_start` y el `last_start` era del otro.
  //   · y al revés: el emisor de 60 s repintaba la llave en verde, así que el nocturno podía
  //     estar muerto y el tablero no se enteraba. Ése era el riesgo de fondo.
  // Ahora `kepler_sales_fact` = SÓLO `livefast` (2 días, cada 60 s), así que el umbral puede ser
  // honesto: 6 h de warn era el umbral de un intradía de 30 min, no de un loop de un minuto.
  // Se deja 1 h / 3 h y no 0.5/2 como el carril `feed_livefast`: primero avisa el carril (que no
  // corrió) y después la entrega (que no llegó) — dos señales del mismo hecho, en ese orden.
  { key: 'kepler_sales_fact',   label: 'Kepler ventas (sales-fact, 2d)', cadence: 'continuo ~60s', warnH: 1, critH: 3, maxRunH: 1 },
  // El refresco COMPLETO de 13 meses: es el ÚNICO que toca filas de más de 2 días. Medido sobre 8
  // días en prod, su régimen normal son 98–852 filas/día ($12k–$86k) más picos de re-derivación
  // masiva cuando cambia un insumo (45,573 filas / $9.5 M el 17-sep, al moverse la escalera de
  // unidad). Umbral calcado de `feed_nightly`, que es quien lo corre. ⚠️ Registrarlo no es
  // cosmético: sin entrada acá el sensor cae en `cfg ? classify : 'ok'` = verde incondicional.
  { key: 'kepler_sales_fact_full', label: 'Kepler ventas (sales-fact COMPLETO 13m)', cadence: 'diario 03:00 MX', warnH: 30, critH: 50, maxRunH: 2 },
  // kepler_catalog_bulk RETIRADO (2026-09-11): el catálogo lo mantienen los repoint-catalog-* del
  // nightly (presence/names/prices/cost, CANON.0.1) — catalog.products fresco 0 h. Su latido llevaba
  // 26 d muerto y este sensor daba un FALSO crítico. No re-agregar. Fila zombie borrada en mig 20260911120000.
  // ── Latido por MODO del runner on-prem (run-prod-feeds.js) — dead-man's switch por batch.
  // Cada tarea de Windows corre un modo; si deja de correr (zombie/apagado/deshabilitada), su
  // último latido envejece y salta en rojo aquí, aunque el dato downstream aún se vea fresco.
  // Umbral = ~2-4× la cadencia de su tarea. Los modos MANUALES (finance/logistics/all) NO se
  // registran a propósito: laten pero se muestran 'ok' sin alarmar (no tienen cadencia esperada).
  // [AB.0b] La FOTO DE INVENTARIO. Es el unico job del registro cuyo dato NO se puede
  // reconstruir despues: la venta de ayer se saca del ERP, la EXISTENCIA de ayer no la
  // guardo nadie. Un dia que no corre es un dia perdido para siempre, asi que el umbral
  // es estrecho: warn al saltarse UNA corrida (26 h), critico a las dos (50 h) -- mismo
  // criterio que los demas jobs diarios. `maxRunH: 1` porque la corrida medida es de
  // segundos sobre ~58k pares; una hora ya es un cuelgue.
  { key: 'stock_snapshot',      label: 'Foto diaria de inventario',         cadence: 'diario 23:50 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // `[CDRP.4]` Corre 08:30 MX. Umbral calcado del hermano `stock_snapshot`: 26 h tolera que un
  // dia se corra un rato, 50 h avisa que se perdio una foto. ⛔ Registrarlo es OBLIGATORIO y no
  // cosmetico: sin entrada aca el sensor cae en `cfg ? classify : 'ok'` — verde incondicional.
  // Medido el 2026-09-21: la tabla de fotos tenia 0 filas y CERO renglones en `cron_runs`, o sea
  // que llevaba quien sabe cuanto sin tomarse y nadie podia enterarse.
  { key: 'cxc_snapshot',        label: 'Foto diaria de cartera (CxC)',      cadence: 'diario 08:30 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // [CC.10] Sin este renglón el latido de `cobranza_gap` no sirve de nada: el sensor caería en
  // `cfg ? classify : 'ok'` y un cron parado se vería verde. Van juntos, siempre.
  { key: 'cobranza_gap',        label: 'Brecha banco↔cobro (abonos sin ligar)', cadence: 'diario 07:45 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // [CG.25] Sin este renglón el latido de `caja_fecha_futura` no sirve: el sensor caería en el
  // `cfg ? classify : 'ok'` y un cron parado se vería verde — que es justo el modo de falla que
  // este job existe para no repetir.
  { key: 'caja_fecha_futura',   label: 'Caja: movimientos fechados adelante', cadence: 'diario 07:15 MX', warnH: 26, critH: 50, maxRunH: 1 },
  { key: 'feed_live',           label: 'Feed live (venta viva)',            cadence: 'cada 30 min',  warnH: 2,   critH: 6, maxRunH: 1 },
  { key: 'feed_livefast',       label: 'Feed livefast (loop ~60s)',         cadence: 'continuo ~60s', warnH: 0.5, critH: 2 },
  // ── [NORM.3] EL CARRIL QUE ERA MUDO ─────────────────────────────────────────────────────────
  // `refresh-consolidado` era el ÚNICO de los 17 de `ops/vl/crontab.feeds` sin latido, y es el que
  // está MÁS arriba de todo: refresca `mart.ventas` → `mart.ventas_enriched` → `sales_daily`, o
  // sea la venta publicada entera. Si se paraba, los carriles de abajo seguían en verde
  // republicando los números de ayer. Umbral = 15 corridas perdidas para warn, 60 para crítico:
  // holgado para un carril de 2 min y muy por debajo de la media jornada.
  // `maxRunH: 1` porque el propio script se autotermina a los 90 s (watchdog duro) — un renglón
  // en `running` de más de una hora sólo puede significar que el proceso murió sin cerrar.
  { key: 'consolidado_refresh', label: 'Consolidado Kepler (mart.refresh_si_cambio)', cadence: 'cada 2 min', warnH: 0.5, critH: 2, maxRunH: 1 },
  { key: 'feed_stock',          label: 'Feed stock (batch existencia)',     cadence: 'cada 15 min',  warnH: 1.5, critH: 4, maxRunH: 1 },
  // [DB-MEM.2] Pasó de "cada minuto" a diario 04:30 — y con él, su umbral. NO es un feed: es el
  // BARRIDO HISTÓRICO (`detect-goods-receipt-duplicates.js`, ventana `--from=2026-01-01`), que
  // costaba el 42.8% del tiempo de ejecución de la base para procesar 1-54 recepciones por DÍA.
  // Lo incremental lo hace `twins_pairing` (cada 5 min), que es quien debe vigilarse de cerca.
  // ⚠️ Si este umbral se hubiera quedado en 0.5/2 h, el tablero lo marcaría CRÍTICO todos los
  // días a las 06:30 — una alarma permanente por el comportamiento correcto, que es justo lo que
  // enseña a ignorar el tablero.
  { key: 'feed_receipts',       label: 'Barrido histórico de recepciones (XA2001)', cadence: 'diario 04:30 MX', warnH: 26, critH: 50, maxRunH: 2 },
  { key: 'feed_intraday',       label: 'Feed intraday (transaccionales)',   cadence: 'cada 1 h',     warnH: 3,   critH: 8, maxRunH: 2 },
  { key: 'feed_nightly',        label: 'Feed nightly (batch nocturno)',     cadence: 'diario 03:00', warnH: 30,  critH: 50, maxRunH: 4 },
  // [NORM.2] Este carril EXISTÍA COMO SCRIPT Y NO ESTABA AGENDADO EN NINGÚN LADO. Llena
  // `inventory.products`, que es el catálogo de escaneo del conteo físico: medido el 2026-09-23,
  // llevaba **37 días** sin un `synced_at` nuevo y **147 SKUs** no eran escaneables. Un producto
  // que el ERP dio de alta y que el contador no puede escanear se cuenta como faltante.
  // 05:10 = después del nocturno (03:00) que puebla `catalog.products`, y sin chocar con
  // `receipts` (04:30) ni `contpaqi-cfdis-full` (05:45).
  { key: 'inventory_products_refresh', label: 'inventory.products ← catalog (escaneo de conteo)', cadence: 'diario 05:10 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // [NORM.2] Hermana de la de arriba y con el mismo defecto de origen: escrita, con 9 lectores
  // vivos (buscador, pricing, portal, extractor de tickets, AI-matcher) y SIN AGENDA. Refresca por
  // TRUNCATE+INSERT, así que se le agregó un PISO anti-vaciado: si el origen diera menos del 50%
  // de lo que la tabla tiene, ABORTA y late en rojo en vez de commitear una tabla casi vacía.
  { key: 'products_active_refresh',    label: 'inventory.products_active ← catalog (9 lectores)',  cadence: 'diario 05:20 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // La tarea \Kepler\Catalog es SEMANAL (MSFT_TaskWeeklyTrigger, domingos 02:00), no diaria:
  // con umbrales de 30/50 h quedaba en ROJO PERMANENTE entre corridas legítimas. Eso es peor
  // que no monitorear — un tablero que grita siempre entrena a ignorarlo, y es la explicación
  // más probable de que el feed_nightly muriera 2 noches (25 y 26-ago) sin que nadie lo viera.
  // ⚠️ [DH.2] Decía "semanal dom 02:00" y el cron real es `0 2 * * 6` = **sábado** 02:00
  // (`ops/vl/crontab.feeds`). Los umbrales no cambian —180/200 h cubren la semana igual— pero la
  // cadencia es lo que el operador LEE para decidir si un rezago es normal, y le estaba corriendo
  // el día. Verificado carril por carril el 2026-09-25: 18 de 19 coincidían, éste no.
  { key: 'feed_catalog',        label: 'Feed catálogo (semanal)',           cadence: 'semanal sáb 02:00', warnH: 180, critH: 200, maxRunH: 3 },
  { key: 'feed_contpaqi',       label: 'Feed ContPAQi (pólizas+bancos)',    cadence: 'cada 1 min',   warnH: 0.5, critH: 2 },
  // [VL.4b] El carril de PRECIOS. Corría fuera del runner (`C:\KeplerRunner\run-prices.cmd` llamaba a
  // los dos importers directo), así que no latía y no tenía entrada acá — o sea que el carril que
  // publica el precio de venta era el único sin forma de avisar. Es EL carril del incidente que
  // fundó la Fase OBS: seis días de precios viejos, uno 54 % bajo costo, encontrado por un humano.
  { key: 'feed_prices',         label: 'Feed precios (etiqueta+venta)',     cadence: 'cada 30 min',  warnH: 2,   critH: 6, maxRunH: 1 },
  { key: 'feed_contpaqi-slow',  label: 'Feed ContPAQi lento (balanza+prov)', cadence: 'cada 2 h',    warnH: 5,   critH: 12 },
  // `cdc_wal_00..06` (CDC WAL-decode, ADR-047) SACADOS 2026-09-04 (OBS.8): el carril se retiró y sus
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
  // OBS.11 — barrido DIARIO del backlog de kdpord (ods-reconcile-full, off-hours 03:00 MX). Latido
  // PROPIO (cdc_reconcile_full) para no pisar el del carril continuo. Diario → warn si pasa un día
  // sin correr. Sin esta entrada caía en el `cfg ? classify : 'ok'` = VERDE INCONDICIONAL (la trampa OBS).
  { key: 'cdc_reconcile_full',  label: 'Reconciliador ODS --full (backlog kdpord)', cadence: 'diario 03:00 MX', warnH: 25, critH: 30 },
  // [ODS.2] La red de las tablas CHICAS (las que no tienen fecha de negocio y por eso quedaban sin
  // ninguna). 16 tablas × 9 ramas cada 30 min. Umbral holgado a propósito: ninguna es de movimiento
  // vivo — un atraso de 2 h acá no significa lo mismo que en `cdc_reconcile`, que mira ventas.
  // ⚠️ Sin este renglón el sensor daría verde INCONDICIONAL (`cfg ? classify : 'ok'`, Fase VP).
  { key: 'cdc_reconcile_chicas', label: 'Reconciliador ODS --chicas (tablas sin fecha)', cadence: 'continuo ~30 min', warnH: 2, critH: 6 },
  // [OBS.12] Dedup de las tablas contables `kdc2YYMM`. Existe porque `c2` esta en la PK y el ODS
  // trae DOS renderizados del mismo instante (+6 h hasta el 2026-09-23): un UPDATE de Kepler
  // aterriza como INSERT y conviven el ANTES y el DESPUES de la misma poliza, los dos sumando.
  // Medido 2026-09-29: 1,737 grupos por $22,796,303.99, y el ingreso de agosto publicaba
  // $77,131.36 de mas. NO lo cubre `cdc_reconcile_full`: por llave de dia la fila SI esta en el
  // origen, asi que no es sobrante — es un defecto de IDENTIDAD, no de borrado.
  // ⚠️ Sin este renglon el sensor daria verde INCONDICIONAL (`cfg ? classify : 'ok'`, Fase VP).
  { key: 'cdc_dedupe_fecha', label: 'Dedup ODS de PK con fecha (kdc2YYMM)', cadence: 'diario 02:25 MX', warnH: 25, critH: 30 },
  // OBS.1 — el carril del POLL (replicate-ods-live.js), que es el que de verdad alimentaba prod y
  // era MUDO: no escribía a cron_runs y no tenía entrada acá, así que db-health no tenía NADA que
  // vigilar. Estuvo parado del 27/08 al 02/09/2026 — 6 días, ~23,200 filas de catálogo sin shipear
  // (10,248 de costo) — y lo encontró un humano al corregir un precio a mano. Dos carriles, dos
  // umbrales: el hot corre @15s y el espejo completo @300s con pasadas de minutos.
  { key: 'ods_live_hot',        label: 'ODS carril vivo (replica→prod)',  cadence: 'continuo ~15 s',  warnH: 0.5, critH: 2 },
  { key: 'ods_live_mirror',     label: 'ODS espejo completo (replica→prod)', cadence: 'continuo ~5 min', warnH: 2, critH: 6 },
  // [PUB.1] El carril que PUBLICA el catálogo del ODS a la tienda mayorista (Railway), que no puede
  // alcanzar a prod on-prem. Se registra ACÁ, antes de agendarlo, porque un latido sin umbral cae en
  // el `cfg ? classify : 'ok'` y se pinta verde incondicional — y este carril nace justo de eso: la
  // tienda leía por FDW la prod VIEJA de Railway y estuvo publicando catálogo del 23-sep hasta el
  // 28-sep (21,404 movimientos y 910,676 piezas de diferencia) sin que nada se pusiera en rojo.
  // Su `error` significa «la huella del destino NO cuadra con la del origen después de publicar»,
  // o sea pérdida de dato — no «el proceso se cayó».
  { key: 'ods_publish_tienda',  label: 'ODS → tienda mayorista (prod→Railway)', cadence: 'continuo ~10 min', warnH: 1, critH: 4 },
  // [RL.11] La COBERTURA de la suscripción — un modo de falla que NINGÚN latido de arriba puede
  // ver, porque no hay nada que falle. La publicación de los POS es `FOR TABLES IN SCHEMA md`, así
  // que una tabla nueva entra sola a la publicación, pero el suscriptor no la escucha hasta que
  // alguien corre `ALTER SUBSCRIPTION … REFRESH PUBLICATION`. Y Kepler crea UNA TABLA DE PÓLIZA POR
  // MES (`kdc2YYMM`). Cada 1° de mes, entonces, la contabilidad del mes nuevo deja de replicarse
  // con la suscripción `enabled`, el apply worker sano y el lag en segundos: la tabla simplemente
  // no está en `pg_subscription_rel`. `ods_live_*` mide que el caño se mueva, `cdc_reconcile` mide
  // que no falten filas DE LO QUE ESCUCHA — ninguno de los dos mira lo que no escucha.
  // Medido el 2026-09-18: `kdc22609` sin suscribir en Canindo (2,162 renglones de septiembre
  // esperando, mientras agosto tenía 1,971) y `kdc22610` sin suscribir en 7 de 9 ramas.
  // ⚠️ El carril es DIARIO aunque el hueco sea mensual: un job mensual no se puede vigilar (pasa
  // 29 días "vencido"), y el REFRESH que no agrega nada cuesta una consulta de catálogo.
  { key: 'kepler_replica_refresh', label: 'Réplicas Kepler — cobertura de la suscripción', cadence: 'diario 06:22 MX', warnH: 26, critH: 50, maxRunH: 1 },
  // OBS.1 — HUÉRFANOS: estos SÍ latían, pero al no estar acá caían en el `cfg ? classify : 'ok'` de
  // checkCronRuns() y se pintaban VERDE INCONDICIONAL por viejos que estuvieran. Un latido sin
  // umbral registrado no es una alarma, es decoración. (wincaja_replica_* justo se pasó 4 días en
  // cero con los dos carriles "online" — esto es lo que lo habría gritado.)
  // [CG.9e] Los dos carriles de la CAJA GENERAL, hermanos de los de Wincaja: mismo Jet 32-bit,
  // misma máquina (`.249`), mismo motivo para existir. Se registran ACÁ, antes de arrancarlos,
  // porque un latido sin umbral cae en el `cfg ? classify : 'ok'` y se pinta verde incondicional —
  // y esta fase nace justo de eso: `analytics.caja_*` estuvo congelada del 11 al 15 de septiembre
  // con el tablero en `ok`, porque el importer se quedó sin agenda y nadie lo vigilaba.
  //
  // `caja_general_replica_all`: TODO va por hash-delta (nada incremental, y está medido: la PK de
  // `Doctos` tiene dos ejes), así que hay un solo carril y el sufijo es `all`. Una pasada completa
  // de las dos ramas mide ~192 s; a @30 min, warn al saltarse tres corridas.
  { key: 'caja_general_replica_all', label: 'Caja general réplica cruda (.mdb → :5433)', cadence: 'continuo ~30 min', warnH: 1.5, critH: 4 },
  // `caja_general_ship`: Postgres→Postgres, barato (2ª pasada medida: 127 filas leídas, 0 escritas).
  // Es el que de verdad decide si la pantalla está fresca, así que va con umbral corto.
  { key: 'caja_general_ship',   label: 'Caja general ship (:5433 → caja_general_ods)', cadence: 'continuo ~5 min', warnH: 0.5, critH: 2 },
  // [CG.22.3] `mv_caja_refresh`: el corte de caja materializado que lee la bandeja de
  // /finanzas/caja-general. Va con umbral CORTO porque su modo de falla es el peor de todos —
  // un matview que dejó de refrescarse **no da error**: sirve la foto vieja, y una bandeja de caja
  // congelada se lee como "no hay trabajo pendiente". Corre cada minuto; warn al saltarse ~6.
  { key: 'mv_caja_refresh',     label: 'Caja — refresca mv_caja_movimientos', cadence: 'cada minuto', warnH: 0.25, critH: 1 },
  // [CS.1] Feed de CAOS (caja fuerte) → analytics.caos_cash_movements. Corre cada 2 min on-prem.
  // Sin esta entrada el latido caería en `cfg ? classify : 'ok'` = verde incondicional. La caja
  // mueve ~8/día; el rezago se tolera holgado (warn a ~2 h) porque un hueco no es urgente como el
  // corte de caja, pero un feed muerto un día entero sí importa (crit a 6 h).
  { key: 'caos_movimientos',    label: 'CAOS — movimientos de caja fuerte',   cadence: 'cada 2 min', warnH: 2, critH: 6 },
  // [EX-PERF.2] `mv_existencia_aux_refresh`: el factor de caja y el costo del ERP que valuan
  // /compras/existencia. Mismo modo de falla que el matview de caja: si deja de refrescarse
  // **no da error**, sirve la foto vieja — y acá eso vale dinero, porque el factor manda la
  // cantidad que se pide y el costo, la valuacion del inventario. Corre cada 5 min.
  // Sin este renglon `db-health` daria verde INCONDICIONAL (`cfg ? classify : ok`), que es lo
  // que la Fase VP midio sobre 3 matvistas del sell-out.
  // [AX-PERF.1] El mismo carril refresca ahora TRES fotos: las dos de `/compras/existencia` y
  // `mv_product_box_factor`, que es el divisor con el que el anexo al CFDI imprime la
  // equivalencia en cajas. O sea que este renglon dejo de cubrir solo una pantalla interna:
  // si se apaga, se entrega papel al cliente con un factor viejo.
  { key: 'mv_existencia_aux_refresh', label: 'Factor de caja y costo Kepler (existencia + anexo del CFDI)', cadence: 'cada 5 min', warnH: 0.5, critH: 2 },
  { key: 'contpaqi_add_cfdis',  label: 'ContPAQi CFDIs (ADD, incremental)', cadence: 'cada 5 min',   warnH: 2,   critH: 8 },
  // El carril `full` es el RECONCILIADOR (recorrido por año, 1×día): si un cambio del ADD no tocara
  // el sello, esta pasada lo levanta igual. Latido propio (`CONTPAQI_HB_KEY`) para que no le preste
  // el pulso al incremental — ver la nota en `import-contpaqi-cfdis.js`.
  { key: 'contpaqi_add_cfdis_full', label: 'ContPAQi CFDIs (ADD, reconciliador)', cadence: '1×día', warnH: 26, critH: 50 },
  // [VL.4b] El poller de tickets de /tienda/live. Era MUDO y su única señal era el mtime de un .log
  // — que se sigue moviendo aunque no llegue un solo ticket. El 2026-09-11, tras mudar la fuente a
  // `md` y dejar las suscripciones viejas en DISABLE, las réplicas de `.249` quedaron congeladas y el
  // poller escribió 137 min de "N vistos · 0 nuevos" SIN UN ERROR. Ahora late con entrega
  // (`rows` = tickets efectivamente insertados en prod) y se pone en `error` si una rama falla o si
  // una réplica deja de recibir WAL — lo segundo es una medida directa sobre `pg_stat_subscription`,
  // no "hace mucho que no vende", que dispararía en falso cada noche al cerrar las tiendas.
  { key: 'store_poller',        label: 'Poller tickets en vivo (Kepler → /tienda/live)', cadence: 'continuo ~25 s', warnH: 0.5, critH: 2 },
  // [VL.4b] El poller GPS de la flota, el otro carril mudo. Su modo de falla NO es caerse: es que
  // la sesión con MagniTracking expire (ADR-034: no hay API oficial, el adapter replica el login de
  // la web). Ahí `fn_objects` devuelve vacío, el ciclo termina "bien" y no se entrega nada — por eso
  // el carril reporta `error` con 0 objetos en vez de un ok que no significa nada.
  { key: 'fleet_gps',           label: 'Poller GPS de flota (MagniTracking → prod)',    cadence: 'cada 1 min',    warnH: 0.5, critH: 2 },
  // [VP.0.1] Las 4 MVs del cron NOCTURNO de `AnalyticsRefreshService` (`@Cron('0 20 6 * * *')`,
  // 06:20 MX), en el ORDEN de dependencia en que se refrescan. Dos bugs juntos, uno por omisión y
  // otro por copia:
  //   · `analytics_refresh_wincaja` era la ÚNICA registrada y estaba con `cadence: 'cada 15 min',
  //     warnH: 1` — los umbrales del OTRO cron (`analytics_refresh`, ese sí de 15 min). Como la
  //     escribe el diario, envejecía 24 h legítimas y se pintaba `critical` todo el día, todos los
  //     días. Una alarma que grita siempre en falso enseña a ignorar el tablero (es la lección de
  //     las 488 alertas con cero reconocidas, y por eso OBS.8 borró los latidos muertos del CDC).
  //   · Las otras tres NO estaban → con el viejo `: 'ok'` salían verdes por siempre. Justo las que
  //     arman el sell-out: si `mv_kepler_sales_daily` deja de refrescarse, el pivote sirve una
  //     pierna vieja y otra fresca sin que nada avise.
  // Umbrales de job diario, mismo criterio que `sales_daily`: warn al saltarse una corrida, crítico
  // al saltarse dos.
  { key: 'analytics_refresh_wincaja',         label: 'Refresh MV Wincaja (nightly)',      cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // [VP.4.3] El comparador de cierres (07:10 MX, después del refresh). Se registra acá porque el
  // candado de VP.0.5 lo exige —todo `job_key` que late tiene umbral— y porque un comparador que
  // deja de correr en silencio devuelve la deriva a ser invisible, que es lo que la fase cerró.
  { key: 'period_close_check',                label: 'Verificación de cierres de mes',    cadence: 'nightly 07:10 MX', warnH: 26, critH: 50 },
  // [DB-MEM] El apareo INCREMENTAL de recepciones gemelas (`GoodsReceiptTwinsService`, cada 5 min).
  // Nació mudo: el único job_key de recepciones que este tablero veía era `feed_receipts`, que es el
  // CLI de barrido HISTÓRICO — agendado cada minuto y llevándose el 42.8% del tiempo de ejecución de
  // la base. Sin este latido no se podía bajar la cadencia del CLI sin arriesgar dinero contado dos
  // veces, porque nadie podía comprobar que el incremental estuviera vivo. Umbral de job de alta
  // frecuencia, mismo criterio que `kepler_stock`.
  { key: 'twins_pairing',                     label: 'Apareo de recepciones gemelas (cron API)', cadence: 'cada 5 min', warnH: 3, critH: 12 },
  { key: 'analytics_refresh_kepler',          label: 'Refresh MV Kepler (nightly)',       cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  { key: 'analytics_refresh_payment_terms',   label: 'Refresh MV condición de pago (SD-PAY, nightly)', cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  { key: 'analytics_refresh_sellout_monthly', label: 'Refresh MV sell-out mensual',       cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  { key: 'analytics_refresh_blended',         label: 'Refresh MV blend consolidado',      cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // [KX.5] El peldano COBRADO (max kdm2.c58 por sucursal x SKU). Sin esta entrada el sensor
  // caeria en `cfg ? classify : 'ok'` y una MV parada se veria VERDE (leccion OBS.1). Y no es
  // cosmetico: cuando envejece, el piso que corrige `box_factor = 1` deja de recibir peldanos
  // nuevos y un producto que empezo a venderse por bulto sigue publicandose como pieza.
  { key: 'analytics_refresh_sold_rung',       label: 'Refresh MV peldano cobrado',        cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // [WMS-BI.4.3] Copia cacheada del resolvedor de unidad (v_unit_truth, ADR-057). Mismo motivo
  // que la de arriba: sin umbral el sensor cae en `cfg ? classify : 'ok'` y una MV parada se ve
  // VERDE. Cuando envejece, un producto cuya unidad base cambio se sigue publicando con la
  // anterior — y la unidad es justo lo que ADR-057 existe para no adivinar.
  { key: 'analytics_refresh_unit_truth',      label: 'Refresh MV verdad de unidad',       cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  { key: 'analytics_refresh_standard_cost',   label: 'Refresh MV actividad costo estándar (CE.0)', cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // [IC.10] Roll-forward entre conteos. Mismo motivo que las dos de arriba, con un agravante:
  // cuando envejece la pantalla de Conciliacion no se vacia ni avisa -- sigue mostrando la
  // merma del periodo anterior como si fuera la del actual, que es la clase de fallo que no
  // se nota hasta que alguien decide con ella.
  { key: 'analytics_refresh_count_rollforward', label: 'Refresh MV roll-forward de conteos', cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // [IC.12] Sin esta fila el sensor cae en `cfg ? classify : 'ok'` y la MV parada se ve VERDE.
  // Acá no es cosmético: /almacen/inventory/diferencias seguiría publicando el descuadre del
  // trimestre pasado, y su banda de dinero en disputa, como si fueran los de este.
  { key: 'analytics_refresh_count_variance',    label: 'Refresh MV descuadre de conteos (IC.12)', cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // ⭐⭐ [PR.R1] El ARBITRO DEL COSTO. Sin este umbral el sensor caia en `cfg ? classify : 'ok'`
  // y una MV parada se veia VERDE — y esta no es una MV mas: es la que decide si el margen de
  // toda la Suite es una medicion o un espejo del markup.
  // Medido 2026-09-29 sobre celdas IDENTICAS (90,328 comunes, la venta cuadra al 0.1%): el costo
  // publicado subdeclara 4.26 pp, y el spread del mismo sku entre plazas es 0.0034 pp con el
  // algebra contra 2.957 pp con este arbitro — un margen m/(1+m) NO PUEDE tener spread.
  // Kepler ya es el 79.1% de la venta, asi que la porcion que no puede arbitrar el precio CRECE.
  // ⚠️ El primer REFRESH (400 d) pasa de 300 s: nace WITH NO DATA y su poblado inicial va en
  // ventana, una vez. Lo que se vigila aca es que NO SE QUEDE VIEJA.
  { key: 'analytics_refresh_erp_margin',      label: 'Refresh MV árbitro de costo',       cadence: 'nightly 06:20 MX', warnH: 26, critH: 50 },
  // Internos del API (@Cron NestJS)
  { key: 'analytics_refresh',   label: 'Refresh MVs analytics',      cadence: 'cada 15 min',     warnH: 1,   critH: 3 },
  { key: 'db_health_scan',      label: 'Scanner Salud BD',           cadence: 'cada 5 min',      warnH: 0.5, critH: 2 },
  // [VL.6.2] El vigilante del vigilante. Sin umbral aca, `checkCronRuns` caia en
  // `cfg ? classify : 'ok'` y el dead-man's switch se pintaba verde por viejo que estuviera —
  // o sea que el unico proceso cuyo trabajo es notar que el scanner murio podia morirse primero
  // y en silencio. Su `note` declara ademas si tiene canal externo, que hoy NO tiene.
  { key: 'health_watchdog',     label: 'Watchdog Salud BD (on-prem)', cadence: 'cada 5 min',     warnH: 0.5, critH: 2 },

  // ── [SEG.3] EL TÚNEL, QUE ERA LA ÚNICA PIEZA SIN VIGILANCIA ───────────────────────────────
  // Por `prod-cloudflared` entra TODO el tráfico de usuarios, y el 2026-09-24 estuvo **33 min
  // muerto** con el contenedor en `Up`: última línea 14:32:44, siguiente `Starting tunnel` tras
  // el reinicio manual. En esa misma ventana `ods-live-hot` escribió 441 líneas y `prod-api` 15
  // — el host estaba sano, sólo el túnel no. Por dentro todo respondía y por fuera daba 1033.
  //
  // No lo vio nadie porque no había con qué: la imagen es *distroless* (sin `sh`, sin `curl`),
  // así que no admite `HEALTHCHECK` de Docker, y por eso tampoco lo cubría `ods-autoheal`, que
  // se guía por el estado de salud. El único detector fue una persona.
  //
  // Lo que late acá NO es "el contenedor corre" — es `readyConnections` de su `/ready`: las
  // conexiones REGISTRADAS contra el borde de Cloudflare. Cero conexiones con el contenedor
  // arriba es exactamente el estado del incidente, y es el que `Up` no distingue (ADR-053).
  //
  // Umbrales de carril de 1 min. `critH: 1` porque acá "viejo" significa que el sitio lleva una
  // hora sin entrar — no hay degradación elegante: o hay túnel o no hay sitio.
  { key: 'tunel_cloudflared',   label: 'Túnel Cloudflare (entrada de usuarios)', cadence: 'cada 1 min (md)', warnH: 0.25, critH: 1 },

  // ── [VL.17] EL DESPLIEGUE AUTOMÁTICO, QUE ES UN CARRIL COMO CUALQUIER OTRO ─────────────────
  // Late en CADA pasada, no sólo cuando despliega: `ok` con "al día en <commit>" si no hay nada
  // que hacer, y `error` con el motivo cuando la compuerta de migraciones frena. Esa distinción
  // es el punto — sin ella, "no hay cambios que subir" y "el carril está muerto" se ven idénticos,
  // que es exactamente cómo estuvo el 2026-09-24: script instalado, llave funcionando, corrida a
  // mano perfecta… y `no crontab for superoot`. Nadie lo disparaba y nada lo decía.
  // Umbrales de carril de 5 min, con holgura para una construcción larga: una pasada que
  // construye las dos imágenes tarda varios minutos y `flock -n` saltea la siguiente.
  { key: 'auto_deploy',         label: 'Despliegue automático (origin/main)', cadence: 'cada 5 min (md)', warnH: 1, critH: 6, maxRunH: 1 },

  // ── [VL.20.5] LA HIGIENE DEL DISCO TAMBIÉN ES UN CARRIL ───────────────────────────────────
  // Poda etiquetas de commit viejas y recorta el caché de BuildKit a un techo. Nace de una
  // medición: el 2026-09-24 `md` tenía **80.23 GB de caché de construcción** sin ninguna
  // política de GC y **12 etiquetas** de `api` y 12 de `worker` con la retención puesta en 5 —
  // porque la poda vivía en `deploy.sh` y el camino que despliega 7 veces al día es
  // `auto-deploy.sh`, que nunca la llamaba.
  //
  // ⭐ Sin este renglón el sensor daría **verde incondicional** (`cfg ? classify : 'ok'`), que
  // es el defecto que la Fase VP midió sobre las matvistas del sell-out. Y un carril de higiene
  // es justo donde más engaña: si nadie poda, nada se rompe… hasta que el disco se llena.
  //
  // Corre después de cada despliegue exitoso Y a las 04:30 como red de seguridad. `warnH: 30`
  // porque lo que importa es que haya pasado algo en el último día y pico; `critH: 72` porque
  // tres días sin podar en una máquina que despliega siete veces al día ya es acumulación.
  // El script se pone en `error` solo si tras podar el disco libre queda bajo el piso.
  { key: 'poda_disco',          label: 'Poda de imágenes y caché de construcción', cadence: 'tras cada despliegue + 04:30 (md)', warnH: 30, critH: 72 },

];

export interface SourceHealth {
  group: 'app' | 'source' | 'cron';
  key: string; label: string; table: string; ts_col: string | null;
  last_update: string | null; age_seconds: number | null;
  status: Status; cadence: string; rows: number | null; note?: string;
  // [DH.1] RECURRENCIA — ver `RECURRENCIA` más abajo. Nulo en los grupos que no son carriles.
  runs_7d?: number | null; fails_7d?: number | null;
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

/** `[VL.15.E]` Un renglón de la bitácora `ops.deploys` que escribe `ops/prod/deploy.sh`. */
export interface DeployRow {
  commit_sha: string;
  servicios: string;
  resultado: string;
  migraciones_pendientes: number;
  quien: string | null;
  desde: string | null;
  desplegado_en: string;
}

export interface VersionReport {
  checked_at: string;
  /** Lo que ESTE proceso está sirviendo, leído de la imagen — no de la bitácora. */
  corriendo: { commit: string; uptime_seconds: number };
  /** `false` = la bitácora todavía no existe. Distinto de "existe y está vacía". */
  bitacora_disponible: boolean;
  despliegues: DeployRow[];
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
          const ret = veredictoRetirada(s, last);
          out.push({
            ...base, ts_col: 'dato', last_update: last ? last.toISOString() : null,
            age_seconds: ageSec, status: ret ? ret.status : this.classify(ageSec, s.warnH, s.critH),
            note: ret ? ret.note : (rows[0]?.note_extra as string | undefined),
          });
          continue;
        }
        const tsCol = await this.pickTsCol(schema, table, s.tsCandidates);
        if (!tsCol) { out.push({ ...base, note: 'sin columna de fecha' }); continue; }
        // [DB-MEM.3] El `max()` y el conteo van SEPARADOS, y no por prolijidad.
        //
        // Este sensor corre para 37 fuentes cada 5 minutos. Juntar los dos agregados en una
        // sola consulta obliga a recorrer la tabla entera, aunque el `max()` pueda resolverse
        // por índice. Medido en prod sobre `analytics.stock_movements` (3.7M filas):
        //
        //   SELECT max(imported_at), count(*)   →  923.759 ms   (8,854 buffers)
        //   SELECT max(imported_at)             →    0.049 ms   (5 buffers)   ← Index Only Scan
        //   SELECT count(*)                     →  206.311 ms   (6,573 buffers)
        //
        // Y el conteo **no decide nada**: el veredicto sale de `classify(ageSec, warnH, critH)`,
        // que sólo mira la EDAD. `rows` es informativo, alimenta la columna de la pantalla.
        const { rows } = await this.knex!.raw(
          `SELECT max("${tsCol}") AS last_update FROM ${s.table}`);
        const last = rows[0]?.last_update ? new Date(rows[0].last_update) : null;
        const ageSec = this.ageOf(last);
        const conteo = await this.contarBarato(s.table);
        const ret = veredictoRetirada(s, last);
        out.push({
          ...base, ts_col: tsCol, last_update: last ? last.toISOString() : null,
          age_seconds: ageSec, status: ret ? ret.status : this.classify(ageSec, s.warnH, s.critH),
          rows: conteo.rows,
          note: ret ? ret.note : (conteo.nota ?? base.note),
        });
      } catch (e) {
        this.logger.warn(`db-health app ${s.table}: ${(e as Error).message}`);
        out.push({ ...base, note: 'error al consultar' });
      }
    }
    return out;
  }

  /**
   * [DB-MEM.3] Cuántas filas tiene la tabla, **sin pagar un `count(*)` de la tabla entera cada
   * 5 minutos** para un número que es puramente informativo.
   *
   * Exacto donde es barato (tablas chicas) y **declarado como estimado** donde no (ADR-056: lo
   * que no se midió exacto se declara, no se disfraza de exacto).
   *
   * ⚠️ `reltuples = -1` significa **nunca analizada**, NO vacía. Es el gotcha que este proyecto
   * ya pagó (una auditoría reportó 96 tablas "vacías" que tenían dato). Por eso ese caso
   * devuelve `null` con su motivo, en vez de un cero que se leería como "no llegó nada".
   */
  private async contarBarato(tabla: string): Promise<{ rows: number | null; nota?: string }> {
    const UMBRAL_EXACTO = 100_000;
    try {
      const est = await this.knex!.raw(
        `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass(?)`, [tabla]);
      const n = est.rows[0]?.n != null ? Number(est.rows[0].n) : null;

      if (n == null) return { rows: null, nota: 'sin estadísticas (tabla no encontrada)' };
      if (n < 0) return { rows: null, nota: 'conteo no medido: la tabla nunca fue analizada' };
      if (n < UMBRAL_EXACTO) {
        const ex = await this.knex!.raw(`SELECT count(*)::bigint AS n FROM ${tabla}`);
        return { rows: ex.rows[0]?.n != null ? Number(ex.rows[0].n) : null };
      }
      return { rows: n, nota: `~${n.toLocaleString('es-MX')} filas (estimado)` };
    } catch {
      return { rows: null, nota: 'conteo no medido' };
    }
  }

  // ── Grupo 'source': DBs origen (por env, con timeout corto y en paralelo) ────
  private async checkExtSource(s: ExtCfg): Promise<SourceHealth> {
    const base: SourceHealth = {
      group: 'source', key: s.key, label: s.label, table: s.db, ts_col: null,
      last_update: null, age_seconds: null, status: 'unknown', cadence: s.cadence, rows: null,
    };
    const conn = s.envVars.map((v) => process.env[v]).find(Boolean);
    // [DH.2] La nota nombra al DUEÑO del arreglo. Antes decía sólo "no configurada", y en un
    // tablero donde la sección entera se rotulaba "en prod no alcanza la LAN" eso se leía como
    // "es la red" — que es falso y manda a la persona equivocada. Medido el 2026-09-25 desde
    // `prod-api`: `192.168.0.245:5432` y `192.168.0.222:5433` ALCANZABLES. Lo que falta es la
    // variable, no la ruta.
    if (!conn) {
      return { ...base, note: `APAGADA: falta la variable ${s.envVars.join('/')} en el entorno del API. La red SÍ alcanza (medido); es configuración, no conectividad.` };
    }

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
      // No alcanzable ≠ crítico: la fuente puede estar apagada o el origen fuera de servicio.
      // ⚠️ Este comentario decía "puede ser que este backend (Railway) no ve la LAN" y dejó de
      // ser cierto: desde `[VL.9]` prod corre en `md` (192.168.0.222), DENTRO de la LAN. Medido
      // el 2026-09-25 desde el contenedor `prod-api`: `.245:5432` y `.222:5433` alcanzables,
      // `.35:1433` (ContPAQi) rechaza la conexión. O sea que un fallo acá ya SÍ dice algo del
      // origen, y no se puede seguir excusando con "es que estamos en la nube".
      return { ...base, status: 'unknown', note: `no alcanzable: ${msg}` };
    } finally {
      await c.end().catch(() => {});
    }
  }

  /**
   * [DH.1] LA RECURRENCIA — el tablero deja de olvidar lo que pasó hace diez minutos.
   *
   * ── Qué estaba mal ─────────────────────────────────────────────────────────────────────────
   * `analytics.cron_runs` guarda UNA fila por carril: la ÚLTIMA corrida. El tablero la pintaba y
   * nada más, así que sólo sabía responder *"¿cómo está en este instante?"*. Y un carril que
   * falla y se recupera al ciclo siguiente se ve, en el instante en que alguien mira, **idéntico
   * a uno sano**.
   *
   * Medido contra prod el 2026-09-25, 7 días de `analytics.cron_run_log`:
   *
   *     cdc_reconcile ........................ 109 de 619 corridas FALLARON (17.6 %)
   *       y 103 de esas fallas dicen literalmente
   *       "N filas ausentes en el ODS — el carril esta perdiendo filas"
   *     backup_prod .......................... 3 de 6 (50.0 %)
   *     stock_snapshot ....................... 2 de 3 (66.7 %)
   *
   * `cdc_reconcile` es **la única alarma de completitud del ODS** (`ops/README.md` §2.1). Estaba
   * gritando seis veces por día que se pierden filas, y en el momento de escribir esto la página
   * lo pintaba **verde**, porque la última corrida había salido bien. La detección funcionaba; lo
   * que faltaba era memoria.
   *
   * ── ⛔ Y los PASOS, que no existían en la pantalla ──────────────────────────────────────────
   * `run-prod-feeds.js` marca el carril en `error` **sólo si fallan TODOS sus pasos** (está así a
   * propósito y documentado en `[VL.4]`). Los pasos laten con llave `padre/paso.js` y esa llave
   * **nunca llega a `cron_runs`**: vive sólo en el log. Resultado medido:
   *
   *     feed_nightly/import-cash-cuts.js ................ 6 de 6 FALLARON (100 %)
   *     feed_nightly/import-sales-by-vendor-monthly.js ... 2 de 6  (33 %)
   *     feed_intraday/import-pos-ticket-sales.js ........ 12 de 146 (8.2 %)
   *
   * O sea: el importer de cortes de caja lleva **una semana entera fallando todas las noches** y
   * `feed_nightly` salía `ok`. Por eso la recurrencia del padre **incluye la de sus pasos**: se
   * agregan a su nota y elevan su estado. No se agregan como renglones propios — serían 40 filas
   * más en una página que ya es larga, y el pedido era limpiarla, no engordarla.
   *
   * ── El umbral, y por qué 5 % ────────────────────────────────────────────────────────────────
   * No se eligió a ojo: se corrió la regla contra los 45 carriles que fallaron alguna vez en 7
   * días y se miró **a quién marca**. Con `≥ 2 fallas Y ≥ 5 %` marca siete —los tres de arriba
   * más `cdc_reconcile_full` (11.8 %), `import-pos-ticket-sales` (8.2 %),
   * `import-sales-by-vendor-monthly` (33 %) y `products_active_refresh` (20 %)— y deja callados a
   * `auto_deploy` (4.6 %), `import-replenishment-plan` (4.3 %), `store_poller` (3.7 %),
   * `kepler_sales_fact` (3.3 %) y los 30 restantes por debajo. El piso de **2 fallas** existe para
   * que un carril diario con UN tropiezo (1 de 7 = 14 %) no encienda nada.
   *
   * ⚠️ La recurrencia **sólo puede empeorar** el veredicto, nunca mejorarlo: un carril en
   * `critical` por su última corrida no baja a `warn` porque su semana haya sido buena.
   */
  private static readonly RECURRENCIA = RECURRENCIA;

  /** Fallas por carril en la ventana, incluidas las de sus pasos (`padre/paso.js`). */
  private async recurrencia(): Promise<Map<string, { runs: number; fails: number; pasos: string[] }>> {
    const m = new Map<string, { runs: number; fails: number; pasos: string[] }>();
    try {
      const reg = await this.knex!.raw(`SELECT to_regclass('analytics.cron_run_log') AS t`);
      if (!reg.rows[0]?.t) return m;
      const { rows } = await this.knex!.raw(
        `SELECT job_key,
                count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'error')::int AS fails
           FROM analytics.cron_run_log
          WHERE finished_at > now() - make_interval(days => ?)
          GROUP BY job_key`, [DbHealthService.RECURRENCIA.dias]);
      // Primero los carriles propios; después se les suman los pasos a su padre.
      for (const r of rows) {
        if (String(r.job_key).includes('/')) continue;
        m.set(r.job_key, { runs: Number(r.runs), fails: Number(r.fails), pasos: [] });
      }
      for (const r of rows) {
        const k = String(r.job_key);
        const i = k.indexOf('/');
        if (i < 0) continue;
        const padre = k.slice(0, i);
        const fails = Number(r.fails);
        if (!fails) continue;
        const e = m.get(padre) || { runs: 0, fails: 0, pasos: [] };
        // El paso NO suma a `runs`/`fails` del padre: son universos distintos (un padre corre una
        // vez y lanza N pasos). Se guarda aparte para que la nota lo nombre y el estado suba.
        e.pasos.push(`${k.slice(i + 1)} ${fails}/${r.runs}`);
        m.set(padre, e);
      }
    } catch (e) {
      this.logger.warn(`db-health recurrencia: ${(e as Error).message}`);
    }
    return m;
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
    const hist = await this.recurrencia();
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
      /*
       * `[DBH.5]` ⛔ **Un job REGISTRADO que nunca reportó no es `unknown`: es un job que no
       * está entregando, y hasta hoy era invisible.**
       *
       * `unknown` no cuenta para el `overall` (`getReport()` lo saltea a propósito, y está bien:
       * una fuente no configurada o inalcanzable no debe ensuciar el semáforo). Pero acá se
       * estaba usando para dos cosas distintas, y a una le mentía:
       *
       *   · un job que **nadie declaró** y que apareció solo en `cron_runs` → ése sí es `unknown`;
       *   · un job que **está en `CRON_JOBS`** —o sea, alguien afirmó que debe correr— y que
       *     **nunca escribió una fila**. Eso no es «no sé»: es «lo esperábamos y no llegó».
       *
       * Medido en prod el 2026-09-21: **3 de 44** jobs registrados nunca reportaron —
       * `stock_snapshot` (la foto diaria de inventario, **con latido ya escrito en su código**),
       * `kepler_replica_refresh` y `cxc_snapshot`. Los tres decían «sin reporte aún» y el tablero
       * seguía verde. Es la misma familia del `cfg ? classify : 'ok'` que la Fase VP.0 cazó: la
       * ausencia leyéndose como salud.
       *
       * ⚠️ Es `warn` y no `critical` a propósito: un job recién agregado a `CRON_JOBS` que todavía
       * no cumple su primera cadencia cae legítimamente acá, y un rojo por eso enseñaría a ignorar
       * el tablero. El `warn` dice exactamente lo que se sabe — *se declaró y no ha entregado* — y
       * se apaga solo con el primer latido.
       */
      if (!row) {
        out.push({ ...base, ...veredictoSinLatido(cfg) });
        continue;
      }
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
        //
        // [VP.0.1] Sin `cfg` esto devolvía `'ok'`: un job que late pero no tiene umbral registrado
        // en CRON_JOBS salía VERDE por siempre, sin importar la antigüedad. Es el mismo default
        // permisivo que documenta la regla 1 de `shared/freshness.ts` — un job sin umbral no es
        // sano, es NO MEDIDO. Va a `unknown`, que el tablero pinta distinto de verde y no invita a
        // ignorarlo. Un fallo DURO seguía viéndose (la rama `row.status === 'error'` es previa y no
        // necesita cfg); lo invisible era el REZAGO, que es justo el modo de falla de "los números
        // cambiaron". Medido: `analytics_refresh_kepler`, `_sellout_monthly` y `_blended` escriben
        // latido y no estaban en CRON_JOBS → las tres MVs que arman el sell-out, en verde eterno.
        status = cfg ? this.classify(ageSec, cfg.warnH, cfg.critH) : 'unknown';
        const dur = row.duration_ms != null ? ` · ${Math.round(Number(row.duration_ms) / 1000)}s` : '';
        const filas = row.rows_affected != null ? ` · ${row.rows_affected} filas` : '';
        // La nota decía "OK" SIEMPRE, aunque `status` fuera warn o critical: el job reportó
        // éxito, y el texto repetía ese éxito ignorando que la última corrida era vieja. Así
        // `contpaqi_add_cfdis` pasó 30 h muerto mostrando "OK · 167224 filas" — el número de
        // filas de la corrida vieja, que se lee como salud. La detección funcionaba; el mensaje
        // mentía. Cuando el estado NO es ok, la nota ARRANCA por el rezago, igual que la rama
        // de `running` dice "desde hace X".
        const edad = ageSec != null ? this.humanH(ageSec / 3600) : 'sin fecha';
        if (status === 'ok') {
          note = `OK${dur}${filas}`;
        } else if (status === 'unknown') {
          // [VP.0.1] No decir "SIN CORRER": corrió y terminó bien. Lo que falta es el umbral, y la
          // nota tiene que nombrar eso — es accionable (registrar el job en CRON_JOBS), y confundir
          // "no medido" con "no corrió" manda a alguien a revisar la máquina de feeds sin motivo.
          note = `SIN UMBRAL: el job late (última hace ${edad}${dur}${filas}) pero no está en CRON_JOBS, así que no se puede juzgar su rezago. Registrarlo.`;
        } else {
          note = `SIN CORRER hace ${edad} (cadencia ${cfg?.cadence || '—'}); la última terminó bien${dur}${filas}`;
        }
      }
      // [DH.1] La semana pesa. Sólo puede EMPEORAR el veredicto (ver el comentario de arriba).
      const h = hist.get(key);
      if (h) {
        const { dias } = DbHealthService.RECURRENCIA;
        const { marca, propio, enPasos, pct } = recurrenciaLevantaLaMano(h);
        if (marca) {
          if (RANK['warn'] > RANK[status]) status = 'warn';
          // La recurrencia va ADELANTE de la nota: si va al final, en una celda angosta la tapa
          // justo el texto que dice "OK" y volvemos a donde estábamos.
          const partes: string[] = [];
          if (propio) partes.push(`falló ${h.fails} de ${h.runs} corridas (${pct.toFixed(1)}%) en ${dias} d`);
          if (enPasos) partes.push(`pasos que fallan: ${h.pasos.join(' · ')}`);
          note = `RECURRENTE — ${partes.join(' · ')}${note ? ` | ${note}` : ''}`;
        }
      }
      out.push({
        ...base, last_update: finish ? finish.toISOString() : null, age_seconds: ageSec,
        status, rows: row.rows_affected != null ? Number(row.rows_affected) : null, note,
        runs_7d: h ? h.runs : null, fails_7d: h ? h.fails : null,
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
  /**
   * `[VL.15.E]` **Qué versión corre, mirable sin terminal.**
   *
   * Dos piezas que responden preguntas distintas y por eso van juntas:
   *
   *   `corriendo` — el commit HORNEADO en esta imagen. Es el mismo que sirve `/api/health`, y
   *     se lee del proceso, no de la bitácora: si alguien levantó un contenedor por fuera de
   *     `deploy.sh`, la bitácora no se entera y esto **sí**. La verdad es lo que está en
   *     memoria, no lo que alguien anotó.
   *
   *   `despliegues` — la bitácora `ops.deploys` que escribe `deploy.sh`: quién, cuándo, qué
   *     servicios, con cuántas migraciones pendientes, y **también los que fallaron** — que son
   *     los que uno quiere leer cuando algo no cuadra.
   *
   * ⚠️ Si las dos no coinciden, el renglón de arriba manda y hay que sospechar de un
   * `docker compose up` a mano. Por eso se devuelven las dos y no una sola "versión".
   *
   * La tabla puede no existir todavía (se auto-crea en el primer despliegue): eso se DECLARA
   * con `bitacora_disponible: false`, no se disfraza de lista vacía — que se leería como
   * "nunca se desplegó nada", que es otra cosa.
   */
  async getVersionReport(): Promise<VersionReport> {
    const base: VersionReport = {
      checked_at: new Date().toISOString(),
      corriendo: { commit: commitDelBuild(), uptime_seconds: Math.floor(process.uptime()) },
      bitacora_disponible: false,
      despliegues: [],
    };
    if (!this.knex) return base;
    try {
      const { rows } = await this.knex.raw(
        `SELECT commit_sha, servicios, resultado, migraciones_pendientes, quien, desde,
                desplegado_en
           FROM ops.deploys ORDER BY id DESC LIMIT 20`);
      return {
        ...base,
        bitacora_disponible: true,
        despliegues: rows.map((r: Record<string, unknown>) => ({
          commit_sha: String(r.commit_sha),
          servicios: String(r.servicios),
          resultado: String(r.resultado),
          migraciones_pendientes: Number(r.migraciones_pendientes ?? 0),
          quien: r.quien ? String(r.quien) : null,
          desde: r.desde ? String(r.desde) : null,
          desplegado_en: new Date(r.desplegado_en as string).toISOString(),
        })),
      };
    } catch {
      // `ops.deploys` todavía no existe (o no se pudo leer). Se declara, no se inventa.
      return base;
    }
  }

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
