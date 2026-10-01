'use strict';
/**
 * `[RE.30]` — **El plazo de pago es del PROVEEDOR, no del documento de Kepler.**
 *
 * ── Para qué ───────────────────────────────────────────────────────────────────────────
 * `/compras/obligaciones` es la entrega de Compras a Finanzas: qué se recibió, cuánto se debe y
 * CUÁNDO vence. El vencimiento sale de dos datos del proveedor (definidos con Francisco el
 * 2026-09-29): cuántos días de crédito da — **días EXACTOS** — y **desde cuándo corren**: la fecha
 * de la FACTURA o la fecha de RECEPCIÓN física.
 *
 * ── Por qué no se toma de Kepler (medido 2026-09-29 contra prod, read-only) ──────────────
 *   · La condición de la Aplicación de orden de entrada (`c30`) dice "Pago de contado" en el 68%
 *     de los documentos y NO es real: el plazo del proveedor nunca se capturó allá. En 2026, 207
 *     proveedores ($94.0M recibidos) salen SIEMPRE de contado y 97 ($234.7M) a veces sí y a veces
 *     no — el mismo proveedor capturado distinto.
 *   · En los últimos 12 meses: 307 proveedores con recepciones, 285 sin `credit_days`, 22 con él.
 * Kepler queda como COMPARACIÓN en la pantalla, nunca como fuente del plazo.
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────────────────
 * **Extiende `catalog.suppliers`; no crea una segunda tabla de plazos** (regla del proyecto:
 * nunca una segunda materialización). `credit_days` YA existe (Fase PP, mig 20260808120000; hoy
 * 25 de 1,318 llenos, rango 8–30, escritos por `import-payment-program.js` desde el Excel del
 * programa de pagos). Se agrega:
 *   · `credit_term_base`         'factura' | 'recepcion'. NULL = no se sabe.
 *   · `credit_terms_updated_by/_at`  quién lo CONFIRMÓ a mano. NULL = el valor viene del Excel o
 *                                no hay valor → la pantalla lo declara "sin confirmar".
 *   · `is_internal` + `internal_reason`  entidades propias que Kepler registra como proveedor
 *                                (CEDIS, sucursales, la persona física dueña): son TRASPASOS, no
 *                                deuda. Medido 12m: "Sucursal Padre Hidalgo 322" $31.4M y el dueño
 *                                $21.1M, ambos "de contado".
 *   · `catalog.supplier_credit_terms_history`  cada cambio con valor anterior, nuevo y quién.
 *                                Append-only. El plazo decide cuándo sale el dinero: tiene que poder
 *                                auditarse (ADR-056: guardar el valor anterior).
 *
 * **Tres estados del plazo que NO se confunden** (lo no medido se declara, no se dibuja como 0):
 *   NULL = sin capturar · 0 = contado CONFIRMADO · 1..365 = crédito.
 *
 * ── Decisiones que un revisor va a preguntar ─────────────────────────────────────────────
 *   · **La base NO se exige por CHECK** aunque un crédito sin base no se pueda calcular. Las 25
 *     filas del Excel tienen días y no base; un CHECK — aun `NOT VALID` — se evalúa en todo UPDATE
 *     de la fila, y rompería el propio `import-payment-program.js`. La exige el servicio al
 *     confirmar (`SupplierCreditTermsService.update`).
 *   · **El rango 0..365 sí va por CHECK** y es el mismo que valida el servicio. Se verificó que los
 *     25 valores actuales (8–30) lo cumplen, así que el `ADD CONSTRAINT` valida sin fallar.
 *   · **`*_by` es `text` (username)**, igual que las tablas hermanas del mismo flujo de pago
 *     (`commercial.supplier_payment_obligations`, `supplier_payment_accounts` — TP/TP.7). Las
 *     columnas de auditoría genéricas de `catalog.suppliers` (`created_by/updated_by`) son `uuid` y
 *     no se tocan desde acá.
 *   · **El importer del Excel ya no pisa un plazo confirmado** (mismo commit): si
 *     `credit_terms_updated_at` tiene valor, deja `credit_days` como está.
 *   · `import-kepler-suppliers.js` (feed) sólo escribe `name`/`updated_at`: no toca estas columnas.
 *     Un proveedor nuevo nace `sin plazo` (NULL) y `is_internal = false`.
 *
 * ── Locks (GOTCHAS §38) ───────────────────────────────────────────────────────────────
 * `ALTER TABLE catalog.suppliers` toma ACCESS EXCLUSIVE y la tabla se lee en caliente (16 archivos
 * de `libs/` y el feed de proveedores). `ADD COLUMN` nullable / con DEFAULT constante es
 * metadata-only en PG ≥ 11, y los CHECK validan 1,318 filas — el riesgo no es el tamaño sino quién
 * más la tenga tomada (el respaldo diario sostiene AccessShare sobre todo). Por eso
 * `SET LOCAL lock_timeout = '3s'`: el peor caso es un reintento (`55P03`), no una cola que tumbe
 * el login. El FK del historial toma SHARE ROW EXCLUSIVE sobre la misma tabla y queda cubierto.
 *
 * Aplicar SOLA con `node database/scripts/apply-one-migration-prod.js <este archivo>` (no
 * `migrate:latest`). Después: verificar con `pg_attribute` y `pg_constraint`, no con el registro.
 *
 * Idempotente (guard al inicio + por paso). `down` retira el historial y los CHECK; las columnas
 * NO se dropean (aditivas; borrar columnas exige confirmación — CLAUDE.md).
 *
 * @param { import("knex").Knex } knex
 */

