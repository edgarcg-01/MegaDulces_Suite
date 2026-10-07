/**
 * `[RL.10]` Cierre del cutover de **Morelia Abastos (`30` → Kepler `08`)** y **Morelia Madero
 * (`32` → Kepler `07`)** — la vista del sell-out y el crosswalk, EN UNA SOLA TRANSACCIÓN.
 *
 * ── ⛔ Por qué es UNA migración y no dos ────────────────────────────────────────────────────
 * Esto empezó como dos archivos separados —parchar `v_sellout_daily` y llenar
 * `wincaja.branches`— y así **borraba 1.68 millones de filas de historia sin decir nada**.
 * Medido en prod el 2026-09-18 antes de aplicarlo:
 *
 *   rama `30` Abastos : 1,170,977 filas en `v_sellout_daily` (2000-01-01 → 2026-09-16)
 *   rama `32` Madero  :   505,843 filas (2000-01-01 → 2026-09-07)
 *
 * El acoplamiento que lo causa: la rama Wincaja de `v_sellout_daily` filtra así —
 *
 *   WHERE ( vl.wincaja_only = true
 *        OR vl.source_branch = '10' AND business_date < '2026-07-01'
 *        OR vl.source_branch = '42' AND business_date < '2025-10-01'
 *        OR vl.source_branch = '50' AND business_date < '2026-08-15' )
 *
 * y `wincaja_only` se deriva de `wincaja.branches.kepler_code IS NULL`. O sea que **poner el
 * `kepler_code` apaga `wincaja_only`**, y si la vista no tiene la cláusula explícita de esa rama,
 * su historia entera desaparece del sell-out. Es exactamente por eso que `10`, `42` y `50` —las
 * tres que ya tienen código— están enumeradas ahí una por una.
 *
 * Las dos cosas tienen que moverse juntas o no moverse. De ahí este archivo.
 *
 * ── El estado al que se llega (el de Canindo, que es el completo) ──────────────────────────
 * Madero quedó a mitad de camino el 2026-09-08: `kepler_code` sin poner (para no perder su
 * historia) y la vista parchada con un `AND NOT (32 >= cut)`. Funciona para el sell-out, pero
 * deja `wincaja.branches` abierto — y los sensores de `db-health` derivan **las sucursales a
 * vigilar** de `kepler_code IS NULL`, así que el tablero sigue alarmando por un `.mdb` que ya
 * nadie escribe. Una alerta que no se puede apagar entrena al equipo a ignorar el tablero.
 *
 * Acá las dos pasan al estado de Canindo: código puesto + cláusula explícita con su fecha.
 *
 * ── Las fechas, medidas por los DOS lados ───────────────────────────────────────────────────
 *   `32` Madero  — Wincaja hasta 2026-09-07 · Kepler `md_07` arranca 09-08.
 *   `30` Abastos — Wincaja hasta 2026-09-17 (651 movs, 0 el 18) · Kepler `md_08` arranca 09-18,
 *                  y `md_08.md.kdm1` NO tiene un solo documento anterior.
 * El control que las hace válidas: los dos carriles PM2 de Wincaja llevaban 3 días online con 0
 * reinicios, así que "no llega nada nuevo" es un hecho y no un carril caído.
 *
 * ⚠️ **`08` todavía NO entra por el lado Kepler**, y no es este archivo el que lo arregla:
 * `mv_kepler_sales_daily` hace `JOIN commercial.warehouses w ON w.code = sucursal`, y Abastos es
 * `MD-30`. Hace falta un almacén con `code = '08'` — Madero tiene `07` y Canindo `06`, los dos
 * creados NUEVOS con el viejo `MD-3x` en soft-delete. Esa decisión toca stock, ventas y políticas
 * de reorden, así que va aparte y con nombre: **sin ella, Abastos no aporta al sell-out desde el
 * 09-18** (tampoco aportaría hoy, porque Wincaja ya no la alimenta). Este archivo deja el
 * complemento Wincaja correcto y la puerta Kepler abierta para cuando el almacén exista.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const CUT_ABASTOS = '2026-09-18';
const CUT_MADERO = '2026-09-08';

// Firmas EXACTAS de `pg_get_viewdef(..., true)` leídas en prod el 2026-09-18. Si alguna no
// aparece exactamente una vez, se ABORTA: un parche que acierta a medias mueve dinero.
const KEPLER_TAIL = `OR k.source_branch = '07'::text AND k.business_date >= '${CUT_MADERO}'::date)`;
const KEPLER_NUEVO = `OR k.source_branch = '07'::text AND k.business_date >= '${CUT_MADERO}'::date OR k.source_branch = '08'::text AND k.business_date >= '${CUT_ABASTOS}'::date)`;

// El bloque Wincaja entero: se le AGREGAN las dos cláusulas de inclusión y se le QUITA el
// `AND NOT (32 …)`, que queda redundante (la cota `< CUT_MADERO` hace el mismo trabajo, y
// además ahora es necesaria porque `32` deja de ser `wincaja_only`).
const WINCAJA_TAIL = `OR vl.source_branch = '50'::text AND vl.business_date < '2026-08-15'::date) AND NOT (vl.source_branch = '32'::text AND vl.business_date >= '${CUT_MADERO}'::date)`;
const WINCAJA_NUEVO = `OR vl.source_branch = '50'::text AND vl.business_date < '2026-08-15'::date`
  + ` OR vl.source_branch = '30'::text AND vl.business_date < '${CUT_ABASTOS}'::date`
  + ` OR vl.source_branch = '32'::text AND vl.business_date < '${CUT_MADERO}'::date)`;

// `pg_get_viewdef` devuelve los nombres SIN esquema → calificar para no depender del search_path.
const QUALIFY = [
  ['FROM product_label_prices', 'FROM commercial.product_label_prices'],
  ['JOIN warehouses w', 'JOIN commercial.warehouses w'],
  ['JOIN products p', 'JOIN catalog.products p'],
  ['JOIN brands b', 'JOIN catalog.brands b'],
];

const CUTOVERS = [
  { branch: '30', kepler: '08', ultimo: '2026-09-17', primero: CUT_ABASTOS, nombre: 'Morelia Abastos' },
  { branch: '32', kepler: '07', ultimo: '2026-09-07', primero: CUT_MADERO, nombre: 'Morelia Madero' },
];

const contar = async (knex, b) => Number((await knex.raw(
  `SELECT count(*)::int n FROM analytics.v_sellout_daily WHERE source_branch = ?`, [b])).rows[0].n);

exports.up = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;

  if (def.includes(`vl.source_branch = '30'::text AND vl.business_date < '${CUT_ABASTOS}'`)) {
    console.log('  v_sellout_daily ya trae el cutover de Abastos — idempotente, skip.');
    return;
  }

  // ── Antes ───────────────────────────────────────────────────────────────────────────────
  const antes = {};
  for (const c of CUTOVERS) antes[c.branch] = await contar(knex, c.branch);
  console.log(`  antes · 30: ${antes['30']} filas · 32: ${antes['32']} filas`);

  // ── Aserciones sobre el cuerpo de la vista ──────────────────────────────────────────────
  for (const [nombre, s] of [['KEPLER_TAIL', KEPLER_TAIL], ['WINCAJA_TAIL', WINCAJA_TAIL]]) {
    const n = def.split(s).length - 1;
    if (n !== 1) {
      throw new Error(`ABORT: la firma ${nombre} aparece ${n} veces (esperaba 1). El cuerpo de `
        + `v_sellout_daily cambió: leer pg_get_viewdef y reescribir el ancla ANTES de parchear.`);
    }
  }

  def = def.replace(KEPLER_TAIL, KEPLER_NUEVO).replace(WINCAJA_TAIL, WINCAJA_NUEVO);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);

  // ── El crosswalk, DESPUÉS de que la vista ya las enumere ────────────────────────────────
  for (const c of CUTOVERS) {
    const prev = (await knex.raw(
      `SELECT kepler_code FROM wincaja.branches WHERE tenant_id = ? AND source_branch = ?`,
      [TENANT, c.branch])).rows[0];
    if (!prev) throw new Error(`ABORT: no existe wincaja.branches para '${c.branch}'.`);
    if (prev.kepler_code && prev.kepler_code !== c.kepler) {
      throw new Error(`ABORT: '${c.branch}' ya tiene kepler_code='${prev.kepler_code}' y se quiere `
        + `poner '${c.kepler}'. Dos códigos para una sucursal rompe el sell-out por los dos lados.`);
    }
    await knex.raw(
      `UPDATE wincaja.branches
          SET kepler_code = ?, status = 'transition', last_movement_date = ?::date,
              notes = coalesce(notes, '') || ?
        WHERE tenant_id = ? AND source_branch = ?`,
      [c.kepler, c.ultimo,
        ` · [RL.10 2026-09-18] cutover a Kepler '${c.kepler}': último día Wincaja ${c.ultimo}, `
        + `primer día Kepler ${c.primero} (medido en los dos lados).`,
        TENANT, c.branch]);
    console.log(`  ✓ '${c.branch}' ${c.nombre} → kepler_code='${c.kepler}', transition, ${c.ultimo}`);
  }

  // ── ⭐ La verificación que justifica que esto sea una sola transacción ───────────────────
  // `kepler_code` apaga `wincaja_only`. Si la cláusula explícita no quedó bien, la historia de
  // esa rama se evapora acá mismo — y es el modo de falla MUDO: nadie mira una cifra que bajó.
  for (const c of CUTOVERS) {
    const ahora = await contar(knex, c.branch);
    const perdido = antes[c.branch] - ahora;
    if (perdido > 0) {
      throw new Error(`ABORT: la rama '${c.branch}' perdió ${perdido} filas del sell-out `
        + `(${antes[c.branch]} → ${ahora}). Poner kepler_code apaga wincaja_only, así que la `
        + `cláusula explícita de esa rama no quedó bien. Se revierte la transacción entera.`);
    }
    console.log(`  ✓ '${c.branch}' conserva su historia: ${antes[c.branch]} → ${ahora} filas`);
  }

  // Y que el complemento sea disjunto: ninguna llave con las dos fuentes desde el corte.
  const dup = Number((await knex.raw(
    `SELECT count(*)::int n FROM (
       SELECT business_date, product_id FROM analytics.v_sellout_daily
        WHERE (source_branch IN ('08','30') AND business_date >= ?::date)
           OR (source_branch IN ('07','32') AND business_date >= ?::date)
        GROUP BY business_date, product_id HAVING count(DISTINCT source_branch) > 1) x`,
    [CUT_ABASTOS, CUT_MADERO])).rows[0].n);
  if (dup > 0) throw new Error(`ABORT: ${dup} llaves con doble fuente tras el corte — no quedó disjunto.`);

  console.log('  ✓ complemento disjunto y sin pérdida de historia.');
};

exports.down = async function (knex) {
  let def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_sellout_daily', true) d`)).rows[0].d;
  def = def.replace(KEPLER_NUEVO, KEPLER_TAIL).replace(WINCAJA_NUEVO, WINCAJA_TAIL);
  for (const [from, to] of QUALIFY) def = def.split(from).join(to);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_sellout_daily AS ${def}`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_daily TO app_runtime`);
  for (const c of CUTOVERS) {
    await knex.raw(
      `UPDATE wincaja.branches SET kepler_code = NULL, status = 'live_on_wincaja', last_movement_date = NULL
        WHERE tenant_id = ? AND source_branch = ? AND kepler_code = ?`, [TENANT, c.branch, c.kepler]);
  }
};
