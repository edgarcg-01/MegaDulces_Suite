'use strict';
/**
 * `[SM.56]` — Corrige UN arqueo tecleado: el cierre de la caja 4 del 24-nov-2026.
 *
 * La cajera capturó **59 billetes de $1,000** donde había **29**. El arqueo quedó en $59,521.00 y
 * el corte de Kepler de ese turno dice $29,591.23 de efectivo. Lo pidió el responsable de la
 * sucursal (2026-11-25), con el ticket de la Suite y el corte de Kepler en la mano.
 *
 * ── El desglose, antes y después ────────────────────────────────────────────────────────────
 *
 *     pieza     antes   después
 *     $1,000      59       29      ← el error de dedo (en el teclado numérico, el 5 está sobre el 2)
 *     $500         1        1
 *     $50          0        1      ┐
 *     $20          1        2      ├ $70.50 COMPLETADOS para igualar el corte: NO se contaron
 *     50¢          0        1      ┘
 *     $1           1        1
 *     total   59,521.00  29,591.50
 *
 * ⚠️ $29,591.23 no se puede formar: la moneda más chica del catálogo es de 50¢. Queda en
 *    $29,591.50 ($0.27 sobre Kepler), por decisión del responsable. La nota del arqueo lo dice,
 *    para que nadie lea esos $70.50 como dinero contado.
 *
 * ── Qué toca ────────────────────────────────────────────────────────────────────────────────
 *  · `reconciliation.blind_counts`: el desglose, el total, la nota y la firma (se borra, igual
 *    que cuando se vuelve a capturar un conteo: un arqueo distinto es un arqueo sin validar).
 *  · `reconciliation.discrepancies`: el hallazgo `arqueo_ciego_divergente` que se levantó solo
 *    («sobran $29,929.77») pasa a `corregido` con causa `error_captura`. El UPSERT del motor
 *    conserva `status`, así que un re-escaneo no lo reabre.
 *
 * ── Guardas (todo o nada) ───────────────────────────────────────────────────────────────────
 *  · Busca el cierre por caja + día + tipo + total original. 0 filas = ya se aplicó o la base no
 *    lo tiene (local, CI): no hace nada. 2 o más = aborta.
 *  · Exige el desglose original pieza por pieza y recalcula el total nuevo antes de escribir.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA. Se aplica en
 *    prod con `apply-one-migration-prod.js` ANTES de mergear.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CAJA = '4';
const DIA = '2026-11-24';
const TOTAL_ANTES = 59521.00;
const TOTAL_DESPUES = 29591.50;

/** Valor de cada llave del catálogo MXN (`libs/contracts/src/money/denominations.ts`). */
const VALOR = {
  1000: 1000, 500: 500, 200: 200, 100: 100, 50: 50, 20: 20,
  '20m': 20, 10: 10, 5: 5, 2: 2, 1: 1, 0.5: 0.5,
};
const ANTES = { 1000: 59, 500: 1, 20: 1, 1: 1 };
const DESPUES = { 1000: 29, 500: 1, 50: 1, 20: 2, 1: 1, 0.5: 1 };

const MARCA = '[SM.56]';
const NOTA = `${MARCA} Corregido el 2026-11-25: se capturaron 59 billetes de $1,000 y eran 29 (error de captura). `
  + 'Total original $59,521.00. Se completaron $70.50 ($50 + $20 + 50¢) SIN CONTARSE para igualar el corte '
  + 'de Kepler ($29,591.23); $29,591.23 no se puede formar con el catálogo de monedas.';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sinCeros = (d) => Object.fromEntries(Object.entries(d || {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, Number(n)]));
const total = (d) => r2(Object.entries(d).reduce((s, [k, n]) => {
  if (VALOR[k] == null) throw new Error(`${MARCA} pieza fuera del catálogo: ${k}`);
  return s + VALOR[k] * Number(n);
}, 0));
const igual = (a, b) => JSON.stringify(Object.entries(sinCeros(a)).sort()) === JSON.stringify(Object.entries(sinCeros(b)).sort());

