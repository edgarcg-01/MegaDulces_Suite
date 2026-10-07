/**
 * Fase GT (GT.12) — Expedientes de Telemarketing: historial de las Guías de Cobranza emitidas.
 *
 * La guía se genera desde Facturación TM (se palomean facturas, se imprime al instante) y
 * queda archivada acá: el expediente es **el historial por vendedor** de lo que salió a cobrar.
 *
 * Dos decisiones del modelo:
 *
 *   1. **Se guarda el SNAPSHOT de lo impreso**, no sólo los folios. El importe de la guía es el
 *      saldo pendiente al momento de imprimir, y ese saldo se mueve: si la reimpresión se
 *      reconstruyera desde la cartera de hoy, el papel archivado y su copia dirían cosas
 *      distintas sobre el mismo folio. El expediente conserva lo que el cobrador se llevó.
 *   2. **Un expediente = un vendedor** (regla GT.8), por eso `vendedor_code` es columna y no
 *      un dato enterrado en el JSON: es la llave por la que se consulta el historial.
 *
 * Convención A.0mt: tenant_id + audit completo, RLS FORZADO, grants a `app_runtime`.
 * Idempotente. No borra nada.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // `CREATE SCHEMA IF NOT EXISTS` pide CREATE sobre la BASE aunque el schema ya exista, y los
  // roles de dev no lo tienen. Se pregunta primero: idempotente y sin pedir un permiso que la
  // migración no necesita (commercial.* existe desde la Fase B en todos los ambientes).
  const { rows: schema } = await knex.raw(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'commercial'`);
  if (!schema.length) await knex.raw(`CREATE SCHEMA commercial`);

  // ── Folio secuencial por (tenant, año) — mismo patrón que `commercial.order_sequences`:
  //    UPSERT atómico, sin SELECT..FOR UPDATE y sin huecos por concurrencia.
  if (!(await knex.schema.withSchema('commercial').hasTable('collection_guide_sequences'))) {
    await knex.raw(`
      CREATE TABLE commercial.collection_guide_sequences (
        tenant_id     uuid NOT NULL,
        year          int  NOT NULL,
        current_value int  NOT NULL DEFAULT 0,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, year)
      )`);
    await knex.raw(`ALTER TABLE commercial.collection_guide_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.collection_guide_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.collection_guide_sequences
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.collection_guide_sequences TO app_runtime`);
  }

  // ── El expediente ───────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('collection_guides'))) {
    await knex.raw(`
      CREATE TABLE commercial.collection_guides (
        tenant_id         uuid NOT NULL,
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        folio             text NOT NULL,              -- GC-YYYY-NNNNN
        -- Un expediente = UN vendedor (GT.8). NULL sólo si las facturas no traen vendedor
        -- en el ERP: se archiva igual, rotulado, en vez de perder el papel emitido.
        vendedor_code     text,
        vendedor_nombre   text,
        responsable       text,                        -- quien firma la guía (se imprime)
        sucursales        text[] NOT NULL DEFAULT '{}',-- sucursales que abarca (suele ser una)
        documentos        int  NOT NULL,
        clientes          int  NOT NULL,
        total             numeric(14,2) NOT NULL,      -- lo que salió a cobrar, tal como se imprimió
        folios            text[] NOT NULL,             -- las facturas seleccionadas
        -- Lo impreso, verbatim: clientes, domicilios y movimientos con su importe del día.
        snapshot          jsonb NOT NULL,
        created_by        uuid,
        created_by_username text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, folio)
      )`);
    await knex.raw(`ALTER TABLE commercial.collection_guides ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.collection_guides FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.collection_guides
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.collection_guides TO app_runtime`);

    // El historial se consulta por vendedor y por fecha — es la pantalla entera.
    await knex.raw(`CREATE INDEX idx_collection_guides_vendedor
      ON commercial.collection_guides (tenant_id, vendedor_code, created_at DESC)`);
    await knex.raw(`CREATE INDEX idx_collection_guides_fecha
      ON commercial.collection_guides (tenant_id, created_at DESC)`);
    // Para responder "¿esta factura ya salió en una guía?" sin escanear la tabla.
    await knex.raw(`CREATE INDEX idx_collection_guides_folios
      ON commercial.collection_guides USING gin (folios)`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.collection_guides`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.collection_guide_sequences`);
};
