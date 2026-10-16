'use strict';
/**
 * `[CAT-COSTO.9]` Candado de la historia por día de los costos de Kepler
 * (`analytics.mv_kepler_costos_cambios` + `analytics.kepler_costo_estandar_foto`).
 *
 *   node database/tests/test-newdb-kepler-costos-historia.js
 *
 * Sólo lee.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 *  1. **El costo de HOY que sale de la historia = el de `mv_kepler_costos`**, que lo calcula por
 *     otro camino (la última fila, no intervalos). Último: todas; promedio: ≥ 99.9 % dentro del
 *     redondeo a 4 decimales (medido 29,899 / 29,901).
 *  2. **Una fecha PASADA, recalculada en JS desde las tablas crudas** (XA2001 y kardex) para una
 *     muestra: el costo vigente ese día tiene que coincidir. Es lo que el selector ‹ día › publica.
 *  3. **Las vigencias no se enciman**: por tipo × sucursal × producto, `desde < hasta` y sin
 *     repetidos. Un hueco o un traslape haría que un día tuviera dos costos o ninguno.
 *  4. **El estándar de hoy = la ficha** (`kdii.c77`) donde ya hay foto.
 *  5. **El último costo sale SÓLO de compras**: su `referencia` es una XA2001.
 *
 * Si la matview no está poblada, se ejerce el cuerpo de la migración y se DECLARA lo que sólo la
 * matview puede decir.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { resolveReadTarget } = require('./_lib/assert-safe-target');
const { url } = resolveReadTarget('test-newdb-kepler-costos-historia');
const knex = require('knex')({ client: 'pg', connection: { connectionString: url, statement_timeout: 300000 }, pool: { min: 0, max: 2 } });
const MIG = require(path.resolve(__dirname, '..', 'migrations-newdb', '20261015214044_kepler_costos_historia.js'));
const MIG6 = require(path.resolve(__dirname, '..', 'migrations-newdb', '20261015115146_mv_kepler_costos.js'));

let ok = 0;
let bad = 0;
let nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok += 1; console.log(`  ✔ ${name}`); }
  else { bad += 1; console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};
const noMedido = (name, porque) => { nm += 1; console.log(`  ○ NO MEDIDO: ${name} — ${porque}`); };
const num = (v) => (v === null || v === undefined ? null : Number(String(v).replace(/[^0-9.-]/g, '')) || null);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

(async () => {
  console.log('\n=== [CAT-COSTO.9] Historia por día de los costos de Kepler ===\n');
  const { rows: [meta] } = await knex.raw(`
    SELECT to_regclass('analytics.mv_kepler_costos_cambios') AS mv,
           (SELECT relispopulated FROM pg_class WHERE oid = to_regclass('analytics.mv_kepler_costos_cambios')) AS poblada,
           to_regclass('analytics.kepler_costo_estandar_foto') AS foto,
           to_regclass('analytics.mv_kepler_costos') AS mv6,
           (SELECT relispopulated FROM pg_class WHERE oid = to_regclass('analytics.mv_kepler_costos')) AS mv6_poblada,
           to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS hoy`);
  const usaMv = !!(meta.mv && meta.poblada);
  console.log(usaMv ? '  ⓘ se mide la matview aplicada' : '  ⓘ la matview no está poblada: se ejerce el cuerpo de la migración');
  const fuente = usaMv ? 'analytics.mv_kepler_costos_cambios' : `(${MIG._cuerpo(!!meta.foto)})`;
  const fuente6 = meta.mv6 && meta.mv6_poblada ? 'analytics.mv_kepler_costos' : `(${MIG6._cuerpo()})`;
  const hoy = meta.hoy;

  const { rows: hist } = await knex.raw(`
    SELECT sucursal, sku, tipo, to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta,
           costo, fuente, referencia FROM ${fuente} h`);
  if (!hist.length) {
    noMedido('todo', 'esta base no tiene datos de Kepler');
    console.log(`\n${ok} ✔ · ${bad} ✗ · ${nm} no medido\n`);
    await knex.destroy();
    process.exit(0);
  }
  console.log(`  ⓘ ${hist.length} puntos de cambio`);
  const porClave = new Map();
  for (const h of hist) {
    const k = `${h.tipo}|${h.sucursal}|${h.sku}`;
    (porClave.get(k) || porClave.set(k, []).get(k)).push(h);
  }
  for (const l of porClave.values()) l.sort((a, b) => a.desde.localeCompare(b.desde));
  const vigente = (tipo, suc, sku, d) => {
    const l = porClave.get(`${tipo}|${suc}|${sku}`) || [];
    const f = l.find((h) => h.desde <= d && (h.hasta === null || h.hasta > d));
    return f ? num(f.costo) : null;
  };

  // ── 1. Hoy, contra mv_kepler_costos ───────────────────────────────────────────────────────
  console.log('\n── 1. El costo de hoy que sale de la historia = mv_kepler_costos ──');
  const { rows: hoyM } = await knex.raw(`
    SELECT sucursal, sku, costo_ultimo, ultimo_origen, costo_promedio FROM ${fuente6} m`);
  let nu = 0, iu = 0, np = 0, ip = 0;
  const difU = [];
  for (const m of hoyM) {
    if (m.ultimo_origen === 'propia' && m.costo_ultimo !== null) {
      nu++;
      const h = vigente('ultimo', m.sucursal, m.sku, hoy);
      if (h !== null && Math.abs(h - num(m.costo_ultimo)) <= 0.000002) iu++; else if (difU.length < 3) difU.push({ m, h });
    }
    if (m.costo_promedio !== null) {
      np++;
      const h = vigente('promedio', m.sucursal, m.sku, hoy);
      if (h !== null && Math.abs(h - Math.round(num(m.costo_promedio) * 1e4) / 1e4) <= 0.00005) ip++;
    }
  }
  t(`último: ${iu} de ${nu} iguales`, nu > 0 && iu === nu, difU);
  t(`promedio: ${ip} de ${np} iguales al redondeo de 4 decimales (≥ 99.9 %)`, np > 0 && ip / np >= 0.999, { ip, np });

  // ── 2. Una fecha pasada, recalculada en JS ────────────────────────────────────────────────
  console.log('\n── 2. Una fecha pasada, recalculada desde las tablas crudas ──');
  const candidatos = [...porClave.entries()].filter(([k, l]) => k.startsWith('ultimo|') && l.length >= 3);
  const muestra = candidatos.sort((a, b) => a[0].localeCompare(b[0])).filter((_, i) => i % Math.max(1, Math.floor(candidatos.length / 8)) === 0).slice(0, 8);
  if (!muestra.length) noMedido('fecha pasada', 'ningún producto con 3 o más compras');
  for (const [k, l] of muestra) {
    const [, suc, sku] = k.split('|');
    // El día anterior a la penúltima compra: vigente = la antepenúltima.
    const d = new Date(Date.parse(l[l.length - 2].desde) - 86400000).toISOString().slice(0, 10);
    const { rows: crudas } = await knex.raw(`
      SELECT h.c68::date::text AS fecha, btrim(h.c6::text) AS folio, upper(btrim(l.c11)) AS unidad, l.c9, l.c13,
             btrim(h.c43::text) AS c43, btrim(h.c1::text) AS alm, btrim(l.c5::text) AS serie
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                              AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
       WHERE h.sucursal = ? AND btrim(l.c8) = ? AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'`, [suc, sku]);
    const { rows: [f] } = await knex.raw(
      `SELECT upper(btrim(c11)) u1, upper(btrim(c80)) u2, c81 f2, upper(btrim(c83)) u3, c84 f3 FROM kepler_ods.kdii WHERE btrim(sucursal) = ? AND btrim(c1) = ?`, [suc, sku]);
    const fac = (u) => (u === f.u1 ? 1 : u === f.u2 && num(f.f2) > 0 ? num(f.f2) : u === f.u3 && num(f.f3) > 0 ? num(f.f3) : null);
    const val = crudas.filter((r) => r.alm === suc && (r.c43 || '') !== 'C' && r.serie === '1' && r.fecha <= d && num(r.c9) > 0 && num(r.c13) > 0);
    const docs = {};
    for (const r of val) { const kk = `${r.fecha}|${r.folio}|${r.unidad}`; docs[kk] = docs[kk] || { ...r, imp: 0, q: 0 }; docs[kk].imp += num(r.c13); docs[kk].q += num(r.c9); }
    const u = Object.values(docs).sort((a, b) => (b.fecha + b.folio).localeCompare(a.fecha + a.folio))[0];
    const js = u && fac(u.unidad) ? u.imp / u.q / fac(u.unidad) : null;
    const h = vigente('ultimo', suc, sku, d);
    t(`ÚLTIMO ${suc}/${sku} al ${d}: historia ${h} = recálculo ${js && js.toFixed(6)}`, js !== null && h !== null && Math.abs(h - js) <= 0.000002, { h, js, u });
  }
  const candP = [...porClave.entries()].filter(([k, l]) => k.startsWith('promedio|') && l.length >= 3);
  const muestraP = candP.sort((a, b) => a[0].localeCompare(b[0])).filter((_, i) => i % Math.max(1, Math.floor(candP.length / 6)) === 0).slice(0, 6);
  for (const [k, l] of muestraP) {
    const [, suc, sku] = k.split('|');
    const d = l[l.length - 2].desde; // el día de un cambio: vigente = ese mismo valor
    const { rows: sal } = await knex.raw(`
      SELECT c10::date::text f, upper(btrim(c12)) u, c11::float q, c13::float imp FROM kepler_ods.kdij
       WHERE sucursal = ? AND btrim(c1) = sucursal AND c2 = 1 AND btrim(c3) = ? AND c30 = 'S' AND c11 > 0 AND c13 > 0
         AND c10::date = ?::date`, [suc, sku, d]);
    const { rows: [f] } = await knex.raw(
      `SELECT upper(btrim(c11)) u1, upper(btrim(c80)) u2, c81 f2, upper(btrim(c83)) u3, c84 f3 FROM kepler_ods.kdii WHERE btrim(sucursal) = ? AND btrim(c1) = ?`, [suc, sku]);
    const fac = (u) => (u === f.u1 ? 1 : u === f.u2 && num(f.f2) > 0 ? num(f.f2) : u === f.u3 && num(f.f3) > 0 ? num(f.f3) : null);
    const porU = {};
    for (const r of sal) { porU[r.u] = porU[r.u] || { u: r.u, q: 0, imp: 0 }; porU[r.u].q += r.q; porU[r.u].imp += r.imp; }
    const dom = Object.values(porU).sort((a, b) => b.q - a.q)[0];
    const js = dom && fac(dom.u) ? Math.round((dom.imp / dom.q / fac(dom.u)) * 1e4) / 1e4 : null;
    const h = vigente('promedio', suc, sku, d);
    t(`PROMEDIO ${suc}/${sku} al ${d}: historia ${h} = recálculo ${js}`, js !== null && h !== null && Math.abs(h - js) <= 0.00005, { h, js, dom });
  }

  // ── 3. Vigencias ──────────────────────────────────────────────────────────────────────────
  console.log('\n── 3. Las vigencias no se enciman ──');
  let mal = 0;
  const ejemplos = [];
  for (const [k, l] of porClave) {
    for (let i = 0; i < l.length; i++) {
      const h = l[i];
      const sig = l[i + 1];
      if ((h.hasta !== null && h.hasta <= h.desde) || (sig && h.hasta !== sig.desde) || (!sig && h.hasta !== null)) {
        mal++; if (ejemplos.length < 3) ejemplos.push({ k, h, sig });
      }
    }
  }
  t(`ningún intervalo vacío, encimado ni con hueco (${porClave.size} series)`, mal === 0, ejemplos);

  // ── 4. El estándar de hoy = la ficha ──────────────────────────────────────────────────────
  console.log('\n── 4. El estándar de hoy es el de la ficha ──');
  if (!meta.foto) {
    noMedido('estándar = ficha', 'la foto de la ficha no existe en esta base');
  } else {
    const { rows: fichas } = await knex.raw(`
      SELECT btrim(k.sucursal) sucursal, btrim(k.c1) sku, round(NULLIF(regexp_replace(k.c77::text,'[^0-9.-]','','g'),'')::numeric, 4) c77
        FROM kepler_ods.kdii k
        JOIN analytics.kepler_costo_estandar_foto p ON p.sucursal = btrim(k.sucursal) AND p.sku = btrim(k.c1)
       WHERE btrim(k.sucursal) BETWEEN '00' AND '08'
       GROUP BY 1, 2, 3`);
    let n = 0, i = 0;
    for (const r of fichas) { if (!(num(r.c77) > 0)) continue; n++; const h = vigente('estandar', r.sucursal, r.sku, hoy); if (h !== null && Math.abs(h - num(r.c77)) <= 0.00005) i++; }
    if (!usaMv) noMedido('estándar = ficha', 'sólo con la matview poblada después de la foto');
    else t(`estándar de hoy = kdii.c77 en ${i} de ${n} fichas con foto (≥ 99 %)`, n > 0 && i / n >= 0.99, { i, n });
  }

  // ── 5. El último costo sale SÓLO de compras ───────────────────────────────────────────────
  console.log('\n── 5. El último costo sale sólo de compras ──');
  const ult = hist.filter((h) => h.tipo === 'ultimo');
  t(`los ${ult.length} puntos de último costo tienen referencia XA2001`, ult.length > 0 && ult.every((h) => /^XA2001-/.test(h.referencia || '') && h.fuente === 'xa2001'));

  console.log(`\n${ok} ✔ · ${bad} ✗ · ${nm} no medido\n`);
  await knex.destroy();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
