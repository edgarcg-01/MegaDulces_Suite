'use strict';
/**
 * `[LE.0.7]` — **Un corte que ya no es borrador no recibe movimientos.**
 *
 * La auditoría «como un banco» del 2026-10-31 (fase LE): `trg_cash_ledger_congelado` (CGS.11) cuida
 * lo que YA estaba dentro de un corte firmado, pero un movimiento suelto se podía atar después a un
 * corte cerrado, y pasó: el 22-oct, 5 ingresos por $121,130.53 entraron por SQL directo al
 * `CC-2026-00002`, cerrado el 15-oct.
 *
 * ── Lo medido antes (prod, sólo lectura, sid 7688376744939610156, 2026-10-31) ────────────────
 *  · `analytics.master_data_history`: 481 ataduras de `corte_id`. Las 476 de la app (`app_runtime`)
 *    ocurrieron TODAS dentro del cierre; las 5 de `postgres`, el 22-oct, con el corte ya cerrado.
 *  · 0 altas con `corte_id` puesto después del cierre de su corte.
 *  · El cierre de la app (`cash-cut.service.ts` `cerrar()`) exige el corte en `borrador`, ata y
 *    después sella, en la misma transacción: la regla no choca con el código desplegado.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  Un disparador rechaza dar de alta o atar un movimiento a un corte cuyo estado no es `borrador`
 *  (`cash_ledger_en_corte_firmado_chk`, el mismo nombre del candado de CGS.11: es la otra mitad
 *  de la misma regla). Sacarlo de un corte firmado ya lo frena CGS.11. Las 5 filas del 22-oct no se
 *  tocan: son historia, y su hallazgo vive en la fase LE.
 *
 * Al final lo prueba con una copia del último movimiento, atada a un corte cerrado (debe fallar) y
 * suelta (debe pasar), dentro de puntos de guardado que se deshacen.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

const FUNCION = `
CREATE OR REPLACE FUNCTION finance.cash_ledger_no_entra_a_corte_firmado()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
  DECLARE
    v_estado text;
    v_folio  text;
  BEGIN
    IF NEW.corte_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.corte_id IS NOT DISTINCT FROM OLD.corte_id) THEN
      RETURN NEW;
    END IF;
    SELECT c.estado, c.folio INTO v_estado, v_folio
      FROM finance.cash_ledger_cuts c WHERE c.id = NEW.corte_id;
    IF FOUND AND v_estado <> 'borrador' THEN
      RAISE EXCEPTION 'El corte % ya está %: no recibe movimientos. Lo que llega tarde va al día abierto.', v_folio, v_estado
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cash_ledger_en_corte_firmado_chk';
    END IF;
    RETURN NEW;
  END
$function$;
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(FUNCION);
  await knex.raw(`COMMENT ON FUNCTION finance.cash_ledger_no_entra_a_corte_firmado() IS
    '[LE.0.7] Un movimiento no se da de alta ni se ata a un corte que ya no es borrador (auditoria del 2026-10-31: 5 ingresos atados por SQL a un corte cerrado).'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_no_entra_a_corte_firmado ON finance.cash_ledger`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_ledger_no_entra_a_corte_firmado
      BEFORE INSERT OR UPDATE OF corte_id ON finance.cash_ledger
      FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_no_entra_a_corte_firmado()`);
  await probar(knex);
};

/** Una copia del último movimiento, dada de alta por quien abrió el último corte cerrado. */
async function probar(knex) {
  const { rows: cs } = await knex.raw(`
    SELECT c.id, c.folio, c.created_by FROM finance.cash_ledger_cuts c
     WHERE c.tenant_id = ? AND c.estado <> 'borrador' AND c.created_by IS NOT NULL
     ORDER BY c.fecha DESC LIMIT 1`, [TENANT]);
  const { rows: ult } = await knex.raw(
    `SELECT id FROM finance.cash_ledger WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [TENANT]);
  if (!cs.length || !ult.length) {
    console.log('  ⚠️ [LE.0.7] NO MEDIDO: no hay un corte cerrado y un movimiento con qué probar (base de prueba).');
    return;
  }
  const c = cs[0];
  const casos = [[`atarla al corte cerrado ${c.folio}`, c.id, 'FALLA'], ['dejarla suelta (control)', null, 'PASA']];
  const fallos = [];
  let n = 0;
  for (const [nombre, corteId, espera] of casos) {
    n += 1;
    await knex.raw('SAVEPOINT le07_prueba');
    let real;
    let detalle = '';
    try {
      await knex.raw(`
        INSERT INTO finance.cash_ledger
        SELECT (jsonb_populate_record(NULL::finance.cash_ledger, to_jsonb(l) || jsonb_build_object(
                 'id', gen_random_uuid(), 'folio', 'LE07-PRUEBA-' || ?::text, 'corte_id', ?::uuid,
                 'estado', 'registrado', 'created_by', ?::uuid, 'cancelled_by', NULL,
                 'origen_ref', NULL, 'client_uuid', NULL))).*
          FROM finance.cash_ledger l WHERE l.id = ?`, [`${Date.now()}-${n}`, corteId, c.created_by, ult[0].id]);
      real = 'PASA';
    } catch (e) {
      real = e.constraint === 'cash_ledger_en_corte_firmado_chk' ? 'FALLA' : 'OTRO_ERROR';
      detalle = ` (${e.constraint || e.message})`;
    }
    await knex.raw('ROLLBACK TO SAVEPOINT le07_prueba');
    await knex.raw('RELEASE SAVEPOINT le07_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}${detalle}`);
  }
  if (fallos.length) throw new Error(`[LE.0.7] la regla no se comporta como debe:\n    - ${fallos.join('\n    - ')}`);
  console.log(`  ✔ [LE.0.7] ${casos.length} casos probados contra una copia del último movimiento, todos revertidos.`);
}

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_no_entra_a_corte_firmado ON finance.cash_ledger`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_no_entra_a_corte_firmado()`);
};
