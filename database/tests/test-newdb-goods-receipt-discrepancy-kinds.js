#!/usr/bin/env node
/**
 * `[RE.45]` — **Todo `discrepancy_kind` que el código escribe, la base lo admite.**
 *
 * `[RE.14.3]` empezó a escribir `'gemela'` y el CHECK `chk_grp_discrepancy_kind` (RE.2) tenía una
 * lista cerrada sin él: el `attach` de una factura que cuadra con la captura de oficinas iba a dar
 * 500. Ninguna prueba lo vio porque ninguna ejercía ese camino (medido en prod: 9 pares con montos
 * distintos y 0 evidencias en ellos — falla latente).
 *
 * Esta prueba no depende de que alguien recorra ese camino: lee los literales `kind: '…'` del
 * servicio y los compara con la definición VIVA de la restricción.
 *
 * Prueba negativa hecha (2026-10-21): contra prod ANTES de `20261021110554` falta `gemela` → rojo.
 *
 * Correr: node database/tests/test-newdb-goods-receipt-discrepancy-kinds.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0, noMedido = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const sinMedir = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

const SERVICIO = path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/goods-receipt-proofs.service.ts');

/** Los valores que el código puede escribir en `discrepancy_kind`: todo `kind: '<x>'` del servicio. */
function kindsDelCodigo() {
  const src = fs.readFileSync(SERVICIO, 'utf8');
  return [...new Set([...src.matchAll(/\bkind:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

/** Los valores que la restricción admite, de su definición (`... IN ('a','b')` o `= ANY (ARRAY['a'::text, ...])`). */
function kindsDeLaRestriccion(def) {
  return [...new Set([...String(def || '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

(async () => {
  try {
    console.log('\n═══ 1. Lo que el código escribe ═══');
    const codigo = kindsDelCodigo();
    ok(codigo.length >= 4, `el servicio escribe ${codigo.length} valor(es): ${codigo.join(', ')}`);
    ok(codigo.includes('gemela'), 'incluye `gemela` (RE.14.3) — si desaparece, revisar esta prueba');

    // El extractor de la restricción, contra las dos formas en que Postgres la puede devolver.
    ok(kindsDeLaRestriccion(`CHECK (discrepancy_kind = ANY (ARRAY['cuadra'::text, 'iva'::text]))`).join() === 'cuadra,iva',
      'lee la forma `= ANY (ARRAY[...])` que devuelve pg_get_constraintdef');

    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      sinMedir('sin DATABASE_URL_NEW: no se puede leer la restricción viva');
    } else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 2 },
      });
      try {
        console.log('\n═══ 2. Lo que la base admite ═══');
        const { rows } = await knex.raw(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'finance.goods_receipt_proofs'::regclass AND conname = 'chk_grp_discrepancy_kind'`);
        if (!rows.length) {
          sinMedir('la restricción no existe en este ambiente (nada que contradecir)');
        } else {
          const admite = kindsDeLaRestriccion(rows[0].def);
          const faltan = codigo.filter((k) => !admite.includes(k));
          ok(faltan.length === 0,
            faltan.length ? `el código escribe valores que el CHECK RECHAZA (attach daría 500): ${faltan.join(', ')}`
              : `los ${codigo.length} valores que escribe el código están admitidos`);
        }
      } finally { await knex.destroy(); }
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)${noMedido ? ` · ${noMedido} NO MEDIDO(S)` : ''}`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  }
  process.exit(fail === 0 ? 0 : 1);
})();
