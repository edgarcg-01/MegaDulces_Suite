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
// `[CG.199]` `cash_signature_requests`: el pedido de firma por teléfono. El alta del movimiento la
// lee con candado (`[CG.202]`), así que sin ella el servicio real del alta no se puede ejercer.
const NUCLEO = ['cash_ledger_cut_denominations', 'cash_ledger_cuts', 'cash_ledger_denominations',
  'cash_ledger_sequences', 'v_cash_ledger_balance', 'cash_ledger', 'cash_signature_requests'];
/**
 * Lo que LEE el servicio del corte fuera del núcleo (`contar`, `cerrar`, `saldo`): las dos piernas
 * de la bóveda (CAOS) y el reparto cajón/bóveda. Sin esto la base sirve para probar las reglas de
 * la tabla, pero no el servicio real. Se trae la migración REAL que crea cada objeto.
 */
const LEE_EL_SERVICIO = ['analytics.caos_cash_movements', 'analytics.v_caja_reparto_movimiento', 'finance.caos_cash_links',
  // `[CGP-L.10]` Donde late el sensor del corte abierto: sin la tabla, el latido no se puede probar.
  'analytics.cron_runs',
  // [CGP-L.6] Lo que lee y escribe la atribución de CAOS: el grano de cada depósito (con RLS forzado,
  // la escritura sin tenant fallaba en silencio) y lo aprendido de los enlaces.
  'finance.caos_deposito_grano', 'analytics.v_caos_link_patterns',
  // `[CGS.10]` La bitácora del libro de caja se apoya en el historial GENÉRICO (`VP.3.1`), no en
  // uno propio: la migración `20261021110252` **aborta a propósito** si no lo encuentra —
  // «no se inventa otro»— y sin esta línea el job `CGP-D.1` quedaba rojo con
  // `finance.cash_ledger_cuts does not exist`, porque la cadena se cortaba antes de crear nada.
  //
  // ⚠️ Se trae la TABLA y la FUNCIÓN: la guarda comprueba las dos
  // (`to_regprocedure('analytics.log_master_data_change()')` y `to_regclass(...)`), y traer sólo
  // una deja el mismo rojo con otro mensaje.
  'analytics.master_data_history',
  // `[CGS.15]` La llave de emergencia y `[CGS.22]` el conteo físico de la caja fuerte. No tocan el
  // núcleo por nombre, así que no entraban solas: el 2026-10-21 sus pruebas salían NO MEDIDO en
  // `caja-db` («la migración no está aplicada en esta base») aunque en prod ya estaban vivas.
  'finance.cash_ledger_llaves', 'finance.caos_conteos_fisicos',
  // `[CGS.41]` El arqueo completo de la caja (lo que contaba Control, jubilado el 2026-10-22).
  'finance.cash_arqueos',
  // `[CGA-A.50]` El retiro de CAOS en custodia. Su migración también cambia el candado de
  // `caos_cash_links` (un retiro, muchos gastos): sin esta línea `test-newdb-caja-custodia` sale
  // NO MEDIDO y el trigger que lo reemplaza nunca se ejerce.
  'finance.caos_retiro_custodia',
  // `[LE.0.0]` El reparto automático de depósitos (`CG.58`): su regla «cada peso, una explicación»
  // se prueba contra el libro, y sin la tabla la migración de LE.0.0 sale sin hacer nada.
  'finance.caos_ingreso_atribucion'];
/**
 * `[CGA-A.55]` Migraciones que ALTERAN una tabla de `LEE_EL_SERVICIO` con REGLAS (no con datos).
 * De esas tablas sólo se trae la migración que las crea; una regla agregada después no entraba, y
 * su prueba salía NO MEDIDO para siempre. Lista explícita a propósito: traer «todo lo que altere
 * `caos_cash_links`» arrastra migraciones de DATOS de prod (`cga_a10`, `a18`, `a24`, `a31`) que
 * abortan en una base vacía, como abortaba `[CGS.52]`.
 */
const REGLAS_SOBRE_LO_QUE_LEE = ['20261026110741_cga_a55_billetes_por_enlace_de_retiro.js',
  // `[CGA-A.37]` el candado «Σ por cobro ≤ su monto» del reparto, y `[LE.0.0]` «cada peso, una explicación».
  '20261020110022_caos_atribucion_cobro_partido.js',
  '20261027101810_le00_baja_atribuciones_dobles_de_caos.js',
  // `[LE.0.0a]` el candado por movimiento en los tres caminos que explican un depósito (entraba sola
  // por su trigger sobre `cash_ledger`; explícita para que no dependa de eso), y `[LE.0.0e]` la
  // función de denominaciones de A.55, que no toca ninguna tabla y por eso nunca entraría sola.
  '20261027105608_le00a_una_explicacion_sin_carrera.js',
  '20261027110325_le00e_caos_denom_valor_sin_signo_de_pregunta.js',
  // `[LE.1]` El libro de partida doble: esquema propio (`cashbook`), no toca el núcleo del corte.
  '20261027111930_le1_cashbook_libro_de_partida_doble.js',
  // `[LE.1.9]` Conteos, hallazgos y excepciones del libro (mismo esquema propio).
  '20261027120749_le19_cashbook_conteos_hallazgos_y_excepciones.js'];
