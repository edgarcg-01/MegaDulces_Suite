/* eslint-disable no-console */
/**
 * `[TOR.0.9]` El veredicto de un servidor Kepler (`database/importers/lib/kepler-servidor.js`).
 * Sin base de datos: ejerce la regla real, no una copia. Cada caso nace de una falla medida en
 * los 30 días al 2026-11-04 (bitácora de `store_poller`) o del runbook de replicación.
 *
 *   node database/tests/test-kepler-servidor.js
 */
const assert = require('assert');
const { tipoDeFalla, veredictoServidor, RETENIDO_MAX_BYTES } = require('../importers/lib/kepler-servidor');

let ok = 0;
const caso = (nombre, fn) => { fn(); ok++; console.log(`  ✔ ${nombre}`); };
const ahora = new Date('2026-10-20T22:11:00Z');
const sano = { arranque: '2026-09-01T00:00:00Z', tope: '10GB', publicadas: 11, slots: [{ slot: 'sub_md_07', activo: true, wal_status: 'reserved', retenido: 4 * 1024 ** 2 }] };

console.log('[TOR.0.9] veredicto de servidor Kepler');

caso('inalcanzable y lento se distinguen (son fallas distintas)', () => {
  assert.strictEqual(tipoDeFalla('connect EHOSTUNREACH 10.0.0.1:1977'), 'inalcanzable');
  assert.strictEqual(tipoDeFalla('timeout expired'), 'lento');
  assert.strictEqual(tipoDeFalla('relation md.kdm1 does not exist'), 'otro');
});

caso('⛔ NEGATIVA — Morelia Madero 19-oct: una caída vigente es error aunque la sonda vieja dijera sano', () => {
  const v = veredictoServidor({ caida: { desde: '2026-10-19T15:32:00Z', tipo: 'lento', mensaje: 'timeout expired' }, sonda: sano, ahora });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /lento/);
  assert.match(v.error, /1839 min/); // 19-oct 09:32 MX → 20-oct 16:11 MX
});

caso('servidor sano: ok, con lo medido en la nota', () => {
  const v = veredictoServidor({ caida: null, sonda: sano, publicadasAntes: 11, ahora });
  assert.strictEqual(v.status, 'ok');
  assert.match(v.note, /11 tablas publicadas/);
  assert.strictEqual(v.error, null);
});

caso('⛔ NEGATIVA — un slot sin consumidor retiene WAL y llena el disco de la sucursal', () => {
  const v = veredictoServidor({ caida: null, sonda: { ...sano, slots: [...sano.slots, { slot: 'sub_viejo_249', activo: false, wal_status: 'extended', retenido: 3 * 1024 ** 3 }] }, ahora });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /sub_viejo_249 sin consumidor/);
});

caso('slot activo pero retiene de más: md no alcanza', () => {
  const v = veredictoServidor({ caida: null, sonda: { ...sano, slots: [{ ...sano.slots[0], retenido: RETENIDO_MAX_BYTES + 1 }] }, ahora });
  assert.strictEqual(v.status, 'error');
});

caso('slot perdido: la réplica no puede seguir', () => {
  const v = veredictoServidor({ caida: null, sonda: { ...sano, slots: [{ slot: 's', activo: false, wal_status: 'lost', retenido: null }] }, ahora });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /PERDIDO/);
});

caso('⛔ NEGATIVA — una actualización de Kepler saca tablas de la publicación', () => {
  const v = veredictoServidor({ caida: null, sonda: { ...sano, publicadas: 9 }, publicadasAntes: 11, ahora });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /2 tabla/);
});

caso('sin revisión anterior no se inventa una baja', () => {
  assert.strictEqual(veredictoServidor({ caida: null, sonda: { ...sano, publicadas: 9 }, publicadasAntes: null, ahora }).status, 'ok');
});

caso('responde pero la sonda no se pudo leer: se DECLARA «NO MEDIDO», no se calla', () => {
  const v = veredictoServidor({ caida: null, sonda: null, errorSonda: 'permission denied', ahora });
  assert.match(v.note, /NO MEDIDO: permission denied/);
});

caso('un reinicio reciente se anota; sin tope de WAL con slot, también', () => {
  const v = veredictoServidor({ caida: null, sonda: { ...sano, tope: '-1', arranque: '2026-10-20T20:00:00Z' }, ahora });
  assert.match(v.note, /se reinició/);
  assert.match(v.note, /SIN TOPE/);
  assert.strictEqual(v.status, 'ok');
});

caso('[TOR.0.2] la réplica va en el detalle: segundos y errores, con estructura', () => {
  const v = veredictoServidor({ caida: null, sonda: sano, ahora, replica: { seg: 20.9, errores: 3, habilitada: true } });
  assert.strictEqual(v.status, 'ok');
  assert.strictEqual(v.detalle.replica_s, 21);
  assert.strictEqual(v.detalle.errores_replica, 3);
  assert.strictEqual(v.detalle.publicadas, 11);
  assert.match(v.note, /3 error\(es\) de réplica acumulados/);
});

caso('⛔ NEGATIVA — servidor responde pero md no recibe de él hace 20 min: es falla', () => {
  const v = veredictoServidor({ caida: null, sonda: sano, ahora, replica: { seg: 1200, errores: 0, habilitada: true } });
  assert.strictEqual(v.status, 'error');
  assert.match(v.error, /no recibe de este servidor hace 20 min/);
});

caso('réplica deshabilitada o sin proceso: falla aunque la sonda no se haya podido leer', () => {
  assert.strictEqual(veredictoServidor({ caida: null, sonda: null, errorSonda: 'x', ahora, replica: { seg: null, errores: null, habilitada: false } }).status, 'error');
  assert.strictEqual(veredictoServidor({ caida: null, sonda: sano, ahora, replica: { seg: null, errores: 0, habilitada: true } }).status, 'error');
});

caso('sin lectura de réplicas (null): no se inventa, el detalle la deja en null', () => {
  const v = veredictoServidor({ caida: null, sonda: sano, ahora, replica: null });
  assert.strictEqual(v.status, 'ok');
  assert.strictEqual(v.detalle.replica_s, null);
  assert.strictEqual(v.detalle.errores_replica, null);
});

console.log(`\n${ok} casos OK`);
