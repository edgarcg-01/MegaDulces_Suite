/* eslint-disable no-console */
/**
 * `[CP.9.2]` — **Réplica cruda de ContPAQi en prod: la CARGA INICIAL.** Copia tabla por tabla, tal cual, de SQL Server
 * (`192.168.0.35\COMPAC`) a Postgres: `contpaqi_ods` (contabilidad, generales, catálogos del SAT, directorio y metadatos
 * del ADD) y `contpaqi_nom` (nóminas). Pedido de Edgar, 2026-10-29: *«todo, hasta nóminas, hagámoslo ahora»*.
 * Plan y medición en `docs/IMPLEMENTACION/FASES/FASE_CP9_COBERTURA_TOTAL.md` §8.
 *
 * ── Qué copia y qué NO ──────────────────────────────────────────────────────────────────────
 *   ✔ todas las tablas de: la contabilidad, `GeneralesSQL`, `ADD_Catalogos`, `DB_Directory`, nóminas (`ctLFLG`,
 *     `nomGenerales`) y los metadatos de los 4 repositorios del ADD (`document_*`/`other_*_metadata`, con `_repo`).
 *   ⛔ las tablas `Certificates`: traen las LLAVES PRIVADAS de los certificados. No salen del servidor contable.
 *   ⛔ cualquier columna de contraseña o llave (`COLUMNA_SECRETA`).
 *   ⛔ el contenido de los documentos del ADD (`*_content`, ~18 GB de XML): ya está en `fiscal.cfdis`.
 *   Nóminas y las tablas `Nomina*` del ADD van a `contpaqi_nom`, que NO se concede a la app ni a `dev_ro`.
 *
 * ── Cómo lee, para no estorbar a contabilidad ───────────────────────────────────────────────
 *   Por llave en trozos (`TOP n … WHERE llave > última ORDER BY llave`): cada consulta termina en milisegundos y no
 *   deja candados abiertos mientras Postgres escribe. Sólo una tabla SIN llave se lee de una pasada, con `NOLOCK`
 *   (declarado: puede leer un renglón a medio escribir; el reconciliador de CP.9 lo corrige).
 *   Fechas y decimales salen de SQL Server como TEXTO: así no se corren de huso horario ni pierden precisión.
 *
 * ── Uso (en la LAN; la contraseña nunca va en el repo) ──────────────────────────────────────
 *   CONTPAQI_SQL_PASSWORD=… node database/importers/contpaqi/replicate-contpaqi.js            # en seco: plan + 1 fila de cada tabla
 *   … --apply [--solo=ct,gen,sat,dir,nom,nomgen,add,addo] [--tabla=Polizas] [--trozo=5000] [--pausa-ms=25]
 *   Destino: `DATABASE_URL_NEW`. Sin `--apply` no escribe nada.
 */
'use strict';
const path = require('path');
const fs = require('fs');
// ⛔ Donde corre la carga (el pod `feeds-cron`) no hay `.env` del repo ni `libs/`: el entorno lo pone el secreto del
// pod. Las dos cargas son opcionales. Y la estación de trabajo NO puede escribir en prod a propósito: su rol trae
// `default_transaction_read_only=on`. La carga corre donde corren los feeds, nunca saltándose eso.
const ENV_REPO = path.resolve(__dirname, '..', '..', '..', '.env');
if (fs.existsSync(ENV_REPO)) require('dotenv').config({ path: ENV_REPO, quiet: true });
const sql = require('mssql');
const { Client } = require('pg');
const GUARDIA = path.resolve(__dirname, '..', '..', '..', 'libs/platform-core/src/lib/provenance/target-guard.js');
const classify = fs.existsSync(GUARDIA) ? require(GUARDIA).classify
  : (url) => { try { const u = new URL(url); return { kind: '¿?', host: u.host, db: u.pathname.slice(1) }; } catch { return { kind: '¿?', host: null, db: null }; } };

