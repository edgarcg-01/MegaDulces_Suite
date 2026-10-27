#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[LE.0.5]` — Las métricas de la Fase LE (libro de efectivo de partida doble), SÓLO LECTURA.
 *
 * Una cifra de la fase no se cita si no sale de aquí: misma definición antes y después, dicha en la
 * salida (regla 15: el antes/después de un número se mide con el mismo instrumento).
 *
 *   (a) depósitos de CAOS explicados más de una vez (libro + reparto automático `CG.58`, ambos vivos)
 *   (b) cortes con un esperado que no se puede ir a contar: esperado < 0, o |diferencia| > $100,000
 *   (c) cortes autorizados por una persona distinta de quien lo abrió Y de quien lo cerró
 *   (d) diferencias sin explicar en el cierre diario contra testigos — NO MEDIDO: ese cierre no existe
 *       todavía (LE.5.2); se declara, no se dibuja como cero
 *   (e) dinero a cargo de una persona sin rendir: custodias de retiros de CAOS abiertas, con su
 *       antigüedad. Los cobros de ruta por rendir: NO MEDIDO hasta el emparejador por llave (LE.2.5)
 *   + control: morralla TECLEADA contra lo contado por pieza (B16), por corte
 *
 * ⚠️ (b) es la definición de este script. La cifra «7 de 13» del plan v1 se midió a mano con otra
 *    (incluía «piernas cruzadas»); desde aquí manda ésta y la salida lo dice.
 * ⚠️ (c) compara USUARIOS, no empleados (B43): mientras no exista el vínculo usuario → empleado,
 *    dos usuarios de la misma persona contarían como dos. La salida lo declara.
 *
 * Contra prod verifica `system_identifier` y abre la transacción READ ONLY con UNA conexión.
 *
 * Uso:
 *   node database/scripts/le-metricas.js               # pg-prod (PROD_DB_URL del .env)
 *   node database/scripts/le-metricas.js --url <url>   # otra base (sólo lectura igual)
 *   node database/scripts/le-metricas.js --json        # salida para guardar el antes/después
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const PROD_ID = '7688376744939610156';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const UMBRAL_B = 100000;

function argumentos(argv) {
  const o = { url: process.env.PROD_DB_URL || '', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') o.url = argv[++i];
    else if (argv[i] === '--json') o.json = true;
    else { console.error(`Argumento desconocido: ${argv[i]}`); process.exit(2); }
  }
  if (!o.url) { console.error('Sin URL: fijá PROD_DB_URL o pasá --url.'); process.exit(2); }
  return o;
}

/** (a) La misma regla que `finance.caos_deposito_en_libro()`, en línea: vale antes de aplicar LE.0.0. */
const SQL_A = `
  WITH en_libro AS (
    SELECT k.caos_device AS device, k.caos_external_id AS ext
      FROM finance.caos_cash_links k JOIN finance.cash_ledger l ON l.id = k.cash_ledger_id
     WHERE k.deleted_at IS NULL AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
    UNION
    SELECT split_part(l.origen_ref, '|', 1), split_part(l.origen_ref, '|', 2)::bigint
      FROM finance.cash_ledger l
     WHERE l.origen_tipo = 'caos' AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       AND l.origen_ref ~ '^[^|]+[|][0-9]+$')
  SELECT count(DISTINCT (a.caos_device, a.caos_external_id))::int AS depositos,
         count(*)::int AS atribuciones,
         coalesce(sum(a.monto), 0)::numeric(18,2)::text AS monto
    FROM finance.caos_ingreso_atribucion a
    JOIN en_libro e ON e.device = a.caos_device AND e.ext = a.caos_external_id
   WHERE a.deleted_at IS NULL`;

const SQL_B = `
  SELECT count(*)::int AS cortes,
         count(*) FILTER (WHERE esperado < 0 OR abs(coalesce(diferencia, 0)) > $1)::int AS no_contables,
         coalesce(json_agg(json_build_object('folio', folio, 'fecha', fecha::text, 'estado', estado,
                    'esperado', esperado::text, 'diferencia', diferencia::text) ORDER BY fecha)
                  FILTER (WHERE esperado < 0 OR abs(coalesce(diferencia, 0)) > $1), '[]') AS detalle
    FROM finance.cash_ledger_cuts`;

