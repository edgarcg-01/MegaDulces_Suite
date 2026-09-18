/**
 * CG.13 — El libro de caja: la plataforma pasa a ser la FUENTE PRINCIPAL del efectivo (ADR-070).
 *
 * Reemplaza la captura de `Doctos` del Access `Control` (medido 2026-09-18, sucursal 20:
 * 116,480 movimientos / $1,302M, capturado ese mismo día). Los tres defectos caros de ese
 * sistema NACEN AL TECLEAR, así que acá mueren POR CONSTRUCCIÓN, no por reporte:
 *
 *   §5.2  34 folios repetidos (`DMax("IdDocto")+1` en el cliente, sin bloqueo, 5 capturistas)
 *         → `finance.cash_ledger_sequences` con UPSERT atómico (patrón commercial.order_sequences)
 *           + UNIQUE (tenant_id, folio).
 *   §5.3  2,387 movs de 2026 sin concepto por $71,958,648 = 46.7% del dinero del año
 *         → `glosa` NOT NULL + CHECK de longitud mínima.  Y además `kepler_cuenta`/
 *           `kepler_concepto` NOT NULL: el concepto dice A QUÉ CUENTA VA, la glosa dice QUÉ PASÓ.
 *           Confundirlos es exactamente cómo se llega a 2,387 renglones sin explicación.
 *   §5.6  1,625 movs de un usuario genérico "Auxiliar"
 *         → `created_by` uuid NOT NULL (el user_id del JWT), con snapshot del username.
 *
 * Y §5.4 (concepto y sucursal fundidos en las 122 cuentas de Control): acá `sucursal` y
 * `centro_costo` son DIMENSIONES PROPIAS, nunca embebidas en el concepto.
 *
 * `autofill` jsonb guarda DE DÓNDE salió cada campo autorrellenado y con qué confianza
 * (contrato de procedencia, VP.2.1 / ADR-056): un campo lleno sin procedencia es
 * indistinguible de uno inventado.
 *
 * Denominaciones en tabla hija (no jsonb) para que el arqueo sea VERIFICABLE en SQL:
 * `sum(denominacion * piezas) + morralla = monto`.
 *
 * RLS FORZADO + grants app_runtime. Idempotente (hasTable). Aditiva: no toca nada existente.
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // --- Secuencia de folio: el antídoto de los 34 duplicados ---------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_sequences'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_sequences (
        tenant_id     uuid    NOT NULL,
        year          int     NOT NULL,
        tipo          text    NOT NULL,
        current_value int     NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, year, tipo)
      )`);
    await tenantRls(knex, 'cash_ledger_sequences');
  }

  // --- El libro -----------------------------------------------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,

        -- identidad
        folio               text NOT NULL,                 -- CI-2026-00001 / CG-… / CD-…
        tipo                text NOT NULL,                 -- ingreso | gasto | deposito
        client_uuid         uuid,                          -- idempotencia de la captura

        -- cuándo y dónde
        fecha               date NOT NULL,
        hora                time,
        sucursal            text NOT NULL,                 -- dimensión propia (§5.4)
        centro_costo        text,                          -- kdc3, dimensión propia

        -- el vínculo contable con Kepler (§7) — obligatorio, ADR-070
        kepler_cuenta           text NOT NULL,             -- subcuenta, ej '601-001'
        kepler_concepto         text NOT NULL,             -- código,    ej '001'
        kepler_cuenta_nombre    text,                      -- snapshot al guardar
        kepler_concepto_nombre  text,                      -- snapshot al guardar

        -- qué pasó (≠ a qué cuenta va)
        glosa               text NOT NULL,
        beneficiario        text,
        beneficiario_rfc    varchar(13),

        -- el dinero
        monto               numeric(18,2) NOT NULL,
        morralla            numeric(18,2) NOT NULL DEFAULT 0,

        -- de dónde salió (Nivel 1 del autorrelleno: se LIGA, no se teclea)
        origen_tipo         text,                          -- cfdi | recepcion | pago_proveedor | cobro | banco | manual
        origen_ref          text,                          -- folio/id del documento
        origen_uuid         varchar(36),                   -- UUID del CFDI cuando aplica

        -- procedencia del autorrelleno: qué campo vino de qué fuente y con qué confianza
        autofill            jsonb,

        -- estado y control interno
        estado              text NOT NULL DEFAULT 'registrado',  -- registrado | en_corte | cancelado
        corte_id            uuid,

        -- trazabilidad con el sistema que se retira
        legacy_cuenta_access text,
        legacy_tipo_dto      int,
        legacy_id_docto      text,

        -- auditoría (§5.6: autor REAL, no un texto)
        created_by          uuid NOT NULL,
        created_by_username text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_by          uuid,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        deleted_at          timestamptz,

        CONSTRAINT cash_ledger_tipo_chk      CHECK (tipo IN ('ingreso','gasto','deposito')),
        CONSTRAINT cash_ledger_estado_chk    CHECK (estado IN ('registrado','en_corte','cancelado')),
        CONSTRAINT cash_ledger_monto_chk     CHECK (monto > 0),
        CONSTRAINT cash_ledger_morralla_chk  CHECK (morralla >= 0),
        -- §5.3: la glosa no puede ser un espacio ni "x"
        CONSTRAINT cash_ledger_glosa_chk     CHECK (length(btrim(glosa)) >= 5),
        -- el par contable no puede venir en blanco (§7.5)
        CONSTRAINT cash_ledger_cuenta_chk    CHECK (length(btrim(kepler_cuenta)) > 0),
        CONSTRAINT cash_ledger_concepto_chk  CHECK (length(btrim(kepler_concepto)) > 0),
        CONSTRAINT cash_ledger_origen_chk    CHECK (origen_tipo IS NULL OR origen_tipo IN
                                              ('cfdi','recepcion','pago_proveedor','cobro','banco','manual'))
      )`);
    // §5.2: un folio, una vez. Es el candado, no una convención.
    await knex.raw(`CREATE UNIQUE INDEX ux_cash_ledger_folio ON finance.cash_ledger (tenant_id, folio)`);
    // idempotencia de la captura (reintento del cliente ≠ movimiento nuevo)
    await knex.raw(`CREATE UNIQUE INDEX ux_cash_ledger_client_uuid ON finance.cash_ledger (tenant_id, client_uuid) WHERE client_uuid IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_cash_ledger_fecha ON finance.cash_ledger (tenant_id, fecha DESC)`);
    await knex.raw(`CREATE INDEX ix_cash_ledger_cuenta ON finance.cash_ledger (tenant_id, kepler_cuenta, kepler_concepto)`);
    await knex.raw(`CREATE INDEX ix_cash_ledger_sucursal ON finance.cash_ledger (tenant_id, sucursal, fecha DESC)`);
    await knex.raw(`CREATE INDEX ix_cash_ledger_origen ON finance.cash_ledger (tenant_id, origen_tipo, origen_ref) WHERE origen_tipo IS NOT NULL`);
    await tenantRls(knex, 'cash_ledger');
  }

  // --- Denominaciones: el arqueo, verificable en SQL -----------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_denominations'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_denominations (
        tenant_id      uuid NOT NULL,
        cash_ledger_id uuid NOT NULL REFERENCES finance.cash_ledger(id) ON DELETE CASCADE,
        denominacion   numeric(10,2) NOT NULL,
        piezas         int NOT NULL,
        PRIMARY KEY (tenant_id, cash_ledger_id, denominacion),
        CONSTRAINT cash_denom_piezas_chk CHECK (piezas > 0),
        -- las 14 que Control maneja (B1000..B20 billetes, M20..M01 monedas). La morralla
        -- suelta va en cash_ledger.morralla, no acá.
        CONSTRAINT cash_denom_valor_chk CHECK (denominacion IN
          (1000,500,200,100,50,20,10,5,2,1,0.50,0.20,0.10,0.05))
      )`);
    await knex.raw(`CREATE INDEX ix_cash_denom_mov ON finance.cash_ledger_denominations (tenant_id, cash_ledger_id)`);
    await tenantRls(knex, 'cash_ledger_denominations');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_denominations');
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger');
  await knex.schema.withSchema('finance').dropTableIfExists('cash_ledger_sequences');
};
