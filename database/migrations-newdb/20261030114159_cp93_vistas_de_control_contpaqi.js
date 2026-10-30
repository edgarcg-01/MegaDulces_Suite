'use strict';
/**
 * `[CP.9.3]` — **Las vistas de control sobre la réplica de ContPAQi** (`contpaqi_ods`, ADR-111): qué CFDI está en qué
 * póliza, y qué ejercicio está cerrado. Las dos preguntas que el dictamen (`[CP.8.95]`) y el candado anti-duplicado
 * (`[CP.8.88]`) tienen que hacerle a ContPAQi, contestadas por VISTA sobre la réplica (derivar, no copiar).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30, sid 7688376744939610156) ──────────────────
 *  · `AsocCFDIs.GuidRef` apunta al MOVIMIENTO (411,321) o a la PÓLIZA entera (587,445); 1,020 no apuntan a nada.
 *    `AsocDoctosAdministrativos` (135,822) y los nodos de pago (11,308) son otros dos caminos al mismo hecho.
 *  · La vista da 1,145,894 asociaciones y 519,781 CFDI. Contra la marca del ADD (`fiscal.cfdis.aso_contabilidad`, otro
 *    sistema), CFDI de ene–sep 2026: **99.40 % de acuerdo**; el placebo (la marca del CFDI vecino) da 91.73 %, que es
 *    el azar con 95 % de asociados, y la vista se equivoca 14 veces menos que él (kappa 0.93). Los 271 que sólo la
 *    vista asocia pasan TODOS por documentos administrativos: es un punto ciego de la marca del ADD.
 *  · ⛔ El staging que usa hoy el dictamen (`analytics.gl_poliza_lines.cfdi_uuid`) conoce 21,363 UUID contra 137,116 de
 *    la vista desde 2025 (16 %): liga un solo UUID por movimiento, ninguno a nivel póliza, y no se entera cuando
 *    contabilidad reasocia (12 renglones rancios). De lo que sí tiene, la vista contiene el 99.98 %.
 *  · Ejercicios: cerrado ⟺ `IdPolCierre` > 0, y esa póliza es la «POLIZA ANUAL DE RESULTADOS» del periodo 14 en los 8
 *    cerrados (2017–2024); los abiertos (2025, 2026) no tienen ninguna póliza en el periodo 14. Después del cierre de
 *    2024 entraron 24 pólizas de ese ejercicio: el cierre no impide capturar.
 *
 * ── Qué crea ───────────────────────────────────────────────────────────────────────────────────
 *  1. Índices por expresión en la réplica, para buscar por UUID o por póliza sin recorrer un millón de filas. El
 *     replicador no los toca: vacía y recopia las filas, no la tabla.
 *  2. `analytics.v_contpaqi_cfdi_poliza` — una fila por asociación (CFDI × póliza, y el movimiento si es a ese nivel).
 *  3. `analytics.v_contpaqi_ejercicio` — una fila por ejercicio: cerrado o no, su póliza de cierre y cuántas pólizas
 *     entraron después.
 *  Sin la réplica (dev o CI sin datos) no hace nada: no hay de qué derivar.
 *
 * Se verifica al aplicarse; si no cuadra, aborta y no queda nada:
 *  · la vista de asociaciones da tantas filas como asociaciones con destino cuenta OTRO camino (semi-join), en la misma
 *    instantánea. Un GUID repetido multiplicaría filas y lo detiene aquí;
 *  · todo ejercicio cerrado tiene su póliza de cierre, del mismo ejercicio y del periodo 14. Que un ejercicio abierto
 *    tenga pólizas en el periodo 14 sólo se informa: contabilidad puede ajustar ahí antes de cerrar.
 *
 * Idempotente. La prueba: `database/tests/test-newdb-contpaqi-vistas-control.js`.
 *
 * @param { import("knex").Knex } knex
 */

const ODS = 'contpaqi_ods';
const FUENTES = ['ct_asoccfdis', 'ct_asocdoctosadministrativos', 'ct_asoccfdinodosdepago', 'ct_movimientospoliza',
  'ct_polizas', 'ct_cuentas', 'ct_ejercicios'];
const INDICES = [
  ['ix_cp93_asoc_uuid', 'ct_asoccfdis', '(upper(btrim(uuid)))'],
  ['ix_cp93_asoc_guid', 'ct_asoccfdis', '(upper(btrim(guidref)))'],
  ['ix_cp93_docadm_uuid', 'ct_asocdoctosadministrativos', '(upper(btrim(uuid)))'],
  ['ix_cp93_docadm_guid', 'ct_asocdoctosadministrativos', '(upper(btrim(guidpoliza)))'],
  ['ix_cp93_nodo_uuid', 'ct_asoccfdinodosdepago', '(upper(btrim(uuidrep)))'],
  ['ix_cp93_nodo_guid', 'ct_asoccfdinodosdepago', '(upper(btrim(guidreferencia)))'],
  ['ix_cp93_mov_guid', 'ct_movimientospoliza', '(upper(btrim(guid)))'],
  ['ix_cp93_mov_poliza', 'ct_movimientospoliza', '(idpoliza)'],
  ['ix_cp93_pol_guid', 'ct_polizas', '(upper(btrim(guid)))'],
  ['ix_cp93_pol_folio', 'ct_polizas', '(ejercicio, periodo, tipopol, folio)'],
];
const V_CFDI = 'analytics.v_contpaqi_cfdi_poliza';
const V_EJERCICIO = 'analytics.v_contpaqi_ejercicio';
// La réplica es de una sola empresa, sin tenant: la vista lo declara, como las de `kepler_ods`.
const TENANT = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

