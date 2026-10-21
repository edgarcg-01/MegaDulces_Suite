'use strict';
/**
 * `[CB.52.1]` — **La regla correcta en el lugar equivocado no clasifica nada.**
 *
 * La hermana `20261020151727` (batch 976 en prod, 2026-10-20 15:40 MX) puso las reglas de la
 * comisión de terminal en **138/139 con `match_code = '^612$'`**. Alcanzó al 98 %: dejó 1,561
 * movimientos en `comision_bancaria` y 1,587 en `iva_acreditable`.
 *
 * ── Lo que NO alcanzó, medido en prod tras aplicarla (sólo lectura) ─────────────────────────
 *
 *      25 movimientos  $8,209.04  siguen en `cobranza`     ← capturados con `code 102`
 *       3 movimientos     $20.77  siguen sin categoría     ← sin código de renglón
 *
 * Dos motivos, y los dos son de **colocación**, no de texto:
 *  1. `match_code = '^612$'` excluye a los que vienen con el código del depósito — y el código
 *     mal capturado es justamente parte del defecto que se está arreglando.
 *  2. La prioridad 139 se evalúa **después** de la `61` (`type ^I$` → cobranza) y la `70`
 *     (`code ^102$` → cobranza): aunque se le quite el `match_code`, esos 25 ya fueron
 *     clasificados antes de que la regla llegue a mirarlos.
 *
 * Por eso las reglas pasan a **54 y 55, sin `match_code`**, y las 138/139 se retiran (quedarían
 * muertas: lo que tomaban ya lo toma la 55, que va antes).
 *
 * ⚠️ El candado `bank-classify-comision-tpv.spec.ts` prueba exactamente este caso: su tercera
 * prueba negativa coloca la regla correcta en 139 y exige que la comisión con `code 102` se
 * pierda en `cobranza` **mientras la de `612` sigue bien** — o sea, que el defecto sea
 * invisible si uno sólo mira el caso fácil. Es el defecto que esta migración repara.
 *
 * ⚠️ No crea objetos de esquema (INSERT/DELETE de reglas + UPDATE de 28 movimientos): la
 *    compuerta de despliegue la clasifica NO_MEDIDO. Aplicar a prod ANTES de mergear.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Sólo el cargo de comisión de TPV; el depósito de la venta dice `ABONO`, no `TASA DE DES`. */
const RE_COMISION = 'TASA DE DES(C)? (CREDITO|DEBITO)';
/** El IVA de esa misma comisión, venga con el código que venga. */
const RE_IVA = '^IVA TASA DE DES';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const reglas = [
    { priority: 54, match_concept: RE_IVA, category_code: 'iva_acreditable',
      note: 'IVA de la comisión de TPV, venga con el código que venga (CB.52.1)' },
    { priority: 55, match_concept: RE_COMISION, category_code: 'comision_bancaria',
      note: 'Tasa de descuento TPV crédito/débito = comisión bancaria (CB.52.1)' },
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

  // Las 138/139 quedan muertas: lo suyo lo toma la 55, que se evalúa antes. Se retiran por su
  // nota, no por su prioridad sola, para no llevarse una regla ajena que ocupe ese número.
  const viejas = await knex.raw(
    `DELETE FROM finance.bank_classify_rules
      WHERE tenant_id = ? AND priority IN (138, 139) AND note LIKE '%CB.52%'`,
    [TENANT],
  );

  // Los 28 que la hermana no pudo alcanzar. Primero el IVA, igual que el orden de prioridad.
  const iva = await knex.raw(
    `UPDATE finance.bank_movements m
        SET category_id = c.id, classified_by = 'rule', updated_at = now()
       FROM finance.movement_categories c
      WHERE c.tenant_id = m.tenant_id AND c.code = 'iva_acreditable'
        AND m.tenant_id = ? AND m.concept ~* ? AND m.deleted_at IS NULL
        AND m.category_id IS DISTINCT FROM c.id
        AND COALESCE(m.classified_by, '') <> 'manual'`,
    [TENANT, RE_IVA],
  );

  const comision = await knex.raw(
    `UPDATE finance.bank_movements m
        SET category_id = c.id, classified_by = 'rule', updated_at = now()
       FROM finance.movement_categories c
      WHERE c.tenant_id = m.tenant_id AND c.code = 'comision_bancaria'
        AND m.tenant_id = ? AND m.concept ~* ? AND m.concept !~* ? AND m.deleted_at IS NULL
        AND m.category_id IS DISTINCT FROM c.id
        AND COALESCE(m.classified_by, '') <> 'manual'`,
    [TENANT, RE_COMISION, RE_IVA],
  );

  console.log(
    `[CB.52.1] reglas 54/55 en su lugar · ${viejas.rowCount} reglas viejas retiradas · ` +
      `reclasificados: ${comision.rowCount} a comision_bancaria, ${iva.rowCount} a iva_acreditable`,
  );
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: quita las reglas 54/55 y repone las 138/139 tal como
 * las dejó la hermana `20261020151727`, para que revertir esta migración devuelva el estado del
 * batch 976 y no uno que nunca existió.
 *
 * ⛔ NO revierte la categoría de los 28 movimientos: su categoría anterior era `cobranza` o
 * NULL — reponerla sería reponer el defecto.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `DELETE FROM finance.bank_classify_rules
      WHERE tenant_id = ? AND priority IN (54, 55) AND note LIKE '%CB.52.1%'`,
    [TENANT],
  );
  const viejas = [
    { priority: 138, match_concept: RE_IVA, category_code: 'iva_acreditable',
      note: 'IVA de comisión TPV capturado con código de gasto (CB.52)' },
    { priority: 139, match_concept: RE_COMISION, category_code: 'comision_bancaria',
      note: 'Tasa de descuento TPV crédito/débito = comisión bancaria, no pago de crédito (CB.52)' },
  ];
  for (const r of viejas) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note, active)
       VALUES (?, ?, NULL, '^612$', ?, ?, ?, true)
       ON CONFLICT (tenant_id, priority) DO NOTHING`,
      [TENANT, r.priority, r.match_concept, r.category_code, r.note],
    );
  }
};
