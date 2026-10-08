/* eslint-disable no-console */
/**
 * `[GX.73]` ¿CUÁNTOS VALES VE LA SUITE EN UNA FASE ANTERIOR A LA DE KEPLER? — sólo lectura.
 *
 * Reporte del usuario (2026-10-07): *«a los usuarios les tarda mucho cuando el estatus de su vale
 * cambia, aún lo ven en una fase anterior cuando en Kepler ya queda»*. Diagnóstico en
 * `database/importers/lib/ods-open-docs.js`: autorizar en Kepler sólo cambia `kdm1.c43` en el
 * renglón existente, y el carril CTID del ODS salta ese UPDATE cuando la solicitud tiene más de 3
 * días. Este script MIDE el daño antes y después del arreglo — no supone.
 *
 * Por sucursal compara, solicitud por solicitud (`XA1501`), el estado `c43` de la RÉPLICA (Kepler al
 * día por replicación lógica) contra el del ODS de producción (lo que lee la Suite). Reporta:
 *   · cuántas difieren y de qué estado a qué estado (`N→A` = autorizadas que la Suite no ve);
 *   · cuántas de ésas tienen la captura dentro de la ventana de 3 días (deberían ser ~0) y fuera;
 *   · las que faltan en el ODS o sobran en él;
 *   · ⛔ el CANDADO DEL FILTRO: el conteo con igualdad exacta (la que usa el carril y el índice) contra
 *     el del filtro tolerante (`btrim`, el de las vistas). Si no coinciden, los datos traen espacios y
 *     la igualdad exacta se está perdiendo renglones EN SILENCIO — el arreglo no se despliega así.
 *
 * Sólo lee: la conexión a prod abre con `default_transaction_read_only=on`.
 *
 * Uso:
 *   ODS_SOURCE_BASE=postgres://…@md:5433/postgres DATABASE_URL_NEW=postgres://…@md:5434/… \
 *     node database/scripts/medir-frescura-kdm1.js                  # todas las sucursales
 *     node database/scripts/medir-frescura-kdm1.js --branch=00 --muestra=20
 *     node database/scripts/medir-frescura-kdm1.js --json
 *
 * Prueba de la comparación (sin base): node database/tests/test-medir-frescura-kdm1.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { openDocsSql, openDocsSqlTolerante, docTypeSql } = require('../importers/lib/ods-open-docs');

/** Ventana de la red de seguridad del carril (ODS_SAFETY_DAYS): lo de adentro debería estar al día. */
const VENTANA_DIAS = Number(process.env.ODS_SAFETY_DAYS || 3);

/**
 * Compara los estados por folio. PURA: es la parte que decide el número, y se prueba sin base.
 *
 * @param {{folio:string, estado:string|null, captura:string|null}[]} replica  Kepler al día
 * @param {{folio:string, estado:string|null}[]} ods  lo que lee la Suite
 * @param {{ hoy?: string, ventanaDias?: number }} [opts]  `hoy` = AAAA-MM-DD (para la antigüedad)
 */
