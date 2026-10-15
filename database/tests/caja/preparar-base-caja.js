#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CGP-D.1.1]` — Arma DESDE CERO la base donde se prueba el corte de Caja General.
 *
 * ── Por qué existe, y por qué no se arregló el arranque genérico ─────────────────────────────
 * El job `caja-db` usaba `dev:bootstrap-vacia`, que repite TODA la historia de migraciones
 * (~1,000) y salta las que fallan. La primera corrida (38678099685) se detuvo en una migración de
 * rutas que no tiene nada que ver con caja, por un tope de 120 saltos. Ese script depende de cada
 * migración nueva de cualquier módulo: se va a seguir rompiendo. Éste depende sólo de caja.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. Aplica las MIGRACIONES REALES que crean o alteran el núcleo del corte (el libro, el
 *     desglose, la secuencia, los cortes y su desglose, la vista de saldo), en orden, más la de
 *     origen del tenant (`current_tenant_id()`). No usa un esquema escrito a mano: eso probaría
 *     una copia, no lo que corre en prod.
 *  2. Si una migración pide algo AJENO que no existe:
 *       · una tabla o vista → se crea VACÍA con las columnas del snapshot de prod
 *         (`docs/esquema-bd-prod-columnas.csv`), como tabla: sólo tiene que existir con su forma;
 *       · una función → se aplica la migración que la crea;
 *       · un schema → se crea.
 *  3. ⛔ NUNCA salta una migración. Si algo no se puede resolver, se detiene y dice qué. Saltar es
 *     lo que vuelve poco confiable al arranque genérico: una migración saltada se registra como
 *     aplicada sin haber corrido, y la prueba pasa contra un esquema que no es el de prod.
 *
 * Todo lo que hizo queda en `public._caja_test_base`, para que una prueba o una persona sepa
 * sobre qué tipo de base está parada.
 *
 * ⛔ ESTA BASE NO ES PROD: valida estructura, reglas, RLS y permisos del corte. No mide datos.
 *
 * Uso (sólo contra un Postgres local y VACÍO):
 *     node database/tests/caja/preparar-base-caja.js --url postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform
 */
const fs = require('fs');
const path = require('path');
const { classify } = require('../../../libs/platform-core/src/lib/provenance/target-guard.js');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DIR = path.join(REPO, 'database', 'migrations-newdb');
const CSV = path.join(REPO, 'docs', 'esquema-bd-prod-columnas.csv');

/** La migración que crea `tenants` y `current_tenant_id()`: el piso de toda tabla con RLS. */
const ORIGEN = '20260526000001_init_tenants_and_extensions.js';
/** Las tablas y la vista que son el corte. Una migración que las crea o altera, entra. */
const NUCLEO = ['cash_ledger_cut_denominations', 'cash_ledger_cuts', 'cash_ledger_denominations',
  'cash_ledger_sequences', 'v_cash_ledger_balance', 'cash_ledger'];
/**
 * Lo que LEE el servicio del corte fuera del núcleo (`contar`, `cerrar`, `saldo`): las dos piernas
 * de la bóveda (CAOS) y el reparto cajón/bóveda. Sin esto la base sirve para probar las reglas de
 * la tabla, pero no el servicio real. Se trae la migración REAL que crea cada objeto.
 */
const LEE_EL_SERVICIO = ['analytics.caos_cash_movements', 'analytics.v_caja_reparto_movimiento', 'finance.caos_cash_links'];
const MAX_REMEDIOS = 200;

// ── utilidades ──────────────────────────────────────────────────────────────────────────────
function argumentos(argv) {
  const o = { url: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') o.url = argv[++i];
    else { console.error(`Argumento desconocido: ${argv[i]}`); process.exit(2); }
  }
  return o;
}

/** Quita comentarios JS y SQL: una tabla mencionada en un comentario no es una dependencia. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    .replace(/--[^\n]*/g, ' ');
}

/**
 * ¿La migración CREA o ALTERA una pieza del núcleo? Leerla no cuenta: una vista que hace
 * `FROM finance.cash_ledger` es de otro módulo, y traerla arrastra su historia entera (así se
 * metía `20260925120000`, que redefine `analytics.erp_collections`).
 */
function tocaNucleo(codigo) {
  return NUCLEO.some((t) => [
    `(CREATE|ALTER)\\s+(TABLE|VIEW|OR\\s+REPLACE\\s+VIEW|MATERIALIZED\\s+VIEW)\\s+(IF\\s+(NOT\\s+)?EXISTS\\s+)?finance\\.${t}\\b`,
    `CREATE\\s+(UNIQUE\\s+)?INDEX[^;(]*\\bON\\s+finance\\.${t}\\b`,
    `CREATE\\s+(CONSTRAINT\\s+)?TRIGGER[^;]*?\\bON\\s+finance\\.${t}\\b`,
    `COMMENT\\s+ON\\s+(TABLE|COLUMN|VIEW)\\s+finance\\.${t}\\b`,
    `(hasColumn|hasTable)\\(\\s*['"]${t}['"]`,
    `withSchema\\(\\s*['"]finance['"]\\s*\\)\\.(alterTable|createTable|table)\\(\\s*['"]${t}['"]`,
  ].some((p) => new RegExp(p, 'i').test(codigo)));
}

