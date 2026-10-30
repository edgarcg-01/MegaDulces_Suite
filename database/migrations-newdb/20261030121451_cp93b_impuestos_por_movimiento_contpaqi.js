'use strict';
/**
 * `[CP.9.3b]` — **Los impuestos por movimiento de ContPAQi, en una vista** (`analytics.v_contpaqi_impuesto_movimiento`):
 * qué IVA, IEPS, ISR e impuestos locales asentó contabilidad en cada movimiento de póliza, con qué tasa, base e importe,
 * de qué CFDI y en qué periodo de IVA. Es la segunda implementación del IVA que necesitan el Libro de Compras y el
 * cierre (`FASE_CP9` Ola 1), derivada de la réplica (`contpaqi_ods.ct_movimientosimpuestos`, ADR-111), sin copiar.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30, sid 7688376744939610156) ──────────────────
 *  · 334,491 filas; 0 sin su póliza; 27,737 sin UUID.
 *  · Los códigos, decodificados por su distribución y por la etiqueta de ContPAQi (`nombreimplocal`):
 *    `impuesto` 1 ISR · 2 IVA · 3 IEPS · 4 local (ISH, cedular…) · 5 «Otras Erogaciones» (no es impuesto: base 0) ·
 *    0 SIN NOMBRE (21,267 filas: se publica como `sin_clasificar`, no se adivina);
 *    `tipomovimiento` 1 traslado · 2 retención; `tipofactor` 1 tasa · 2 cuota · 3 exento.
 *  · La tasa viene en POR CIENTO: en 107,872 de 107,872 filas de IVA con tasa y base (16, 8, 4 y 10.6667 %),
 *    importe = base × tasa / 100.
 *  · Testigo: el CFDI (`fiscal.cfdis.total_trasladados`), por UUID, ene–sep 2026, los que están en UNA póliza.
 *    Traslados de IVA + IEPS + locales:
 *      ingreso PUE 3,541 de 3,634 (97.4 %) · nota de crédito PUE 1,193 de 1,225 y PPD 101 de 104, con SIGNO CONTRARIO ·
 *      ingreso PPD 5,593 de 8,386 exactos, y 786 más con la proporción del pago (IVA del pago parcial).
 *    Y con el CFDI en 2+ pólizas, ContPAQi asienta el impuesto completo en CADA una (213 de 257: pólizas × CFDI).
 *  · `imptotal` NO se publica: es base + impuesto en el IVA (99.9 %) pero sólo en el 43 % del IEPS. Quien lo
 *    necesite suma `base + importe`.
 *
 * ── Cómo se lee, sin equivocarse ─────────────────────────────────────────────────────────────
 *  1. Las notas de crédito (CFDI tipo E) van con el signo contrario al del CFDI.
 *  2. Sumar por UUID a través de pólizas cuenta el impuesto una vez POR PÓLIZA (provisión y pago, por ejemplo).
 *  3. En un CFDI PPD, la póliza del pago lleva la proporción pagada.
 *
 * Crea dos índices en la réplica (por UUID y por póliza) y la vista. Sin la réplica (dev o CI sin datos) no hace nada.
 * Se verifica al aplicarse y ABORTA si la tasa no está en por ciento (menos del 95 % de las filas de IVA con tasa y
 * base cumplen importe = base × tasa / 100): la vista diría una unidad falsa. ⛔ No sólo las del 16 %: con la tasa en
 * fracción (0.16) ninguna fila diría «16» y la verificación pasaría en vacío.
 *
 * Idempotente. La prueba: `database/tests/test-newdb-contpaqi-impuestos.js`.
 *
 * @param { import("knex").Knex } knex
 */

const ODS = 'contpaqi_ods';
const FUENTES = ['ct_movimientosimpuestos', 'ct_polizas', 'ct_cuentas', 'ct_personas'];
// ⛔ El índice por UUID lleva la expresión EXACTA de la columna de la vista (con el NULLIF): con `upper(btrim(uuid))`
// a secas el planificador no lo puede usar y cada búsqueda recorre las 334 mil filas (lo cazó la prueba).
const INDICES = [
  ['ix_cp93b_imp_uuid', 'ct_movimientosimpuestos', `(NULLIF(upper(btrim(uuid)), ''))`],
  ['ix_cp93b_imp_poliza', 'ct_movimientosimpuestos', '(idpoliza)'],
];
const VISTA = 'analytics.v_contpaqi_impuesto_movimiento';
const TENANT = `'00000000-0000-0000-0000-00000000d01c'::uuid`;
/** Mínimo de filas de IVA con tasa y base que deben cumplir importe = base × tasa / 100. Medido: 100 %. */
const MINIMO_EN_POR_CIENTO = 0.95;

