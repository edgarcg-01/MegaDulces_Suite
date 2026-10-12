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

/**
 * ¿Algún COMPONENTE importa esta tira? Es la diferencia entre «hay un archivo de pestañas» y
 * «hay una barra de pestañas EN LA PANTALLA». Sólo con la segunda se puede afirmar que,
 * entrando por una pestaña, se llega a las demás — que es lo que el salvavidas de la tira
 * anidada da por cierto.
 */
const TODOS_LOS_TS = [];
(function walkTs(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkTs(p);
    else if (/.component.ts$/.test(e.name)) TODOS_LOS_TS.push(p);
  }
})(ROOT);

function seConsume(archivoTabs) {
  const base = path.basename(archivoTabs, '.ts');
  // Sin regex a proposito: una barra invertida dentro de un template literal se degrada en
  // silencio (una barra + s queda en s) y la comprobacion no matchea NUNCA. Ya paso al
  // escribir esta funcion: daba rojo a una tira que SI se consume.
  const aguja = '/' + base + "'";
  return TODOS_LOS_TS.some((p) => fs.readFileSync(p, 'utf8').includes(aguja));
}


let fallas = 0; let exentas = 0; let okTabs = 0;
for (const f of files.sort()) {
  const nom = path.basename(f).replace('-tabs.ts', '');
  const s = fs.readFileSync(f, 'utf8');
  const tabs = [...s.matchAll(/label:\s*'([^']+)'[\s\S]{0,240}?route:\s*'([^']+)'/g)]
    .map((m) => ({ label: m[1], route: m[2] }));
  if (!tabs.length) continue;
  if (EXENTOS[nom]) { exentas += tabs.length; console.log(`  ⓘ ${nom}: EXENTO — ${EXENTOS[nom]}`); continue; }
  // `[NAV.2]` Un archivo `*-tabs.ts` ES una tira: sus pantallas se alcanzan unas a otras desde
  // cualquiera de ellas. Por eso una tira ANIDADA —una cuya puerta es, a su vez, pestaña de
  // otra— está cubierta si AL MENOS UNA de sus rutas llega al sidebar: entrando por ahí, la
  // tira se pinta entera.
  //
  // ⛔ Sin esto la compuerta daba un FALSO POSITIVO, y el caso real lo destapó: al agrupar
  // `/compras` por flujo, «Control de entradas» pasó a ser una pestaña de «Recepción» y
  // conservó su propia tira de 5. Las 5 son alcanzables (Recepción → Control de entradas →
  // su tira), y la compuerta marcaba 4 en rojo porque sólo sabía mirar el sidebar PLANO.
  //
  // ⚠️ El salvavidas es ESTRECHO a propósito: exige una puerta REAL en el sidebar. Una tira
  // con CERO rutas en el sidebar sigue en rojo — que es el defecto que esta compuerta nació
  // para cazar: 81 pantallas que vivían sólo en una pestaña y no aparecían en ningún lado.
  // ⛔⛔ Y la condición NO es sólo que tenga puerta: la tira tiene que EXISTIR EN PANTALLA.
  // Medido al estrenar esta regla: con el salvavidas suelto, `contabilidad` pasó a verde — y
  // es un FALSO NEGATIVO. Sus 16 pantallas están listadas una por una en el sidebar y NADIE
  // importa `CONTABILIDAD_TABS`: el archivo define una tira que ningún componente pinta, así
  // que desde sus 15 hermanas no se llega a «Cierre». Un archivo `*-tabs.ts` no prueba que
  // haya una barra; lo prueba un componente consumiéndolo.
  const consumida = seConsume(f);
  const puertaEnSidebar = consumida && tabs.some((t) => enSidebar.has(t.route));
  const faltan = puertaEnSidebar ? [] : tabs.filter((t) => !enSidebar.has(t.route));
  const anidada = puertaEnSidebar && tabs.some((t) => !enSidebar.has(t.route));
  okTabs += tabs.length - faltan.length;
  if (!faltan.length) {
    // Se DISTINGUE la anidada: pasa, pero por una razón distinta, y eso tiene que verse.
    const via = anidada ? ' — anidada: su puerta está en el sidebar' : '';
    console.log(`  ✔ ${nom} (${tabs.length} pestañas)${via}`);
    continue;
  }
  fallas += faltan.length;
  console.log(`  ✖ ${nom}: ${faltan.length} de ${tabs.length} pestañas NO están en el sidebar`);
  for (const t of faltan) console.log(`        ${t.label.padEnd(28)} ${t.route}`);
}

if (noResueltas.length) {
  console.log(`\n  ✖ no se pudo resolver el import de: ${noResueltas.join(', ')}`);
  fallas += noResueltas.length;
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
