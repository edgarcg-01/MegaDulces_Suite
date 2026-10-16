'use strict';
/**
 * ⭐⭐ `[CGA-A.11]` — **Un descuento anti-duplicado se hace por LLAVE, nunca por TEXTO.**
 * Esta compuerta impide que vuelva a entrar un `LIKE` sobre una columna de prosa dentro de una
 * existencia negada.
 *
 * ── El incidente que la funda, medido en PROD el 2026-10-16 ────────────────────────────────
 *
 *     // finance: movimientosPendientes()
 *     .whereNotExists(sub => sub.from('finance.cash_ledger as yac')
 *       .whereRaw(`yac.glosa LIKE v.doc_tipo || ' ' || v.folio || '%'`))
 *
 * `glosa` es texto libre para que lo lea una persona. Que empiece con `doc_tipo folio` es un
 * **formato**, no un contrato. Y el folio de camioneta es consecutivo **por unidad**, no global:
 * dos unidades comparten folio el mismo día de forma rutinaria. Cada captura tapaba a sus
 * homónimos de otras sucursales.
 *
 *     01-006  ruta_28  U-A-5 0000013  $13,699.00  ← capturado
 *     01-002  ruta_22  U-A-5 0000013  $15,321.00  ← INVISIBLE
 *
 * **157 movimientos · $1,325,687.43** escondidos. Detalle en `GOTCHAS` §86.
 *
 * ⛔ **Por qué una existencia NEGADA es lo peligroso, y no el `LIKE` a secas.** Un `LIKE` en un
 * `WHERE` normal de más: trae filas que no querías, se ven, alguien se queja. Un `LIKE` dentro de
 * un `NOT EXISTS` **quita** filas: no hay error, no hay log, no hay descuadre — **la fila
 * simplemente deja de existir para la pantalla**. Por eso la compuerta mira sólo ese caso.
 *
 * ── Cómo se arregla, no cómo se silencia ───────────────────────────────────────────────────
 *
 * La llave existe: `origen_tipo + origen_ref`, con el candado `ux_cash_ledger_origen_vivo`.
 * Si el origen no trae la llave, **el defecto es del origen** y se arregla ahí — no se compensa
 * comparando prosa. (`[CGA-A.10]`: la captura desde CAOS declara el documento en una columna.)
 *
 * ── El trinquete ───────────────────────────────────────────────────────────────────────────
 *
 * La deuda que YA existe está declarada abajo con su motivo y su salida, **contada**. La
 * compuerta no se pone roja por ella —eso la apagaría el primer día—, pero **sí por el
 * siguiente**. Y cuando `[CGA-A.10]` quite los dos sitios, hay que bajar el número a 0: si
 * quedan menos de los declarados, la compuerta también avisa, para que nadie deje el permiso
 * puesto después de haber arreglado el problema.
 *
 * uso:  node scripts/check-dedup-por-llave.js [--probar-negativo]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs', 'database'];
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);
const IGNORAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp']);

/** Columnas de PROSA: las escribe un humano o se arman concatenando. No son identidad. */
const PATRON = /\b(?:\w+\.)?(glosa|concepto|descripcion|descripción|observaciones|referencia|notas)\b\s+(?:NOT\s+)?I?LIKE\b/i;

/**
 * El trinquete. `n` = cuántos `LIKE` sobre prosa dentro de una existencia negada se toleran HOY
 * en ese archivo, con el porqué y con la salida. **Bajar el número al arreglarlos; nunca subirlo
 * sin que esté escrito acá por qué.**
 */
const DEUDA_DECLARADA = [
  {
    rel: path.join('libs', 'finance', 'src', 'lib', 'caja', 'cash-ledger.service.ts'),
    n: 2,
    motivo: 'la captura desde CAOS declara el documento en la glosa porque no tiene columna propia',
    salida: '[CGA-A.10] columna `declared_doc_ref` → el descuento pasa a ser igualdad por llave',
  },
  // ⚠️ Estas dos REPLICAN el descuento del servicio en vez de ejercerlo, y por eso llevaban el
  // defecto adentro: el `AND origen_tipo = 'caos'` les faltaba igual que al original, así que
  // certificaban el bug. Se corrigieron el 16-oct (`[CGA-A.11]`) y quedan declaradas porque
  // siguen comparando prosa — se van junto con el servicio cuando entre `[CGA-A.10]`.
  {
    rel: path.join('database', 'tests', 'test-newdb-cola-sin-duplicados.js'),
    n: 1,
    motivo: 'replica el descuento de [CG.85] para poder ejercer su negativa',
    salida: '[CGA-A.10] y, mejor aún, dejar de replicar: ejercer el servicio',
  },
  {
    rel: path.join('database', 'tests', 'test-newdb-caja-cobertura.js'),
    n: 1,
    motivo: 'replica el descuento para armar el denominador de cobertura',
    salida: '[CGA-A.10] y, mejor aún, dejar de replicar: ejercer el servicio',
  },
];

