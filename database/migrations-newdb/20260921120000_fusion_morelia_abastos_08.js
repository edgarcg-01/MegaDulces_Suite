/**
 * `[RL.13]` **Morelia Abastos deja de estar partida en dos.** `MD-30` (era Wincaja) y `08` (era
 * Kepler) se funden en UN almacén, y el sufijo `MD-30` desaparece.
 *
 * ── Por qué estaba partida, y por qué eso ya no sirve ───────────────────────────────────────
 * `20260919130000_warehouse_08_abastos.js` creó `08` como fila NUEVA y dejó escrito que no tocaba
 * `MD-30` a propósito ("cada era, su casa"), calcando a Madero. Medido hoy en prod, ese modelo
 * dejó a la sucursal operando a ciegas:
 *
 *   MD-30 (a2a08332…)  1,091,667 movs · 15,675 tickets · 10,097 de existencia CONGELADA 09-18 12:55
 *   08    (7305328c…)  3,421 movs · 12 cortes · **0 filas de existencia**
 *
 * Y la tienda **sí vende**: `kepler_ods.kdm1` de la `08` trae 1,275 tickets `U-D-10` hasta hoy.
 * O sea que desde el 18-sep Compras planea Morelia Abastos contra un inventario Wincaja muerto,
 * mientras el vivo no entra por ningún lado. Un almacén partido no es una elección de modelado:
 * es la sucursal existiendo dos veces y ninguna de las dos estando completa.
 *
 * El modelo MAYORITARIO de la red es el fusionado — Canindo `06` lleva `kepler_code='06'` **y**
 * `wincaja_source_branch='50'` en la misma fila. Esto vuelve a él.
 *
 * ── Se renombra el VIEJO, no se migra al nuevo ─────────────────────────────────────────────
 * Sobrevive el id de `MD-30` y se pliegan adentro las ~12,600 filas que la `08` juntó en 3 días.
 * Al revés serían ~1,160,000 UPDATE sobre prod. Además `07` Madero **ya tiene a `MD-30` de hub de
 * resurtido** (`source_warehouse_id`), así que renombrando queda bien sin tocarlo. Es el precedente
 * de Canindo (`MD-50` → `06`), que el runbook §9.4 pedía medir antes de repetir: medido arriba.
 *
 * ── ⛔ El candado NO puede ser "la FK aborta si quedó algo apuntando" ───────────────────────
 * Se midió el catálogo antes de confiar en eso, y es FALSO: de las 76 FKs hacia
 * `commercial.warehouses`, **36 no abortan** — 11 `ON DELETE CASCADE` (`reorder_policy`,
 * `replenishment_channel`, `replenishment_findings`, `route_warehouses`, `erp_sucursal_warehouse`,
 * `inventory_risk_index`, `warehouse_aisles`, `stock_movement_audits`, `erp_transfer_origin`,
 * `inventory.warehouse_stock*`) y 25 `ON DELETE SET NULL` (entre ellas `analytics.cash_cuts`, que
 * tiene los 12 cortes de la `08`, y `identity.users`, que tiene sus 2 personas).
 * Un `DELETE` confiado habría **borrado y desvinculado en silencio** en vez de abortar.
 * Por eso acá el repunte se enumera desde `pg_constraint` y se AFIRMA cero antes de borrar.
 *
 * ── Lo que se PURGA, declarado ──────────────────────────────────────────────────────────────
 * Las 6 tablas derivadas del lado `MD-30` son foto de Wincaja y ya no corresponden a nada: el POS
 * de esa tienda es Kepler desde el 18-sep. Se borran y los feeds nocturnos las reconstruyen sobre
 * el almacén fusionado (mismo criterio que `20260911120000_cleanup_retired_lanes_md32.js`).
 *
 * ⚠️ **Consecuencia medida y aceptada (decisión de 0Sistemas, 2026-09-21):** Kepler `md_08` arrancó
 * con **2,975 SKUs** y Wincaja tenía **10,097** → la existencia de Abastos pasa a mostrar ~7,122
 * SKUs MENOS. No es pérdida de dato: es que el POS nuevo todavía no tiene cargado ese catálogo.
 * Se prefiere que caiga y se reporte, antes que Compras siga pidiendo contra stock fantasma.
 * El faltante se emite al final de esta migración con su cifra, para que Sistemas lo cargue.
 *
 * `replenishment_findings` (4,412) **NO se purga** — es bandeja con triage humano: se repunta.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/** Derivadas puras del lado Wincaja: se reconstruyen solas. [tabla, motivo] */
