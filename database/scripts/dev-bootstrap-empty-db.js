#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[DEV.BOOT]` — Levanta una base de DESARROLLO desde cero, cuando `migrate:new` solo no alcanza.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────────
 * `npm run migrate:new` sobre una base vacía NO llega al final (GOTCHAS §75): se detiene en la 88 (falta
 * el tenant), en la 435 (faltan las tablas de `kepler_ods.*`, que crea la ingesta del ERP y no una
 * migración) y luego en una docena de supuestos que prod cumple por historia (tablas que allá son tabla y
 * acá vista, extensiones en otro schema, perfiles y zonas que son DATOS, aserciones sobre el ERP). Este
 * script hace lo que hubo que hacer a mano el 2026-10-02 para levantar la Fase MS, en el mismo orden, y
 * DECLARA lo que no pudo reproducir.
 *
 *     node database/scripts/dev-bootstrap-empty-db.js --url postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform
 *
 * ── ⛔ Lo que esta base NO ES ───────────────────────────────────────────────────────────────────
 * **No es prod ni se parece a prod en datos.** Valida ESTRUCTURA e invariantes (un esquema nuevo, sus CHECK,
 * su RLS, sus permisos). **No** sirve para medir nada del ERP: las ~70 migraciones que asertan sobre datos
 * reales (vistas y matvistas analíticas) se MARCAN aplicadas sin ejecutarse. Cada una queda registrada en
 * `public._dev_bootstrap_log`, para que una prueba o una persona pueda saber que está sobre una base así.
 *
 * ── Protecciones (no son opcionales) ────────────────────────────────────────────────────────────
 *  1. **Solo local.** Se niega si el host no es 127.0.0.1/localhost/::1. No hay flag para saltarlo.
 *  2. **La URL es explícita.** NO usa `DATABASE_URL_NEW` por defecto: ése es justo el que, mal apuntado, ya
 *     hizo medir la base equivocada (GOTCHAS §52).
 *  3. **Clúster propio.** Las migraciones crean y modifican ROLES, que valen para TODO el servidor (la caída
 *     de 6 h del 27-ago nació de compartir `app_runtime`, GOTCHAS §24). Si el clúster tiene bases ajenas al
 *     stack de desarrollo, se niega, salvo `--clúster-compartido` (y lo dice).
 *  4. **No pisa una base con historia.** Si `knex_migrations` ya tiene filas pide `--resume`.
 *  5. Nunca salta una migración que toque identidad, puestos, responsabilidades, roles o permisos, ni
 *     NINGUNA anterior a la era analítica (`FRONTERA_ANALITICA`): lo estructural se entiende o se detiene.
 *  6. **Un clúster, una base.** Las migraciones fijan `search_path` por ROL (valdría para todo el servidor):
 *     si ya está fijado se niega, porque una segunda base heredaría el de la primera y le cambiaría el suyo.
 *
 * ── De dónde sale la estructura de kepler_ods ───────────────────────────────────────────────────
 * De `docs/esquema-bd-prod-columnas.csv` (snapshot introspectivo de prod: nombres y tipos, **vacías**). Si
 * el snapshot es viejo faltarán columnas nuevas; se regenera con `database/scripts/columns-snapshot.sql`.
 *
 * Idempotente y reanudable: solo corre lo pendiente.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const REPO = path.resolve(__dirname, '..', '..');
const CSV = path.join(REPO, 'docs', 'esquema-bd-prod-columnas.csv');
const KNEX_CLI = require.resolve('knex/bin/cli.js', { paths: [REPO] });
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Bases que un clúster de DESARROLLO legítimamente tiene. Cualquier otra = un servidor compartido. */
const BASES_DEL_STACK = new Set(['postgres', 'megadulces_logistica', 'postgres_platform', 'vector_db', 'template0', 'template1']);
/** Lo que la Mesa de Servicio y todo lo demás necesita de verdad: estas migraciones NUNCA se saltan. */
const NECESARIAS = /identity|responsib|position|depart|organigrama|permission|role|tenant|cron|user/i;
/**
 * Antes de esta migración (la primera vista en vivo sobre el ERP) TODO fallo es ESTRUCTURAL: o se entiende
 * y tiene remedio, o el script se detiene. Saltarse una migración temprana arrastra a las que dependen de
 * ella (se vio: saltar `catalog_schema_with_views` dejó sin schema `catalog` a media base). Las
 * aserciones sobre datos reales del ERP son de la era analítica, de aquí en adelante.
 */
