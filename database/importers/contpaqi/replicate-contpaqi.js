/* eslint-disable no-console */
/**
 * `[CP.9.2]` — **Réplica cruda de ContPAQi en prod: la CARGA INICIAL y la SINCRONÍA.** Copia tabla por tabla, tal cual,
 * de SQL Server (`192.168.0.35\COMPAC`) a Postgres: `contpaqi_ods` (contabilidad, generales, catálogos del SAT, directorio
 * y metadatos del ADD) y `contpaqi_nom` (nóminas). Pedido de Edgar: *«todo, hasta nóminas, hagámoslo ahora»*.
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
 * ── La sincronía (`--sync`): sólo lo que cambió, sin marca de agua ─────────────────────────────
 *   ContPAQi no tiene columna «modificado desde»: `RowVersion` es un entero AL AZAR que se regenera en cada escritura
 *   (medido 2026-10-30: 111,182 valores distintos en 111,185 pólizas, de 977 a 2,147,468,696). No sirve de marca de
 *   agua, pero sí de huella: es lo que ya hace el feed de pólizas (PV.1) cada minuto, con `Σ RowVersion` por póliza.
 *   Por tabla, la llave se parte en tramos de ~`--cubeta` filas y en los DOS lados se calcula por tramo: filas y la Σ de
 *   cada columna que se suma exacta (enteros —`RowVersion` incluida—, decimales, money, bit). Sólo el tramo que difiere
 *   se recopia, en UNA transacción: quien lee la réplica nunca ve el tramo a medias.
 *   Es un árbitro y no una bitácora: compara el ORIGEN contra la RÉPLICA, así que también ve una réplica que se movió sola.
 *   ⚠️ Lo que NO ve, declarado: un cambio SÓLO de texto o de fecha en una tabla SIN `RowVersion` (nóminas, SAT,
 *   directorio; contabilidad y generales la traen todas). Una tabla sin llave entera se compara entera hasta
 *   `--tabla-entera-max` filas; arriba de eso queda «sin carril» en `_sync_status.note` y su `last_push_at` envejece.
 *
 * ── Uso (en la LAN; la contraseña nunca va en el repo) ──────────────────────────────────────
 *   CONTPAQI_SQL_PASSWORD=… node database/importers/contpaqi/replicate-contpaqi.js            # en seco: plan + 1 fila de cada tabla
 *   … --apply [--solo=ct,gen,sat,dir,nom,nomgen,add,addo] [--tabla=Polizas] [--trozo=5000] [--pausa-ms=25]
 *   … --sync                       # en seco: qué tramos difieren de la réplica, sin escribir
 *   … --sync --apply [--watch=5]   # recopia los tramos que difieren; con --watch, una vuelta cada N minutos
 *   … --sync --control             # prueba negativa: mueve una fila DENTRO de una transacción que se deshace
 *   Destino: `DATABASE_URL_NEW`. Sin `--apply` no escribe nada. Una sola corrida que escribe a la vez (candado).
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
const SYNC = process.argv.includes('--sync');
const WATCH_MIN = Number(arg('watch', 0));
const CUBETA = Number(arg('cubeta', 4096));
const TABLA_ENTERA_MAX = Number(arg('tabla-entera-max', 100000));
const CONTROL = process.argv.includes('--control');
/** Dos corridas que escriben a la vez se pisan: una borra el tramo que la otra acaba de copiar. */
const CANDADO = 'contpaqi_ods.replica';

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
/** Secreto en cualquier tabla y de cualquier tipo: el nombre lo dice sin ambigüedad. */
const COLUMNA_SECRETA = /privad|password|passwd|contrase|pwd|clave_?acceso|secret|token|api_?key/i;
/**
 * ⛔ ContPAQi le dice CLAVE a la contraseña: `GeneralesSQL.Usuarios.Clave` y `eMailClave` se copiaron a prod en el humo
 * del 2026-10-30 porque el filtro buscaba «password». Pero «clave» también es la homoclave del RFC (`nom10001.homoclave`)
 * y la clave de un concepto (`Nomina_Detalle.Clave`), así que por nombre se pasa de largo: medido en el ensayo del mismo
 * día. «Clave» es secreto SÓLO en las tablas de usuarios. Y FIEL/CIEC, al final de un texto (no `FieldName`).
 */
