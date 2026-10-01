/* eslint-disable no-console */
/**
 * `[IC.CEDIS.7]` — **El candado de la existencia del CEDIS** (ADR-059).
 *
 * ── QUÉ VINO A CERRAR ───────────────────────────────────────────────────────────────────────────
 * El 2026-09-30 la mig `20260930140000` le puso `kepler_code='00'` al CEDIS para cerrar la
 * compuerta de su feed Wincaja. Efecto no previsto: `analytics.v_erp_stock_on_hand` lo excluía a
 * mano de la pierna Kepler (`w.kepler_code <> '00'`, escrito cuando se creía que esa sucursal era
 * OFICINAS) y lo aceptaba en la de Wincaja sólo si `kepler_code IS NULL`. **Se cayó de las dos y
 * quedó invisible un día entero**, en el nodo que SURTE A LA RED. Lo reportó un humano, no un test.
 *
 * ── EL ÁRBITRO, Y POR QUÉ ÉSTE ─────────────────────────────────────────────────────────────────
 * El testigo del CEDIS es su **conteo físico del corte** (`N-A-45` del 2026-09-30, 127 líneas):
 * mismo ERP, mismo grano (almacén x SKU), e independiente del ledger en el sentido que importa —
 * alguien contó cajas. El bloque 3 compara SKU por SKU contra `kdil` y exige **1.00x**.
 *
 * ⚠️ Y se declara su LÍMITE, que es real: a partir del corte el conteo deja de ser independiente
 * (la entrada `N-A-30` posteó justamente lo contado) y el CEDIS se mueve. Este candado arbitra la
 * **identidad del corte**, no la existencia de hoy. Decir que arbitra más sería un espejo (R5).
 *
 * ── EL HUECO, DECLARADO CON NÚMERO (nunca dibujado en verde) ───────────────────────────────────
 * Kepler tiene DOS columnas de existencia y **se contradicen en las OCHO sucursales**: `kdil`
 * (`c4+c8-c9`, la que publicamos en todos lados) contra `kdik.c6` (que no consume nadie). Razones
 * medidas el 2026-10-01: 0.09x a 5.45x, ~99% de los SKUs distintos en cada rama. El bloque 5 lo
 * mide y reporta **NO MEDIDO**, no un tache: no es una regresión de esta fase y no se puede
 * arbitrar sin decidir primero qué significa `kdik.c6`. Un hueco con nombre y monto le gana a un
 * rojo permanente que nadie atiende.
 */
'use strict';
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const CORTE = process.env.CEDIS_CUTOVER || '2026-09-30';
const SUC = '00';