const SQL_VISTA = `
CREATE OR REPLACE VIEW ${VISTA} AS
SELECT ${TENANT} AS tenant_id,
       i.id AS impuesto_id,
       p.id AS poliza_id, p.ejercicio, p.periodo, p.tipopol AS tipo_pol, p.folio, p.fecha::date AS fecha,
       i.nummovto AS num_movto,
       NULLIF(upper(btrim(i.uuid)), '') AS cfdi_uuid,
       i.ejercicioasignado AS ejercicio_asignado, i.periodoasignado AS periodo_asignado,
       i.impuesto AS impuesto_codigo,
       CASE i.impuesto WHEN 1 THEN 'ISR' WHEN 2 THEN 'IVA' WHEN 3 THEN 'IEPS' WHEN 4 THEN 'local'
                       WHEN 5 THEN 'otras_erogaciones' ELSE 'sin_clasificar' END AS impuesto,
       NULLIF(btrim(i.nombreimplocal), '') AS nombre_local,
       CASE i.tipomovimiento WHEN 1 THEN 'traslado' WHEN 2 THEN 'retencion' ELSE 'sin_clasificar' END AS tipo_movimiento,
       CASE i.tipofactor WHEN 1 THEN 'tasa' WHEN 2 THEN 'cuota' WHEN 3 THEN 'exento' ELSE 'sin_clasificar' END AS tipo_factor,
       -- En tasa, POR CIENTO (16 = 16 %); en cuota, el monto por unidad.
       round(i.tasaocuota::numeric, 6) AS tasa_o_cuota,
       round(i.impbase::numeric, 2) AS base,
       round(i.impimpuesto::numeric, 2) AS importe,
       round(i.ivanoacred::numeric, 2) AS iva_no_acreditable,
       i.aplicaimpuesto AS aplica, i.desglosado,
       btrim(c.codigo) AS cuenta,
       NULLIF(upper(btrim(pe.rfc)), '') AS persona_rfc, btrim(pe.nombre) AS persona_nombre
  FROM ${ODS}.ct_movimientosimpuestos i
  JOIN ${ODS}.ct_polizas p ON p.id = i.idpoliza
  LEFT JOIN ${ODS}.ct_cuentas c ON c.id = i.idcuenta
  LEFT JOIN ${ODS}.ct_personas pe ON pe.id = i.idpersona`;

/** La unidad de la tasa, probada en los datos: todo IVA con tasa y base, sea cual sea la tasa. */
const SQL_VERIFICA_UNIDAD = `
SELECT count(*)::int AS filas,
       count(*) FILTER (WHERE abs(importe - base * tasa_o_cuota / 100) <= 1)::int AS en_por_ciento
  FROM ${VISTA}
 WHERE impuesto = 'IVA' AND tipo_factor = 'tasa' AND tasa_o_cuota > 0 AND base > 1`;

exports.up = async function up(knex) {
  const hay = (await knex.raw(`SELECT ${FUENTES.map((t, i) => `to_regclass('${ODS}.${t}') AS t${i}`).join(', ')}`)).rows[0];
  // Sin la réplica (dev o CI sin datos) no hay nada que derivar.
  if (Object.values(hay).some((v) => !v)) return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '300s'`);
  for (const [nombre, tabla, expr] of INDICES) await knex.raw(`CREATE INDEX IF NOT EXISTS ${nombre} ON ${ODS}.${tabla} ${expr}`);
  await knex.raw(SQL_VISTA);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'GRANT SELECT ON ${VISTA} TO app_runtime'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${VISTA} TO dev_ro'; END IF;
  END $$`);
  // ⛔ `COMMENT ON` no admite parámetros ligados: el texto va inlineado.
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[CP.9.3b] Impuestos por movimiento de poliza de ContPAQi (MovimientosImpuestos de la replica). tasa_o_cuota en POR CIENTO. Las notas de credito van con signo contrario al CFDI; sumar por UUID entre polizas cuenta el impuesto una vez por poliza; en PPD la poliza del pago lleva la proporcion pagada. impuesto sin_clasificar = codigo 0, sin nombre en ContPAQi.'`);

  const [u] = (await knex.raw(SQL_VERIFICA_UNIDAD)).rows;
  if (u.filas > 0 && u.en_por_ciento / u.filas < MINIMO_EN_POR_CIENTO) {
    throw new Error(`[CP.9.3b] ${VISTA}: sólo ${u.en_por_ciento} de ${u.filas} filas de IVA con tasa cumplen importe = base × tasa / 100:`
      + ' la tasa no está en por ciento y la vista lo afirmaría. No se crea.');
  }
  // eslint-disable-next-line no-console
  console.log(`[CP.9.3b] ${VISTA}: la tasa está en por ciento en ${u.en_por_ciento} de ${u.filas} filas de IVA con tasa`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista y los dos índices de la réplica. Las filas no se tocan. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  for (const [nombre] of INDICES) await knex.raw(`DROP INDEX IF EXISTS ${ODS}.${nombre}`);
};
