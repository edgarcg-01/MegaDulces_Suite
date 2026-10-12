/* eslint-disable no-console */
/**
 * `[SN.31]` COMPUERTA: toda pantalla que esté en una barra de pestañas tiene que estar
 * también en el sidebar de su proyecto.
 *
 * ⛔ **Por qué existe.** Medido el 2026-10-09 sobre los 14 archivos `*-tabs.ts`: **81 pantallas
 * vivían SÓLO en una pestaña**. No es descuido: son dos listas escritas a mano sobre lo mismo,
 * así que divergen siempre. La regla ya estaba escrita en el repo desde `[AU.3]` —*una pantalla
 * que no está en el sidebar, para quien no conoce la pestaña, no existe*— pero sin compuerta
 * que la sostenga.
 *
 * ⚠️ Entiende las DOS formas de estar en el sidebar: escrita a mano (`route: '...'`) y
 * **derivada** (`...navDeTabs(X_TABS)`). La primera versión de esta medición sólo veía la
 * primera, así que al derivar un grupo reportaba MÁS faltantes — midiendo lo contrario de lo
 * que pasaba. Una compuerta que no entiende el arreglo convierte el arreglo en falla.
 *
 * ⭐ Almacén es la excepción declarada: su sidebar muestra un item por ÁREA, no por pestaña
 * (43 pestañas → ~10 puertas), y lo deriva con `ALMACEN_AREAS`. Está exento a propósito.
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'apps/view/src/app/modules';
const LAYOUT = path.join(ROOT, 'dashboard/layout/layout.component.ts');
/** Sub-módulos exentos, con el motivo. Vacío no se permite: una exención sin motivo es un hueco. */
const EXENTOS = {
  almacen: 'su sidebar muestra un item por ÁREA (43 pestañas → ~10 puertas), derivado de ALMACEN_AREAS',
};

const lay = fs.readFileSync(LAYOUT, 'utf8');

// 1. Las rutas escritas a mano en el layout.
const enSidebar = new Set([...lay.matchAll(/route:\s*'([^']+)'/g)].map((m) => m[1]));

// 2. Las DERIVADAS, en sus DOS formas:
//    · `...navDeTabs(X_TABS)` — una entrada por pantalla;
//    · `tabs: X_TABS` — ⭐ el patrón de `[GX.80]`: UNA entrada para todo un sub-módulo, que
//      lleva a la primera pestaña visible y queda activa en cualquiera de ellas. Es una forma
//      legítima de estar en el sidebar, y la primera versión de esta compuerta no la conocía:
//      marcaba en rojo a «Gastos», que estaba bien hecho. Una compuerta que no entiende un
//      patrón válido del repo no mide calidad, mide parecido.
const derivadas = [
  ...[...lay.matchAll(/navDeTabs\(\s*([A-Z_0-9]+)\s*\)/g)].map((m) => m[1]),
  ...[...lay.matchAll(/tabs:\s*([A-Z_0-9]+)\s*[,}]/g)].map((m) => m[1]),
];
const importes = new Map();
for (const m of lay.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
  for (const sym of m[1].split(',').map((s) => s.trim().replace(/^type\s+/, ''))) {
    if (sym) importes.set(sym, m[2]);
  }
}
const noResueltas = [];
for (const sym of derivadas) {
  const rel = importes.get(sym);
  if (!rel) { noResueltas.push(sym); continue; }
  const abs = path.resolve(path.dirname(LAYOUT), rel) + '.ts';
  if (!fs.existsSync(abs)) { noResueltas.push(`${sym} (${rel})`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  for (const r of src.matchAll(/route:\s*'([^']+)'/g)) enSidebar.add(r[1]);
}

// 3. Cada barra de pestañas contra el sidebar.
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/-tabs\.ts$/.test(e.name)) files.push(p);
  }
})(ROOT);

