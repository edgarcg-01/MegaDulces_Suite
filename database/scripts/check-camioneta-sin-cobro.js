/* eslint-disable no-console */
/**
 * ⭐⭐ `[CGA-A.13]` — **Qué camioneta manda su VENTA y no manda su COBRO.**
 *
 *   node database/scripts/check-camioneta-sin-cobro.js
 *   node database/scripts/check-camioneta-sin-cobro.js --self-test
 *
 * Lee el runner (`kepler_consolidado`, `DATABASE_URL_KEPLER_CONSOLIDADO`). No escribe nada.
 * **Exit 1** cuando una unidad con venta fresca lleva su cobro atrasado o ausente: eso es
 * efectivo que ya se levantó y que nadie puede ver en Caja General.
 *
 * ── Por qué existe, medido el 2026-10-16 ───────────────────────────────────────────────────
 *
 * El `.cmd` de cada camioneta se **pega a mano, máquina por máquina**. No hay plantilla única ni
 * nadie que compare lo desplegado contra lo esperado, así que **un bloque faltante no produce
 * rojo: produce silencio**. Ese día hubo que cablear cuatro unidades a mano, y el censo decía:
 *
 *     11 camionetas empujan VENTAS   ·   4 empujaban COBROS
 *
 * ⛔ **Y el modo de fallar es el de siempre en este carril: no hay error, no hay log, no hay
 * descuadre.** Una unidad que nunca mandó cobros se ve **exactamente igual** que una que no
 * cobró nada. `GOTCHAS` §84 (un carril verde puede ser que murió el origen) y §86.
 *
 * ⭐ **Por eso se cruzan DOS latidos y no se mira uno.** La venta es el testigo independiente:
 * si una unidad mandó venta hoy, estuvo prendida, con red y con su Kepler vivo — así que la
 * ausencia del cobro **no es la camioneta, es el `.cmd`**. Mismo razonamiento que
 * `check-route-stock-push.js` (`[RD.32]`), que ya hace esto para la existencia.
 *
 * ⚠️ Lo que NO contesta: si el importe es correcto. Eso lo mide
 * `check-cobro-monto-desfasado.js` del lado de prod. Acá se mide **entrega** (ADR-053).
 */
'use strict';
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const SELF = process.argv.includes('--self-test');

/** Una unidad que mandó venta dentro de esta ventana estuvo viva: su cobro es exigible. */
const VENTA_FRESCA_H = 36;
/** Más de esto sin cobros, con venta fresca, es un carril caído o nunca cableado. */
const COBRO_RANCIO_H = 36;

