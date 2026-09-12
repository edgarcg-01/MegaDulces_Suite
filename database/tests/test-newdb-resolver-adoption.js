/* eslint-disable no-console */
/**
 * CANDADO — ¿ALGUIEN LEE LOS RESOLVEDORES? (VA.1)
 *
 * Edgar, 2026-09-11, después de encontrar un `UxC = 1` donde son 58:
 *
 *     "tu verdad absoluta fallo"
 *
 * Tenía razón, y este archivo existe porque medirlo le dio la razón.
 *
 * ── Qué falló exactamente ───────────────────────────────────────────────────────────────────
 *
 * NO falló el dato, ni los resolvedores: el resolvedor canónico decía **58** para ese SKU desde
 * siempre. Falló `docs/VERDAD_ABSOLUTA.md` **como mecanismo**.
 *
 *   · §5 declara QUÉ LEER para cada número.
 *   · §7 lista los huecos **del dato**, con nombre y monto.
 *   · Los candados verifican que **cada resolvedor concuerde con su testigo**.
 *   · ⛔ **Ni uno solo verificaba que alguien lo LEYERA.**
 *
 * La distancia entre lo arbitrado y lo publicado no estaba en la lista de huecos. Por eso se
 * pudo escribir una fase entera sobre *"las declaraciones no caducan"* sin ver que el modo de
 * falla real era **"el resolvedor existe y nadie lo consume"** — y por eso se arbitró a fondo
 * `v_erp_sales_line_units`, que tiene **cero** lectores.
 *
 * Es el patrón de ADR-056 otra vez, un escalón más arriba: el primitivo se construyó bien, se
 * aplicó a un dominio, y nunca se generalizó. Sólo que esta vez había un documento declarándolo
 * canónico, y eso se leía como si estuviera adoptado.
 *
 * ── Qué mide, y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Mide **adopción**: cuántos publicadores (servicios y componentes que emiten un número) leen el
 * resolvedor, contra cuántos siguen leyendo la fuente cruda que ese resolvedor existe para
 * reemplazar.
 *
 * ⛔ NO se pone rojo por la brecha de hoy — sería rojo permanente y un rojo permanente se aprende
 * a ignorar. Se pone rojo cuando **EMPEORA**: un trinquete. La brecha de hoy se DECLARA con su
 * tamaño, acá y en `analytics.declared_gaps`.
 *
 * ⚠️ El conteo mira **código, no prosa**: se quitan comentarios antes de contar. Un archivo puede
 * nombrar `cost_base` en un comentario que explica por qué NO usarlo — de hecho varios lo hacen
 * desde hoy. Contar menciones crudas inflaba el número, y publicar un número que se sabe inflado
 * es el mismo pecado que este candado persigue. (Ya pasó hoy: una aserción de otro candado se
 * puso roja por el comentario donde citaba el código viejo.)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * El registro: por cada eje de verdad, su resolvedor canónico y las fuentes crudas que ese
 * resolvedor existe para reemplazar. `baseline` es lo MEDIDO el 2026-09-11 — el trinquete.
 */
const EJES = [
  {
    eje: 'factor de caja',
    adr: 'ADR-055 / ADR-057',
    resolvedores: ['v_product_box_factor', 'v_warehouse_box_factor'],
    crudas: ['factor_sale', 'box_size'],
    baseline: { crudas: 21 },
  },
  {
    eje: 'costo unitario',
    adr: 'ADR-051 / ADR-059 (KE.3)',
    resolvedores: ['v_erp_unit_cost'],
    crudas: ['cost_base', 'cost_with_tax'],
    // 29 es lo MEDIDO por este mismo archivo el 2026-09-11. La primera version puso 23,
    // que era un numero ADIVINADO a ojo desde un grep -- y el candado lo atrapo al instante.
    // Un baseline inventado convierte el trinquete en ruido.
    baseline: { crudas: 29 },
  },
  {
    eje: 'unidad de la celda',
    adr: 'ADR-057',
    resolvedores: ['v_unit_truth'],
    crudas: [],
    baseline: { crudas: 0 },
  },
  {
    eje: 'renglon de venta',
    adr: 'K.1 / ADR-059',
    resolvedores: ['v_erp_sales_line_units'],
    crudas: [],
    baseline: { crudas: 0 },
  },
  {
    eje: 'existencia valuada',
    adr: 'KE.1',
    resolvedores: ['v_erp_stock_truth'],
    crudas: [],
    baseline: { crudas: 0 },
  },
];

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };

/** Archivos que PUBLICAN: servicios y componentes. Sin specs, migraciones ni importers. */
function publicadores() {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'migrations-newdb' || e.name === 'dist') continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.includes('.spec.')) {
        out.push(p);
      }
    }
  };
  walk(path.join(ROOT, 'apps'));
  walk(path.join(ROOT, 'libs'));
  return out;
}