const arg = (n, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const APPLY = process.argv.includes('--apply');
const SOLO = arg('solo', null) ? new Set(arg('solo').split(',')) : null;
const TABLA = arg('tabla', null);
const TROZO = Number(arg('trozo', 5000));
const PAUSA_MS = Number(arg('pausa-ms', 25));

if (!process.env.CONTPAQI_SQL_PASSWORD) {
  console.error('⛔ falta CONTPAQI_SQL_PASSWORD en el entorno (este script no trae contraseña por defecto).');
  process.exit(2);
}
const CFG = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD,
  database: 'master',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true,
    readOnlyIntent: true },
  pool: { max: 2 },
  connectionTimeout: 20000, requestTimeout: 600000,
};
const DB_CT = process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ';
const DB_NOM = process.env.CONTPAQI_NOM_DB || 'ctLFLG';
/** El repositorio del ADD que usa la contabilidad (`Parametros.GuidDSL`): va primero. */
const ADD_PRINCIPAL = (process.env.CONTPAQI_ADD_GUID || '12677b5d').toLowerCase();

const TABLA_SECRETA = /^certificates$/i;
const COLUMNA_SECRETA = /privad|password|passwd|contrase|pwd|clave_?acceso|secret|token|api_?key|ciec|fiel/i;
/**
 * ⛔ ContPAQi le dice CLAVE a la contraseña: `GeneralesSQL.Usuarios.Clave` y `EmailClave` se copiaron a prod en el humo
 * del 2026-10-30 porque el filtro buscaba «password». Un TEXTO cuyo nombre termina en clave/pass/nip/pin es secreto;
 * `FechaVencimientoClave` (fecha) y `c_ClaveProdServ` (no termina en clave) se siguen copiando.
 */
const TEXTO_SECRETO = /(clave|pass|nip|pin)$/i;
const TIPOS_TEXTO = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'binary', 'varbinary', 'image']);
const esSecreta = (c) => COLUMNA_SECRETA.test(c.nombre) || (TEXTO_SECRETO.test(c.nombre) && TIPOS_TEXTO.has(c.tipo));
const LLAVE_LEGIBLE = new Set(['int', 'bigint', 'smallint', 'tinyint', 'uniqueidentifier', 'char', 'varchar', 'nchar', 'nvarchar']);

/** Las bases que se replican, en orden: la contabilidad primero, el ADD principal antes que los demás. */
function fuentes(bases) {
  const out = [
    { alias: 'ct', db: DB_CT, prefijo: 'ct_' },
    { alias: 'gen', db: 'GeneralesSQL', prefijo: 'gen_' },
    { alias: 'sat', db: 'ADD_Catalogos', prefijo: 'sat_' },
    { alias: 'dir', db: 'DB_Directory', prefijo: 'dir_' },
    { alias: 'nom', db: DB_NOM, prefijo: 'nom_', nomina: true },
    { alias: 'nomgen', db: 'nomGenerales', prefijo: 'nomgen_', nomina: true },
  ];
  const add = [];
  for (const b of bases) {
    const m = String(b).match(/^(document|other)_([0-9a-f-]{36})_metadata$/i);
    if (!m) continue;
    const doc = m[1].toLowerCase() === 'document';
    add.push({ alias: doc ? 'add' : 'addo', db: b, prefijo: doc ? 'add_' : 'addo_', repo: m[2].slice(0, 8).toLowerCase() });
  }
  add.sort((x, y) => Number(y.repo === ADD_PRINCIPAL) - Number(x.repo === ADD_PRINCIPAL) || x.db.localeCompare(y.db));
  return [...out, ...add].filter((f) => bases.includes(f.db) && (!SOLO || SOLO.has(f.alias)));
}

/** Tipo de Postgres para un tipo de SQL Server. Lo que no tiene par exacto va a `text`. */
function tipoPg(c) {
  switch (c.tipo) {
    case 'bit': return 'boolean';
    case 'tinyint': case 'smallint': return 'smallint';
    case 'int': return 'integer';
    case 'bigint': return 'bigint';
    case 'decimal': case 'numeric': return `numeric(${c.precision},${c.scale})`;
    case 'money': case 'smallmoney': return 'numeric(19,4)';
    case 'float': return 'double precision';
    case 'real': return 'real';
    case 'date': return 'date';
    case 'datetime': case 'datetime2': case 'smalldatetime': return 'timestamp';
    case 'datetimeoffset': return 'timestamptz';
    case 'uniqueidentifier': return 'uuid';
    case 'binary': case 'varbinary': case 'image': case 'timestamp': return 'bytea';
    default: return 'text';
  }
}