const TABLA_DE_USUARIOS = /^(usuarios?|cac10000)$/i;
const CLAVE_DE_USUARIO = /^(clave|e?mailclave)$/i;
const TEXTO_SECRETO = /(fiel|ciec|pass)$/i;
const TIPOS_TEXTO = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'binary', 'varbinary', 'image']);
const esSecreta = (tabla, c) => COLUMNA_SECRETA.test(c.nombre)
  || (TABLA_DE_USUARIOS.test(tabla) && CLAVE_DE_USUARIO.test(c.nombre))
  || (TEXTO_SECRETO.test(c.nombre) && TIPOS_TEXTO.has(c.tipo));
const LLAVE_LEGIBLE = new Set(['int', 'bigint', 'smallint', 'tinyint', 'uniqueidentifier', 'char', 'varchar', 'nchar', 'nvarchar']);
const ENTERO = new Set(['int', 'bigint', 'smallint', 'tinyint']);
const RANGO_ENTERO = { tinyint: [0, 255], smallint: [-32768, 32767], int: [-2147483648, 2147483647],
  bigint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
/**
 * Lo que entra a la huella, sumado EXACTO en los dos motores. ⛔ ContPAQi guarda los importes en `float` (`Importe`,
 * `Cargos`, `Importes1..14`: 149 columnas en 14 tablas, medido 2026-10-30) y la suma de un `float` depende del orden en
 * que se acumula: no se suma su valor sino su PATRÓN DE BITS como entero, que es el mismo en SQL Server y en Postgres.
 */
const FLOTANTE = new Set(['float', 'real']);
const SUMABLE = new Set([...ENTERO, 'bit', 'decimal', 'numeric', 'money', 'smallmoney', ...FLOTANTE]);

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
const msId = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const hora = () => new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour12: false });
let detener = false;

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
    if (esSecreta(c.tabla, col)) t.excluidas.push(c.nombre); else t.columnas.push(col);
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

/** Dónde vive cada tabla en Postgres y cómo se lee de SQL Server. */
function contexto(f, t) {
  const esquemaPg = f.nomina || /^nomina/i.test(t.tabla) ? 'contpaqi_nom' : 'contpaqi_ods';
  const nombrePg = `${f.prefijo}${t.esquema === 'dbo' ? '' : `${t.esquema}_`}${t.tabla}`.toLowerCase();
  return {
    esquemaPg,
    destino: `${esquemaPg}.${pgId(nombrePg)}`,
    desde: `${msId(f.db)}.${msId(t.esquema)}.${msId(t.tabla)}`,
    select: t.columnas.map(seleccion).join(', '),
    porLlave: t.llave.length > 0 && t.llave.every((k) => LLAVE_LEGIBLE.has(k.tipo)),
    clave: `${nombrePg}${f.repo ? `|${f.repo}` : ''}`,
  };
}

/**
 * Crea la tabla si falta, le agrega las columnas nuevas del origen y le BORRA las secretas: un secreto que una corrida
 * anterior alcanzó a copiar se borra de prod, no sólo se deja de copiar. Mira el catálogo antes de tocar nada: un
 * `ALTER TABLE … IF NOT EXISTS` toma el candado exclusivo aunque no haga nada, y la sincronía pasa por aquí cada vuelta.
 */