/** El texto SIN comentarios. Contar prosa infla el número y ya cobró una vez hoy. */
function codigoDe(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

(async () => {
  console.log('\n=== CANDADO: ¿alguien LEE los resolvedores? (VA.1) ===\n');
  console.log('  Edgar: "tu verdad absoluta fallo". Esto es la medición que le da la razón.\n');

  const files = publicadores();
  check('hay publicadores que medir', files.length > 100, `${files.length} archivos .ts`);
  if (files.length <= 100) {
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    process.exit(1);
  }

  // Se lee cada archivo UNA vez: el código sin comentarios, para todos los ejes.
  const codigo = new Map();
  for (const f of files) {
    try { codigo.set(f, codigoDe(f)); } catch { /* archivo ilegible: no se cuenta */ }
  }

  const cuenta = (token) => {
    let n = 0;
    for (const src of codigo.values()) if (src.includes(token)) n++;
    return n;
  };

  console.log('── 1. Adopción por eje, medida sobre código (sin comentarios) ──\n');
  console.log(`  ${'eje'.padEnd(22)}${'resolvedor'.padEnd(12)}${'crudas'.padEnd(10)}adopción`);
  const medidas = [];
  for (const e of EJES) {
    const res = e.resolvedores.reduce((a, r) => a + cuenta(r), 0);
    const cru = e.crudas.reduce((a, r) => a + cuenta(r), 0);
    const tot = res + cru;
    const pct = tot ? (100 * res / tot) : null;
    medidas.push({ ...e, res, cru, pct });
    console.log(`  ${e.eje.padEnd(22)}${String(res).padEnd(12)}${String(cru).padEnd(10)}`
      + `${pct == null ? 'n/a' : pct.toFixed(0) + '%'}`);
  }

  // ── 2. ⭐⭐ EL TRINQUETE: la brecha no puede EMPEORAR ──────────────────────────────────────
  console.log('\n── 2. ⭐⭐ El trinquete: la brecha puede cerrarse, nunca abrirse ──');
  for (const m of medidas) {
    if (!m.crudas.length) { continue; }
    check(`⭐ \`${m.eje}\`: las fuentes crudas no ganaron lectores (${m.adr})`,
      m.cru <= m.baseline.crudas,
      `${m.cru} publicadores leen ${m.crudas.join('/')} contra ${m.baseline.crudas} del baseline `
      + `2026-09-11 — alguien cableó un número nuevo a la fuente equivocada`);
    if (m.cru < m.baseline.crudas) {
      console.log(`     ⭐ mejoró: ${m.baseline.crudas} → ${m.cru}. Bajá el baseline en este archivo.`);
    }
  }

  // ── 3. ⛔ Un resolvedor sin lectores no es verdad: es una intención ───────────────────────
  console.log('\n── 3. ⛔ Un resolvedor SIN lectores ──');
  const huerfanos = medidas.filter((m) => m.res === 0);
  for (const h of huerfanos) {
    console.log(`     ⛔ \`${h.resolvedores.join(', ')}\` (${h.eje}) — CERO publicadores lo leen.`);
  }
  check('⭐⭐ ningún resolvedor canónico quedó con CERO lectores',
    huerfanos.length === 0,
    `${huerfanos.length} huérfanos: ${huerfanos.map((h) => h.resolvedores.join('/')).join(' · ')} `
    + '— arbitrar una vista que nadie consume no cambia ningún número publicado');

  // ── 4. La brecha de HOY se declara, no se dibuja como verde ───────────────────────────────
  console.log('\n── 4. La brecha de hoy, declarada ──');
  const conCrudas = medidas.filter((m) => m.crudas.length);
  const peor = conCrudas.slice().sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100))[0];
  if (peor) {
    console.log(`     El eje peor adoptado es \`${peor.eje}\`: ${peor.res} publicadores leen el`);
    console.log(`     resolvedor y ${peor.cru} siguen en ${peor.crudas.join('/')} (${peor.pct.toFixed(0)}% de adopción).`);
  }
  console.log('     ⚠️  Este bloque NO se pone rojo por la brecha: sería rojo permanente, y un');
  console.log('        rojo permanente se aprende a ignorar. El tamaño vive en');
  console.log('        `analytics.declared_gaps` (clave `resolvedores_sin_adopcion`), que sí');
  console.log('        caduca cuando alguien lo cierre.');

  // ── 5. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 5. Lo que este candado no mide ──');
  console.log('     ⚠️  Cuenta ARCHIVOS que tocan el token, no llamadas ni renglones publicados.');
  console.log('        Un archivo que lee la fuente cruda para un uso LEGÍTIMO (valuar inventario');
  console.log('        con `cost_base`, ADR-051) cuenta igual que uno que la usa mal. Sirve de');
  console.log('        trinquete, no de veredicto por consumidor.');
  console.log('     ⚠️  NO prueba que quien lee el resolvedor lo use bien. Sell-Out lo leía para');
  console.log('        las CAJAS desde U.7 y aun así publicaba el UxC desde `factor_sale`.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
