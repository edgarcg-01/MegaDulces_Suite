'use strict';
/**
 * `[CGS.60]` — **Un movimiento de caja que se hace con cheque o con papel (crédito).** Un cobro
 * puede entrar en cheque o en papel; un pago puede salir con un cheque que está en la caja. Cada
 * documento es un renglón del movimiento, con la MISMA identidad (`pieza`) que usa el arqueo de
 * documentos (`[CGS.59]`), y no cuenta como efectivo: ni entra al cajón ni sale de él.
 *
 * Edgar, 2026-10-30: *«y si un movimiento se quiere hacer con cheque, o papel (crédito)»* →
 * *«sí, hazlo»*.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ────────────────────────────────────────
 *  · El libro sólo conocía efectivo: un cobro tiene «venta a crédito» (un importe suelto, usado en
 *    1 de 184 cobros) y un pago sale del cajón o de CAOS. El cheque no existía.
 *  · Kepler no distingue la forma del cobro: los 2,369 cobros de octubre dicen `c31 = 'Cob'`.
 *  · El corte no restaba ni siquiera la «venta a crédito» del efectivo esperado.
 *
 * ── El modelo ───────────────────────────────────────────────────────────────────────────────
 *  · `finance.cash_ledger_documentos`: un renglón por documento del movimiento. `entra` = llegó con
 *    el movimiento (un cobro en cheque o en papel); `sale` = salió con él (un pago con un cheque
 *    que estaba en la caja).
 *  · ⛔ Lo que hace la base, no sólo el servicio (trigger diferido, al confirmar):
 *      1. los documentos de un movimiento, más lo que pagaron sus retiros de CAOS, no pasan de su
 *         monto: el efectivo nunca queda negativo;
 *      2. un documento sólo SALE si antes entró (por un movimiento o en un arqueo) y sale UNA vez
 *         entre los movimientos vivos.
 *  · El movimiento cancelado deja de contar: sus renglones se ignoran por el estado del movimiento
 *    (no se borran: la constancia queda).
 *  · `analytics.v_caja_reparto_movimiento` gana `en_documentos`, y `en_cajon` pasa a ser
 *    `monto − en_boveda − en_documentos`: un cobro en cheque no se lee como efectivo del cajón.
 *
 * Toca el libro viejo (LE.0.4 lo congela): excepción declarada, aprobada por Edgar («sí, hazlo»).
 * El libro nuevo la necesita igual: su operación en sombra lee esta captura (LE.5.1).
 *
 * Sólo se agrega (app_runtime sin UPDATE ni DELETE en los renglones).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_caja_reparto_movimiento';

/** Lo que pagaron los retiros de CAOS de un movimiento (la misma expresión de `[CG.139]`). */
const EN_BOVEDA = `CASE WHEN l.origen_tipo = 'caos' THEN l.monto
                ELSE coalesce((SELECT sum(k.monto_enlazado)
                                 FROM finance.caos_cash_links k
                                WHERE k.cash_ledger_id = l.id
                                  AND k.deleted_at IS NULL), 0)
           END`;

const REPARTO = (conDocumentos) => `
    SELECT l.tenant_id,
           l.id              AS cash_ledger_id,
           l.folio,
           l.sucursal,
           l.fecha,
           l.created_at,
           l.tipo,
           l.estado,
           l.origen_tipo,
           l.monto,
           -- Lo que nunca pasó por el cajón.
           ${EN_BOVEDA} AS en_boveda,
           -- Lo que sí llegó al cajón: el resto. En un cobro de ruta, la morralla.
           l.monto - ${EN_BOVEDA}${conDocumentos ? `
             - coalesce((SELECT sum(d.monto) FROM finance.cash_ledger_documentos d
                          WHERE d.cash_ledger_id = l.id), 0)` : ''} AS en_cajon,
           -- ⚠️ CON QUÉ se repartió. 'sin_enlace' = nadie lo declaró, NO "quedó todo en el cajón".
           CASE WHEN l.origen_tipo = 'caos' THEN 'nacio_en_la_maquina'
                WHEN EXISTS (SELECT 1 FROM finance.caos_cash_links k
                              WHERE k.cash_ledger_id = l.id AND k.deleted_at IS NULL) THEN 'enlazado'
                ELSE 'sin_enlace'
           END AS reparto_via${conDocumentos ? `,
           -- \`[CGS.60]\` Lo que fue en cheque o en papel: ni entró al cajón ni salió de él.
           coalesce((SELECT sum(d.monto) FROM finance.cash_ledger_documentos d
                      WHERE d.cash_ledger_id = l.id), 0) AS en_documentos` : ''}
      FROM finance.cash_ledger l
     WHERE l.deleted_at IS NULL`;

const REGLAS = `
CREATE OR REPLACE FUNCTION finance.cash_ledger_documentos_reglas() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  m record;
  v_docs numeric;
  v_caos numeric;
