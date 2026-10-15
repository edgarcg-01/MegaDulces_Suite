'use strict';
/**
 * `[VEC.21]` Candado de la venta a CRÉDITO de la ruta.
 *
 *   node database/tests/test-newdb-route-credit-sales.js
 *
 * Sólo lee. No escribe una sola fila.
 *
 * ── Qué protege, y por qué ──────────────────────────────────────────────────────────────────
 *
 * `analytics.v_route_credit_sales` **re-deriva a propósito** parte de lo que ya resuelve
 * `analytics.erp_receivable_documents`, porque el primitivo cuesta 850–1,030 ms venga como venga
 * (su CTE materializa las 60,737 filas de toda la cartera antes de poder filtrar) y la vista
 * nueva mide ~450 ms acotada al universo de ruta.
 *
 * ⛔ **Re-derivar es exactamente lo que esta casa prohíbe**, y la única razón por la que acá se
 * permite es que este candado lo vigila: compara **fila por fila contra el primitivo** y exige
 * igualdad al centavo. Si alguien cambia allá la lista de doctypes de abono, acá se pone rojo.
 *
 * ⭐ **El cruce ya pagó antes de que la vista existiera.** El prototipo sumaba TODAS las
 * aplicaciones de `kdm5` y daba saldo **negativo** (−$377.11 en el folio `0000547`): metía el
 * tipo de abono `65`, que la canónica excluye. *Un saldo negativo en una venta a crédito es
 * imposible*, y sin el cruce salía publicado.
 *
 * ⚠️ Lo que no se puede medir se reporta `NO MEDIDO`, nunca ✔.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';
const GATE_MS = 1000;

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [VEC.21] la venta a crédito de la ruta y su cobro ===\n');
  try {
    /**
     * ── 0. ¿Existe? ───────────────────────────────────────────────────────────────────────
     *
     * ⛔ Sin esto el candado **revienta** con `relation does not exist` en vez de reportar, y
     * una corrida que explota se lee como «el candado está roto», no como «falta aplicar la
     * migración». Un candado tiene que decir qué pasa, incluso cuando lo que pasa es que su
     * objeto no está.
     */
    const existe = (await db.raw(
      `SELECT to_regclass('analytics.v_route_credit_sales') IS NOT NULL AS hay`)).rows[0].hay;
    if (!existe) {
      t('la vista analytics.v_route_credit_sales existe', false,
        'la migración [VEC.21] no está aplicada en este destino');
      for (const q of ['el saldo coincide con el primitivo', 'ninguna factura falta',
        'ningún saldo es negativo', 'los estados se separan',
        'el cobro declara su cuenta', 'la vista responde bajo el gate']) {
        noMedido(q, 'la vista no existe todavía');
      }
      return;
    }

    // ── 1. La forma: `CREATE OR REPLACE VIEW` NO hereda `security_invoker` ni el GRANT ──────
    const meta = (await db.raw(
      `SELECT COALESCE(c.reloptions::text,'') AS opts,
              has_table_privilege('app_runtime','analytics.v_route_credit_sales','SELECT') AS lee
         FROM pg_class c WHERE c.oid = 'analytics.v_route_credit_sales'::regclass`)).rows[0];
    t('v_route_credit_sales: security_invoker', String(meta.opts).includes('security_invoker=true'),
      'sin esto la vista corre con los permisos del DUEÑO y saltea la RLS');
    // ⚠️ `has_table_privilege`, NO `information_schema`: esa vista filtra por el privilegio de
    //    QUIEN PREGUNTA y devuelve «ningún grant» para tablas que sí los tienen (trampa CP.8.39).
    t('v_route_credit_sales: app_runtime puede leerla', meta.lee === true,
      'la API no va a poder abrirla');

    // ── 2. ⭐ El CRUCE contra el primitivo — la razón por la que se permite re-derivar ───────
    const x = (await db.raw(
      `SELECT count(*)::int AS docs,
              count(*) FILTER (WHERE abs(v.saldo - r.saldo_documento) > 0.02)::int AS difieren,
              round(COALESCE(sum(v.saldo - r.saldo_documento),0),2) AS delta
         FROM analytics.v_route_credit_sales v
         JOIN analytics.erp_receivable_documents r
           ON r.sucursal = v.warehouse_code AND r.folio = v.folio AND r.doc_code = 'UD0801'
        WHERE v.tenant_id = ? AND v.fecha >= current_date - 120`, [T])).rows[0];

    if (!Number(x.docs)) {
      noMedido('el saldo coincide con el primitivo', 'ninguna ruta facturó a crédito en 120 días');
    } else {
      t(`el saldo coincide con erp_receivable_documents en ${x.docs - x.difieren} de ${x.docs} documentos`,
        Number(x.difieren) === 0,
        `${x.difieren} difieren (delta ${x.delta}): la vista rápida se separó del primitivo`);
    }

    // ── 3. ⛔ Ningún documento perdido: lo que está en la cartera tiene que estar acá ────────
    //
    // El cruce de arriba sólo mira los que coinciden. Un documento que la vista NO produjera
    // quedaría invisible para él — es la trampa del LEFT JOIN que llega NULL y se lee como sano.
    const falta = (await db.raw(
      `SELECT count(*)::int AS n
         FROM analytics.erp_receivable_documents r
        WHERE r.doc_code = 'UD0801' AND r.fecha >= current_date - 120
          AND EXISTS (SELECT 1 FROM kepler_ods.kdm1 h
                       WHERE btrim(h.sucursal) = r.sucursal AND btrim(h.c6) = r.folio
                         AND h.c2='U' AND h.c3='D' AND h.c4::integer = 8
                         AND btrim(COALESCE(h.c12,'')) ~ '^[0-9]V[0-9]'
                         AND btrim(COALESCE(h.c1,'')) = btrim(h.sucursal))
          AND NOT EXISTS (SELECT 1 FROM analytics.v_route_credit_sales v
                           WHERE v.warehouse_code = r.sucursal AND v.folio = r.folio)`)).rows[0];
    t('ninguna factura de ruta que esté en la cartera falta en la vista', Number(falta.n) === 0,
      `${falta.n} documentos de cartera que la vista no produce`);

    // ── 4. ⭐ El saldo NUNCA es negativo — el defecto que el cruce atrapó en el prototipo ────
    const neg = (await db.raw(
      `SELECT count(*)::int AS n, round(COALESCE(min(saldo),0),2) AS peor
         FROM analytics.v_route_credit_sales
        WHERE tenant_id = ? AND saldo < -0.02`, [T])).rows[0];
    t('ningún saldo es negativo', Number(neg.n) === 0,
      `${neg.n} documentos con saldo negativo (peor ${neg.peor}): se está sobre-aplicando el abono`);

    // ── 5. La ausencia no se dibuja como cero (ADR-056) ─────────────────────────────────────
    const est = (await db.raw(
      `SELECT cobranza, count(*)::int AS n,
              count(*) FILTER (WHERE dias_vencida IS NULL)::int AS sin_dias
         FROM analytics.v_route_credit_sales
        WHERE tenant_id = ? AND fecha >= current_date - 120
        GROUP BY 1 ORDER BY 1`, [T])).rows;
    const sinVenc = est.find((r) => r.cobranza === 'sin_vencimiento');
    t(`'sin_vencimiento' es un estado propio, no se mezcla con 'vigente' (${est.map((r) => `${r.cobranza}:${r.n}`).join(' · ')})`,
      !sinVenc || Number(sinVenc.sin_dias) === Number(sinVenc.n),
      'hay documentos sin vencimiento con días calculados: se inventó una fecha');

    // ── 6. ⭐ Prueba NEGATIVA: el cobro tiene que decir DÓNDE entró el dinero ────────────────
    //
    // Si `cobros` llegara siempre sin `cuenta`, la vista estaría cumpliendo la forma y no el
    // propósito — que es justo "cazarlas con su depósito".
    const cta = (await db.raw(
      `SELECT count(*)::int AS abonos,
              count(*) FILTER (WHERE co->>'cuenta' IS NOT NULL)::int AS con_cuenta
         FROM analytics.v_route_credit_sales v,
              jsonb_array_elements(COALESCE(v.cobros,'[]'::jsonb)) co
        WHERE v.tenant_id = ? AND v.fecha >= current_date - 120`, [T])).rows[0];
    if (!Number(cta.abonos)) {
      noMedido('el cobro declara su cuenta de tesorería', 'ninguna factura del período tiene cobro aplicado');
    } else {
      t(`${cta.con_cuenta} de ${cta.abonos} abonos declaran su cuenta de tesorería`,
        Number(cta.con_cuenta) > 0,
        'ningún abono trae cuenta: la liga con erp_collections no está resolviendo');
    }

    // ── 7. La pantalla tiene que abrir ──────────────────────────────────────────────────────
    const t0 = Date.now();
    await db.raw(
      `SELECT warehouse_code, route_no, folio, importe, cobrado, saldo, cobranza, cobros
         FROM analytics.v_route_credit_sales
        WHERE tenant_id = ? AND fecha >= current_date - 90`, [T]);
    const ms = Date.now() - t0;
    t(`la vista (90 días) responde en ${ms} ms (gate ${GATE_MS} ms)`, ms <= GATE_MS,
      `${ms} ms: por encima del gate deja de poder ser vista`);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
