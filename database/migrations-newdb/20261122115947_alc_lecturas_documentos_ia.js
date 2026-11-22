'use strict';
/**
 * `[ALC.4.4]` — **Lo que la máquina leyó de los documentos del cliente, guardado como evidencia.**
 *
 * Pedido de Francisco (2026-11-22): las altas llegan como fotos de la constancia, capturas de Wincaja o
 * de otro sistema, etiquetas y facturas viejas; *«privilegiando la transformación digital a través de
 * la IA»*. Leerlas con IA exige dos cosas que la solicitud sola no guarda:
 *  1. **La lectura es evidencia, no lo que manda el navegador** (lección de `OcrReadingsService`): el
 *     servidor la guarda al leer y, al crear, la toma de aquí.
 *  2. **Medir cuánto acierta la IA**: al crear se anota qué casillas corrigió la persona respecto de lo
 *     leído (`corrections`). Sin eso «la IA funciona» sería una opinión.
 *
 * Qué hace:
 *  · `commercial.customer_onboarding_readings` — dato PROPIO (OCR/HITL, no copia de Kepler): una fila
 *    por lectura, con los archivos (llaves del almacén + sha256), la fuente (`pdf_texto`/`ia`/`mixta`),
 *    el modelo, lo que costó, lo que propuso y lo que se corrigió. `tenant_id` + auditoría + RLS FORCE.
 *  · `customer_onboarding_requests.reading_id` (nullable, FK) — de qué lectura salió; una lectura sirve
 *    a UNA solicitud (índice único parcial).
 *  · `customer_onboarding_requests_origin_ck` admite `documento` (leída con IA).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-22) ──
 *  · `customer_onboarding_requests`: 2 filas, las 2 `origin = 'constancia'` y ligadas (21-nov). El
 *    CHECK de origen sólo se AMPLÍA: ninguna fila deja de cumplirlo.
 *  · Ningún camino de inserción cambia: `reading_id` es nullable (regla 14).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'customer_onboarding_readings';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.${TABLA} (
      id             uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid          NOT NULL,
      source         text          NOT NULL,
      status         text          NOT NULL,
      branch         varchar(4),
      documents      jsonb         NOT NULL DEFAULT '[]'::jsonb,
      document_type  text,
      model          text,
      usage          jsonb,
      cost_usd       numeric(10,5),
      proposal       jsonb,
      failure        text,
      corrections    jsonb,
      created_at     timestamptz   NOT NULL DEFAULT now(),
      created_by     uuid,
      updated_at     timestamptz   NOT NULL DEFAULT now(),
      updated_by     uuid,
      CONSTRAINT ${TABLA}_pkey PRIMARY KEY (id),
      -- identity.tenants, NO public.tenants (es una vista: lección de 20261104235236).
      CONSTRAINT ${TABLA}_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT,
      CONSTRAINT ${TABLA}_source_ck CHECK (source IN ('pdf_texto', 'ia', 'mixta')),
      CONSTRAINT ${TABLA}_status_ck CHECK (status IN ('leida', 'ilegible', 'rechazada', 'incompleta', 'fallida')),
      -- Una lectura «leida» trae su propuesta; una fallida, su motivo. Las dos ramas son booleanas.
      CONSTRAINT ${TABLA}_resultado_ck CHECK ((status = 'leida' AND proposal IS NOT NULL) OR (status <> 'leida' AND failure IS NOT NULL)),
      CONSTRAINT ${TABLA}_documents_ck CHECK (jsonb_typeof(documents) = 'array')
    )`);
  // El tope diario cuenta las lecturas con IA del día.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_dia ON commercial.${TABLA} (tenant_id, created_at)`);

  await knex.raw(`ALTER TABLE commercial.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON commercial.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON commercial.${TABLA}
                    USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  // Sin DELETE: la evidencia no se borra desde la app.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.${TABLA} TO app_runtime`);

  // ── La solicitud: de qué lectura salió ─────────────────────────────────────────────────────
  const { rows: col } = await knex.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name = 'customer_onboarding_requests' AND column_name = 'reading_id'`,
  );
  if (!col.length) await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests ADD COLUMN reading_id uuid`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests DROP CONSTRAINT IF EXISTS customer_onboarding_requests_reading_fk`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests ADD CONSTRAINT customer_onboarding_requests_reading_fk
                    FOREIGN KEY (reading_id) REFERENCES commercial.${TABLA}(id) ON DELETE SET NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_onboarding_requests_reading
                    ON commercial.customer_onboarding_requests (reading_id) WHERE reading_id IS NOT NULL`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests DROP CONSTRAINT IF EXISTS customer_onboarding_requests_origin_ck`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests ADD CONSTRAINT customer_onboarding_requests_origin_ck
                    CHECK (origin IN ('constancia', 'manual', 'documento'))`);

  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.customer_onboarding_requests`);
  console.log(`  [alc_lecturas_documentos_ia] tabla ${TABLA} lista; ${n.n} solicitud(es) existentes siguen cumpliendo el CHECK de origen`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests DROP CONSTRAINT IF EXISTS customer_onboarding_requests_origin_ck`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests ADD CONSTRAINT customer_onboarding_requests_origin_ck
                    CHECK (origin IN ('constancia', 'manual'))`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_customer_onboarding_requests_reading`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests DROP CONSTRAINT IF EXISTS customer_onboarding_requests_reading_fk`);
  await knex.raw(`ALTER TABLE commercial.customer_onboarding_requests DROP COLUMN IF EXISTS reading_id`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.${TABLA}`);
};