/** El snapshot de columnas de prod, agrupado por `schema.tabla`. */
function cargarSnapshot() {
  if (!fs.existsSync(CSV)) throw new Error(`No existe ${CSV}: sin el snapshot no se pueden crear las tablas ajenas.`);
  const lineas = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const cab = lineas.shift().split(',');
  const i = (k) => cab.indexOf(k);
  const tablas = new Map();
  for (const l of lineas) {
    const c = l.split(',');   // el snapshot no trae comas dentro de los campos que se usan acá
    const clave = `${c[i('schema')]}.${c[i('table')]}`;
    if (!tablas.has(clave)) tablas.set(clave, []);
    tablas.get(clave).push({
      orden: Number(c[i('ordinal')]), columna: c[i('column')], tipo: c[i('data_type')],
      udt: c[i('udt')], largo: c[i('maxlen')],
    });
  }
  return tablas;
}

function tipoSql(col) {
  if (col.tipo === 'ARRAY') return `${col.udt.replace(/^_/, '')}[]`;
  if (col.tipo === 'USER-DEFINED') return col.udt === 'vector' ? 'text' : col.udt;   // pgvector no hace falta acá
  if (col.tipo === 'character varying' && col.largo) return `varchar(${col.largo})`;
  if (col.tipo === 'character' && col.largo) return `char(${col.largo})`;
  return col.tipo;
}

/** La migración más vieja que crea la función `schema.nombre`. */
function creadorDeFuncion(nombreCalificado, archivos) {
  const [schema, nombre] = nombreCalificado.includes('.') ? nombreCalificado.split('.') : ['public', nombreCalificado];
  const rx = new RegExp(`FUNCTION\\s+(${schema}\\.)?${nombre}\\s*\\(`, 'i');
  return archivos.find((f) => rx.test(fs.readFileSync(path.join(DIR, f), 'utf8'))) || null;
}

/**
 * La migración más vieja que crea la tabla o vista `schema.nombre`.
 * ⚠️ Hay migraciones que guardan el nombre en una constante (`const VISTA = 'analytics.x'` y
 * después `CREATE OR REPLACE VIEW ${VISTA}`): buscar sólo el nombre literal no las encuentra.
 */
