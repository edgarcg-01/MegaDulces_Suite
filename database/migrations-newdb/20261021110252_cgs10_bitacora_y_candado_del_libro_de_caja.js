'use strict';
/**
 * `[CGS.10][CGS.11][CGS.16]` — El libro de caja deja rastro de cada cambio, lo firmado ya no se
 * edita por debajo, y quien autoriza un corte no puede haber capturado en él.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §4 C0.
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-21) ────────────────────────────────────────────
 *  · **28** movimientos de cortes YA CERRADOS se editaron después del cierre, en 7 tandas, los
 *    28 con `updated_by` NULL. Fueron migraciones; no quedó ni quién ni el valor anterior.
 *  · `CI-2026-00063` ($10,105.00) pasó de `ingreso` a `gasto` DENTRO del corte firmado
 *    CC-2026-00007 (CGA-A.42). La nota del corte dice «las cifras firmadas no se modificaron»,
 *    y es cierto del corte — pero el movimiento sí, así que el corte ya no se reconstruye desde
 *    sus propios movimientos.
 *  · La única tabla de cambios del módulo es `cash_ledger_reclasificaciones` (una clase de cambio).
 *  · `maria_gutierrez` (rol `tesoreria`, la que autoriza desde CGS.1) capturó **29 de 30**
 *    movimientos del 20-oct. La doble llave de hoy (`cut_doble_llave_chk`) sólo separa a quien
 *    CERRÓ de quien autoriza; nada le impide autorizar el corte de sus propias capturas.
 *    Decisión D3 de Edgar (2026-10-21): *«captura, pero no firma lo suyo»*.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `[CGS.10]` **Bitácora**: NO se inventa una tabla. Se cuelga el historial genérico que ya
 *     existe (`analytics.master_data_history` + `analytics.log_master_data_change`, VP.3.1) de
 *     `finance.cash_ledger` y `finance.cash_ledger_cuts`. ADR-056: un primitivo que ya vive en la
 *     base se reusa, no se reimplementa. El historial es sólo-agregar (app_runtime: INSERT/SELECT)
 *     y registra `current_user`, así que distingue la app de una migración sin que nadie declare.
 *  2. `[CGS.11]` **Candado de base sobre lo firmado**: un movimiento cuyo corte ya no es
 *     `borrador` no cambia importe, tipo, cuenta, día, sucursal, estado ni corte, y no se borra.
 *     Sigue pudiendo cambiar lo que es VÍNCULO o EVIDENCIA (origen, documento declarado, firma,
 *     autollenado): eso no mueve ningún número del corte y llega tarde con razón. Hasta hoy esto
 *     lo cuidaba sólo el servicio (`puedeCancelarse`); las migraciones pasaban por debajo.
 *  3. `[CGS.16]` **Quien autoriza no puede ser quien abrió el corte ni quien capturó o canceló un
 *     movimiento de él.** En la base, igual que la doble llave.
 *
 * ⚠️ Ningún camino de la app escribe hoy las columnas congeladas sobre un corte cerrado:
 *    `cancelar` y `reclasificar` ya lo rechazan, el vigía de fechas futuras salta los cortes
 *    firmados, y cerrar adjunta movimientos con `corte_id` NULL (antes de cerrar). Verificado en
 *    `cash-cut.service.ts` y `caja-fecha-futura-scanner.service.ts` el 2026-10-21.
 *
 * El `up` se prueba a sí mismo contra los datos reales dentro de SAVEPOINTs que se deshacen, como
 * `[CGS.4]`. Sin cortes cerrados (base nueva del CI) lo declara NO MEDIDO; la prueba completa está
 * en `database/tests/test-newdb-caja-supervision.js`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** Columnas del historial. Validadas contra el catálogo: una que no exista sería un hueco mudo. */