let ok = 0; let fail = 0; let skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX');

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 180000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    // ── 1. LA REGRESIÓN: el CEDIS existe en la vista ────────────────────────────────────────
    console.log('\n[1] El CEDIS está publicado');
    const [cedis] = await q(
      `SELECT count(*)::int skus, COALESCE(sum(qty_stock_units),0)::numeric u
         FROM analytics.v_erp_stock_on_hand WHERE warehouse_code = $1`, [SUC]);
    chk(cedis.skus > 0,
      `el almacén ${SUC} tiene ${n(cedis.skus)} SKUs en v_erp_stock_on_hand `
      + `(${n(Math.round(cedis.u))} u) — estuvo en CERO el 2026-09-30`);

    const ramas = await q(
      `SELECT warehouse_code FROM analytics.v_erp_stock_on_hand
        GROUP BY 1 HAVING count(*) > 0 ORDER BY 1`);
    // Guarda anti-no-op: si la vista se vacía entera, el bloque 1 pasaría igual de "verde" mirando
    // sólo al CEDIS. Las 8 hermanas son el control.
    chk(ramas.length >= 9,
      `la vista publica ${ramas.length} almacenes (${ramas.map((r) => r.warehouse_code).join(',')}) — se esperan >= 9`);

    // ── 2. SIN DOBLE CONTEO entre las dos piernas ───────────────────────────────────────────
    console.log('\n[2] Las dos piernas no se solapan');
    const [dup] = await q(
      `SELECT count(*)::int pares FROM (
         SELECT warehouse_code, sku FROM analytics.v_erp_stock_on_hand
          GROUP BY 1,2 HAVING count(DISTINCT source) > 1) t`);
    chk(dup.pares === 0,
      dup.pares === 0 ? 'ningún (almacén, SKU) sale por Kepler Y por Wincaja a la vez'
        : `⛔ ${n(dup.pares)} pares (almacén,SKU) duplicados entre piernas — el total está inflado`);

    // ── 3. EL ÁRBITRO: el conteo del corte contra el ledger ─────────────────────────────────
    console.log('\n[3] Árbitro — conteo físico N-A-45 del corte vs kdil, SKU por SKU');
    const [arb] = await q(
      `WITH cap AS (
         SELECT btrim(l.c8) sku, sum(l.c9::numeric) u
           FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm2 l
             ON l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3
            AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6
          WHERE m.sucursal=$1 AND m.c1=$1 AND m.c2='N' AND m.c3='A' AND m.c4='45'
            AND m.c9::date BETWEEN $2::date - 3 AND $2::date + 1
          GROUP BY 1),
       kd AS (
         SELECT btrim(c3) sku, GREATEST(sum(c4+c8-c9),0)::numeric u
           FROM kepler_ods.kdil WHERE sucursal=$1 AND c1=$1
            AND btrim(c3) <> ALL(ARRAY['00001','00002','00022'])
          GROUP BY 1)
       SELECT (SELECT count(*) FROM cap)::int contados,
              (SELECT COALESCE(sum(u),0) FROM cap)::numeric u_contadas,
              count(*)::int cruzan,
              COALESCE(sum(kd.u),0)::numeric u_kdil,
              count(*) FILTER (WHERE abs(kd.u - cap.u) > 0.01)::int difieren
         FROM cap JOIN kd USING (sku)`, [SUC, CORTE]);

    if (!arb.contados || Number(arb.contados) === 0) {
      // ⛔ Sin captura NO se pone verde: no hay con qué arbitrar (ADR-056).
      nm(`no hay captura N-A-45 en la sucursal ${SUC} alrededor de ${CORTE} — sin árbitro`);
    } else {
      // Guarda anti-no-op: un árbitro de 3 filas "cuadra" trivialmente.
      chk(Number(arb.contados) >= 100,
        `el conteo del corte trae ${n(arb.contados)} SKUs (>= 100: un árbitro chico cuadra solo)`);
      chk(Number(arb.cruzan) === Number(arb.contados),
        `los ${n(arb.contados)} SKUs contados TODOS tienen saldo en kdil (cruzan ${n(arb.cruzan)})`);
      chk(Number(arb.difieren) === 0,
        Number(arb.difieren) === 0
          ? `el ledger reproduce el conteo al grano SKU: ${n(arb.u_contadas)} u contra ${n(arb.u_kdil)} u`
          : `⛔ ${n(arb.difieren)} SKUs donde kdil NO reproduce lo contado`);
    }

    // ── 4. PRUEBA NEGATIVA: el árbitro sabe decir que NO ────────────────────────────────────
    console.log('\n[4] Prueba negativa — el bloque 3 no es un sello de goma');
    const [neg] = await q(
      `SELECT count(*)::int filas FROM kepler_ods.kdm1
        WHERE sucursal=$1 AND c2='N' AND c3='A' AND c4='99'`, [SUC]);
    chk(neg.filas === 0,
      'un doctype inexistente (N-A-99) devuelve 0 filas → el bloque 3 caería en NO MEDIDO, no en ✔');

    // ── 5. EL HUECO DECLARADO: kdil vs kdik en TODAS las sucursales ─────────────────────────
    console.log('\n[5] Hueco declarado — Kepler tiene DOS existencias y no coinciden');
    const div = await q(
      `WITH kl AS (
         SELECT sucursal, btrim(c3) sku, GREATEST(sum(c4+c8-c9),0)::numeric u
           FROM kepler_ods.kdil WHERE sucursal=c1
            AND btrim(c3) <> ALL(ARRAY['00001','00002','00022']) GROUP BY 1,2),
       kk AS (
         SELECT sucursal, btrim(c2) sku, max(c6::numeric) u
           FROM kepler_ods.kdik WHERE sucursal=c1 GROUP BY 1,2)
       SELECT COALESCE(kl.sucursal,kk.sucursal) suc,
              round((sum(GREATEST(kl.u,0))/NULLIF(sum(GREATEST(kk.u,0)),0))::numeric,2) razon
         FROM kl FULL JOIN kk ON kk.sucursal=kl.sucursal AND kk.sku=kl.sku
        GROUP BY 1 ORDER BY 1`);
    const fuera = div.filter((r) => r.razon == null || Math.abs(Number(r.razon) - 1) > 0.02);
    if (fuera.length) {
      nm(`kdil vs kdik discrepan en ${fuera.length} de ${div.length} sucursales `
        + `(${fuera.map((r) => `${r.suc}=${r.razon}x`).join(' ')}) — `
        + 'un testigo que contradice SIEMPRE no arbitra; se publica kdil, igual que en las 8');
    } else {
      chk(true, 'kdil y kdik coinciden en todas las sucursales — el hueco se cerró, actualizá el doc');
    }

    // ── 6. Metadata que un CREATE OR REPLACE se lleva puesta ───────────────────────────────
    console.log('\n[6] security_invoker y grants sobrevivieron');
    const [meta] = await q(
      `SELECT COALESCE((SELECT option_value FROM pg_options_to_table(cl.reloptions)
                         WHERE option_name='security_invoker'),'(no)') si
         FROM pg_class cl WHERE cl.oid='analytics.v_erp_stock_on_hand'::regclass`);
    chk(meta.si === 'true', `security_invoker = ${meta.si} (un CREATE OR REPLACE NO lo hereda)`);
    // ⛔ NO se pregunta por `information_schema.role_table_grants`: esa vista sólo muestra los
    // grants donde el rol CONECTADO es otorgante o beneficiario, así que corriendo como `dev_ro`
    // devolvía 1 de 2 y marcaba en ROJO una vista sana. `has_table_privilege` no depende de quién
    // pregunta. *Un candado que falla según quién lo corre enseña a ignorarlo.*
    const [gr] = await q(
      `SELECT has_table_privilege('app_runtime','analytics.v_erp_stock_on_hand','SELECT') AS app,
              has_table_privilege('dev_ro','analytics.v_erp_stock_on_hand','SELECT')      AS dev`);
    chk(gr.app === true && gr.dev === true,
      `SELECT concedido a app_runtime (${gr.app}) y dev_ro (${gr.dev})`);

    console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
    if (fail) process.exit(1);
    if (skip && ok === 0) return noMedido('no hubo con qué comprobar nada');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
