'use strict';
/**
 * ⭐⭐ `[CGA-C.3]` — **Proveedores BORRADOS del catálogo a los que se les sigue pagando.**
 *
 *   node database/scripts/check-proveedor-borrado-con-pagos.js
 *   node database/scripts/check-proveedor-borrado-con-pagos.js --desde=2026-01-01
 *   node database/scripts/check-proveedor-borrado-con-pagos.js --self-test
 *
 * Sólo lee. **Exit 0 siempre**: un proveedor borrado que cobra es un hecho de la operación que
 * alguien tiene que resolver, no una regresión que haya que bloquear.
 *
 * ── De dónde sale, medido contra prod el 2026-10-16 ─────────────────────────────────────────
 *
 * Buscando los 10 proveedores de efectivo que «faltaban» en `catalog.suppliers` resultó que **no
 * faltan: están borrados**. Y el problema es más grande que esos 10:
 *
 *     2026-07-16   63 filas borradas
 *     2026-07-20  260 filas borradas   ← un borrado masivo, en un día
 *     2026-08-08    1 fila
 *                 ---
 *                 324 proveedores soft-deleted, TODOS con `deleted_by` en NULL
 *
 * De esos 324, **22 siguen recibiendo pagos en 2026 por $11,220,546.79**, y **10 de ellos en
 * efectivo ($1,951,182.86)**. El pago más reciente a un proveedor borrado es del **2026-10-12**.
 * Entre ellos **BIMBO** ($4,309,779.24, último pago el 08-oct) y **DULJAL** ($727,938.06, 12-oct).
 *
 * ⛔ **Por qué importa más allá del catálogo:** toda pantalla que filtre `deleted_at IS NULL`
 * —que son casi todas— **no ve a esos proveedores**. No es que muestren un dato viejo: muestran
 * un universo incompleto, y la falta no se nota porque nada dice «faltan 22».
 *
 * ⚠️ `catalog.suppliers.activo` **no es GENERATED** (verificado: `is_generated = NEVER`), así que
 * puede disentir de `deleted_at`. Este check mira `deleted_at`, que es lo que filtran las
 * consultas.
 *
 * ── Por qué ESTA forma ──────────────────────────────────────────────────────────────────────
 *
 * ⛔ **No propone restaurar.** Un proveedor puede estar borrado con razón y seguir recibiendo el
 * pago de una deuda vieja. Lo que el check afirma es más chico y más cierto: *«a éste se le pagó
 * después de borrarlo»*. Separa **borrado antes del último pago** (sospechoso) de **borrado
 * después** (probablemente correcto), porque son dos conversaciones distintas.
 *
 * ── La prueba negativa, y por qué la primera versión no servía ──────────────────────────────
 *
 * ⚠️ Empecé comparando el join con `btrim` contra uno sin él. **Los dos dan 22**, así que esa
 * prueba no demostraba nada: es el caso que este repo llama *«comparar la consulta consigo
 * misma»*. Se mide igual, pero como dato informativo, no como aserción.
 *
 * ⭐ Lo que sí muerde es **mutar el predicado del que depende todo el detector**: con
 * `deleted_at IS NULL` el universo da **292** y sin filtro **314**, contra los **22** del
 * detector. El `--self-test` exige que las dos mitades sumen el universo — si el filtro dejara
 * de discriminar, la compuerta listaría a cualquiera que cobra y se vería igual de llena.
 * Verificado en los dos sentidos: **exit 1** al quitar el filtro, **exit 0** al restaurarlo.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DESDE = (process.argv.find((a) => a.startsWith('--desde=')) || '').split('=')[1] || '2026-01-01';
const SELF = process.argv.includes('--self-test');

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

const PAGOS = `
  SELECT proveedor_code, count(*)::int AS pagos, sum(monto) AS monto,
         max(pago_date) AS ultimo, bool_or(medio_pago = 'caja') AS caja
    FROM analytics.erp_supplier_payments
   WHERE pago_date >= $2::date
   GROUP BY 1`;

/** El join bueno. `btrim` en los dos lados. */
const SQL = `
WITH p AS (${PAGOS})
SELECT btrim(s.code) AS code, s.name,
       to_char(s.deleted_at, 'YYYY-MM-DD') AS borrado_el,
       p.pagos, p.monto, to_char(p.ultimo, 'YYYY-MM-DD') AS ultimo, p.caja,
       (p.ultimo > s.deleted_at::date) AS pagado_despues
  FROM catalog.suppliers s
  JOIN p ON p.proveedor_code = btrim(s.code)
 WHERE s.tenant_id = $1 AND s.deleted_at IS NOT NULL
 ORDER BY p.monto DESC`;

