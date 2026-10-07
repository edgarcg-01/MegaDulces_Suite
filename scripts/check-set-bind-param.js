'use strict';
/**
 * `[VL.16]` **Postgres NO acepta parámetros ligados en `SET`. Esta compuerta lo impide.**
 *
 * ── El incidente que la funda, medido en PROD el 2026-09-23 ─────────────────────────────────
 *
 *     await trx.raw('SET LOCAL app.tenant_id = ?', [tenant.id]);
 *
 * knex convierte su `?` en el `$1` de Postgres, y el servidor responde:
 *
 *     42601  SET LOCAL app.tenant_id = $1 - syntax error at or near "$1"
 *
 * Eso estaba en `login-core.ts`, en el camino de `POST /api/auth-mt/login`. Resultado: **500 a
 * todo el mundo, nadie podía entrar**, y hubo que volver la versión anterior en caliente.
 *
 * ⚠️ Y el daño no siempre es un 500 ruidoso. El mismo defecto en
 * `provenance/freshness.ts` vivía dentro de un `try` cuyo `catch` marca `at = null` =
 * "no se pudo medir": ahí la medición de frescura se declaraba **ciega por un defecto propio**,
 * no por el dato. Un bug que se disfraza de "no medido" no lo reporta nadie. Por eso la
 * compuerta busca la FORMA, no el síntoma: los dos sitios eran el mismo error y sólo uno gritaba.
 *
 * ⚠️ Lo más caro del caso: **el repo YA lo sabía**. `apps/api/src/modules/store/store.service.ts`
 * tiene el comentario textual «set_config admite bind param (SET LOCAL x = ? NO — Postgres
 * rechaza params en SET)». El conocimiento estaba escrito en un comentario, que no frena nada.
 * Un comentario no es una compuerta.
 *
 * ── La forma correcta ───────────────────────────────────────────────────────────────────────
 *
 *     await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant.id]);
 *
 * Misma semántica (`true` = LOCAL: se revierte al cerrar la transacción) y sí admite el
 * parámetro, porque es una LLAMADA A FUNCIÓN, no la sentencia `SET`.
 *
 * ── Qué NO marca, y por qué ─────────────────────────────────────────────────────────────────
 *
 * `UPDATE … SET col = ?` es una sentencia distinta y ahí los parámetros son válidos y normales.
 * Confundirlas volvería la compuerta ruido: hay cientos de UPDATE en el repo. Se exige que el
 * `SET` arranque la sentencia (principio de línea o tras una comilla de apertura de plantilla),
 * y se descarta explícitamente todo lo que venga precedido de `UPDATE`.
 *
 * uso:  node scripts/check-set-bind-param.js [--probar-negativo]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs', 'database', 'scripts'];
const EXT = new Set(['.ts', '.js', '.mjs', '.cjs']);
const IGNORAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp']);

/**
 * `SET [LOCAL|SESSION] <nombre> = ?`  ó  `= $1`, al INICIO de la sentencia.
 * El `(^|\`|'|"|;|\()\s*` ancla el arranque: descarta `UPDATE t SET c = ?`, donde el `SET` va
 * precedido del nombre de la tabla.
 */
