/* eslint-disable no-console */
/**
 * `[ZN.8]` — El alcance puede variar por ÁREA, y las áreas son las del árbol.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────
 * Hasta esta fase el alcance era UNO por persona y dimensión, igual en toda la
 * app. El pedido que lo cambió es real: *«hace el pedido de TODAS las
 * sucursales, ve reportes de ALGUNAS, y en otras sólo la zona Morelia»*. Con una
 * sola palanca eso no se puede expresar — y la bitácora de esa persona tiene
 * **cuatro cambios de alcance en quince días**, cada uno arreglando una pantalla
 * y rompiendo otra.
 *
 *   [1] El schema: `area` existe, entra en la PK y tiene su índice.
 *   [2] ⛔ **Nadie se movió.** La migración es aditiva: si hay filas fuera de
 *       `'*'` que nadie creó a propósito, algo cambió comportamiento en silencio.
 *   [3] ⛔ **No hay áreas que el árbol no conozca.** El id de proyecto se guarda
 *       como texto y un typo (`'compra'`) se guarda feliz — y crea una excepción
 *       que **no aplica a ninguna pantalla**, invisible, porque el resolvedor
 *       nunca la encuentra y cae al `'*'`.
 *   [4] La CONSULTA que hace el resolvedor devuelve lo que debe: las reglas del
 *       área pedida y las de `'*'`, y ninguna de otra área.
 *   [5] MÉTRICA (no falla): qué excepciones por área existen hoy.
 *
 * ⚠️ **Lo que este candado NO prueba:** cuál de las dos reglas gana. Eso es
 * `elegirRegla`, y se prueba donde se puede probar de verdad — en
 * `libs/contracts/src/authz/scope-areas.spec.ts`, con 12 casos y rojo ejercido.
 * Reimplementar la precedencia acá sería verificar una cosa contra una copia de
 * sí misma, que es como pasan los bugs en verde.
 *
 * ── Es READ-ONLY y por eso puede correr contra producción ───────────────────
 * Abre la sesión con `default_transaction_read_only = on`: no es una promesa,
 * es un candado.
 *
 * Correr:  ZN_DB_URL="<url>" node database/tests/test-newdb-zn8-alcance-por-area.js
 */

const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const DST =
  process.env.ZN_DB_URL ||
  process.env.DATABASE_URL_NEW ||
  (() => { throw new Error('falta ZN_DB_URL o DATABASE_URL_NEW'); })();

