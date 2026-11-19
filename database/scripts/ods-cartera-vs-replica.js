/* eslint-disable no-console */
/**
 * `[CXC.45]` ¿El ODS tiene la cartera que tiene Kepler? Compara, SUCURSAL POR SUCURSAL, la réplica
 * (`kepler_md_XX.md.*`, la que mantiene la replicación lógica) contra `kepler_ods.*` con
 * `sucursal = XX`, en las dos tablas de las que sale todo saldo de cliente:
 *
 *   · `kdue` — cada documento de cartera y su SALDO SEGÚN KEPLER (`c20`). Faltantes y saldos distintos.
 *   · `kdm5` — cada aplicación de un pago a una factura. Faltantes, montos distintos y SOBRANTES
 *     VIVOS (la réplica ya no la tiene y su abono no está cancelado: el ODS la cree pagada).
 *
 * POR QUÉ EXISTE. El 2026-11-19 un cliente de Canindo reclamó su estado de cuenta: el cobro 117
 * ($39,829, del 22-sep) nunca llegó aplicado al ODS. Medido ese día con esta comparación: 2,967
 * saldos viejos en `kdue`, 100 documentos y 133 aplicaciones faltantes. La causa fue el carril CTID
 * (no ve un UPDATE que deja la fila en otra página); el arreglo, la cola de cambios. Esto es el
 * ÁRBITRO que dice si el arreglo se sostiene: debe dar CERO.
 *
 * ⛔ NO TIENE RELOJ. Se corre a mano (o lo corre quien despliega) — no es un cron ni un sensor. Es de
 * SÓLO LECTURA en las dos puntas (`default_transaction_read_only`).
 *
 * ⭐ LO QUE VA EN CAMINO NO ES UNA FALLA. Una venta de hace 2 s puede estar en la réplica y aún no en
 * el ODS. Por eso toda diferencia se vuelve a leer, SÓLO esas llaves, tras `--recheck` segundos
 * (default 30): lo que sigue distinto es lo que se reporta.
 *
 * Uso (dentro del pod del carril, que trae las dos conexiones):
 *   kubectl exec -n ingesta deploy/ods-live-caja -- node database/scripts/ods-cartera-vs-replica.js
 *   … --branch=06 · --recheck=30 · --muestra=5 (llaves de ejemplo por hallazgo)
 *
 * Sale con 1 si queda cualquier diferencia; 0 si las dos puntas dicen lo mismo.
 * Origen: `ODS_SOURCE_BASE` o `KEPLER_REPLICA_BASE`. Destino: `KP_DEST_URL` o `DATABASE_URL_NEW`
 * (igual que `replicate-ods-live.js`).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
const { Client } = require('pg');
const { BRANCHES, replicaUrl } = require('../importers/lib/kepler-branches');

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const SOLO = arg('branch') || null;
const RECHECK_S = Math.max(0, Number(arg('recheck') ?? 30));
const MUESTRA = Math.max(0, Number(arg('muestra') ?? 3));
const BASE = process.env.ODS_SOURCE_BASE || process.env.KEPLER_REPLICA_BASE;
const DEST = process.env.KP_DEST_URL || process.env.DATABASE_URL_NEW;

// Los mismos tipos que lee `analytics.erp_receivable_documents` (la cartera): cargos y abonos.
const FILTRO_KDUE = `((c29 = 'C' AND btrim(c4::text) IN ('3','8','9','12','13','25','41'))
                  OR (c29 = 'A' AND btrim(c4::text) IN ('5','7','21','25','30','35','40')))`;
const LLAVE_KDUE = `btrim(c1)||'|'||c3||'|'||btrim(c4::text)||'|'||btrim(c5::text)||'|'||btrim(c6)`;
const LLAVE_KDM5 = `btrim(c1)||'|'||c2||'|'||c3||'|'||btrim(c4::text)||'|'||btrim(c5::text)||'|'||btrim(c6)||'|'||btrim(c7::text)`;

const kdueDe = async (p, donde, params) => new Map((await p.query(
  `SELECT ${LLAVE_KDUE} AS k, round(c20, 2)::text AS v FROM ${donde} AND ${FILTRO_KDUE}`, params)).rows.map((r) => [r.k, r.v]));
const kdm5De = async (p, donde, params) => new Map((await p.query(
  `SELECT ${LLAVE_KDM5} AS k, round(c13, 2)::text AS v FROM ${donde}`, params)).rows.map((r) => [r.k, r.v]));

/** Diferencias entre dos mapas llave → valor. */
function comparar(src, ods) {
  const faltan = [], distintas = [], sobran = [];
  for (const [k, v] of src) { if (!ods.has(k)) faltan.push(k); else if (ods.get(k) !== v) distintas.push(k); }
  for (const k of ods.keys()) if (!src.has(k)) sobran.push(k);
  return { faltan, distintas, sobran };
}

/** Vuelve a leer SÓLO las llaves con diferencia y devuelve las que siguen distintas. */
async function releer(rep, ods, code, tabla, llaves) {
  if (!llaves.length) return { faltan: [], distintas: [], sobran: [] };
  const expr = tabla === 'kdue' ? LLAVE_KDUE : LLAVE_KDM5;
  const leer = tabla === 'kdue' ? kdueDe : kdm5De;
  const s = await leer(rep, `(SELECT * FROM md.${tabla} WHERE ${expr} = ANY($1)) t WHERE true`, [llaves]);
  const o = await leer(ods, `(SELECT * FROM kepler_ods.${tabla} WHERE sucursal = $2 AND ${expr} = ANY($1)) t WHERE true`, [llaves, code]);
  return comparar(s, o);
}

