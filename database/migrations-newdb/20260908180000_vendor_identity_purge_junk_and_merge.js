/**
 * Sell-Out por vendedor — 2ª barrida de anomalías (junk + duplicado dentro de grupo).
 *
 * Tras enlazar gemelos de mayoreo (mig ...160000) y purgar inactivos (mig ...170000), la simulación
 * de la resolución del servicio sobre las filas crudas de prod (v_sellout_daily, 2025-01+) dejó ver
 * 2 anomalías vivas en la lista FINAL visible:
 *
 *   1. `01:1` "1" — vendedor literalmente llamado "1" (código 1, sucursal PH). Basura/test, $900,
 *      última venta ago-2026. No es persona. → exclude=true (se saca del desglose).
 *   2. `04:10001` "Cinthia Yaret del Valle Rueda" — MISMA persona que `cinthia-yaret` (01:10001+10:72,
 *      $31.7M), pero con un canonical_key DISTINTO (`cinthia-delvalle`) → la partía en 2 columnas del
 *      MISMO grupo (crédito/mayoreo): $31.7M + $253. Es un código extra suyo en Yurécuaro. → se repunta
 *      su canonical_key a `cinthia-yaret` para fundirla en una sola columna. (No queda huérfano:
 *      `cinthia-delvalle` sólo lo usaba esta fila — verificado en prod 2026-09-08.)
 *
 * NO se tocan (revisadas y descartadas): los Joseph 30:94 (crédito Morelia) vs 32:94 (preventa Zamora)
 * son CANALES distintos → 2 columnas por diseño (igual que Candy mayoreo vs vecinal), no un duplicado
 * de grupo; los vendedores de preventa Zamora (32:xx Manuel Herrera/Javier/Ricardo/Fidel/Guillermo)
 * son personas reales activas mostradas por su propio nombre (pass-through), no anomalías.
 *
 * `vendor_identity` se lee EN VIVO → efecto inmediato, sin re-materializar. Idempotente (UPSERT).
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  // 1) Purga del junk "1" (01:1) — exclude=true.
  await knex.raw(
    `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
     VALUES (?, '01', '1', 'purge-junk-01-1', 'Junk "1"', true, ?)
     ON CONFLICT (tenant_id, source_branch, vendedor)
     DO UPDATE SET exclude = true, note = EXCLUDED.note, updated_at = now()`,
    [T, 'Vendedor basura llamado "1" (cód. 1, PH), $900. No es persona. Purga.'],
  );

  // 2) Merge de la Cinthia de Yurécuaro (04:10001) a su identidad canónica cinthia-yaret.
  await knex.raw(
    `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
     VALUES (?, '04', '10001', 'cinthia-yaret', 'Cinthia Yaret del Valle Rueda', false, ?)
     ON CONFLICT (tenant_id, source_branch, vendedor)
     DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name,
                   exclude = false, note = EXCLUDED.note, updated_at = now()`,
    [T, 'Cinthia en Yurécuaro — mismo canónico que 01:10001+10:72 (antes cinthia-delvalle, partía su columna).'],
  );
};

exports.down = async function (knex) {
  // Revertir: 01:1 vuelve a visible (exclude=false); 04:10001 vuelve a su key propio.
  await knex.raw(`UPDATE analytics.vendor_identity SET exclude = false, updated_at = now()
                  WHERE tenant_id = ? AND source_branch = '01' AND vendedor = '1'`, [T]);
  await knex.raw(`UPDATE analytics.vendor_identity SET canonical_key = 'cinthia-delvalle', updated_at = now()
                  WHERE tenant_id = ? AND source_branch = '04' AND vendedor = '10001'`, [T]);
};