const PURGAR = [
  ['commercial.stock', 'existencia viva Wincaja, congelada el 09-18'],
  ['commercial.stock_lots', 'lotes derivados de esa misma existencia'],
  ['analytics.inventory_health', 'salud de inventario, recalculada por import-inventory-health'],
  ['analytics.replenishment_plan', 'plan de reorden, recalculado por import-computed-reorder'],
  ['commercial.abc_classification', 'clasificación ABC, recalculada'],
  ['commercial.reorder_policy', 'política de reorden (medido: 4,920 filas, TODAS source=computed)'],
];

/** Lee del catálogo TODAS las columnas que apuntan a commercial.warehouses. */
async function columnasQueApuntan(knex) {
  return (await knex.raw(`
    SELECT n.nspname AS esquema, t.relname AS tabla, a.attname AS columna
      FROM pg_constraint co
      JOIN pg_class t ON t.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class rt ON rt.oid = co.confrelid
      JOIN pg_namespace rn ON rn.oid = rt.relnamespace
      JOIN unnest(co.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE co.contype = 'f' AND rn.nspname = 'commercial' AND rt.relname = 'warehouses'
       AND a.attname LIKE '%warehouse%'
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)).rows;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  await knex.raw(`SET LOCAL statement_timeout = '10min'`);

  const fila = async (code) => (await knex.raw(
    `SELECT id, code, name, kepler_code, wincaja_source_branch AS win, display_order AS ord
       FROM commercial.warehouses WHERE tenant_id = ? AND code = ?`, [M, code])).rows[0];

  const sv = await fila('MD-30');   // sobrevive: el que trae la historia
  const vc = await fila('08');      // víctima: 3 días de vida

  // ── Idempotencia ────────────────────────────────────────────────────────────────────────
  if (!sv && vc && vc.win === '30') {
    console.log('  Abastos ya está fusionada (08 lleva wincaja_source_branch=30) — skip.');
    return;
  }
  if (!sv) throw new Error('ABORT: no existe commercial.warehouses MD-30 y la 08 no quedó fusionada.');
  if (!vc) throw new Error('ABORT: no existe commercial.warehouses 08. Correr antes 20260919130000.');
  if (sv.win !== '30') throw new Error(`ABORT: MD-30 tiene wincaja_source_branch='${sv.win}', esperaba '30'.`);
  if (vc.kepler_code !== '08') throw new Error(`ABORT: 08 tiene kepler_code='${vc.kepler_code}', esperaba '08'.`);

  console.log(`  sobrevive MD-30 ${sv.id} · se pliega 08 ${vc.id}`);

  // ── 1. Purga de las derivadas Wincaja (libera además casi todas las colisiones de UNIQUE) ─
  let purgadas = 0;
  const stockAntes = Number((await knex.raw(
    `SELECT count(*)::int n FROM commercial.stock WHERE warehouse_id = ?`, [sv.id])).rows[0].n);
  for (const [t, motivo] of PURGAR) {
    const r = await knex.raw(`DELETE FROM ${t} WHERE warehouse_id = ?`, [sv.id]);
    purgadas += r.rowCount;
    console.log(`  purgada ${t}: ${r.rowCount} filas — ${motivo}`);
  }

  // ── 2. La colisión que la purga NO cubre: replenishment_channel es config, no derivada ────
  //    UNIQUE (tenant_id, warehouse_id, supplier_id). Medido: 3 proveedores en los dos lados.
  //    Gana la fila de la era Kepler (la 08), que es la vigente.
  const ch = await knex.raw(
    `DELETE FROM commercial.replenishment_channel a
      WHERE a.warehouse_id = ?
        AND EXISTS (SELECT 1 FROM commercial.replenishment_channel b
                     WHERE b.warehouse_id = ? AND b.tenant_id = a.tenant_id
                       AND b.supplier_id = a.supplier_id)`, [sv.id, vc.id]);
  console.log(`  replenishment_channel: ${ch.rowCount} filas viejas desplazadas por su gemela Kepler`);

  // ── 3. Repunte GENÉRICO: todo lo que apunte a la víctima pasa al sobreviviente ────────────
  const cols = await columnasQueApuntan(knex);
  console.log(`  ${cols.length} columnas apuntan a commercial.warehouses — repuntando…`);
  let movidas = 0;
  for (const c of cols) {
    const t = `${c.esquema}.${c.tabla}`;
    if (t === 'commercial.warehouses' && c.columna === 'source_warehouse_id') {
      // self-FK: se resuelve igual, pero la víctima se borra después, así que va primero.
    }
    let r;
    try {
      r = await knex.raw(`UPDATE ${t} SET ${c.columna} = ? WHERE ${c.columna} = ?`, [sv.id, vc.id]);
    } catch (e) {
      throw new Error(`ABORT repuntando ${t}.${c.columna}: ${e.message}. `
        + `Si es choque de UNIQUE, esa tabla tiene filas en los DOS almacenes y hay que decidir `
        + `cuál gana ANTES de repuntar (ver el bloque de replenishment_channel arriba).`);
    }
    if (r.rowCount) { movidas += r.rowCount; console.log(`    · ${t}.${c.columna}: ${r.rowCount}`); }
  }
  console.log(`  ${movidas} filas repuntadas a la fila que sobrevive.`);

  // ── 4. ⭐ AFIRMAR CERO antes de borrar. No se delega en la FK: 36 de 76 no abortan ────────
  const colgando = [];
  for (const c of cols) {
    const t = `${c.esquema}.${c.tabla}`;
    const n = Number((await knex.raw(
      `SELECT count(*)::int n FROM ${t} WHERE ${c.columna} = ?`, [vc.id])).rows[0].n);
    if (n) colgando.push(`${t}.${c.columna}=${n}`);
  }
  if (colgando.length) {
    throw new Error(`ABORT: la fila 08 todavía tiene referencias y 36 de sus 76 FKs hacen CASCADE `
      + `o SET NULL (o sea: el DELETE no avisaría, mutilaría). Pendientes → ${colgando.join(', ')}`);
  }

  // ── 5. Se va la fila joven, y el sufijo con ella ──────────────────────────────────────────
  const del = await knex.raw(`DELETE FROM commercial.warehouses WHERE id = ?`, [vc.id]);
  if (del.rowCount !== 1) throw new Error(`ABORT: el DELETE de la 08 tocó ${del.rowCount} filas.`);

  await knex.raw(
    `UPDATE commercial.warehouses
        SET code = '08', name = 'Morelia Abastos', kepler_code = '08', short_label = 'MA',
            active = true, deleted_at = NULL, updated_at = now()
      WHERE id = ?`, [sv.id]);
  console.log(`  MD-30 → '08' "Morelia Abastos" (kepler_code=08 + wincaja_source_branch=30, como Canindo)`);

  // ── 6. Las dos patas que quedaban sueltas del lado del mapeo ──────────────────────────────
  await knex.raw(
    `UPDATE wincaja.branches SET warehouse_code = '08'
      WHERE tenant_id = ? AND source_branch = '30' AND warehouse_code = 'MD-30'`, [M]);

  // `erp_sucursal_warehouse` sólo tenía la sucursal '30' (Wincaja). Los feeds Kepler emiten '08'
  // y no había fila → quedaban sin resolver. La '30' se conserva: la historia sigue emitiéndola.
  await knex.raw(
    `INSERT INTO commercial.erp_sucursal_warehouse (tenant_id, sucursal, warehouse_id, updated_at)
     VALUES (?, '08', ?, now())
     ON CONFLICT (tenant_id, sucursal) DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id,
                                                     updated_at = now()`, [M, sv.id]);

  // ── 7. ⭐ El alcance por sucursal, que es lo que de verdad muerde ──────────────────────────
  // `branchKeySql` (scope.types.ts:102) es
  //     CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code ELSE w.wincaja_source_branch END
  // Mientras Abastos fue 'MD-30' la llave canónica era '30'. Al renombrar a '08', `code` ya
  // matchea la regex y la llave pasa a ser '08' — igual que Canindo, que con code='06' y
  // wincaja_source_branch='50' hoy llavea '06'.
  //
  // ⛔ O sea que sin esto, los 8 usuarios cuyo `user_scopes.values` dice '30' dejan de matchear
  // CUALQUIER fila y ven CERO, sin un solo error en el log. Medido en prod antes de escribirlo:
  // aide_piceno ['07','30'] · cesar_plascencia · eduardo_miranda · enrique_herrera ·
  // gloria_ortega · guillermo_hernandez · jose_herrera · joseph_guerrero.
  const sc = await knex.raw(
    `UPDATE identity.user_scopes
        SET values = array_replace(values, '30', '08')
      WHERE dimension = 'warehouse' AND values @> ARRAY['30']`);
  console.log(`  alcance: ${sc.rowCount} user_scopes con '30' reescritos a '08'`);

  const huerfanos = Number((await knex.raw(
    `SELECT count(*)::int n FROM identity.user_scopes
      WHERE dimension = 'warehouse' AND values @> ARRAY['30']`)).rows[0].n);
  if (huerfanos) throw new Error(`ABORT: quedaron ${huerfanos} alcances apuntando a '30', que `
    + `después del renombre ya no llavea nada. Verían cero en silencio.`);

  // ── 8. Verificación final ─────────────────────────────────────────────────────────────────
  const fin = (await knex.raw(
    `SELECT w.code, w.name, w.kepler_code, w.wincaja_source_branch AS win,
            (SELECT count(*)::int FROM commercial.warehouses x
              WHERE x.tenant_id = w.tenant_id AND x.source_warehouse_id = w.id) AS surte_a
       FROM commercial.warehouses w WHERE w.tenant_id = ? AND w.code = '08'`, [M])).rows;
  if (fin.length !== 1) throw new Error(`ABORT: quedaron ${fin.length} almacenes con code '08'.`);
  const sobra = Number((await knex.raw(
    `SELECT count(*)::int n FROM commercial.warehouses WHERE tenant_id = ? AND code = 'MD-30'`,
    [M])).rows[0].n);
  if (sobra) throw new Error(`ABORT: el sufijo MD-30 sigue existiendo (${sobra} filas).`);

  console.log(`  ✓ un solo almacén '08' — ${fin[0].name}, kepler=${fin[0].kepler_code}, `
    + `wincaja=${fin[0].win}, surte a ${fin[0].surte_a} almacén(es)`);
  console.log(`  ✓ ${purgadas} filas derivadas Wincaja purgadas · sin sufijo MD-30`);
  console.log(`\n  ⚠️ DECLARADO — existencia: se fueron ${stockAntes} SKUs de la foto Wincaja. `
    + `Kepler md_08 trae hoy ~2,975 en kdik/kdil, así que faltan ~${stockAntes - 2975} SKUs por `
    + `CARGAR EN EL POS. Hasta entonces Abastos muestra menos catálogo del que vende. Dueño: Sistemas.`);
  console.log(`  ⚠️ PENDIENTE operativo: correr 'import-branch-stock-live --full' para que `
    + `commercial.stock de la '08' deje de estar en cero (el diff por snapshot no lo va a llenar solo).`);
};

exports.down = async function down() {
  // No reversible automáticamente, y decirlo es más honesto que fingir un rollback:
  //  · las 6 tablas derivadas del lado Wincaja se BORRARON (se reconstruyen con los feeds, no acá);
  //  · las ~12,600 filas repuntadas ya no distinguen de qué era venían.
  // Para volver atrás: recrear la fila '08' con 20260919130000 y renombrar ésta a 'MD-30' a mano,
  // sabiendo que la separación de eras no se recupera.
  throw new Error('20260921120000_fusion_morelia_abastos_08: sin rollback automático — '
    + 'fusionar almacenes borra la frontera entre las dos eras. Ver el comentario de `down`.');
};