const VIGILADAS = {
  'finance.cash_ledger': [
    'tipo', 'fecha', 'hora', 'sucursal', 'kepler_cuenta', 'kepler_concepto', 'glosa',
    'beneficiario', 'beneficiario_rfc', 'monto', 'morralla', 'venta_credito', 'estado', 'corte_id',
    'origen_tipo', 'origen_ref', 'origen_uuid', 'declared_doc_ref', 'sin_documento_motivo',
    'firma_estado', 'deleted_at', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_by',
  ],
  'finance.cash_ledger_cuts': [
    'estado', 'fecha', 'sucursal', 'fondo_inicial', 'fondo_origen', 'total_ingresos',
    'total_gastos', 'total_depositos', 'esperado', 'contado', 'morralla', 'diferencia', 'nota',
    'closed_by', 'closed_at', 'authorized_by', 'authorized_at', 'conteo_previo',
    'reconteo_motivo', 'corrected_by', 'corrected_at',
  ],
};

const CONGELADO = `
CREATE OR REPLACE FUNCTION finance.cash_ledger_congelado()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
    DECLARE
      v_estado text;
      v_folio  text;
    BEGIN
      IF OLD.corte_id IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;

      SELECT estado, folio INTO v_estado, v_folio
        FROM finance.cash_ledger_cuts
       WHERE id = OLD.corte_id AND tenant_id = OLD.tenant_id;
      -- Sin corte visible (lo está borrando su CASCADE) o todavía en borrador: nada que cuidar.
      IF NOT FOUND OR v_estado = 'borrador' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'El movimiento % está en el corte % (%): no se borra. Si estaba mal, se corrige con un ajuste en la jornada abierta.',
          OLD.folio, v_folio, v_estado
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_en_corte_firmado_chk';
      END IF;

      -- Lo que mueve un número del corte. Lo que no está acá (origen, documento, firma,
      -- autollenado, glosa) es vínculo o evidencia y puede llegar tarde.
      IF (NEW.tenant_id, NEW.tipo, NEW.fecha, NEW.hora, NEW.sucursal, NEW.kepler_cuenta,
          NEW.kepler_concepto, NEW.monto, NEW.morralla, NEW.venta_credito, NEW.estado,
          NEW.corte_id, NEW.deleted_at, NEW.cancelled_at, NEW.created_by, NEW.created_at)
         IS DISTINCT FROM
         (OLD.tenant_id, OLD.tipo, OLD.fecha, OLD.hora, OLD.sucursal, OLD.kepler_cuenta,
          OLD.kepler_concepto, OLD.monto, OLD.morralla, OLD.venta_credito, OLD.estado,
          OLD.corte_id, OLD.deleted_at, OLD.cancelled_at, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'El movimiento % está en el corte % (%): su importe, tipo, cuenta, día y estado ya no cambian. Si estaba mal, se corrige con un ajuste en la jornada abierta.',
          OLD.folio, v_folio, v_estado
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_en_corte_firmado_chk';
      END IF;
      RETURN NEW;
    END
$function$;
`;