/** El archivo que documenta la trampa puede nombrarla sin ser culpable de ella. */
const EXENTOS = new Set([
  path.join('scripts', 'check-dedup-por-llave.js'),
  path.join('database', 'scripts', 'check-cobro-escondido.js'),
  path.join('database', 'scripts', 'check-cobro-monto-desfasado.js'),
]);

function archivos(dir, acc) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (EXT.has(path.extname(e.name))) acc.push(p);
  }
  return acc;
}

/** Un comentario que MENCIONA la forma mala no es la forma mala. */
function esComentario(linea) {
  const t = linea.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * ⚠️ ¿Este `LIKE` vive dentro de una existencia NEGADA?
 *
 * El SQL real se escribe en varias líneas, así que el `whereNotExists` casi nunca está en la
 * misma línea que el `LIKE`. Se mira hacia atrás hasta 25 líneas. Se corta si antes aparece un
 * `whereExists`/`EXISTS` **sin negar**, porque entonces el `LIKE` pertenece a esa otra
 * subconsulta y ahí no quita nada: agrega.
 */
function dentroDeExistenciaNegada(lineas, i) {
  for (let j = i; j >= Math.max(0, i - 25); j--) {
    const l = lineas[j];
    if (/\bwhereNotExists\b|\bNOT\s+EXISTS\b/i.test(l)) return true;
    if (j < i && /\bwhereExists\b|(?<!NOT\s)\bEXISTS\s*\(/i.test(l)) return false;
  }
  return subconsultaConNombre(lineas, i);
}

/**
 * ⭐⭐ **El caso que la primera versión NO vio, y era uno de los dos sitios del incidente.**
 *
 *     const yaCapturado = (sub) => sub.from('…').whereRaw(`… yac.glosa LIKE …`);
 *     …
 *     qb.whereNotExists(yaCapturado);          // ← 6 líneas MÁS ABAJO
 *
 * Mirar sólo hacia atrás da **falso negativo**, que es peor que un falso positivo: la compuerta
 * sale verde sobre el defecto que la funda. Si el `LIKE` vive en una lambda con nombre, hay que
 * buscar ese nombre en TODO el archivo.
 */
function subconsultaConNombre(lineas, i) {
  for (let j = i; j >= Math.max(0, i - 40); j--) {
    const m = lineas[j].match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*\w*\s*(?::[^=]*)?\)?\s*=>/);
    if (!m) continue;
    const nombre = m[1];
    const usado = new RegExp(`whereNotExists\\s*\\(\\s*${nombre}\\b`);
    return lineas.some((l) => usado.test(l));
  }
  return false;
}

function revisar() {
  const hallazgos = [];
  for (const d of DIRS) {
    for (const f of archivos(path.join(RAIZ, d), [])) {
      const rel = path.relative(RAIZ, f);
      if (EXENTOS.has(rel)) continue;
      const lineas = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      lineas.forEach((linea, i) => {
        if (esComentario(linea)) return;
        if (!PATRON.test(linea)) return;
        if (!dentroDeExistenciaNegada(lineas, i)) return;
        hallazgos.push({ rel, n: i + 1, linea: linea.trim().slice(0, 110) });
      });
    }
  }
  return hallazgos;
}

