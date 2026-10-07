/* eslint-disable no-console */
/**
 * Recrea la vista `dic.stock` en kepler_consolidado con la fórmula de existencia
 * CORRECTA de Kepler: existencia = kdil.c4 + kdil.c8 − kdil.c9 (inicial + entradas
 * − salidas), verificada contra el reporte "Existencia por productos"
 * (invrepexsrep.kpl). Antes usaba `s.c9` solo (= SALIDAS) → existencia inflada/mal.
 *
 * Caveat: c4 (inicial) llega en 0 en el branch, así que productos con inventario
 * físico previo dan negativo → se pisan a 0 con GREATEST. Esos (~2–10% por
 * sucursal) requieren el CSV export del reporte de Kepler para exactitud total.
 * Ver docs/IMPLEMENTACION/KEPLER_TABLAS_COMPLETO.md (nota kdil/kdik).
 *
 *   node database/scripts/fix-dic-stock-view.js
 */
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO
  || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const BRANCHES = ['md_00', 'md_01', 'md_02', 'md_03', 'md_04', 'md_05'];

(async () => {
  const db = new Client({ connectionString: SRC });
  await db.connect();
  try {
    const parts = BRANCHES.map((b) => `
 SELECT '${b}'::text AS sucursal, s.c3 AS sku, p.c2 AS nombre,
        GREATEST(s.c4 + s.c8 - s.c9, 0) AS existencia,
        k.c16 AS costo_unitario,
        GREATEST(s.c4 + s.c8 - s.c9, 0) * k.c16 AS valor_inventario
   FROM ${b}.kdil s
   LEFT JOIN ${b}.kdii p ON p.c1::text = s.c3::text
   LEFT JOIN ${b}.kdik k ON k.c2::text = s.c3::text`);
    await db.query(`CREATE OR REPLACE VIEW dic.stock AS\n${parts.join('\nUNION ALL\n')};`);
    console.log('dic.stock recreada (existencia = c4 + c8 − c9, floor 0).');
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