function creadorDeRelacion(schema, nombre, archivos) {
  const crea = '(CREATE\\s+(OR\\s+REPLACE\\s+)?(MATERIALIZED\\s+)?(TABLE|VIEW)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?)';
  const literal = new RegExp(`${crea}${schema}\\.${nombre}\\b`, 'i');
  const constante = new RegExp(`const\\s+([A-Za-z_]\\w*)\\s*=\\s*['"]${schema}\\.${nombre}['"]`, 'g');
  return archivos.find((f) => {
    const src = sinComentarios(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (literal.test(src)) return true;
    const nombres = [...src.matchAll(constante)].map((m) => m[1]);
    return nombres.some((c) => new RegExp(`${crea}\\$\\{${c}\\}`, 'i').test(src));
  }) || null;
}

// ── principal ───────────────────────────────────────────────────────────────────────────────
async function main() {
  const o = argumentos(process.argv.slice(2));
  const destino = classify(o.url);
  if (destino.kind !== 'local') {
    console.error(`⛔ RECHAZADO: "${destino.host}" no es un Postgres local (${destino.kind}). Esta base se arma desde cero y sólo en local.`);
    process.exit(2);
  }

  const knex = require('knex')({ client: 'pg', connection: { connectionString: o.url }, pool: { min: 0, max: 2 } });
  try {
    const previas = await knex.raw(`SELECT to_regclass('public.knex_migrations') AS t`);
    if (previas.rows[0].t) {
      const n = await knex('knex_migrations').count('* as n').first();
      if (Number(n.n) > 0) {
        console.error(`⛔ La base ya tiene ${n.n} migraciones aplicadas: esto arma una base DESDE CERO. Usá una base vacía.`);
        process.exit(2);
      }
    }

    const todos = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
    const nucleo = todos.filter((f) => tocaNucleo(sinComentarios(fs.readFileSync(path.join(DIR, f), 'utf8'))));
    // ⭐ El schema `finance` lo crea en prod una migración vieja (la de Maat), y ahí viven sus
    // permisos: el `GRANT USAGE` a `app_runtime`. Sin ella el rol de prod no puede escribir ni una
    // fila, aunque tenga los GRANT de cada tabla (CG.158). Se trae la migración REAL que creó el
    // schema, no un permiso escrito a mano. Lo encontró la suite, no la lectura del código.
    const creadorDeSchema = todos.find((f) =>
      /CREATE\s+SCHEMA\s+(IF\s+NOT\s+EXISTS\s+)?finance\b/i.test(sinComentarios(fs.readFileSync(path.join(DIR, f), 'utf8'))));
    if (!creadorDeSchema) throw new Error('ninguna migración crea el schema finance: no se puede reproducir su permiso.');
    const conjunto = new Set([ORIGEN, creadorDeSchema, ...nucleo]);
    for (const obj of LEE_EL_SERVICIO) {
      const [s, n] = obj.split('.');
      const creador = creadorDeRelacion(s, n, todos);
      if (!creador) throw new Error(`ninguna migración crea ${obj}, que lee el servicio del corte.`);
      conjunto.add(creador);
    }
    const snapshot = cargarSnapshot();

    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
          CREATE ROLE app_runtime WITH LOGIN PASSWORD 'app_runtime';
        END IF;
      END $$`);
    await knex.raw(`CREATE TABLE IF NOT EXISTS public._caja_test_base (
      id serial PRIMARY KEY, tipo text NOT NULL, nombre text NOT NULL, detalle text,
      at timestamptz NOT NULL DEFAULT now())`);
    const anotar = (tipo, nombre, detalle) =>
      knex('public._caja_test_base').insert({ tipo, nombre, detalle: detalle || null });

    console.log(`[caja-test-base] ${destino.db} @ ${destino.host}`);
    console.log(`   núcleo del corte: ${nucleo.length} migraciones + la de origen del tenant`);

    const moldes = [];
    const traidas = [];
    for (let intento = 0; ; intento++) {
      if (intento > MAX_REMEDIOS) throw new Error(`más de ${MAX_REMEDIOS} remedios: algo se repite, revisar.`);
      const lista = [...conjunto].sort();
      const fuente = {
        getMigrations: async () => lista,
        getMigrationName: (m) => m,
        getMigration: async (m) => require(path.join(DIR, m)),
      };
      try {
        await knex.migrate.latest({ migrationSource: fuente, tableName: 'knex_migrations', schemaName: 'public' });
        break;
      } catch (e) {
        const msg = String(e.message || e);
        const mig = (msg.match(/migration file "([^"]+)"/) || [])[1] || '(desconocida)';

        const fn = msg.match(/function ([\w.]+)\(/);
        if (fn) {
          const creador = creadorDeFuncion(fn[1], todos);
          if (!creador || conjunto.has(creador)) {
            throw new Error(`${mig} pide la función ${fn[1]} y no hay migración que la cree fuera del conjunto.\n   ${msg.split('\n').pop()}`);
          }
          conjunto.add(creador); traidas.push(creador);
          await anotar('migracion_traida', creador, `crea ${fn[1]}, que pide ${mig}`);
          continue;
        }

        const sch = msg.match(/schema "([\w]+)" does not exist/);
        if (sch) {
          await knex.raw(`CREATE SCHEMA IF NOT EXISTS ${sch[1]}`);
          await anotar('schema', sch[1], `lo pidió ${mig}`);
          continue;
        }

        const rel = msg.match(/relation "([\w.]+)" does not exist/);
        if (rel) {
          let [schema, nombre] = rel[1].includes('.') ? rel[1].split('.') : [null, rel[1]];
          if (!schema) {
            const candidatos = [...snapshot.keys()].filter((k) => k.endsWith(`.${nombre}`));
            if (candidatos.length !== 1) throw new Error(`${mig} pide "${nombre}" sin schema y el snapshot tiene ${candidatos.length} candidatos.`);
            [schema, nombre] = candidatos[0].split('.');
          }
          const cols = snapshot.get(`${schema}.${nombre}`);
          if (cols) {
            const defs = cols.sort((a, b) => a.orden - b.orden).map((c) => `"${c.columna}" ${tipoSql(c)}`).join(', ');
            await knex.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
            await knex.raw(`CREATE TABLE ${schema}.${nombre} (${defs})`);
            moldes.push(`${schema}.${nombre}`);
            await anotar('tabla_vacia', `${schema}.${nombre}`, `desde el snapshot de prod; la pidió ${mig}`);
            continue;
          }
          const creador = creadorDeRelacion(schema, nombre, todos);
          if (creador && !conjunto.has(creador)) {
            conjunto.add(creador); traidas.push(creador);
            await anotar('migracion_traida', creador, `crea ${schema}.${nombre}, que pide ${mig}`);
            continue;
          }
          throw new Error(`${mig} pide ${schema}.${nombre}: no está en el snapshot ni hay migración que la cree.`);
        }

        throw new Error(`se detiene en ${mig}:\n   ${msg.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-6).join('\n   ')}`);
      }
    }

    const aplicadas = await knex('knex_migrations').count('* as n').first();
    console.log(`\n══ LISTO: ${aplicadas.n} migraciones aplicadas, ninguna saltada.`);
    if (traidas.length) console.log(`   traídas por dependencia (${traidas.length}): ${traidas.join(', ')}`);
    if (moldes.length) console.log(`   tablas ajenas vacías desde el snapshot (${moldes.length}): ${moldes.join(', ')}`);
    console.log('   ⛔ Esta base NO es prod: valida estructura y reglas del corte, no datos.');
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error(`\n⛔ ${e.message}`);
  process.exit(1);
});