const FRONTERA_ANALITICA = '20260819120000';
const EXTENSIONES = ['uuid-ossp', 'pgcrypto', 'pg_trgm', 'unaccent', 'cube', 'earthdistance', 'vector'];

// ── argumentos ─────────────────────────────────────────────────────────────────────────────────
function args(argv) {
  const o = { url: process.env.DEV_BOOTSTRAP_URL || '', resume: false, maxSkips: 120, maxIter: 400, clusterCompartido: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--resume') o.resume = true;
    else if (a === '--max-skips') o.maxSkips = Number(argv[++i]);
    else if (a === '--max-iter') o.maxIter = Number(argv[++i]);
    else if (a === '--cluster-compartido' || a === '--clúster-compartido') o.clusterCompartido = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`Argumento desconocido: ${a}`); process.exit(2); }
  }
  return o;
}

function ayuda() {
  console.log(`Uso: node database/scripts/dev-bootstrap-empty-db.js --url <postgres://postgres@127.0.0.1:PUERTO/base> [--resume]

  // El ejemplo de arriba va SIN contrasena a proposito: si tu Postgres la pide, va donde
  // corresponde en la cadena. Con un `usuario:clave@` literal el escaneo de secretos marca
  // esta linea de AYUDA como hallazgo, y poner una excepcion para un texto de uso seria
  // aflojar la compuerta por comodidad.
  --url                  OBLIGATORIA (o DEV_BOOTSTRAP_URL). Superusuario de un Postgres LOCAL, base ya creada y vacía.
  --resume               reanuda una base que ya tiene migraciones aplicadas (sin esto se niega)
  --cluster-compartido   acepta correr en un clúster con bases ajenas al stack (los roles son del clúster)
  --max-skips N          tope de migraciones que se pueden saltar (120)

No usa DATABASE_URL_NEW a propósito. Ver GOTCHAS §75.`);
}

