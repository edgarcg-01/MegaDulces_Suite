'use strict';
/**
 * `[CGS.59]` — **Cheques y papeles, uno por uno, en el arqueo de la caja.** El arqueo completo
 * (`[CGS.41]`) guardaba «cheques» y «vales y papeles» como UN importe tecleado; esto los vuelve
 * renglones —cada cheque con su banco y número, cada papel con quién debe y por qué— y el importe
 * del arqueo pasa a ser la SUMA de sus renglones, comprobada por la base.
 *
 * Edgar, 2026-10-30: *«pensemos en cómo implementar cuando hay un cheque, crédito o papel. cómo
 * agregar esos apartados»* → *«agreguémoslo»*. Ya lo había pedido el 13-oct (`[CG.100]`: *«dólares y
 * papeles sin pagar… en un apartado diferente»*).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ────────────────────────────────────────
 *  · Los papeles: **el mismo importe desde el 2025-10-06**, re-declarado en 383 arqueos de
 *    Control. Un total suelto se arrastra; nadie sabe quién debe ni por qué.
 *  · El detalle que `[CG.100]` previó (`finance.cash_ledger_cut_vouchers`): **0 filas**.
 *  · Los cheques sí se mueven (del 15 al 19-oct bajaron a menos de una vigésima parte) y ningún
 *    sistema registra cuáles entraron ni cuáles salieron.
 *  · Arqueos completos de la Suite desde que se jubiló Control (22-oct): **0**.
 *
 * ── El modelo ───────────────────────────────────────────────────────────────────────────────
 *  · Una fila por documento POR ARQUEO. `pieza` es la identidad del documento de un arqueo al
 *    siguiente: el que «sigue» conserva la suya y no se vuelve a teclear.
 *  · `estado = 'esta'`: se vio en la caja. `'salio'`: estaba en el arqueo anterior y ya no, CON su
 *    salida (el cheque se depositó o lo devolvió el banco; el papel se pagó o se comprobó). Un
 *    documento no desaparece sin decir a dónde fue: eso es lo que arrastraba Control.
 *  · El papel dice su `clase`: `vale` (alguien de la empresa se llevó efectivo) o `credito` (un
 *    cliente quedó a deber). En Control los dos vivían en la misma columna, `totalcredito`.
 *  · ⛔ `cheques` y `papeles` del arqueo = la suma de sus renglones que ESTÁN. Lo comprueba un
 *    trigger diferido al confirmar la transacción: un total que no sale de sus renglones no entra.
 *    En NULL («no se contó») no lleva renglones. Los arqueos guardados antes de esta migración no se
 *    tocan (el trigger sólo mira lo que se inserta).
 *
 * Es el TESTIGO de la caja, no un libro: no registra movimientos ni toca el libro viejo (LE.0.4).
 * El libro nuevo lo usa como «arqueo de documentos» de `CAJA_DOC` (Fase LE, §4.2).
 *
 * Sólo se agrega (app_runtime sin UPDATE ni DELETE), como el arqueo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CUADRAN = `
CREATE OR REPLACE FUNCTION finance.cash_arqueo_documentos_cuadran() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  -- La misma función sirve a las dos tablas: el renglón se lee como JSON porque PL/pgSQL resuelve
  -- NEW.arqueo_id contra la forma de la tabla que disparó, y el arqueo no tiene esa columna.
  v_id uuid := CASE WHEN TG_TABLE_NAME = 'cash_arqueos' THEN (to_jsonb(NEW) ->> 'id')::uuid
                    ELSE (to_jsonb(NEW) ->> 'arqueo_id')::uuid END;
  a record;
  d record;
BEGIN
  SELECT x.id, x.cheques, x.papeles INTO a FROM finance.cash_arqueos x WHERE x.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(monto) FILTER (WHERE tipo = 'cheque' AND estado = 'esta'), 0) AS cheques,
         count(*) FILTER (WHERE tipo = 'cheque') AS n_cheques,
         coalesce(sum(monto) FILTER (WHERE tipo = 'papel' AND estado = 'esta'), 0) AS papeles,
         count(*) FILTER (WHERE tipo = 'papel') AS n_papeles
    INTO d FROM finance.cash_arqueo_documentos WHERE arqueo_id = v_id;
  IF a.cheques IS NULL AND d.n_cheques > 0 THEN
    RAISE EXCEPTION 'El arqueo dice que no se contaron los cheques y trae % renglón(es) de cheque.', d.n_cheques
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_arqueo_cheques_sin_contar';
  END IF;
  IF a.papeles IS NULL AND d.n_papeles > 0 THEN
    RAISE EXCEPTION 'El arqueo dice que no se contaron los papeles y trae % renglón(es) de papel.', d.n_papeles
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_arqueo_papeles_sin_contar';
  END IF;
  IF a.cheques IS NOT NULL AND a.cheques <> d.cheques THEN
    RAISE EXCEPTION 'Los cheques del arqueo (%) no son la suma de sus renglones (%).', a.cheques, d.cheques
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_arqueo_cheques_no_suman';
  END IF;
  IF a.papeles IS NOT NULL AND a.papeles <> d.papeles THEN
    RAISE EXCEPTION 'Los papeles del arqueo (%) no son la suma de sus renglones (%).', a.papeles, d.papeles
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_arqueo_papeles_no_suman';
  END IF;
  RETURN NULL;
END
$fn$`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('cash_arqueos'))) {
    throw new Error('[CGS.59] falta finance.cash_arqueos ([CGS.41], 20261022112834): los documentos son renglones de un arqueo.');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('cash_arqueo_documentos'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_arqueo_documentos (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        arqueo_id            uuid NOT NULL REFERENCES finance.cash_arqueos(id),
        pieza                uuid NOT NULL,
        tipo                 text NOT NULL,
        clase                text,
        estado               text NOT NULL,
        salida               text,
        salida_nota          text,
        monto                numeric(18,2) NOT NULL,
        banco                text,
        numero               text,
        de_quien             text NOT NULL,
        concepto             text,
        fecha                date,
        created_by           uuid NOT NULL,
        created_by_username  text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cash_arqueo_doc_tipo_chk CHECK (tipo IN ('cheque', 'papel')),
        CONSTRAINT cash_arqueo_doc_clase_chk CHECK (
          (tipo = 'cheque' AND clase IS NULL) OR (tipo = 'papel' AND clase IN ('vale', 'credito'))),
        CONSTRAINT cash_arqueo_doc_estado_chk CHECK (estado IN ('esta', 'salio')),
        CONSTRAINT cash_arqueo_doc_salida_chk CHECK (
          (estado = 'esta' AND salida IS NULL AND salida_nota IS NULL)
          OR (estado = 'salio' AND (
               (tipo = 'cheque' AND salida IN ('depositado', 'devuelto', 'otro'))
            OR (tipo = 'papel' AND salida IN ('pagado', 'comprobado', 'otro'))))),
        CONSTRAINT cash_arqueo_doc_otro_chk CHECK (
          salida IS DISTINCT FROM 'otro' OR length(btrim(coalesce(salida_nota, ''))) >= 3),
        CONSTRAINT cash_arqueo_doc_monto_chk CHECK (monto > 0),
        CONSTRAINT cash_arqueo_doc_quien_chk CHECK (length(btrim(de_quien)) >= 3),
        CONSTRAINT cash_arqueo_doc_cheque_chk CHECK (
          tipo <> 'cheque' OR (length(btrim(coalesce(banco, ''))) >= 2 AND length(btrim(coalesce(numero, ''))) >= 1)),
        CONSTRAINT cash_arqueo_doc_papel_chk CHECK (
          tipo <> 'papel' OR length(btrim(coalesce(concepto, ''))) >= 3)
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_arqueo_doc_pieza
                    ON finance.cash_arqueo_documentos (tenant_id, arqueo_id, pieza)`);
  // Un cheque (banco + número) aparece una sola vez en un arqueo.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_arqueo_doc_cheque
                    ON finance.cash_arqueo_documentos (tenant_id, arqueo_id, upper(btrim(banco)), btrim(numero))
                    WHERE tipo = 'cheque'`);
  // La historia de un documento: en qué arqueos estuvo y desde cuándo.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_arqueo_doc_historia
                    ON finance.cash_arqueo_documentos (tenant_id, pieza)`);

  await knex.raw(`ALTER TABLE finance.cash_arqueo_documentos ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.cash_arqueo_documentos FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='cash_arqueo_documentos' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.cash_arqueo_documentos
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`REVOKE UPDATE, DELETE ON finance.cash_arqueo_documentos FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.cash_arqueo_documentos TO app_runtime`);

  await knex.raw(CUADRAN);
  // Diferidos: el arqueo y sus renglones se insertan en la misma transacción y se comprueban juntos.
  await knex.raw(`DROP TRIGGER IF EXISTS cash_arqueo_documentos_cuadran ON finance.cash_arqueos`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER cash_arqueo_documentos_cuadran
      AFTER INSERT ON finance.cash_arqueos
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION finance.cash_arqueo_documentos_cuadran()`);
  await knex.raw(`DROP TRIGGER IF EXISTS cash_arqueo_documentos_cuadran ON finance.cash_arqueo_documentos`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER cash_arqueo_documentos_cuadran
      AFTER INSERT ON finance.cash_arqueo_documentos
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION finance.cash_arqueo_documentos_cuadran()`);

  await knex.raw(`COMMENT ON TABLE finance.cash_arqueo_documentos IS
    '[CGS.59] Los cheques y los papeles (vales y creditos) de un arqueo de la caja, uno por renglon. pieza = la identidad del documento de un arqueo al siguiente. estado esta = se vio; salio = estaba en el arqueo anterior y ya no, con su salida. Los importes cheques/papeles del arqueo son la suma de sus renglones que estan (trigger diferido). Solo se agrega.'`);
};

/** Deshace sólo si no hay renglones: con renglones, bajarla tira la constancia del arqueo. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('finance').hasTable('cash_arqueo_documentos')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_arqueo_documentos`);
    if (rows[0].n > 0) throw new Error(`[CGS.59] hay ${rows[0].n} renglón(es) de cheques y papeles: bajar la migración tiraría la constancia.`);
  }
  await knex.raw(`DROP TRIGGER IF EXISTS cash_arqueo_documentos_cuadran ON finance.cash_arqueos`);
  await knex.raw(`DROP TABLE IF EXISTS finance.cash_arqueo_documentos`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_arqueo_documentos_cuadran()`);
};
