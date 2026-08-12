/**
 * CB.26 — Feed de tesorería de Kepler POR BANCO (ADR-033).
 *
 * La contabilidad de Kepler (kdc2 → analytics.bank_postings) postea todo al mayor
 * `102` sin desglosar. El desglose por banco vive en el MÓDULO DE TESORERÍA
 * (`md.kdm1`, encabezado de documento) donde `c45` = clave de la cuenta de banco.
 * Poblado por `import-kepler-bank-movements.js`: 1 fila por efecto-de-banco (un
 * traspaso emite 2 piernas: −origen c45, +destino c47), para conciliar por CUENTA.
 *
 * Reglas (confirmadas con el experto de BD Kepler, 2026-08-12):
 *   banco/caja = kdb1.c5 LIKE '102%' (excluye puente 402/210/ajuste).
 *   dirección por tipo de doc: U-A/X-A-45=entrada · X-D=salida · N-A-26=traspaso 2 piernas.
 *   importe=c16 (positivo); excluir c43='C'; fecha-valor=c9; fecha captura=c68.
 *   Kepler NO trae estado de cuenta ni conciliación: eso lo aporta la plataforma.
 *
 * Esta migración es el reflejo tracked del esquema que el importer materializa
 * (esquema rico: flujo/signo/es_traspaso/pierna/contra_clave), MÁS `account_label`:
 * el crosswalk de la clave de banco Kepler → finance.bank_accounts, que enlaza el
 * feed directo a las cuentas del tablero (usado por el cuadre 3 vías por cuenta).
 *
 * Idempotente: CREATE IF NOT EXISTS (entorno limpio) + ADD COLUMN IF NOT EXISTS
 * (prod, donde la tabla ya existe sin account_label) + backfill del crosswalk.
 * Patrón analytics.*: SIN RLS (tenant_id explícito), grant SELECT app_runtime.
 * @param { import("knex").Knex } knex
 */

// Crosswalk clave_banco (c45/kdb1) → finance.bank_accounts.account_label:
//   1) match exacto (nuestras labels SON el número de cuenta: 2169, 4176, 1463…)
//   2) caja: '0011' → 'CG' (CAJA GENERAL)
//   3) sufijo: el workbook recortó el dígito líder de 2 BAJÍO (Kepler 5854→854, 6506→506)
const BACKFILL_ACCOUNT_LABEL = `
  UPDATE analytics.kepler_bank_movements k
     SET account_label = sub.label
    FROM (
      SELECT d.tenant_id, d.clave_banco,
        COALESCE(
          (SELECT ba.account_label FROM finance.bank_accounts ba
             WHERE ba.tenant_id=d.tenant_id AND ba.account_label=d.clave_banco LIMIT 1),
          CASE WHEN d.clave_banco='0011' THEN 'CG' END,
          (SELECT ba.account_label FROM finance.bank_accounts ba
             WHERE ba.tenant_id=d.tenant_id AND length(ba.account_label)>=3
               AND d.clave_banco LIKE '%'||ba.account_label AND d.clave_banco<>ba.account_label
             ORDER BY length(ba.account_label) DESC LIMIT 1)
        ) AS label
      FROM (SELECT DISTINCT tenant_id, clave_banco FROM analytics.kepler_bank_movements) d
    ) sub
   WHERE k.tenant_id=sub.tenant_id AND k.clave_banco=sub.clave_banco
     AND sub.label IS NOT NULL AND k.account_label IS DISTINCT FROM sub.label`;

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  // Entorno limpio: crea la tabla rica (espejo del CREATE inline del importer) + account_label.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.kepler_bank_movements (
      tenant_id        uuid NOT NULL,
      sucursal         text NOT NULL,
      doc_tipo         text NOT NULL,        -- 'X-D-26','U-A-5','N-A-26',...
      folio            text NOT NULL,
      clave_banco      text NOT NULL,        -- kdm1.c45 / c47 (kdb1.c1)
      cuenta_contable  text,                 -- kdb1.c5 ('102-XXXX')
      banco_nombre     text,                 -- kdb1.c2
      tipo_cuenta      text,                 -- banco | caja | puente
      flujo            text NOT NULL,        -- entrada | salida | traspaso | otro
      importe          numeric NOT NULL,     -- c16 (positivo)
      signo            smallint,             -- +1 entra / −1 sale
      fecha_valor      date,                 -- c9
      fecha_captura    date,                 -- c68 (frescura)
      concepto         text,                 -- c24
      metodo           text,                 -- c31 (Tra/Che/Cob/Ant)
      beneficiario     text,                 -- c32
      es_traspaso      boolean DEFAULT false,
      contra_clave     text,                 -- banco de la otra pierna del traspaso (c47/c45)
      pierna           text,                 -- mov | origen | destino
      account_label    text,                 -- crosswalk → finance.bank_accounts (nullable)
      computed_at      timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, doc_tipo, folio, clave_banco)
    )`);
  // Prod: la tabla ya existe (creada por el importer) sin la columna del crosswalk.
  await knex.raw(`ALTER TABLE analytics.kepler_bank_movements ADD COLUMN IF NOT EXISTS account_label text`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_kbm_acct ON analytics.kepler_bank_movements (tenant_id, account_label, fecha_valor)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_kbm_clave ON analytics.kepler_bank_movements (tenant_id, clave_banco, fecha_valor)`);
  await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
  // Backfill del crosswalk (idempotente). En entorno limpio (tabla vacía) no hace nada.
  await knex.raw(BACKFILL_ACCOUNT_LABEL);
};

exports.down = async function (knex) {
  // Conserva la tabla (feed cargado); solo revierte la columna del crosswalk que agrega esta migración.
  await knex.raw(`ALTER TABLE analytics.kepler_bank_movements DROP COLUMN IF EXISTS account_label`);
};

exports.BACKFILL_ACCOUNT_LABEL = BACKFILL_ACCOUNT_LABEL;