BEGIN
  SELECT l.id, l.monto, l.estado, l.deleted_at, l.origen_tipo INTO m
    FROM finance.cash_ledger l WHERE l.id = NEW.cash_ledger_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 1. Documentos + retiros de CAOS no pasan del monto: el efectivo del movimiento no es negativo.
  SELECT coalesce(sum(d.monto), 0) INTO v_docs
    FROM finance.cash_ledger_documentos d WHERE d.cash_ledger_id = m.id;
  SELECT CASE WHEN m.origen_tipo = 'caos' THEN m.monto
              ELSE coalesce((SELECT sum(k.monto_enlazado) FROM finance.caos_cash_links k
                              WHERE k.cash_ledger_id = m.id AND k.deleted_at IS NULL), 0) END
    INTO v_caos;
  IF v_docs + v_caos > m.monto + 0.005 THEN
    RAISE EXCEPTION 'Los cheques y papeles (%) más lo que pagó CAOS (%) pasan del monto del movimiento (%).', v_docs, v_caos, m.monto
      USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_documentos_exceden';
  END IF;

  -- 2. Un documento sale sólo si entró, y una vez entre los movimientos vivos.
  IF NEW.sentido = 'sale' THEN
    IF NOT EXISTS (
         SELECT 1 FROM finance.cash_ledger_documentos e
           JOIN finance.cash_ledger le ON le.id = e.cash_ledger_id
          WHERE e.tenant_id = NEW.tenant_id AND e.pieza = NEW.pieza AND e.sentido = 'entra'
            AND le.deleted_at IS NULL AND le.estado <> 'cancelado')
       AND NOT EXISTS (
         SELECT 1 FROM finance.cash_arqueo_documentos a
          WHERE a.tenant_id = NEW.tenant_id AND a.pieza = NEW.pieza) THEN
      RAISE EXCEPTION 'Ese documento nunca entró a la caja: no puede salir.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_documentos_sin_entrada';
    END IF;
    IF (SELECT count(*) FROM finance.cash_ledger_documentos s
          JOIN finance.cash_ledger ls ON ls.id = s.cash_ledger_id
         WHERE s.tenant_id = NEW.tenant_id AND s.pieza = NEW.pieza AND s.sentido = 'sale'
           AND ls.deleted_at IS NULL AND ls.estado <> 'cancelado') > 1 THEN
      RAISE EXCEPTION 'Ese documento ya salió de la caja con otro movimiento.'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_documentos_sale_dos_veces';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$`;