async function main(c) {
  const { rows } = await c.query(SQL, [TENANT, DESDE]);

  const tot = (f) => rows.filter(f).reduce((a, r) => a + Number(r.monto || 0), 0);
  const despues = rows.filter((r) => r.pagado_despues);

  console.log(`\nProveedores BORRADOS de catalog.suppliers con pagos desde ${DESDE}\n`);
  if (!rows.length) { console.log('  Ninguno. (Si esperabas encontrar alguno, revisá el join.)\n'); return; }

  console.log(`  ${rows.length} proveedores · ${money(tot(() => true))}`);
  console.log(`  de ellos EN EFECTIVO: ${rows.filter((r) => r.caja).length} · ${money(tot((r) => r.caja))}`);
  console.log(`  ⛔ PAGADOS DESPUÉS de borrarlos: ${despues.length} · ${money(tot((r) => r.pagado_despues))}\n`);

  console.log(`  ${pad('código', 10)}${pad('nombre', 32)}${pad('borrado', 12)}${padL('monto', 16)}  ${pad('últ. pago', 12)}${pad('efvo', 6)}después`);
  console.log(`  ${'-'.repeat(96)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.code, 10)}${pad(String(r.name).slice(0, 30), 32)}${pad(r.borrado_el, 12)}` +
      `${padL(money(r.monto), 16)}  ${pad(r.ultimo, 12)}${pad(r.caja ? 'sí' : '', 6)}${r.pagado_despues ? '⛔' : ''}`);
  }

  // Cuándo se borraron: un borrado masivo en un día no es lo mismo que una baja a la vez.
  const { rows: olas } = await c.query(`
    SELECT to_char(deleted_at, 'YYYY-MM-DD') AS dia, count(*)::int AS n,
           count(*) FILTER (WHERE deleted_by IS NULL)::int AS sin_autor
      FROM catalog.suppliers WHERE tenant_id = $1 AND deleted_at IS NOT NULL
     GROUP BY 1 ORDER BY 1`, [TENANT]);
  console.log(`\n  Cuándo se borraron (TODOS los del catálogo, no sólo los que cobran):`);
  for (const o of olas) {
    console.log(`    ${o.dia}  ${padL(o.n, 5)} filas` + (o.sin_autor === o.n ? '   (sin autor)' : `   (${o.sin_autor} sin autor)`));
  }
  console.log('');
}

async function selfTest(c) {
  console.log('\n[self-test] El filtro `deleted_at IS NOT NULL` tiene que DISCRIMINAR.\n');
  const n = async (sql) => (await c.query(sql, [TENANT, DESDE])).rows.length;

  const bueno = (await c.query(SQL, [TENANT, DESDE])).rows;
  // La MUTACIÓN que importa: invertir el predicado del que depende todo el detector.
  const vivos = await n(`WITH p AS (${PAGOS})
    SELECT 1 FROM catalog.suppliers s JOIN p ON p.proveedor_code = btrim(s.code)
     WHERE s.tenant_id = $1 AND s.deleted_at IS NULL`);
  // Y quitarlo del todo: si el detector diera esto, estaría listando a cualquiera que cobra.
  const todos = await n(`WITH p AS (${PAGOS})
    SELECT 1 FROM catalog.suppliers s JOIN p ON p.proveedor_code = btrim(s.code)
     WHERE s.tenant_id = $1`);
  // Informativo: hoy el `btrim` no cambia nada, pero se mide en vez de suponerlo.
  const ingenuo = await n(`WITH p AS (${PAGOS})
    SELECT 1 FROM catalog.suppliers s JOIN p ON p.proveedor_code = s.code
     WHERE s.tenant_id = $1 AND s.deleted_at IS NOT NULL`);

  console.log(`  detector (deleted_at IS NOT NULL) → ${bueno.length}`);
  console.log(`  mutado   (deleted_at IS NULL)     → ${vivos}`);
  console.log(`  sin filtro de borrado             → ${todos}`);
  console.log(`  · con el join ingenuo (sin btrim) → ${ingenuo}` +
    (ingenuo === bueno.length ? '  (hoy da igual; se mide, no se supone)' : '  ⚠️ DIFIERE'));

  const fallos = [];
  if (!bueno.length) fallos.push('el detector no encontró nada: o el problema se resolvió, o el filtro se rompió');
  if (vivos <= bueno.length) {
    fallos.push(`la mutación encontró ${vivos} y el detector ${bueno.length}: el filtro de borrado NO discrimina`);
  }
  if (todos !== bueno.length + vivos) {
    fallos.push(`sin filtro da ${todos} y las dos mitades suman ${bueno.length + vivos}: el universo no parte en dos`);
  }
  if (ingenuo > bueno.length) fallos.push(`el join sin btrim encontró MÁS (${ingenuo}): hay duplicados`);

  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); process.exit(1); }
  console.log(`  ✓ El filtro discrimina: ${bueno.length} borrados contra ${vivos} vivos, y las dos mitades`);
  console.log(`    suman el universo (${todos}). Una compuerta que diera lo mismo con el predicado`);
  console.log(`    invertido no estaría midiendo el borrado.\n`);
}

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    await c.query(`SET default_transaction_read_only = on`);
    await c.query(`SET statement_timeout = '120s'`);
    if (SELF) await selfTest(c); else await main(c);
  } finally { await c.end(); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
