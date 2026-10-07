/**
 * CS.1 — Espejo de los movimientos de CAOS (caja fuerte de efectivo).
 *
 * CAOS (192.168.0.110, dispositivo AST700 / protocolo C-Link) es un sistema EXTERNO: mueve el
 * efectivo físico (Depósito / Dispensar / Dotar / Cambio / Vaciar…) con detalle por denominación,
 * por usuario y con un `ref` operativo. No está en nuestro Postgres, así que NO se puede derivar
 * como vista sobre `kepler_ods` — se espeja en una tabla propia alimentada por un feed on-prem
 * (excepción de "sistema externo con su propia base"). Ver `docs/CAOS_CASH_SYSTEM.md` y ADR Fase CS
 * (hereda ADR-034 el patrón adapter-sin-API).
 *
 * ── Por qué en `analytics.*` y SIN RLS ──────────────────────────────────────────────────────────
 * Es un espejo alimentado por un IMPORTER, no por la app. El importer no corre dentro de
 * `TenantContextService`, así que una RLS forzada con `WITH CHECK (tenant_id = current_tenant_id())`
 * le rechazaría los inserts. Mismo patrón que `analytics.kepler_bank_movements` y
 * `logistics.vehicle_positions`: SIN RLS, `tenant_id` explícito, y la LECTURA filtra por tenant a
 * mano (como ya lo hace la bandeja de Caja General sobre kepler_bank_movements).
 *
 * ── Diseño ──────────────────────────────────────────────────────────────────────────────────────
 * - `external_id` = el `id` de CAOS (secuencia contigua) → watermark. UNIQUE `(tenant_id, device,
 *   external_id)`; el id es por dispositivo (hoy uno; `sharedDBEnabled=false`).
 * - `_row_hash` (md5 del payload) → UPSERT sólo reescribe si cambió (anti-churn, como
 *   `access-replicate.js`).
 * - Denominaciones en tabla HIJA (no jsonb) para cruzar el arqueo EN SQL contra
 *   `finance.cash_ledger_denominations` (CS.4): `sum(denom*quantity) = total`.
 * - `raw` jsonb = respuesta cruda (procedencia, ADR-056).
 *
 * Aditiva e idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // --- El movimiento (espejo) ---------------------------------------------------------------
  if (!(await knex.schema.withSchema('analytics').hasTable('caos_cash_movements'))) {
    await knex.raw(`
      CREATE TABLE analytics.caos_cash_movements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,

        -- identidad en CAOS
        device            text NOT NULL,                 -- devName, ej. 'AST700-19758'
        external_id       bigint NOT NULL,               -- CAOS id (secuencia contigua = watermark)

        -- clasificación
        type_id           smallint NOT NULL,             -- 0 Deposito, 4 Dispensar, 8 Dotar, ...
        type_label        text NOT NULL,                 -- etiqueta de getConfiguration

        -- cuándo
        occurred_at       timestamptz NOT NULL,          -- 'date' (fecha+hora del movimiento)
        accounting_date   date,                          -- 'accountingDate' (para cuadrar período)

        -- quién / cuánto / por qué
        user_external     text,                          -- 'user', ej. 'Vendedor (006) - VENTAS'
        total             numeric(18,2) NOT NULL,        -- suma del efectivo del movimiento
        currency          text NOT NULL DEFAULT 'MXN',
        ref               text,                          -- 'ruta 27 240926' / 'pagos gdl'
        shift_id          text,

        -- extras poco frecuentes (no se cruzan aún)
        cheques           jsonb NOT NULL DEFAULT '[]'::jsonb,
        tickets           jsonb NOT NULL DEFAULT '[]'::jsonb,

        -- procedencia + control del feed
        raw               jsonb,                         -- respuesta cruda de getTransactionDetails
        _row_hash         text NOT NULL,                 -- md5 del payload normalizado (anti-churn)
        synced_at         timestamptz NOT NULL DEFAULT now(),

        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT caos_mov_total_chk CHECK (total >= 0)
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_mov_ext ON analytics.caos_cash_movements (tenant_id, device, external_id)`);
    await knex.raw(`CREATE INDEX ix_caos_mov_fecha ON analytics.caos_cash_movements (tenant_id, occurred_at DESC)`);
    await knex.raw(`CREATE INDEX ix_caos_mov_tipo ON analytics.caos_cash_movements (tenant_id, type_id, occurred_at DESC)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.caos_cash_movements TO app_runtime`);
  }

  // --- Detalle por denominación (hija) ------------------------------------------------------
  if (!(await knex.schema.withSchema('analytics').hasTable('caos_cash_denominations'))) {
    await knex.raw(`
      CREATE TABLE analytics.caos_cash_denominations (
        tenant_id      uuid NOT NULL,
        movement_id    uuid NOT NULL REFERENCES analytics.caos_cash_movements(id) ON DELETE CASCADE,
        denom          numeric(10,2) NOT NULL,           -- 500/200/100/50/20/...
        pieza_tipo     text NOT NULL DEFAULT 'B',        -- 'B' billete (CAOS type)
        quantity       int NOT NULL,
        PRIMARY KEY (tenant_id, movement_id, denom, pieza_tipo),
        CONSTRAINT caos_denom_qty_chk CHECK (quantity > 0),
        CONSTRAINT caos_denom_valor_chk CHECK (denom > 0)
      )`);
    await knex.raw(`CREATE INDEX ix_caos_denom_mov ON analytics.caos_cash_denominations (tenant_id, movement_id)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.caos_cash_denominations TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('caos_cash_denominations');
  await knex.schema.withSchema('analytics').dropTableIfExists('caos_cash_movements');
};
