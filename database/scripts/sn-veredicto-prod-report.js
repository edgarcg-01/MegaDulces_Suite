'use strict';
/* eslint-disable no-console */
/**
 * `[SN.29]` — Qué va a decir «Mi trabajo» con datos REALES, usando la función real.
 *
 * READ-ONLY contra PROD. Corre por cada bandeja la MISMA forma de consulta que `medirCola` emite
 * (los cinco contadores en una pasada con `FILTER`) y le pasa el resultado a `veredictoDe` — la
 * de `libs/contracts`, transpilada al vuelo, **no una copia**: una copia probaría que dos
 * implementaciones coinciden, no que la de producción acierta.
 *
 * ⛔ `DATABASE_URL_NEW` del `.env` apunta a la RÉPLICA DE PRUEBAS. Acá se resuelve `FLEET_DB_URL`
 * y se verifica el destino antes de medir, igual que `or-landing-gap-report.js`.
 *
 * Uso:  node database/scripts/sn-veredicto-prod-report.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const ts = require('typescript');

const DST = process.env.FLEET_DB_URL;
if (!DST || !/railway/.test(DST)) {
  console.error('FLEET_DB_URL debe apuntar a PROD (DATABASE_URL_NEW es la réplica de pruebas).');
  process.exit(1);
}

/** Carga `veredictoDe` del contrato transpilando el .ts: la función de producción, no una copia. */
function cargarVeredicto() {
  const p = path.resolve(__dirname, '../../libs/contracts/src/http/identity-me.contract.ts');
  const js = ts.transpileModule(fs.readFileSync(p, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  if (typeof mod.exports.veredictoDe !== 'function') {
    throw new Error('veredictoDe no se exportó del contrato — el reporte no mediría nada');
  }
  return mod.exports;
}

/** Los ejes tal como los declara `BANDEJAS` en `libs/trade/src/lib/users/me-work.ts`. */
const BANDEJAS = [
  { id: 'cuadre',            label: 'Descuadres por revisar',        t: 'reconciliation.discrepancies',      col: 'status', ab: 'nuevo',            cierre: 'updated_at',  umbral: 7 },
  { id: 'maat-acciones',     label: 'Acciones de finanzas',          t: 'finance.proposed_actions',          col: 'estado', ab: 'pending_approval', cierre: 'updated_at',  umbral: 3 },
  { id: 'thot-acciones',     label: 'Acciones comerciales',          t: 'commercial.commercial_actions',     col: 'status', ab: 'pending_approval', cierre: 'updated_at',  umbral: 7 },
  { id: 'compras-hallazgos', label: 'Hallazgos de reabastecimiento', t: 'commercial.replenishment_findings', col: 'status', ab: 'open',             cierre: 'resolved_at', umbral: 2 },
  { id: 'flota-alertas',     label: 'Alertas de flota',              t: 'logistics.fleet_alerts',            col: 'status', ab: 'open',             cierre: 'resolved_at', umbral: 1 },
  { id: 'caducidades-mias',  label: 'Revisiones de caducidad',       t: 'commercial.expiry_reviews',         col: 'status', ab: 'draft',            cierre: 'submitted_at', umbral: 2 },
];

(async () => {
  const { veredictoDe, ORDEN_VEREDICTO } = cargarVeredicto();
  const c = new Client({ connectionString: DST, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("set statement_timeout='30s'");
  console.log(`# base: ${(await c.query('select current_database() d')).rows[0].d}  ·  ${new Date().toISOString()}\n`);

  const filas = [];
  for (const b of BANDEJAS) {
    const cerradas = b.cierre
      ? `count(*) filter (where ${b.col} <> $1 and ${b.cierre} > now()-interval '30 days')::int`
      : 'null::int';
    const r = await c.query(
      `select count(*) filter (where ${b.col} = $1)::int n,
              min(created_at) filter (where ${b.col} = $1) viejo,
              count(*) filter (where ${b.col} = $1 and created_at > now()-interval '7 days')::int e7,
              count(*) filter (where created_at > now()-interval '30 days')::int e30,
              ${cerradas} c30
         from ${b.t}`, [b.ab]);
    const x = r.rows[0];
    const medida = {
      total: x.n,
      mas_viejo_at: x.viejo ? new Date(x.viejo).toISOString() : null,
      flujo: { entradas_7d: x.e7, entradas_30d: x.e30, cerradas_30d: x.c30 },
    };
    filas.push({ ...b, medida, veredicto: veredictoDe(medida, b.umbral) });
  }

  // Mismo orden que `workFor`: por veredicto, y dentro de él lo más viejo arriba.
  filas.sort((a, z) => {
    const d = ORDEN_VEREDICTO[a.veredicto] - ORDEN_VEREDICTO[z.veredicto];
    if (d !== 0) return d;
    return Date.parse(a.medida.mas_viejo_at ?? 0) - Date.parse(z.medida.mas_viejo_at ?? 0);
  });

  console.log('orden  veredicto    abiertos   +7d   ent30   cer30  mas_viejo    bandeja');
  filas.forEach((f, i) => {
    const m = f.medida;
    const c30 = m.flujo.cerradas_30d === null ? 'null' : String(m.flujo.cerradas_30d);
    console.log(
      `${String(i + 1).padStart(4)}.  ${f.veredicto.padEnd(11)} ${String(m.total).padStart(8)}  ${String(m.flujo.entradas_7d).padStart(4)}  ${String(m.flujo.entradas_30d).padStart(6)}  ${c30.padStart(6)}  ${(m.mas_viejo_at ?? '—').slice(0, 10)}   ${f.label}`,
    );
  });

  const congeladas = filas.filter((f) => f.veredicto === 'congelada');
  console.log(`\ncongeladas: ${congeladas.length} (${congeladas.map((f) => f.id).join(', ') || '—'})`);
  await c.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
