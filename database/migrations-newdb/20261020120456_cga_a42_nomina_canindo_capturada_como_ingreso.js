'use strict';
/**
 * `[CGA-A.42]` — La nómina 42 de Canindo ($10,105, 19-oct) se capturó como INGRESO.
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────────────────────────
 *
 * `CI-2026-00063` («NOMINA EFECTIVO», $10,105.00) se capturó a mano el 19-oct como ingreso, con la
 * cuenta 115/071 (abono a clientes) y la nota de Carmen «NO APARECE EN SUITE»: el documento de
 * Kepler todavía no salía en la bandeja. En Kepler ese movimiento es `06|X-D-26|0000161|0011`,
 * «NOMINA 42 EN EFECTIVO CANINDO», $10,105.00, **signo −1: es un GASTO**. `[CGA-A.31]` lo había
 * declarado como «reintegro de nómina»; Edgar lo corrigió el 20-oct: es el egreso de la nómina.
 *
 * ── Por qué se corrige EN SU LUGAR, contra la regla de siempre ──────────────────────────────
 *
 * La regla del proyecto (`cash-cut.service.ts`, `reclasificar`) es que un movimiento que ya entró
 * a un corte no se toca: «registra un movimiento que lo corrija». Aquí esa salida empeora las
 * cosas: **cada corte arranca del conteo físico del anterior** (medido: `CC-2026-00007` abrió con
 * $618.50, lo contado en `CC-2026-00006`), así que el error del 19-oct quedó encerrado en ese
 * corte. Un gasto de corrección hoy restaría $20,210 al esperado del corte de HOY, que no tuvo el
 * error. Edgar autorizó la excepción el 2026-10-20.
 *
 * ── Qué cambia ──────────────────────────────────────────────────────────────────────────────
 *
 * En el movimiento: tipo → gasto; vínculo a su documento (`pago_proveedor`,
 * `06|X-D-26|0000161|0011`; el `declared_doc_ref` que puso `[CGA-A.31]` sobra con el vínculo);
 * sucursal → 06 (la del documento, como queda cualquier captura desde la bandeja); cuenta →
 * 601-001 / 002 «NOMINA EFECTIVO.», la que tienen los 4 gastos de nómina de Canindo vinculados a su
 * documento (medido 4 de 4, ningún otro par). El cambio de cuenta queda en la bitácora
 * `finance.cash_ledger_reclasificaciones` (origen `manual`), como cualquier reclasificación.
 *
 * ⛔ **Las cifras firmadas de `CC-2026-00007` NO se tocan** (`cut_firmado_inmutable_chk` lo
 * impide, y debe). Se escribe sólo en su `nota`, que no está congelada: el esperado firmado
 * ($296,867.09) incluyó este movimiento como ingreso; el real es $276,657.09 (−$20,210) y la
 * diferencia real −$188,384.59 en lugar de −$208,594.59.
 *
 * ⚠️ El folio sigue empezando con `CI-` aunque ahora sea gasto: el folio es la identidad del
 *    movimiento y cambiarlo rompería referencias. Queda explicado en su nota.
 * ⚠️ Sólo hace UPDATE/INSERT de datos: aplicala con `aplicar-migracion.sh` ANTES de mergear.
 *
 * Idempotente. Todas las guardas corren antes de la primera escritura.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FOLIO = 'CI-2026-00063';
const DOC = { sucursal: '06', doc_tipo: 'X-D-26', folio: '0000161', clave: '0011', importe: '10105.00' };
const REF = `${DOC.sucursal}|${DOC.doc_tipo}|${DOC.folio}|${DOC.clave}`;
const CORTE = 'CC-2026-00007';
const ANTES = { tipo: 'ingreso', sucursal: '00', cuenta: '115', concepto: '071', cuenta_nombre: 'ABONO A CLIENTES', concepto_nombre: 'ABONO A CLIENTES' };
const DESPUES = { tipo: 'gasto', sucursal: '06', cuenta: '601-001', concepto: '002', cuenta_nombre: 'CAJA DE AHORRO', concepto_nombre: 'NOMINA EFECTIVO.' };
const CORTE_FIRMADO = { esperado: '296867.09', contado: '88272.50', diferencia: '-208594.59' };
const CORTE_REAL = { esperado: '276657.09', diferencia: '-188384.59' };
const MARCA = 'CGA-A.42 (2026-10-20)';

const NOTA_MOV = `${MARCA}: capturado como INGRESO por error; es el EGRESO de la nomina 42 de Canindo (Kepler ${REF}, signo -1). Corregido en su lugar por autorizacion de Edgar: un movimiento de correccion en la jornada abierta descuadraria el corte de hoy, porque cada corte arranca del conteo fisico. El folio conserva el prefijo CI.`;
const NOTA_CORTE = `${MARCA}: el esperado firmado ($${CORTE_FIRMADO.esperado}) incluyo ${FOLIO} ($10,105.00) como INGRESO; era un GASTO. Esperado real $${CORTE_REAL.esperado}; diferencia real ${CORTE_REAL.diferencia} en lugar de ${CORTE_FIRMADO.diferencia}. Las cifras firmadas no se modificaron.`;
const MOTIVO_RECL = `${MARCA}: ${FOLIO} se capturo como ingreso con la cuenta de abono a clientes; es la nomina 42 de Canindo (${REF}). Cuenta de los 4 gastos de nomina de Canindo vinculados.`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const abortar = (m) => { throw new Error(`[CGA-A.42] ${m} -- migracion abortada, no se toco ninguna fila.`); };
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  // Guarda 1: el movimiento es el que se midió (o ya quedó corregido: idempotencia).
  const { rows } = await knex.raw(
    `SELECT l.id, l.tipo, l.estado, l.deleted_at, l.monto, l.sucursal, l.origen_tipo, l.origen_ref, l.declared_doc_ref,
            l.kepler_cuenta, l.kepler_concepto, l.corte_id, c.folio AS corte_folio, c.estado AS corte_estado,
            c.esperado, c.contado, c.diferencia, c.nota AS corte_nota
       FROM finance.cash_ledger l LEFT JOIN finance.cash_ledger_cuts c ON c.id = l.corte_id
      WHERE l.tenant_id = ? AND l.folio = ?`, [TENANT, FOLIO]);
  if (rows.length !== 1) abortar(`${FOLIO}: esperaba 1 fila y hay ${rows.length}`);
  const m = rows[0];
  if (m.deleted_at || m.estado === 'cancelado') abortar(`${FOLIO}: esta borrado o cancelado`);
  if (Math.abs(Number(m.monto) - Number(DOC.importe)) > 0.001) abortar(`${FOLIO}: monto ${m.monto}, se midio ${DOC.importe}`);
  if (m.corte_folio !== CORTE || m.corte_estado !== 'cerrado') abortar(`${FOLIO}: esperaba el corte ${CORTE} cerrado y esta en ${m.corte_folio} ${m.corte_estado}`);
  const yaHecho = m.tipo === DESPUES.tipo && m.origen_tipo === 'pago_proveedor' && m.origen_ref === REF;
  if (!yaHecho) {
    if (m.tipo !== ANTES.tipo) abortar(`${FOLIO}: esperaba ${ANTES.tipo} y es ${m.tipo}`);
    if (m.origen_tipo !== null) abortar(`${FOLIO}: ya tiene origen ${m.origen_tipo} ${m.origen_ref}`);
    if (m.declared_doc_ref !== null && m.declared_doc_ref !== REF) abortar(`${FOLIO}: declara otro documento (${m.declared_doc_ref})`);
    if (m.kepler_cuenta !== ANTES.cuenta || m.kepler_concepto !== ANTES.concepto || m.sucursal !== ANTES.sucursal) {
      abortar(`${FOLIO}: cuenta/sucursal ya no son las medidas (${m.sucursal} ${m.kepler_cuenta}/${m.kepler_concepto}): alguien lo cambio, revisar a mano`);
    }
  }
  // Las cifras del corte siguen siendo las firmadas: la nota las cita.
  if (Number(m.esperado).toFixed(2) !== CORTE_FIRMADO.esperado || Number(m.contado).toFixed(2) !== CORTE_FIRMADO.contado) {
    abortar(`${CORTE}: esperado/contado ${m.esperado}/${m.contado} no son los medidos`);
  }

  // Guarda 2: el documento de Kepler existe, es un gasto, de la Caja General, por ese importe.
  const doc = await knex.raw(
    `SELECT importe, signo, fecha_valor::text AS fecha FROM analytics.mv_caja_movimientos
      WHERE tenant_id = ? AND sucursal = ? AND doc_tipo = ? AND folio = ? AND clave_banco = ?`,
    [TENANT, DOC.sucursal, DOC.doc_tipo, DOC.folio, DOC.clave]);
  if (doc.rows.length !== 1) abortar(`${REF}: esperaba 1 documento y hay ${doc.rows.length}`);
  if (Number(doc.rows[0].signo) >= 0) abortar(`${REF}: no es un gasto (signo ${doc.rows[0].signo})`);
  if (Math.abs(Number(doc.rows[0].importe) - Number(DOC.importe)) > 0.001) abortar(`${REF}: importe ${doc.rows[0].importe}`);
  if (doc.rows[0].fecha !== '2026-10-19') abortar(`${REF}: fecha ${doc.rows[0].fecha}, se midio 2026-10-19`);

  // Guarda 3: ningún OTRO movimiento vivo tiene ya ese documento.
  const usado = await knex.raw(
    `SELECT folio FROM finance.cash_ledger
      WHERE tenant_id = ? AND deleted_at IS NULL AND estado <> 'cancelado' AND folio <> ?
        AND (origen_ref = ? OR declared_doc_ref = ?)`, [TENANT, FOLIO, REF, REF]);
  if (usado.rows.length) abortar(`${REF}: ya lo tiene ${usado.rows[0].folio}`);

  // Guarda 4: la cuenta de nómina de Canindo sigue siendo UNA, la medida.
  const pares = await knex.raw(
    `SELECT kepler_cuenta, kepler_concepto, count(*)::int AS n FROM finance.cash_ledger
      WHERE tenant_id = ? AND sucursal = ? AND tipo = 'gasto' AND estado <> 'cancelado' AND deleted_at IS NULL
        AND origen_tipo = 'pago_proveedor' AND (beneficiario ILIKE '%NOMINA%' OR glosa ILIKE '%NOMINA%') AND folio <> ?
      GROUP BY 1, 2`, [TENANT, DESPUES.sucursal, FOLIO]);
  if (pares.rows.length !== 1 || pares.rows[0].kepler_cuenta !== DESPUES.cuenta || pares.rows[0].kepler_concepto !== DESPUES.concepto) {
    abortar(`la cuenta de nomina de Canindo ya no es una sola ${DESPUES.cuenta}/${DESPUES.concepto}: ${JSON.stringify(pares.rows)}`);
  }

  if (yaHecho) return;

  // ── Escrituras ──
  // La bitácora va ANTES del UPDATE, como en `reclasificar()`.
  await knex.raw(
    `INSERT INTO finance.cash_ledger_reclasificaciones
       (id, tenant_id, cash_ledger_id, de_cuenta, de_concepto, a_cuenta, a_concepto, origen, respaldo, motivo, corte_id, hecho_por_username, created_at)
     VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, now())`,
    [TENANT, m.id, ANTES.cuenta, ANTES.concepto, DESPUES.cuenta, DESPUES.concepto, pares.rows[0].n, MOTIVO_RECL, m.corte_id, 'migracion CGA-A.42']);
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET tipo = ?, sucursal = ?, origen_tipo = 'pago_proveedor', origen_ref = ?, declared_doc_ref = NULL,
            kepler_cuenta = ?, kepler_concepto = ?, kepler_cuenta_nombre = ?, kepler_concepto_nombre = ?,
            sin_documento_motivo = CASE
              WHEN sin_documento_motivo IS NULL OR sin_documento_motivo = '' THEN ?
              WHEN position('CGA-A.42' in sin_documento_motivo) > 0 THEN sin_documento_motivo
              ELSE sin_documento_motivo || ' | ' || ? END,
            updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND tipo = ?`,
    [DESPUES.tipo, DESPUES.sucursal, REF, DESPUES.cuenta, DESPUES.concepto, DESPUES.cuenta_nombre, DESPUES.concepto_nombre,
      NOTA_MOV, NOTA_MOV, TENANT, FOLIO, ANTES.tipo]);
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET nota = CASE WHEN nota IS NULL OR nota = '' THEN ?
                        WHEN position('CGA-A.42' in nota) > 0 THEN nota
                        ELSE nota || ' | ' || ? END,
            updated_at = now()
      WHERE tenant_id = ? AND folio = ?`, [NOTA_CORTE, NOTA_CORTE, TENANT, CORTE]);

  // Comprobación final.
  const fin = await knex.raw(`SELECT tipo, origen_ref FROM finance.cash_ledger WHERE tenant_id = ? AND folio = ?`, [TENANT, FOLIO]);
  if (fin.rows[0].tipo !== 'gasto' || fin.rows[0].origen_ref !== REF) abortar(`${FOLIO}: no quedo corregido`);
};

/** Deshace EXACTAMENTE lo del `up`: tipo, sucursal, cuenta, declaración de A.31, bitácora y notas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET tipo = ?, sucursal = ?, origen_tipo = NULL, origen_ref = NULL, declared_doc_ref = ?,
            kepler_cuenta = ?, kepler_concepto = ?, kepler_cuenta_nombre = ?, kepler_concepto_nombre = ?,
            sin_documento_motivo = NULLIF(regexp_replace(sin_documento_motivo, '( [|] ){0,1}CGA-A[.]42 [(]2026-10-20[)].*$', ''), ''),
            updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND tipo = 'gasto' AND origen_ref = ?`,
    [ANTES.tipo, ANTES.sucursal, REF, ANTES.cuenta, ANTES.concepto, ANTES.cuenta_nombre, ANTES.concepto_nombre, TENANT, FOLIO, REF]);
  await knex.raw(
    `DELETE FROM finance.cash_ledger_reclasificaciones
      WHERE tenant_id = ? AND hecho_por_username = 'migracion CGA-A.42' AND position('CGA-A.42' in motivo) > 0`, [TENANT]);
  await knex.raw(
    `UPDATE finance.cash_ledger_cuts
        SET nota = NULLIF(regexp_replace(nota, '( [|] ){0,1}CGA-A[.]42 [(]2026-10-20[)].*$', ''), ''), updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND position('CGA-A.42' in COALESCE(nota, '')) > 0`, [TENANT, CORTE]);
};