const T = 'catalog.suppliers';
const HIST = 'supplier_credit_terms_history';

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

async function hasConstraint(knex, name) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`, [T, name]);
  return rows.length > 0;
}

async function addCheck(knex, name, expr) {
  if (!(await hasConstraint(knex, name))) {
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${name} CHECK (${expr})`);
  }
}

exports.up = async function up(knex) {
  const S = () => knex.schema.withSchema('catalog'); // ⛔ FÁBRICA, no instancia: un SchemaBuilder ACUMULA sentencias, y de la 2a `has*()` en adelante devuelve un ARRAY (truthy) en vez de un booleano -- el `if (!...)` se vuelve falso siempre y el DDL se SALTA en silencio. Medido en prod 2026-09-30.

  // Guard al inicio (GOTCHAS §3): la migración corre en UNA transacción, así que o quedó todo o
  // nada. Si ya está lo último que crea, no hay nada que hacer.
  if ((await S().hasColumn('suppliers', 'internal_reason')) && (await S().hasTable(HIST))
      && (await hasConstraint(knex, 'chk_suppliers_internal_reason'))) {
    return;
  }

  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const add = async (col, ddl) => {
    if (!(await S().hasColumn('suppliers', col))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN ${ddl}`);
  };
  // `credit_days` es de la Fase PP; se garantiza por si un entorno no la tiene.
  await add('credit_days', 'credit_days int');
  await add('credit_term_base', 'credit_term_base text');
  await add('credit_terms_updated_by', 'credit_terms_updated_by text');
  await add('credit_terms_updated_at', 'credit_terms_updated_at timestamptz');
  await add('is_internal', 'is_internal boolean NOT NULL DEFAULT false');
  await add('internal_reason', 'internal_reason text');

  await addCheck(knex, 'chk_suppliers_credit_days_range',
    'credit_days IS NULL OR credit_days BETWEEN 0 AND 365');
  await addCheck(knex, 'chk_suppliers_credit_term_base',
    `credit_term_base IS NULL OR credit_term_base IN ('factura','recepcion')`);
  await addCheck(knex, 'chk_suppliers_internal_reason',
    `NOT is_internal OR nullif(btrim(internal_reason), '') IS NOT NULL`);

  await knex.raw(`COMMENT ON COLUMN ${T}.credit_days IS
    'Días EXACTOS de crédito pactados. NULL = sin capturar · 0 = contado confirmado · 1..365 = crédito. Confirmado a mano sólo si credit_terms_updated_at no es NULL (si no, viene del Excel del programa de pagos). [RE.30]'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.credit_term_base IS
    'Desde cuándo corre el plazo: factura (fecha del documento en Kepler) o recepcion (llegada física, la captura la zona). NULL = no se sabe. [RE.30]'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.is_internal IS
    'Entidad propia registrada como proveedor en Kepler (CEDIS, sucursal, dueño): sus entradas son traspasos, no deuda. Exige internal_reason. [RE.30]'`);

  if (!(await S().hasTable(HIST))) {
    await knex.raw(`
      CREATE TABLE catalog.${HIST} (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        supplier_id          uuid NOT NULL,
        old_credit_days      int,
        new_credit_days      int,
        old_credit_term_base text,
        new_credit_term_base text,
        old_is_internal      boolean,
        new_is_internal      boolean,
        note                 text,
        created_by           text NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           text,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, supplier_id) REFERENCES ${T} (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_sct_hist_supplier ON catalog.${HIST} (tenant_id, supplier_id, created_at DESC)`);
    await knex.raw(`COMMENT ON TABLE catalog.${HIST} IS
      'Historial append-only del plazo de pago por proveedor: valor anterior, nuevo y quién. Lo escribe SupplierCreditTermsService.update en la misma transacción. [RE.30]'`);
    await tenantRls(knex, 'catalog', HIST);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.schema.withSchema('catalog').dropTableIfExists(HIST);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS chk_suppliers_internal_reason`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS chk_suppliers_credit_term_base`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS chk_suppliers_credit_days_range`);
  // Columnas: NO se dropean (aditivas; borrar columnas exige confirmación). `credit_days` es de PP.
};
