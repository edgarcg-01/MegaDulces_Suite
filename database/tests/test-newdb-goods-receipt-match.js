#!/usr/bin/env node
/**
 * `[RE.43]` — **¿De qué entrada es este papel?** El folio del PROVEEDOR va contra `referencia`.
 *
 * Caso que lo motivó (prod, 2026-10-21): la nota `0666` de EL FAROLITO se enlazó sola a
 * `01/0000666` (otro proveedor, otra sucursal) porque el folio del papel se comparaba con NUESTRO
 * folio de entrada. Kepler guarda el del proveedor en `referencia` (`30-0666`).
 *
 * Se carga el `.ts` REAL (`emparejar-papel.ts`) y se corre el SQL que él genera. Bloques:
 *   1. Reglas sin DB: qué llave usa cada hoja, sufijo, y la PRUEBA NEGATIVA del sufijo corto.
 *   2. `sqlNucleoReferencia` ≡ `nucleoReferencia` y `sqlSufijoReferencia` ≡ `esSufijoDeReferencia`,
 *      sobre casos fijos + las referencias reales del ambiente.
 *   3. Los dos filtros corren contra la vista real dentro de 1 s.
 *
 * Correr: node database/tests/test-newdb-goods-receipt-match.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0, noMedido = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const sinMedir = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const {
  llaveDelFolio, nucleoReferencia, esSufijoDeReferencia, sqlNucleoReferencia, sqlSufijoReferencia,
} = require(path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/emparejar-papel.ts'));
const { folioNucleo } = require(path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/documento-duplicado.ts'));

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  try {
    console.log('\n═══ 1. Reglas (sin DB) ═══');
    ok(llaveDelFolio('factura', '0666') === 'proveedor', 'el folio de una factura es del PROVEEDOR aunque empiece con cero (el caso de prod)');
    ok(llaveDelFolio('orden_entrada', '0000666') === 'nuestro', 'nuestra orden de entrada trae NUESTRO folio');
    ok(nucleoReferencia('30-0666') === folioNucleo('0666'), '`30-0666` (Kepler) casa con la nota `0666`');
    ok(esSufijoDeReferencia(folioNucleo('IC - 3384616'), nucleoReferencia('10-4616')), 'cola de 4: `IC - 3384616` ↔ `10-4616` (caso real)');
    ok(!esSufijoDeReferencia('20666', '666'), 'PRUEBA NEGATIVA: una cola de 3 no alcanza');

    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      sinMedir('sin DATABASE_URL_NEW: bloques 2–3 (espejo SQL y la vista real)');
    } else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 3 },
      });
      try {
        console.log('\n═══ 2. TS y SQL deciden igual ═══');
        const fijos = ['30-0666', '10-071026', 'F-A-12345', ' 30 - 0666', '30-07', '', '3-0666', '300666', '0-N-070926', '30-ABA188'];
        const { rows: reales } = await knex.raw(
          `SELECT DISTINCT referencia AS r FROM analytics.erp_goods_receipts WHERE tenant_id = ? AND referencia IS NOT NULL LIMIT 20000`, [T]);
        const refs = [...new Set([...fijos, ...reales.map((x) => x.r)])];
        const { rows: n } = await knex.raw(
          `SELECT v.i, ${sqlNucleoReferencia('v.r')} AS n FROM unnest(ARRAY[?]::text[]) WITH ORDINALITY AS v(r, i)`, [refs]);
        let d1 = 0;
        for (const r of n) {
          const sqlN = r.n.length >= 3 ? r.n : null;
          if (nucleoReferencia(refs[Number(r.i) - 1]) !== sqlN) { d1++; if (d1 <= 3) console.error(`     "${refs[Number(r.i) - 1]}" TS≠SQL`); }
        }
        ok(d1 === 0, `núcleo de referencia: TS y SQL iguales en ${refs.length} (${reales.length} reales; discrepan ${d1})`);

        // Sufijo: cada referencia contra papeles armados para casar, para no casar y casos borde.
        const pares = [];
        for (const r of refs.slice(0, 3000)) {
          const rn = nucleoReferencia(r) || '';
          pares.push([r, `9${rn}`], [r, rn], [r, `${rn}1`], [r, '3384616']);
        }
        // El SQL del sufijo trae `?` para el núcleo del papel: se sustituyen por la columna `v.p`
        // para evaluar EL MISMO texto sobre todos los pares en una consulta.
        const sufijoCol = sqlSufijoReferencia('v.r').split('?').join('v.p');
        const { rows: s } = await knex.raw(
          `SELECT v.i, (${sufijoCol}) AS es FROM unnest(ARRAY[?]::text[], ARRAY[?]::text[]) WITH ORDINALITY AS v(r, p, i)`,
          [pares.map((x) => x[0]), pares.map((x) => x[1])]);
        let d2 = 0;
        for (const r of s) {
          const [ref, papel] = pares[Number(r.i) - 1];
          if (Boolean(r.es) !== esSufijoDeReferencia(papel, nucleoReferencia(ref))) { d2++; if (d2 <= 3) console.error(`     "${ref}" × "${papel}" TS≠SQL`); }
        }
        ok(d2 === 0, `sufijo: TS y SQL iguales en ${pares.length} pares (casan, no casan, folio entero, cola corta; discrepan ${d2})`);

        console.log('\n═══ 3. Contra la vista real ═══');
        const base = `FROM analytics.erp_goods_receipts c WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.receipt_date >= current_date - 120`;
        let t0 = Date.now();
        const { rows: a } = await knex.raw(`SELECT c.sucursal, c.folio ${base} AND ${sqlNucleoReferencia('c.referencia')} = ?`, [T, '666']);
        const ms1 = Date.now() - t0;
        t0 = Date.now();
        const { rows: b } = await knex.raw(`SELECT c.sucursal, c.folio ${base} AND ${sqlSufijoReferencia('c.referencia')}`, [T, '3384616', '3384616']);
        const ms2 = Date.now() - t0;
        ok(Array.isArray(a) && Array.isArray(b), `los dos filtros corren con sus bindings (${a.length} y ${b.length} fila(s))`);
        ok(ms1 < 1000 && ms2 < 1000, `dentro de 1 s (referencia ${ms1} ms · sufijo ${ms2} ms; medido en prod: 78 y 81 ms)`);
      } finally { await knex.destroy(); }
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)${noMedido ? ` · ${noMedido} NO MEDIDO(S)` : ''}`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  }
  process.exit(fail === 0 ? 0 : 1);
})();
