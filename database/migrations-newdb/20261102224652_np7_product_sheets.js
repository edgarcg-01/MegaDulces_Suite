/**
 * `[NP.7.0.5]` `catalog.product_sheets` — la ficha de producto del Catálogo digital.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_NP7_ALTA_DESDE_FOTOS.md` §7.1. Una sola tabla para los dos
 * caminos (`origin`): el ALTA de un producto que Kepler no tiene, y el LEVANTAMIENTO de la ficha de un
 * SKU que ya existe (fotos tomadas por el personal de sucursal). No copia nada de Kepler (regla 2): el
 * maestro sigue en `kepler_ods.kdii`; aquí sólo vive lo propio — fotos, lectura de la IA, decisiones.
 *
 * Estados (CHECK por origen):
 *  · alta: presolicitud, borrador, analizada, aprobada, tecleada_en_kepler, ligada, conciliada,
 *    con_diferencias, descartada.
 *  · levantamiento: en_captura, fotos_tomadas, analizada, publicada, por_revisar, recapturar, historica.
 *    `en_captura` se agregó al plan el 2026-11-02: al escanear se APARTA el producto antes de tener fotos.
 *
 * Unicidad: un alta viva por EAN; una ficha de levantamiento VIGENTE por SKU (la anterior queda
 * `historica` con `superseded_at`, no se pisa).
 *
 * Dato propio (fotos y decisiones de personas): tabla legítima. Sin DELETE (soft-delete).
 * Idempotente: la tabla se crea si no existe; RLS, policy y grants se re-aplican siempre.
 *
 * @param { import("knex").Knex } knex
 */

const ALTA = ['presolicitud', 'borrador', 'analizada', 'aprobada', 'tecleada_en_kepler', 'ligada', 'conciliada', 'con_diferencias', 'descartada'];
const LEVANTAMIENTO = ['en_captura', 'fotos_tomadas', 'analizada', 'publicada', 'por_revisar', 'recapturar', 'historica'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('catalog').hasTable('product_sheets'))) {
    await knex.raw(`
      CREATE TABLE catalog.product_sheets (
        id                          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id                   uuid NOT NULL,
        origin                      text NOT NULL,
        status                      text NOT NULL,
        ean                         text,
        sku                         text,
        branch_code                 text,
        supplier_code               text,
        supplier_name               text,
        negotiated_cost             numeric(14,4),
        photos                      jsonb NOT NULL DEFAULT '[]'::jsonb,
        ai_raw                      jsonb,
        sheet                       jsonb NOT NULL DEFAULT '{}'::jsonb,
        kepler_diff                 jsonb,
        projection                  jsonb,
        fields_total                integer,
        fields_by_human             integer,
        margin_authorized_by        uuid,
        margin_authorized_at        timestamptz,
        margin_authorization_reason text,
        margin_authorized_pct       numeric(8,4),
        approved_by                 uuid,
        approved_at                 timestamptz,
        kepler_captured_by          uuid,
        kepler_captured_at          timestamptz,
        linked_at                   timestamptz,
        superseded_by               uuid,
        superseded_at               timestamptz,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        created_by                  uuid,
        created_by_username         varchar(80),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        updated_by                  uuid,
        updated_by_username         varchar(80),
        deleted_at                  timestamptz,
        deleted_by                  uuid,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT catalog_product_sheets_origin_chk CHECK (origin IN ('alta','levantamiento')),
        CONSTRAINT catalog_product_sheets_status_chk CHECK (
          (origin = 'alta' AND status IN (${lista(ALTA)}))
          OR (origin = 'levantamiento' AND status IN (${lista(LEVANTAMIENTO)}))),
        CONSTRAINT catalog_product_sheets_photos_chk CHECK (jsonb_typeof(photos) = 'array'),
        CONSTRAINT catalog_product_sheets_sheet_chk CHECK (jsonb_typeof(sheet) = 'object'),
        -- El levantamiento es de un SKU que ya existe, levantado en una sucursal (la pone el servidor).
        CONSTRAINT catalog_product_sheets_lev_sku_chk CHECK (origin <> 'levantamiento' OR (sku IS NOT NULL AND branch_code IS NOT NULL)),
        -- Una ficha histórica dice cuándo y por cuál se reemplazó.
        CONSTRAINT catalog_product_sheets_historica_chk CHECK (status <> 'historica' OR superseded_at IS NOT NULL),
        -- Si hay autorizador de margen, el motivo no va vacío (§5.8 punto 5).
        CONSTRAINT catalog_product_sheets_margin_reason_chk CHECK (
          margin_authorized_by IS NULL OR length(trim(coalesce(margin_authorization_reason, ''))) > 0),
        CONSTRAINT fk_catalog_product_sheets_tenant
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_product_sheets_status ON catalog.product_sheets (tenant_id, status)`);
    await knex.raw(`CREATE INDEX ix_product_sheets_branch ON catalog.product_sheets (tenant_id, branch_code, status) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_product_sheets_sku ON catalog.product_sheets (tenant_id, sku) WHERE deleted_at IS NULL`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_product_sheets_alta_ean ON catalog.product_sheets (tenant_id, ean)
       WHERE origin = 'alta' AND deleted_at IS NULL AND status <> 'descartada'`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_product_sheets_lev_sku ON catalog.product_sheets (tenant_id, sku)
       WHERE origin = 'levantamiento' AND superseded_at IS NULL AND deleted_at IS NULL`);
  }

  await knex.raw(`ALTER TABLE catalog.product_sheets ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE catalog.product_sheets FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='catalog' AND tablename='product_sheets' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON catalog.product_sheets
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  // Sin DELETE: una ficha se descarta o queda histórica; las fotos y decisiones son el rastro.
  await knex.raw(`REVOKE DELETE ON catalog.product_sheets FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON catalog.product_sheets TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE catalog.product_sheets IS
    '[NP.7] Ficha de producto del Catalogo digital: alta desde fotos (origin=alta) o levantamiento de un SKU existente (origin=levantamiento). Dato propio: fotos, lectura de IA y decisiones; el maestro sigue en kepler_ods.kdii.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: si ya hay fichas, se niega. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('catalog').hasTable('product_sheets'))) return;
  // La tabla tiene RLS FORZADA: con un rol que no la salta y sin `app.tenant_id`, el conteo daría 0 aunque
  // haya fichas y la salvaguarda dejaría pasar el DROP. Con `row_security = off`, ese rol FALLA en vez de
  // contar de menos; postgres (quien migra hoy) cuenta todo.
  await knex.raw(`SET LOCAL row_security = off`);
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM catalog.product_sheets`);
  if (rows[0].n > 0) {
    throw new Error(`[NP.7.0.5] down rechazado: catalog.product_sheets tiene ${rows[0].n} fichas (fotos y decisiones de personas). Respáldalas antes de borrar la tabla.`);
  }
  await knex.raw(`DROP TABLE catalog.product_sheets`);
};
