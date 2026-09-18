/**
 * `[RL.10]` DEDUP del cutover **Morelia Abastos**: Kepler `'08'` ≥ 2026-09-18 / Wincaja `'30'` <
 * 2026-09-18 en `analytics.v_sellout_daily`.
 *
 * Abastos migró su PdV de Wincaja (`'30'`) a Kepler (`'08'`) el 2026-09-18. En el sell-out, la
 * sucursal `'30'` entra por `vl.wincaja_only = true` **sin cota de fecha**, así que en cuanto
 * `'08'` empiece a llegar al ODS quedan las dos: `'30'` (todas las fechas) + `'08'` (≥ 09-18) →
 * **DOBLE CONTEO** desde el 09-18. Este parche cierra el complemento:
 *
 *   · KEPLER  += (source_branch = '08' AND business_date >= CUT)
 *   · WINCAJA += AND NOT (source_branch = '30' AND business_date >= CUT)   ← acota el wincaja_only
 *
 * Calca `20260909170000_sellout_dedup_madero_07.js`, que hizo exactamente esto para Madero. No se
 * inventa nada: cambian la fecha y los dos códigos.
 *
 * ── Por qué la fecha es ésta y no una estimación ────────────────────────────────────────────
 * Medido por los DOS lados el 2026-09-18, que es lo que un corte necesita y casi nunca tiene:
 *
 *   Wincaja `w30` : último movimiento **2026-09-17** (651 movs) · **0** el 09-18, con el carril
 *                   PM2 3 días online y 0 reinicios (o sea: "no llega nada" es una medición, no
 *                   un carril muerto).
 *   Kepler `md_08`: **arranca el 2026-09-18** (77 docs al momento de medir) y `md.kdm1` **no
 *                   tiene un solo documento anterior** — un único día en toda la tabla.
 *
 * Cero traslape y cero hueco.
 *
 * ── ⚠️ Las firmas de anclaje ────────────────────────────────────────────────────────────────
 * Están escritas contra la salida de `pg_get_viewdef` **después** del parche de Madero. Desde
 * entonces `20260910120000_v_sellout_daily_canindo_van_push.js` volvió a tocar la vista, así que
 * pueden haber cambiado. Por eso esto **NO adivina**: si una firma no aparece exactamente una
 * vez, ABORTA y dice cuál. Un parche que falla ruidoso es barato; uno que acierta a medias
 * duplica o borra venta y nadie lo nota hasta el cierre.
 *
 * @param { import("knex").Knex } knex
 */
const CUT = '2026-09-18';
const CUT_MADERO = '2026-09-08';

// Firmas EXACTAS del cuerpo actual. El ancla es el propio parche de Madero, que es lo último que
// se agregó a cada rama de la condición.
const KEPLER_TAIL = `(k.source_branch = '07'::text AND k.business_date >= '${CUT_MADERO}'::date))`;
const KEPLER_PATCHED = `(k.source_branch = '07'::text AND k.business_date >= '${CUT_MADERO}'::date) OR (k.source_branch = '08'::text AND k.business_date >= '${CUT}'::date))`;
const WINCAJA_TAIL = `AND NOT (vl.source_branch = '32'::text AND vl.business_date >= '${CUT_MADERO}'::date)`;
const WINCAJA_PATCHED = `AND NOT (vl.source_branch = '32'::text AND vl.business_date >= '${CUT_MADERO}'::date) AND NOT (vl.source_branch = '30'::text AND vl.business_date >= '${CUT}'::date)`;

// `pg_get_viewdef` devuelve los nombres SIN esquema → calificar para no depender del search_path
// al recrear. Mismo bloque que la migración de Madero.
const QUALIFY = [
  ['FROM product_label_prices', 'FROM commercial.product_label_prices'],
  ['JOIN warehouses w', 'JOIN commercial.warehouses w'],
  ['JOIN products p', 'JOIN catalog.products p'],
  ['JOIN brands b', 'JOIN catalog.brands b'],
];

exports.up = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;

  if (def.includes(`'08'::text AND k.business_date >= '${CUT}'`)) {
    console.log('  v_sellout_daily ya trae el dedup de Abastos 08 — idempotente, skip.');
    return;
  }

  // ⛔ Gate anti-hueco. No se acota `'30'` hasta que `'08'` YA esté en el ODS y en la matview.
  // Si se aplicara antes, Abastos quedaría con HUECO en vez de con duplicado: '30' excluido y
  // '08' todavía ausente. Un hueco es peor que un duplicado porque nadie lo ve.
  const k08 = Number((await knex.raw(
    `SELECT count(*)::int n FROM analytics.mv_kepler_sales_daily WHERE source_branch = '08' AND business_date >= '${CUT}'::date`)).rows[0].n);
  if (k08 === 0) {
    throw new Error(`ABORT: Kepler '08' aún no tiene venta en mv_kepler_sales_daily (>= ${CUT}). `
      + `Aplicar DESPUÉS de que el carril del ODS shipee la rama y se refresque la matview `
      + `(REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_kepler_sales_daily), o el `
      + `complemento dejaría a Abastos con HUECO (30 excluido, 08 ausente).`);
  }
  console.log(`  gate OK: '08' tiene ${k08} filas en mv_kepler (>= ${CUT}).`);

  // Aserciones: cada firma exactamente una vez. Si el cuerpo cambió, se para acá.
  for (const [name, s] of [['KEPLER_TAIL', KEPLER_TAIL], ['WINCAJA_TAIL', WINCAJA_TAIL]]) {
    const n = def.split(s).length - 1;
    if (n !== 1) {
      throw new Error(`ABORT: la firma ${name} aparece ${n} veces (esperaba 1) — el cuerpo de `
        + `v_sellout_daily cambió desde el parche de Madero. Leer `
        + `pg_get_viewdef('analytics.v_sellout_daily', true) y reescribir el ancla ANTES de parchear.`);
    }
  }

  def = def.replace(KEPLER_TAIL, KEPLER_PATCHED).replace(WINCAJA_TAIL, WINCAJA_PATCHED);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);

  // Verificación EN EL MISMO MOMENTO, no "después": ninguna llave (día × producto) puede traer
  // '30' y '08' a la vez desde el corte.
  const dup = Number((await knex.raw(
    `SELECT count(*)::int n FROM (
       SELECT business_date, product_id FROM analytics.v_sellout_daily
        WHERE source_branch IN ('08','30') AND business_date >= '${CUT}'::date
        GROUP BY business_date, product_id HAVING count(DISTINCT source_branch) > 1) x`)).rows[0].n);
  if (dup > 0) throw new Error(`ABORT: ${dup} llaves con '08' y '30' simultáneos >= ${CUT} — el complemento no quedó disjunto.`);

  // Y la otra mitad, que es la que no se suele mirar: que no haya quedado HUECO. El día del
  // corte tiene que existir en el sell-out por el lado de Kepler.
  const dia = Number((await knex.raw(
    `SELECT count(*)::int n FROM analytics.v_sellout_daily
      WHERE source_branch = '08' AND business_date >= '${CUT}'::date`)).rows[0].n);
  if (dia === 0) throw new Error(`ABORT: tras el parche, '08' no aporta NINGUNA fila >= ${CUT} — se abrió un hueco.`);

  console.log(`  ✓ v_sellout_daily parchada · 0 llaves con doble fuente y ${dia} filas de '08' >= ${CUT}.`);
};

exports.down = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;
  def = def.replace(KEPLER_PATCHED, KEPLER_TAIL).replace(WINCAJA_PATCHED, WINCAJA_TAIL);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
};