function compararEstados(replica, ods, opts = {}) {
  const ventana = Number.isFinite(Number(opts.ventanaDias)) ? Number(opts.ventanaDias) : VENTANA_DIAS;
  const hoy = opts.hoy ? new Date(`${opts.hoy}T00:00:00Z`) : null;
  const norm = (v) => (v == null ? null : String(v).trim() || null);
  const enOds = new Map(ods.map((r) => [norm(r.folio), norm(r.estado)]));
  const enRep = new Set();

  const distintos = [];
  const porTransicion = {};
  let iguales = 0, dentroVentana = 0, fueraVentana = 0, sinFecha = 0;
  const faltanEnOds = [];

  for (const r of replica) {
    const folio = norm(r.folio);
    if (!folio) continue;
    enRep.add(folio);
    const estRep = norm(r.estado);
    if (!enOds.has(folio)) { faltanEnOds.push(folio); continue; }
    const estOds = enOds.get(folio);
    if (estRep === estOds) { iguales++; continue; }

    const t = `${estOds ?? '∅'}→${estRep ?? '∅'}`; // lo que dice la Suite → lo que dice Kepler
    porTransicion[t] = (porTransicion[t] || 0) + 1;
    let edad = null;
    if (hoy && r.captura) {
      const f = new Date(`${String(r.captura).slice(0, 10)}T00:00:00Z`);
      if (!Number.isNaN(f.getTime())) edad = Math.round((hoy - f) / 86400000);
    }
    if (edad === null) sinFecha++;
    else if (edad <= ventana) dentroVentana++;
    else fueraVentana++;
    distintos.push({ folio, ods: estOds, kepler: estRep, captura: r.captura ? String(r.captura).slice(0, 10) : null, edad_dias: edad });
  }
  const sobranEnOds = [...enOds.keys()].filter((f) => f && !enRep.has(f));
  // Las más viejas primero: son las que llevan más tiempo mostrando una fase equivocada.
  distintos.sort((a, b) => (b.edad_dias ?? -1) - (a.edad_dias ?? -1));
  return {
    total_replica: enRep.size, iguales, distintos, porTransicion,
    dentroVentana, fueraVentana, sinFecha, faltanEnOds, sobranEnOds,
  };
}