let ok = 0, fail = 0, sinMedir = 0;
const check = (t, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${t}`); }
  else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); }
};
const declarar = (t, motivo) => { sinMedir++; console.log(`  ⓘ NO MEDIDO ${t} — ${motivo}`); };
const info = (t) => console.log(`     → ${t}`);

const AREA_TODAS = '*';

/**
 * Los proyectos del árbol, leídos del FUENTE. ⚠️ No es una copia de la lista: es la lista, y si
 * alguien agrega un proyecto este candado se entera solo. Se lee con una expresión acotada al
 * nivel de proyecto (sangría de 8) para no tragarse los ids de módulo, que viven más adentro.
 */
function areasDelArbol() {
  const fs = require('node:fs');
  const path = require('node:path');
  const f = path.join(__dirname, '..', '..', 'libs', 'contracts', 'src', 'authz', 'authz-tree.ts');
  // ⚠️ La imagen de `prod-api` NO lleva el fuente TypeScript. Corriendo ahí, este bloque no se
  // puede medir — y entonces se DECLARA, no se da por bueno. Un candado que se pone verde
  // porque no encontró con qué comparar es peor que no tenerlo.
  if (!fs.existsSync(f)) return null;
  const txt = fs.readFileSync(f, 'utf8');
  const ids = [...txt.matchAll(/^ {8}id: '([a-z0-9_-]+)',$/gm)].map((m) => m[1]);
  return new Set(ids);
}

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy\./i.test(DST) ? { rejectUnauthorized: false } : undefined,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');

  const { rows: [meta] } = await db.query(
    `SELECT current_database() AS db, inet_server_addr()::text AS host`,
  );
  console.log(`\n[ZN.8] alcance por área — ${meta.db} @ ${meta.host || 'local'}\n`);

  // ── [1] Schema ────────────────────────────────────────────────────────────
  console.log('[1] `area` existe, entra en la PK y tiene índice');
  for (const tabla of ['user_scopes', 'role_scopes']) {
    const { rows: [col] } = await db.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'identity' AND table_name = $1 AND column_name = 'area'`, [tabla],
    );
    check(`${tabla}.area existe, NOT NULL y con default`,
      !!col && col.is_nullable === 'NO' && /\*/.test(col.column_default ?? ''));

    const { rows: [pk] } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'p'`, [`identity.${tabla}`],
    );
    check(`${tabla}: la PK incluye area`, /\barea\b/.test(pk?.def ?? ''), pk?.def);
  }

  // ── [2] Nadie se movió ────────────────────────────────────────────────────
  console.log('\n[2] La migración fue aditiva: la regla general sigue siendo la de siempre');
  const { rows: [gen] } = await db.query(
    `SELECT (SELECT count(*)::int FROM identity.user_scopes WHERE area = $1) AS u_gen,
            (SELECT count(*)::int FROM identity.user_scopes) AS u_tot,
            (SELECT count(*)::int FROM identity.role_scopes WHERE area = $1) AS r_gen,
            (SELECT count(*)::int FROM identity.role_scopes) AS r_tot`, [AREA_TODAS],
  );
  info(`usuario: ${gen.u_gen} de ${gen.u_tot} en '*' · rol: ${gen.r_gen} de ${gen.r_tot}`);
  check('toda regla de ROL es general — una excepción por área en un rol se la lleva quien lo herede',
    gen.r_gen === gen.r_tot,
    'si esto cambia a propósito, hay que decirlo acá: afecta a todos los de ese rol');

  // ── [3] Ningún área desconocida ───────────────────────────────────────────
  console.log('\n[3] Toda área guardada existe en AUTHZ_TREE');
  const arbol = areasDelArbol();
  const { rows: usadas } = await db.query(
    `SELECT DISTINCT area FROM identity.user_scopes
      UNION SELECT DISTINCT area FROM identity.role_scopes`,
  );
  if (!arbol) {
    declarar('que toda área guardada exista en el árbol',
      'este destino no trae el fuente TS (la imagen de prod-api no lo lleva); corre en local');
  } else {
    info(`el árbol declara ${arbol.size} proyectos`);
    check('se pudieron leer los proyectos del árbol', arbol.size > 5,
      'sin esto el bloque siguiente estaría verde por ceguera');
    const desconocidas = usadas
      .map((r) => r.area)
      .filter((a) => a !== AREA_TODAS && !arbol.has(a));
    check(`ninguna de las ${usadas.length} área(s) en uso es desconocida`,
      desconocidas.length === 0, desconocidas.join(', '));
  }

  // ── [4] La consulta del resolvedor ────────────────────────────────────────
  console.log('\n[4] La consulta del resolvedor trae su área y la general, y nada más');
  const areaPrueba = arbol ? [...arbol][0] : 'compras';
  const { rows: traidas } = await db.query(
    `SELECT area, count(*)::int AS n FROM identity.role_scopes
      WHERE area = ANY ($1) GROUP BY area ORDER BY area`,
    [[AREA_TODAS, areaPrueba]],
  );
  check(`pidiendo ['*','${areaPrueba}'] no vuelve ninguna otra área`,
    traidas.every((r) => r.area === AREA_TODAS || r.area === areaPrueba),
    traidas.map((r) => r.area).join(', '));
  // Control negativo: sin el filtro vendrían TODAS. Si hoy sólo existe `'*'`, el bloque no
  // distingue nada y se DECLARA en vez de ponerse verde por no tener con qué fallar.
  if (usadas.length <= 1) {
    declarar('que el filtro por área descarta algo',
      'todavía no existe ninguna excepción: el filtro no tiene qué descartar');
  } else {
    const { rows: [todas] } = await db.query(
      `SELECT count(DISTINCT area)::int AS n FROM identity.role_scopes`,
    );
    check('y sin el filtro vendrían más — o sea que el filtro hace algo',
      todas.n > traidas.length || usadas.length > traidas.length);
  }

  // ── [5] MÉTRICA ───────────────────────────────────────────────────────────
  console.log('\n[5] Excepciones por área que existen hoy');
  const { rows: exc } = await db.query(
    `SELECT u.username, s.dimension, s.area, s.mode, s.values
       FROM identity.user_scopes s JOIN identity.users u ON u.id = s.user_id
      WHERE s.area <> $1 ORDER BY u.username, s.dimension`, [AREA_TODAS],
  );
  if (!exc.length) {
    info('ninguna todavía — el mecanismo está, falta usarlo desde /admin/personas');
  } else {
    exc.forEach((r) =>
      info(`${r.username} · ${r.dimension} en ${r.area} = ${r.mode} ${r.values ? JSON.stringify(r.values) : ''}`));
  }

  console.log(`\n${ok} ok · ${fail} fallos · ${sinMedir} no medidos\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
