#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.36]` — **La lista acotada de proveedores que faltan, para que compras la confirme.**
 *
 * `[CP.8.35]` resuelve 144 de 216 movimientos de `compra_mercancia` pareando el concepto del
 * banco contra el padrón `2120*`. Los **72 que quedan son $6.8M** y no los resuelve ningún
 * algoritmo: el banco escribe `"Effem Mexico Inc y Compañia"` y ContPAQi tiene otra razón social.
 *
 * ── ⛔ Este script PROPONE. No escribe nada. ────────────────────────────────────────────────
 * Las sugerencias se ordenan por **palabras en común**, y eso es una pista, no un veredicto. La
 * tentación es aplicar la primera automáticamente; sería el mismo error que el resolvedor evita a
 * propósito: una cuenta equivocada **cuadra igual** y nadie la ve hasta la balanza.
 *
 * El alias confirmado se guarda en `contpaqi.supplier_aliases` desde la pantalla, con nombre de
 * quien lo afirmó. Acá sólo sale el trabajo pendiente, ordenado por dinero.
 *
 *   node database/scripts/alias-proveedor-pendientes.js [--mes=2026-01] [--csv=ruta.csv]
 *
 * Solo lectura.
 */
const path = require('path');
const fs = require('fs');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const SRC = path.resolve(__dirname, '../../libs/finance/src/lib/contpaqi');
const { construirIndice, resolverProveedor, normalizarNombre } = require(path.join(SRC, 'proveedor-resolver.ts'));

const arg = (n, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const MES = arg('mes', '2026-01');
const CSV = arg('csv', null);
const MEGA = '00000000-0000-0000-0000-00000000d01c';

const knex = require('knex')({
  client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 3 },
});

/** Palabras en común, normalizadas. Pista para ordenar, NUNCA criterio para aplicar. */
function parecido(a, b) {
  const pa = new Set(normalizarNombre(a).split(' ').filter((w) => w.length > 2));
  const pb = new Set(normalizarNombre(b).split(' ').filter((w) => w.length > 2));
  if (!pa.size || !pb.size) return 0;
  let comunes = 0;
  for (const w of pa) if (pb.has(w)) comunes += 1;
  return comunes / Math.max(pa.size, pb.size);
}

(async () => {
  const padron = await knex('contpaqi.supplier_accounts').where({ tenant_id: MEGA })
    .select('cuenta', 'proveedor_nombre', 'cuenta_nombre', 'veredicto', 'rfc');
  let alias = [];
  try {
    alias = await knex('contpaqi.supplier_aliases').where({ tenant_id: MEGA, active: true })
      .select('alias_normalizado', 'cuenta');
  } catch { /* la tabla puede no existir todavía en este destino */ }
  const idx = construirIndice(padron, '2120', alias);

  const movs = await knex('finance.bank_movements as m')
    .join('finance.movement_categories as c', 'c.id', 'm.category_id')
    .join('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
    .select('m.concept', 'm.amount_out')
    .where('m.tenant_id', MEGA).whereNull('m.deleted_at').where('m.amount_out', '>', 0)
    .where('c.code', 'compra_mercancia').whereNotNull('ba.contpaqi_cuenta')
    .whereRaw(`to_char(m.movement_date,'YYYY-MM') = ?`, [MES]);

  // Agrupado por nombre: compras confirma UN alias, no 12 movimientos.
  const pend = new Map();
  let resueltos = 0; let impResuelto = 0;
  for (const m of movs) {
    const r = resolverProveedor(idx, m.concept);
    if (r.veredicto === 'resuelto') { resueltos += 1; impResuelto += Number(m.amount_out); continue; }
    const k = normalizarNombre(m.concept) || '(sin concepto)';
    const y = pend.get(k) ?? { norm: k, texto: m.concept, movs: 0, importe: 0, veredicto: r.veredicto, motivo: r.motivo };
    y.movs += 1;
    y.importe += Number(m.amount_out);
    pend.set(k, y);
  }

  const filas = [...pend.values()].sort((a, b) => b.importe - a.importe);
  const totalPend = filas.reduce((a, f) => a + f.importe, 0);

  console.log(`\n[CP.8.36] alias de proveedor pendientes · ${MES}`);
  console.log(`  resuelto : ${resueltos} movs · $${Math.round(impResuelto).toLocaleString('es-MX')}`);
  console.log(`  PENDIENTE: ${movs.length - resueltos} movs en ${filas.length} nombres · `
    + `$${Math.round(totalPend).toLocaleString('es-MX')}`);
  console.log(`  alias ya confirmados: ${alias.length}\n`);

  const salida = [];
  for (const f of filas) {
    const sug = padron
      .filter((p) => String(p.cuenta).startsWith('2120'))
      .map((p) => ({ p, s: Math.max(parecido(f.texto, p.proveedor_nombre), parecido(f.texto, p.cuenta_nombre)) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    console.log(`$${Math.round(f.importe).toLocaleString('es-MX').padStart(12)}  ${String(f.movs).padStart(3)} movs  `
      + `[${f.veredicto}]  "${f.texto}"`);
    if (!sug.length) console.log('      sin candidato parecido — hay que buscarlo en ContPAQi');
    for (const s of sug) {
      console.log(`      ¿${s.p.cuenta}  ${String(s.p.proveedor_nombre ?? s.p.cuenta_nombre).slice(0, 44)}`
        + `  (${(s.s * 100).toFixed(0)}% de palabras en común, ${s.p.veredicto})`);
    }
    salida.push({
      concepto_banco: f.texto, alias_normalizado: f.norm, movimientos: f.movs,
      importe: Math.round(f.importe), veredicto: f.veredicto,
      sugerencia_1: sug[0] ? sug[0].p.cuenta : '', sugerencia_1_nombre: sug[0] ? sug[0].p.proveedor_nombre : '',
    });
  }

  if (CSV) {
    const cab = Object.keys(salida[0] ?? { concepto_banco: '' }).join(',');
    const cuerpo = salida.map((r) => Object.values(r).map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    fs.writeFileSync(CSV, [cab, ...cuerpo].join('\n'), 'utf8');
    console.log(`\nCSV: ${CSV}`);
  }
  console.log('\n⛔ Las sugerencias son pistas por palabras en común. Confirma una PERSONA; '
    + 'una cuenta equivocada cuadra igual y no se ve hasta la balanza.\n');
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
