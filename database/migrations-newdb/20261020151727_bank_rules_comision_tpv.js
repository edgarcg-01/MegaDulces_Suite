'use strict';
/**
 * `[CB.52]` — **La comisión de terminal punto de venta dejaba de ser comisión porque el
 * concepto del banco dice la palabra "CREDITO".**
 *
 * ── Lo medido antes, en prod, sólo lectura (2026-10-20, `system_identifier` 7688376744939610156)
 *
 *  · La regla `priority 142` (`code ^612$`, concepto `CAPITAL|CREDITO|CRÉDITO|PRESTAMO|…`)
 *    se lleva los cargos `APLI TASA DE DES CREDITO/1750968xx TERMINALES PUNTO DE VENTA`,
 *    que son la **comisión que BBVA cobra por cobrar con tarjeta**, no un pago de crédito.
 *  · **La misma comisión está repartida en CUATRO estados** (lo mismo que midió
 *    [`FASE_CP8_ATERRIZAJE`](../../docs/IMPLEMENTACION/FASES/FASE_CP8_ATERRIZAJE.md) `[CP.8.46]`,
 *    que delega el arreglo a esta fase):
 *
 *      770 en `pago_credito`     $202,130.82   ← la palabra "CREDITO"
 *      792 sin categoría         $131,849.15   ← la variante DEBITO: no la tomaba ninguna regla
 *       21 en `cobranza`           $8,124.85   ← capturadas con `code 102`
 *        7 en `iva_acreditable`      $499.09
 *    ─────────────────────────────────────────
 *    **1,590 movimientos · $342,603.91** → `comision_bancaria`
 *
 *  · Y **26 movimientos del IVA de esa comisión** (`$1,425.45`) llegan con el código del gasto
 *    o del depósito y no con el suyo; van a `iva_acreditable`, que es donde ya están los otros
 *    1,560 que sí traen `code 147`.
 *  · El pago de crédito REAL (`PAGO DE CAPITAL …`, `PAGO DE INTERESES …`) son ~4 al mes y
 *    **no los toca**: no dicen "TASA DE DES".
 *  · Contabilidad ya las lleva bien: **85 de 85** de una muestra jul–sep >$500 tienen su
 *    línea en `611-003 COMISIONES BANCARIAS` (distancia −3 a +14 días; control placebo con un
 *    importe inventado: 0 coincidencias en ContPAQi y en el mayor).
 *
 * ⚠️ **Por qué el regex nombra la tasa de descuento y no la terminal.** `TERMINALES PUNTO DE
 * VENTA` a secas también está en el concepto del **depósito** de la venta con tarjeta: **647
 * movimientos / $4,975,481.93** hoy correctos en `cobranza`, que este cambio **no toca**
 * (medido). Lo que identifica a la comisión es la frase `TASA DE DES(C)? (CREDITO|DEBITO)`.
 *
 * ⚠️ **Las prioridades son 54 y 55, no 138/139.** La regla `70` (`code ^102$` → `cobranza`) y la
 * `61` (`type ^I$` → `cobranza`) se evalúan antes, así que una regla en los 130 nunca vería las
 * 21 comisiones capturadas con `code 102`. Por eso van arriba, y **sin** `match_code`: el código
 * del renglón es justamente lo que viene mal capturado.
 *
 * ⚠️ **Falso positivo conocido y declarado:** de los ~3,176 movimientos que dicen esa frase,
 * **uno** trae el importe en DEPÓSITO (`$114.01`, 24-jul, `APLI TASA DE DES DEBITO`) — parece
 * una devolución de comisión. El motor clasifica por texto y **no ve el importe**, así que ese
 * queda en `comision_bancaria`. Se prefiere eso a dejar 1,589 mal por cuidar uno.
 *
 * ⚠️ Esta migración **no crea objetos de esquema** (INSERT de 2 reglas + UPDATE de movimientos):
 *    la compuerta de despliegue la clasifica NO_MEDIDO. Aplicar a prod ANTES de mergear.
 *
 * Idempotente: las reglas van por `ON CONFLICT (tenant_id, priority)`; el UPDATE sólo toca lo
 * que todavía no quedó en su categoría y **nunca** lo clasificado a mano (`classified_by`).
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Sólo el egreso de comisión de TPV, nunca el depósito de la venta con tarjeta. */
const RE_COMISION = 'TASA DE DES(C)? (CREDITO|DEBITO)';
/** El IVA de esa misma comisión, cuando llegó capturado con el código del gasto. */
const RE_IVA = '^IVA TASA DE DES';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const reglas = [
    {
      priority: 54,
      match_concept: RE_IVA,
      category_code: 'iva_acreditable',
      note: 'IVA de la comisión de TPV, venga con el código que venga (CB.52)',
    },
    {
      priority: 55,
      match_concept: RE_COMISION,
      category_code: 'comision_bancaria',
      note: 'Tasa de descuento TPV crédito/débito = comisión bancaria, no pago de crédito (CB.52)',
    },
  ];

  for (const r of reglas) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note, active)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, true)
       ON CONFLICT (tenant_id, priority) DO UPDATE
         SET match_type = NULL, match_code = NULL,
             match_concept = EXCLUDED.match_concept, category_code = EXCLUDED.category_code,
             note = EXCLUDED.note, active = true, updated_at = now()`,
      [TENANT, r.priority, r.match_concept, r.category_code, r.note],
    );
  }

  // Reclasificar lo ya cargado. El orden importa: primero el IVA, para que la regla ancha no
  // se lo lleve — es el mismo orden de prioridad que acaban de tomar las reglas.
  const iva = await knex.raw(
    `UPDATE finance.bank_movements m
        SET category_id = c.id, classified_by = 'rule', updated_at = now()
       FROM finance.movement_categories c
      WHERE c.tenant_id = m.tenant_id AND c.code = 'iva_acreditable'
        AND m.tenant_id = ?
        AND m.concept ~* ? AND m.deleted_at IS NULL
        AND m.category_id IS DISTINCT FROM c.id
        AND COALESCE(m.classified_by, '') <> 'manual'`,
    [TENANT, RE_IVA],
  );

  const comision = await knex.raw(
    `UPDATE finance.bank_movements m
        SET category_id = c.id, classified_by = 'rule', updated_at = now()
       FROM finance.movement_categories c
      WHERE c.tenant_id = m.tenant_id AND c.code = 'comision_bancaria'
        AND m.tenant_id = ?
        AND m.concept ~* ? AND m.concept !~* ? AND m.deleted_at IS NULL
        AND m.category_id IS DISTINCT FROM c.id
        AND COALESCE(m.classified_by, '') <> 'manual'`,
    [TENANT, RE_COMISION, RE_IVA],
  );

  console.log(
    `[CB.52] reglas 138/139 en su lugar · reclasificados: ${comision.rowCount} a comision_bancaria, ` +
      `${iva.rowCount} a iva_acreditable`,
  );
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: retira las dos reglas.
 *
 * ⛔ NO revierte la categoría de los movimientos: la categoría anterior de 800 de ellos era
 * NULL y la de 781 era una clasificación equivocada, así que "restaurarla" sería reponer el
 * defecto. Si hiciera falta, el camino es `reclassifyAll` con las reglas ya sin la 138/139.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `DELETE FROM finance.bank_classify_rules
      WHERE tenant_id = ? AND priority IN (54, 55) AND note LIKE '%CB.52%'`,
    [TENANT],
  );
};
