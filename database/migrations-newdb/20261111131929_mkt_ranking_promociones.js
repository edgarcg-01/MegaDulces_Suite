'use strict';
/**
 * `[MKT.9]` — Ranking de promociones de Marketing: lo que hoy vive en el Excel semanal
 * «RANKING SEMANA NN» pasa a la suite. Aquí sólo se guarda lo que **una persona decide**; la venta
 * NO se copia: se deriva en vivo de `analytics.v_kepler_sales_lines` (regla principal: cero
 * importers).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ────────────────────────────────────────
 *  · La «VENTA» del Excel es la CANTIDAD del código de promo (código simbólico de `kdii`, $0.01 /
 *    «= GRATIS», ERP_KEPLER §2.9) en el canal MOSTRADOR, de lunes a domingo: reproduce 186 de 229
 *    renglones de la semana 45 exactos (81 %) y 201 con ±1 (88 %). Los que no cuadran son errores
 *    del Excel (objetivo tecleado como venta, preventa sumada a veces sí y a veces no).
 *  · Kepler NO guarda la vigencia de una promo y REUTILIZA el código (25 de 117 códigos con varias
 *    promos). Por eso la promo se da de ALTA aquí, con su vigencia y la descripción vista al darla
 *    de alta.
 *  · El objetivo del Excel no tiene regla (a mano, INV/4, INV/10, = INV). Aquí se guarda por
 *    promo × sucursal × canal × vendedor, con su FUENTE (sugerido por el sistema o capturado).
 *  · Los incentivos «$X por caja / por cada $Y / por cliente» se calculan de la misma venta; el que
 *    no tiene fuente en Kepler («por exhibidor colocado») se CAPTURA y se declara capturado.
 *
 * Tablas nuevas, sin tocar ninguna existente. RLS forzado por tenant. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = ['mkt_ranking_promos', 'mkt_ranking_objectives', 'mkt_incentives', 'mkt_incentive_captures'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.mkt_ranking_promos (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      code                 varchar(20)  NOT NULL,
      descripcion_kepler   text,
      mecanica             text NOT NULL,
      vigencia_desde       date NOT NULL,
      vigencia_hasta       date,
      canales              text[] NOT NULL DEFAULT ARRAY['mostrador']::text[],
      warehouse_codes      text[],
      activo               boolean NOT NULL DEFAULT true,
      notas                text,
      created_by           uuid,
      created_by_username  varchar(80),
      updated_by           uuid,
      updated_by_username  varchar(80),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      deleted_at           timestamptz,
      CONSTRAINT mkt_ranking_promos_vigencia_ck CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
      CONSTRAINT mkt_ranking_promos_canales_ck CHECK (
        cardinality(canales) > 0 AND canales <@ ARRAY['mostrador','preventa','ruta','mayoreo']::text[])
    )`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS mkt_ranking_promos_vig_idx
      ON commercial.mkt_ranking_promos (tenant_id, vigencia_desde, vigencia_hasta) WHERE deleted_at IS NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.mkt_ranking_objectives (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      promo_id             uuid NOT NULL REFERENCES commercial.mkt_ranking_promos(id) ON DELETE CASCADE,
      warehouse_code       varchar(4)  NOT NULL,
      canal                varchar(12) NOT NULL,
      vendor_code          varchar(40) NOT NULL DEFAULT '',
      objetivo_semanal     numeric(12,2) NOT NULL,
      fuente               varchar(10) NOT NULL DEFAULT 'manual',
      created_by           uuid,
      created_by_username  varchar(80),
      updated_by           uuid,
      updated_by_username  varchar(80),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mkt_ranking_obj_positivo_ck CHECK (objetivo_semanal > 0),
      CONSTRAINT mkt_ranking_obj_fuente_ck CHECK (fuente IN ('sugerido','manual')),
      CONSTRAINT mkt_ranking_obj_canal_ck CHECK (canal IN ('mostrador','preventa','ruta','mayoreo'))
    )`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mkt_ranking_obj_uq
      ON commercial.mkt_ranking_objectives (tenant_id, promo_id, warehouse_code, canal, vendor_code)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.mkt_incentives (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      nombre               text NOT NULL,
      tipo                 varchar(12) NOT NULL,
      pago                 numeric(12,2) NOT NULL,
      base_monto           numeric(12,2),
      redondeo             varchar(12) NOT NULL DEFAULT 'proporcional',
      skus                 text[] NOT NULL DEFAULT ARRAY[]::text[],
      vigencia_desde       date NOT NULL,
      vigencia_hasta       date,
      canales              text[] NOT NULL DEFAULT ARRAY['mostrador','preventa','ruta','mayoreo']::text[],
      warehouse_codes      text[],
      activo               boolean NOT NULL DEFAULT true,
      notas                text,
      created_by           uuid,
      created_by_username  varchar(80),
      updated_by           uuid,
      updated_by_username  varchar(80),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      deleted_at           timestamptz,
      CONSTRAINT mkt_incentives_tipo_ck CHECK (tipo IN ('por_caja','por_unidad','por_monto','por_cliente','por_captura')),
      CONSTRAINT mkt_incentives_pago_ck CHECK (pago > 0),
      CONSTRAINT mkt_incentives_base_ck CHECK (tipo <> 'por_monto' OR (base_monto IS NOT NULL AND base_monto > 0)),
      CONSTRAINT mkt_incentives_skus_ck CHECK (tipo = 'por_captura' OR cardinality(skus) > 0),
      CONSTRAINT mkt_incentives_redondeo_ck CHECK (redondeo IN ('proporcional','completo')),
      CONSTRAINT mkt_incentives_vigencia_ck CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
      CONSTRAINT mkt_incentives_canales_ck CHECK (
        cardinality(canales) > 0 AND canales <@ ARRAY['mostrador','preventa','ruta','mayoreo']::text[])
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.mkt_incentive_captures (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      incentive_id         uuid NOT NULL REFERENCES commercial.mkt_incentives(id) ON DELETE CASCADE,
      warehouse_code       varchar(4)  NOT NULL,
      vendor_code          varchar(40) NOT NULL,
      semana               date NOT NULL,
      cantidad             numeric(12,2) NOT NULL,
      created_by           uuid,
      created_by_username  varchar(80),
      updated_by           uuid,
      updated_by_username  varchar(80),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mkt_incentive_cap_cantidad_ck CHECK (cantidad >= 0),
      CONSTRAINT mkt_incentive_cap_lunes_ck CHECK (extract(isodow FROM semana) = 1)
    )`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mkt_incentive_cap_uq
      ON commercial.mkt_incentive_captures (tenant_id, incentive_id, warehouse_code, vendor_code, semana)`);

  for (const t of TABLAS) {
    await knex.raw(`ALTER TABLE commercial.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${t} TO app_runtime`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. Hijos primero. */
exports.down = async function down(knex) {
  for (const t of [...TABLAS].reverse()) {
    await knex.raw(`DROP TABLE IF EXISTS commercial.${t}`);
  }
};
