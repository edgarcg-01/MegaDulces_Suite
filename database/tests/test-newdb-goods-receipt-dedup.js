#!/usr/bin/env node
/**
 * `[RE.42]` — **¿Este papel del proveedor ya se subió?** Emisor + folio, nunca el folio solo.
 *
 * Caso que lo motivó (prod, 2026-10-20): la nota `0666` de EL FAROLITO no se podía subir porque
 * la `0666` de DULCELICIAS ya estaba en `01/0000589`. El dedup viejo "cuidaba" al proveedor con el
 * RFC de Kepler, que viene vacío en el 42% de las entradas, y con eso el folio chocaba contra
 * CUALQUIER proveedor (394 folios comodín medidos).
 *
 * Se carga el `.ts` REAL vía ts-node y se corre el SQL REAL (`SQL_CANDIDATOS_DUPLICADO`, el mismo
 * texto que usa el servicio). Bloques:
 *   1. Reglas sin DB: el caso de prod y lo que tiene que seguir bloqueando.
 *   2. El espejo SQL de `folioNucleo()` decide igual que el TS (casos fijos + los folios reales).
 *   3. El SQL de candidatos corre con sus 7 bindings y devuelve la forma que el servicio lee.
 *   4. Sobre los papeles reales: NINGÚN bloqueo entre proveedores de Kepler distintos, y el control
 *      positivo — un papel real contra sí mismo en otra entrada SÍ bloquea.
 *
 * Correr: node database/tests/test-newdb-goods-receipt-dedup.js
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
  veredictoDuplicado, folioNucleo, papelesDeFila, SQL_CANDIDATOS_DUPLICADO,
} = require(path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/documento-duplicado.ts'));

const PROPIO = 'LOGL851014AQ5';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  try {
    // ── 1. Reglas ───────────────────────────────────────────────────────────
    console.log('\n═══ 1. Reglas (sin DB) ═══');
    const dulcelicias = { sha256: 'a', folio: '0666', rfc: 'MEAM8008293J4', total: 1150, proveedorCode: 'CD43', proveedorNombre: 'DULCELICIAS' };
    const opts = { rfcPropio: PROPIO, tolerancia: 1 };
    ok(veredictoDuplicado({ sha256: 'b', folio: '0666', rfc: 'CUMG660606M75', total: 22500 }, dulcelicias, opts).nivel === 'distinto',
      'el caso de prod: misma 0666, RFC de emisor distinto → NO es duplicado');
    ok(veredictoDuplicado({ folio: '0666', proveedorCode: 'CE011' }, dulcelicias, opts).nivel === 'distinto',
      'el caso de prod al adjuntar: proveedor de Kepler CE011 ≠ CD43 → NO es duplicado');
    ok(veredictoDuplicado({ sha256: 'a' }, dulcelicias, opts).nivel === 'bloquea',
      'PRUEBA NEGATIVA: el mismo PDF sigue bloqueando');
    ok(veredictoDuplicado({ folio: '666', proveedorCode: 'CD43', total: 1150 }, dulcelicias, opts).nivel === 'bloquea',
      'PRUEBA NEGATIVA: mismo proveedor + mismo folio (escrito distinto) sigue bloqueando');
    ok(veredictoDuplicado({ folio: '0666', rfc: PROPIO }, { folio: '0666', rfc: PROPIO }, opts).nivel === 'avisa',
      'nuestro RFC leído en los dos papeles no prueba emisor: avisa, no bloquea');

    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      sinMedir('sin DATABASE_URL_NEW: bloques 2–4 (espejo SQL, el SQL real y los papeles reales)');
    } else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 3 },
      });
      try {
        // ── 2. El espejo SQL de folioNucleo ───────────────────────────────────
        console.log('\n═══ 2. folioNucleo: TS y SQL deciden igual ═══');
        const fijos = ['0666', '666', 'No. 0666', 'A-0666', 'XA2001-0000140', 'F 97340', '10-3344', '000', '07', '', 'REM 8842'];
        const { rows: reales } = await knex.raw(
          `SELECT DISTINCT f FROM (
             SELECT ocr_folio AS f FROM finance.goods_receipt_proofs WHERE tenant_id = ?
             UNION ALL
             SELECT e->>'ocr_folio' FROM finance.goods_receipt_proofs p, jsonb_array_elements(COALESCE(p.files,'[]'::jsonb)) e WHERE p.tenant_id = ?
           ) x WHERE f IS NOT NULL LIMIT 5000`, [T, T]);
        const todos = [...new Set([...fijos, ...reales.map((r) => r.f)])];
        const { rows: sql } = await knex.raw(
          `SELECT v.i, ltrim(regexp_replace(COALESCE(v.f, ''), '\\D', '', 'g'), '0') AS n
             FROM unnest(ARRAY[?]::text[]) WITH ORDINALITY AS v(f, i)`, [todos]); // knex expande el arreglo a ?,?,…
        let discrepan = 0;
        for (const r of sql) {
          const ts = folioNucleo(todos[Number(r.i) - 1]);
          // El SQL no filtra largo: el TS devuelve null bajo FOLIO_MINIMO. Se compara el núcleo.
          const sqlN = r.n.length >= 3 ? r.n : null;
          if (ts !== sqlN) { discrepan++; if (discrepan <= 3) console.error(`     "${todos[Number(r.i) - 1]}": TS=${ts} SQL=${sqlN}`); }
        }
        ok(discrepan === 0, `TS y SQL dan el mismo núcleo en ${todos.length} folios (${reales.length} reales; discrepan: ${discrepan})`);

        // ── 3. El SQL de candidatos, tal cual lo corre el servicio ─────────────
        console.log('\n═══ 3. El SQL real de candidatos ═══');
        const t0 = Date.now();
        const { rows: cand } = await knex.raw(SQL_CANDIDATOS_DUPLICADO, ['', '', '666', '666', '666', '666', T]);
        const ms = Date.now() - t0;
        ok(Array.isArray(cand), `corre con sus 7 bindings (${cand.length} candidato(s) para el núcleo 666, ${ms} ms)`);
        ok(ms < 1000, `dentro del presupuesto de 1 s (medido ${ms} ms; con LEFT JOIN directo a la vista eran 11.7 s)`);
        if (cand.length) {
          const forma = ['sucursal', 'folio', 'f_sha', 'f_role', 'f_folio', 'f_rfc', 'f_total', 'p_folio', 'p_rfc', 'p_total', 'proveedor_code', 'vigente'];
          ok(forma.every((k) => k in cand[0]), 'trae las columnas que el servicio lee');
          ok(cand.every((r) => typeof r.vigente === 'boolean'), '`vigente` es booleano (no null) en todas las filas');
        } else {
          sinMedir('no hay papeles con núcleo 666 en este ambiente: la forma de la fila queda sin ver');
        }

        // ── 4. Los papeles reales ─────────────────────────────────────────────
        console.log('\n═══ 4. Sobre los papeles reales ═══');
        // `SQL_CANDIDATOS_DUPLICADO` filtra por UN núcleo; el universo se arma con la misma forma
        // de fila para pasarlo por el mismo `papelesDeFila()` que usa el servicio.
        const { rows: universo } = await knex.raw(
          `WITH c AS MATERIALIZED (
             SELECT p.sucursal, p.folio, p.proveedor_nombre, p.ocr_proveedor,
                    p.ocr_folio AS p_folio, p.ocr_rfc AS p_rfc, p.ocr_monto::float8 AS p_total,
                    e->>'sha256' AS f_sha, e->>'role' AS f_role, e->>'ocr_folio' AS f_folio,
                    e->>'ocr_rfc' AS f_rfc, e->>'ocr_total' AS f_total
               FROM finance.goods_receipt_proofs p
               LEFT JOIN LATERAL jsonb_array_elements(COALESCE(p.files, '[]'::jsonb)) e ON true
              WHERE p.tenant_id = ? AND (e IS NULL OR e->>'role' IN ('remision','factura')))
           SELECT c.*, g.proveedor_code, (g.folio IS NOT NULL) AS vigente
             FROM c LEFT JOIN LATERAL (
               SELECT x.proveedor_code, x.folio FROM analytics.erp_goods_receipts x
                WHERE x.tenant_id = ? AND x.sucursal = c.sucursal AND x.folio = c.folio LIMIT 1) g ON true`, [T, T]);
        const papeles = universo.flatMap((r) => papelesDeFila(r).map((p) => ({ ent: `${r.sucursal}/${r.folio}`, vig: r.vigente, p })));
        if (!papeles.length) {
          sinMedir('no hay papeles fiscales en este ambiente');
        } else {
          let bloqOtroProv = 0, pares = 0, control = null;
          const porNucleo = new Map();
          for (const x of papeles) {
            const n = folioNucleo(x.p.folio);
            if (n) (porNucleo.get(n) ?? porNucleo.set(n, []).get(n)).push(x);
            if (!control && x.vig && x.p.sha256 && x.p.proveedorCode) control = x;
          }
          for (const grupo of porNucleo.values()) {
            for (const a of grupo) for (const b of grupo) {
              if (a.ent === b.ent || !b.vig || !a.p.proveedorCode || !b.p.proveedorCode) continue;
              pares++;
              const v = veredictoDuplicado(a.p, b.p, opts);
              if (v.nivel === 'bloquea' && a.p.proveedorCode !== b.p.proveedorCode && v.emisor !== 'rfc_papel') bloqOtroProv++;
            }
          }
          ok(bloqOtroProv === 0,
            `ningún bloqueo entre proveedores de Kepler distintos en ${pares} pares reales con el mismo folio (bloqueos: ${bloqOtroProv})`);
          if (control) {
            const v = veredictoDuplicado({ ...control.p }, { ...control.p }, opts);
            ok(v.nivel === 'bloquea', `CONTROL POSITIVO: un papel real (${control.ent}) contra sí mismo bloquea (${v.motivo})`);
          } else {
            sinMedir('ningún papel real con hash y proveedor: el control positivo queda sin correr');
          }
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