/** La columna como sale de SQL Server: fechas y decimales como texto (sin huso horario ni pérdida de precisión). */
function seleccion(c) {
  const q = `[${c.nombre.replace(/]/g, ']]')}]`;
  switch (c.tipo) {
    case 'date': return `CONVERT(varchar(10), ${q}, 23) AS ${q}`;
    case 'datetime': case 'datetime2': case 'smalldatetime': return `CONVERT(varchar(27), ${q}, 126) AS ${q}`;
    case 'datetimeoffset': return `CONVERT(varchar(34), ${q}, 127) AS ${q}`;
    case 'time': return `CAST(${q} AS varchar(16)) AS ${q}`;
    case 'decimal': case 'numeric': return `CONVERT(varchar(60), ${q}) AS ${q}`;
    // ⛔ Sin estilo, `money` sale con 2 decimales y guarda 4: el estilo 2 los conserva.
    case 'money': case 'smallmoney': return `CONVERT(varchar(60), ${q}, 2) AS ${q}`;
    case 'xml': case 'sql_variant': case 'hierarchyid': case 'geography': case 'geometry': return `CAST(${q} AS nvarchar(max)) AS ${q}`;
    default: return q;
  }
}

const TIPO_PARAM = {
  int: sql.Int, bigint: sql.BigInt, smallint: sql.SmallInt, tinyint: sql.TinyInt, uniqueidentifier: sql.UniqueIdentifier,
  char: sql.VarChar, varchar: sql.VarChar, nchar: sql.NVarChar, nvarchar: sql.NVarChar,
};

/** `WHERE` del trozo siguiente para una llave de una o varias columnas (T-SQL no compara tuplas). */
function despuesDe(llave) {
  return llave.map((k, i) => `(${[...llave.slice(0, i).map((kk, j) => `[${kk.nombre}] = @p${j}`), `[${k.nombre}] > @p${i}`].join(' AND ')})`)
    .join(' OR ');
}

