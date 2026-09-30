import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN } from '@megadulces/platform-core';

/**
 * Refresh de materialized views de `analytics.*`. Requiere conexión admin
 * (postgres user) porque sólo el owner puede hacer REFRESH MATERIALIZED VIEW.
 *
 * Estrategia: `REFRESH MATERIALIZED VIEW CONCURRENTLY` por MV. CONCURRENTLY
 * permite que las lecturas no se bloqueen durante el refresh. Requiere UNIQUE
 * INDEX en cada MV (ya creado en la migración).
 *
 * Schedule: cada 15 min ('*\/15 * * * *'). En testdata-scale el refresh tarda
 * ms. Cuando crezca, considerar:
 *   - Aumentar intervalo a 30-60 min
 *   - Refresh asíncrono con job queue (BullMQ) en lugar de blocking cron
 *   - Refresh disparado por eventos ('order:fulfilled' → invalidar)
 */

/**
 * MVs a refrescar. `requires_fdw=true` significa que el SELECT joinea con
 * `analytics_external.*` (postgres_fdw → 192.168.0.245). Esos refresh se
 * skippean automáticamente si el FDW no es alcanzable, sin reintentar 15min
 * más tarde y sin spamear el log.
 */
const MVS: Array<{ name: string; requires_fdw?: boolean; everyMin?: number }> = [
  // `[MR.8.5]` (mig 20260929130000) Copia materializada de `analytics.v_erp_unit_cost`, sin un
  // cambio de lógica. La vista enumera el cartesiano completo (180,384 filas / 161,147 buffers)
  // y cuesta **~1.25 s por pase** — que `/comercial/rentabilidad` pagaba en CADA consulta, y el
  // desglose tres veces. Poblarla es un solo pase de la vista (~968 ms), así que entra al array
  // de 15 min sin `everyMin`: es barata y el costo unitario sí se mueve en el día (recepciones).
  { name: 'analytics.mv_erp_unit_cost' },
  { name: 'analytics.mv_sales_overview_30d' },
  { name: 'analytics.mv_top_customers_30d' },
  { name: 'analytics.mv_top_products_30d' },
  { name: 'public.products_top_sellers', requires_fdw: true },
  // PERF (mig 20260831150000): momentum r30/r90 para ThotService.suggest(). Antes se
  // agregaba 90d de sales_daily en vivo por request (~1.4 s); ahora es un join al matview.
  //
  // [DB-MEM.5] `everyMin: 120` — **el refresh más caro de este array, y el que menos lo necesita.**
  // Medido en prod con `pg_stat_statements`: **65.7 s por REFRESH**. A 15 min son 96 corridas/día
  // = **~1.75 h/día de CPU** para materializar 5,935 filas / 1.7 MB. Y lo que calcula son ventanas
  // **r30/r90**: en 15 minutos una media de 30 días no se mueve de forma que alguien pueda notar.
  // A 2 h son 12 corridas/día (~13 min) — mismo dato para quien lo lee, ~1.5 h/día menos de CPU.
  { name: 'analytics.mv_product_momentum', everyMin: 120 },
  // PERF (mig 20260831160000): ventas del mes en curso pre-agregadas para el path diario
  // de sellOut (mes en curso nunca es month-aligned → escaneaba 111k filas + sort-a-disco).
  { name: 'analytics.mv_sales_current_month' },
  // Regla ⭐ (mig 20260903130000): postings del 102 = matview derive-no-copy sobre kepler_ods.kdc2YYMM
  // (reemplazó import-bank-postings.js). Fan-out mensual = ~1.1 s en REFRESH; lectura indexada = 15 ms.
  { name: 'analytics.bank_postings' },
  // `[CDRP.4-perf]` (mig 20260921220000) Venta diaria por ruta, ventana de 200 d. La lee el bloque
  // de zonas de «Mi trabajo»: `v_rd_route_daily` es vista-sobre-vista y sus TRES toques costaban
  // **11.3 de los 12.4 s** de la portada de Dirección.
  //
  // `everyMin: 30` medido, no elegido de oído: el `REFRESH CONCURRENTLY` tarda **16 s** (la ventana
  // de 200 d cuesta ~127M buffers; la historia completa 568M y sólo habría alcanzado para nocturno).
  // A 30 min son 48 corridas/día ≈ 13 min de CPU, y el dato de HOY está — que es el punto: una
  // matview nocturna le sacaría el día en curso justo a quien más lo mira.
  { name: 'analytics.mv_rd_route_daily_200d', everyMin: 30 },
  // `[CDRP.4-perf]` (mig 20260922000000) La otra pierna de la misma portada: venta por
  // almacén × canal × día. `sales_daily` está al grano de PRODUCTO y el bloque sumaba 249,389
  // filas por carga; **1,124,926 filas de 200 d colapsan a 4,447** (253×).
  // `REFRESH CONCURRENTLY` medido: **2 s** — ocho veces más barato que el de rutas, así que la
  // cadencia de 30 min le sobra.
  { name: 'analytics.mv_sales_daily_wh_200d', everyMin: 30 },
  // `[CPU.2]` El resolvedor de unidad (ADR-057). Estaba SÓLO en el grupo nocturno, y eso dejaba de
  // ser tolerable el día que sus consumidores pasaron de la vista viva a esta copia: publicar el
  // factor de caja de anoche cuando antes era en vivo sería cambiar CPU por una mentira chica.
  //
  // `everyMin: 30` medido, no elegido de oído: el `REFRESH CONCURRENTLY` tarda **9.0 s** (106 MB,
  // 180,272 filas, con UNIQUE sobre (tenant, almacén, producto) → no bloquea lecturas). A 30 min
  // son 48 corridas/día ≈ 7 min de CPU, contra los **9,694 s en 21 h** que costaba que tres
  // pantallas derivaran la vista viva 6,242 veces. Se paga 1 para no pagar 1,300.
  //
  // El hueco que cierra, medido el 2026-09-25 comparando copia contra vista tras ~6 h de rezago:
  // las LLAVES eran idénticas (180,272 = 180,272) y `box_factor`/`metodo_cajas`/`base_label`/
  // `is_weight` no tenían NI UNA diferencia; el que se movía era **`cja_price`, 32 filas**. O sea
  // que el rezago no rompía las conversiones, movía precios de caja — chico, pero es dinero, y es
  // justo la clase de diferencia que nadie va a notar mirando la pantalla.
  //
  // ⚠️ SIGUE ADEMÁS EN EL GRUPO NOCTURNO, a propósito y no por olvido. Su latido dedicado
  // (`analytics_refresh_unit_truth`, umbral registrado en `CRON_JOBS`) lo escribe el loop nocturno,
  // que es el único que lleva una llave POR MV; este array escribe UN latido agregado
  // (`analytics_refresh`) para todo el grupo. Sacarla de allá dejaría esa llave registrada y sin
  // nadie que la escriba = rojo permanente, que entrena a ignorar el tablero igual que un verde
  // falso. El precio de dejarla en los dos lados es UN refresco redundante de 9 s al día.
  { name: 'analytics.mv_unit_truth', everyMin: 30 },
  // NOTA: analytics.mv_wincaja_sales_daily NO va en este array de 15 min. Se alimenta de una carga
  // Access→Postgres que aterriza ~05:00 MX una vez al día (el resto del histórico está congelado) →
  // se refresca NIGHTLY en refreshWincajaDaily() (06:20 MX, tras la carga). Refrescarlo cada 15 min
  // era puro desperdicio y devolvía la contención del pool admin (0-2) → 2.6 min por request de sell-out.
];