// ── Prueba negativa: una compuerta que nunca se vio en rojo es una intención ────────────────
if (process.argv.includes('--probar-negativo')) {
  const malo = [
    '.whereNotExists((sub) => sub',
    "  .from('finance.cash_ledger as yac')",
    '  .whereRaw(`yac.glosa LIKE v.doc_tipo || \' \' || v.folio || \'%\'`))',
  ];
  const maloSql = [
    'AND NOT EXISTS (SELECT 1 FROM finance.cash_ledger y',
    "  WHERE y.concepto ILIKE v.doc_tipo || '%')",
  ];
  // ⭐ Los dos casos que NO deben marcarse, y que son la diferencia entre una compuerta y ruido.
  const buenoPositivo = [
    'AND EXISTS (SELECT 1 FROM finance.cash_ledger y',
    "  WHERE y.glosa LIKE '%' || v.folio || '%')",   // suma filas, no las quita
  ];
  const buenoLlave = [
    '.whereNotExists((sub) => sub',
    "  .from('finance.cash_ledger as yac')",
    '  .whereRaw(`yac.origen_ref = v.origen_ref`))',  // la forma correcta
  ];
  const buenoBusqueda = [
    '// buscador: glosa ILIKE ? es correcto, suma resultados',
    'qb.orWhereRaw(`glosa ILIKE ? ESCAPE \'\\\\\'`, [s]);',
  ];

  // ⭐ El sitio que la primera versión dejó pasar: la lambda con nombre, usada más abajo.
  const maloConNombre = [
    'const yaCapturado = (sub: Knex.QueryBuilder) => sub',
    "  .from('finance.cash_ledger as yac')",
    '  .whereRaw(`yac.glosa LIKE v.doc_tipo || \' \' || v.folio || \'%\'`);',
    'let qb = trx(\'finance.v_caja_movimientos_pendientes\')',
    '  .whereNotExists(yaCapturado);',
  ];
  // …y la misma lambda SIN que nadie la niegue: eso no quita filas.
  const buenoConNombre = [
    'const candidatos = (sub) => sub',
    "  .from('finance.cash_ledger as yac')",
    '  .whereRaw(`yac.glosa LIKE \'%\' || v.folio || \'%\'`);',
    'let qb = trx(\'x\').whereExists(candidatos);',
  ];

  let fallas = 0;
  const marca = (bloque) => bloque.some((l, i) =>
    !esComentario(l) && PATRON.test(l) && dentroDeExistenciaNegada(bloque, i));

  if (!marca(malo)) { console.error('  ✗ NO detectó el glosa LIKE dentro de whereNotExists'); fallas++; }
  if (!marca(maloSql)) { console.error('  ✗ NO detectó el concepto ILIKE dentro de NOT EXISTS'); fallas++; }
  if (marca(buenoPositivo)) { console.error('  ✗ FALSO POSITIVO: EXISTS sin negar (agrega filas, no las quita)'); fallas++; }
  if (marca(buenoLlave)) { console.error('  ✗ FALSO POSITIVO: la forma correcta, por llave'); fallas++; }
  if (marca(buenoBusqueda)) { console.error('  ✗ FALSO POSITIVO: un buscador libre'); fallas++; }
  if (!marca(maloConNombre)) { console.error('  ✗ NO detectó la lambda con nombre usada en whereNotExists'); fallas++; }
  if (marca(buenoConNombre)) { console.error('  ✗ FALSO POSITIVO: lambda con nombre usada en whereExists'); fallas++; }

  if (fallas) { console.error(`\n⛔ la prueba negativa falló en ${fallas} caso(s).`); process.exit(1); }
  console.log('✓ prueba negativa: detecta los 3 casos malos y no marca los 4 buenos');
  console.log('  (EXISTS sin negar, el descuento por llave, un buscador libre, y la lambda no negada).');
  process.exit(0);
}

const hallazgos = revisar();
const porArchivo = new Map();
for (const h of hallazgos) porArchivo.set(h.rel, (porArchivo.get(h.rel) || 0) + 1);

let rojo = false;
console.log('');

for (const [rel, n] of [...porArchivo].sort()) {
  const d = DEUDA_DECLARADA.find((x) => x.rel === rel);
  if (!d) {
    rojo = true;
    console.log(`⛔ ${rel} — ${n} LIKE sobre prosa dentro de una existencia negada, SIN declarar`);
    for (const h of hallazgos.filter((x) => x.rel === rel)) console.log(`     :${h.n}  ${h.linea}`);
    console.log('   Un descuento anti-duplicado va por LLAVE (`origen_tipo` + `origen_ref`).');
    console.log('   Si el origen no la trae, el defecto es del origen. Ver GOTCHAS §86.\n');
  } else if (n > d.n) {
    rojo = true;
    console.log(`⛔ ${rel} — ${n} hallazgos, pero sólo hay ${d.n} declarados. El trinquete subió.\n`);
  } else if (n < d.n) {
    console.log(`·  ${rel} — ${n} de ${d.n} declarados: bajá el número en DEUDA_DECLARADA.\n`);
  } else {
    console.log(`·  ${rel} — ${n} declarado(s): ${d.motivo}`);
    console.log(`   salida: ${d.salida}\n`);
  }
}

for (const d of DEUDA_DECLARADA) {
  if (!porArchivo.has(d.rel)) {
    console.log(`·  ${d.rel} — ya no tiene ninguno. Quitá su entrada de DEUDA_DECLARADA.\n`);
  }
}

if (rojo) {
  console.log('⛔ compuerta en ROJO.\n');
  process.exit(1);
}
console.log('✓ Ningún descuento anti-duplicado nuevo compara texto libre.\n');
process.exit(0);
