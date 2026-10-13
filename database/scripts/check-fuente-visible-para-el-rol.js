'use strict';
/**
 * ⭐⭐ `[CG.131]` — **¿La fuente que vas a leer se ve desde el rol que EJECUTA?**
 *
 *   node database/scripts/check-fuente-visible-para-el-rol.js finance.kepler_accounts analytics.v_caja_contracuenta_cobro
 *   node database/scripts/check-fuente-visible-para-el-rol.js --migracion <archivo.js>
 *
 * Sólo lee. Se corre **con el mismo rol y desde el mismo lugar** que va a correr la migración —
 * dentro de `prod-api`, no desde la máquina de trabajo. Ésa es toda la idea.
 *
 * ── El incidente que lo paga, 2026-10-13 ────────────────────────────────────────────────────
 *
 * `[CG.129]` ajustó 25 ingresos de caja a su cuenta correcta y dejó `kepler_cuenta_nombre` en
 * **NULL en los 25**. El ensayo previo había dicho «25 de 25 resuelven nombre» — y era cierto,
 * **con el rol equivocado**:
 *
 *     finance.kepler_accounts   con el rol de la maquina de trabajo ... 182 filas
 *     finance.kepler_accounts   con el rol del pod (postgres) .........   0 filas
 *
 * No es una tabla: es una **vista con `security_invoker = true`** que lee de
 * `analytics.ledger_monthly`. El `LEFT JOIN` devolvió `NULL` **sin un solo error**, y el
 * resultado fue el peor síntoma posible: **el dato correcto con la etiqueta vacía**. La pantalla
 * muestra el nombre, no el código, así que el movimiento corregido se veía sin nombre de cuenta y
 * nadie lo iba a leer como un error de la corrección.
 *
 * ⭐⭐ Es la misma trampa de `[CP.8.44]`, al revés: allá un candado se conectaba con `dev_ro` y
 * verificaba un permiso que producción no ejercía; acá se **ensayó con un rol y se ejecutó con
 * otro**. *Un ensayo que no usa el rol del que ejecuta no ensayó nada.*
 *
 * ── Qué mide, y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Para cada objeto: **si existe, de qué tipo es, si es una vista con `security_invoker`, y
 * cuántas filas ve el rol actual**. Cero filas en una fuente que debería tener datos es el
 * hallazgo — y es lo que un `LEFT JOIN` convierte en `NULL` silencioso.
 *
 * ⛔ **No prueba el JOIN**, sólo la visibilidad. Un objeto visible puede seguir sin casar por la
 * llave; eso se mide aparte. Lo que esto cierra es la clase de error donde la fuente está vacía
 * **para quien ejecuta** y llena para quien ensaya.
 *
 * ⚠️ Un objeto con **cero filas de verdad** (una tabla recién creada) no se distingue acá de uno
 * invisible por permisos. Por eso la salida no dice «mal»: dice **cuántas filas ve este rol**, y
 * quien lee compara contra lo que esperaba. Dibujar un veredicto sobre esa ambigüedad sería la
 * misma falta que el script viene a cerrar.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const args = process.argv.slice(2);

/** Saca los `schema.objeto` que una migración menciona, para no tener que listarlos a mano. */
function objetosDe(archivo) {
  const txt = fs.readFileSync(archivo, 'utf8');
  const rx = /\b(finance|analytics|commercial|catalog|identity|kepler_ods|caja_general_ods)\.([a-z_][a-z0-9_]*)/g;
  return [...new Set([...txt.matchAll(rx)].map((m) => `${m[1]}.${m[2]}`))];
}

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }

  let objetos = args.filter((a) => !a.startsWith('--'));
  const iMig = args.indexOf('--migracion');
  if (iMig >= 0) {
    const f = args[iMig + 1];
    if (!f) { console.error('--migracion necesita el archivo'); process.exit(1); }
    const ruta = fs.existsSync(f) ? f : path.join('database', 'migrations-newdb', f);
    objetos = objetosDe(ruta);
    console.log(`objetos mencionados por ${path.basename(ruta)}: ${objetos.length}`);
  }
  if (!objetos.length) {
    console.error('Pasá uno o más `schema.objeto`, o `--migracion <archivo.js>`.');
    process.exit(1);
  }

  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`SET statement_timeout = '60s'`);

  const { rows: [quien] } = await c.query(
    `SELECT current_user AS rol, current_database() AS base, inet_server_addr()::text AS host`);
  console.log(`\nrol: ${quien.rol} · base: ${quien.base} · host: ${quien.host ?? '(local)'}`);
  console.log('⚠️ Si este rol NO es el que va a ejecutar la migración, esta medición no sirve.\n');

  const out = [];
  for (const o of objetos) {
    const { rows: [m] } = await c.query(`
      SELECT c.relkind::text AS kind,
             (c.reloptions::text ILIKE '%security_invoker=true%') AS invoker,
             c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`, o.split('.'));
    if (!m) { out.push({ objeto: o, tipo: '⛔ NO EXISTE', filas: '—', nota: '' }); continue; }

    const tipo = { r: 'tabla', v: 'vista', m: 'matvista', p: 'particionada', f: 'foranea' }[m.kind] || m.kind;
    let filas = '—'; let nota = '';
    try {
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n FROM ${o}`);
      filas = n.n;
      // ⛔ Cero filas es el hallazgo: es lo que un LEFT JOIN vuelve NULL sin avisar.
      if (n.n === 0) nota = '⛔ CERO filas para este rol — un LEFT JOIN daria NULL sin error';
    } catch (e) {
      filas = '✗';
      nota = String(e.message).slice(0, 60);
    }
    if (m.invoker && !nota) nota = 'vista con security_invoker: lo que ve depende del rol';
    if (m.forzado && !nota) nota = 'RLS FORZADO: sin tenant seteado devuelve vacio';
    out.push({ objeto: o, tipo, filas, nota });
  }

  console.table(out);

  const ciegos = out.filter((r) => r.filas === 0 || r.filas === '✗' || r.tipo === '⛔ NO EXISTE');
  console.log(ciegos.length
    ? `\n⚠️ ${ciegos.length} fuente(s) que este rol NO puede leer o ve vacías. `
      + 'Si la migración las lee en un LEFT JOIN, va a escribir NULL sin fallar.'
    : '\n✓ Este rol ve filas en todas las fuentes listadas.');

  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
