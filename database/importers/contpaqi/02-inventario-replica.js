/* eslint-disable no-console */
/**
 * `[CP.9.0]` — **Inventario para replicar ContPAQi entero.** SÓLO LEE el catálogo de SQL Server (`sys.*`): no toca
 * ninguna tabla de datos, no escribe en ninguna base, no cambia nada en el servidor de contabilidad.
 *
 * Contesta lo que decide CÓMO se replica cada tabla, que `FASE_CP9` no midió:
 *   - filas y tamaño (la carga inicial y su ventana);
 *   - llave primaria (sin ella no se puede reconciliar renglón a renglón);
 *   - columna `RowVersion` (token de cambio por fila: con ella se detecta qué cambió sin traer el renglón);
 *   - columnas binarias o de texto largo (`image`, `varbinary(max)`, `ntext`…): los documentos del ADD pesan GB;
 *   - tipos que no tienen equivalente directo en Postgres.
 *
 * Corre en una máquina de la LAN que alcance la instancia `COMPAC` (por ejemplo `md`):
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/importers/contpaqi/02-inventario-replica.js [--db=ctLUIS_…] [--json=salida.json]
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

// Por tabla: filas, tamaño, llave primaria, RowVersion y los tipos de sus columnas. Todo de `sys.*`.
const POR_TABLA = `
SELECT s.name AS esquema, t.name AS tabla,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS filas,
       (SELECT SUM(a.total_pages) * 8 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id
         WHERE p.object_id = t.object_id) AS kb,
       (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal)
          FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
          JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = t.object_id AND i.is_primary_key = 1) AS pk,
       (SELECT TOP 1 ty.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = t.object_id AND c.name = 'RowVersion') AS rowversion_tipo,
       (SELECT TOP 1 c.name FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.object_id = t.object_id AND ty.name IN ('timestamp', 'rowversion')) AS col_timestamp,
       (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = t.object_id) AS columnas,
       (SELECT STRING_AGG(CONCAT(c.name, ':', ty.name, CASE WHEN c.max_length = -1 THEN '(max)' ELSE '' END), ',')
          FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE c.object_id = t.object_id) AS tipos
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE t.is_ms_shipped = 0`;

(async () => {
  const pool = await sql.connect(CFG);
  const soloDb = arg('db', null);
  const bases = (await pool.request().query(`SELECT name, state_desc FROM sys.databases ORDER BY name`)).recordset
    .filter((d) => !SISTEMA.has(d.name) && d.state_desc === 'ONLINE' && (!soloDb || d.name === soloDb));
  const salida = [];
  for (const b of bases) {
    let filas;
    try {
      filas = (await pool.request().query(`USE [${b.name.replace(/]/g, ']]')}]; ${POR_TABLA}`)).recordset;
    } catch (e) {
      console.log(`\n${b.name}: ⚠ NO MEDIDO — ${e.message}`);
      salida.push({ base: b.name, error: e.message, tablas: [] });
      continue;
    }
    const tablas = filas.map((r) => {
      const tipos = String(r.tipos ?? '').split(',').filter(Boolean);
      const pesadas = tipos.filter((x) => PESADOS.has(x.split(':')[1].replace('(max)', '')) || x.endsWith('(max)'));
      return {
        tabla: `${r.esquema}.${r.tabla}`, filas: Number(r.filas) || 0, kb: Number(r.kb) || 0,
        pk: r.pk || null, rowversion: r.rowversion_tipo || null, timestamp: r.col_timestamp || null,
        columnas: Number(r.columnas) || 0, pesadas,
      };
    });
    const conDatos = tablas.filter((t) => t.filas > 0);
    const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
    console.log(`\n${b.name}: ${tablas.length} tablas · ${conDatos.length} con datos · ${sum(conDatos, (t) => t.filas).toLocaleString('es-MX')} filas`
      + ` · ${(sum(tablas, (t) => t.kb) / 1024).toFixed(0)} MB`);
    console.log(`  con datos: con llave primaria ${conDatos.filter((t) => t.pk).length} · con RowVersion ${conDatos.filter((t) => t.rowversion).length}`
      + ` · con columna timestamp ${conDatos.filter((t) => t.timestamp).length} · con columnas pesadas ${conDatos.filter((t) => t.pesadas.length).length}`);
    const sinPk = conDatos.filter((t) => !t.pk);
    if (sinPk.length) console.log(`  ⚠ con datos y SIN llave primaria: ${sinPk.map((t) => `${t.tabla} (${t.filas})`).join(', ')}`);
    for (const t of conDatos.sort((x, y) => y.kb - x.kb).slice(0, 15)) {
      console.log(`  ${t.tabla.padEnd(42)} ${String(t.filas).padStart(10)} filas ${String(Math.round(t.kb / 1024)).padStart(6)} MB`
        + `  pk=${t.pk ?? '—'}  rv=${t.rowversion ?? '—'}${t.pesadas.length ? `  pesadas=${t.pesadas.join(' ')}` : ''}`);
    }
    salida.push({ base: b.name, tablas });
  }
  const json = arg('json', null);
  if (json) { fs.writeFileSync(json, JSON.stringify({ medido: new Date().toISOString(), bases: salida }, null, 1)); console.log(`\n→ ${json}`); }
  await pool.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
