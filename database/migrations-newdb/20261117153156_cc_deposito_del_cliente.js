'use strict';
/**
 * `[CC.20]` — El CLIENTE sube su ficha de depósito desde un enlace personal, sin usuario ni contraseña. Edgar,
 * 2026-11-17: «lo más práctico y lo más fácil posible»; canal = enlace personal (WhatsApp + QR en el estado de
 * cuenta); lo recibe Cobranza en su bandeja y lo ve el vendedor.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-17) ──────────────────────────────────────────────────────────────
 *  · 2,722 cobros por $48.5M en Kepler en 30 días (U-A-5/7).
 *  · `finance.collection_deposits` (la ficha capturada EN OFICINA, fase CC): **0 filas en su historia**. La pantalla
 *    de Cobranza tuvo 3 llamadas en 30 días. Capturar la ficha del cliente en oficina no ocurre.
 *  · El portal B2B: 3 sesiones en 30 días, 0 personas identificadas. Pedir usuario al cliente no es práctico.
 *
 * ── Qué cambia ───────────────────────────────────────────────────────────────────────────────────────────────────
 *  · `finance.collection_deposits` (se EXTIENDE, no se copia): `origen` ('oficina' | 'cliente'). La ficha del
 *    cliente llega ANTES de que exista el cobro en Kepler, así que `folio` puede ir vacío mientras `origen = 'cliente'`
 *    (un CHECK sostiene que la de oficina siempre lo trae). Lo que el cliente DECLARA (monto, fecha, nota) va aparte
 *    de lo que leyó el OCR: el OCR es una propuesta, lo declarado es su palabra. Tiene 0 filas: el cambio no toca datos.
 *  · `finance.customer_deposit_links`: el enlace es un JWT SIN ESTADO (sucursal, cliente, versión); esta tabla
 *    guarda sólo la versión vigente de cada cuenta (revocar = subir la versión) y el uso. Sin renglón = versión 1.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = async (rel) => (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [rel])).rows[0].ok;
  if (!(await hay('finance.collection_deposits'))) {
    console.log('[CC.20] sin finance.collection_deposits (entorno sin la fase CC): nada que extender.');
    return;
  }
  const col = async (c) => (await knex.raw(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'finance' AND table_name = 'collection_deposits' AND column_name = ?) AS ok`, [c])).rows[0].ok;

  // ── 1. collection_deposits: el depósito que reporta el cliente ─────────────────────────────────────────────────
  if (!(await col('origen'))) {
    await knex.raw(`ALTER TABLE finance.collection_deposits
      ADD COLUMN origen text NOT NULL DEFAULT 'oficina' CHECK (origen IN ('oficina', 'cliente'))`);
  }
  if (!(await col('reported_monto'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN reported_monto numeric`);
  if (!(await col('reported_fecha'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN reported_fecha date`);
  if (!(await col('reported_nota'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN reported_nota text`);
  // La cuenta del cliente (su sucursal en la cartera). `sucursal`/`folio` son los del COBRO de Kepler, que al ligarse
  // puede ser de otra sucursal (los cobros de la 00 traen el código del cliente de cualquier plaza).
  if (!(await col('cuenta_sucursal'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN cuenta_sucursal text`);
  if (!(await col('linked_at'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN linked_at timestamptz`);
  if (!(await col('linked_by'))) await knex.raw(`ALTER TABLE finance.collection_deposits ADD COLUMN linked_by text`);
  // El folio del cobro de Kepler: obligatorio para la de oficina, vacío para la del cliente hasta que Cobranza la liga.
  await knex.raw(`ALTER TABLE finance.collection_deposits ALTER COLUMN folio DROP NOT NULL`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_deposits_folio_oficina'
                       AND conrelid = 'finance.collection_deposits'::regclass) THEN
        ALTER TABLE finance.collection_deposits
          ADD CONSTRAINT collection_deposits_folio_oficina CHECK (origen = 'cliente' OR folio IS NOT NULL);
      END IF;
    END $$`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_cd_cliente ON finance.collection_deposits
    (tenant_id, cuenta_sucursal, cliente_code, created_at DESC) WHERE origen = 'cliente'`);
  await knex.raw(`COMMENT ON COLUMN finance.collection_deposits.origen IS
    '[CC.20] oficina = la capturó Cobranza ligada a un cobro de Kepler; cliente = la subió el cliente desde su enlace, '
    'antes de que exista el cobro (folio vacío hasta que Cobranza la liga).'`);
  await knex.raw(`COMMENT ON COLUMN finance.collection_deposits.reported_monto IS
    '[CC.20] Lo que el CLIENTE declaró (su palabra). Lo que leyó el OCR va en ocr_*: es una propuesta, no un dato.'`);

  // ── 2. customer_deposit_links: versión vigente y uso del enlace de cada cuenta ────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS finance.customer_deposit_links (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     uuid NOT NULL DEFAULT current_tenant_id(),
      sucursal      text NOT NULL,
      cliente_code  text NOT NULL,
      version       integer NOT NULL DEFAULT 1,
      revoked_at    timestamptz,
      last_used_at  timestamptz,
      uses          integer NOT NULL DEFAULT 0,
      created_by    text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    text,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, sucursal, cliente_code)
    )`);
  await knex.raw(`COMMENT ON TABLE finance.customer_deposit_links IS
    '[CC.20] El enlace del cliente para subir su ficha es un JWT sin estado (sucursal, cliente, versión). Aquí sólo la '
    'versión vigente de cada cuenta (dar de baja = subir la versión: los enlaces viejos dejan de servir) y el uso. '
    'Sin renglón = versión 1, vigente.'`);
  await knex.raw(`ALTER TABLE finance.customer_deposit_links ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.customer_deposit_links FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = 'customer_deposit_links'
                       AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.customer_deposit_links
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.customer_deposit_links TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON finance.customer_deposit_links TO dev_ro;
      END IF;
    END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TABLE IF EXISTS finance.customer_deposit_links`);
  const { rows: [r] } = await knex.raw(`SELECT to_regclass('finance.collection_deposits') IS NOT NULL AS ok`);
  if (!r.ok) return;
  // Si ya entraron fichas de clientes (sin folio), no se puede volver a exigir el folio sin perderlas: se frena.
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM finance.collection_deposits WHERE folio IS NULL`);
  if (n.n > 0) throw new Error(`[CC.20] hay ${n.n} fichas de clientes sin folio: no se puede deshacer sin perderlas`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_cd_cliente`);
  await knex.raw(`ALTER TABLE finance.collection_deposits DROP CONSTRAINT IF EXISTS collection_deposits_folio_oficina`);
  await knex.raw(`ALTER TABLE finance.collection_deposits ALTER COLUMN folio SET NOT NULL`);
  for (const c of ['linked_by', 'linked_at', 'cuenta_sucursal', 'reported_nota', 'reported_fecha', 'reported_monto', 'origen']) {
    await knex.raw(`ALTER TABLE finance.collection_deposits DROP COLUMN IF EXISTS ${c}`);
  }
};
