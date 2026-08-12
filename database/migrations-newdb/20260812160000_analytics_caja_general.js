/**
 * Fase CG.1 — Espejo del sistema Access de Finanzas ("Movimientos MegaDulces" y
 * "Movimientos Cajas") → analytics.caja_*.
 *
 * Dos sistemas en \\192.168.0.245\D (Z:), ver [reference_movimientos_finanzas_access]:
 *  - Sistema B "Base Movimientos SI/NO" = control venta diaria → depósito bancario
 *    (la capa operativa que falta entre el POS/Wincaja y el depósito en el banco;
 *    alimenta CAJA GENERAL y la conciliación CB). Espina de esta fase.
 *  - Sistema A "BMovimientosCajas" = arqueo de caja por denominación (caja 20 viva).
 *
 * analytics.* (SIN RLS, filtro tenant explícito) + GRANT SELECT a app_runtime.
 * Lo pueblan los importers movimientos-caja/import-*.js (read-only sobre los .mdb).
 * `source_instance` = SI|NO (instancia de la app, no razón social — la entidad real
 * es la columna `empresa`). Idempotente (hasTable) para reruns.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // --- Catálogo de bancos (Tipos Bancos) = crosswalk a finance.bank_accounts (CB) ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_bancos_catalog'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_bancos_catalog (
        tenant_id       uuid NOT NULL,
        source_instance text NOT NULL,             -- SI | NO
        banco_code      text NOT NULL,             -- 0 T Tipos Bancos.ID2 (=BancoDepositado)
        banco_name      text,                      -- Banamex/Banorte/BBVA/Bajio/Santander…
        es_banco        boolean DEFAULT false,
        es_cuenta       boolean DEFAULT false,
        es_cheques      boolean DEFAULT false,
        bank_account_label text,                   -- crosswalk manual → finance.bank_accounts (CB), NULL hasta ligar
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_instance, banco_code)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.caja_bancos_catalog TO app_runtime`);
  }

  // --- Catálogo de sucursales/almacenes (almacen → empresa/nombre) ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_sucursales_catalog'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_sucursales_catalog (
        tenant_id       uuid NOT NULL,
        source_instance text NOT NULL,
        almacen         text NOT NULL,             -- 0 T Sucursales.Almacen
        empresa         text,                      -- Mega Dulces De Los Altos / LFLG / ConfiGol / Fabrica De Botanas
        nombre          text,                      -- Nom Completo
        nombre_corto    text,
        es_nomina       boolean DEFAULT false,
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_instance, almacen)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.caja_sucursales_catalog TO app_runtime`);
  }

  // --- ESPINA: venta diaria por sucursal, partida por forma de pago vs depositado ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_ventas_diarias'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_ventas_diarias (
        tenant_id        uuid NOT NULL,
        source_instance  text NOT NULL,            -- SI | NO
        control          text NOT NULL,            -- 4 T VentasDiarias.Control (id de la app)
        empresa          text,                     -- resuelto por almacen
        almacen          text NOT NULL,
        venta_date       date,                     -- VentaDiariaFecha (fecha de negocio; acotada 2009-2027)
        capture_date     date,                     -- CapturaFecha (va meses adelante por rezago)
        captured_by      text,                     -- NombreCapturo
        venta_total      numeric NOT NULL DEFAULT 0,
        -- por forma de pago: monto vendido vs monto depositado
        efectivo         numeric DEFAULT 0, efectivo_deposito   numeric DEFAULT 0,
        morralla         numeric DEFAULT 0, morralla_deposito   numeric DEFAULT 0,
        cheques          numeric DEFAULT 0, cheques_deposito    numeric DEFAULT 0,
        tarjeta          numeric DEFAULT 0, tarjeta_deposito    numeric DEFAULT 0,
        caja_chica       numeric DEFAULT 0, caja_chica_deposito numeric DEFAULT 0,
        sobregiro        numeric DEFAULT 0, sobregiro_deposito  numeric DEFAULT 0,
        desglose         numeric DEFAULT 0,        -- descuadre venta − depositado (app)
        revisado         boolean DEFAULT false,
        eliminado        boolean DEFAULT false,
        observaciones    text,
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_instance, control)
      )`);
    await knex.raw(`CREATE INDEX ix_cajavd_fecha ON analytics.caja_ventas_diarias (tenant_id, venta_date)`);
    await knex.raw(`CREATE INDEX ix_cajavd_almacen ON analytics.caja_ventas_diarias (tenant_id, almacen, venta_date)`);
    await knex.raw(`GRANT SELECT ON analytics.caja_ventas_diarias TO app_runtime`);
  }

  // --- ESPINA: ledger de cada depósito bancario ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_depositos'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_depositos (
        tenant_id        uuid NOT NULL,
        source_instance  text NOT NULL,
        deposito_id      text NOT NULL,            -- 4 T VentasDiarias 1 Depositos.ID
        control          text,                     -- FK lógico → caja_ventas_diarias.control
        almacen          text,
        banco_code       text,                     -- BancoDepositado → caja_bancos_catalog
        banco_name       text,                     -- resuelto
        banco_cuenta     text,
        deposito_date       date,                  -- FechaDeposito (acotada 2009-2027)
        deposito_date_real  date,                  -- FechaDepositoReal (día real del banco)
        tipo_pago_code   text,                     -- Tipo → 0 T Tipos Pagos
        tipo_pago        text,                     -- Transferencia/Cheque/Efectivo/NotaCredito/Comision
        total_deposito      numeric DEFAULT 0,
        total_deposito_real numeric DEFAULT 0,
        comision         numeric DEFAULT 0,
        iva              numeric DEFAULT 0,
        revisado         boolean DEFAULT false,
        eliminado        boolean DEFAULT false,
        observaciones    text,
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_instance, deposito_id)
      )`);
    await knex.raw(`CREATE INDEX ix_cajadep_fecha ON analytics.caja_depositos (tenant_id, deposito_date)`);
    await knex.raw(`CREATE INDEX ix_cajadep_banco ON analytics.caja_depositos (tenant_id, banco_code)`);
    await knex.raw(`CREATE INDEX ix_cajadep_control ON analytics.caja_depositos (tenant_id, source_instance, control)`);
    await knex.raw(`GRANT SELECT ON analytics.caja_depositos TO app_runtime`);
  }

  // --- Arqueo de caja por denominación (Sistema A, caja 20/70) ---
  if (!(await knex.schema.withSchema('analytics').hasTable('caja_arqueos'))) {
    await knex.raw(`
      CREATE TABLE analytics.caja_arqueos (
        tenant_id      uuid NOT NULL,
        source_caja    text NOT NULL,              -- 20 | 70 | 0 (backend de origen)
        mov_id         text NOT NULL,              -- 0 T Movimientos.ID
        folio          text,                       -- A23104 / R.. / "Cancelado"
        tipo           text,                       -- Arqueo/Retiro/Corte/Deposito/FondoCaja
        almacen        text,
        caja           text,
        arqueo_date    date,
        capturo        text,
        total_billetes numeric DEFAULT 0,
        total_monedas  numeric DEFAULT 0,
        total_efectivo numeric DEFAULT 0,
        total_credito  numeric DEFAULT 0,
        total_cheques  numeric DEFAULT 0,
        total_tarjeta  numeric DEFAULT 0,
        total_dolares  numeric DEFAULT 0,
        mov_total      numeric DEFAULT 0,
        denom          jsonb,                      -- {B1000,B500,…,M100,…,Centavos} conteos
        revisado       boolean DEFAULT false,
        cancelado      boolean DEFAULT false,
        observaciones  text,
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, source_caja, mov_id)
      )`);
    await knex.raw(`CREATE INDEX ix_cajaarq_fecha ON analytics.caja_arqueos (tenant_id, arqueo_date)`);
    await knex.raw(`CREATE INDEX ix_cajaarq_tipo ON analytics.caja_arqueos (tenant_id, source_caja, tipo)`);
    await knex.raw(`GRANT SELECT ON analytics.caja_arqueos TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_arqueos');
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_depositos');
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_ventas_diarias');
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_sucursales_catalog');
  await knex.schema.withSchema('analytics').dropTableIfExists('caja_bancos_catalog');
};