const MAX_REMEDIOS = 200;

/**
 * `[CGP-D.1.2]` Migraciones que, ADEMÁS de cambiar la estructura del corte, corrigen FILAS DE PROD
 * medidas a mano, y abortan a propósito si esas filas no están. En esta base vacía las filas nunca
 * están: la migración corre entera (columnas, candados, guardia) y al llegar a su plan de datos
 * aborta. Como knex aplica el lote en UNA transacción, ese aborto deshacía TODO el núcleo y el job
 * quedaba rojo con `finance.cash_ledger_cuts does not exist` en cada suite (desde e059ad6be,
 * 2026-10-23, cuando entró `[CGS.52]`).
 *
 * ⛔ Esto NO es saltar: la migración CORRE, su SQL de estructura se aplica y queda registrada. Sólo
 * se acepta el aborto EXACTO que dice «no hay ninguna de las filas de prod que se midieron»
 * (cero, no «otro número»): el aborto llega por un `throw` de JS después de un SELECT que salió
 * bien, así que la transacción no queda envenenada y nada del plan de datos llegó a escribirse.
 * Cualquier otro aborto (una cifra distinta, otro conteo, un error de SQL) sigue deteniendo todo.
 * Lo que no se midió se DECLARA: queda en `_caja_test_base` como `datos_de_prod_no_medidos`.
 */
const CORRIGEN_FILAS_DE_PROD = {
  '20261023095246_cgs52_recalcular_cortes_con_el_conteo_fisico_y_el_libro_atado.js':
    /^\[CGS\.52\] hay 0 cortes del \d{4}-\d{2}-\d{2} al \d{4}-\d{2}-\d{2}, se midieron \d+ -- migracion abortada, sin tocar ninguna fila\.$/,
};

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
 * `[CGP-L.6]` Y otras guardan sólo el nombre (`const TABLA = 'caos_deposito_grano'`) y escriben
 * `CREATE TABLE finance.${TABLA}`: con eso tampoco se encontraba la tabla de granos de CAOS.
 */
function creadorDeRelacion(schema, nombre, archivos) {
  const crea = '(CREATE\\s+(OR\\s+REPLACE\\s+)?(MATERIALIZED\\s+)?(TABLE|VIEW)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?)';
  const literal = new RegExp(`${crea}${schema}\\.${nombre}\\b`, 'i');
  const constante = new RegExp(`const\\s+([A-Za-z_]\\w*)\\s*=\\s*['"]${schema}\\.${nombre}['"]`, 'g');
  const corta = new RegExp(`const\\s+([A-Za-z_]\\w*)\\s*=\\s*['"]${nombre}['"]`, 'g');
  return archivos.find((f) => {
    const src = sinComentarios(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (literal.test(src)) return true;
    const nombres = [...src.matchAll(constante)].map((m) => m[1]);
    if (nombres.some((c) => new RegExp(`${crea}\\$\\{${c}\\}`, 'i').test(src))) return true;
    const cortos = [...src.matchAll(corta)].map((m) => m[1]);
    return cortos.some((c) => new RegExp(`${crea}${schema}\\.\\$\\{${c}\\}`, 'i').test(src));
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
    for (const f of REGLAS_SOBRE_LO_QUE_LEE) {
      if (!todos.includes(f)) throw new Error(`la migración de reglas ${f} no existe en ${DIR}.`);
      conjunto.add(f);
    }
    const snapshot = cargarSnapshot();

    // `[CGP-L.6]` `dev_ro`, el rol de sólo lectura, también: varias migraciones le dan GRANT (la de los
    // granos de CAOS, entre ellas) y sin el rol la migración se cae. Acá basta con que exista: sin login.
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
          CREATE ROLE app_runtime WITH LOGIN PASSWORD 'app_runtime';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
          CREATE ROLE dev_ro NOLOGIN;
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
    const sinFilasDeProd = [];   // `[CGP-D.1.2]` se rehace en cada intento: el lote anterior se deshizo entero
    for (let intento = 0; ; intento++) {
      if (intento > MAX_REMEDIOS) throw new Error(`más de ${MAX_REMEDIOS} remedios: algo se repite, revisar.`);
      sinFilasDeProd.length = 0;
      const lista = [...conjunto].sort();
      const fuente = {
        getMigrations: async () => lista,
        getMigrationName: (m) => m,
        getMigration: async (m) => {
          const mod = require(path.join(DIR, m));
          const vacio = CORRIGEN_FILAS_DE_PROD[m];
          if (!vacio) return mod;
          return {
            ...mod,
            up: async (k) => {
              try {
                await mod.up(k);
              } catch (e) {
                const msg = String((e && e.message) || e);
                if (!vacio.test(msg)) throw e;
                sinFilasDeProd.push(`${m}: ${msg}`);
              }
            },
          };
        },
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
    for (const s of sinFilasDeProd) {
      const [mig, ...resto] = s.split(': ');
      await anotar('datos_de_prod_no_medidos', mig, resto.join(': '));
    }
    if (sinFilasDeProd.length) {
      console.log(`   ⚠️ NO MEDIDO — corrección de filas de prod sin sus filas (${sinFilasDeProd.length}; la estructura SÍ se aplicó):`);
      for (const s of sinFilasDeProd) console.log(`      · ${s}`);
    }
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
