/**
 * `[MDT.0.1]` — Censo de MDTask: qué dominios se USAN de verdad.
 *
 * Lee el schema `eajd` (MDTask) de la base de Railway que comparte con Mega Talento y, por cada
 * tabla, cuenta filas y cuántas se escribieron en los últimos 7 y 30 días (por cada columna de
 * fecha que tenga). Con eso se decide qué dominio entra a la migración (FASE_MDT §2, D11, D13).
 *
 * ⛔ SÓLO LECTURA: la sesión se fuerza a `default_transaction_read_only = on` antes de la primera
 * consulta. Nunca imprime la cadena de conexión. Imprime el `system_identifier` para que la cifra
 * diga de qué clúster salió (esa base y la prod vieja de la Suite se llaman igual).
 *
 * Uso:   MT_DATABASE_URL=... node database/scripts/mdt/censo-eajd.js
 *        (acepta también MDTASK_DATABASE_URL)
 *
 * ⚠️ MDTask guarda varias fechas como `bigint` (epoch en ms: `creado_en`, `actualizado_en`) o como
 * texto `YYYY-MM-DD` (`fecha`). Las tres formas se miden; una tabla sin ninguna se declara
 * «sin columna de fecha», nunca se reporta como «sin uso».
 */
const { Client } = require('pg');

const EPOCH_MS = ['creado_en', 'actualizado_en', 'tomado_en', 'completado_en'];

async function main() {
  const url = process.env.MT_DATABASE_URL || process.env.MDTASK_DATABASE_URL;
  if (!url) {
    console.error('Falta MT_DATABASE_URL (o MDTASK_DATABASE_URL).');
    process.exit(2);
  }
  const ssl = /railway\.internal/.test(url) ? undefined : { rejectUnauthorized: false };
  const c = new Client({ connectionString: url, ssl, statement_timeout: 30000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const q = (sql, p) => c.query(sql, p).then((r) => r.rows);

  const [{ sid }] = await q('SELECT system_identifier::text AS sid FROM pg_control_system()');
  const [{ ahora }] = await q('SELECT now()::text AS ahora');
  console.log(`system_identifier=${sid} · medido=${ahora} · sólo lectura`);

  const tablas = await q(
    `SELECT c.relname AS t, pg_total_relation_size(c.oid) AS b
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'eajd' AND c.relkind = 'r' ORDER BY 1`,
  );
  if (!tablas.length) console.log('⚠️ schema eajd sin tablas visibles para este rol (NO MEDIDO, no es «cero»).');

  const filas = [];
  for (const { t, b } of tablas) {
    const cols = await q(
      `SELECT column_name AS col, data_type AS tipo FROM information_schema.columns
        WHERE table_schema = 'eajd' AND table_name = $1`,
      [t],
    );
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM eajd."${t}"`);
    const fila = { tabla: t, filas: n, kb: Math.round(Number(b) / 1024), d7: null, d30: null, ultima: null, por: null };

    // La primera columna de fecha que exista, en orden de preferencia.
    const fecha = cols.find((x) => /timestamp|date/.test(x.tipo))
      || cols.find((x) => EPOCH_MS.includes(x.col) && /bigint|integer|numeric/.test(x.tipo))
      || cols.find((x) => x.col === 'fecha' && /text|char/.test(x.tipo));
    if (fecha) {
      const expr = /timestamp|date/.test(fecha.tipo)
        ? `"${fecha.col}"::timestamptz`
        : EPOCH_MS.includes(fecha.col)
          ? `to_timestamp("${fecha.col}" / 1000.0)`
          : `CASE WHEN "${fecha.col}" ~ '^\\d{4}-\\d{2}-\\d{2}' THEN left("${fecha.col}", 10)::date::timestamptz END`;
      const [r] = await q(
        `SELECT max(${expr})::text AS ultima,
                count(*) FILTER (WHERE ${expr} >= now() - interval '7 days')::int AS d7,
                count(*) FILTER (WHERE ${expr} >= now() - interval '30 days')::int AS d30
           FROM eajd."${t}"`,
      );
      Object.assign(fila, r, { por: fecha.col });
    }
    filas.push(fila);
  }

  console.table(filas.map((f) => ({
    tabla: f.tabla,
    filas: f.filas,
    kb: f.kb,
    '7 días': f.por ? f.d7 : 'sin columna de fecha',
    '30 días': f.por ? f.d30 : '—',
    'última': f.ultima ? f.ultima.slice(0, 16) : '—',
    'medido por': f.por || '—',
  })));
  await c.end();
}

main().catch((e) => {
  console.error('ERROR', e.code || '', String(e.message).slice(0, 300));
  process.exit(1);
});
