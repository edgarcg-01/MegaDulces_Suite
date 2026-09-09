/**
 * DEDUP del cutover Madero (E): Kepler '07' ≥ 2026-09-08 / Wincaja '32' < 2026-09-08 en `v_sellout_daily`.
 *
 * Madero migró su POS de Wincaja ('32') a Kepler ('07') el 2026-09-08 (handoff limpio, cero traslape).
 * En el sell-out, la sucursal '32' entra por `vl.wincaja_only = true` SIN cota de fecha (verificado en
 * prod: mv_wincaja_sales_daily marca 30 y 32 como wincaja_only). Cuando '07' empiece a llegar al ODS,
 * '32' (todas las fechas) + '07' (≥09-08) → DOBLE CONTEO desde el 09-08. Este parche cierra el complemento:
 *   - KEPLER_DEDUP += (source_branch='07' AND business_date >= '2026-09-08')
 *   - WINCAJA_DEDUP += AND NOT (source_branch='32' AND business_date >= '2026-09-08')  ← acota el wincaja_only de 32
 *
 * ⚠️ ORDEN (auto-sellado): este parche EXCLUYE '32' desde el 09-08. Si se aplica ANTES de que '07' llegue
 * al ODS (paso 4 = `ODS_LIVE_BRANCHES += 07` en el runner + refresh de mv_kepler), Madero queda con HUECO
 * (32 fuera, 07 aún ausente). Por eso up() SE NIEGA a correr hasta ver venta de '07' en mv_kepler_sales_daily
 * — un gate con prueba negativa: no puede crear el hueco aunque alguien lo dispare temprano.
 *
 * Cirugía sobre el cuerpo VIVO (pg_get_viewdef) con aserciones — no reproduce el cuerpo de 3 piernas a
 * mano (se pondría stale si otra migración toca la vista). v_sellout_daily es vista simple, sin
 * security_invoker (reloptions null, verificado) → CREATE OR REPLACE conserva los grants. mv_sales_blended
 * NO existe en prod (el código lo referencia pero to_regclass=null) → no hay 2º consumidor que parchar.
 * @param { import("knex").Knex } knex
 */
const CUT = '2026-09-08';

// Firmas EXACTAS del cuerpo actual (pg_get_viewdef, pretty). Si cambian, la aserción falla en vez de mis-patchear.
const KEPLER_TAIL = `(k.source_branch = ANY (ARRAY['03'::text, '04'::text, '05'::text])))`;
const KEPLER_PATCHED = `(k.source_branch = ANY (ARRAY['03'::text, '04'::text, '05'::text])) OR (k.source_branch = '07'::text AND k.business_date >= '${CUT}'::date))`;
const WINCAJA_TAIL = `vl.source_branch = '50'::text AND vl.business_date < '2026-08-15'::date)`;
const WINCAJA_PATCHED = `vl.source_branch = '50'::text AND vl.business_date < '2026-08-15'::date) AND NOT (vl.source_branch = '32'::text AND vl.business_date >= '${CUT}'::date)`;
// Nombres sin esquema que devuelve pg_get_viewdef → calificar para no depender del search_path al recrear.
const QUALIFY = [
  ['FROM product_label_prices', 'FROM commercial.product_label_prices'],
  ['JOIN warehouses w', 'JOIN commercial.warehouses w'],
  ['JOIN products p', 'JOIN catalog.products p'],
  ['JOIN brands b', 'JOIN catalog.brands b'],
];

exports.up = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;

  if (def.includes(`'07'::text AND k.business_date >= '${CUT}'`)) {
    console.log('  v_sellout_daily ya trae el dedup de Madero 07 — idempotente, skip.');
    return;
  }

  // Gate anti-hueco: no acotar '32' hasta que '07' YA esté en el ODS (paso 4 hecho + mv_kepler refrescada).
  const k07 = Number((await knex.raw(
    `SELECT count(*)::int n FROM analytics.mv_kepler_sales_daily WHERE source_branch = '07' AND business_date >= '${CUT}'::date`)).rows[0].n);
  if (k07 === 0) {
    throw new Error(`ABORT: Kepler '07' aún no tiene venta en mv_kepler_sales_daily (>= ${CUT}). ` +
      `Aplicar DESPUÉS del paso 4 (ODS_LIVE_BRANCHES += 07 en el runner + REFRESH mv_kepler_sales_daily), ` +
      `o el complemento dejaría a Madero con HUECO (32 excluido, 07 ausente).`);
  }
  console.log(`  gate OK: '07' tiene ${k07} filas en mv_kepler (>= ${CUT}).`);

  // Aserciones: cada firma exactamente una vez.
  for (const [name, s] of [['KEPLER_TAIL', KEPLER_TAIL], ['WINCAJA_TAIL', WINCAJA_TAIL]]) {
    const n = def.split(s).length - 1;
    if (n !== 1) throw new Error(`ABORT: firma ${name} aparece ${n} veces (esperaba 1) — el cuerpo de v_sellout_daily cambió; revisar antes de parchear.`);
  }

  def = def.replace(KEPLER_TAIL, KEPLER_PATCHED).replace(WINCAJA_TAIL, WINCAJA_PATCHED);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);

  // Verificación en el mismo momento: no debe haber una llave (día×producto) con '32' y '07' a la vez >= cut.
  const dup = Number((await knex.raw(
    `SELECT count(*)::int n FROM (
       SELECT business_date, product_id FROM analytics.v_sellout_daily
        WHERE source_branch IN ('07','32') AND business_date >= '${CUT}'::date
        GROUP BY business_date, product_id HAVING count(DISTINCT source_branch) > 1) x`)).rows[0].n);
  if (dup > 0) throw new Error(`ABORT: ${dup} llaves con '07' y '32' simultáneos >= ${CUT} — el complemento no quedó disjunto.`);
  console.log(`  ✓ v_sellout_daily parchada · 0 llaves con doble fuente >= ${CUT}.`);
};

exports.down = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;
  def = def.replace(KEPLER_PATCHED, KEPLER_TAIL).replace(WINCAJA_PATCHED, WINCAJA_TAIL);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
};