const limpiar = (v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const pgId = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** Catálogo de una base: tablas con sus columnas (sin las secretas), su llave y sus filas. */
async function catalogo(pool, db) {
  const r = await pool.request().query(`USE [${db.replace(/]/g, ']]')}];
    SELECT t.object_id AS oid, s.name AS esquema, t.name AS tabla, c.column_id, c.name AS nombre,
           TYPE_NAME(c.system_type_id) AS tipo, c.precision, c.scale
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns c ON c.object_id = t.object_id
     WHERE t.is_ms_shipped = 0 ORDER BY t.object_id, c.column_id;
    SELECT i.object_id AS oid, c.name AS nombre
      FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE i.is_primary_key = 1 ORDER BY i.object_id, ic.key_ordinal;
    SELECT object_id AS oid, SUM(rows) AS filas FROM sys.partitions WHERE index_id IN (0, 1) GROUP BY object_id;`);
  const [cols, pks, filas] = r.recordsets;
  const tablas = new Map();
  for (const c of cols) {
    if (!tablas.has(c.oid)) tablas.set(c.oid, { esquema: c.esquema, tabla: c.tabla, columnas: [], excluidas: [], llave: [], filas: 0 });
    const t = tablas.get(c.oid);
    const col = { nombre: c.nombre, tipo: String(c.tipo).toLowerCase(), precision: c.precision, scale: c.scale };
    if (esSecreta(col)) t.excluidas.push(c.nombre); else t.columnas.push(col);
  }
  for (const p of pks) {
    const t = tablas.get(p.oid);
    if (t) t.llave.push(t.columnas.find((c) => c.nombre === p.nombre) ?? { nombre: p.nombre, tipo: '__excluida' });
  }
  for (const f of filas) { const t = tablas.get(f.oid); if (t) t.filas = Number(f.filas) || 0; }
  return [...tablas.values()];
}

async function prepararDestino(pg) {
  for (const s of ['contpaqi_ods', 'contpaqi_nom']) {
    await pg.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await pg.query(`CREATE TABLE IF NOT EXISTS ${s}._sync_status (table_name text PRIMARY KEY, source_db text,
      rows_source bigint, rows_copied bigint, last_push_at timestamptz NOT NULL DEFAULT now(), seconds numeric, note text)`);
  }
  await pg.query('REVOKE ALL ON SCHEMA contpaqi_nom FROM PUBLIC');
  for (const rol of ['app_runtime', 'dev_ro']) {
    if (!(await pg.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [rol])).rows.length) continue;
    await pg.query(`GRANT USAGE ON SCHEMA contpaqi_ods TO ${rol}`);
    await pg.query(`GRANT SELECT ON ALL TABLES IN SCHEMA contpaqi_ods TO ${rol}`);
    await pg.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi_ods GRANT SELECT ON TABLES TO ${rol}`);
  }
}

/** INSERT por lotes, dentro del límite de 65,535 parámetros de Postgres. */
async function insertar(pg, destino, columnas, repo, filas) {
  const nombres = [...columnas.map((c) => pgId(c.nombre.toLowerCase())), ...(repo ? ['"_repo"'] : [])];
  const por = nombres.length;
  const max = Math.max(1, Math.min(1000, Math.floor(60000 / por)));
  for (let i = 0; i < filas.length; i += max) {
    const lote = filas.slice(i, i + max);
    const valores = [];
    const marcas = lote.map((r, j) => {
      for (const c of columnas) valores.push(limpiar(r[c.nombre]));
      if (repo) valores.push(repo);
      return `(${nombres.map((_, k) => `$${j * por + k + 1}`).join(',')})`;
    });
    await pg.query(`INSERT INTO ${destino} (${nombres.join(',')}) VALUES ${marcas.join(',')}`, valores);
  }
}

/** Lee una tabla sin llave de una pasada, con pausa mientras Postgres escribe cada lote. */
function leerDeUnaPasada(pool, desde, select, alLote) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const fin = (e) => { if (listo) return; listo = true; if (e) reject(e); else resolve(); };
    const req = pool.request();
    req.stream = true;
    let buf = [];
    let cadena = Promise.resolve();
    req.on('row', (r) => {
      buf.push(r);
      if (buf.length < TROZO) return;
      const lote = buf; buf = [];
      req.pause();
      cadena = cadena.then(() => alLote(lote)).then(() => req.resume()).catch((e) => { req.cancel(); fin(e); });
    });
    req.on('error', (e) => fin(e));
    req.on('done', () => { cadena.then(() => (buf.length ? alLote(buf) : null)).then(() => fin(), fin); });
    req.query(`SELECT ${select} FROM ${desde} WITH (NOLOCK)`);
  });
}

async function copiarTabla(pool, pg, f, t) {
  const esquemaPg = f.nomina || /^nomina/i.test(t.tabla) ? 'contpaqi_nom' : 'contpaqi_ods';
  const nombrePg = `${f.prefijo}${t.esquema === 'dbo' ? '' : `${t.esquema}_`}${t.tabla}`.toLowerCase();
  const destino = `${esquemaPg}.${pgId(nombrePg)}`;
  const desde = `[${f.db.replace(/]/g, ']]')}].[${t.esquema}].[${t.tabla}]`;
  const select = t.columnas.map(seleccion).join(', ');
  const porLlave = t.llave.length > 0 && t.llave.every((k) => LLAVE_LEGIBLE.has(k.tipo));
  const clave = `${nombrePg}${f.repo ? `|${f.repo}` : ''}`;

  if (!APPLY) {
    await pool.request().query(`SELECT TOP (1) ${select} FROM ${desde} WITH (NOLOCK)`);
    return { destino, filas: t.filas, porLlave, copiadas: 0 };
  }

  const defs = t.columnas.map((c) => `${pgId(c.nombre.toLowerCase())} ${tipoPg(c)}`);
  if (f.repo) defs.push('"_repo" text NOT NULL');
  defs.push('"_synced_at" timestamptz NOT NULL DEFAULT now()');
  const pk = porLlave ? `, PRIMARY KEY (${[...t.llave.map((k) => pgId(k.nombre.toLowerCase())), ...(f.repo ? ['"_repo"'] : [])].join(', ')})` : '';
  await pg.query(`CREATE TABLE IF NOT EXISTS ${destino} (${defs.join(', ')}${pk})`);
  for (const c of t.columnas) await pg.query(`ALTER TABLE ${destino} ADD COLUMN IF NOT EXISTS ${pgId(c.nombre.toLowerCase())} ${tipoPg(c)}`);
  // Un secreto que una corrida anterior alcanzó a copiar se borra de prod, no sólo se deja de copiar.
  for (const x of t.excluidas) await pg.query(`ALTER TABLE ${destino} DROP COLUMN IF EXISTS ${pgId(x.toLowerCase())}`);
  if (f.repo) await pg.query(`DELETE FROM ${destino} WHERE "_repo" = $1`, [f.repo]);
  else await pg.query(`TRUNCATE ${destino}`);

  let copiadas = 0;
  if (porLlave) {
    let ultimo = null;
    for (;;) {
      const req = pool.request();
      if (ultimo) t.llave.forEach((k, i) => req.input(`p${i}`, TIPO_PARAM[k.tipo], ultimo[i]));
      const filas = (await req.query(`SELECT TOP (${TROZO}) ${select} FROM ${desde} ${ultimo ? `WHERE ${despuesDe(t.llave)}` : ''}`
        + ` ORDER BY ${t.llave.map((k) => `[${k.nombre}]`).join(', ')}`)).recordset;
      if (!filas.length) break;
      await insertar(pg, destino, t.columnas, f.repo, filas);
      copiadas += filas.length;
      const u = filas[filas.length - 1];
      ultimo = t.llave.map((k) => u[k.nombre]);
      if (filas.length < TROZO) break;
      if (PAUSA_MS) await dormir(PAUSA_MS);
    }
  } else {
    await leerDeUnaPasada(pool, desde, select, async (lote) => {
      await insertar(pg, destino, t.columnas, f.repo, lote);
      copiadas += lote.length;
    });
  }
  const origen = Number((await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${desde} WITH (NOLOCK)`)).recordset[0].n);
  const enPg = Number((await pg.query(`SELECT count(*)::bigint AS n FROM ${destino}${f.repo ? ' WHERE "_repo" = $1' : ''}`,
    f.repo ? [f.repo] : [])).rows[0].n);
  return { destino, filas: origen, copiadas: enPg, porLlave, clave, esquemaPg };
}

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await pg.connect();
  const sid = (await pg.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  const k = classify(process.env.DATABASE_URL_NEW);
  console.log(`destino: ${k.kind} ${k.host}/${k.db} · system_identifier ${sid} · ${APPLY ? 'ESCRIBE' : 'EN SECO (sin --apply no escribe)'}`);
  const pool = await sql.connect(CFG);
  const bases = (await pool.request().query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE'`)).recordset.map((r) => r.name);
  if (APPLY) await prepararDestino(pg);

  let detener = false;
  process.on('SIGINT', () => { console.log('\n⏸ se detiene al terminar la tabla en curso…'); detener = true; });
  const t0 = Date.now();
  const resumen = { tablas: 0, filas: 0, fallas: [], descuadres: [], omitidas: [] };
  for (const f of fuentes(bases)) {
    let tablas;
    try { tablas = await catalogo(pool, f.db); } catch (e) { resumen.fallas.push(`${f.db}: ${e.message}`); console.log(`\n[${f.alias}] ${f.db}: ⚠ NO MEDIDO — ${e.message}`); continue; }
    const conDatos = tablas.filter((t) => t.filas > 0 && (!TABLA || t.tabla.toLowerCase() === TABLA.toLowerCase()));
    console.log(`\n[${f.alias}] ${f.db}${f.repo ? ` (repo ${f.repo})` : ''}: ${conDatos.length} tablas con datos`);
    for (const t of conDatos) {
      if (detener) break;
      if (TABLA_SECRETA.test(t.tabla)) { resumen.omitidas.push(`${f.db}.${t.tabla} (llaves privadas)`); console.log(`  ⛔ ${t.tabla}: no se copia (llaves privadas)`); continue; }
      if (t.excluidas.length) console.log(`  ⛔ ${t.tabla}: sin las columnas ${t.excluidas.join(', ')}`);
      const ti = Date.now();
      try {
        const r = await copiarTabla(pool, pg, f, t);
        const s = (Date.now() - ti) / 1000;
        if (APPLY) {
          const cuadra = r.copiadas === r.filas;
          if (!cuadra) resumen.descuadres.push(`${r.destino}${f.repo ? ` (${f.repo})` : ''}: origen ${r.filas} · copiadas ${r.copiadas}`);
          await pg.query(`INSERT INTO ${r.esquemaPg}._sync_status (table_name, source_db, rows_source, rows_copied, last_push_at, seconds, note)
            VALUES ($1, $2, $3, $4, now(), $5, $6) ON CONFLICT (table_name) DO UPDATE SET source_db = EXCLUDED.source_db,
            rows_source = EXCLUDED.rows_source, rows_copied = EXCLUDED.rows_copied, last_push_at = now(), seconds = EXCLUDED.seconds,
            note = EXCLUDED.note`, [r.clave, f.db, r.filas, r.copiadas, s.toFixed(1), r.porLlave ? 'carga inicial por llave' : 'carga inicial de una pasada (NOLOCK)']);
          resumen.filas += r.copiadas;
          console.log(`  ${cuadra ? '✓' : '✗'} ${t.tabla.padEnd(34)} → ${r.destino.padEnd(44)} ${String(r.copiadas).padStart(9)} de ${String(r.filas).padStart(9)}`
            + `  ${s.toFixed(1)} s${r.porLlave ? '' : ' (sin llave)'}`);
        } else {
          console.log(`  · ${t.tabla.padEnd(34)} → ${r.destino.padEnd(44)} ${String(r.filas).padStart(9)} filas  ${r.porLlave ? 'por llave' : 'de una pasada'}  (lectura de prueba OK)`);
        }
        resumen.tablas += 1;
      } catch (e) {
        resumen.fallas.push(`${f.db}.${t.tabla}: ${e.message}`);
        console.log(`  ✗ ${t.tabla}: FALLÓ — ${String(e.message).slice(0, 200)}`);
      }
    }
    if (detener) break;
  }
  const min = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n${APPLY ? 'CARGA' : 'EN SECO'}: ${resumen.tablas} tablas · ${resumen.filas.toLocaleString('es-MX')} filas copiadas · ${min} min`);
  if (resumen.omitidas.length) console.log(`  omitidas a propósito: ${resumen.omitidas.join('; ')}`);
  if (resumen.descuadres.length) console.log(`  ⚠ conteo distinto al origen (${resumen.descuadres.length}): ${resumen.descuadres.join('; ')}`);
  if (resumen.fallas.length) console.log(`  ✗ fallas (${resumen.fallas.length}):\n    ${resumen.fallas.join('\n    ')}`);
  await pool.close();
  await pg.end();
  process.exit(resumen.fallas.length ? 1 : 0);
})().catch((e) => {
  // Un `AggregateError` (conexión rechazada en varias direcciones) trae el mensaje vacío: se dicen sus causas.
  const causas = Array.isArray(e && e.errors) ? e.errors.map((x) => x && x.message).filter(Boolean).join('; ') : '';
  console.error('ERR', (e && e.message) || causas || String(e));
  if (!process.env.DATABASE_URL_NEW) console.error('  ⛔ DATABASE_URL_NEW no está en el entorno: en el pod se carga de /secrets/feeds.env.');
  process.exit(1);
});
