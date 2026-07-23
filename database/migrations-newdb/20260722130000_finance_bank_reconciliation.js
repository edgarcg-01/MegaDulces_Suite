/**
 * CB.0 — Conciliación bancaria (ADR-033). Schema `finance.bank_*`.
 *
 * Reemplaza el workbook Excel manual ("CUENTAS LUIS FRANCISCO", 19 cuentas de banco
 * + caja + factoraje, ~4,865 movimientos/mes clasificados a mano) por una interfaz:
 * subir estado de cuenta → clasificar con catálogo controlado → conciliar contra
 * Kepler (102 cobranza / 201-102 pagos / 6xx gastos) → rastrear diferencias.
 *
 * Tablas:
 *   finance.bank_accounts       = las cuentas de banco/caja/factoraje como entidad.
 *   finance.movement_categories = catálogo LIMPIO alineado a Kepler (reemplaza los
 *                                 códigos sobrecargados del Excel 612/613/147/510…).
 *   finance.bank_statements     = estado de cuenta por (cuenta × periodo): saldos + totales.
 *   finance.bank_movements      = una fila por línea del estado de cuenta.
 *   finance.bank_recon_matches  = cruce movimiento banco ↔ posting Kepler.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado (current_tenant_id()) + grants
 * app_runtime. Services vía TenantKnexService.run(). Idempotente (hasTable). Seed del
 * catálogo vía SET LOCAL app.tenant_id (pasa el WITH CHECK de la policy) + ON CONFLICT.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

async function createTenantRls(knex, table) {
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

// Catálogo limpio: código → cuenta Kepler + grupo (columnas estilo CONCENTRADO).
const CATEGORIES = [
  // code, name, flow, kepler_account, group_key, kepler_note
  ['cobranza',              'Cobranza (venta cobrada)',  'in',   '102/115', 'ingreso',       'Depósito de venta; en Kepler C 102 / A 115 (doc UA0501)'],
  ['ingreso_devolucion',    'Ingreso por devolución',    'in',   null,      'devolucion',    'Reingreso de un pago/dev previo'],
  ['compra_mercancia',      'Compra de mercancía',       'out',  '511',     'compra',        'Pago a proveedor; costo 511, pago C 201 / A 102 (XD2601)'],
  ['compra_factoraje',      'Compra con factoraje',      'out',  '201/210', 'factoraje',     'Compra financiada por factoraje'],
  ['pago_factoraje',        'Pago a factoraje',          'out',  '210',     'factoraje',     'Pago del crédito de factoraje (Financiera Bajío)'],
  ['nomina',                'Nómina',                    'out',  '601',     'gasto',         'Dispersión de nómina'],
  ['imss_sua',              'IMSS / SUA',                'out',  '601',     'gasto',         'Cuota IMSS/SUA; en Kepler vive en 601 (mayor 762 está en $0). Corregido CB.9.3'],
  ['pension_alimenticia',   'Pensión alimenticia',       'out',  '601',     'gasto',         'Retención de nómina'],
  ['comision_bancaria',     'Comisión bancaria',         'out',  '611-003', 'gasto',         'Comisión del banco (NO 612, que en Kepler=robo)'],
  ['iva_acreditable',       'IVA acreditable',           'out',  '122',     'gasto',         'IVA de comisiones/servicios'],
  ['renta',                 'Arrendamiento',             'out',  '603',     'gasto',         'Rentas/arrendamiento'],
  ['traslado_valores',      'Traslado de valores',       'out',  '602',     'gasto',         'Servicio Pan Americano y similares'],
  ['gasto_admin',           'Gasto administrativo',      'out',  '608',     'gasto',         'Tarjetas, domiciliaciones, servicios varios'],
  ['pago_credito',          'Pago de crédito (capital)', 'out',  '210/103', 'financiero',    'Amortización de capital de crédito'],
  ['caja_ahorro',           'Caja de ahorro',            'out',  null,      'financiero',    'Aportación/préstamo a caja de ahorro (cuenta por definir)'],
  ['traspaso_entre_cuentas','Traspaso entre cuentas',    'both', null,      'traspaso',      'Movimiento entre cuentas propias (neto 0, sin P&L)'],
  ['devolucion_spei',       'Devolución SPEI',           'both', null,      'devolucion',    'Reverso/devolución de un SPEI'],
  ['sin_clasificar',        'Sin clasificar',            'none', null,      'sin_clasificar','Bandeja: línea importada sin categoría — resolver en la UI'],
];

// Las 19 cuentas de banco + caja + factoraje del workbook (enero 2026).
const ACCOUNTS = [
  ['SANTANDER', '2169', 'SNTDR 2169', 'bank'],
  ['SANTANDER', '1604', 'SNTDR 1604', 'bank'],
  ['SANTANDER', '1621', 'SNTDR 1621', 'bank'],
  ['SANTANDER', '5565', 'SNTDR 5565', 'bank'],
  ['BANAMEX',   '1463', 'BNMX 1463',  'bank'],
  ['BBVA',      '5712', 'BBVA 5712',  'bank'],
  ['BBVA',      '6586', 'BBVA 6586',  'bank'],
  ['BBVA',      '4176', 'BBVA 4176',  'bank'],
  ['BBVA',      '4885', 'BBVA 4885',  'bank'],
  ['BBVA',      '6721', 'BBVA 6721',  'bank'],
  ['BBVA',      '2182', 'BBVA 2182',  'bank'],
  ['BANORTE',   '3041', 'BTE 3041',   'bank'],
  ['BANORTE',   '7744', 'BTE 7744',   'bank'],
  ['BANORTE',   '7133', 'BTE 7133',   'bank'],
  ['BBAJIO',    '3660', 'BB 3660',    'bank'],
  ['BBAJIO',    '4166', 'BB 4166',    'bank'],
  ['BBAJIO',    '854',  'BB 854',     'bank'],
  ['BBAJIO',    '506',  'BB 506',     'bank'],
  ['CAJA',      'CG',   'CAJA GENERAL', 'cash'],
  ['FACTORAJE', 'FAC',  'FACTORAJE',  'factoraje'],
];

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(`GRANT USAGE ON SCHEMA finance TO app_runtime`);

  // ── finance.bank_accounts ──
  if (!(await knex.schema.withSchema('finance').hasTable('bank_accounts'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_accounts (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        bank          text NOT NULL,                 -- SANTANDER | BBVA | BANORTE | BBAJIO | BANAMEX | CAJA | FACTORAJE
        account_label text NOT NULL,                 -- '2169', '1463', 'CG', 'FAC'
        alias         text,                          -- nombre de la hoja Excel ('SNTDR 2169')
        kind          text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank','cash','factoraje')),
        kepler_link   text,                          -- cómo mapea al 102 de Kepler (c7 / subcuenta) — F4
        active        boolean NOT NULL DEFAULT true,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, bank, account_label)
      )`);
    await createTenantRls(knex, 'bank_accounts');
  }

  // ── finance.movement_categories (catálogo limpio) ──
  if (!(await knex.schema.withSchema('finance').hasTable('movement_categories'))) {
    await knex.raw(`
      CREATE TABLE finance.movement_categories (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        code           text NOT NULL,                -- 'cobranza','compra_mercancia',...
        name           text NOT NULL,
        flow           text NOT NULL CHECK (flow IN ('in','out','both','none')),
        kepler_account text,                          -- '511','601','122',... (null = no aplica)
        group_key      text NOT NULL,                 -- ingreso|compra|gasto|factoraje|financiero|traspaso|devolucion|sin_clasificar
        kepler_note    text,
        sort_order     int NOT NULL DEFAULT 0,
        active         boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, code)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_movcat_group ON finance.movement_categories (tenant_id, group_key, active)`);
    await createTenantRls(knex, 'movement_categories');
  }

  // ── finance.bank_statements (por cuenta × periodo) ──
  if (!(await knex.schema.withSchema('finance').hasTable('bank_statements'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_statements (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        bank_account_id uuid NOT NULL REFERENCES finance.bank_accounts(id) ON DELETE CASCADE,
        period          text NOT NULL,               -- 'YYYY-MM'
        opening_balance numeric NOT NULL DEFAULT 0,
        closing_balance numeric NOT NULL DEFAULT 0,
        total_in        numeric NOT NULL DEFAULT 0,   -- suma depósitos (validar vs CONCENTRADO)
        total_out       numeric NOT NULL DEFAULT 0,   -- suma retiros
        source_file     text,
        status          text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','reconciling','closed')),
        imported_at     timestamptz,
        imported_by     text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, bank_account_id, period)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_stmt_period ON finance.bank_statements (tenant_id, period)`);
    await createTenantRls(knex, 'bank_statements');
  }

  // ── finance.bank_movements (una fila por línea) ──
  if (!(await knex.schema.withSchema('finance').hasTable('bank_movements'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_movements (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        statement_id    uuid NOT NULL REFERENCES finance.bank_statements(id) ON DELETE CASCADE,
        bank_account_id uuid NOT NULL REFERENCES finance.bank_accounts(id) ON DELETE CASCADE,
        movement_date   date NOT NULL,
        category_id     uuid REFERENCES finance.movement_categories(id),  -- null = sin_clasificar
        raw_type        text,                        -- M original del Excel (I/G/C/TE/TI/CF/PF/DS/ID)
        raw_code        text,                        -- C original del Excel (102/510/612/147…)
        sucursal        text,                        -- S del Excel (plaza de origen)
        concept         text,                        -- PROVEEDOR / descripción
        amount_in       numeric NOT NULL DEFAULT 0,  -- depósito
        amount_out      numeric NOT NULL DEFAULT 0,  -- retiro
        running_balance numeric,
        recon_status    text NOT NULL DEFAULT 'pending' CHECK (recon_status IN ('pending','matched','unmatched','ignored')),
        client_uuid     text NOT NULL,               -- hash de la línea → idempotencia del import (UPSERT, no DELETE)
        source_file     text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, client_uuid)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_mov_stmt ON finance.bank_movements (tenant_id, statement_id)`);
    await knex.raw(`CREATE INDEX ix_fin_mov_acct_date ON finance.bank_movements (tenant_id, bank_account_id, movement_date)`);
    await knex.raw(`CREATE INDEX ix_fin_mov_recon ON finance.bank_movements (tenant_id, recon_status)`);
    await knex.raw(`CREATE INDEX ix_fin_mov_uncat ON finance.bank_movements (tenant_id) WHERE category_id IS NULL`);
    await createTenantRls(knex, 'bank_movements');
  }

  // ── finance.bank_recon_matches (banco ↔ Kepler) ──
  if (!(await knex.schema.withSchema('finance').hasTable('bank_recon_matches'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_recon_matches (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        bank_movement_id uuid NOT NULL REFERENCES finance.bank_movements(id) ON DELETE CASCADE,
        kepler_sucursal  text,
        kepler_doc_tipo  text,
        kepler_doc_folio text,
        kepler_cuenta    text,
        kepler_amount    numeric,
        match_type       text NOT NULL DEFAULT 'manual' CHECK (match_type IN ('exact','inferred','manual')),
        match_confidence numeric,
        matched_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, bank_movement_id, kepler_doc_tipo, kepler_doc_folio)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_match_mov ON finance.bank_recon_matches (tenant_id, bank_movement_id)`);
    await createTenantRls(knex, 'bank_recon_matches');
  }

  // ── Seed del tenant mega_dulces (SET LOCAL pasa el WITH CHECK de la policy) ──
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);

  for (let i = 0; i < CATEGORIES.length; i++) {
    const [code, name, flow, kepler, group, note] = CATEGORIES[i];
    await knex.raw(
      `INSERT INTO finance.movement_categories (tenant_id, code, name, flow, kepler_account, group_key, kepler_note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [MEGA, code, name, flow, kepler, group, note, i * 10],
    );
  }

  for (const [bank, label, alias, kind] of ACCOUNTS) {
    await knex.raw(
      `INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, alias, kind)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, bank, account_label) DO NOTHING`,
      [MEGA, bank, label, alias, kind],
    );
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('bank_recon_matches');
  await knex.schema.withSchema('finance').dropTableIfExists('bank_movements');
  await knex.schema.withSchema('finance').dropTableIfExists('bank_statements');
  await knex.schema.withSchema('finance').dropTableIfExists('movement_categories');
  await knex.schema.withSchema('finance').dropTableIfExists('bank_accounts');
};
