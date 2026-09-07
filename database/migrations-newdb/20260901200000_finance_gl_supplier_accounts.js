/**
 * LC.3 (Fase LC, ADR-052) — Mapa proveedor → cuentas contables del libro de compras.
 *
 * Cada proveedor tiene tres cuentas en ContPAQi, todas con el MISMO sufijo de 7 dígitos:
 *   212<sufijo> = PROVEEDORES (pasivo)   · 501<sufijo> = COMPRAS AL 0%
 *   502<sufijo> = COMPRAS C/IVA
 * El asiento mensual postea a las tres, así que el generador del TXT necesita resolver
 * `RFC del emisor → sufijo` para cada CFDI.
 *
 * ── De dónde sale el mapa (y de dónde NO) ────────────────────────────────────────────
 * Sale de la hoja `DATOS` del workbook "LIBRO DE COMPRAS": 1,009 proveedores con clave,
 * nombre, RFC y número de cuenta. Verificado 2026-09-01 contra las 177 cuentas `212` que
 * el asiento realmente usa: **177 de 177 empatan, y el nombre coincide en 175** (las otras
 * dos difieren solo en puntuación: "CANEL'S" vs "CANELS", "S. DE R.L." vs "S DE RL").
 *
 * **NO sale de `analytics.contpaqi_suppliers`.** Su `codigo` empata numéricamente con el
 * sufijo en 142 de 177 casos, pero es un empate espurio: el código 2 es "MARIA SILVIA
 * ANDRADE BARRA" mientras que la cuenta `2120000002` es "ACEITES GRASAS Y DERIVADOS". Los
 * catálogos de Proveedores y de Cuentas de ContPAQi se numeran por separado. Se descartó
 * al contrastar los nombres — el número solo nunca alcanza.
 *
 * ── Por qué se guarda si la cuenta EXISTE ────────────────────────────────────────────
 * El TXT no puede citar una cuenta que ContPAQi no tenga: la importación falla. Se valida
 * contra el catálogo `Cuentas` y se guarda el resultado. Medido: de 931 proveedores con
 * cuenta, 928 tienen la de pasivo y la de compra exenta, y 917 la de compra con IVA — hay
 * 14 sin cuenta `502`, que es correcto (nunca han facturado con IVA).
 *
 * RLS forzado como el resto de `finance.*`. Poblada por `import-supplier-accounts.js` y
 * editable desde la UI (el script es solo para el sembrado inicial).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('gl_supplier_accounts'))) {
    await knex.raw(`
      CREATE TABLE finance.gl_supplier_accounts (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        supplier_code         text,                  -- CLAVE del catálogo (ej. 'PLH')
        supplier_name         text NOT NULL,
        rfc                   varchar(13),           -- 102 del catálogo no lo traen
        account_suffix        text NOT NULL,         -- '0000108' — la llave real
        cuenta_proveedor      text NOT NULL,         -- 212<sufijo>
        cuenta_compra_exenta  text,                  -- 501<sufijo>
        cuenta_compra_iva     text,                  -- 502<sufijo>
        proveedor_existe      boolean,               -- ¿la cuenta existe en ContPAQi?
        compra_exenta_existe  boolean,
        compra_iva_existe     boolean,
        verificado_at         timestamptz,
        usado_en_asiento      boolean NOT NULL DEFAULT false, -- ya aparece en pólizas reales
        source                text NOT NULL DEFAULT 'libro_compras_xlsx',
        activo                boolean NOT NULL DEFAULT true,
        notas                 text,
        created_at            timestamptz NOT NULL DEFAULT now(),
        created_by            uuid,
        updated_at            timestamptz NOT NULL DEFAULT now(),
        updated_by            uuid,
        deleted_at            timestamptz,
        deleted_by            uuid,
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, account_suffix)
      )`);
    // El lookup del generador es por RFC del emisor del CFDI. Parcial: hay proveedores sin RFC.
    await knex.raw(`CREATE INDEX ix_gl_sup_acc_rfc ON finance.gl_supplier_accounts (tenant_id, rfc) WHERE rfc IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_gl_sup_acc_activo ON finance.gl_supplier_accounts (tenant_id) WHERE deleted_at IS NULL`);

    await knex.raw(`ALTER TABLE finance.gl_supplier_accounts ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.gl_supplier_accounts FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY gl_supplier_accounts_tenant ON finance.gl_supplier_accounts
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.gl_supplier_accounts TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('gl_supplier_accounts');
};
