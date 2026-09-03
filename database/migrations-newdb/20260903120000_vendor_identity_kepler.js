/**
 * RS.11 / PARIDAD Kepler↔Wincaja — siembra la identidad de vendedor para KEPLER en
 * `analytics.vendor_identity` (que hasta hoy era 100% Wincaja: source_branch 10/30/50).
 *
 * Por qué (parte del cableado 1:1 Kepler↔Wincaja): `sellOutByVendor()` ya empuja las filas Kepler de
 * `analytics.mv_kepler_sales_daily` por el MISMO loop de identidad (canonVendor + isNoiseVendor), pero
 * el mapa no las reconocía → (1) los pseudo-vendedores Kepler (pisos, e-commerce, "otros ingresos") se
 * colaban como columnas de vendedor con dinero real (isNoiseVendor sólo filtra '' / 00 / 99); (2) el
 * mismo humano se partía en su código Wincaja pre-cutover y su código Kepler post-cutover. Al sembrar
 * estas filas, ambos problemas se arreglan SIN tocar el servicio (canonVendor ya resuelve el merge y el
 * exclude). La llave Kepler es (sucursal, kdm1.c12) — el código se reusa entre sucursales para PERSONAS
 * distintas, por eso NUNCA colapsar por c12 pelado.
 *
 * Todo DERIVADO de kepler_ods.kduv (catálogo de vendedores, fresco) + restringido a los (sucursal:c12)
 * que REALMENTE aparecen en el by-vendor (canal mayoreo/credito). NADA inventado.
 *
 * EXCLUDE (pseudo-vendedores, criterio OBJETIVO por nombre kduv: PISO / E-COMMERCE / OTROS INGRESOS):
 *   son buckets de venta, no personas → se ocultan del desglose por vendedor (igual que la migración
 *   Wincaja 20260805230000). Los "Sin vendedor" (c12 vacío) ya los caza isNoiseVendor, no necesitan fila.
 *
 * MERGE (canonical_key COMPARTIDA con el hermano Wincaja → colapsan a UNA columna a través del cutover):
 *   verificado por NOMBRE EXACTO + cutover conocido de la sucursal. Confirmable/reversible (auditable):
 *     01:10002 SERGIO  → sergio-mendoza   (hermano Wincaja 10:75)
 *     01:10001 CINTHIA → cinthia-delvalle (hermano Wincaja 10:72)  [+ 04:10001, misma persona, otra plaza]
 *     06:30003 DANIEL  → daniel-franco    (hermano Wincaja 50:23)
 *   Los demás vendedores Kepler reales (Paulina 02:1, José Ramón 06:30004, etc.) quedan pass-through
 *   (canonVendor devuelve código+nombre kduv) — sin fila, sin merge, ya salen nombrados.
 *
 * Idempotente: INSERT ... ON CONFLICT DO UPDATE (mismo patrón que el seed Wincaja).
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// [source_branch, vendedor(c12), canonical_name]  — exclude=true
const EXCLUDE = [
  ['01', '10003', 'SUCURSAL PADRE HIDALGO PISO'],
  ['01', '10004', 'SUCURSAL 8 ESQUINAS PISO'],
  ['01', '00002', 'E-COMMERCE'],
  ['02', '2', 'VENTAS DE PISO LA PIEDAD ABASTO'],
  ['03', '2', 'VENTAS DE PISO'],
  ['03', '10004', 'SUCURSAL 8 ESQUINAS PISO'],
  ['04', '2', 'VENTAS DE PISO'],
  ['04', '10006', 'SUCURSAL YURECUARO PISO'],
  ['05', '2', 'VENTAS DE PISO'],
  ['05', '30001', 'SUCURSAL ZAMORA CENTRO PISO'],
  ['06', '30001', 'SUCURSAL CANINDO PISO'],
  ['06', '00001', 'OTROS INGRESOS'],
];

// [source_branch, vendedor(c12), canonical_key, canonical_name]  — merge con hermano Wincaja
const MERGE = [
  ['01', '10002', 'sergio-mendoza', 'Sergio Francisco Mendoza Pérez'],
  ['01', '10001', 'cinthia-delvalle', 'Cinthia Yareth del Valle Rueda'],
  ['04', '10001', 'cinthia-delvalle', 'Cinthia Yareth del Valle Rueda'],
  ['06', '30003', 'daniel-franco', 'Daniel Franco Martínez'],
];

exports.up = async function (knex) {
  for (const [sb, ve, name] of EXCLUDE) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, true, 'Kepler: no es vendedor (bucket/piso) — derivado de kduv, oculto del desglose')
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET exclude = true, canonical_name = EXCLUDED.canonical_name, updated_at = now()`,
      [T, sb, ve, `kepler-${sb}-${ve}`, name],
    );
  }
  for (const [sb, ve, key, name] of MERGE) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, false, 'Kepler: merge cross-cutover con hermano Wincaja (nombre exacto + cutover) — confirmable')
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name, exclude = false, updated_at = now()`,
      [T, sb, ve, key, name],
    );
  }
};

exports.down = async function (knex) {
  const all = [...EXCLUDE.map((r) => [r[0], r[1]]), ...MERGE.map((r) => [r[0], r[1]])];
  for (const [sb, ve] of all) {
    await knex.raw(`DELETE FROM analytics.vendor_identity WHERE tenant_id = ? AND source_branch = ? AND vendedor = ?`, [T, sb, ve]);
  }
};
