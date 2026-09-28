/* eslint-disable no-console */
/**
 * `[AUD-DAT.1]` — El hecho de venta que lee una pantalla **no puede dejarse sucursales afuera**.
 *
 * ── DE DÓNDE SALE ESTE CANDADO ──────────────────────────────────────────────────────────────
 * De una auditoría de la capa de datos (2026-09-28). `analytics.sales_daily` cubre **6 de las 8
 * sucursales** — y no es un bug: su importer lo declara en la primera línea (*"Fuente:
 * mart.ventas_enriched (consolidación on-prem, **6 sucursales**)"*). Morelia Madero (07) y Morelia
 * Abastos (08) estuvieron en Wincaja hasta su corte a Kepler, así que el fact las tiene **desde el
 * día del corte, no antes** (`analytics.v_branch_erp_cutover`: 2026-09-08 y 2026-09-19).
 *
 * Lo que faltaba era que ese alcance VIAJARA con el número. `[PU.2]`/`[PU.5]` nacieron el
 * 2026-09-17 —**tres días después** de que `[SD.3]` migrara el linaje a `mv_sales_blended`— leyendo
 * la fuente vieja y llamándola "el Real del ODS". Medido en prod ese día:
 *
 *     2026 ene-sep   sales_daily $313,391,770   vs   mv_sales_blended $464,309,751   (+48.2%)
 *     histórico      $409.8M de venta Wincaja de Morelia que el ODS tiene y el fact no
 *
 * ── QUÉ GUARDA, Y QUÉ NO ────────────────────────────────────────────────────────────────────
 * Guarda el INVARIANTE, no el número: la fuente que los servicios declaran en `SALES_FACT` debe
 * cubrir **todas** las sucursales que el sell-out del ODS reporta con venta en el mes cerrado. No
 * fija montos —se mueven todos los días— ni fechas, que caducan.
 *
 * ⚠️ Es de SÓLO LECTURA y corre contra PRODUCCIÓN a propósito: el invariante es sobre los datos
 * reales. Correrlo contra una base de prueba lo pondría verde midiendo semillas, que es justo el
 * modo de fallar que este archivo existe para evitar.
 *
 * ⚠️ Tercer estado (ADR-056): si el árbitro no tiene el mes, reporta **NO MEDIDO**. Una tabla sin
 * diferencias y una tabla sin datos se ven iguales y no significan lo mismo.
 *
 *   node database/tests/test-newdb-sales-source-coverage.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { assertTarget } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const URL = process.env.DATABASE_URL_NEW;
assertTarget('test-newdb-sales-source-coverage', { url: URL, intent: 'read', expect: 'prod' });

const knex = require('knex')({ client: 'pg', connection: { connectionString: URL }, pool: { min: 0, max: 2 } });

/** La misma constante que declaran `commercial-profitability`, `commercial-analytics`, `budget-*`. */
const SALES_FACT = 'analytics.mv_sales_blended';
/** El carril que la refresca. Su umbral vive en `CRON_JOBS` (db-health), warnH 26. */
const SALES_FACT_LANE = 'analytics_refresh_blended';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·', 'NO MEDIDO —', m); };

