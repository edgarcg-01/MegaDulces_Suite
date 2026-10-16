'use strict';
/**
 * ⭐⭐ `[CGA-A.10]` — **Cobros capturados cuyo importe YA NO coincide con su propia fuente.**
 *
 *   node database/scripts/check-cobro-monto-desfasado.js
 *   node database/scripts/check-cobro-monto-desfasado.js --self-test
 *
 * Sólo lee. **Exit 1 si encuentra algo.** Igual que su hermana `check-cobro-escondido.js`, ésta
 * frena: un importe desfasado no es una decisión de negocio pendiente, es el libro de caja
 * diciendo un número que su fuente desmiente.
 *
 * ── De dónde sale, medido en prod el 2026-10-16 ─────────────────────────────────────────────
 *
 * La ruta 27 entregó $21,240.00 y el libro lo registró en **$120.00**:
 *
 *     CI-2026-00047  01-005|U-A-5|0000015|0011   libro $120.00   fuente $21,240.00
 *
 * ⭐ **La captura CONGELA el importe, y la vista de pendientes excluye por `origen_ref` — no por
 * monto.** O sea que si la fuente se corrige después de capturar (acá el importer re-corrió una
 * hora más tarde y completó los renglones del corte), **el libro se queda con el número viejo y
 * el documento ya nunca vuelve a ofrecerse en la cola**. Nadie lo revisa porque, para la
 * pantalla, ese cobro ya está resuelto.
 *
 * ⛔ **Es el mismo modo de fallar que `GOTCHAS` §86:** el dinero no se pierde ni se duplica —
 * **se vuelve invisible**. Sin error, sin log, sin descuadre que nadie note. Por eso hay que
 * salir a buscarlo: no avisa solo.
 *
 * ⚠️ **No todo desfase es un defecto, y el script no los mezcla.** Quien captura puede redondear
 * a propósito (medido: `CI-2026-00004`, **−$0.38**). Por eso se reportan en dos cubos: lo que
 * cabe en el redondeo de una persona y lo que no. **El exit 1 lo dispara el segundo cubo.**
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SELF = process.argv.includes('--self-test');

/** Hasta acá es teclado humano; de acá para arriba es la tubería. Medido, no elegido al gusto. */
const TOLERANCIA_REDONDEO = 1.0;

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

/**
 * La llave del cobro. ⭐ Lleva la **sucursal**: `01-005|U-A-5|0000015|0011`.
 * El `--self-test` la rompe a propósito quitándosela — que es exactamente el defecto de §86.
 */
const LLAVE_BUENA = `(r.almacen || '|U-A-5|' || r.cobro_folio || '|0011')`;
const LLAVE_ROTA  = `('%|U-A-5|' || r.cobro_folio || '|0011')`;

const desfasados = (llave, op) => `
  WITH src AS (
    SELECT r.tenant_id, ${llave} AS k, sum(r.importe) AS monto_fuente
      FROM analytics.route_collections r
     WHERE r.tenant_id = $1 AND r.cuenta = '0011'
     GROUP BY 1, 2)
  SELECT l.folio, l.sucursal, to_char(l.fecha,'YYYY-MM-DD') AS dia,
         l.monto AS monto_libro, s.monto_fuente,
         (s.monto_fuente - l.monto) AS diferencia,
         l.created_by_username, l.origen_ref
    FROM finance.cash_ledger l
    JOIN src s ON s.tenant_id = l.tenant_id AND l.origen_ref ${op} s.k
   WHERE l.tenant_id = $1 AND l.origen_tipo = 'cobro'
     AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
     AND l.monto <> s.monto_fuente
   ORDER BY abs(s.monto_fuente - l.monto) DESC`;

const CONSULTA = desfasados(LLAVE_BUENA, '=');

function imprimir(titulo, filas) {
  const total = filas.reduce((a, r) => a + Math.abs(Number(r.diferencia || 0)), 0);
  console.log(`\n${titulo} · ${filas.length} fila(s) · ${money(total)}\n`);
  console.log(`  ${pad('folio', 16)}${pad('suc', 9)}${pad('fecha', 12)}` +
    `${padL('libro', 14)}${padL('fuente', 14)}${padL('dif', 14)}  capturó`);
  console.log(`  ${'-'.repeat(93)}`);
  for (const r of filas) {
    console.log(`  ${pad(r.folio, 16)}${pad(r.sucursal, 9)}${pad(r.dia, 12)}` +
      `${padL(money(r.monto_libro), 14)}${padL(money(r.monto_fuente), 14)}` +
      `${padL(money(r.diferencia), 14)}  ${r.created_by_username || '—'}`);
  }
}

async function main(c) {
  const { rows } = await c.query(CONSULTA, [TENANT]);

  if (!rows.length) {
    console.log('\n  ✓ Ningún cobro capturado difiere de su fuente.\n');
    return 0;
  }

  const grave = rows.filter((r) => Math.abs(Number(r.diferencia)) > TOLERANCIA_REDONDEO);
  const menudo = rows.filter((r) => Math.abs(Number(r.diferencia)) <= TOLERANCIA_REDONDEO);

  if (grave.length) imprimir('⛔ DESFASE DE TUBERÍA — el libro dice lo que la fuente desmiente', grave);
  if (menudo.length) {
    imprimir(`·  Redondeo de quien capturó (≤ ${money(TOLERANCIA_REDONDEO)}) — informativo`, menudo);
  }

  if (!grave.length) {
    console.log('\n  ✓ Sólo redondeos de teclado. No frena.\n');
    return 0;
  }
  console.log('\n  El importe quedó congelado al capturar y la cola ya no vuelve a ofrecer el');
  console.log('  documento: se excluye por `origen_ref`, no por monto. Corregir en la pantalla.\n');
  return 1;
}

async function selfTest(c) {
  console.log('\n[self-test] La llave del cobro lleva la SUCURSAL. Sin ella, el cruce se desborda.\n');
  const bueno = (await c.query(CONSULTA, [TENANT])).rows;
  const roto = (await c.query(desfasados(LLAVE_ROTA, 'LIKE'), [TENANT])).rows;

  console.log(`  llave con sucursal (la vigente) → ${bueno.length} desfasados`);
  console.log(`  llave SIN sucursal (el defecto) → ${roto.length} desfasados`);

  const fallos = [];
  if (roto.length < bueno.length) {
    fallos.push(`la llave rota encuentra MENOS (${roto.length} < ${bueno.length}): la prueba está al revés`);
  }
  if (roto.length === bueno.length) {
    console.log('\n  · Hoy las dos dan igual: ninguna sucursal comparte folio de cobro con otra.');
    console.log('    La prueba no puede distinguir sin un choque real, y se DECLARA — no se da por buena.');
  } else {
    console.log(`\n  ✓ Distingue: sin la sucursal, el cruce inventaría ${roto.length - bueno.length} desfase(s).`);
  }

  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); return 1; }
  return 0;
}

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  let code = 0;
  try {
    await c.query(`SET default_transaction_read_only = on`);
    await c.query(`SET statement_timeout = '120s'`);
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    code = SELF ? await selfTest(c) : await main(c);
  } finally { await c.end(); }
  process.exit(code);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
