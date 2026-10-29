/* eslint-disable no-console */
/**
 * `[CP.9.0]` — **Inventario para replicar ContPAQi entero.** SÓLO LEE el catálogo de SQL Server (`sys.*`): no toca
 * ninguna tabla de datos, no escribe en ninguna base, no cambia nada en el servidor de contabilidad. La única
 * excepción es `--directorio`, que además lee los renglones de `DB_Directory.dbo.DatabaseDirectory`: el directorio de
 * empresas del ADD, para saber de quién es cada repositorio.
 *
 * Contesta lo que decide CÓMO se replica cada tabla, que `FASE_CP9` no midió:
 *   - filas y tamaño (la carga inicial y su ventana);
 *   - llave primaria (sin ella no se puede reconciliar renglón a renglón);
 *   - marca de cambio: `RowVersion` (token por fila de la contabilidad), una columna `timestamp`/`rowversion`, o una
 *     fecha de modificación como `Documento.TimeStamp` del ADD (la que usa `import-contpaqi-cfdis.js`);
 *   - columnas binarias o de texto largo (`image`, `varbinary(max)`, `nvarchar(max)`…): los documentos del ADD pesan GB;
 *   - el nivel de compatibilidad de cada base.
 *
 * ⛔ Nada de `STRING_AGG`: exige compatibilidad 140 (SQL Server 2017), y la contabilidad, nóminas y tres repositorios del
 * ADD corren en un nivel menor. Medido el 2026-10-29: así salían «Incorrect syntax near the keyword 'AS'». Se agrega
 * con `FOR XML PATH`, que funciona en cualquier nivel.
 *
 * Corre en una máquina de la LAN que alcance la instancia `COMPAC` (en `md`, dentro de `feeds-cron`):
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/importers/contpaqi/02-inventario-replica.js [--db=ctLUIS_…] [--json=salida.json] [--directorio]
 *
 * ⛔ No trae contraseña por defecto, a propósito: el repo es público y los importadores viejos ya la tienen embebida
 * (deuda anotada en `ops/vl/crontab.feeds`). Sin `CONTPAQI_SQL_PASSWORD` se niega a arrancar.
 * Sin `--db` recorre todas las bases de la instancia salvo las de sistema.
 */
'use strict';
const fs = require('fs');
const sql = require('mssql');

const arg = (n, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
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
  connectionTimeout: 20000, requestTimeout: 120000,
};
const SISTEMA = new Set(['master', 'tempdb', 'model', 'msdb']);
/** Tipos que se guardan fuera de la fila o que pesan: deciden si una tabla va en la réplica de datos o aparte. */
const PESADOS = new Set(['image', 'text', 'ntext', 'varbinary', 'xml', 'geography', 'geometry', 'sql_variant']);
/** Una fecha que, por su nombre, puede servir de marca de cambio (`Documento.TimeStamp` del ADD). */
const FECHA_DE_CAMBIO = /time ?stamp|fecha_?modif|modificad|ultima_?act|updated/i;

const lista = (sub) => `STUFF((${sub} FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')`;

// Por tabla: filas, tamaño, llave primaria, marcas de cambio y los tipos de sus columnas. Todo de `sys.*`.
const POR_TABLA = `
SELECT s.name AS esquema, t.name AS tabla,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS filas,
       (SELECT SUM(a.total_pages) * 8 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id
         WHERE p.object_id = t.object_id) AS kb,
       ${lista(`SELECT ',' + c.name
          FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = t.object_id AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`)} AS pk,
       (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = t.object_id) AS columnas,
       ${lista(`SELECT ',' + c.name + ':' + ty.name + CASE WHEN c.max_length = -1 THEN '(max)' ELSE '' END
          FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = t.object_id ORDER BY c.column_id`)} AS tipos
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE t.is_ms_shipped = 0`;

/** La marca de cambio de una tabla, por orden de preferencia; `null` si no tiene ninguna. */
function marcaDe(tipos) {
  const rv = tipos.find((x) => x.nombre.toLowerCase() === 'rowversion');
  if (rv) return `${rv.nombre}:${rv.tipo}`;
  const ts = tipos.find((x) => x.tipo === 'timestamp' || x.tipo === 'rowversion');
  if (ts) return `${ts.nombre}:${ts.tipo}`;
  const f = tipos.find((x) => /date|time/.test(x.tipo) && FECHA_DE_CAMBIO.test(x.nombre));
  return f ? `${f.nombre}:${f.tipo}` : null;
}