const AUTORIZA_AJENO = `
CREATE OR REPLACE FUNCTION finance.cash_cut_autoriza_ajeno()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
    DECLARE
      v_capturas int;
    BEGIN
      IF NEW.estado <> 'autorizado' OR NEW.authorized_by IS NULL THEN
        RETURN NEW;
      END IF;
      IF OLD.estado = 'autorizado' AND OLD.authorized_by IS NOT DISTINCT FROM NEW.authorized_by THEN
        RETURN NEW;   -- ya estaba autorizado por la misma persona: nada nuevo que juzgar
      END IF;

      IF NEW.created_by = NEW.authorized_by THEN
        RAISE EXCEPTION 'Quien abrió el corte % no puede autorizarlo: tiene que hacerlo otra persona.', NEW.folio
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_autoriza_lo_ajeno_chk';
      END IF;

      SELECT count(*) INTO v_capturas
        FROM finance.cash_ledger l
       WHERE l.tenant_id = NEW.tenant_id AND l.corte_id = NEW.id
         AND (l.created_by = NEW.authorized_by OR l.cancelled_by = NEW.authorized_by);
      IF v_capturas > 0 THEN
        RAISE EXCEPTION 'Quien autoriza el corte % capturó o canceló % movimiento(s) de él: lo tiene que autorizar otra persona.',
          NEW.folio, v_capturas
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_autoriza_lo_ajeno_chk';
      END IF;
      RETURN NEW;
    END
$function$;
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: fn } = await knex.raw(
    `SELECT to_regprocedure('analytics.log_master_data_change()') AS f,
            to_regclass('analytics.master_data_history') AS t`);
  if (!fn[0].f || !fn[0].t) {
    throw new Error('[CGS.10] no existe el historial genérico (VP.3.1): no se inventa otro, se aplica primero 20260907130000.');
  }

  // ── 1. Bitácora ────────────────────────────────────────────────────────────────────────
  for (const [tabla, cols] of Object.entries(VIGILADAS)) {
    const [schema, name] = tabla.split('.');
    const { rows } = await knex.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?`,
      [schema, name]);
    const existentes = new Set(rows.map((r) => r.column_name));
    const faltantes = cols.filter((c) => !existentes.has(c));
    if (faltantes.length) {
      throw new Error(`[CGS.10] ${tabla}: columnas vigiladas inexistentes → ${faltantes.join(', ')}`);
    }
    const args = cols.map((c) => `'${c}'`).join(', ');
    await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON ${tabla}`);
    await knex.raw(`
      CREATE TRIGGER trg_master_data_history
        AFTER UPDATE OR DELETE ON ${tabla}
        FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${args})`);
  }

  // ── 2. Candado de lo firmado ───────────────────────────────────────────────────────────
  await knex.raw(CONGELADO);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_congelado ON finance.cash_ledger`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_ledger_congelado
      BEFORE UPDATE OR DELETE ON finance.cash_ledger
      FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_congelado()`);

  // ── 3. Quien autoriza, ajeno al corte ──────────────────────────────────────────────────
  const { rows: ya } = await knex.raw(
    `SELECT folio FROM finance.cash_ledger_cuts c
      WHERE c.estado = 'autorizado'
        AND (c.created_by = c.authorized_by OR EXISTS (
              SELECT 1 FROM finance.cash_ledger l
               WHERE l.tenant_id = c.tenant_id AND l.corte_id = c.id
                 AND (l.created_by = c.authorized_by OR l.cancelled_by = c.authorized_by)))`);
  if (ya.length) {
    throw new Error(`[CGS.16] ${ya.length} corte(s) YA autorizados violan la regla nueva (${ya.map((r) => r.folio).join(', ')}). Revisalos antes.`);
  }
  await knex.raw(AUTORIZA_AJENO);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_autoriza_ajeno ON finance.cash_ledger_cuts`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_cut_autoriza_ajeno
      BEFORE UPDATE OF estado, authorized_by ON finance.cash_ledger_cuts
      FOR EACH ROW EXECUTE FUNCTION finance.cash_cut_autoriza_ajeno()`);

  await knex.raw(`COMMENT ON FUNCTION finance.cash_ledger_congelado() IS
    '[CGS.11] Un movimiento de un corte que ya no es borrador no cambia importe, tipo, cuenta, dia, sucursal, estado ni corte, y no se borra. Vinculo y evidencia si.'`);
  await knex.raw(`COMMENT ON FUNCTION finance.cash_cut_autoriza_ajeno() IS
    '[CGS.16] Quien autoriza un corte no lo abrio ni capturo o cancelo ninguno de sus movimientos (D3, Edgar 2026-10-21).'`);

  await probar(knex);
};

async function probar(knex) {
  const casos = [];
  const { rows: movs } = await knex.raw(
    `SELECT l.id, l.folio FROM finance.cash_ledger l
       JOIN finance.cash_ledger_cuts c ON c.id = l.corte_id
      WHERE c.estado <> 'borrador' AND l.estado <> 'cancelado'
      ORDER BY c.fecha DESC LIMIT 1`);
  if (movs.length) {
    const m = movs[0];
    const W = (sets) => `UPDATE finance.cash_ledger SET ${sets} WHERE id = '${m.id}'`;
    casos.push(
      ['cambiar el importe de un movimiento firmado', 'FALLA', W('monto = monto + 1')],
      ['cambiar su tipo', 'FALLA', W(`tipo = CASE WHEN tipo = 'gasto' THEN 'ingreso' ELSE 'gasto' END`)],
      ['sacarlo del corte', 'FALLA', W('corte_id = NULL')],
      ['borrarlo', 'FALLA', `DELETE FROM finance.cash_ledger WHERE id = '${m.id}'`],
      ['corregir su glosa (evidencia, no número)', 'PASA_CON_RASTRO', W(`glosa = glosa || '.'`)],
    );
    casos.forEach((c) => { c.pk = m.id; });
  } else {
    console.log('  ⚠️ [CGS.11] NO MEDIDO: no hay movimientos en cortes cerrados para probar el candado.');
  }

  const { rows: cs } = await knex.raw(
    `SELECT c.id, c.folio, c.closed_by, c.created_by,
            (SELECT l.created_by FROM finance.cash_ledger l
              WHERE l.corte_id = c.id AND l.created_by <> c.closed_by LIMIT 1) AS capturista,
            (SELECT u.id FROM identity.users u
              WHERE u.tenant_id = c.tenant_id AND u.id <> c.closed_by AND u.id <> c.created_by
                AND NOT EXISTS (SELECT 1 FROM finance.cash_ledger l
                                 WHERE l.corte_id = c.id
                                   AND (l.created_by = u.id OR l.cancelled_by = u.id))
              LIMIT 1) AS ajeno
       FROM finance.cash_ledger_cuts c
      WHERE c.estado = 'cerrado'
      ORDER BY (SELECT count(*) FROM finance.cash_ledger l
                 WHERE l.corte_id = c.id AND l.created_by <> c.closed_by) DESC, c.fecha DESC
      LIMIT 1`);
  if (cs.length && cs[0].capturista && cs[0].ajeno) {
    const c = cs[0];
    const A = (u) => `UPDATE finance.cash_ledger_cuts SET estado = 'autorizado', authorized_by = '${u}',
      authorized_by_username = 'prueba_cgs16', authorized_at = now() WHERE id = '${c.id}'`;
    casos.push(
      [`autorizar ${c.folio} con quien capturó en él`, 'FALLA', A(c.capturista)],
      [`autorizar ${c.folio} con quien lo abrió`, 'FALLA', A(c.created_by)],
      [`autorizar ${c.folio} con alguien ajeno`, 'PASA', A(c.ajeno)],
    );
  } else {
    console.log('  ⚠️ [CGS.16] NO MEDIDO: no hay un corte cerrado con un capturista distinto de quien cerró.');
  }

  const fallos = [];
  for (const caso of casos) {
    const [nombre, espera, sql, pk] = [caso[0], caso[1], caso[2], caso.pk];
    await knex.raw('SAVEPOINT cgs10_prueba');
    let real;
    try {
      const antes = pk ? (await knex.raw(
        `SELECT count(*)::int AS n FROM analytics.master_data_history WHERE tabla = 'finance.cash_ledger' AND pk = ?`, [pk])).rows[0].n : 0;
      await knex.raw(sql);
      real = 'PASA';
      if (espera === 'PASA_CON_RASTRO') {
        const despues = (await knex.raw(
          `SELECT count(*)::int AS n FROM analytics.master_data_history WHERE tabla = 'finance.cash_ledger' AND pk = ?`, [pk])).rows[0].n;
        real = despues === antes + 1 ? 'PASA_CON_RASTRO' : `PASA_SIN_RASTRO (${antes}→${despues})`;
      }
    } catch (e) {
      real = 'FALLA';
      caso.err = e.constraint || e.message;
    }
    await knex.raw('ROLLBACK TO SAVEPOINT cgs10_prueba');
    await knex.raw('RELEASE SAVEPOINT cgs10_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}`);
  }
  if (fallos.length) {
    throw new Error(`[CGS.10] los candados no se comportan como deben:\n    - ${fallos.join('\n    - ')}`);
  }
  if (casos.length) console.log(`  ✔ [CGS.10/11/16] ${casos.length} casos probados contra datos reales, todos revertidos.`);
}

/** Deshace EXACTAMENTE lo que hizo el `up`. El historial ya escrito se conserva: es historia. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_autoriza_ajeno ON finance.cash_ledger_cuts`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_cut_autoriza_ajeno()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_congelado ON finance.cash_ledger`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_congelado()`);
  for (const tabla of Object.keys(VIGILADAS)) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON ${tabla}`);
  }
};
