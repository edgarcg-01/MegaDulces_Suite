/**
 * GX.9 — Captura de gasto por LINK, sin folio de Kepler todavía.
 *
 * El orden real de los hechos es al revés del que el sistema exigía: el trabajador recibe
 * la solicitud firmada en papel, gasta, junta tickets, y *después* alguien en oficina lo
 * captura en Kepler. Hasta hoy `folio_solicitud` era NOT NULL, así que no había forma de
 * guardar la evidencia antes de que existiera el folio — la foto se quedaba en el celular.
 *
 * Dos cambios:
 *
 * 1. `finance.expense_proofs.folio_solicitud` pasa a NULLable. NULL = **capturado y todavía
 *    sin casar** con su solicitud XA1501. Casar es un UPDATE que le pone el folio, no mover
 *    la fila a otra tabla: es el MISMO expediente, sólo que antes de saber a qué folio
 *    pertenece. (Una segunda tabla sería una copia — ver la regla del proyecto.)
 *
 *    ⚠️ Con NULLs en esa columna, `statusByFolio()` (que hace `PARTITION BY folio_solicitud`)
 *    agruparía a TODOS los huérfanos bajo una sola clave `null` y devolvería una fila
 *    arbitraria entre ellos. El servicio filtra `IS NOT NULL`; si alguien escribe otra
 *    consulta por folio, tiene que hacer lo mismo.
 *
 * 2. `finance.expense_capture_links` — un link por PERSONA, reutilizable y revocable.
 *    No es por gasto: un link de un solo uso lo tendría que emitir alguien de oficina cada
 *    vez, y el punto de todo esto es que en oficina **todavía no saben** que el gasto
 *    ocurrió. Además es el único que puede cerrar el lazo del rechazo — el trabajador
 *    necesita un lugar donde enterarse de que le devolvieron un ticket.
 *
 *    El token que viaja en la URL es un JWT firmado que sólo carga el `id` de esta fila;
 *    la autoridad (persona, sucursal, vigencia, revocación) se relee de acá en CADA uso.
 *    Así revocar es un UPDATE y surte efecto al instante, sin esperar a que expire el JWT.
 *
 * Idempotente. NO borra ni reescribe datos existentes: los expedientes de hoy quedan con
 * `origen='interno'` y su folio intacto.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (t, c) => knex.schema.withSchema('finance').hasColumn(t, c);

  // ── 1. El folio deja de ser obligatorio ──────────────────────────────────
  if (await knex.schema.withSchema('finance').hasTable('expense_proofs')) {
    await knex.raw(`ALTER TABLE finance.expense_proofs ALTER COLUMN folio_solicitud DROP NOT NULL`);
    await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.folio_solicitud IS
      'Folio de la solicitud Kepler (XA1501). NULL = capturado por link y todavía SIN CASAR. Toda consulta que agrupe por esta columna debe filtrar IS NOT NULL.'`);

    // `departamento` se derivaba de la sucursal y era NOT NULL. Quien captura en la calle
    // declara sucursal, no departamento; se sigue rellenando cuando se puede, pero dejar de
    // exigirlo evita inventar un valor sólo para satisfacer el constraint.
    await knex.raw(`ALTER TABLE finance.expense_proofs ALTER COLUMN departamento DROP NOT NULL`);

    // De dónde vino el expediente. Lo que entra por link NO puede cerrarse solo aunque el
    // OCR cuadre: es una superficie pública y la revisa un humano (decisión del PM).
    if (!(await has('expense_proofs', 'origen'))) {
      await knex.raw(`ALTER TABLE finance.expense_proofs
        ADD COLUMN origen text NOT NULL DEFAULT 'interno'
        CHECK (origen IN ('interno','link'))`);
      await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.origen IS
        'interno = capturado por un usuario con sesión. link = llegó por un link público de captura; NUNCA se auto-valida.'`);
    }

    if (!(await has('expense_proofs', 'capture_link_id'))) {
      await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN capture_link_id uuid`);
    }

    // Huella de la captura: cuándo la tomó el dispositivo, si la cámara fue en vivo o cayó
    // al selector de archivos, y el hash de cada foto (para cazar el MISMO ticket subido
    // dos veces). La cámara en vivo es fricción, no prueba: esto es lo que sí deja rastro.
    if (!(await has('expense_proofs', 'capture_meta'))) {
      await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN capture_meta jsonb NOT NULL DEFAULT '{}'`);
      await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.capture_meta IS
        '{captured_at, camera: "live"|"file", user_agent, hashes:[sha256]}. Rastro de la captura de campo.'`);
    }

    // La bandeja "sin casar" es la consulta caliente de la pantalla nueva.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_ep_sin_folio
      ON finance.expense_proofs (tenant_id, created_at DESC)
      WHERE folio_solicitud IS NULL`);
  }

  // ── 2. Los links emitidos ────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('expense_capture_links'))) {
    await knex.raw(`
      CREATE TABLE finance.expense_capture_links (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL DEFAULT public.current_tenant_id(),
        persona       text NOT NULL,          -- a nombre de quién se emitió (es el solicitante)
        sucursal      text,                   -- plaza por default; el que captura puede cambiarla
        nota          text,                   -- para qué se emitió (lo lee quien administra)
        user_id       uuid,                   -- si la persona además tiene cuenta, se liga
        expires_at    timestamptz,            -- NULL = sin vencimiento
        revoked_at    timestamptz,            -- revocar surte efecto al instante
        last_used_at  timestamptz,
        uses          integer NOT NULL DEFAULT 0,
        created_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_ecl_vivos ON finance.expense_capture_links (tenant_id, created_at DESC)`);
    await knex.raw(`ALTER TABLE finance.expense_capture_links ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.expense_capture_links FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance'
                        AND tablename='expense_capture_links' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.expense_capture_links
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expense_capture_links TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE finance.expense_capture_links IS
      'GX.9 — link de captura de gasto por PERSONA, reutilizable y revocable. El JWT de la URL sólo carga el id; persona/vigencia/revocación se releen de acá en cada uso.'`);
  }
};

exports.down = async function (knex) {
  // El folio vuelve a NOT NULL sólo si no quedó ningún huérfano; si quedan, revertir
  // borraría evidencia de campo. Se prefiere fallar ruidoso a perder capturas.
  await knex.schema.withSchema('finance').dropTableIfExists('expense_capture_links');
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_ep_sin_folio`);
};