async function permisosDeLaVista(knex) {
  // ⛔ `security_invoker` y los GRANT no sobreviven a un `CREATE OR REPLACE VIEW` (ADR-057).
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  for (const rol of ['app_runtime', 'dev_ro']) {
    await knex.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA analytics TO ${rol}';
        EXECUTE 'GRANT SELECT ON ${VISTA} TO ${rol}';
      END IF;
    END $$`);
  }
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const t of ['cash_ledger', 'caos_cash_links', 'cash_arqueo_documentos']) {
    if (!(await knex.schema.withSchema('finance').hasTable(t))) {
      throw new Error(`[CGS.60] falta finance.${t}: los documentos de un movimiento se apoyan en ella (cash_arqueo_documentos es [CGS.59], 20261030095100).`);
    }
  }

  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_documentos'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_documentos (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        cash_ledger_id       uuid NOT NULL REFERENCES finance.cash_ledger(id),
        pieza                uuid NOT NULL,
        sentido              text NOT NULL,
        tipo                 text NOT NULL,
        clase                text,
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
        CONSTRAINT cash_ledger_doc_sentido_chk CHECK (sentido IN ('entra', 'sale')),
        CONSTRAINT cash_ledger_doc_tipo_chk CHECK (tipo IN ('cheque', 'papel')),
        CONSTRAINT cash_ledger_doc_clase_chk CHECK (
          (tipo = 'cheque' AND clase IS NULL) OR (tipo = 'papel' AND clase IN ('vale', 'credito'))),
        CONSTRAINT cash_ledger_doc_monto_chk CHECK (monto > 0),
        CONSTRAINT cash_ledger_doc_quien_chk CHECK (length(btrim(de_quien)) >= 3),
        CONSTRAINT cash_ledger_doc_cheque_chk CHECK (
          tipo <> 'cheque' OR (length(btrim(coalesce(banco, ''))) >= 2 AND length(btrim(coalesce(numero, ''))) >= 1)),
        CONSTRAINT cash_ledger_doc_papel_chk CHECK (
          tipo <> 'papel' OR length(btrim(coalesce(concepto, ''))) >= 3)
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ledger_doc_pieza
                    ON finance.cash_ledger_documentos (tenant_id, cash_ledger_id, pieza)`);
  // Un documento nuevo entra con UN movimiento.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_ledger_doc_entra
                    ON finance.cash_ledger_documentos (tenant_id, pieza) WHERE sentido = 'entra'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_ledger_doc_movimiento
                    ON finance.cash_ledger_documentos (cash_ledger_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cash_ledger_doc_historia
                    ON finance.cash_ledger_documentos (tenant_id, pieza)`);

  await knex.raw(`ALTER TABLE finance.cash_ledger_documentos ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_documentos FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='cash_ledger_documentos' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.cash_ledger_documentos
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`REVOKE UPDATE, DELETE ON finance.cash_ledger_documentos FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.cash_ledger_documentos TO app_runtime`);

  await knex.raw(REGLAS);
  await knex.raw(`DROP TRIGGER IF EXISTS cash_ledger_documentos_reglas ON finance.cash_ledger_documentos`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER cash_ledger_documentos_reglas
      AFTER INSERT ON finance.cash_ledger_documentos
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_documentos_reglas()`);

  await knex.raw(`COMMENT ON TABLE finance.cash_ledger_documentos IS
    '[CGS.60] Los cheques y papeles con que se hizo un movimiento de caja: entra = llego con el (un cobro en cheque o en papel); sale = salio con el (un pago con un cheque de la caja). pieza = la misma identidad del arqueo de documentos ([CGS.59]). No es efectivo: el corte lo resta del esperado. Un movimiento cancelado deja de contar. Solo se agrega.'`);

  // El reparto: lo que fue en cheque o papel no es efectivo del cajón.
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${REPARTO(true)}`);
  await permisosDeLaVista(knex);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[CG.139][CGS.60] El reparto de CADA movimiento de caja: lo que se fue a la boveda (CAOS), lo que fue en cheque o papel (en_documentos) y lo que llego al cajon (el resto). reparto_via dice con que se repartio la boveda; sin_enlace NO significa que todo quedo en el cajon.'`);

  // ⛔ El candado de la vista: boveda + documentos + cajon = monto, fila por fila.
  const [{ rotas, filas }] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE round(en_boveda + en_documentos + en_cajon, 2) <> round(monto, 2))::int AS rotas,
           count(*)::int AS filas
      FROM ${VISTA}`)).rows;
  if (Number(rotas) !== 0) {
    throw new Error(`[CGS.60] el reparto no conserva el monto en ${rotas} fila(s): la migración se revierte entera.`);
  }
  // eslint-disable-next-line no-console
  console.log(`[CGS.60] finance.cash_ledger_documentos lista · ${VISTA}: ${filas} movimiento(s), conservación OK.`);
};

/** Deshace sólo si no hay renglones: con renglones, bajarla tira la constancia del movimiento. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('finance').hasTable('cash_ledger_documentos')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_ledger_documentos`);
    if (rows[0].n > 0) throw new Error(`[CGS.60] hay ${rows[0].n} documento(s) de movimientos: bajar la migración tiraría la constancia.`);
  }
  // La vista vuelve a su forma de `[CG.139]`: sin la columna nueva (CREATE OR REPLACE no quita columnas).
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  await knex.raw(`CREATE VIEW ${VISTA} AS ${REPARTO(false)}`);
  await permisosDeLaVista(knex);
  await knex.raw(`DROP TABLE IF EXISTS finance.cash_ledger_documentos`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_documentos_reglas()`);
};
