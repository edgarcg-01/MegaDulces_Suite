/**
 * Mayoreo — enlace 1-a-1 Kepler↔Wincaja tras el cutover (identidad canónica).
 *
 * PROBLEMA: la sucursal 10 (mayoreo Wincaja) y Canindo (50) pasaron su venta de Wincaja a
 * Kepler a mediados de 2026 (cutover). La MISMA persona sigue vendiendo bajo un vendor_code
 * KEPLER nuevo, pero como `vendor_identity` no enlazaba el código Wincaja (que "muere" en el
 * cutover) con su gemelo Kepler (que sigue vivo), el reporte por-vendedor los mostraba como DOS
 * vendedores: uno inactivo desde jun/ago-2026 y otro nuevo. Medido: Sergio $53.3M (10:75) partido
 * de su continuación 01:10002; Yareth/Cinthia $28.3M; Daniel Canindo $97.5M; José Ramón $6.97M.
 *
 * FIX: un `canonical_key` COMPARTIDO por los dos (o tres) códigos → `canonVendor` los funde en un
 * solo vendedor continuo. Mapeo confirmado por el usuario 2026-09-08 (Yareth=Cinthia Yaret;
 * Daniel Martinez=Daniel Franco, misma persona). `vendor_identity` se lee EN VIVO → efecto
 * inmediato, sin re-materializar. Idempotente (UPSERT). exclude=false (todos activos).
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';
// [source_branch, vendedor, canonical_key, canonical_name, note]
const ROWS = [
  // Sergio Francisco Mendoza Perez — Wincaja 10:75 (hasta jun-2026) = Kepler 01:10002 (jul+)
  ['10', '75',    'sergio-mendoza',          'Sergio Francisco Mendoza Perez',  'Mayoreo. Wincaja 10:75 (hasta jun-2026) = Kepler 01:10002. Cutover suc.10.'],
  ['01', '10002', 'sergio-mendoza',          'Sergio Francisco Mendoza Perez',  'Mayoreo Kepler — continuación de Wincaja 10:75.'],
  // Cinthia Yaret del Valle Rueda (alias "Yareth") — Wincaja 10:72 (hasta jun) = Kepler 01:10001
  ['10', '72',    'cinthia-yaret',           'Cinthia Yaret del Valle Rueda',   'Mayoreo. Wincaja 10:72 "YARETH" (hasta jun-2026) = Kepler 01:10001. Confirmado.'],
  ['01', '10001', 'cinthia-yaret',           'Cinthia Yaret del Valle Rueda',   'Mayoreo Kepler — continuación de Wincaja 10:72 "Yareth".'],
  // Jose Ramon Rodriguez Varela — Wincaja 50:33 (hasta ago) = Kepler 06:30004
  ['50', '33',    'jose-ramon-rodriguez',    'Jose Ramon Rodriguez Varela',     'Mayoreo Canindo. Wincaja 50:33 (hasta ago-2026) = Kepler 06:30004. Cutover 14-ago.'],
  ['06', '30004', 'jose-ramon-rodriguez',    'Jose Ramon Rodriguez Varela',     'Mayoreo Kepler — continuación de Wincaja 50:33.'],
  // Daniel Francisco Franco Martinez — Wincaja 50:23 + 50:17 = Kepler 06:30003 (confirmado misma persona)
  ['50', '23',    'daniel-francisco-franco', 'Daniel Francisco Franco Martinez','Mayoreo Canindo. Wincaja 50:23 (hasta ago-2026) = Kepler 06:30003. Cutover 14-ago.'],
  ['50', '17',    'daniel-francisco-franco', 'Daniel Francisco Franco Martinez','Mayoreo. Wincaja 50:17 (mismo Daniel; confirmado usuario 2026-09-08).'],
  ['06', '30003', 'daniel-francisco-franco', 'Daniel Francisco Franco Martinez','Mayoreo Kepler — continuación de Daniel Franco.'],
];

exports.up = async function (knex) {
  for (const [sb, ven, key, name, note] of ROWS) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, false, ?)
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name,
                     exclude = false, note = EXCLUDED.note, updated_at = now()`,
      [T, sb, ven, key, name, note],
    );
  }
};

exports.down = async function (knex) {
  for (const [sb, ven] of ROWS) {
    await knex.raw(`DELETE FROM analytics.vendor_identity WHERE tenant_id = ? AND source_branch = ? AND vendedor = ?`, [T, sb, ven]);
  }
};