const horas = (t) => (t ? (Date.now() - new Date(t).getTime()) / 3.6e6 : null);
const edad = (h) => (h == null ? 'nunca' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} d`);
const money = (v) => (v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
const pad = (s, n) => String(s ?? '').padEnd(n);

/**
 * ⭐ El `LEFT JOIN` es lo que carga el peso: **una unidad SIN fila de cobros tiene que salir**,
 * y es justamente el caso que más duele (nunca se cableó). El `--self-test` lo degrada a `INNER`
 * —el error natural de quien escribe esta consulta— y exige que encuentre MENOS.
 */
const censo = (join) => `
  SELECT v.truck,
         v.last_ok AS venta_ok, v.rows_last AS venta_filas,
         c.last_ok AS cobro_ok, c.rows_last AS cobro_filas, c.valor_last AS cobro_valor,
         host(coalesce(c.client_ip, v.client_ip)) AS ip
    FROM ingest.route_push_heartbeat v
    ${join} JOIN ingest.route_collections_heartbeat c ON c.truck = v.truck
   ORDER BY v.truck`;

/** La regla, en un solo lugar: se usa igual en el informe y en la prueba negativa. */
function clasificar(r) {
  const hv = horas(r.venta_ok);
  const hc = horas(r.cobro_ok);
  if (hv == null || hv > VENTA_FRESCA_H) return 'dormida';      // no mandó venta: otro problema
  if (hc == null) return 'sin_cablear';                          // venta fresca, cobro NUNCA
  if (hc > COBRO_RANCIO_H) return 'carril_caido';                // venta fresca, cobro rancio
  return 'al_dia';
}

const ROTULO = {
  al_dia: '✓ al día',
  carril_caido: '⛔ CARRIL CAÍDO',
  sin_cablear: '⛔ SIN CABLEAR',
  dormida: '·  dormida',
};

async function leer(c, join) {
  const { rows } = await c.query(censo(join));
  return rows.map((r) => ({ ...r, estado: clasificar(r) }));
}

async function main(c) {
  const filas = await leer(c, 'LEFT');

  console.log('\n[CGA-A.13] Camionetas: quién manda su venta y NO manda su cobro\n');
  console.log(`  ${pad('camión', 10)}${pad('venta', 12)}${pad('cobro', 12)}${pad('filas', 8)}` +
    `${pad('valor', 12)}${pad('dónde está', 17)}estado`);
  console.log(`  ${'-'.repeat(88)}`);

  for (const r of filas) {
    console.log(`  ${pad(r.truck, 10)}${pad(edad(horas(r.venta_ok)), 12)}` +
      `${pad(edad(horas(r.cobro_ok)), 12)}${pad(r.cobro_filas ?? '—', 8)}` +
      `${pad(money(r.cobro_valor), 12)}${pad(r.ip || '—', 17)}${ROTULO[r.estado]}`);
  }

  const malas = filas.filter((r) => r.estado === 'sin_cablear' || r.estado === 'carril_caido');
  const dormidas = filas.filter((r) => r.estado === 'dormida');

  console.log('');
  if (dormidas.length) {
    console.log(`  ·  ${dormidas.length} dormida(s): sin venta en ${VENTA_FRESCA_H} h. No se juzga su cobro —`);
    console.log('     no se puede distinguir «no cobró» de «está apagada», y se DECLARA (ADR-056).');
  }

  if (!malas.length) {
    console.log('\n  ✓ Toda unidad con venta fresca está mandando su cobro.\n');
    return 0;
  }

  console.log(`\n⛔ ${malas.length} unidad(es) mandaron VENTA y no mandan COBRO: ${malas.map((r) => r.truck).join(', ')}`);
  console.log('   La venta prueba que la máquina estuvo prendida y con red, así que esto NO es la');
  console.log('   camioneta: le falta el bloque de cobros al `.cmd`. Plantilla única en');
  console.log('   `database/importers/kepler/route-push/` (`[CGA-A.12]`).\n');
  return 1;
}

async function selfTest(c) {
  console.log('\n[self-test] El `LEFT JOIN` es lo que hace visible a la que NUNCA se cableó.\n');
  const bueno = await leer(c, 'LEFT');
  const roto = await leer(c, 'INNER');

  const cuenta = (f) => f.filter((r) => r.estado === 'sin_cablear' || r.estado === 'carril_caido').length;
  const nb = cuenta(bueno);
  const nr = cuenta(roto);

  console.log(`  LEFT JOIN (el vigente)  → ${bueno.length} unidades censadas · ${nb} con problema`);
  console.log(`  INNER JOIN (el defecto) → ${roto.length} unidades censadas · ${nr} con problema`);

  const fallos = [];
  if (roto.length > bueno.length) fallos.push(`el INNER censa MÁS (${roto.length} > ${bueno.length}): imposible`);
  if (nr > nb) fallos.push(`el INNER encuentra MÁS problemas (${nr} > ${nb}): la prueba está al revés`);

  if (bueno.length === roto.length) {
    console.log('\n  · Hoy todas las unidades tienen fila de cobros: la prueba no puede distinguir');
    console.log('    sin una unidad nunca cableada, y se DECLARA — no se da por buena.');
  } else {
    console.log(`\n  ✓ Distingue: el INNER perdería ${bueno.length - roto.length} unidad(es) de vista,`);
    console.log(`    y con ellas ${nb - nr} problema(s) — las que NUNCA mandaron un cobro.`);
  }

  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); return 1; }
  return 0;
}

(async () => {
  const url = process.env.DATABASE_URL_KEPLER_CONSOLIDADO;
  if (!url) { console.error('⛔ falta DATABASE_URL_KEPLER_CONSOLIDADO en el .env'); process.exit(1); }
  const c = new Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 10000 });
  await c.connect();
  let code = 0;
  try {
    await c.query(`SET default_transaction_read_only = on`);
    code = SELF ? await selfTest(c) : await main(c);
  } finally { await c.end(); }
  process.exit(code);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
