/* eslint-disable no-console */
/**
 * `[GX.73]` La COMPARACIÓN que decide cuántos vales ve la Suite atrasados. Sin base: lo que puede
 * estar mal acá es el conteo, no el SQL (el SQL lo ejerce `test-ods-open-docs.js` contra kdm1).
 *
 * Las formas de que el número mienta, cada una con su caso:
 *   · contar como atrasado lo que sólo trae espacios distintos ('A ' vs 'A');
 *   · contar como «al día» un folio que FALTA en el ODS (no es igual: no está);
 *   · mezclar «dentro de la ventana» con «fuera» (son dos causas distintas);
 *   · perder la dirección del cambio (N→A es «autorizada que la Suite no ve»; A→N sería otra cosa).
 */
const { compararEstados } = require('../scripts/medir-frescura-kdm1');

let ok = 0, fail = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };

const HOY = '2026-10-07';
const replica = [
  { folio: '0009001', estado: 'A', captura: '2026-09-01' }, // autorizada hace semanas, la Suite dice N
  { folio: '0009002', estado: 'A', captura: '2026-10-06' }, // autorizada ayer: dentro de la ventana
  { folio: '0009003', estado: 'F', captura: '2026-08-20' }, // cerrada, la Suite dice A
  { folio: '0009004', estado: 'N', captura: '2026-10-01' }, // igual en los dos
  { folio: ' 0009005 ', estado: 'A ', captura: '2026-09-10' }, // igual con espacios
  { folio: '0009006', estado: 'C', captura: '2026-07-01' }, // cancelada, la Suite dice A
  { folio: '0009007', estado: 'N', captura: '2026-10-07' }, // falta en el ODS
  { folio: '0009008', estado: 'A', captura: null },          // sin fecha de captura
];
const ods = [
  { folio: '0009001', estado: 'N' },
  { folio: '0009002', estado: 'N' },
  { folio: '0009003', estado: 'A' },
  { folio: '0009004', estado: 'N' },
  { folio: '0009005', estado: 'A' },
  { folio: '0009006', estado: 'A' },
  { folio: '0009008', estado: 'N' },
  { folio: '0009999', estado: 'A' }, // sobra en el ODS
];

console.log('\n[1] El conteo');
const r = compararEstados(replica, ods, { hoy: HOY, ventanaDias: 3 });
A(r.total_replica === 8, 'cuenta las 8 solicitudes de Kepler');
A(r.iguales === 2, 'iguales = 2 (la 0009004, y la 0009005 aunque traiga espacios)');
A(r.distintos.length === 5, 'atrasadas = 5');
A(r.faltanEnOds.length === 1 && r.faltanEnOds[0] === '0009007', '⛔ la que FALTA en el ODS no cuenta como igual ni como atrasada: se reporta aparte');
A(r.sobranEnOds.length === 1 && r.sobranEnOds[0] === '0009999', 'la que sobra en el ODS se reporta');

console.log('\n[2] La dirección del cambio');
A(r.porTransicion['N→A'] === 3, 'N→A = 3: autorizadas en Kepler que la Suite muestra «por autorizar»');
A(r.porTransicion['A→F'] === 1, 'A→F = 1: cerrada en Kepler');
A(r.porTransicion['A→C'] === 1, 'A→C = 1: cancelada en Kepler que la Suite sigue mostrando viva');
A(!r.porTransicion['A→N'], '⛔ no invierte la dirección (se lee «Suite → Kepler»)');

console.log('\n[3] Dentro vs fuera de la ventana');
A(r.dentroVentana === 1, 'dentro de la ventana de 3 días = 1 (la de ayer: el carril ya debería cubrirla)');
A(r.fueraVentana === 3, 'fuera de la ventana = 3 (el punto ciego que arregla GX.73)');
A(r.sinFecha === 1, 'sin fecha de captura = 1: se declara, no se adivina');
A(r.distintos[0].folio === '0009006', 'la muestra trae primero la más vieja (la que lleva más tiempo mal)');
A(r.distintos.find((d) => d.folio === '0009001').edad_dias === 36, 'la antigüedad se calcula en días (36)');

console.log('\n[4] Bordes');
const vacio = compararEstados([], [], { hoy: HOY });
A(vacio.total_replica === 0 && vacio.distintos.length === 0, 'sin datos: todo en cero, sin reventar');
const sinHoy = compararEstados([{ folio: '1', estado: 'A', captura: '2026-01-01' }], [{ folio: '1', estado: 'N' }]);
A(sinHoy.sinFecha === 1 && sinHoy.distintos[0].edad_dias === null, 'sin `hoy` no inventa la antigüedad: la declara nula');

console.log(`\n${fail ? '✖' : '✔'} ${ok} ok · ${fail} fallas`);
process.exit(fail ? 1 : 0);