(async () => {
  const pool = await sql.connect(CFG);
  const soloDb = arg('db', null);
  const bases = (await pool.request().query(`SELECT name, state_desc, compatibility_level FROM sys.databases ORDER BY name`)).recordset
    .filter((d) => !SISTEMA.has(d.name) && d.state_desc === 'ONLINE' && (!soloDb || d.name === soloDb));
  const salida = [];
  for (const b of bases) {
    let filas;
    try {
      filas = (await pool.request().query(`USE [${b.name.replace(/]/g, ']]')}]; ${POR_TABLA}`)).recordset;
    } catch (e) {
      console.log(`\n${b.name} (compat ${b.compatibility_level}): ⚠ NO MEDIDO — ${e.message}`);
      salida.push({ base: b.name, compat: b.compatibility_level, error: e.message, tablas: [] });
      continue;
    }
    const tablas = filas.map((r) => {
      const tipos = String(r.tipos ?? '').split(',').filter(Boolean).map((x) => {
        const [nombre, tipo] = x.split(':');
        return { nombre, tipo: String(tipo ?? '') };
      });
      const pesadas = tipos.filter((x) => PESADOS.has(x.tipo.replace('(max)', '')) || x.tipo.endsWith('(max)'))
        .map((x) => `${x.nombre}:${x.tipo}`);
      return {
        tabla: `${r.esquema}.${r.tabla}`, filas: Number(r.filas) || 0, kb: Number(r.kb) || 0,
        pk: r.pk || null, marca: marcaDe(tipos), columnas: Number(r.columnas) || 0, pesadas,
      };
    });
    const conDatos = tablas.filter((t) => t.filas > 0);
    const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
    console.log(`\n${b.name} (compat ${b.compatibility_level}): ${tablas.length} tablas · ${conDatos.length} con datos`
      + ` · ${sum(conDatos, (t) => t.filas).toLocaleString('es-MX')} filas · ${(sum(tablas, (t) => t.kb) / 1024).toFixed(0)} MB`);
    console.log(`  con datos: con llave primaria ${conDatos.filter((t) => t.pk).length} · con marca de cambio ${conDatos.filter((t) => t.marca).length}`
      + ` · con columnas pesadas ${conDatos.filter((t) => t.pesadas.length).length}`);
    const sinPk = conDatos.filter((t) => !t.pk);
    if (sinPk.length) {
      console.log(`  ⚠ con datos y SIN llave primaria (${sinPk.length}): `
        + sinPk.sort((x, y) => y.filas - x.filas).slice(0, 12).map((t) => `${t.tabla} (${t.filas})`).join(', ')
        + (sinPk.length > 12 ? ` y ${sinPk.length - 12} más` : ''));
    }
    for (const t of conDatos.sort((x, y) => y.kb - x.kb).slice(0, 20)) {
      console.log(`  ${t.tabla.padEnd(42)} ${String(t.filas).padStart(10)} filas ${String(Math.round(t.kb / 1024)).padStart(6)} MB`
        + `  pk=${t.pk ?? '—'}  marca=${t.marca ?? '—'}${t.pesadas.length ? `  pesadas=${t.pesadas.join(' ')}` : ''}`);
    }
    salida.push({ base: b.name, compat: b.compatibility_level, tablas });
  }

  if (process.argv.includes('--directorio')) {
    try {
      const d = (await pool.request().query('SELECT * FROM DB_Directory.dbo.DatabaseDirectory')).recordset;
      console.log('\nDB_Directory.dbo.DatabaseDirectory (de quién es cada repositorio del ADD):');
      for (const r of d) {
        console.log('  ' + Object.entries(r).filter(([, v]) => v != null && String(v).length < 200)
          .map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : v}`).join(' · '));
      }
    } catch (e) {
      console.log(`\nDatabaseDirectory: ⚠ NO MEDIDO — ${e.message}`);
    }
  }

  const json = arg('json', null);
  if (json) { fs.writeFileSync(json, JSON.stringify({ medido: new Date().toISOString(), bases: salida }, null, 1)); console.log(`\n→ ${json}`); }
  await pool.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
