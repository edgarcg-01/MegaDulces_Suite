/**
 * `[PR.W1]` — La cascada de precio dice de dónde se va el dinero, y **no lo inventa**.
 *
 * Qué prueba, y por qué cada bloque existe:
 *   1. Forma: la vista existe, es `security_invoker`, `app_runtime` la lee.
 *   2. ⭐ La IDENTIDAD de la cascada: `bruto_lista − fuga_linea = neto_linea`. Si no cierra,
 *      la vista miente sobre el origen del dinero.
 *   3. ⛔ LAS PRUEBAS NEGATIVAS — las tres formas de mentir que esta vista tiene prohibidas:
 *        · una línea SIN `precio_lista` contando como **fuga 0** (ADR-056: no se sabe ≠ cero)
 *        · una línea cobrada POR ENCIMA de lista contando como **fuga negativa**
 *        · las dos capas de descuento SUMADAS (conviven — sumarlas infla la fuga)
 *   4. Los veredictos PARTICIONAN el universo: ninguna línea se queda sin clasificar.
 *   5. La medición de negocio que justifica la fase, con su cobertura declarada.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-waterfall.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const VIEW = 'analytics.v_price_waterfall';
// ⚠️ 14 y no 30: con 30 días el test se pasó de 600 s contra prod. La vista deriva del ODS
// (erp_sales_invoice_lines sobre kdm2, 4.7M filas) y NO está pensada para escanearse en vivo —
// por eso el tablero va sobre una matvista, no sobre esta vista. 14 d alcanzan para medir.
const D = 14;

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== [PR.W1] · la cascada de precio ===\n');

  const [ex] = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [VIEW]);
  if (!ex.ok) noMedido('falta la migración 20260929180000 en este destino');

  // ── 1 · FORMA ────────────────────────────────────────────────────────────────────────
  console.log('1 · FORMA');
  ck(`${VIEW} existe`, true);
  const [si] = await q(`
    SELECT COALESCE(
      (SELECT 'security_invoker=true' = ANY(c.reloptions)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'analytics' AND c.relname = 'v_price_waterfall'), false) AS si`);
  // Sin security_invoker la vista corre con los permisos del DUEÑO y se salta la RLS de quien lee.
  ck('es security_invoker (respeta la RLS de quien consulta)', !!si.si);
  const [g] = await q(`SELECT has_table_privilege('app_runtime', $1, 'SELECT') AS s`, [VIEW]);
  ck('app_runtime puede leerla', !!g.s);

  const [n] = await q(`SELECT count(*)::int filas FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  if (!n.filas) noMedido(`la vista no devuelve filas en ${D} días — nada que medir`);
  ck(`devuelve filas (${n.filas.toLocaleString()} en ${D} días)`, n.filas > 0);

  // ── 2 · ⭐ LA IDENTIDAD DE LA CASCADA ────────────────────────────────────────────────
  console.log('\n2 · ⭐ LA IDENTIDAD: bruto_lista − fuga_linea = neto_linea');
  /**
   * ⛔ SIN TOLERANCIA, y ésa es la corrección de `[PR.W1.1]`.
   *
   * Esta aserción tenía `> 0.02` y **dejó pasar** el bug de redondeo que sí atrapó la prueba del
   * signo: el defecto medía **0.01**. Con un solo redondeo la identidad es exacta por
   * construcción, así que cualquier holgura acá vuelve a ser un agujero con forma de compuerta.
   */
  const [id] = await q(`
    SELECT count(*) FILTER (WHERE fuga_linea IS NOT NULL)::int medibles,
           count(*) FILTER (WHERE fuga_linea IS NOT NULL
                              AND bruto_lista - fuga_linea <> neto_linea)::int rotas
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  ck(`la cascada cierra EXACTO (sin tolerancia) en las ${id.medibles.toLocaleString()} líneas medibles`,
    id.rotas === 0, `${id.rotas} no cierran`);

  // ── 3 · ⛔ LAS PRUEBAS NEGATIVAS ─────────────────────────────────────────────────────
  console.log('\n3 · ⛔ PRUEBAS NEGATIVAS (las tres formas de mentir que están prohibidas)');

  // (a) Sin lista NO puede ser fuga 0. ADR-056: "no se sabe" no es "cero".
  const [a] = await q(`
    SELECT count(*) FILTER (WHERE veredicto = 'sin_lista')::int sin_lista,
           count(*) FILTER (WHERE veredicto = 'sin_lista' AND fuga_linea IS NOT NULL)::int mintiendo
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  ck(`⛔ una línea SIN precio_lista NO reporta fuga (${a.sin_lista} casos)`,
    a.mintiendo === 0, `${a.mintiendo} dibujan un número donde no hay dato`);

  // (b) Cobrar por ENCIMA de lista no es "fuga negativa": es otra cosa, y se declara aparte.
  const [b] = await q(`
    SELECT count(*) FILTER (WHERE veredicto = 'precio_sobre_lista')::int sobre,
           count(*) FILTER (WHERE veredicto = 'precio_sobre_lista' AND fuga_linea IS NOT NULL)::int mintiendo,
           count(*) FILTER (WHERE fuga_linea < 0)::int fuga_negativa
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  ck(`⛔ cobrar POR ENCIMA de lista no cuenta como fuga (${b.sobre} casos)`, b.mintiendo === 0);
  ck('⛔ no existe ninguna fuga negativa', b.fuga_negativa === 0, `${b.fuga_negativa} negativas`);

  // (c) ⭐ LA QUE JUSTIFICA EL DISEÑO: las dos capas CONVIVEN, así que sumarlas es doble conteo.
  //     Se prueba que hay documentos con AMBOS descuentos — si no los hubiera, la separación
  //     sería innecesaria y este diseño estaría de más.
  const [d] = await q(`
    WITH doc AS (
      SELECT sucursal, doc_prefix, folio,
             max(COALESCE(desc_documento, 0)) AS dc,
             sum(COALESCE(descuento_linea, 0)) AS dl
        FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}
       GROUP BY 1,2,3)
    SELECT count(*)::int docs,
           count(*) FILTER (WHERE dc > 0)::int con_cabecera,
           count(*) FILTER (WHERE dl > 0)::int con_linea,
           count(*) FILTER (WHERE dc > 0 AND dl > 0)::int con_ambos
      FROM doc`);
  ck(`⭐ hay documentos con LAS DOS capas de descuento (${d.con_ambos} de ${d.docs}) `
     + '— por eso NO se suman', d.con_ambos > 0,
  'si fuera 0, la separación de capas no haría falta y habría que revisar el diseño');

  // (d) Control POSITIVO: sin esto, un 0 por filtro mal puesto se leería como "candado OK".
  const [p] = await q(`
    SELECT count(*) FILTER (WHERE veredicto = 'con_descuento' AND fuga_linea > 0)::int reales
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  ck(`⭐ CONTROL POSITIVO: sí hay fuga real donde debe haberla (${p.reales.toLocaleString()} líneas)`,
    p.reales > 0);

  // ── 4 · LOS VEREDICTOS PARTICIONAN ──────────────────────────────────────────────────
  console.log('\n4 · LOS VEREDICTOS PARTICIONAN EL UNIVERSO');
  const v = await q(`
    SELECT veredicto, count(*)::int n FROM ${VIEW}
     WHERE fecha >= CURRENT_DATE - ${D} GROUP BY 1 ORDER BY 2 DESC`);
  const suma = v.reduce((s, r) => s + r.n, 0);
  for (const r of v) console.log(`     ${r.veredicto.padEnd(20)} ${r.n.toLocaleString().padStart(9)}`);
  ck('los veredictos suman el total (ninguna línea sin clasificar)', suma === n.filas,
    `${suma} vs ${n.filas}`);
  ck('ninguna línea con veredicto NULL',
    !v.some((r) => r.veredicto === null));
  // ⭐ [PR.W1.1] El veredicto y la fuga tienen que salir del MISMO criterio. Si divergieran,
  // una línea podría decir 'con_descuento' y traer fuga NULL — y nadie sabría cuál creer.
  const [coh] = await q(`
    SELECT count(*) FILTER (WHERE veredicto = 'con_descuento' AND fuga_linea IS NULL)::int a,
           count(*) FILTER (WHERE veredicto = 'a_lista' AND fuga_linea <> 0)::int b,
           count(*) FILTER (WHERE veredicto = 'precio_sobre_lista' AND fuga_linea IS NOT NULL)::int c
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  ck('⭐ veredicto y fuga son COHERENTES (salen del mismo criterio)',
    coh.a === 0 && coh.b === 0 && coh.c === 0,
    `con_descuento sin fuga: ${coh.a} · a_lista con fuga≠0: ${coh.b} · sobre_lista con fuga: ${coh.c}`);

  // ── 5 · LA MEDICIÓN DE NEGOCIO, CON SU COBERTURA ────────────────────────────────────
  console.log('\n5 · LA MEDICIÓN (con la cobertura declarada, no escondida)');
  const [m] = await q(`
    SELECT round(sum(bruto_lista)/1e6, 2) lista_mdp,
           round(sum(fuga_linea)/1e6, 3) fuga_mdp,
           round(sum(neto_linea)/1e6, 2) neto_mdp,
           round(100 * sum(fuga_linea) / NULLIF(sum(bruto_lista), 0), 3) fuga_pct,
           round(100.0 * count(*) FILTER (WHERE fuga_linea IS NOT NULL) / count(*), 2) cobertura_pct
      FROM ${VIEW} WHERE fecha >= CURRENT_DATE - ${D}`);
  console.log(`     lista $${m.lista_mdp}M → fuga $${m.fuga_mdp}M → neto $${m.neto_mdp}M`);
  console.log(`     fuga ${m.fuga_pct}% · cobertura de la medición ${m.cobertura_pct}%`);
  ck('la cobertura de la medición se puede reportar', m.cobertura_pct != null);
  // Un 100% de cobertura sería sospechoso: significa que NINGUNA línea carece de lista.
  ck('la fuga es un número plausible (0% < fuga < 25%)',
    Number(m.fuga_pct) > 0 && Number(m.fuga_pct) < 25, `es ${m.fuga_pct}%`);

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