async function main() {
  const { Client } = require('pg');
  const { replicaDbName, BRANCHES } = require('../importers/lib/kepler-branches');
  const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
  const JSON_OUT = process.argv.includes('--json');
  const MUESTRA = Math.max(0, Number(arg('muestra', 10)) || 0);
  const SOLO = arg('branch', null);

  const base = process.env.ODS_SOURCE_BASE;
  const dest = process.env.DATABASE_URL_NEW;
  if (!base || !dest) {
    console.error('Faltan ODS_SOURCE_BASE (réplicas :5433) y/o DATABASE_URL_NEW (prod, sólo lectura).');
    process.exit(2);
  }
  const urlRep = (code) => { const u = new URL(base); u.pathname = `/${replicaDbName(code)}`; return u.toString(); };
  const codes = SOLO ? [SOLO] : BRANCHES.map((b) => b.code);
  const hoy = new Date().toISOString().slice(0, 10);

  const prod = new Client({
    connectionString: dest, ssl: dest.includes('127.0.0.1') || dest.includes('localhost') ? false : { rejectUnauthorized: false },
    statement_timeout: 120000, options: '-c default_transaction_read_only=on',
  });
  await prod.connect();
  const salida = { generado: new Date().toISOString(), ventana_dias: VENTANA_DIAS, sucursales: [] };

  try {
    for (const code of codes) {
      const rep = new Client({ connectionString: urlRep(code), statement_timeout: 120000, options: '-c default_transaction_read_only=on' });
      try { await rep.connect(); } catch (e) {
        salida.sucursales.push({ sucursal: code, medido: false, motivo: `réplica no conecta: ${e.message}` });
        continue;
      }
      try {
        const cols = (await rep.query(`SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema='md' AND table_name='kdm1'`)).rows;
        const clave = docTypeSql('kdm1', cols);
        const abiertasExacto = openDocsSql('kdm1', cols);
        const abiertasTolerante = openDocsSqlTolerante('kdm1', cols);
        if (!clave || !abiertasExacto) {
          salida.sucursales.push({ sucursal: code, medido: false, motivo: 'md.kdm1 sin las columnas c1..c5/c43' });
          continue;
        }
        const replica = (await rep.query(
          `SELECT btrim(c6::text) folio, btrim(c43::text) estado, c68::text captura FROM md.kdm1 WHERE ${clave}`, [code])).rows;
        const nExacto = Number((await rep.query(`SELECT count(*) n FROM md.kdm1 WHERE ${abiertasExacto.sql}`, [code])).rows[0].n);
        const nTolerante = Number((await rep.query(`SELECT count(*) n FROM md.kdm1 WHERE ${abiertasTolerante}`, [code])).rows[0].n);

        const ods = (await prod.query(
          `SELECT btrim(c6::text) folio, btrim(c43::text) estado FROM kepler_ods.kdm1
            WHERE sucursal = $1 AND btrim(c1::text) = $1 AND c2 = 'X' AND c3 = 'A'
              AND btrim(c4::text) = '15' AND btrim(c5::text) = '1'`, [code])).rows;

        const cmp = compararEstados(replica, ods, { hoy });
        salida.sucursales.push({
          sucursal: code, medido: true,
          solicitudes_kepler: cmp.total_replica, iguales: cmp.iguales,
          atrasadas: cmp.distintos.length, por_transicion: cmp.porTransicion,
          atrasadas_dentro_ventana: cmp.dentroVentana, atrasadas_fuera_ventana: cmp.fueraVentana,
          faltan_en_ods: cmp.faltanEnOds.length, sobran_en_ods: cmp.sobranEnOds.length,
          filtro_exacto_vs_tolerante: { exacto: nExacto, tolerante: nTolerante, coincide: nExacto === nTolerante },
          muestra: cmp.distintos.slice(0, MUESTRA),
        });
      } finally { await rep.end(); }
    }
  } finally { await prod.end(); }

  if (JSON_OUT) { console.log(JSON.stringify(salida, null, 2)); return; }

  console.log(`\nFrescura de las solicitudes de gasto (XA1501): réplica (Kepler) vs ODS (Suite) · ${salida.generado}\n`);
  let tot = 0, atr = 0, fuera = 0, filtroMal = 0;
  for (const s of salida.sucursales) {
    if (!s.medido) { console.log(`  ${s.sucursal}  NO MEDIDO — ${s.motivo}`); continue; }
    tot += s.solicitudes_kepler; atr += s.atrasadas; fuera += s.atrasadas_fuera_ventana;
    if (!s.filtro_exacto_vs_tolerante.coincide) filtroMal++;
    const trans = Object.entries(s.por_transicion).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
    console.log(`  ${s.sucursal}  ${s.solicitudes_kepler} solicitudes · ${s.atrasadas} atrasadas (${trans})`
      + ` · ${s.atrasadas_fuera_ventana} fuera de la ventana de ${VENTANA_DIAS}d · faltan ${s.faltan_en_ods} · sobran ${s.sobran_en_ods}`
      + ` · filtro exacto ${s.filtro_exacto_vs_tolerante.exacto} / tolerante ${s.filtro_exacto_vs_tolerante.tolerante}${s.filtro_exacto_vs_tolerante.coincide ? '' : '  ⛔ NO COINCIDEN'}`);
    for (const m of s.muestra) console.log(`        ${m.folio}  Suite ${m.ods ?? '∅'} · Kepler ${m.kepler ?? '∅'} · capturada ${m.captura ?? '?'} (${m.edad_dias ?? '?'} d)`);
  }
  // ⛔ «0 de 0» se lee como «todo al día». Si no se pudo medir, se DICE (ADR-056).
  const medidas = salida.sucursales.filter((s) => s.medido).length;
  const sinMedir = salida.sucursales.length - medidas;
  if (!medidas) {
    console.log('\n  NO MEDIDO — ninguna sucursal se pudo comparar. Esto NO dice que la Suite esté al día.');
    process.exitCode = 3;
    return;
  }
  console.log(`\n  TOTAL: ${atr} de ${tot} solicitudes muestran en la Suite otro estado que en Kepler · ${fuera} fuera de la ventana`
    + (sinMedir ? ` · ⚠️ ${sinMedir} sucursal(es) SIN MEDIR (no entran en el total)` : ''));
  if (filtroMal) console.log(`  ⛔ En ${filtroMal} sucursal(es) el filtro exacto NO ve lo mismo que el tolerante: NO desplegar el carril así.`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}

module.exports = { compararEstados };
