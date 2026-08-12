/**
 * CB.26 — Feed de tesorería de Kepler POR BANCO (ADR-033).
 *
 * La contabilidad de Kepler (kdc2 → analytics.bank_postings) postea todo al mayor
 * `102` sin desglosar. El desglose por banco vive en el MÓDULO DE TESORERÍA
 * (`md.kdm1`, encabezado de documento) donde `c45` = clave de la cuenta de banco.
 * Este espejo, poblado por `import-kepler-bank-movements.js`, trae 1 fila por
 * efecto-de-banco de cada documento (un traspaso emite 2: salida origen + entrada
 * destino), para conciliar por CUENTA contra el estado de cuenta.
 *
 * Reglas (confirmadas con el experto de BD Kepler):
 *   - banco/caja = kdb1.c5 LIKE '102%' (excluye puente 402/210/ajuste).
 *   - dirección por tipo de doc: U-A(cobro)=entrada · X-D(pago/cheque)=salida ·
 *     N-A(traspaso)=salida c45 + entrada destino c47.
 *   - importe = c16 (siempre positivo); excluir c43='C' (cancelado).
 *   - fecha-valor = c9 (bucket del periodo); fecha de captura = c68 (frescura).
 *   - Kepler NO trae estado de cuenta ni conciliación: el matching lo aporta la plataforma.
 *
 * Patrón analytics.*: SIN RLS (tenant_id explícito), grant SELECT app_runtime.
 * Idempotente (hasTable). @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('kepler_bank_movements'))) {
    await knex.raw(`
      CREATE TABLE analytics.kepler_bank_movements (
        tenant_id        uuid NOT NULL,
        client_uuid      text NOT NULL,
        sucursal         text,
        doc_tipo         text,                 -- 'XD2601','UA0501','NA2601',...
        folio            text,
        banco_clave      text NOT NULL,        -- kdm1.c45 / c47 (kdb1.c1)
        cuenta_contable  text,                 -- kdb1.c5 ('102-XXXX')
        banco_nombre     text,                 -- kdb1.c2
        account_label    text,                 -- crosswalk → finance.bank_accounts (nullable)
        direccion        text NOT NULL,        -- entrada | salida | traspaso_in | traspaso_out | otro
        importe          numeric NOT NULL,
        fecha            date,                 -- c9 (fecha-valor; bucket del periodo)
        fecha_captura    date,                 -- c68 (frescura del feed)
        anio_mes         text,                 -- derivado de c9 (fecha-valor)
        metodo           text,                 -- c31 (Tra/Che/Cob/Ant)
        beneficiario     text,                 -- c32
        computed_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, client_uuid)
      )`);
    await knex.raw(`CREATE INDEX ix_kbm_acct ON analytics.kepler_bank_movements (tenant_id, anio_mes, account_label)`);
    await knex.raw(`CREATE INDEX ix_kbm_clave ON analytics.kepler_bank_movements (tenant_id, anio_mes, banco_clave)`);
    await knex.raw(`CREATE INDEX ix_kbm_dir ON analytics.kepler_bank_movements (tenant_id, anio_mes, direccion)`);
    await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('kepler_bank_movements');
};