async function asegurarTabla(pg, f, t, x) {
  const hay = await columnasPg(pg, x);
  if (!hay.size) {
    const defs = t.columnas.map((c) => `${pgId(c.nombre.toLowerCase())} ${tipoPg(c)}`);
    if (f.repo) defs.push('"_repo" text NOT NULL');
    defs.push('"_synced_at" timestamptz NOT NULL DEFAULT now()');
    const pk = x.porLlave ? `, PRIMARY KEY (${[...t.llave.map((k) => pgId(k.nombre.toLowerCase())), ...(f.repo ? ['"_repo"'] : [])].join(', ')})` : '';
    await pg.query(`CREATE TABLE IF NOT EXISTS ${x.destino} (${defs.join(', ')}${pk})`);
    return [];
  }
  const agregadas = [];
  for (const c of t.columnas) {
    if (hay.has(c.nombre.toLowerCase())) continue;
    await pg.query(`ALTER TABLE ${x.destino} ADD COLUMN IF NOT EXISTS ${pgId(c.nombre.toLowerCase())} ${tipoPg(c)}`);
    agregadas.push(c.nombre);
  }
  for (const e of t.excluidas) {
    if (hay.has(e.toLowerCase())) await pg.query(`ALTER TABLE ${x.destino} DROP COLUMN IF EXISTS ${pgId(e.toLowerCase())}`);
  }
  return agregadas;
}
async function columnasPg(pg, x) {
  return new Set((await pg.query(`SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0
    AND NOT attisdropped`, [x.destino])).rows.map((r) => r.attname));
}

/** Recorre la tabla entera y entrega cada lote: por llave en trozos o, sin llave legible, de una pasada. */
async function recorrer(pool, t, x, alLote) {
  if (!x.porLlave) return leerDeUnaPasada(pool, x.desde, x.select, alLote);
  let ultimo = null;
  for (;;) {
    const req = pool.request();
    if (ultimo) t.llave.forEach((k, i) => req.input(`p${i}`, TIPO_PARAM[k.tipo], ultimo[i]));
    const filas = (await req.query(`SELECT TOP (${TROZO}) ${x.select} FROM ${x.desde} ${ultimo ? `WHERE ${despuesDe(t.llave)}` : ''}`
      + ` ORDER BY ${t.llave.map((k) => msId(k.nombre)).join(', ')}`)).recordset;
    if (!filas.length) break;
    await alLote(filas);
    const u = filas[filas.length - 1];
    ultimo = t.llave.map((k) => u[k.nombre]);
    if (filas.length < TROZO) break;
    if (PAUSA_MS) await dormir(PAUSA_MS);
  }
}