const PATRON = /(^|[`'";(])\s*SET\s+(?:LOCAL\s+|SESSION\s+)?[a-zA-Z_][\w.]*\s*=\s*(\?|\$\d+)/im;

/** El archivo que documenta la trampa puede nombrarla sin ser culpable de ella. */
const EXENTOS = new Set([
  path.join('scripts', 'check-set-bind-param.js'),
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

/** ¿La línea es un comentario? Un comentario que MENCIONA la forma mala no es la forma mala. */
function esComentario(linea) {
  const t = linea.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * ⚠️ ¿El `SET` de esta línea pertenece a un `UPDATE`?
 *
 * La primera versión de esta compuerta miraba UNA línea y marcó **7 falsos positivos** en su
 * primer barrido: el SQL real se escribe en varias líneas y el `SET` de un `UPDATE` cae en una
 * línea de continuación, donde el `UPDATE` ya no se ve. Una compuerta con 7 falsos en 7
 * hallazgos es peor que ninguna — se apaga el primer día.
 *
 * Se mira hacia atrás hasta 8 líneas buscando el `UPDATE`, y se corta en el `;` que cierra la
 * sentencia anterior: un `UPDATE` de dos sentencias más arriba no tiene nada que ver con este
 * `SET`.
 */
function vieneDeUnUpdate(lineas, i) {
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const l = lineas[j];
    if (j < i && /;/.test(l)) return false;           // cerró la sentencia anterior
    if (/\bUPDATE\b/i.test(l) && !/\bSET\s+(LOCAL|SESSION)\b/i.test(l)) return true;
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
        if (vieneDeUnUpdate(lineas, i)) return;
        hallazgos.push({ rel, n: i + 1, linea: linea.trim().slice(0, 110) });
      });
    }
  }
  return hallazgos;
}

// ── Prueba negativa: una compuerta que nunca se vio en rojo es una intención ────────────────
if (process.argv.includes('--probar-negativo')) {
  const casosMalos = [
    "await trx.raw('SET LOCAL app.tenant_id = ?', [t]);",
    'await trx.raw(`SET LOCAL statement_timeout = ?`, [previo]);',
    "conn.query('SET search_path = $1', [s]);",
  ];
  // ⭐ El caso MULTILINEA es el que rompio la primera version: 7 falsos positivos en el primer
  // barrido real. Va acá para que no vuelva.
  const updateMultilinea = [
    'await knex.raw(`UPDATE catalog.products',
    '     SET embedding = ?::vector,',
    '         updated_at = now()',
    '   WHERE id = ?`, [v, id]);',
  ];
  const casosBuenos = [
    "await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]);",
    "await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);",
    'await knex("users").update({ a: 1 });',
    "await knex.raw('UPDATE p SET embedding = ?::vector WHERE id = ?', [v, id]);",
    "// SET LOCAL x = ? esta MAL, se documenta acá",
  ];
  let fallas = 0;
  for (const c of casosMalos) {
    if (!PATRON.test(c) || esComentario(c)) { console.error(`  ✗ NO detecto lo malo: ${c}`); fallas++; }
  }
  for (const c of casosBuenos) {
    if (!esComentario(c) && PATRON.test(c) && !vieneDeUnUpdate([c], 0)) {
      console.error(`  ✗ FALSO POSITIVO: ${c}`); fallas++;
    }
  }
  // ⭐ El caso que ROMPIÓ la primera versión. Sin este bloque la prueba decía ✓ sin ejercitarlo.
  updateMultilinea.forEach((linea, i) => {
    if (!esComentario(linea) && PATRON.test(linea) && !vieneDeUnUpdate(updateMultilinea, i)) {
      console.error(`  ✗ FALSO POSITIVO (UPDATE multilínea): ${linea.trim()}`); fallas++;
    }
  });
  if (fallas) { console.error(`\n⛔ la prueba negativa falló en ${fallas} caso(s).`); process.exit(1); }
  console.log('✓ prueba negativa: detecta los 3 casos malos, y no marca los 5 buenos ni el UPDATE multilínea.');
  process.exit(0);
}

const h = revisar();
if (!h.length) {
  console.log('✓ sin parámetros ligados en sentencias SET.');
  process.exit(0);
}
console.error('⛔ PARÁMETRO LIGADO EN UNA SENTENCIA `SET` — Postgres lo rechaza con 42601:\n');
for (const x of h) console.error(`   ${x.rel}:${x.n}\n      ${x.linea}`);
console.error(`\n   ${h.length} sitio(s). Usá:  trx.raw(\`SELECT set_config('<clave>', ?, true)\`, [valor])`);
console.error('   `true` = LOCAL (se revierte al cerrar la tx). Es una función, por eso sí admite el parámetro.');
console.error('\n   Esto tumbó el login de PROD el 2026-09-23. No es teórico.');
process.exit(1);