function exigirLocal(url) {
  let u;
  try { u = new URL(url); } catch { console.error('RECHAZADO: la URL no se puede leer.'); process.exit(2); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.error(`⛔ RECHAZADO: el host "${u.hostname}" no es local. Este script solo corre contra un Postgres de ESTA máquina.`);
    process.exit(2);
  }
  const db = u.pathname.replace(/^\//, '');
  if (!db || /railway|prod/i.test(db)) {
    console.error(`⛔ RECHAZADO: la base "${db}" no parece una base de desarrollo.`);
    process.exit(2);
  }
  return { u, db };
}

// ── snapshot de esquema de prod ────────────────────────────────────────────────────────────────
function parseLinea(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  const [schema, table, kind, ordinal, column, data_type, udt, nullable, column_default, maxlen] = out;
  return { schema, table, kind, ordinal: Number(ordinal), column, data_type, udt, nullable, column_default, maxlen };
}

function cargarTablas() {
  if (!fs.existsSync(CSV)) { console.error(`No existe ${CSV}: sin el snapshot de prod no se pueden crear los moldes.`); process.exit(2); }
  const tablas = new Map();
  for (const r of fs.readFileSync(CSV, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(parseLinea)) {
    if (r.kind !== 'table') continue;
    const k = `${r.schema}.${r.table}`;
    if (!tablas.has(k)) tablas.set(k, []);
    tablas.get(k).push(r);
  }
  return tablas;
}

const tipo = (r) => {
  if (r.data_type === 'ARRAY') return `${r.udt.replace(/^_/, '')}[]`;
  if (r.data_type === 'character varying') return r.maxlen ? `varchar(${r.maxlen})` : 'varchar';
  if (r.data_type === 'character') return r.maxlen ? `char(${r.maxlen})` : 'char';
  if (r.data_type === 'USER-DEFINED') return 'text';
  return r.data_type;
};
const dflt = (r) => {
  const d = (r.column_default || '').trim();
  if (['now()', 'gen_random_uuid()', 'true', 'false', 'CURRENT_DATE'].includes(d)) return ` DEFAULT ${d}`;
  if (/^-?\d+(\.\d+)?$/.test(d)) return ` DEFAULT ${d}`;
  return '';
};

async function crearMolde(client, tablas, key) {
  const cols = tablas.get(key).slice().sort((a, b) => a.ordinal - b.ordinal);
  const [schema, table] = key.split('.');
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const defs = cols.map((r) => `"${r.column}" ${tipo(r)}${r.nullable === 'NO' ? ' NOT NULL' : ''}${dflt(r)}`);
  await client.query(`CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (${defs.join(', ')})`);
}

// ── knex ───────────────────────────────────────────────────────────────────────────────────────
function entorno(url) {
  const u = new URL(url);
  const runtime = new URL(url); runtime.username = 'app_runtime'; runtime.password = 'app_runtime';
  return {
    ...process.env,
    NODE_ENV: 'development',
    DATABASE_URL_NEW: url,
    DATABASE_URL_NEW_RUNTIME: runtime.toString(),
    DATABASE_URL: u.toString(),
  };
}

function knex(argv, env) {
  const r = spawnSync(process.execPath, [KNEX_CLI, ...argv, '--knexfile', 'database/knexfile-newdb.js'],
    { cwd: REPO, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

/** Corre una semilla del repo (idempotente: todas hacen upsert) o aborta con su salida. */
function semilla(ctx, archivo) {
  const r = knex(['seed:run', `--specific=${archivo}`], ctx.env);
  if (r.status !== 0) throw new Error(`la semilla ${archivo} falló:\n` + r.out.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-8).join('\n'));
}

// ── remedios: cada uno corresponde a algo que falló DE VERDAD el 2026-10-02, en este orden ─────
const REMEDIOS = [
  {
    id: 'tenant-ausente',
    cuando: (o) => /violates foreign key constraint "[a-z_]*tenant[a-z_]*"/.test(o) || /zones_tenant_id_foreign/.test(o),
    aplicar: async (_c, ctx) => {
      semilla(ctx, '01_first_tenant_mega_dulces.js');
      return 'semilla 01 (tenant mega_dulces)';
    },
  },
  {
    id: 'matview-que-en-prod-es-tabla',
    cuando: (o) => /cannot be performed on relation "products_top_sellers"/.test(o),
    aplicar: async (c) => {
      // En prod `catalog.products_top_sellers` es TABLA; la migración que la crea hace una VISTA MATERIALIZADA.
      await c.query('BEGIN');
      try {
        await c.query(`DO $$ DECLARE def text; BEGIN
          def := pg_get_viewdef('public.products_top_sellers'::regclass);
          EXECUTE 'CREATE TABLE catalog.products_top_sellers__t AS SELECT * FROM catalog.products_top_sellers WITH NO DATA';
          EXECUTE 'DROP VIEW public.products_top_sellers';
          EXECUTE 'DROP MATERIALIZED VIEW catalog.products_top_sellers';
          EXECUTE 'ALTER TABLE catalog.products_top_sellers__t RENAME TO products_top_sellers';
          EXECUTE 'CREATE VIEW public.products_top_sellers AS ' || def;
        END $$`);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      return 'catalog.products_top_sellers: vista materializada → tabla vacía (como en prod)';
    },
  },
  {
    id: 'perfiles-faltantes',
    cuando: (o) => /positions_default_role_fk/.test(o),
    aplicar: async (c, ctx) => {
      // Los puestos proponen un perfil por defecto: primero los roles iniciales, y encima los dos que en prod
      // son DATOS (los crea una migración sólo si ya existen roles-tarea con usuarios, que acá no hay).
      semilla(ctx, '02_mega_dulces_initial_roles.js');
      await c.query(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions, kind)
        SELECT $1, r, '{}'::jsonb, 'perfil' FROM unnest(ARRAY['piso_tienda','administrativo']) r
         WHERE NOT EXISTS (SELECT 1 FROM identity.role_permissions WHERE tenant_id=$1 AND role_name=r)`, [TENANT]);
      return 'semilla 02 (roles iniciales) + perfiles piso_tienda y administrativo (sin permisos: son DATOS de prod)';
    },
  },
  {
    id: 'zonas-faltantes',
    cuando: (o) => /se esperaba MORELIA ABASTOS|no quedó ninguna zona sin sucursal/.test(o),
    aplicar: async (c) => {
      for (const [name, orden] of [['MORELIA ABASTOS', 2], ['LA PIEDAD RD', 3]]) {
        await c.query(`INSERT INTO trade.zones (tenant_id, name, orden, is_system)
          SELECT $1::uuid, $2::text, $3::int, false
           WHERE NOT EXISTS (SELECT 1 FROM trade.zones WHERE tenant_id=$1::uuid AND upper(name)=upper($2::text))`, [TENANT, name, orden]);
      }
      return 'zonas MORELIA ABASTOS y LA PIEDAD RD (son DATOS de prod)';
    },
  },
  {
    id: 'sin-god-mode',
    cuando: (o) => /ninguna persona activa quedó con god-mode/.test(o),
    aplicar: async (_c, ctx) => {
      // superoot tiene el rol `superadmin` (FK): lo crea la semilla 02, así que va antes.
      semilla(ctx, '02_mega_dulces_initial_roles.js');
      semilla(ctx, '03_mega_dulces_superoot_user.js');
      return 'semillas 02 + 03 (roles iniciales y usuario superoot, contraseña de desarrollo)';
    },
  },
];

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help || !o.url) { ayuda(); process.exit(o.help ? 0 : 2); }
  const { db } = exigirLocal(o.url);

  const c = new Client({ connectionString: o.url });
  await c.connect();
  const meta = await c.query(`select current_database() d, version() v, (select rolsuper from pg_roles where rolname=current_user) su`);
  if (!meta.rows[0].su) { console.error('⛔ Hace falta un SUPERUSUARIO: las migraciones crean roles y extensiones.'); process.exit(2); }

  // Protección 3: el clúster no puede traer bases ajenas.
  const bases = (await c.query(`select datname from pg_database where not datistemplate order by 1`)).rows.map((r) => r.datname);
  const ajenas = bases.filter((b) => b !== db && !BASES_DEL_STACK.has(b) && !/^(bootstrap|platform|postgres_platform)/.test(b));
  if (ajenas.length && !o.clusterCompartido) {
    console.error(`⛔ RECHAZADO: este clúster tiene bases ajenas al stack de desarrollo: ${ajenas.join(', ')}.`);
    console.error('   Las migraciones crean/modifican ROLES (app_runtime), que valen para TODO el servidor: compartirlos causó la');
    console.error('   caída de 6 h del 27-ago (GOTCHAS §24). Usá un Postgres propio (Docker, otro puerto). Si de verdad querés');
    console.error('   correr acá, agregá --cluster-compartido.');
    process.exit(2);
  }

  // Protección 6: las migraciones fijan `search_path` a nivel de ROL (ALTER ROLE postgres SET search_path…,
  // migración 20260603140000), o sea para TODO el clúster. Una segunda base arrancaría con el de la primera
  // y se comportaría distinto (`hasTable` resuelve por ese path), y de paso se lo cambiaría a la primera.
  if (!o.resume) {
    const yaFijado = await c.query(`select r.rolname, array_to_string(s.setconfig, '; ') cfg
        from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
       where s.setdatabase = 0 and r.rolname in (current_user, 'app_runtime')
         and exists (select 1 from unnest(s.setconfig) x where x like 'search_path=%')`);
    if (yaFijado.rows.length) {
      console.error('⛔ RECHAZADO: este clúster ya tiene el search_path fijado POR ROL (' +
        yaFijado.rows.map((r) => r.rolname).join(', ') + '): ya hay una base armada con estas migraciones.');
      console.error('   Ese ajuste es del clúster, no de la base: una segunda base heredaría el path de la primera y le');
      console.error('   cambiaría el comportamiento a la primera. Regla: UN CLÚSTER, UNA BASE DE DESARROLLO. Levantá otro');
      console.error('   Postgres (Docker, otro puerto) o reanudá la existente con --resume.');
      process.exit(2);
    }
  }

  // Protección 4: no pisar una base con historia.
  const hay = await c.query(`select to_regclass('public.knex_migrations') t`);
  if (hay.rows[0].t) {
    const n = Number((await c.query('select count(*) n from public.knex_migrations')).rows[0].n);
    if (n > 0 && !o.resume) { console.error(`⛔ ${db} ya tiene ${n} migraciones aplicadas. Usá --resume para reanudarla.`); process.exit(2); }
  }

  console.log(`\n══ [DEV.BOOT] ${db} @ ${new URL(o.url).host} · ${meta.rows[0].v.slice(0, 22)}`);
  console.log('   ⛔ ESTA BASE NO ES PROD: valida estructura e invariantes, no comportamiento con datos.\n');

  // Preparación: extensiones EN public (si las crea una migración con otro search_path quedan en `identity`),
  // el rol de runtime y el registro de lo que se improvisa.
  for (const e of EXTENSIONES) {
    try { await c.query(`CREATE EXTENSION IF NOT EXISTS "${e}" SCHEMA public`); }
    catch (err) { console.log(`   · extensión ${e}: no disponible (${err.message.split('\n')[0]})`); }
  }
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime')
    THEN CREATE ROLE app_runtime WITH LOGIN PASSWORD 'app_runtime'; END IF; END $$`);
  await c.query(`CREATE TABLE IF NOT EXISTS public._dev_bootstrap_log (
    id serial PRIMARY KEY, kind text NOT NULL, name text NOT NULL, detail text, at timestamptz NOT NULL DEFAULT now())`);
  const log = (kind, name, detail) => c.query('INSERT INTO public._dev_bootstrap_log (kind, name, detail) VALUES ($1,$2,$3)', [kind, name, detail || null]);

  // Moldes de kepler_ods (la ingesta los crea en prod; ninguna migración).
  const tablas = cargarTablas();
  let moldes = 0;
  for (const k of tablas.keys()) {
    if (!k.startsWith('kepler_ods.') || k === 'kepler_ods._sync_status') continue;
    await crearMolde(c, tablas, k); moldes++;
  }
  console.log(`   · kepler_ods: ${moldes} tablas VACÍAS creadas desde el snapshot de prod`);
  await log('molde', 'kepler_ods.*', `${moldes} tablas vacías desde docs/esquema-bd-prod-columnas.csv`);

  const env = entorno(o.url);
  const ctx = { env };
  const ultimoRemedio = new Map();
  const saltadas = [];
  const yaMoldeadas = new Set();
  let intento = 0;

  for (; intento < o.maxIter; intento++) {
    const r = knex(['migrate:latest'], env);
    if (r.status === 0) break;
    const out = r.out;
    const mig = (out.match(/migration file "([^"]+)" failed/) || [])[1] || null;
    // El mensaje puede empezar en la línea SIGUIENTE (SQL multilínea): se toma todo hasta la línea en blanco.
    // Respaldo: la primera línea `error: …`; y sólo al final una línea que NO sea de la traza (`at …`).
    const sinTraza = out.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l));
    const motivo = ((out.match(/migration failed with error:\s*([\s\S]{0,400}?)(?:\n\s*\n|\n[^\n]*error:)/) || [])[1]
      || (out.match(/^\s*error:\s*([^\n]+)/m) || [])[1]
      || sinTraza[sinTraza.length - 1] || '').replace(/\s+/g, ' ').trim().slice(0, 220);

    // 1) tabla que prod tiene por historia
    const rel = out.match(/relation "([a-z_0-9]+\.[a-z_0-9]+)" does not exist/);
    if (rel && tablas.has(rel[1]) && !yaMoldeadas.has(rel[1])) {
      yaMoldeadas.add(rel[1]);
      await crearMolde(c, tablas, rel[1]);
      console.log(`   · molde ${rel[1]}  (lo pedía ${mig})`);
      await log('molde', rel[1], `lo pedía ${mig}`);
      continue;
    }

    // 2) remedios conocidos (uno por falla; si el mismo no alcanzó dos veces seguidas, se para)
    const rem = REMEDIOS.find((x) => x.cuando(out));
    if (rem) {
      if (ultimoRemedio.get(mig) === rem.id) {
        console.error(`\n⛔ El remedio "${rem.id}" ya se aplicó y ${mig} sigue fallando:\n   ${motivo}`);
        process.exit(1);
      }
      ultimoRemedio.set(mig, rem.id);
      const desc = await rem.aplicar(c, ctx);
      console.log(`   · remedio ${rem.id}: ${desc}`);
      await log('remedio', rem.id, desc);
      continue;
    }

    // 3) aserción sobre datos reales del ERP o de prod: se SALTA, salvo lo que la Mesa de Servicio necesita
    const migTs = mig ? mig.slice(0, 14) : '';
    if (mig && migTs >= FRONTERA_ANALITICA && !NECESARIAS.test(mig) && saltadas.length < o.maxSkips) {
      await c.query(`INSERT INTO public.knex_migrations (name, batch, migration_time)
        SELECT $1::varchar, COALESCE(max(batch),1), now() FROM public.knex_migrations
         WHERE NOT EXISTS (SELECT 1 FROM public.knex_migrations WHERE name=$1::varchar)`, [mig]);
      saltadas.push({ mig, motivo });
      await log('saltada', mig, motivo);
      continue;
    }

    console.error(`\n⛔ Se detiene en ${mig || '(migración desconocida)'}:\n   ${motivo}`);
    if (mig && NECESARIAS.test(mig)) console.error('   (toca identidad/puestos/responsabilidades/roles/permisos: NO se salta nunca)');
    if (mig && migTs < FRONTERA_ANALITICA) console.error(`   (es una migración ESTRUCTURAL, anterior a ${FRONTERA_ANALITICA}: no se salta; hace falta un remedio nuevo)`);
    if (saltadas.length >= o.maxSkips) console.error(`   (se alcanzó el tope de ${o.maxSkips} migraciones saltadas)`);
    console.error(out.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-12).join('\n'));
    await c.end();
    process.exit(1);
  }
  if (intento >= o.maxIter) { console.error(`⛔ Tope de ${o.maxIter} intentos.`); process.exit(1); }

  const total = Number((await c.query('select count(*) n from public.knex_migrations')).rows[0].n);
  await c.end();

  console.log(`\n══ LISTO: ${total} migraciones registradas · ${saltadas.length} SALTADAS · ${yaMoldeadas.size} moldes extra.`);
  if (saltadas.length) {
    console.log('\n   Migraciones SALTADAS (no se ejecutaron; quedan en public._dev_bootstrap_log):');
    for (const s of saltadas) console.log(`     - ${s.mig}\n         ← ${s.motivo}`);
  }
  console.log('\n   ⛔ Recordatorio: esta base NO ES PROD. Valida estructura, no datos.');
  console.log(`   Para apuntar tus comandos a ella: DATABASE_URL_NEW='${o.url}'  (y DATABASE_URL, que el guardián de tests también lee).`);
}

main().catch((e) => { console.error('\n⛔ ERROR:', e.message); process.exit(1); });