const SQL_C = `
  SELECT count(*) FILTER (WHERE estado <> 'borrador')::int AS cerrados,
         count(*) FILTER (WHERE estado = 'autorizado')::int AS autorizados,
         count(*) FILTER (WHERE estado = 'autorizado' AND authorized_by IS NOT NULL
                            AND authorized_by IS DISTINCT FROM created_by
                            AND authorized_by IS DISTINCT FROM closed_by)::int AS autorizados_por_otro
    FROM finance.cash_ledger_cuts`;

const SQL_MORRALLA = `
  SELECT folio, fecha::text, contado::text, morralla::text,
         CASE WHEN contado > 0 THEN round(100 * morralla / contado, 1) END::text AS pct
    FROM finance.cash_ledger_cuts
   WHERE contado IS NOT NULL ORDER BY fecha`;

const SQL_E = `
  SELECT count(*)::int AS abiertas, coalesce(sum(m.total), 0)::numeric(18,2)::text AS monto,
         coalesce(max(current_date - m.occurred_at::date), 0)::int AS dias_max,
         count(*) FILTER (WHERE current_date - m.occurred_at::date > 1)::int AS mas_de_un_dia,
         coalesce(sum(m.total) FILTER (WHERE current_date - m.occurred_at::date > 1), 0)::numeric(18,2)::text AS monto_mas_de_un_dia
    FROM finance.caos_retiro_custodia c
    JOIN analytics.caos_cash_movements m
      ON m.tenant_id = c.tenant_id AND m.device = c.caos_device AND m.external_id = c.caos_external_id
   WHERE c.deleted_at IS NULL AND c.cierre_tipo IS NULL AND c.destino = 'custodia'`;

const SQL_FRESCURA = `
  SELECT max(synced_at)::text AS caos_ultimo_sync, max(occurred_at)::text AS caos_ultimo_movimiento
    FROM analytics.caos_cash_movements`;

async function main() {
  const o = argumentos(process.argv.slice(2));
  const c = new Client({ connectionString: o.url });
  await c.connect();
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const base = (await q(`SELECT system_identifier::text AS id FROM pg_control_system()`))[0].id;
    const esProd = base === PROD_ID;
    if (o.url === process.env.PROD_DB_URL && !esProd) {
      throw new Error(`PROD_DB_URL no es pg-prod (system_identifier ${base}): no se publica nada`);
    }
    await q(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const hay = async (t) => (await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t]))[0].ok;

    const r = {
      medido_en: (await q(`SELECT now()::text AS t`))[0].t,
      base: esProd ? `pg-prod ${base}` : `NO es prod (${base})`,
      frescura: (await hay('analytics.caos_cash_movements')) ? (await q(SQL_FRESCURA))[0] : 'NO MEDIDO: sin feed de CAOS',
      a: (await hay('finance.caos_ingreso_atribucion')) ? (await q(SQL_A))[0] : 'NO MEDIDO: sin la tabla del reparto',
      b: { definicion: `esperado < 0 o |diferencia| > $${UMBRAL_B.toLocaleString('es-MX')}`, ...(await q(SQL_B, [UMBRAL_B]))[0] },
      c: { nota: 'compara usuarios, no empleados (B43: falta el vínculo usuario → empleado)', ...(await q(SQL_C))[0] },
      d: 'NO MEDIDO: el cierre diario contra testigos no existe todavía (LE.5.2)',
      e: {
        custodias: (await hay('finance.caos_retiro_custodia')) ? (await q(SQL_E))[0] : 'NO MEDIDO: sin la tabla de custodia',
        cobros_por_rendir: 'NO MEDIDO: requiere el emparejador por llave (LE.2.5)',
      },
      morralla_tecleada: await q(SQL_MORRALLA),
    };

    if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`\n[LE.0.5] Métricas de la Fase LE — ${r.base} — ${r.medido_en}`);
    console.log('frescura:', JSON.stringify(r.frescura));
    console.log('\n(a) depósitos explicados más de una vez:', r.a);
    console.log(`\n(b) cortes no contables (${r.b.definicion}): ${r.b.no_contables} de ${r.b.cortes}`);
    for (const d of r.b.detalle) console.log('    ', JSON.stringify(d));
    console.log(`\n(c) cortes autorizados por otra persona: ${r.c.autorizados_por_otro} (autorizados ${r.c.autorizados}, cerrados ${r.c.cerrados}) — ${r.c.nota}`);
    console.log(`\n(d) ${r.d}`);
    console.log('\n(e) custodias abiertas:', r.e.custodias);
    console.log('    cobros de ruta por rendir:', r.e.cobros_por_rendir);
    console.log('\n(control B16) morralla tecleada por corte:');
    for (const m of r.morralla_tecleada) console.log('    ', JSON.stringify(m));
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
