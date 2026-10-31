'use strict';
/**
 * `[LE.0.8]` — **Un folio emitido no desaparece**: un movimiento con folio oficial se cancela, no
 * se borra, y el consecutivo sólo avanza de uno en uno.
 *
 * La auditoría «como un banco» del 2026-10-31 (fase LE) encontró folios sin rastro: la secuencia
 * de gastos va en 613 y hay 490 movimientos `CG`; la de ingresos en 268 y hay 235 `CI`.
 *
 * ── Lo medido antes (prod, sólo lectura, sid 7688376744939610156, 2026-10-31) ────────────────
 *  · Los 123 huecos de gastos están en UN tramo, 156–278, dado de alta el 19-oct (20 sobreviven).
 *    La bitácora del libro (CGS.10) nació el 21-oct: la causa de ese tramo es NO MEDIDA.
 *  · Desde el 21-oct, 0 DELETE en `analytics.master_data_history` sobre el libro.
 *  · La app nunca borra un movimiento (el único `.del()` de la caja es el del desglose del corte) y
 *    las dos que toman folio (`cash-ledger.service`, `cash-cut.service`) avanzan la secuencia +1.
 *  · 3 borrados lógicos, los tres cancelados (pruebas apartadas por una migración el 20-oct).
 *  · Las pruebas usan folios propios (`UNA-…`, `CIV-…`) y los borran al limpiar: la regla sólo
 *    cuida el folio OFICIAL (`CI|CG|CD-AAAA-NNNNN`, `caja-autofill.engine.ts` `buildFolio`).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. En `finance.cash_ledger`, un movimiento con folio oficial no se borra, no cambia de folio, y
 *     sólo se aparta (`deleted_at`) si ya está cancelado (`cash_ledger_folio_no_se_borra_chk`).
 *  2. En `finance.cash_ledger_sequences`, el consecutivo sólo sube de uno en uno
 *     (`folio_consecutivo_chk`): ni salta ni retrocede. El índice único del folio ya impide reusarlo.
 *
 * La API desplegada no manda nada nuevo (expand/contract). Al final lo prueba con filas reales
 * dentro de puntos de guardado que se deshacen.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OFICIAL = '^C[GID]-[0-9]{4}-[0-9]{5}$';

const FUNCIONES = `
CREATE OR REPLACE FUNCTION finance.cash_ledger_folio_no_desaparece()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
  BEGIN
    IF OLD.folio !~ '${OFICIAL}' THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'El folio % ya se emitió: no se borra, se cancela.', OLD.folio
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_folio_no_se_borra_chk';
    END IF;
    IF NEW.folio IS DISTINCT FROM OLD.folio THEN
      RAISE EXCEPTION 'El folio % ya se emitió: no cambia de número.', OLD.folio
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_folio_no_se_borra_chk';
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.estado <> 'cancelado' THEN
      RAISE EXCEPTION 'El folio % está vivo: primero se cancela, con su motivo; después se puede apartar.', OLD.folio
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_folio_no_se_borra_chk';
    END IF;
    RETURN NEW;
  END
$function$;

CREATE OR REPLACE FUNCTION finance.cash_ledger_sequence_de_uno_en_uno()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
  BEGIN
    IF NEW.current_value IS DISTINCT FROM OLD.current_value + 1 THEN
      RAISE EXCEPTION 'El consecutivo % % sólo avanza de uno en uno: iba en % y se quiso poner en %.',
        OLD.tipo, OLD.year, OLD.current_value, NEW.current_value
        USING ERRCODE = 'check_violation', CONSTRAINT = 'folio_consecutivo_chk';
    END IF;
    RETURN NEW;
  END
$function$;
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(FUNCIONES);
  await knex.raw(`COMMENT ON FUNCTION finance.cash_ledger_folio_no_desaparece() IS
    '[LE.0.8] Un movimiento con folio oficial no se borra ni cambia de folio, y solo se aparta si ya esta cancelado (auditoria del 2026-10-31: 155 folios sin rastro).'`);
  await knex.raw(`COMMENT ON FUNCTION finance.cash_ledger_sequence_de_uno_en_uno() IS
    '[LE.0.8] El consecutivo de folios solo avanza de uno en uno.'`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_folio_no_desaparece ON finance.cash_ledger`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_ledger_folio_no_desaparece
      BEFORE UPDATE OF folio, deleted_at OR DELETE ON finance.cash_ledger
      FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_folio_no_desaparece()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_sequence_de_uno_en_uno ON finance.cash_ledger_sequences`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_ledger_sequence_de_uno_en_uno
      BEFORE UPDATE OF current_value ON finance.cash_ledger_sequences
      FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_sequence_de_uno_en_uno()`);

  await probar(knex);
};

async function probar(knex) {
  const casos = [];
  // Un movimiento con folio oficial que NO esté en un corte firmado: si lo estuviera, CGS.11 lo
  // frenaría primero y no se mediría esta regla.
  const { rows: suelto } = await knex.raw(`
    SELECT l.id, l.folio FROM finance.cash_ledger l
      LEFT JOIN finance.cash_ledger_cuts c ON c.id = l.corte_id
     WHERE l.tenant_id = ? AND l.folio ~ ? AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       AND (l.corte_id IS NULL OR c.estado = 'borrador')
     ORDER BY l.created_at DESC LIMIT 1`, [TENANT, OFICIAL]);
  if (suelto.length) {
    const m = suelto[0];
    casos.push(
      [`borrar ${m.folio}`, 'FALLA', 'cash_ledger_folio_no_se_borra_chk', `DELETE FROM finance.cash_ledger WHERE id = '${m.id}'`],
      [`apartar ${m.folio} sin cancelarlo`, 'FALLA', 'cash_ledger_folio_no_se_borra_chk', `UPDATE finance.cash_ledger SET deleted_at = now() WHERE id = '${m.id}'`],
      [`cambiarle el número a ${m.folio}`, 'FALLA', 'cash_ledger_folio_no_se_borra_chk', `UPDATE finance.cash_ledger SET folio = folio || 'X' WHERE id = '${m.id}'`],
    );
  } else {
    console.log('  ⚠️ [LE.0.8] NO MEDIDO: no hay un movimiento oficial fuera de un corte firmado para probar el borrado.');
  }
  const { rows: sec } = await knex.raw(
    `SELECT tenant_id, year, tipo FROM finance.cash_ledger_sequences WHERE tenant_id = ? ORDER BY current_value DESC LIMIT 1`, [TENANT]);
  if (sec.length) {
    const s = sec[0];
    const W = (expr) => `UPDATE finance.cash_ledger_sequences SET current_value = ${expr}
      WHERE tenant_id = '${s.tenant_id}' AND year = ${Number(s.year)} AND tipo = '${s.tipo}'`;
    casos.push(
      [`saltar el consecutivo de ${s.tipo}`, 'FALLA', 'folio_consecutivo_chk', W('current_value + 2')],
      [`regresar el consecutivo de ${s.tipo}`, 'FALLA', 'folio_consecutivo_chk', W('current_value - 1')],
      [`avanzar el consecutivo de ${s.tipo} en uno (control)`, 'PASA', null, W('current_value + 1')],
    );
  } else {
    console.log('  ⚠️ [LE.0.8] NO MEDIDO: no hay consecutivo con qué probar.');
  }

  const fallos = [];
  for (const [nombre, espera, candado, sql] of casos) {
    await knex.raw('SAVEPOINT le08_prueba');
    let real;
    let detalle = '';
    try {
      await knex.raw(sql);
      real = 'PASA';
    } catch (e) {
      real = e.constraint === candado ? 'FALLA' : 'OTRO_ERROR';
      detalle = ` (${e.constraint || e.message})`;
    }
    await knex.raw('ROLLBACK TO SAVEPOINT le08_prueba');
    await knex.raw('RELEASE SAVEPOINT le08_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}${detalle}`);
  }
  if (fallos.length) throw new Error(`[LE.0.8] la regla no se comporta como debe:\n    - ${fallos.join('\n    - ')}`);
  if (casos.length) console.log(`  ✔ [LE.0.8] ${casos.length} casos probados contra filas reales, todos revertidos.`);
}

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_folio_no_desaparece ON finance.cash_ledger`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_sequence_de_uno_en_uno ON finance.cash_ledger_sequences`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_folio_no_desaparece()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_sequence_de_uno_en_uno()`);
};