const delCierre = (q, tot) => q
  .where({ tenant_id: TENANT, caja: CAJA, business_date: DIA, tipo: 'cierre' })
  .whereRaw('total_contado = ?', [tot]);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const abortar = (m) => { throw new Error(`${MARCA} ${m} -- migracion abortada, sin tocar ninguna fila.`); };

  if (total(DESPUES) !== TOTAL_DESPUES) abortar(`el desglose nuevo suma ${total(DESPUES)}, no ${TOTAL_DESPUES}`);

  const filas = await delCierre(knex('reconciliation.blind_counts'), TOTAL_ANTES)
    .select('id', 'warehouse_code', 'denominations', 'nota');
  if (filas.length === 0) {
    console.log(`${MARCA} no hay cierre de la caja ${CAJA} del ${DIA} con $${TOTAL_ANTES}: ya aplicada o base sin ese arqueo. Nada que hacer.`);
    return;
  }
  if (filas.length > 1) abortar(`hay ${filas.length} cierres que coinciden; se esperaba uno`);

  const [f] = filas;
  const denoms = typeof f.denominations === 'string' ? JSON.parse(f.denominations) : f.denominations;
  if (!igual(denoms, ANTES)) abortar(`el desglose no es el del ticket: ${JSON.stringify(denoms)}`);
  if (total(denoms) !== TOTAL_ANTES) abortar(`el desglose suma ${total(denoms)}, no ${TOTAL_ANTES}`);

  await knex('reconciliation.blind_counts').where({ tenant_id: TENANT, id: f.id }).update({
    denominations: JSON.stringify(DESPUES),
    total_contado: TOTAL_DESPUES,
    nota: [f.nota, NOTA].filter(Boolean).join(' | '),
    validado_por: null, validado_at: null, validado_nota: null,
  });

  const hallazgo = await knex('reconciliation.discrepancies')
    .where({ tenant_id: TENANT, rule_key: 'arqueo_ciego_divergente' })
    .whereRaw('dedup_key LIKE ?', [`arqueo_ciego_divergente:${f.warehouse_code}:${CAJA}:${DIA}:%`])
    .whereIn('status', ['nuevo', 'en_revision'])
    .update({ status: 'corregido', causa_confirmada: 'error_captura', updated_at: knex.fn.now() });

  console.log(`${MARCA} cierre caja ${CAJA} ${DIA}: $${TOTAL_ANTES} -> $${TOTAL_DESPUES} · hallazgos marcados corregido: ${hallazgo}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. La firma no vuelve: el arqueo no estaba validado. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const filas = await delCierre(knex('reconciliation.blind_counts'), TOTAL_DESPUES)
    .whereRaw('nota LIKE ?', [`%${MARCA}%`])
    .select('id', 'warehouse_code', 'nota');
  if (filas.length !== 1) {
    console.log(`${MARCA} down: ${filas.length} filas con la marca; no se revierte nada.`);
    return;
  }
  const [f] = filas;
  const notaOriginal = String(f.nota).split(' | ').filter((p) => !p.startsWith(MARCA)).join(' | ') || null;
  await knex('reconciliation.blind_counts').where({ tenant_id: TENANT, id: f.id }).update({
    denominations: JSON.stringify(ANTES), total_contado: TOTAL_ANTES, nota: notaOriginal,
  });
  await knex('reconciliation.discrepancies')
    .where({ tenant_id: TENANT, rule_key: 'arqueo_ciego_divergente', status: 'corregido', causa_confirmada: 'error_captura' })
    .whereRaw('dedup_key LIKE ?', [`arqueo_ciego_divergente:${f.warehouse_code}:${CAJA}:${DIA}:%`])
    .update({ status: 'nuevo', causa_confirmada: null, updated_at: knex.fn.now() });
};
