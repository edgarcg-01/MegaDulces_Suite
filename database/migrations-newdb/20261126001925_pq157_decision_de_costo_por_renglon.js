'use strict';
/**
 * `[PQ.157]` C1 — **La decisión de Compras sobre cada renglón aplicado a otro costo que el de su OC.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md` §3d y §3e. La vista de C0
 * (`commercial.v_application_line_cost`, mig 20261125214023) dice QUÉ renglón difiere; esta tabla guarda lo que
 * Compras DECIDIÓ con él, quién y por qué. Hoy esa decisión no queda en ningún lado, y por eso se repite.
 *
 *   · **accept**    — el costo nuevo se acepta: la OC siguiente nace con él (lista del proveedor, `[PQ.155]`) y,
 *                     si el margen cambia, se avisa a precios (Francisco, 2026-11-26: «ajustar costos y precios»).
 *   · **claim**     — se reclama: el proveedor cobró más que lo pedido y se espera una nota de crédito por la
 *                     diferencia («descontar con NC»). Sólo en un renglón que SUBE, y nunca por más que la diferencia.
 *   · **promotion** — precio de promoción o cambio temporal: vale hasta una fecha y la OC siguiente no lo hereda.
 *
 * Una decisión viva por renglón. Cambiarla es marcar la anterior (`superseded_*`) y escribir otra: nada se borra.
 * La fila guarda la FOTO de lo que la persona vio (precio aplicado, precio de la OC en la misma unidad, cantidad,
 * estado): no es copia de la vista (regla 2) sino la evidencia de la decisión; la vista cambia si Kepler corrige el
 * renglón, la decisión no.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 2026-11-25; anexo R §3d) ───────────────────────────────────────────
 *  · 60 días: de 9,527 renglones comparables, 1,029 suben (+$1.17 M) y 651 bajan (−$511 mil): 1,680 sin decisión
 *    registrada en ningún lado. El mismo cambio se vuelve a validar en la entrada siguiente el 61 % de las veces
 *    (placebo 4.7 %): eso es lo que esta tabla corta.
 *  · Ninguna tabla de la Suite guarda una decisión sobre el costo de una aplicación (la conciliación de Recepción
 *    marca «difiere precio» contra la factura y no se registra qué se hizo).
 *
 * Datos PROPIOS (regla 1). La llave del renglón es la de Kepler (`sucursal`, `subtipo`, `folio`, `renglon`), la
 * misma de la vista; sin FK (el ODS no lleva tenant ni llaves). RLS forzado por tenant. `app_runtime`:
 * SELECT/INSERT/UPDATE; el DELETE que dan los privilegios por defecto del esquema se REVOCA (lección de PQ.3.5).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.application_cost_decisions';
/** Las decisiones posibles; la prueba de base las compara contra el contrato y el CHECK. */
const DECISIONES = ['accept', 'claim', 'promotion'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);

  if (!(await knex.schema.withSchema('commercial').hasTable('application_cost_decisions'))) {
    await knex.raw(`
      CREATE TABLE ${T} (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        sucursal       text NOT NULL,
        subtipo        text NOT NULL,
        folio          text NOT NULL,
        renglon        integer NOT NULL,
        supplier_code  text NOT NULL,
        sku            text NOT NULL,
        unit           text,
        quantity       numeric(16,4) NOT NULL,
        applied_price  numeric(16,6) NOT NULL,
        oc_price       numeric(16,6) NOT NULL,
        cost_state     text NOT NULL,
        decision       text NOT NULL,
        reason         text NOT NULL,
        claim_amount   numeric(14,2),
        valid_until    date,
        created_by     text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     text,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        superseded_by  text,
        superseded_at  timestamptz,
        CONSTRAINT application_cost_decisions_llave_chk CHECK (
          btrim(sucursal) <> '' AND btrim(subtipo) <> '' AND btrim(folio) <> '' AND renglon > 0),
        CONSTRAINT application_cost_decisions_producto_chk CHECK (btrim(supplier_code) <> '' AND btrim(sku) <> ''),
        CONSTRAINT application_cost_decisions_cifras_chk CHECK (quantity > 0 AND applied_price > 0 AND oc_price > 0),
        -- Sólo se decide lo que difiere de la OC, y la foto tiene que ser coherente con su estado.
        CONSTRAINT application_cost_decisions_estado_chk CHECK (
          (cost_state = 'sube' AND applied_price > oc_price) OR (cost_state = 'baja' AND applied_price < oc_price)),
        CONSTRAINT application_cost_decisions_decision_chk CHECK (decision IN ('${DECISIONES.join("', '")}')),
        -- Quién y POR QUÉ: un motivo de verdad, no un punto (el mismo piso que RE.86).
        CONSTRAINT application_cost_decisions_motivo_chk CHECK (length(btrim(reason)) >= 10),
        -- Reclamar: sólo lo que SUBE, con monto, y nunca más que la diferencia contra la OC (un centavo de holgura
        -- por el redondeo). El monto puede ser menor: se reclama una parte.
        -- COALESCE(…, false) es defensivo: hoy todas las columnas de la regla son NOT NULL, pero un CHECK que da NULL
        -- deja pasar la fila (la trampa de PQ.3.2) y una columna que se vuelva opcional no debe abrir el hueco.
        CONSTRAINT application_cost_decisions_reclamo_chk CHECK (COALESCE(
          (decision = 'claim') = (claim_amount IS NOT NULL)
          AND (claim_amount IS NULL OR (cost_state = 'sube' AND claim_amount > 0
               AND claim_amount <= round((applied_price - oc_price) * quantity, 2) + 0.01)),
          false)),
        -- Promoción: vale hasta una fecha; ninguna otra decisión lleva fecha de fin.
        CONSTRAINT application_cost_decisions_promocion_chk CHECK ((decision = 'promotion') = (valid_until IS NOT NULL)),
        CONSTRAINT application_cost_decisions_reemplazo_chk CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
      )`);
  }
  // Una decisión VIVA por renglón; la reemplazada queda como historia.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_application_cost_decisions_viva
      ON ${T} (tenant_id, sucursal, subtipo, folio, renglon) WHERE superseded_at IS NULL`);
  // «Ya se aceptó antes»: lo vivo aceptado o en promoción, por proveedor y producto, lo más nuevo primero.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_application_cost_decisions_producto
      ON ${T} (tenant_id, supplier_code, sku, created_at DESC)
      WHERE superseded_at IS NULL AND decision IN ('accept', 'promotion')`);

  await knex.raw(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'commercial'
                       AND tablename = 'application_cost_decisions' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON ${T}
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON ${T} TO app_runtime;
        -- Los privilegios POR DEFECTO del esquema commercial dan también DELETE (PQ.3.5): sin este REVOKE,
        -- «una decisión se reemplaza, no se borra» sería una intención.
        REVOKE DELETE, TRUNCATE ON ${T} FROM app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON ${T} TO dev_ro;
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE ${T} IS
    '[PQ.157] La decisión de Compras sobre un renglón de aplicación X-A-20 aplicado a otro costo que el de su OC (commercial.v_application_line_cost): accept, claim (nota de crédito esperada, nunca más que la diferencia) o promotion (con fecha de fin). Una viva por renglón; cambiarla = superseded_*. Guarda la foto de lo que se vio al decidir.'`);

  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM ${T}`);
  console.log(`[PQ.157] ${T}: ${n.n} decisión(es)`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): con filas, la tabla se conserva y se dice;
 * sólo vacía se quita (con ella se van sus índices y su política).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasTable('application_cost_decisions'))) return;
  const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM ${T}`)).rows[0].n);
  if (n > 0) {
    console.log(`[PQ.157] ${T} tiene ${n} decisión(es) hechas por personas: se conserva (regla 5).`);
    return;
  }
  await knex.raw(`DROP TABLE ${T}`);
};

exports.DECISIONES = DECISIONES;
