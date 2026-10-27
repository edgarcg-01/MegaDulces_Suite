'use strict';
/**
 * `[PGP.23]` — **La cuenta bancaria del proveedor, que el propio proveedor ya nos declaró.**
 *
 * El complemento de pago (REP) que un proveedor emite al cobrarnos trae `CtaBeneficiario`: SU
 * cuenta. El parser YA lee ese complemento —de ahí salen las 466 filas de
 * `fiscal.cfdi_payment_links`— pero descarta ese atributo porque vive en el nodo `Pago` y el
 * extractor sólo recorre `DoctoRelacionado`.
 *
 * ── Por qué importa, medido contra prod el 2026-10-27 (sólo lectura) ────────────────────────
 *  · 172 proveedores cobraron POR BANCO en 120 días: **$136,912,739**, y `commercial.
 *    supplier_payment_accounts` tiene **0 cuentas**. Sin cuenta destino no se puede preparar una
 *    transferencia, y sin preparar no se libera el día del Calendario: el circuito entero (50
 *    pagos armados, 0 ejecutados) está detenido ahí.
 *  · La CLABE **no se puede derivar de otra cosa**: de 14,456 salidas bancarias sólo 24 traen 18
 *    dígitos en el concepto (0.17%); el estado de cuenta trae el NOMBRE del beneficiario, no su
 *    cuenta; `catalog.suppliers` no tiene ninguna columna de banco; `kdxd.c7` son teléfonos (604
 *    de 10 dígitos) y `contpaqi.supplier_accounts` son cuentas CONTABLES.
 *  · En los 17 días de CFDI que sí se descargaron del SAT: **63 REP traen cuenta, de 34
 *    proveedores, 35 cuentas distintas** — incluida la del acreedor más grande ($22.7M).
 *
 * ⚠️ **Tasa de llenado medida: 34 de los 93 proveedores que emitieron REP (37%).**
 *    `CtaBeneficiario` es OPCIONAL en el CFDI, así que esto NO sustituye la captura: la reduce.
 *
 * ⚠️ **26 de las 63 son CLABE de 18 dígitos; 37 son cuenta de 10.** Una cuenta de 10 no sirve
 *    sola para SPEI. Por eso se guarda el texto TAL CUAL, sin normalizar ni validar acá: quien
 *    da de alta la cuenta decide, con el REP a la vista. La migración NO inventa una CLABE.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. Dos columnas nuevas, ambas NULLABLE (tabla existente, sin default, sin reescritura).
 *  2. Backfill desde el `xml` que ya está guardado — recupera las 63 sin volver a descargar.
 *     ⛔ Se hace acá y no por re-ingesta porque el insert de `cfdi-ingest` usa
 *        `.onConflict(...).ignore()`: una re-descarga NO actualizaría las filas que ya existen.
 *
 * Aditiva e idempotente. No borra ni reescribe ninguna fila existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tabla = 'cfdi_payment_links';
  const tieneCta = await knex.schema.withSchema('fiscal').hasColumn(tabla, 'cta_beneficiario');
  const tieneRfc = await knex.schema.withSchema('fiscal').hasColumn(tabla, 'rfc_banco_beneficiario');

  if (!tieneCta || !tieneRfc) {
    await knex.schema.withSchema('fiscal').alterTable(tabla, (t) => {
      // `CtaBeneficiario` del nodo Pago. TEXTO CRUDO: puede ser CLABE de 18 o cuenta de 10.
      if (!tieneCta) t.text('cta_beneficiario').nullable();
      // `RfcEmisorCtaBen` — el banco del proveedor. Sirve para saber a qué banco va la cuenta de 10.
      if (!tieneRfc) t.text('rfc_banco_beneficiario').nullable();
    });
  }

  await knex.raw(
    `COMMENT ON COLUMN fiscal.cfdi_payment_links.cta_beneficiario IS ` +
      `'[PGP.23] La cuenta que el proveedor declaro en SU complemento de pago. TEXTO CRUDO: 18 digitos = CLABE, 10 = cuenta de banco (no sirve sola para SPEI). Opcional en el CFDI: solo 37% de los emisores la llenan.'`,
  );

  // Backfill desde el XML ya guardado. `nullif` evita escribir cadenas vacias.
  const r = await knex.raw(
    `UPDATE fiscal.cfdi_payment_links l
        SET cta_beneficiario       = nullif(btrim(substring(c.xml from 'CtaBeneficiario="([^"]*)"')), ''),
            rfc_banco_beneficiario = nullif(btrim(substring(c.xml from 'RfcEmisorCtaBen="([^"]*)"')), '')
       FROM fiscal.cfdis c
      WHERE c.tenant_id = l.tenant_id
        AND c.uuid = l.rep_uuid
        AND c.xml IS NOT NULL
        AND l.cta_beneficiario IS NULL
        AND c.xml LIKE '%CtaBeneficiario%'`,
  );
  const tocadas = r?.rowCount ?? 0;

  const [{ con_cuenta, provs }] = (
    await knex.raw(
      `SELECT count(*) FILTER (WHERE l.cta_beneficiario IS NOT NULL)::int AS con_cuenta,
              count(DISTINCT c.emisor_rfc) FILTER (WHERE l.cta_beneficiario IS NOT NULL)::int AS provs
         FROM fiscal.cfdi_payment_links l
         JOIN fiscal.cfdis c ON c.tenant_id = l.tenant_id AND c.uuid = l.rep_uuid`,
    )
  ).rows;

  // Se imprime lo que de verdad movio: un OK sin cifra no dice si sirvio.
  console.log(
    `[PGP.23] backfill: ${tocadas} fila(s) actualizadas · ${con_cuenta} enlaces con cuenta · ${provs} proveedor(es) distintos`,
  );
  if (Number(provs) === 0) {
    console.log('[PGP.23] ⚠️ CERO proveedores con cuenta: o no hay REP con xml, o el atributo cambio de nombre. REVISAR, no dar por bueno.');
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const tabla = 'cfdi_payment_links';
  const tieneCta = await knex.schema.withSchema('fiscal').hasColumn(tabla, 'cta_beneficiario');
  const tieneRfc = await knex.schema.withSchema('fiscal').hasColumn(tabla, 'rfc_banco_beneficiario');
  if (tieneCta || tieneRfc) {
    await knex.schema.withSchema('fiscal').alterTable(tabla, (t) => {
      if (tieneCta) t.dropColumn('cta_beneficiario');
      if (tieneRfc) t.dropColumn('rfc_banco_beneficiario');
    });
  }
};
