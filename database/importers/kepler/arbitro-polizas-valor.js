/* eslint-disable no-console */
/**
 * `[OPS-AUD.13.4]` ÁRBITRO DE PÓLIZAS POR VALOR — el ODS contra la réplica de Kepler, renglón por
 * renglón, con su IMPORTE. Alarma en Salud BD (`analytics.cron_runs`, llave `arbitro_polizas_valor`).
 *
 * POR QUÉ EXISTE
 * --------------
 * Todo lo que vigilaba las pólizas comparaba LLAVES: el reconciliador (`reconcile-ods-window.js`),
 * el dedup por fecha, el árbitro de los triggers del reporte (`gl_polizas_kepler_drift`, que compara
 * el reporte contra el ODS — no el ODS contra Kepler). Ninguno miraba el importe.
 *
 * Medido el 2026-10-28: el drenador de la cola (`lib/ods-cola.js`) borraba del ODS toda póliza
 * EDITADA en Kepler desde el 27-oct — 1,590 renglones, ~$17 M, casi todo septiembre — con todos los
 * latidos en verde. Lo encontró una persona preguntando por la cuenta 601-014. El barrido que lo
 * cerró (24 tablas × 9 sucursales, 0 faltan · 0 sobran) se hizo a mano; éste es ese barrido, diario.
 *
 * QUÉ COMPARA (y qué NO)
 * ----------------------
 * Por sucursal × `kdc2YYMM`: la llave (c1, c2, c3, c8, c10) + cargo/abono (c4) + importe (c5, a 2
 * decimales). Primero una HUELLA por tabla en SQL (count + md5 de los renglones ordenados en "C"):
 * ~100 ms la más grande (CEDIS sep-2026, 23,158 renglones). Sólo si la huella difiere trae los
 * renglones y nombra cada llave: falta (Kepler la tiene, el ODS no), sobra (al revés) o distinta.
 *   ⛔ NO compara las demás columnas (concepto, referencia, folio): este árbitro es de DINERO. Un
 *      concepto corregido en Kepler que no llegó no lo ve, y se declara así en la nota.
 *
 * QUÉ HACE CON UNA DIFERENCIA
 * ---------------------------
 *   1. Espera `ODS_ARBITRO_ESPERA_S` (90 s) y vuelve a medir SÓLO esas tablas: una póliza editada
 *      hace un segundo está en la cola, no perdida. Lo que se cerró solo no se reporta.
 *   2. Lo que persiste se ENCOLA en `ods.cola` de la réplica (op 'U'): el drenador ya sabe qué hacer
 *      con cada caso — si la réplica tiene la llave la re-embarca, si no la borra del ODS. Es el
 *      mismo camino que la reparación manual del 2026-10-28, no uno nuevo.
 *   3. Late en ROJO aunque haya reparado: una diferencia significa que el carril tiene un hueco, y
 *      repararla en silencio lo escondería para siempre (misma regla que `arbitro-por-cambio`).
 *
 * FRENOS (viven en el código, no en quien lo invoca)
 *   · réplica vacía con ODS lleno, o tabla ausente en la réplica → NO repara: una réplica rota
 *     haría parecer «sobrante» a todo el ODS y el drenador lo borraría. Se declara.
 *   · más de `ODS_ARBITRO_TOPE` (2,000) llaves en total → NO repara nada: eso no es un hueco, es
 *     otra cosa, y se mira a mano.
 *   · sin `ods.cola` en la réplica → no puede reparar; lo declara.
 *   · en seco (sin `--apply`) no encola ni late: mirar no es entregar ([OBS.13]).
 *
 * Uso:
 *   node arbitro-polizas-valor.js                    # en seco: mide y reporta
 *   node arbitro-polizas-valor.js --apply            # repara y late
 *   node arbitro-polizas-valor.js --branch=08 --tables=kdc22610
 *
 * Env: ODS_SOURCE_BASE (réplicas :5433) · DATABASE_URL_NEW (ODS en prod: lee y late).
 */

