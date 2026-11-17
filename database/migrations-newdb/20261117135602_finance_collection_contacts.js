'use strict';
/**
 * `[CXC.43]` — Contactos de cobranza: quién contactó a qué cuenta, cuándo y por dónde.
 *
 * La lista de `/finanzas/cartera` no decía a quién ya se le habló hoy: al retomarla no había
 * forma de saber dónde se quedó, y la única huella posible eran los compromisos de pago, que
 * nunca se usaron (0 en su historia). Esta tabla la llena el ACTO, no un formulario: tocar
 * «Llamar», «Enviar por WhatsApp» o «Estado de cuenta (PDF)» en la ficha del cliente deja el
 * renglón. Nada se teclea de más.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-17) ──────────────────────────────────────────────
 *  · 98 % del uso de la pantalla es de `credito_cobranza` (3,459 de 3,532 en 30 días).
 *  · 910 fichas abiertas en 30 días; 0 compromisos registrados; 0 tablas existentes que guarden
 *    un contacto por (sucursal, cliente_code) — `commercial.call_logs` es de Telemarketing, va
 *    por `customer_id` y tiene 0 filas.
 *
 * Tabla propia de la Suite: NUNCA escribe a Kepler. RLS forzado, igual que
 * `finance.collection_promises`. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  if (!(await knex.schema.withSchema('finance').hasTable('collection_contacts'))) {
    await knex.raw(`
      CREATE TABLE finance.collection_contacts (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        sucursal      text NOT NULL,
        cliente_code  text NOT NULL,
        canal         text NOT NULL
                        CHECK (canal IN ('telefono','whatsapp','estado_cuenta_pdf')),
        contacted_at  timestamptz NOT NULL DEFAULT now(),
        created_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_by    text,
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`);
  }
  // El que lee la lista pide el ÚLTIMO contacto por cuenta: este índice lo da sin ordenar.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_cc_cuenta
                    ON finance.collection_contacts (tenant_id, sucursal, cliente_code, contacted_at DESC)`);
  await knex.raw(`ALTER TABLE finance.collection_contacts ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.collection_contacts FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='collection_contacts' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.collection_contacts
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sólo SELECT e INSERT: un contacto no se edita ni se borra desde la app.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT ON finance.collection_contacts TO app_runtime;
      END IF;
    END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS finance.collection_contacts`);
};