/** Las tres fuentes de una asociación, con la llave ya normalizada (mayúsculas, sin espacios; vacía = no hay). */
const ASOCIACIONES = `
  SELECT a.id AS asociacion_id, 'asoc_cfdis'::text AS origen, upper(btrim(a.uuid)) AS cfdi_uuid,
         upper(btrim(a.guidref)) AS guid, btrim(a.apptype) AS app, NULL::integer AS num_nodo_pago
    FROM ${ODS}.ct_asoccfdis a
   WHERE btrim(coalesce(a.uuid, '')) <> '' AND btrim(coalesce(a.guidref, '')) <> ''
  UNION ALL
  SELECT d.id, 'documento_administrativo', upper(btrim(d.uuid)), upper(btrim(d.guidpoliza)), 'Contabilidad', NULL
    FROM ${ODS}.ct_asocdoctosadministrativos d
   WHERE btrim(coalesce(d.uuid, '')) <> '' AND btrim(coalesce(d.guidpoliza, '')) <> ''
  UNION ALL
  SELECT n.id, 'nodo_de_pago', upper(btrim(n.uuidrep)), upper(btrim(n.guidreferencia)), btrim(n.aplicationtype), n.numnodopago
    FROM ${ODS}.ct_asoccfdinodosdepago n
   WHERE btrim(coalesce(n.uuidrep, '')) <> '' AND btrim(coalesce(n.guidreferencia, '')) <> ''`;

const SQL_CFDI = `
CREATE OR REPLACE VIEW ${V_CFDI} AS
WITH asoc AS (${ASOCIACIONES})
SELECT ${TENANT} AS tenant_id,
       x.cfdi_uuid, x.origen, x.asociacion_id, x.app, x.num_nodo_pago,
       CASE WHEN m.id IS NOT NULL THEN 'movimiento' ELSE 'poliza' END AS nivel,
       p.id AS poliza_id, p.ejercicio, p.periodo, p.tipopol AS tipo_pol, p.folio, p.fecha::date AS fecha,
       btrim(p.concepto) AS concepto,
       m.nummovto AS num_movto, btrim(c.codigo) AS cuenta, btrim(c.nombre) AS cuenta_nombre,
       CASE WHEN m.id IS NULL THEN NULL WHEN m.tipomovto THEN 'A' ELSE 'C' END AS cargo_abono,
       round(m.importe::numeric, 2) AS importe
  FROM asoc x
  LEFT JOIN ${ODS}.ct_movimientospoliza m ON upper(btrim(m.guid)) = x.guid
  -- La póliza entera sólo si el GUID no es de un movimiento (medido: ninguno es de los dos).
  LEFT JOIN ${ODS}.ct_polizas pp ON m.id IS NULL AND upper(btrim(pp.guid)) = x.guid
  -- Sin destino (la póliza o el movimiento ya no existen) la asociación no contesta nada: queda fuera.
  JOIN ${ODS}.ct_polizas p ON p.id = coalesce(m.idpoliza, pp.id)
  LEFT JOIN ${ODS}.ct_cuentas c ON c.id = m.idcuenta`;

const SQL_EJERCICIO = `
CREATE OR REPLACE VIEW ${V_EJERCICIO} AS
SELECT ${TENANT} AS tenant_id,
       e.ejercicio, e.fecinieje::date AS inicio, e.fecfineje::date AS fin, e.periodos,
       (coalesce(e.idpolcierre, 0) > 0) AS cerrado,
       pc.id AS poliza_cierre_id, pc.periodo AS poliza_cierre_periodo, pc.tipopol AS poliza_cierre_tipo,
       pc.folio AS poliza_cierre_folio,
       d.n AS polizas_despues_del_cierre
  FROM ${ODS}.ct_ejercicios e
  LEFT JOIN ${ODS}.ct_polizas pc ON pc.id = NULLIF(e.idpolcierre, 0)
  -- El Id crece con cada alta: lo que tiene un Id mayor que la póliza de cierre entró después de cerrar.
  LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM ${ODS}.ct_polizas p
                      WHERE p.ejercicio = e.ejercicio AND p.id > e.idpolcierre) d ON coalesce(e.idpolcierre, 0) > 0`;

