'use strict';
/**
 * ⭐⭐ `[CGA-A.9]` — **Cobros que la bandeja ESCONDE por una colisión de folio.**
 *
 *   node database/scripts/check-cobro-escondido.js
 *   node database/scripts/check-cobro-escondido.js --self-test
 *
 * Sólo lee. **Exit 1 si encuentra algo**: a diferencia de sus hermanas, ésta SÍ frena — un cobro
 * escondido no es una decisión de negocio pendiente, es dinero que nadie puede ver ni capturar.
 *
 * ── De dónde sale, medido en prod el 2026-10-16 ─────────────────────────────────────────────
 *
 * El día que se cablearon tres camionetas, la bandeja dejó de mostrar $15,321.00:
 *
 *     01-006 ruta_28  U-A-5 0000013  $13,699.00  ← capturado, glosa "U-A-5 0000013 · CONTADO"
 *     01-002 ruta_22  U-A-5 0000013  $15,321.00  ← INVISIBLE
 *
 * El descuento anti-duplicado de `movimientosPendientes()` (`[CG.85]`) compara la glosa contra
 * `doc_tipo || ' ' || folio`. **Eso no identifica un cobro:** el folio de la camioneta es
 * consecutivo **por unidad**, no global, así que dos unidades comparten folio el mismo día
 * de manera rutinaria. Capturar uno escondía el otro.
 *
 * ⭐ **El modo de fallar es el peor:** el dinero no se pierde ni se duplica — **se vuelve
 * invisible**. La fila sigue en la vista, con su importe correcto, y la pantalla no la ofrece.
 * Nadie la captura y nadie se entera. Por eso este check frena en vez de informar.
 *
 * `[CGA-A.9]` acotó el descuento a `origen_tipo = 'caos'`, que es para lo único que existía.
 * Este script vigila que no vuelva: compara **lo que la vista publica** contra **lo que la
 * bandeja deja pasar**, y nombra la diferencia.
 *
 * ⚠️ Lo que NO cubre, declarado: una captura desde CAOS que declare `U-A-5 0000013` todavía
 * puede tapar a otra sucursal con el mismo folio. Ese hueco se cierra escribiendo la sucursal
 * en la glosa al capturar. Mientras tanto, este check lo DETECTA aunque no lo impida.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SELF = process.argv.includes('--self-test');

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

/** El descuento tal como lo aplica el servicio HOY (acotado a CAOS). */
const DEDUP_BUENO = `yac.origen_tipo = 'caos' AND `;
/** El descuento ROTO: sin acotar, mira cualquier fila del libro. */
const DEDUP_ROTO = '';

const escondidos = (dedup) => `
  SELECT v.sucursal, v.doc_tipo, v.folio, to_char(v.fecha_valor,'YYYY-MM-DD') AS fecha_valor, v.monto, v.tipo
    FROM finance.v_caja_movimientos_pendientes v
   WHERE v.tenant_id = $1
     AND EXISTS (
       SELECT 1 FROM finance.cash_ledger yac
        WHERE yac.tenant_id = v.tenant_id
          AND yac.deleted_at IS NULL AND yac.estado <> 'cancelado'
          AND ${dedup} yac.glosa LIKE v.doc_tipo || ' ' || v.folio || '%'
          -- La colisión: el libro tiene ESE doc_tipo+folio, pero de OTRA identidad.
          AND (yac.origen_ref IS NULL OR yac.origen_ref <> v.origen_ref))`;

async function main(c) {
  const { rows } = await c.query(escondidos(DEDUP_BUENO), [TENANT]);

  if (!rows.length) {
    console.log('\n  ✓ Ningún cobro escondido por colisión de folio.\n');
    return 0;
  }

  const total = rows.reduce((a, r) => a + Number(r.monto || 0), 0);
  console.log(`\n⛔ ${rows.length} movimiento(s) que la vista publica y la bandeja NO muestra · ${money(total)}\n`);
  console.log(`  ${pad('sucursal', 10)}${pad('doc', 8)}${pad('folio', 10)}${pad('fecha', 12)}${padL('monto', 14)}  tipo`);
  console.log(`  ${'-'.repeat(62)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.sucursal, 10)}${pad(r.doc_tipo, 8)}${pad(r.folio, 10)}` +
      `${pad(r.fecha_valor, 12)}${padL(money(r.monto), 14)}  ${r.tipo}`);
  }
  console.log('\n  Son invisibles en pantalla: nadie los puede capturar desde la cola.\n');
  return 1;
}

async function selfTest(c) {
  console.log('\n[self-test] El descuento SIN acotar tiene que esconder MÁS que el acotado.\n');
  const n = async (dedup) => (await c.query(escondidos(dedup), [TENANT])).rows.length;

  const bueno = await n(DEDUP_BUENO);
  const roto = await n(DEDUP_ROTO);

  console.log(`  descuento acotado a CAOS (el vigente) → ${bueno} escondidos`);
  console.log(`  descuento SIN acotar (el defecto)     → ${roto} escondidos`);

  const fallos = [];
  if (roto < bueno) fallos.push(`el roto esconde MENOS (${roto} < ${bueno}): la prueba está al revés`);
  if (roto === bueno) {
    console.log('\n  · Hoy los dos dan igual: no hay colisión viva en los datos.');
    console.log('    La prueba no puede distinguir sin un caso real, y se DECLARA — no se da por buena.');
  } else {
    console.log(`\n  ✓ Distingue: el defecto escondería ${roto - bueno} movimiento(s) más.`);
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