/** De las aplicaciones que sobran en el ODS, ¿cuántas son de un abono VIVO (no cancelado en Kepler)? */
async function sobrantesVivas(ods, code, llaves) {
  if (!llaves.length) return [];
  const { rows } = await ods.query(
    `SELECT ${LLAVE_KDM5} AS k FROM kepler_ods.kdm5 a
      WHERE a.sucursal = $2 AND ${LLAVE_KDM5} = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 k
                         WHERE k.sucursal = a.c1 AND k.c1 = a.c1 AND k.c2 = a.c2 AND k.c3 = a.c3
                           AND k.c4 = a.c4 AND k.c5 = a.c5 AND k.c6 = a.c6 AND btrim(coalesce(k.c43, '')) = 'C')`,
    [llaves, code]);
  return rows.map((r) => r.k);
}

(async () => {
  if (!BASE) { console.error('✖ falta ODS_SOURCE_BASE o KEPLER_REPLICA_BASE (las réplicas).'); process.exit(2); }
  if (!DEST) { console.error('✖ falta KP_DEST_URL o DATABASE_URL_NEW (el ODS).'); process.exit(2); }
  const ods = new Client({ connectionString: DEST, ssl: false, statement_timeout: 120000 });
  await ods.connect();
  await ods.query('SET default_transaction_read_only = on');
  const ramas = BRANCHES.filter((b) => !SOLO || b.code === SOLO);
  const res = [];
  const pendientes = [];
  for (const b of ramas) {
    const rep = new Client({ connectionString: replicaUrl(b.code, BASE), connectionTimeoutMillis: 10000, statement_timeout: 120000 });
    try {
      await rep.connect();
      await rep.query('SET default_transaction_read_only = on');
      const due = comparar(await kdueDe(rep, 'md.kdue WHERE true', []),
        await kdueDe(ods, 'kepler_ods.kdue WHERE sucursal = $1', [b.code]));
      const m5 = comparar(await kdm5De(rep, 'md.kdm5 WHERE true', []),
        await kdm5De(ods, 'kepler_ods.kdm5 WHERE sucursal = $1', [b.code]));
      pendientes.push({ b, rep, due, m5 });
    } catch (e) {
      res.push({ rama: b.code, error: e.message.slice(0, 90) });
      await rep.end().catch(() => { /* ya cerrada */ });
    }
  }
  if (RECHECK_S && pendientes.some(({ due, m5 }) => due.faltan.length + due.distintas.length + m5.faltan.length + m5.distintas.length + m5.sobran.length)) {
    console.log(`… hay diferencias: las vuelvo a leer en ${RECHECK_S} s (lo que va en camino no es una falla)`);
    await new Promise((r) => setTimeout(r, RECHECK_S * 1000));
  }
  for (const { b, rep, due, m5 } of pendientes) {
    try {
      const d2 = RECHECK_S ? await releer(rep, ods, b.code, 'kdue', [...due.faltan, ...due.distintas]) : due;
      const m2 = RECHECK_S ? await releer(rep, ods, b.code, 'kdm5', [...m5.faltan, ...m5.distintas, ...m5.sobran]) : m5;
      const vivas = await sobrantesVivas(ods, b.code, m2.sobran);
      const fila = {
        rama: b.code, sucursal: b.name,
        kdue_faltan: d2.faltan.length, kdue_saldo_distinto: d2.distintas.length,
        kdm5_faltan: m2.faltan.length, kdm5_monto_distinto: m2.distintas.length,
        kdm5_sobran_vivas: vivas.length, kdm5_sobran_canceladas: m2.sobran.length - vivas.length,
      };
      res.push(fila);
      if (MUESTRA) {
        const ej = { 'kdue faltan': d2.faltan, 'kdue saldo distinto': d2.distintas, 'kdm5 faltan': m2.faltan, 'kdm5 sobran vivas': vivas };
        for (const [q, l] of Object.entries(ej)) if (l.length) console.log(`  ${b.code} ${q}: ${l.slice(0, MUESTRA).join(' · ')}${l.length > MUESTRA ? ` (+${l.length - MUESTRA})` : ''}`);
      }
    } catch (e) {
      res.push({ rama: b.code, error: e.message.slice(0, 90) });
    } finally { await rep.end().catch(() => { /* ya cerrada */ }); }
  }
  await ods.end();
  console.table(res);
  const malas = res.filter((r) => r.error || r.kdue_faltan || r.kdue_saldo_distinto || r.kdm5_faltan || r.kdm5_monto_distinto || r.kdm5_sobran_vivas);
  console.log(malas.length
    ? `✖ ${malas.length} sucursal(es) con diferencias entre Kepler y el ODS. Las aplicaciones de abonos cancelados no cuentan: la cartera ya las ignora (kepler_kdm5_vigente).`
    : '✔ El ODS tiene la misma cartera que Kepler en todas las sucursales revisadas.');
  process.exit(malas.length ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
