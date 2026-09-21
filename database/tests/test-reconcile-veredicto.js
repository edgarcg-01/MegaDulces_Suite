/**
 * OBS.12 — El veredicto del reconciliador del ODS, ROTO A PROPÓSITO.
 *
 * Este gate llevaba meses sin ejercerse: la decisión vivía inline dentro de `latir()`, que abre
 * conexión a prod y hace `process.exit`, así que no había forma de correrla sin prod. Un gate sin
 * prueba negativa es una intención (ADR-056). Acá se ejerce, y se cierra con una prueba de
 * MUTACIÓN: si con la regla vieja el test sigue verde, el test es decorativo.
 *
 * El caso REAL que lo originó (prod, 2026-09-21): cinco pasadas con huecos 48/32/52/58/106 y
 * repuestas 48/32/52/58/106, errores 0, y la ventana FULL del mismo día en huecos 0. El tablero
 * marcaba CRÍTICO por haber hecho su trabajo.
 *
 * No toca la base. `needsApi: false`.
 */
'use strict';
const path = require('path');
const { veredicto } = require(path.resolve(__dirname, '..', 'importers', 'lib', 'reconcile-veredicto'));

let ok = 0, fail = 0;
const assert = (cond, txt) => {
  if (cond) { ok++; console.log(`  ✓ ${txt}`); }
  else { fail++; console.log(`  ✗ ${txt}`); }
};

console.log('\n=== OBS.12 · veredicto del reconciliador ===\n');

// ── 1. El camino feliz que estaba en rojo ────────────────────────────────────────────────────
console.log('1) lo que se cura NO es un incidente');
for (const [huecos, repuestas] of [[48, 48], [32, 32], [52, 52], [58, 58], [106, 106]]) {
  const v = veredicto({ huecos, repuestas, errores: 0, sobrantes: 0 }, { apply: true, alerta: 50 });
  assert(v.status === 'ok', `huecos ${huecos} · repuestas ${repuestas} · errores 0 → ok (medido en prod)`);
}
const alto = veredicto({ huecos: 106, repuestas: 106, errores: 0 }, { apply: true, alerta: 50 });
assert(/TENDENCIA/.test(alto.tendencia), 'pero el exceso sobre el umbral NO se pierde: queda en la nota como TENDENCIA');
assert(alto.error === null, 'y no ensucia el campo `error`, que es lo que db-health lee para el crítico');

// ── 2. La prueba NEGATIVA: lo que sí tiene que ponerse rojo ──────────────────────────────────
console.log('\n2) lo que NO se pudo reponer sigue siendo CRÍTICO');
const roto = veredicto({ huecos: 106, repuestas: 100, errores: 0 }, { apply: true, alerta: 50 });
assert(roto.status === 'error', 'huecos 106 · repuestas 100 → error (6 quedaron afuera)');
assert(roto.sinReponer === 6, 'y dice CUÁNTAS quedaron afuera (6), no cuántas encontró');
assert(/NO se pudieron reponer/.test(roto.error), 'el mensaje nombra el hecho real, no el umbral');

const unaSola = veredicto({ huecos: 1, repuestas: 0, errores: 0 }, { apply: true, alerta: 50 });
assert(unaSola.status === 'error', 'UNA sola fila sin reponer ya es error, aunque esté muy por debajo del umbral');

assert(veredicto({ huecos: 0, repuestas: 0, errores: 2 }, { apply: true }).status === 'error',
  'una tabla con error sigue poniendo rojo aunque no haya huecos');
assert(veredicto({ huecos: 0, repuestas: 0, abortados: 1 }, { apply: true }).status === 'error',
  'un DELETE abortado sigue poniendo rojo');
assert(veredicto({ sobrantes: 900 }, { apply: true, alertaSobrantes: 100 }).status === 'error',
  'sobrantes sobre su umbral propio siguen poniendo rojo');
assert(veredicto({ sobrantes: 900 }, { apply: true, alertaSobrantes: 0 }).status === 'ok',
  'pero con su umbral APAGADO (0 = default) no, que es la decisión ya tomada en el archivo');

// ── 3. La trampa del dry-run ─────────────────────────────────────────────────────────────────
console.log('\n3) el dry-run no puede reponer: medir "sin reponer" ahí seria mentir');
const seco = veredicto({ huecos: 106, repuestas: 0, errores: 0 }, { apply: false, alerta: 50 });
assert(seco.status === 'ok', 'en dry-run, huecos 106 y repuestas 0 NO es error (no se envió nada, por diseño)');
assert(seco.sinReponer === 0, 'y `sinReponer` es 0, no 106');
const secoConError = veredicto({ huecos: 5, repuestas: 0, errores: 1 }, { apply: false });
assert(secoConError.status === 'error', 'pero un error de tabla en dry-run SÍ se reporta');

// ── 4. ⭐ MUTACIÓN: la regla VIEJA tiene que poner el test en rojo ────────────────────────────
// Sin esto no se sabe si el test mide algo. Se reimplementa el criterio anterior
// (`malo = huecos > ALERTA || ...`) y se exige que FALLE el caso feliz medido en prod.
console.log('\n4) mutación: con la regla vieja, esta suite tiene que romperse');
const veredictoViejo = (r, o) => ({
  status: (r.huecos > o.alerta || (r.errores || 0) > 0) ? 'error' : 'ok',
});
const vieja = veredictoViejo({ huecos: 106, repuestas: 106, errores: 0 }, { alerta: 50 });
assert(vieja.status === 'error',
  'la regla vieja marca CRÍTICO el caso 106/106 — o sea que el cambio NO es cosmético');
assert(vieja.status !== alto.status,
  'y la nueva difiere de la vieja en ese caso exacto: si coincidieran, esta suite no probaría nada');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
process.exit(fail === 0 ? 0 : 1);