@Injectable()
export class AnalyticsRefreshService {
  private readonly logger = new Logger(AnalyticsRefreshService.name);
  private isRefreshing = false;
  /**
   * Cache TTL para el check de salud del FDW. Si una vez falla, no volvemos
   * a probar hasta 30 min después — sino cada cron tick (15 min) ata una
   * conexión esperando timeout al FDW caído.
   */
  private fdwUnhealthyUntil: number = 0;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
  ) {}

  /**
   * Cron task: refresh cada 15 min en :00, :15, :30, :45.
   * Si una corrida sigue activa cuando la siguiente arranca, skip (flag isRefreshing).
   */
  @Cron('0 */15 * * * *')
  async scheduledRefresh(): Promise<void> {
    if (!this.adminKnex) {
      this.logger.debug('Skip scheduledRefresh: KNEX_NEW_DB_ADMIN no disponible');
      return;
    }
    if (this.isRefreshing) {
      this.logger.warn('Skip scheduledRefresh: corrida anterior aún activa');
      return;
    }
    await this.refreshAll('cron');
  }

  /**
   * PASO 3 (mig 20260901160000) — refresh del rollup diario de wincaja
   * (`analytics.mv_wincaja_sales_daily`, all-history). Va aparte del cron de 15 min y corre UNA vez al
   * día porque wincaja se alimenta por una carga Access→Postgres que aterriza ~05:00 MX (medido: las
   * 3 sucursales vivas 00/30/32 cargaron 05:01–05:06); el resto del histórico está congelado. Refrescar
   * cada 15 min era puro desperdicio y devolvía la contención del pool admin (0-2) que causaba los
   * 2.6 min por request de sell-out.
   *
   * 06:20 MX: DESPUÉS de la carga (~05:06) con margen, y off del borde de 15 min (:00/:15/:30/:45) para
   * no competir por el pool admin con el otro cron. El contenedor ya corre en America/Mexico_City → sin
   * `timeZone`. REFRESH CONCURRENTLY (no bloquea las lecturas de sellOut) + ANALYZE (grano fino → el
   * planner necesita stats frescas o elige un plan catastrófico). No es FDW → sin el gate de FDW del loop.
   */
  @Cron('0 20 6 * * *')
  async refreshWincajaDaily(): Promise<void> {
    const admin = this.adminKnex;
    if (!admin) {
      this.logger.debug('Skip refreshWincajaDaily: KNEX_NEW_DB_ADMIN no disponible');
      return;
    }
    // Rollups diarios de venta DERIVADOS de las fuentes crudas (sin RLS): wincaja (carga Access→PG
    // ~05:00) + kepler (mv_kepler desde kepler_ods, live CDC) + el BLEND consolidado (mv_sales_blended,
    // deriva de los dos anteriores → va AL FINAL para tomarlos ya frescos). Nightly basta: el sell-out
    // no es tiempo-real y antes ya era diario vía el importer. Heartbeat propio por MV.
    // [VP.1.3] `deps` = de qué MV deriva ésta. El orden ya estaba bien pensado, pero el `try/catch`
    // por MV lo dejaba sin efecto: si fallaba `mv_kepler_sales_daily`, el rollup se materializaba
    // IGUAL sobre `v_sellout_daily`, que hace UNION de la pierna Kepler (ahora rancia) con la de
    // Wincaja (fresca). Quedaba un rollup construido a medias, indistinguible de uno sano — y
    // después `REFRESH CONCURRENTLY` sobre el siguiente lo consolida. Ordenar no es depender.
    const fallidas = new Set<string>();
    for (const [mv, jobKey, label, deps] of [
      ['analytics.mv_wincaja_sales_daily', 'analytics_refresh_wincaja', 'Refresh MV wincaja (nightly)', []],
      ['analytics.mv_kepler_sales_daily', 'analytics_refresh_kepler', 'Refresh MV kepler (nightly)', []],
      // Rollup mensual del sell-out (deriva de v_sellout_daily → de los dos anteriores) → va DESPUÉS de ellos.
      ['analytics.mv_sellout_monthly', 'analytics_refresh_sellout_monthly', 'Refresh MV sell-out mensual (nightly)',
        ['analytics.mv_wincaja_sales_daily', 'analytics.mv_kepler_sales_daily']],
      // ⚠️ EL POBLADO INICIAL DE ESTA MV CUESTA 6 h 15 min. El refresco diario NO.
      //
      // Medido el 2026-09-23/24, y la distinción importa porque yo mismo la confundí primero y
      // dejé escrita acá la conclusión equivocada ("no cabe en la ventana nocturna"):
      //
      //   · `REFRESH` PLANO desde VACÍA ... **6 h 15 min** (20:23 → 02:38), 4,584,247 filas.
      //     Es el camino que toma el loop cuando `relispopulated` es falso, o sea después de un
      //     `CREATE MATERIALIZED VIEW … WITH NO DATA`. Se paga UNA vez.
      //   · `REFRESH CONCURRENTLY` nocturno ... cierra `ok`. El historial de
      //     `analytics.cron_run_log` lo tiene bien los días 13, 14, 16, 17, 18, 19, 20, 21, 22
      //     y 24 de septiembre. **Faltó UNO: el 23** — el día del corte de producción a `md`.
      //
      // ⛔ Lo que parecía una espiral de fallos era un solo día perdido. Un latido de 37 h se
      //   lee igual que "lleva días sin cerrar", y no es lo mismo.
      //
      // ⚠️ Y NO SE SABE cuánto tarda el nocturno: el latido escribe `started_at` y `finished_at`
      //   con el MISMO `now()` al terminar, así que `cron_run_log` muestra `0.0 min` para todas
      //   las corridas. Eso no es una medición de cero, es la AUSENCIA de medición — y hace
      //   invisible que un refresco se esté degradando. Deuda con nombre: el latido tiene que
      //   marcar el inicio al arrancar, no al cerrar.
      //
      // Dónde está el costo del poblado, para cuando haya que tocarlo: el `LEFT JOIN` por CINCO
      // columnas contra `analytics.v_kepler_ticket_count`, que **no es matvista sino VISTA** —
      // se recalcula entera leyendo el ODS crudo con operadores de expresión regular, contra las
      // 791,548 filas de `mv_kepler_sales_daily`. Y la MV guarda TODA la historia (4.58 M filas,
      // 2025 + 2026), de la que sólo el **1.14 %** cambia en una semana.
      ['analytics.mv_sales_blended', 'analytics_refresh_blended', 'Refresh MV blend consolidado (nightly)',
        ['analytics.mv_wincaja_sales_daily', 'analytics.mv_kepler_sales_daily']],
      // [KX.5] El PELDAÑO COBRADO por sucursal × SKU (max `kdm2.c58`, ventana 365 d). No deriva de
      // ninguna otra MV: sale directo del ODS, así que `deps` va vacío. Se materializa por COSTO
      // (~38 s de agregación sobre 4M renglones) porque no puede vivir dentro de
      // `v_warehouse_box_factor`, que la leen la existencia, compras y el sell-out.
      // ⚠️ Su umbral está registrado en `CRON_JOBS` (`analytics_refresh_sold_rung`): sin eso el
      // sensor cae en `cfg ? classify : 'ok'` y una MV parada se vería VERDE (lección OBS.1).
      ['analytics.mv_kepler_sold_rung', 'analytics_refresh_sold_rung', 'Refresh MV peldaño cobrado (nightly)', []],
      // [IC.10] Roll-forward entre conteos fisicos: lo contado antes + entradas - salidas contra
      // lo contado despues. `deps` vacio: sale directo del ODS, no de otra MV.
      //
      // ⛔ Va ACA y no en el array de 15 min por dos razones medidas. La primera es el costo:
      // el poblado inicial tardo **292.9 s**, y el pool admin es 0-2 -- ocuparlo cinco minutos
      // en horario habil es lo que ya devolvio 2.6 min por request de sell-out una vez. La
      // segunda es que NO HACE FALTA mas seguido: sus pares son conteo-a-conteo CERRADOS, y
      // Kepler cuenta cada tres meses. Un refresco diario ya es holgado.
      //
      // ⚠️ Su umbral esta registrado en `CRON_JOBS` (`analytics_refresh_count_rollforward`).
      // Sin esa fila el sensor cae en `cfg ? classify : 'ok'` y una MV parada se ve VERDE --
      // y esta MV parada es peor que la mayoria: la pantalla de Conciliacion seguiria
      // mostrando la merma del trimestre pasado como si fuera la de este.
      ['analytics.mv_erp_count_rollforward', 'analytics_refresh_count_rollforward',
        'Refresh MV roll-forward de conteos (nightly)', []],
      // [IC.12] El descuadre del conteo físico + el peldaño del costo declarado. `deps` vacío:
      // sale de `v_erp_physical_count_variance` (vista, no MV) y del ODS.
      //
      // ⛔ Va en el lote NOCTURNO por las dos razones medidas: el poblado cuesta **92 s** (el CTE
      // del testigo recorre todos los `N-A-45` de la historia) y el pool admin es 0-2; y no hace
      // falta más seguido, porque Kepler emite un conteo cada TRES MESES.
      //
      // ⚠️ Su umbral está en `CRON_JOBS` (`analytics_refresh_count_variance`). Sin esa fila el
      // sensor cae en `cfg ? classify : 'ok'` y una MV parada se ve VERDE (OBS.1). Y acá la MV
      // parada no vacía la pantalla: la deja publicando el descuadre del trimestre anterior.
      ['analytics.mv_erp_physical_count_variance', 'analytics_refresh_count_variance',
        'Refresh MV descuadre de conteos (nightly)', []],
      // [WMS-BI.4.3] Copia cacheada del resolvedor de unidad (`analytics.v_unit_truth`, ADR-057).
      // `deps` vacío a propósito: NO deriva de otra MV, sale de la vista canónica, que a su vez
      // sale del ODS. Se materializa por COSTO: medido con EXPLAIN contra prod, el join vivo
      // descartaba 8,981,845 filas para devolver 50 en /almacen/analisis-bi (1,420 ms → 170 ms
      // sobre la ventana de 30 d). La MV es `SELECT *` de la vista: una copia, no una segunda
      // definición.
      // ⚠️ Su umbral está registrado en `CRON_JOBS` (`analytics_refresh_unit_truth`): sin eso el
      // sensor cae en `cfg ? classify : 'ok'` y una MV parada se ve VERDE (lección OBS.1). Y acá
      // no es cosmético: cuando envejece, un producto cuya unidad base cambió sigue publicándose
      // con la anterior, y la unidad es justo lo que ADR-057 existe para no adivinar.
      ['analytics.mv_unit_truth', 'analytics_refresh_unit_truth', 'Refresh MV verdad de unidad (nightly)', []],
      // [SD-PAY] Condición de pago (credito/contado) por canal. `deps` vacío: deriva directo del ODS
      // (kdm1 header total c16 + kdud días c16). Aditiva — no la lee el linaje principal. ⚠️ Su umbral
      // vive en `CRON_JOBS` (`analytics_refresh_payment_terms`): sin eso el sensor cae en `cfg ? classify : 'ok'`
      // y una MV parada se ve VERDE (OBS.1) — y acá el crédito vencido depende de que esté fresca.
      ['analytics.mv_sales_payment_terms', 'analytics_refresh_payment_terms', 'Refresh MV condición de pago (nightly)', []],
      // [CE.0] Actividad de venta (impuesto observado + unidades BASE) que pesa el costo estándar.
      // `deps` vacío: sale directo del ODS. Se materializa por COSTO — `kdm2` son 4.7M filas /
      // 2.16 GB SIN índice por fecha, y agregar 30 días cuesta 3.5 s medidos contra el gate de 1 s.
      // ⚠️ Su umbral vive en `CRON_JOBS` (`analytics_refresh_standard_cost`): sin eso el sensor cae
      // en `cfg ? classify : 'ok'` y una MV parada se ve VERDE (OBS.1). Y acá no es cosmético: la
      // ventana de la MV ES la ventana que la pantalla rotula «30 días».
      ['analytics.mv_kepler_standard_cost_activity', 'analytics_refresh_standard_cost', 'Refresh MV actividad del costo estándar (nightly)', []],
      /**
       * ⭐⭐ `[PR.R1]` EL ÁRBITRO DEL COSTO. La MV que decide si el margen de toda la Suite
       * es una medición o un espejo del markup.
       *
       * ⛔ Se aplicó el 2026-09-29 (`20260929120000_mv_erp_margin_daily.js`) y **quedó fuera de
       * este array**. Medido ese mismo día: `relispopulated = false` — creada `WITH NO DATA` y
       * **sin ningún carril que la llenara nunca**. Correr el primer `REFRESH` a mano no
       * alcanzaba: sin esta línea se quedaba vieja para siempre.
       *
       * Por qué importa, medido sobre celdas IDÉNTICAS (90,328 comunes, la venta cuadra al 0.1%):
       *   · el costo publicado subdeclara el margen **4.26 pp**
       *   · spread del MISMO sku entre plazas: **0.0034 pp** con el álgebra contra **2.957 pp**
       *     con este árbitro — un margen `m/(1+m)` NO PUEDE tener spread, por construcción
       *   · y Kepler pasó de 12.7 % de la venta en enero a **79.1 % en septiembre**: la porción
       *     que no puede arbitrar el precio CRECE cada mes
       *
       * `deps` vacío: sale directo del ODS, no deriva de otra MV.
       *
       * ⚠️ El PRIMER refresh NO cabe en un timeout corto — medido en su propia migración:
       * 30 d = 20.1 s · 90 d = 47.1 s · 180 d = 74.3 s · **400 d > 300 s** (crece superlineal).
       * Nace `WITH NO DATA`, así que el loop la detecta por `relispopulated` y hace el poblado
       * inicial SIN `CONCURRENTLY`. Ese primero va en ventana, una vez.
       *
       * ⚠️ Su umbral va en `CRON_JOBS` (`analytics_refresh_erp_margin`) o el sensor cae en
       * `cfg ? classify : 'ok'` y una MV parada se ve **VERDE** (OBS.1, la lección que este
       * archivo ya documenta tres veces).
       */
      ['analytics.mv_erp_margin_daily', 'analytics_refresh_erp_margin', 'Refresh MV árbitro de costo (nightly)', []],
    ] as const) {
      const start = Date.now();
      let ok = false;
      let errMsg: string | null = null;
      try {
        const rotas = deps.filter((d) => fallidas.has(d));
        if (rotas.length) {
          // NO se refresca: mejor servir el rollup de ayer —viejo pero COHERENTE, y su latido lo
          // declara— que uno de hoy mezclando una pierna de ayer con otra de hoy. La frescura se
          // declara (VP.0.3); la incoherencia no se ve.
          throw new Error(`dependencia sin refrescar: ${rotas.join(', ')} — se omite para no mezclar piernas`);
        }
        const found = (
          await admin.raw(`SELECT relkind, relispopulated FROM pg_class WHERE oid = ?::regclass`, [mv])
        ).rows;
        if (!found.length || found[0].relkind !== 'm') {
          // [VP.1.3] Antes acá había un `continue` que saltaba ANTES del latido: una MV borrada o
          // renombrada no dejaba fila en `cron_runs` y sólo rastro en nivel `debug`. Ni error ni
          // latido: silencio, que en el tablero se lee igual que "nunca corrió". Se trata como falla.
          throw new Error(`no es materialized view (relkind=${found.length ? found[0].relkind : 'missing'})`);
        }
        const concurrently = found[0].relispopulated ? 'CONCURRENTLY ' : '';
        await admin.raw(`REFRESH MATERIALIZED VIEW ${concurrently}${mv}`);
        await admin.raw(`ANALYZE ${mv}`);
        ok = true;
        this.logger.log(
          `Refreshed ${mv} (${Date.now() - start}ms, source=cron-nightly${concurrently ? '' : ', initial populate'})`,
        );
      } catch (e: any) {
        errMsg = e.message || String(e);
        fallidas.add(mv); // lo que dependa de ésta no se refresca sobre datos a medias
        this.logger.error(`Refresh ${mv} (nightly) failed: ${errMsg}`);
      }
      // Heartbeat → Salud BD (grupo Crons), job propio para no pisar el del cron de 15 min.
      try {
        const MEGA = '00000000-0000-0000-0000-00000000d01c';
        await admin('analytics.cron_runs')
          .insert({
            tenant_id: MEGA, job_key: jobKey, label,
            /**
             * ⛔ [PR.R0] `last_start` ERA `now()` — el MISMO instante que `last_finish`.
             *
             * El comentario de abajo cuenta que se arregló que `last_start` **se actualizara**
             * (antes quedaba congelado en la 1ª corrida). Pero se arregló estampándolo con
             * `now()` AL CERRAR, así que quedó **fresco y sin significado**: `last_finish −
             * last_start = 0` para todas las corridas, y `duration_ms` nunca se escribía.
             *
             * Medido contra prod el 2026-09-29: **14 de 52 jobs con `duration_ms = NULL`**, y son
             * exactamente los `analytics_refresh_*` de este archivo. O sea que **la duración de la
             * ventana nocturna NUNCA se midió** — y es la ventana donde va a entrar el panel de
             * precios. Agregarle carga sin medirla es cómo las 03:00 se vuelven las 09:00.
             *
             * ⭐ La lección: que una columna de reloj se ACTUALICE no es lo mismo que que MIDA.
             */
            last_start: new Date(start), last_finish: admin.fn.now(),
            duration_ms: Date.now() - start,
            status: ok ? 'ok' : 'error', rows_affected: ok ? 1 : 0,
            error: errMsg ? errMsg.slice(0, 500) : null, host: 'api', updated_at: admin.fn.now(),
          })
          .onConflict(['tenant_id', 'job_key'])
          // ⚠️ `last_start` VA en el merge. Sin él sólo se escribe en el INSERT y queda congelado en
          // la fecha de la primera corrida: medido el 2026-09-12, este job y `db_health_scan`
          // mostraban `last_start = 2026-07-31` con `last_finish` de ese mismo día — seis semanas de
          // "muerto" en un cron que corría cada 15 min. Un tablero (o un auditor) que ordene por
          // `last_start` reporta un falso positivo; acá pasó.
          .merge(['label', 'last_start', 'last_finish', 'duration_ms', 'status', 'rows_affected',
            'error', 'host', 'updated_at']);
      } catch { /* heartbeat no debe romper el refresh */ }
    }
  }

  /**
   * Refresh manual disparado por endpoint. Devuelve resultado por MV.
   */
  async refreshAll(source: 'cron' | 'manual' = 'manual'): Promise<{
    refreshed_at: string;
    results: Array<{ mv: string; ok: boolean; ms?: number; error?: string }>;
  }> {
    if (!this.adminKnex) {
      throw new Error(
        'KNEX_NEW_DB_ADMIN no disponible (DATABASE_URL_NEW no seteado en env). No se puede refrescar analytics.*',
      );
    }
    this.isRefreshing = true;
    const results: Array<{ mv: string; ok: boolean; ms?: number; error?: string; skipped?: boolean }> = [];
    const now = Date.now();
    // El MV de wincaja NO va en el cron de 15 min (MVS) pero SÍ en el refresh MANUAL, para que el botón
    // "Refresh" lo pueble on-demand — p.ej. la 1ª vez tras aplicar la migración (nace WITH NO DATA) sin
    // esperar al cron nocturno de 06:20. El loop ya maneja WITH NO DATA (REFRESH inicial no-CONCURRENTLY).
    type MvEntry = { name: string; requires_fdw?: boolean; everyMin?: number };
    const list: MvEntry[] = source === 'manual'
      ? [...MVS,
         { name: 'analytics.mv_wincaja_sales_daily' },
         { name: 'analytics.mv_kepler_sales_daily' },
         { name: 'analytics.mv_sellout_monthly' },
         { name: 'analytics.mv_sales_blended' }]
      : MVS;
    try {
      for (const entry of list) {
        const mv = entry.name;

        // [DB-MEM.5] Cadencia propia. El cron dispara cada 15 min; una MV con `everyMin` sólo se
        // refresca en los ticks que le tocan. Se mide contra el minuto del DÍA (no del reloj de
        // pared del proceso) para que el patrón sea estable entre reinicios: con `everyMin: 120`
        // toca en :00 de las horas pares, siempre las mismas.
        // ⚠️ El refresh MANUAL ignora esto a propósito: el botón está para forzar, y quien lo
        // aprieta espera ver su dato actualizado, no una explicación de cadencias.
        if (source !== 'manual' && entry.everyMin && entry.everyMin > 15) {
          const d = new Date();
          const minutoDelDia = d.getHours() * 60 + d.getMinutes();
          if (minutoDelDia % entry.everyMin >= 15) {
            this.logger.debug(`Skip ${mv}: cadencia propia de ${entry.everyMin} min`);
            results.push({ mv, ok: true, skipped: true });
            continue;
          }
        }

        // FDW health gate: si una corrida previa marcó el FDW como caído,
        // saltamos las MVs que lo requieren hasta que pase la ventana.
        if (entry.requires_fdw && this.fdwUnhealthyUntil > now) {
          const minutesLeft = Math.ceil((this.fdwUnhealthyUntil - now) / 60_000);
          this.logger.debug(
            `Skip ${mv}: FDW marcado unhealthy hasta hace ${minutesLeft} min restantes`,
          );
          results.push({ mv, ok: false, skipped: true, error: 'fdw_unhealthy' });
          continue;
        }

        const start = Date.now();
        try {
          // relkind: solo 'm' (materialized view) es refrescable. En prod el
          // hotfix convirtió catalog.products_top_sellers en TABLA + public.* en
          // VIEW normal (sincronizadas manualmente desde el ERP). Refrescar una
          // vista/tabla tira "is not a table or materialized view". Si no es MV,
          // saltamos sin error: su data llega por sync externo, no por REFRESH.
          // relispopulated: CONCURRENTLY exige que la MV ya esté poblada al menos
          // una vez (WITH NO DATA → false). Si no, REFRESH normal primero.
          const found = (
            await this.adminKnex.raw(
              `SELECT relkind, relispopulated FROM pg_class WHERE oid = ?::regclass`,
              [mv],
            )
          ).rows;
          if (!found.length || found[0].relkind !== 'm') {
            const kind = found.length ? found[0].relkind : 'missing';
            this.logger.debug(
              `Skip ${mv}: no es materialized view (relkind=${kind}) — data por sync externo, no por REFRESH.`,
            );
            results.push({ mv, ok: true, skipped: true });
            continue;
          }
          const concurrently = found[0].relispopulated ? 'CONCURRENTLY ' : '';
          await this.adminKnex.raw(
            `REFRESH MATERIALIZED VIEW ${concurrently}${mv}`,
          );
          // ANALYZE post-refresh: REFRESH reemplaza los datos pero no actualiza las stats del
          // planner. En MVs de grano fino (p.ej. mv_wincaja_sales_daily ~99k filas/mes) sin stats
          // frescas el planner elige un plan catastrófico al leerlas (verificado: timeout vs 739ms
          // con ANALYZE). Barato para las MVs chicas; `mv` sale de MVS (no user input).
          await this.adminKnex.raw(`ANALYZE ${mv}`);
          const ms = Date.now() - start;
          this.logger.log(
            `Refreshed ${mv} (${ms}ms, source=${source}${concurrently ? '' : ', initial populate'})`,
          );
          results.push({ mv, ok: true, ms });
        } catch (e: any) {
          const msg = e.message || String(e);
          // Detectar fallos del FDW para marcar unhealthy y no reintentar
          // cada 15 min (sino cada tick ata una conexión esperando timeout).
          const isFdwDown =
            entry.requires_fdw &&
            /could not connect to server|connection to server.*failed|no route to host|ETIMEDOUT/i.test(
              msg,
            );
          if (isFdwDown) {
            this.fdwUnhealthyUntil = Date.now() + 30 * 60_000;
            this.logger.warn(
              `Refresh ${mv} skip: FDW unreachable. No reintentaremos por 30 min. (${msg.slice(0, 120)})`,
            );
          } else {
            this.logger.error(`Refresh ${mv} failed: ${msg}`);
          }
          results.push({ mv, ok: false, error: msg });
        }
      }
    } finally {
      this.isRefreshing = false;
    }
    // Heartbeat → Salud BD (grupo Crons). error si alguna MV real falló (no skip).
    try {
      const failed = results.filter((r) => !r.ok && !r.skipped);
      const ok = results.filter((r) => r.ok && !r.skipped).length;
      const MEGA = '00000000-0000-0000-0000-00000000d01c';
      await this.adminKnex!('analytics.cron_runs')
        .insert({
          tenant_id: MEGA, job_key: 'analytics_refresh', label: 'Refresh MVs analytics',
          // [PR.R0] mismo arreglo que el latido nocturno: `now` es el arranque REAL de la pasada.
          last_start: new Date(now), last_finish: this.adminKnex!.fn.now(),
          duration_ms: Date.now() - now,
          status: failed.length ? 'error' : 'ok', rows_affected: ok,
          error: failed.length ? failed.map((f) => f.mv).join(', ').slice(0, 500) : null,
          host: 'api', updated_at: this.adminKnex!.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        // ⚠️ `last_start` VA en el merge — ver la nota del otro heartbeat de este archivo.
        .merge(['label', 'last_start', 'last_finish', 'duration_ms', 'status', 'rows_affected',
          'error', 'host', 'updated_at']);
    } catch { /* heartbeat no debe romper el refresh */ }
    return { refreshed_at: new Date().toISOString(), results };
  }
}
