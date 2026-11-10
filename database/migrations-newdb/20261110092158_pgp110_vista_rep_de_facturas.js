'use strict';
/**
 * `[PGP.110]` — **El REP de cada factura, por vista sobre la réplica de ContPAQi** (derivar, no copiar).
 *
 * La póliza de egreso de una factura PPD se completa cuando llega el REP (complemento de pago) que el
 * proveedor timbra después de cobrar: mediana 3.5 días, p90 24 (`[PGP.107]` en la fase). El ADD de
 * ContPAQi ya los tiene y la réplica `contpaqi_ods` (ADR-111) los trae; ninguna vista los leía.
 * Agregar el tipo P al importer de CFDI no servía: sólo lee la cabecera, no qué facturas paga.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10) ───────────────────────────────────────────
 *  · `add_pagos_doc_rel`: 154,874 ligas (151,920 del repositorio principal); `iddocumento` es el UUID de
 *    la factura pagada, en mayúsculas como `fiscal.cfdis.uuid`; trae parcialidad, saldo anterior,
 *    pagado y saldo insoluto. Las 154,874 casan con su comprobante (`add_comprobante`, el REP) y con
 *    su documento (`add_documento`).
 *  · Cancelación: `add_documento.canceldate` en 230 ligas (162 sin texto de estado, 65 «Cancelable sin
 *    aceptación», 3 «Cancelado sin aceptación»). Se expone la fecha y el texto, sin interpretarlos.
 *  · ⛔ La réplica NO está viva: corrió una vez el 2026-10-30 (`_sync_status` = «carga inicial»). Esta
 *    vista dice lo que la réplica sabe; mientras no se reviva el carril (D15 + extender el replicador),
 *    los REP posteriores al 30-oct no aparecen. Lo declara quien la consuma.
 *  · `add_pagos_doc_rel` sólo tiene índice por `(idpago, iddoctounique, _repo)`: buscar por factura
 *    recorría las 155 mil filas. Se agrega uno por `upper(iddocumento)`. El replicador vacía y recopia
 *    las FILAS, no la tabla: el índice sobrevive (como los de `[CP.9.3]`).
 *
 * ── Qué crea ───────────────────────────────────────────────────────────────────────────────────
 *  · Índice `ix_cods_pagos_doc_rel_factura` en `contpaqi_ods.add_pagos_doc_rel (upper(iddocumento))`.
 *  · `analytics.v_rep_de_factura`: una fila por (REP × factura pagada).
 *  Sin la réplica (dev o CI sin datos) no hace nada: no hay de qué derivar.
 *
 * Se verifica al aplicarse: la vista da exactamente una fila por liga (ningún cruce multiplica). Si no
 * cuadra, aborta y no queda nada.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const ODS = 'contpaqi_ods';
const VISTA = 'analytics.v_rep_de_factura';
const FUENTES = ['add_pagos_doc_rel', 'add_pagos', 'add_comprobante', 'add_documento'];
const INDICE = ['ix_cods_pagos_doc_rel_factura', 'add_pagos_doc_rel', '(upper(iddocumento))'];

const SQL_VISTA = `
CREATE OR REPLACE VIEW ${VISTA} AS
SELECT upper(dr.iddocumento)            AS factura_uuid,
       upper(c.uuid::text)              AS rep_uuid,
       upper(btrim(c.rfcemisor))        AS emisor_rfc,
       upper(btrim(c.rfcreceptor))      AS receptor_rfc,
       c.fechatimbrado                  AS rep_timbrado,
       p.fechapago                      AS fecha_pago,
       p.formadepagop                   AS forma_pago,
       dr.metododepagodr                AS metodo_pago_factura,
       dr.numparcialidad                AS parcialidad,
       dr.impsaldoant                   AS saldo_anterior,
       dr.imppagado                     AS pagado,
       dr.impsaldoinsoluto              AS saldo_insoluto,
       d.canceldate                     AS cancelado_en,
       nullif(btrim(d.cancelstatus), '') AS estado_cancelacion,
       dr._repo                         AS repositorio,
       dr._synced_at                    AS copiado_en
  FROM ${ODS}.add_pagos_doc_rel dr
  JOIN ${ODS}.add_pagos p        ON p.idpago = dr.idpago AND p._repo = dr._repo
  JOIN ${ODS}.add_comprobante c  ON c.guiddocument = dr.guiddocument AND c._repo = dr._repo
  LEFT JOIN ${ODS}.add_documento d ON d.guiddocument = dr.guiddocument AND d._repo = dr._repo`;

const conceder = (vista) => `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'GRANT SELECT ON ${vista} TO app_runtime'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${vista} TO dev_ro'; END IF;
END $$`;

exports.up = async function up(knex) {
  const hay = (await knex.raw(`SELECT ${FUENTES.map((t, i) => `to_regclass('${ODS}.${t}') AS t${i}`).join(', ')}`)).rows[0];
  // Sin la réplica (dev o CI sin datos) no hay nada que derivar.
  if (Object.values(hay).some((v) => !v)) return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '300s'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDICE[0]} ON ${ODS}.${INDICE[1]} ${INDICE[2]}`);
  await knex.raw(SQL_VISTA);
  await knex.raw(conceder(VISTA));
  // ⛔ `COMMENT ON` no admite parámetros ligados: el texto va inlineado.
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PGP.110] El REP (complemento de pago) de cada factura, desde la replica de ContPAQi (add_pagos_doc_rel + add_pagos + add_comprobante + add_documento). factura_uuid y rep_uuid en mayusculas. La replica corrio una vez el 2026-10-30: lo posterior no esta hasta revivir el carril.'`);

  const [v] = (await knex.raw(`SELECT (SELECT count(*) FROM ${VISTA})::bigint AS vista, (SELECT count(*) FROM ${ODS}.add_pagos_doc_rel)::bigint AS ligas`)).rows;
  if (Number(v.vista) !== Number(v.ligas)) {
    throw new Error(`[PGP.110] ${VISTA}: la vista da ${v.vista} filas y hay ${v.ligas} ligas (un cruce multiplica o pierde filas): no se crea.`);
  }
  // eslint-disable-next-line no-console
  console.log(`[PGP.110] ${VISTA}: ${v.vista} ligas REP × factura, una fila cada una.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista y el índice de la réplica. Las filas no se tocan. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  await knex.raw(`DROP INDEX IF EXISTS ${ODS}.${INDICE[0]}`);
};