(async () => {
  try {
    // Mes CERRADO más reciente, calculado. Nada de fechas escritas a mano: caducan y el test
    // se pone rojo por el calendario en vez de por el defecto.
    const [{ desde, hasta, etiqueta }] = await knex.raw(`
      SELECT (date_trunc('month', current_date) - interval '1 month')::date AS desde,
             date_trunc('month', current_date)::date                       AS hasta,
             to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM') AS etiqueta`)
      .then((r) => r.rows);
    console.log(`\nMes cerrado bajo prueba: ${etiqueta}\n`);

    // ── 1. El árbitro: qué sucursales vendieron, según el ODS ────────────────────────────────
    // Unión de las dos piernas del sell-out. `v_branch_erp_cutover` garantiza que NO se traslapan
    // (verificado: Canindo cortó el 2026-08-15 y cada pierna cubre su tramo del mes).
    const arbitro = await knex.raw(`
      SELECT DISTINCT warehouse_code FROM analytics.mv_kepler_sales_daily
       WHERE business_date >= ? AND business_date < ?
      UNION
      SELECT DISTINCT warehouse_code FROM analytics.mv_wincaja_sales_daily
       WHERE business_date >= ? AND business_date < ?`, [desde, hasta, desde, hasta])
      .then((r) => r.rows.map((x) => x.warehouse_code).filter(Boolean).sort());

    if (arbitro.length === 0) {
      noMedido(`el árbitro del ODS no tiene ninguna sucursal con venta en ${etiqueta} — sin base de comparación`);
    } else {
      ok(true, `árbitro del ODS: ${arbitro.length} sucursales con venta (${arbitro.join(', ')})`);

      // ── 2. EL INVARIANTE: la fuente que leen las pantallas no puede faltarle ninguna ────────
      const enFact = await knex.raw(`
        SELECT DISTINCT w.code FROM ${SALES_FACT} f
          JOIN commercial.warehouses w ON w.id = f.warehouse_id
         WHERE f.sale_date >= ? AND f.sale_date < ?`, [desde, hasta])
        .then((r) => r.rows.map((x) => x.code).filter(Boolean));
      const faltan = arbitro.filter((c) => !enFact.includes(c));
      ok(faltan.length === 0,
        faltan.length === 0
          ? `${SALES_FACT} cubre las ${arbitro.length} sucursales del árbitro`
          : `${SALES_FACT} NO cubre ${faltan.length}: ${faltan.join(', ')} — una pantalla que lo lea subdeclara la venta`);

      // ── 3. Prueba NEGATIVA: el defecto original tiene que seguir siendo detectable ──────────
      // Si esto se pone verde (sales_daily ya no omite nada), el invariante de arriba dejó de
      // tener con qué probarse y hay que revisar por qué — no es motivo de fiesta, es de mirar.
      const enViejo = await knex.raw(`
        SELECT DISTINCT w.code FROM analytics.sales_daily f
          JOIN commercial.warehouses w ON w.id = f.warehouse_id
         WHERE f.sale_date >= ? AND f.sale_date < ?`, [desde, hasta])
        .then((r) => r.rows.map((x) => x.code).filter(Boolean));
      const omiteViejo = arbitro.filter((c) => !enViejo.includes(c));
      if (omiteViejo.length > 0) {
        ok(true, `prueba negativa OK: analytics.sales_daily sigue omitiendo ${omiteViejo.length} (${omiteViejo.join(', ')}) → el candado de arriba SÍ discrimina`);
      } else {
        noMedido('analytics.sales_daily ya no omite ninguna sucursal → el invariante quedó sin caso negativo con qué probarse; revisar si la consolidación cambió de alcance');
      }
    }

    // ── 4. La frescura NO puede salir de la fila ────────────────────────────────────────────
    // `mv_sales_blended.updated_at` es la FECHA DE VENTA truncada a medianoche, no el sello del
    // refresco. Usarla como `data_as_of` diría "al día" siempre — el mismo defecto que VP.0 midió
    // en 21 de 24 píldoras. Esta aserción existe para que nadie la vuelva a usar de reloj.
    const [{ medianoche, total }] = await knex.raw(`
      SELECT count(*) FILTER (WHERE updated_at::time = '00:00:00')::bigint AS medianoche,
             count(*)::bigint AS total
        FROM ${SALES_FACT} WHERE sale_date >= ? AND sale_date < ?`, [desde, hasta]).then((r) => r.rows);
    if (Number(total) === 0) {
      noMedido(`${SALES_FACT} no tiene filas de ${etiqueta} — no se puede probar la forma de updated_at`);
    } else {
      ok(Number(medianoche) > 0,
        `updated_at de ${SALES_FACT} NO es sello de refresco (${medianoche}/${total} filas a medianoche exacta) → el data_as_of va por el latido`);
    }

    // ── 5. El latido que SÍ mide la entrega existe y está registrado ────────────────────────
    const [lane] = await knex('analytics.cron_runs').where({ job_key: SALES_FACT_LANE })
      .select('status', 'last_finish');
    if (!lane) {
      ok(false, `no hay latido '${SALES_FACT_LANE}' en analytics.cron_runs → el data_as_of quedaría en 'unknown' para siempre`);
    } else {
      const horas = lane.last_finish ? (Date.now() - new Date(lane.last_finish).getTime()) / 3_600_000 : null;
      ok(horas !== null, `latido '${SALES_FACT_LANE}': ${lane.status}, hace ${horas === null ? '—' : horas.toFixed(1)} h`);
    }

    console.log(`\nCobertura de la fuente de venta [AUD-DAT.1]: ${pass} ✓ / ${fail} ✗ / ${nm} NO MEDIDO`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