let fallas = 0; let exentas = 0; let okTabs = 0;
for (const f of files.sort()) {
  const nom = path.basename(f).replace('-tabs.ts', '');
  const s = fs.readFileSync(f, 'utf8');
  const tabs = [...s.matchAll(/label:\s*'([^']+)'[\s\S]{0,240}?route:\s*'([^']+)'/g)]
    .map((m) => ({ label: m[1], route: m[2] }));
  if (!tabs.length) continue;
  if (EXENTOS[nom]) { exentas += tabs.length; console.log(`  ⓘ ${nom}: EXENTO — ${EXENTOS[nom]}`); continue; }
  const faltan = tabs.filter((t) => !enSidebar.has(t.route));
  okTabs += tabs.length - faltan.length;
  if (!faltan.length) { console.log(`  ✔ ${nom} (${tabs.length} pestañas)`); continue; }
  fallas += faltan.length;
  console.log(`  ✖ ${nom}: ${faltan.length} de ${tabs.length} pestañas NO están en el sidebar`);
  for (const t of faltan) console.log(`        ${t.label.padEnd(28)} ${t.route}`);
}

if (noResueltas.length) {
  console.log(`\n  ✖ no se pudo resolver el import de: ${noResueltas.join(', ')}`);
  fallas += noResueltas.length;
}


// ── `[NAV.2.2]` Una entrada `tabs:` promete una BARRA, y la barra la pinta la PÁGINA ────────
//
// ⛔ El defecto que esto caza, vivido el 2026-10-12. Se agruparon las 22 pantallas de
// `/compras` en 6 entradas con `tabs:`, y el sidebar quedó impecable — pero **ninguna de las 5
// tiras nuevas la pintaba un componente**. O sea: se borraron 19 renglones del menú y las 19
// pantallas se quedaron sin NINGUNA forma de llegar. La compuerta daba verde, porque un
// `tabs: X` mete todas las rutas de X en `enSidebar` y da por cierto que existe una barra.
//
// ⭐ Por qué `[NAV.1]` sí estaba bien y éste no: allá se plegaron tiras que YA existían y que
// sus páginas YA pintaban (2 a 5 componentes cada una); acá se crearon tiras nuevas. El
// `tabs:` del sidebar NO crea la barra — sólo apunta a ella.
//
// La regla: para cada `tabs: X` del layout, algún `*.component.ts` que no sea el layout tiene
// que importar el archivo de X. Si nadie lo importa, la entrada es una puerta a un cuarto sin
// salida, y eso es peor que el renglón de más que vino a ahorrar.
const COMPONENTES = [];
(function walkComp(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkComp(p);
    else if (/\.component\.ts$/.test(e.name) && !/layout\.component\.ts$/.test(e.name)) COMPONENTES.push(p);
  }
})(ROOT);

const conTabs = [...new Set([...lay.matchAll(/tabs:\s*([A-Z_0-9]+)\s*[,}]/g)].map((m) => m[1]))];
const sinBarra = [];
for (const sym of conTabs) {
  const rel = importes.get(sym);
  if (!rel) continue; // ya se reporta en `noResueltas`
  // Sin regex: una barra invertida dentro de un template literal se degrada en silencio.
  const aguja = '/' + path.basename(rel) + "'";
  const pintan = COMPONENTES.filter((p) => fs.readFileSync(p, 'utf8').includes(aguja));
  if (!pintan.length) sinBarra.push(sym);
}
if (sinBarra.length) {
  console.log(`\n  ✖ ${sinBarra.length} entrada(s) del sidebar prometen una barra que NINGUNA página pinta:`);
  for (const s of sinBarra) console.log(`        ${s} — sus pantallas quedan sin forma de llegar`);
  console.log('     Arreglo: la página aterrizaje (y las demás del grupo) renderizan <app-page-tabs [tabs]="…">.');
  console.log('     ⛔ El orden importa: PRIMERO la barra en las páginas, DESPUÉS se pliega el sidebar.');
  fallas += sinBarra.length;
} else if (conTabs.length) {
  console.log(`\n  ✔ las ${conTabs.length} entrada(s) con barra: su tira la pinta al menos una página`);
}
// PRUEBA NEGATIVA: la compuerta tiene que SABER ver una derivada; si no ve ninguna, no está
// midiendo lo que cree y un verde no significa nada.
if (!derivadas.length) {
  console.log('\n  ✖ CONTROL: no se detectó ninguna entrada derivada (navDeTabs). La compuerta no está midiendo la derivación.');
  fallas++;
} else {
  console.log(`\n  ✔ CONTROL: ${derivadas.length} grupo(s) derivado(s) resueltos — la compuerta ve las dos formas`);
}

console.log(`\n  ${okTabs} pestaña(s) con entrada en el sidebar · ${exentas} exenta(s) · ${fallas} falla(s)`);
process.exit(fallas === 0 ? 0 : 1);
