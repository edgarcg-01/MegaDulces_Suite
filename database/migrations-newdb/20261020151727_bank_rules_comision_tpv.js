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
 *  · **781 movimientos / $203,047.77** mal clasificados como `pago_credito`.
 *  · **800 movimientos / $132,252.69** de la variante `DEBITO` quedaban **sin categoría**
 *    (ninguna regla las tomaba: no dicen "COMISI" ni "CREDITO").
 *  · Total que esta migración recategoriza: **1,581 movimientos / $335,300.46**.
 *  · El pago de crédito REAL (`PAGO DE CAPITAL …`, `PAGO DE INTERESES …`) son ~4 al mes y
 *    **no los toca**: no dicen "TASA DE DES".
 *  · Contabilidad ya las lleva bien: **85 de 85** de una muestra jul–sep >$500 tienen su
 *    línea en `611-003 COMISIONES BANCARIAS` (distancia −3 a +14 días; control placebo con un
 *    importe inventado: 0 coincidencias en ContPAQi y en el mayor).
 *
 * ⚠️ **Por qué el regex es estrecho.** `TERMINALES PUNTO DE VENTA` a secas también aparece en
 * el concepto del **depósito** de la venta con tarjeta: 672 movimientos / **$4,983,804.98** hoy
 * correctamente en `cobranza`. Por eso las dos reglas exigen `code = 612` (egreso) **y** la
 * frase `TASA DE DES(C)? (CREDITO|DEBITO)`. Medido: con ese acote, cero ingresos entran.
 *
 * ⚠️ El IVA de esa comisión ya va bien a `iva_acreditable` cuando viene con `code 147` (1,567
 * movimientos). Pero **9 llegaron capturados con `code 612`** y se quedaban sin categoría; la
 * regla `138` los manda a `iva_acreditable`, que es como el libro trata todos los demás IVA.
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
      priority: 138,
      match_code: '^612$',
      match_concept: RE_IVA,
      category_code: 'iva_acreditable',
      note: 'IVA de comisión TPV capturado con código de gasto (CB.52)',
    },
    {
      priority: 139,
      match_code: '^612$',
      match_concept: RE_COMISION,
      category_code: 'comision_bancaria',
      note: 'Tasa de descuento TPV crédito/débito = comisión bancaria, no pago de crédito (CB.52)',
    },
  ];

  for (const r of reglas) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note, active)
       VALUES (?, ?, NULL, ?, ?, ?, ?, true)
       ON CONFLICT (tenant_id, priority) DO UPDATE
         SET match_type = NULL, match_code = EXCLUDED.match_code,
             match_concept = EXCLUDED.match_concept, category_code = EXCLUDED.category_code,
             note = EXCLUDED.note, active = true, updated_at = now()`,
      [TENANT, r.priority, r.match_code, r.match_concept, r.category_code, r.note],
    );
  }

  // Reclasificar lo ya cargado. El orden importa: primero el IVA, para que la regla ancha no
  // se lo lleve — es el mismo orden de prioridad que acaban de tomar las reglas.
  const iva = await knex.raw(
    `UPDATE finance.bank_movements m
        SET category_id = c.id, classified_by = 'rule', updated_at = now()
       FROM finance.movement_categories c
      WHERE c.tenant_id = m.tenant_id AND c.code = 'iva_acreditable'
        AND m.tenant_id = ? AND m.raw_code = '612'
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
        AND m.tenant_id = ? AND m.raw_code = '612'
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
      WHERE tenant_id = ? AND priority IN (138, 139) AND note LIKE '%CB.52%'`,
    [TENANT],
  );
};

/**
 * ⚠️⚠️ **ESTE ARCHIVO ES EL QUE CORRIÓ EN PROD (batch 976, 2026-10-20 15:40 MX) Y NO SE TOCA.**
 *
 * Alcanzó al 98 %: dejó **1,561 movimientos en `comision_bancaria`** y 1,587 en
 * `iva_acreditable`. Lo que NO alcanzó son los **28 capturados con `code 102` o sin código**
 * ($8,229.81), porque sus reglas exigen `^612$` y viven en 138/139 — debajo de la `61`
 * (`type ^I$`) y la `70` (`code ^102$`), que mandan a `cobranza` antes de llegar ahí.
 *
 * Eso lo completa la migración hermana `..._bank_rules_comision_tpv_prioridad.js`, que mueve
 * las reglas a 54/55 sin `match_code`. **Acá no se corrige nada**: una migración ya aplicada
 * que cambia de contenido deja el ledger describiendo algo que nunca corrió.
 */