async function copiarTabla(pool, pg, f, t) {
  const x = contexto(f, t);
  if (!APPLY) {
    await pool.request().query(`SELECT TOP (1) ${x.select} FROM ${x.desde} WITH (NOLOCK)`);
    return { ...x, filas: t.filas, copiadas: 0 };
  }
  await asegurarTabla(pg, f, t, x);
  if (f.repo) await pg.query(`DELETE FROM ${x.destino} WHERE "_repo" = $1`, [f.repo]);
  else await pg.query(`TRUNCATE ${x.destino}`);
  await recorrer(pool, t, x, (lote) => insertar(pg, x.destino, t.columnas, f.repo, lote));
  const origen = Number((await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${x.desde} WITH (NOLOCK)`)).recordset[0].n);
  const enPg = Number((await pg.query(`SELECT count(*)::bigint AS n FROM ${x.destino}${f.repo ? ' WHERE "_repo" = $1' : ''}`,
    f.repo ? [f.repo] : [])).rows[0].n);
  return { ...x, filas: origen, copiadas: enPg };
}

// ── La sincronía ─────────────────────────────────────────────────────────────────────────────

/**
 * La Σ de una columna en SQL Server, como texto exacto. Un `float` aporta sus bits (IEEE, big-endian, como entero con
 * signo) y el `-0` cuenta como `0`: la réplica lo guarda como `0` (el driver lo escribe como texto).
 */
function sumaMs(c) {
  const q = msId(c.nombre);
  if (FLOTANTE.has(c.tipo)) {
    const [bytes, entero] = c.tipo === 'real' ? [4, 'int'] : [8, 'bigint'];
    return `CONVERT(varchar(60), SUM(CAST(CASE WHEN ${q} = 0 THEN 0 ELSE CAST(CAST(${q} AS binary(${bytes})) AS ${entero}) END AS decimal(38, 0))))`;
  }
  const escala = c.tipo === 'decimal' || c.tipo === 'numeric' ? c.scale : c.tipo === 'money' || c.tipo === 'smallmoney' ? 4 : 0;
  const v = c.tipo === 'bit' ? `CAST(${q} AS int)` : q;
  return `CONVERT(varchar(60), SUM(CAST(${v} AS decimal(38, ${escala}))))`;
}
/** La misma Σ en Postgres, sobre la columna replicada. */
function sumaPg(c) {
  const q = pgId(c.nombre.toLowerCase());
  if (FLOTANTE.has(c.tipo)) {
    const [envio, bits, entero] = c.tipo === 'real' ? ['float4send', 32, 'int'] : ['float8send', 64, 'bigint'];
    return `sum(CASE WHEN ${q} = 0 THEN 0 ELSE ('x' || encode(${envio}(${q}), 'hex'))::bit(${bits})::${entero} END)::text`;
  }
  return `sum(${c.tipo === 'bit' ? `${q}::int` : q})::text`;
}
/** `12.500000` y `12.5` son el mismo número: se comparan sin ceros de cola. */
function normal(v) {
  if (v === null || v === undefined) return '∅';
  let s = String(v).trim();
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
/** `{tramo → huella}`: la huella junta las filas y las sumas, ya normalizadas. */
function aMapa(filas, nSumas) {
  const m = new Map();
  for (const r of filas) {
    const partes = [normal(r.n)];
    for (let i = 0; i < nSumas; i++) partes.push(normal(r[`s${i}`]));
    m.set(Number(r.__tramo), { n: Number(r.n), huella: partes.join('|') });
  }
  return m;
}
/** Los tramos que difieren: con huella distinta, o presentes en un solo lado. */
function diferencias(origen, replica) {
  const out = [];
  for (const [b, o] of origen) { const r = replica.get(b); if (!r || r.huella !== o.huella) out.push(b); }
  for (const b of replica.keys()) if (!origen.has(b)) out.push(b);
  return out.sort((a, b) => a - b);
}

/**
 * Cómo se compara la tabla: por TRAMOS de la primera columna de la llave si es entera (también en llaves compuestas,
 * `idempleado, …`); si no, ENTERA hasta `TABLA_ENTERA_MAX` filas; arriba de eso, SIN CARRIL (declarado).
 */
function planSync(t) {
  const k = t.llave[0];
  if (k && ENTERO.has(k.tipo)) return { modo: 'tramos', k };
  if (t.filas <= TABLA_ENTERA_MAX) return { modo: 'entera' };
  return { modo: 'sin carril' };
}

/**
 * Ancho del tramo para que cada uno tenga ~`CUBETA` filas. Los tramos se cuentan desde la llave MÍNIMA del origen: así
 * en SQL Server nunca son negativos, y en Postgres (división con `floor`) lo que el origen ya borró cae en tramos que
 * sólo existen en la réplica, y se borra.
 */
async function medirLlave(pool, x, t, k) {
  const r = (await pool.request().query(`SELECT MIN(${msId(k.nombre)}) AS mn, MAX(${msId(k.nombre)}) AS mx
    FROM ${x.desde} WITH (NOLOCK)`)).recordset[0];
  if (r.mn === null || r.mn === undefined) return null;
  const mn = Number(r.mn);
  const tramos = Math.max(1, Math.ceil(t.filas / CUBETA));
  return { kmin: mn, w: Math.max(1, Math.ceil((Number(r.mx) - mn + 1) / tramos)) };
}

/** Huella por tramo en SQL Server. `NOLOCK`: una lectura sucia sólo provoca una recopia de más, que lee con candado. */
async function huellaOrigen(pool, t, x, sumables, p) {
  const sumas = sumables.map((c, i) => `, ${sumaMs(c)} AS s${i}`).join('');
  const cols = sumables.map((c) => `, ${msId(c.nombre)}`).join('');
  if (p.modo === 'entera') {
    return aMapa((await pool.request().query(`SELECT 0 AS __tramo, COUNT_BIG(*) AS n${sumas} FROM ${x.desde} WITH (NOLOCK)`)).recordset, sumables.length);
  }
  const req = pool.request().input('kmin', sql.BigInt, p.kmin).input('w', sql.BigInt, p.w);
  return aMapa((await req.query(`SELECT __tramo, COUNT_BIG(*) AS n${sumas} FROM (SELECT (${msId(p.k.nombre)} - @kmin) / @w AS __tramo${cols}
    FROM ${x.desde} WITH (NOLOCK)) z GROUP BY __tramo`)).recordset, sumables.length);
}

/** La misma huella sobre la réplica. */
async function huellaReplica(pg, f, x, sumables, p) {
  const sumas = sumables.map((c, i) => `, ${sumaPg(c)} AS s${i}`).join('');
  if (p.modo === 'entera') {
    return aMapa((await pg.query(`SELECT 0 AS __tramo, count(*) AS n${sumas} FROM ${x.destino}${f.repo ? ' WHERE "_repo" = $1' : ''}`,
      f.repo ? [f.repo] : [])).rows, sumables.length);
  }
  return aMapa((await pg.query(`SELECT ${tramoPg(p, '$1', '$2')} AS __tramo, count(*) AS n${sumas}
    FROM ${x.destino}${f.repo ? ' WHERE "_repo" = $3' : ''} GROUP BY 1`, f.repo ? [p.kmin, p.w, f.repo] : [p.kmin, p.w])).rows, sumables.length);
}
/** El tramo de una fila en Postgres, en `bigint`: `smallint − smallint` se desborda si la llave cruza el cero. */
const tramoPg = (p, kmin, w) => `floor((${pgId(p.k.nombre.toLowerCase())}::bigint - ${kmin}::bigint)::numeric / ${w}::numeric)::bigint`;

async function enTransaccion(pg, fn) {
  await pg.query('BEGIN');
  try {
    const r = await fn();
    await pg.query('COMMIT');
    return r;
  } catch (e) {
    await pg.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/** Recopia UN tramo en una transacción: lo que la réplica tenía en ese rango se va y entra lo del origen. */
async function recopiarTramo(pool, pg, f, t, x, p, b, enOrigen) {
  // El rango del tramo, recortado al tipo de la llave: el último tramo de un `int` pasaría de 2,147,483,647.
  const [min, max] = RANGO_ENTERO[p.k.tipo];
  const lo = Math.max(p.kmin + b * p.w, min);
  const hi = Math.min(p.kmin + (b + 1) * p.w - 1, max);
  let filas = [];
  if (enOrigen) {
    filas = (await pool.request().input('lo', TIPO_PARAM[p.k.tipo], lo).input('hi', TIPO_PARAM[p.k.tipo], hi)
      .query(`SELECT ${x.select} FROM ${x.desde} WHERE ${msId(p.k.nombre)} BETWEEN @lo AND @hi`)).recordset;
  }
  await enTransaccion(pg, async () => {
    await pg.query(`DELETE FROM ${x.destino} WHERE ${pgId(p.k.nombre.toLowerCase())} BETWEEN $1 AND $2${f.repo ? ' AND "_repo" = $3' : ''}`,
      f.repo ? [lo, hi, f.repo] : [lo, hi]);
    if (filas.length) await insertar(pg, x.destino, t.columnas, f.repo, filas);
  });
  return filas.length;
}

/** Recopia la tabla entera en una transacción (sólo tablas chicas: `TABLA_ENTERA_MAX`). Lee todo antes de abrirla. */
async function recopiarEntera(pool, pg, f, t, x) {
  const filas = [];
  await recorrer(pool, t, x, async (lote) => { for (const r of lote) filas.push(r); });
  await enTransaccion(pg, async () => {
    await pg.query(`DELETE FROM ${x.destino}${f.repo ? ' WHERE "_repo" = $1' : ''}`, f.repo ? [f.repo] : []);
    if (filas.length) await insertar(pg, x.destino, t.columnas, f.repo, filas);
  });
  return filas.length;
}

/**
 * ⛔ Prueba negativa (regla 12): dentro de una transacción que se DESHACE, mueve una fila de la réplica (una columna
 * sumable +1, o la borra si no hay) y exige que la huella marque SU tramo. Una huella que nunca difiere es un espejo.
 */
async function controlNegativo(pg, f, t, x, sumables, p, origen, antes) {
  if (p.modo === 'entera' && antes.length) return 'no concluyente (la tabla ya difería)';
  const col = sumables.find((c) => !t.llave.some((k) => k.nombre === c.nombre));
  const cq = col ? pgId(col.nombre.toLowerCase()) : null;
  const tramo = p.modo === 'tramos' ? tramoPg(p, Number(p.kmin), Number(p.w)) : '0';
  // La fila se elige FUERA de los tramos que ya difieren: si no, el control no distingue su efecto del que ya había.
  const params = [];
  const donde = [cq ? `${cq} IS NOT NULL` : null];
  if (f.repo) { params.push(f.repo); donde.push(`"_repo" = $${params.length}`); }
  if (p.modo === 'tramos' && antes.length) { params.push(antes); donde.push(`${tramo} <> ALL($${params.length}::bigint[])`); }
  const filtro = donde.filter(Boolean);
  try {
    return await enTransaccion(pg, async () => {
      const fila = (await pg.query(`SELECT ctid::text AS ctid, ${tramo} AS __tramo FROM ${x.destino}
        ${filtro.length ? `WHERE ${filtro.join(' AND ')}` : ''} LIMIT 1`, params)).rows[0];
      if (!fila) throw Object.assign(new Error('no hay fila fuera de los tramos que ya difieren'), { noAplica: true });
      if (cq) await pg.query(`UPDATE ${x.destino} SET ${cq} = ${col.tipo === 'bit' ? `NOT ${cq}` : `${cq} + 1`} WHERE ctid = $1::tid`, [fila.ctid]);
      else await pg.query(`DELETE FROM ${x.destino} WHERE ctid = $1::tid`, [fila.ctid]);
      const despues = diferencias(origen, await huellaReplica(pg, f, x, sumables, p));
      const b = Number(fila.__tramo);
      const esperado = [...new Set([...antes, b])].sort((m, n) => m - n);
      const veredicto = antes.includes(b) ? 'no concluyente (su tramo ya difería)'
        : JSON.stringify(despues) === JSON.stringify(esperado) ? `✓ marcó el tramo ${b} (${cq ? `${col.nombre} + 1` : 'fila borrada'})`
          : `✗ NO lo vio: esperaba ${esperado.length} tramos distintos y hubo ${despues.length}`;
      throw Object.assign(new Error(veredicto), { veredicto });
    });
  } catch (e) {
    if (e.veredicto) return e.veredicto;
    return `no aplica (${e.noAplica ? e.message : String(e.message).slice(0, 80)})`;
  }
}

/** Una tabla: compara las huellas y, con `--apply`, recopia los tramos que difieren. */
async function sincronizarTabla(pool, pg, f, t) {
  const x = contexto(f, t);
  const existe = (await pg.query('SELECT to_regclass($1) IS NOT NULL AS e', [x.destino])).rows[0].e;
  if (!existe) {
    if (!t.filas) return null;
    if (!APPLY) return { x, modo: 'nueva', tramos: 1, difieren: [0], recopiadas: 0, nota: 'tabla nueva: le toca la carga inicial' };
    const r = await copiarTabla(pool, pg, f, t);
    return { x, modo: 'nueva', tramos: 1, difieren: [0], recopiadas: r.copiadas, nOrigen: r.filas, nReplica: r.copiadas };
  }
  const agregadas = APPLY ? await asegurarTabla(pg, f, t, x) : [];
  let p = planSync(t);
  if (p.modo === 'sin carril') {
    return { x, modo: p.modo, nota: `sin carril: ${t.filas} filas y sin llave entera; vale la última carga completa` };
  }
  if (p.modo === 'tramos') p = (await medirLlave(pool, x, t, p.k).then((m) => (m ? { ...p, ...m } : null))) || { modo: 'entera' };
  // Una columna que el origen estrenó: con --apply se acaba de agregar VACÍA; en seco todavía no existe y no se puede
  // sumar. En los dos casos la tabla entera difiere, aunque la columna no sea sumable.
  const enPg = await columnasPg(pg, x);
  const nuevas = APPLY ? agregadas : t.columnas.filter((c) => !enPg.has(c.nombre.toLowerCase())).map((c) => c.nombre);
  const sumables = t.columnas.filter((c) => SUMABLE.has(c.tipo) && enPg.has(c.nombre.toLowerCase()));
  const origen = await huellaOrigen(pool, t, x, sumables, p);
  const replica = await huellaReplica(pg, f, x, sumables, p);
  const difieren = nuevas.length ? [...new Set([...origen.keys(), ...replica.keys()])].sort((a, b) => a - b) : diferencias(origen, replica);
  const control = CONTROL ? await controlNegativo(pg, f, t, x, sumables, p, origen, difieren) : null;
  let recopiadas = 0;
  if (APPLY && difieren.length) {
    if (p.modo === 'entera') recopiadas = await recopiarEntera(pool, pg, f, t, x);
    else for (const b of difieren) recopiadas += await recopiarTramo(pool, pg, f, t, x, p, b, origen.has(b));
  }
  const suma = (m) => [...m.values()].reduce((s, v) => s + v.n, 0);
  const nOrigen = suma(origen);
  const nReplica = APPLY ? suma(replica) - difieren.reduce((s, b) => s + (replica.get(b)?.n || 0), 0) + recopiadas : suma(replica);
  const nota = nuevas.length ? `columnas nuevas en el origen: ${nuevas.join(', ')}` : null;
  return { x, modo: p.modo, tramos: origen.size, difieren, recopiadas, nOrigen, nReplica, control, nota };
}

/** Las vueltas de la sincronía: una, o una cada `--watch` minutos hasta Ctrl-C. Devuelve cuántas fallas hubo. */
async function sincronizar(pool, pg, bases) {
  let fallas = 0;
  for (let vuelta = 1; ; vuelta++) {
    const t0 = Date.now();
    const v = { tablas: 0, alDia: 0, tramos: 0, difieren: 0, recopiadas: 0, sinCarril: 0, lentas: [], fallas: [] };
    for (const f of fuentes(bases)) {
      if (detener) break;
      let tablas;
      try { tablas = await catalogo(pool, f.db); } catch (e) { v.fallas.push(`${f.db}: ${e.message}`); continue; }
      for (const t of tablas) {
        if (detener) break;
        if (TABLA_SECRETA.test(t.tabla) || (TABLA && t.tabla.toLowerCase() !== TABLA.toLowerCase())) continue;
        const ti = Date.now();
        try {
          const r = await sincronizarTabla(pool, pg, f, t);
          if (!r) continue;
          const s = (Date.now() - ti) / 1000;
          v.tablas += 1;
          v.lentas.push([s, r.x.destino]);
          if (r.modo === 'sin carril') {
            v.sinCarril += 1;
            if (APPLY) await pg.query(`UPDATE ${r.x.esquemaPg}._sync_status SET note = $2 WHERE table_name = $1`, [r.x.clave, r.nota]);
            if (vuelta === 1) console.log(`  · ${t.tabla.padEnd(34)} ${r.nota}`);
            continue;
          }
          v.tramos += r.tramos;
          v.difieren += r.difieren.length;
          v.recopiadas += r.recopiadas;
          if (!r.difieren.length) v.alDia += 1;
          if (r.difieren.length || r.control) {
            console.log(`  ${r.difieren.length ? (APPLY ? '↻' : '≠') : '='} ${t.tabla.padEnd(34)} → ${r.x.destino.padEnd(44)} `
              + `${r.modo === 'nueva' ? r.nota || 'tabla nueva, copiada entera' : `${r.difieren.length} de ${r.tramos} tramos ${APPLY ? `recopiados (${r.recopiadas} filas)` : 'difieren'}${r.nota ? ` · ${r.nota}` : ''}`}`
              + `  ${s.toFixed(1)} s${r.control ? `  · control ${r.control}` : ''}`);
          }
          if (APPLY) {
            const nota = r.difieren.length ? `sync ${hora()}: ${r.difieren.length} de ${r.tramos} tramos recopiados (${r.recopiadas} filas)`
              : `sync ${hora()}: al día (${r.tramos} tramos, modo ${r.modo})`;
            await pg.query(`INSERT INTO ${r.x.esquemaPg}._sync_status (table_name, source_db, rows_source, rows_copied, last_push_at, seconds, note)
              VALUES ($1, $2, $3, $4, now(), $5, $6) ON CONFLICT (table_name) DO UPDATE SET source_db = EXCLUDED.source_db,
              rows_source = EXCLUDED.rows_source, rows_copied = EXCLUDED.rows_copied, last_push_at = now(), seconds = EXCLUDED.seconds,
              note = EXCLUDED.note`, [r.x.clave, f.db, r.nOrigen, r.nReplica, s.toFixed(1), nota]);
          }
        } catch (e) {
          v.fallas.push(`${f.db}.${t.tabla}: ${e.message}`);
          console.log(`  ✗ ${t.tabla}: FALLÓ — ${String(e.message).slice(0, 200)}`);
        }
        if (PAUSA_MS) await dormir(PAUSA_MS);
      }
    }
    const lentas = v.lentas.sort((a, b) => b[0] - a[0]).slice(0, 5).map(([s, d]) => `${d} ${s.toFixed(1)} s`).join(' · ');
    console.log(`${hora()} · SYNC vuelta ${vuelta}: ${v.tablas} tablas · ${v.alDia} al día · ${v.difieren} de ${v.tramos} tramos `
      + `${APPLY ? `recopiados (${v.recopiadas.toLocaleString('es-MX')} filas)` : 'difieren'} · ${v.sinCarril} sin carril · `
      + `${((Date.now() - t0) / 1000).toFixed(0)} s\n  las más lentas: ${lentas}`);
    if (v.fallas.length) console.log(`  ✗ fallas (${v.fallas.length}):\n    ${v.fallas.join('\n    ')}`);
    fallas += v.fallas.length;
    if (!WATCH_MIN || detener) break;
    for (let i = 0; i < WATCH_MIN * 60 && !detener; i++) await dormir(1000);
    if (detener) break;
  }
  return fallas;
}

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await pg.connect();
  const sid = (await pg.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  const k = classify(process.env.DATABASE_URL_NEW);
  console.log(`destino: ${k.kind} ${k.host}/${k.db} · system_identifier ${sid} · ${SYNC ? 'SINCRONÍA' : 'CARGA'} · `
    + `${APPLY ? 'ESCRIBE' : 'EN SECO (sin --apply no escribe)'}${CONTROL ? ' · con prueba negativa (se deshace)' : ''}`);
  const pool = await sql.connect(CFG);
  const bases = (await pool.request().query(`SELECT name FROM sys.databases WHERE state_desc = 'ONLINE'`)).recordset.map((r) => r.name);
  if (APPLY) {
    if (!(await pg.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [CANDADO])).rows[0].ok) {
      console.error('⛔ otra corrida que escribe en la réplica tiene el candado: salgo sin tocar nada.');
      process.exit(3);
    }
    await prepararDestino(pg);
  }

  process.on('SIGINT', () => { console.log('\n⏸ se detiene al terminar la tabla en curso…'); detener = true; });
  if (SYNC) {
    const fallas = await sincronizar(pool, pg, bases);
    await pool.close();
    await pg.end();
    process.exit(fallas ? 1 : 0);
  }
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