/**
 * La misma cuenta que la vista de asociaciones, por OTRO camino: un semi-join (`IN`) en vez de joins, en una sola
 * instantánea. Con la misma regla de destino que la vista (un movimiento cuenta si su póliza existe): a media vuelta de la
 * sincronía puede haber un movimiento cuya póliza todavía no llegó, y eso no es un error de la vista. ⛔ No con
 * `EXISTS … OR EXISTS`: Postgres no lo vuelve semi-join y recorre la tabla por cada fila (medido: más de 120 s).
 */
const SQL_VERIFICA_CFDI = `
SELECT (SELECT count(*) FROM ${V_CFDI})::bigint AS vista,
       (SELECT count(*) FROM (${ASOCIACIONES}) a
         WHERE a.guid IN (SELECT upper(btrim(m.guid)) FROM ${ODS}.ct_movimientospoliza m
                           WHERE m.idpoliza IN (SELECT id FROM ${ODS}.ct_polizas)
                          UNION ALL
                          SELECT upper(btrim(p.guid)) FROM ${ODS}.ct_polizas p))::bigint AS por_otro_camino`;

/** El testigo del cierre, desde las tablas crudas y no desde la vista. */
const SQL_VERIFICA_EJERCICIO = `
SELECT count(*) FILTER (WHERE coalesce(e.idpolcierre, 0) > 0)::int AS cerrados,
       count(*) FILTER (WHERE coalesce(e.idpolcierre, 0) > 0
                          AND (pc.id IS NULL OR pc.ejercicio <> e.ejercicio OR pc.periodo <> 14))::int AS cerrados_sin_testigo,
       count(*) FILTER (WHERE coalesce(e.idpolcierre, 0) = 0
                          AND EXISTS (SELECT 1 FROM ${ODS}.ct_polizas p WHERE p.ejercicio = e.ejercicio AND p.periodo = 14))::int
         AS abiertos_con_periodo_14
  FROM ${ODS}.ct_ejercicios e
  LEFT JOIN ${ODS}.ct_polizas pc ON pc.id = NULLIF(e.idpolcierre, 0)`;

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
  for (const [nombre, tabla, expr] of INDICES) await knex.raw(`CREATE INDEX IF NOT EXISTS ${nombre} ON ${ODS}.${tabla} ${expr}`);
  await knex.raw(SQL_CFDI);
  await knex.raw(SQL_EJERCICIO);
  for (const v of [V_CFDI, V_EJERCICIO]) await knex.raw(conceder(v));
  // ⛔ `COMMENT ON` no admite parámetros ligados: el texto va inlineado.
  await knex.raw(`COMMENT ON VIEW ${V_CFDI} IS
    '[CP.9.3] Que CFDI esta en que poliza de ContPAQi, desde la replica (AsocCFDIs, AsocDoctosAdministrativos y nodos de pago). nivel = movimiento o poliza. cfdi_uuid en mayusculas. Sin las asociaciones cuyo destino ya no existe.'`);
  await knex.raw(`COMMENT ON VIEW ${V_EJERCICIO} IS
    '[CP.9.3] Ejercicios de ContPAQi: cerrado = tiene poliza de cierre (Ejercicios.IdPolCierre, periodo 14). El cierre NO impide capturar: polizas_despues_del_cierre las cuenta.'`);

  const [c] = (await knex.raw(SQL_VERIFICA_CFDI)).rows;
  if (Number(c.vista) !== Number(c.por_otro_camino)) {
    throw new Error(`[CP.9.3] ${V_CFDI}: la vista da ${c.vista} filas y el otro camino ${c.por_otro_camino} asociaciones con destino`
      + ' (¿un GUID repetido multiplica filas?): no se crea.');
  }
  const [e] = (await knex.raw(SQL_VERIFICA_EJERCICIO)).rows;
  if (e.cerrados_sin_testigo > 0) {
    throw new Error(`[CP.9.3] ${V_EJERCICIO}: ${e.cerrados_sin_testigo} de ${e.cerrados} ejercicios cerrados no tienen su póliza de cierre`
      + ' en el periodo 14 del mismo ejercicio: «cerrado» no significaría lo que dice. No se crea.');
  }
  // eslint-disable-next-line no-console
  console.log(`[CP.9.3] ${V_CFDI}: ${c.vista} asociaciones, igual por los dos caminos · ${V_EJERCICIO}: ${e.cerrados} cerrados con`
    + ` testigo${e.abiertos_con_periodo_14 ? ` · ⚠️ ${e.abiertos_con_periodo_14} abiertos con pólizas en el periodo 14` : ''}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos vistas y los índices de la réplica. Las filas no se tocan. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V_EJERCICIO}`);
  await knex.raw(`DROP VIEW IF EXISTS ${V_CFDI}`);
  for (const [nombre] of INDICES) await knex.raw(`DROP INDEX IF EXISTS ${ODS}.${nombre}`);
};