const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const PK = ['c1', 'c2', 'c3', 'c8', 'c10'];
const TABLA_RE = /^kdc2[0-9]{4}$/;
const HB_KEY = 'arbitro_polizas_valor';
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// El renglón como texto, idéntico en los dos lados: la réplica guarda varchar y numeric(·,2), el ODS
// text y numeric sin escala — `btrim`/`trim_scale`/`round` los vuelven comparables.
const LLAVE_TXT = `btrim(c1::text)||'|'||to_char(c2,'YYYY-MM-DD HH24:MI:SS')||'|'||btrim(c3::text)||'|'||btrim(c8::text)||'|'||trim_scale(c10::numeric)::text`;
const VALOR_TXT = `btrim(coalesce(c4::text,''))||'|'||round(c5::numeric,2)::text`;
const LLAVE_JSON = `jsonb_build_object(${PK.map((k) => `'${k}', to_jsonb(t) -> '${k}'`).join(', ')})`;

const desde = (esquema, tabla, sucursal) =>
  `${esquema}.${tabla} t${sucursal ? ` WHERE t.sucursal = '${sucursal.replace(/[^0-9A-Za-z]/g, '')}'` : ''}`;

async function listarTablas(c, esquema) {
  const r = await c.query(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p') AND c.relname ~ '^kdc2[0-9]{4}$' ORDER BY 1`, [esquema]);
  return r.rows.map((x) => x.t);
}

async function huella(c, esquema, tabla, sucursal) {
  const r = await c.query(
    `SELECT count(*)::int AS n, coalesce(md5(string_agg(x, chr(10) ORDER BY x COLLATE "C")), '') AS h
       FROM (SELECT ${LLAVE_TXT}||'#'||${VALOR_TXT} AS x FROM ${desde(esquema, tabla, sucursal)}) s`);
  return r.rows[0];
}

async function renglones(c, esquema, tabla, sucursal) {
  const r = await c.query(`SELECT ${LLAVE_TXT} AS k, ${VALOR_TXT} AS v, ${LLAVE_JSON} AS llave FROM ${desde(esquema, tabla, sucursal)}`);
  return new Map(r.rows.map((x) => [x.k, x]));
}

/** Puro: dados los renglones de los dos lados, qué llaves difieren y cómo. */
function diferencias(rep, ods) {
  const out = [];
  for (const [k, x] of rep) {
    const o = ods.get(k);
    if (!o) out.push({ k, tipo: 'falta', llave: x.llave });
    else if (o.v !== x.v) out.push({ k, tipo: 'distinta', llave: x.llave, kepler: x.v, ods: o.v });
  }
  for (const [k, o] of ods) if (!rep.has(k)) out.push({ k, tipo: 'sobra', llave: o.llave });
  return out;
}

/**
 * Una tabla de una sucursal. `rep` = réplica (esquema `md`), `ods` = prod (`kepler_ods`, filtrado
 * por sucursal). Devuelve el veredicto de la tabla; nunca lanza.
 */
async function arbitrarTabla(rep, ods, code, tabla, { esqRep = 'md', esqOds = 'kepler_ods' } = {}) {
  const m = { suc: code, tabla, n_kepler: null, n_ods: null, difs: [], freno: null, error: null };
  try {
    const [hr, ho] = [await huella(rep, esqRep, tabla), await huella(ods, esqOds, tabla, code)];
    m.n_kepler = hr.n; m.n_ods = ho.n;
    if (hr.h === ho.h) return m;
    if (hr.n === 0 && ho.n > 0) m.freno = 'réplica vacía con ODS lleno';
    m.difs = diferencias(await renglones(rep, esqRep, tabla), await renglones(ods, esqOds, tabla, code));
  } catch (e) { m.error = e.message; }
  return m;
}

/** Puro: el veredicto y la nota del latido. */
function veredicto(mediciones, { reparadas = 0, noReparo = null } = {}) {
  const cuenta = { falta: 0, sobra: 0, distinta: 0 };
  const fallas = [];
  let limpias = 0;
  for (const m of mediciones) {
    if (m.error) { fallas.push(`${m.suc}/${m.tabla}: NO MEDIDO (${m.error.slice(0, 120)})`); continue; }
    if (m.freno) fallas.push(`${m.suc}/${m.tabla}: ${m.freno} — no se reparó`);
    if (!m.difs.length && !m.freno) { limpias++; continue; }
    const c = { falta: 0, sobra: 0, distinta: 0 };
    for (const d of m.difs) { c[d.tipo]++; cuenta[d.tipo]++; }
    if (m.difs.length) fallas.push(`${m.suc}/${m.tabla}: faltan ${c.falta} · sobran ${c.sobra} · distintas ${c.distinta}`);
  }
  if (noReparo) fallas.unshift(`NO se reparó nada: ${noReparo}`);
  else if (reparadas) fallas.unshift(`${reparadas} llaves re-encoladas — el carril de pólizas tiene un hueco`);
  return {
    fallas,
    limpias,
    nota: `${limpias} de ${mediciones.length} sucursal×mes idénticas a Kepler (llave + cargo/abono + importe; `
      + `NO compara concepto ni referencia) · faltan ${cuenta.falta} · sobran ${cuenta.sobra} · distintas ${cuenta.distinta}`
      + (reparadas ? ` · re-encoladas ${reparadas}` : ''),
  };
}

async function encolar(rep, tabla, difs, esqCola = 'ods') {
  if (!difs.length) return 0;
  const r = await rep.query(
    `INSERT INTO ${esqCola}.cola (tabla, llave, op) SELECT $1, x, 'U' FROM jsonb_array_elements($2::jsonb) x`,
    [tabla, JSON.stringify(difs.map((d) => d.llave))]);
  return r.rowCount;
}

async function latir(destUrl, v, ms) {
  const c = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  try {
    await c.connect();
    await c.query(`
      INSERT INTO analytics.cron_runs
        (tenant_id, job_key, label, last_start, last_finish, status, rows_affected, duration_ms, note, error, host, updated_at)
      VALUES ($1, $2, 'Árbitro de pólizas ODS↔Kepler por importe', now() - ($3::int || ' ms')::interval, now(),
              $4, $5, $3, $6, $7, $8, now())
      ON CONFLICT (tenant_id, job_key) DO UPDATE SET
        label=EXCLUDED.label, last_start=EXCLUDED.last_start, last_finish=EXCLUDED.last_finish, status=EXCLUDED.status,
        rows_affected=EXCLUDED.rows_affected, duration_ms=EXCLUDED.duration_ms,
        note=EXCLUDED.note, error=EXCLUDED.error, host=EXCLUDED.host, updated_at=now()`,
    [TENANT, HB_KEY, ms, v.fallas.length ? 'error' : 'ok', v.limpias, v.nota,
      v.fallas.length ? v.fallas.slice(0, 12).join(' | ').slice(0, 1500) : null, require('os').hostname()]);
  } catch (e) {
    console.error(`latido falló: ${e.message}`);
  } finally { await c.end().catch(() => {}); }
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : null; };
  const ESPERA_S = Math.max(0, Number(process.env.ODS_ARBITRO_ESPERA_S ?? 90));
  const TOPE = Math.max(1, Number(process.env.ODS_ARBITRO_TOPE) || 2000);
  const destUrl = process.env.DATABASE_URL_NEW;
  const base = process.env.ODS_SOURCE_BASE;
  if (!destUrl || !base) { console.error('Faltan DATABASE_URL_NEW y/o ODS_SOURCE_BASE.'); process.exit(2); }
  const { replicaDbName, BRANCHES } = require('../lib/kepler-branches');
  const codes = arg('branch') ? [arg('branch')] : BRANCHES.map((b) => b.code);
  const soloTablas = arg('tables') ? arg('tables').split(',').filter((t) => TABLA_RE.test(t)) : null;
  const urlRep = (code) => { const u = new URL(base); u.pathname = `/${replicaDbName(code)}`; return u.toString(); };

  const t0 = Date.now();
  const ods = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await ods.connect();
  const tablasOds = await listarTablas(ods, 'kepler_ods');
  const reps = new Map();
  let mediciones = [];
  try {
    for (const code of codes) {
      const rep = new Client({ connectionString: urlRep(code), statement_timeout: 120000 });
      try { await rep.connect(); } catch (e) {
        mediciones.push({ suc: code, tabla: '*', difs: [], error: `réplica inalcanzable: ${e.message}` });
        continue;
      }
      reps.set(code, rep);
      const tablasRep = new Set(await listarTablas(rep, 'md'));
      const universo = [...new Set([...tablasRep, ...tablasOds])].filter((t) => !soloTablas || soloTablas.includes(t)).sort();
      for (const t of universo) {
        if (!tablasRep.has(t)) {
          const n = (await huella(ods, 'kepler_ods', t, code)).n;
          if (n) mediciones.push({ suc: code, tabla: t, n_kepler: null, n_ods: n, difs: [], freno: 'tabla ausente en la réplica' });
          continue;
        }
        if (!tablasOds.includes(t)) {
          // Kepler crea vacías las del mes siguiente (y quedan restos como `kdc20012`): sin renglones
          // no hay nada que perder. Con renglones, el ODS no tiene dónde recibirlos — eso sí es falla.
          const n = (await huella(rep, 'md', t)).n;
          if (n) mediciones.push({ suc: code, tabla: t, n_kepler: n, n_ods: null, difs: [], freno: `tabla ausente en el ODS con ${n} renglones en Kepler` });
          continue;
        }
        mediciones.push(await arbitrarTabla(rep, ods, code, t));
      }
    }

    // 1. Segunda medición de lo que difirió: lo que la cola cerró sola no es un hueco.
    const conDif = mediciones.filter((m) => m.difs.length);
    if (conDif.length && ESPERA_S) {
      console.log(`${conDif.length} tabla(s) con diferencias; re-mido en ${ESPERA_S} s…`);
      await new Promise((r) => setTimeout(r, ESPERA_S * 1000));
      mediciones = await Promise.all(mediciones.map(async (m) => {
        if (!m.difs.length) return m;
        const m2 = await arbitrarTabla(reps.get(m.suc), ods, m.suc, m.tabla);
        if (m2.error) return m2;
        const antes = new Set(m.difs.map((d) => `${d.tipo}:${d.k}`));
        return { ...m2, difs: m2.difs.filter((d) => antes.has(`${d.tipo}:${d.k}`)) };
      }));
    }

    // 2. Reparar lo que persiste, con sus frenos.
    const reparables = mediciones.filter((m) => m.difs.length && !m.freno && !m.error);
    const total = reparables.reduce((s, m) => s + m.difs.length, 0);
    let reparadas = 0;
    let noReparo = null;
    if (total && !APPLY) noReparo = 'corrida en seco';
    else if (total > TOPE) noReparo = `${total} llaves superan el tope de ${TOPE} — revisar a mano`;
    else {
      for (const m of reparables) {
        const rep = reps.get(m.suc);
        const hay = (await rep.query(`SELECT to_regclass('ods.cola') IS NOT NULL AS ok`)).rows[0].ok;
        if (!hay) { m.freno = 'la réplica no tiene ods.cola'; continue; }
        reparadas += await encolar(rep, m.tabla, m.difs);
      }
    }

    for (const m of mediciones.filter((x) => x.difs.length || x.freno || x.error)) {
      console.log(`${m.suc}/${m.tabla}: kepler ${m.n_kepler} · ods ${m.n_ods}${m.freno ? ` · FRENO ${m.freno}` : ''}${m.error ? ` · ERROR ${m.error}` : ''}`);
      for (const d of m.difs.slice(0, 10)) console.log(`   ${d.tipo.padEnd(8)} ${d.k}${d.tipo === 'distinta' ? `  kepler ${d.kepler} · ods ${d.ods}` : ''}`);
      if (m.difs.length > 10) console.log(`   … +${m.difs.length - 10}`);
    }
    const v = veredicto(mediciones, { reparadas, noReparo: total ? noReparo : null });
    console.log(`\n${v.nota}${v.fallas.length ? `\nFALLAS:\n  ${v.fallas.join('\n  ')}` : ''}`);
    if (APPLY) await latir(destUrl, v, Date.now() - t0);
    else console.log('(en seco: no se encoló nada ni se escribió el latido)');
  } finally {
    await ods.end().catch(() => {});
    for (const c of reps.values()) await c.end().catch(() => {});
  }
}

if (require.main === module) main().catch((e) => { console.error('ERR', e.message); process.exit(1); });

module.exports = { __test: { diferencias, veredicto, arbitrarTabla, encolar, huella, LLAVE_TXT, VALOR_TXT } };
