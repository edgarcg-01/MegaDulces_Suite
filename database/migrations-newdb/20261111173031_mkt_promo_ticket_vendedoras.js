'use strict';
/**
 * `[MKT.18]` — Quién vendió cada ticket con promoción en el mostrador: lo escribe la cajera en su
 * arqueo (`/tienda/arqueo`) y alimenta el ranking «por vendedora». Sólo se guarda lo que una
 * persona decide (QUIÉN); el ticket, sus promociones y cantidades se leen en vivo de Kepler.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ────────────────────────────────────────
 *  · Kepler NO sabe quién vendió en mostrador: 148 de 149 tickets con promoción de Padre Hidalgo
 *    (semana 45) traen el vendedor genérico «PV SUCURSAL PADRE HIDALGO PISO».
 *  · El ticket SÍ sabe su turno: `kdm1.c80` = la apertura del turno (`kdpv_folio_caja.c3`). Los
 *    543 tickets con promoción de la semana 45 empatan con su turno: 543 de 543.
 *  · La plantilla con puesto (`hr.employees`) tiene 0 filas; la lista viva es quien checó en el
 *    reloj de la sucursal (58 personas en PH en 30 días, 100 % con nombre). Por eso se guarda la
 *    clave del reloj y el NOMBRE de ese momento (el ranking de semanas pasadas no cambia si el
 *    reloj se edita).
 *
 * Grano: un renglón por ticket (sucursal + tipo de documento + caja + folio), como Kepler lo
 * identifica. Tabla nueva, sin tocar ninguna existente. RLS forzado por tenant. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.mkt_promo_ticket_sellers (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      warehouse_code       varchar(4)   NOT NULL,
      doc_tipo             integer      NOT NULL,
      caja                 varchar(10)  NOT NULL,
      folio                varchar(20)  NOT NULL,
      business_date        date         NOT NULL,
      turno_apertura       varchar(20),
      person_code          varchar(40)  NOT NULL,
      person_name          varchar(160) NOT NULL,
      created_by           uuid,
      created_by_username  varchar(80),
      updated_by           uuid,
      updated_by_username  varchar(80),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mkt_promo_ticket_sellers_wh_ck CHECK (warehouse_code ~ '^[0-9]{2}$'),
      CONSTRAINT mkt_promo_ticket_sellers_person_ck CHECK (btrim(person_code) <> '' AND btrim(person_name) <> ''),
      CONSTRAINT mkt_promo_ticket_sellers_ticket_uq UNIQUE (tenant_id, warehouse_code, doc_tipo, caja, folio)
    )`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS mkt_promo_ticket_sellers_fecha_idx
      ON commercial.mkt_promo_ticket_sellers (tenant_id, business_date, warehouse_code)`);
  await knex.raw(`ALTER TABLE commercial.mkt_promo_ticket_sellers ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.mkt_promo_ticket_sellers FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.mkt_promo_ticket_sellers`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.mkt_promo_ticket_sellers
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.mkt_promo_ticket_sellers TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.mkt_promo_ticket_sellers`);
};
