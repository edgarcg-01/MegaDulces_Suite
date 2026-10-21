'use strict';
/**
 * ⭐⭐ `[CGS.4]` — **Un corte cerrado se puede CORREGIR, con constancia. Antes no se podía, y punto.**
 *
 * Edgar, 2026-10-20: *«los arqueos que se registraron desde el 12 hasta hoy se migran al corte de
 * ese día; cambiemos el resultado del corte»*. El conteo que manda es el **arqueo físico** que se
 * capturó en el Access `Control`; el de la Suite se tecleó mal.
 *
 * ── ⛔ El muro, medido ──────────────────────────────────────────────────────────────────────
 *
 * `finance.cash_cut_guardia()` rama 4 congela un corte que dejó de ser borrador:
 *
 *     IF OLD.estado <> 'borrador' THEN
 *       IF (… esperado, contado, morralla, diferencia, conteo_previo, reconteo_motivo …)
 *          IS DISTINCT FROM (OLD. …) THEN
 *         RAISE EXCEPTION 'El corte % ya está %: sus cifras ya no cambian.'
 *
 * Y la puerta del **reconteo** —rama 3, la que conserva el conteo anterior y exige motivo— sólo
 * se abre mientras el corte es `borrador`. Los 7 cortes de octubre están `cerrado`.
 *
 * ⭐ O sea que **no era que la corrección fuera difícil: no existía el camino**, ni por migración
 * ni por la aplicación. Es el mismo muro que rechazó `[CGA-A.37]` el 2026-10-20 por la mañana, y
 * aquella vez la respuesta fue revertir la migración. Esta vez se construye la puerta, porque el
 * hecho que la pide es real y se va a repetir: **un arqueo físico puede desmentir a un conteo
 * sellado, y el libro tiene que poder decirlo sin perder el conteo anterior.**
 *
 * ── Lo que esta migración hace ──────────────────────────────────────────────────────────────
 *
 * 1. Agrega `corrected_by` y `corrected_at` a `finance.cash_ledger_cuts`.
 * 2. Reescribe la rama 4 de la guardia: un corte cerrado **sigue congelado por defecto**, y sólo
 *    cede ante una corrección que cumpla las CUATRO condiciones de abajo, todas a la vez.
 *
 * ── Las cuatro condiciones, y por qué cada una ──────────────────────────────────────────────
 *
 * · **`conteo_previo` conserva el `contado` que reemplaza.** Es la misma regla que ya exige el
 *   reconteo (rama 3). Sin ella una «corrección» borra el conteo anterior y nadie puede auditar
 *   qué se cambió — que es exactamente lo que vuelve peligrosa una corrección.
 * · **`reconteo_motivo` con 10 caracteres o más.** Un motivo vacío convierte el candado en un
 *   trámite. Diez es lo mínimo para nombrar la fuente («arqueo A23648»).
 * · **`corrected_at` no nulo.** Cuándo se corrigió es parte del rastro, no un adorno.
 * · **`corrected_by <> closed_by` cuando hay persona.** La misma doble llave que ya rige el
 *   cierre y la autorización (`cut_doble_llave_chk`): quien cerró no se corrige a sí mismo.
 *
 * ⚠️ **`corrected_by` nulo se ACEPTA, y hay que decir qué significa y qué deja abierto.** Una
 * corrección que viene de una migración no tiene persona: tiene un commit revisado y un motivo
 * que nombra la fuente. Ponerle el nombre de alguien que no la hizo sería fabricar un registro,
 * que es peor que el hueco. **Lo que esto deja abierto:** un `UPDATE` directo contra la base
 * podría poner `corrected_by = NULL` y pasar. No es una defensa contra alguien con credenciales
 * de la base —ninguna lo es—; es una defensa contra el camino de la aplicación y contra el
 * accidente, y aun en ese caso sigue exigiendo que el conteo anterior quede guardado.
 *
 * ── ⛔ Lo que esta migración NO hace ────────────────────────────────────────────────────────
 *
 * **No corrige ningún corte.** Eso va en `[CGS.5]`, aparte y a propósito: una migración que abre
 * un candado y además lo usa no se puede revertir a medias, y si la corrección sale mal hay que
 * poder deshacerla sin volver a cerrar la puerta.
 *
 * **No afloja el reconteo ni el cierre.** Las ramas 1, 2 y 3 se copian **tal cual** desde la
 * versión viva en prod (leída el 2026-10-20), no se reescriben de memoria.
 *
 * @param { import("knex").Knex } knex
 */

const COLUMNAS = ['corrected_by', 'corrected_at'];

/** El cuerpo de la guardia, con la rama 4 nueva. Las ramas 1–3 van tal cual estaban. */
const GUARDIA_NUEVA = `
CREATE OR REPLACE FUNCTION finance.cash_cut_guardia()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
    DECLARE
      v_corrige boolean;
    BEGIN
      -- 4. Un corte que dejó de ser borrador es una foto. Se puede CORREGIR, nunca reabrir.
      IF OLD.estado <> 'borrador' THEN
        IF NEW.estado = 'borrador' OR (OLD.estado = 'autorizado' AND NEW.estado <> 'autorizado') THEN
          RAISE EXCEPTION 'El corte % ya está %: no se reabre.', OLD.folio, OLD.estado
            USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_firmado_inmutable_chk';
        END IF;

        -- ⭐ [CGS.4] ¿Esta actualización es una corrección en regla? Las cuatro a la vez.
        v_corrige := NEW.corrected_at IS NOT NULL
          AND NEW.corrected_at IS DISTINCT FROM OLD.corrected_at
          AND NEW.conteo_previo IS NOT NULL
          AND (NEW.conteo_previo->>'contado') IS NOT NULL
          AND OLD.contado IS NOT NULL
          AND (NEW.conteo_previo->>'contado')::numeric = OLD.contado
          AND length(btrim(coalesce(NEW.reconteo_motivo, ''))) >= 10
          AND (NEW.corrected_by IS NULL OR NEW.closed_by IS NULL OR NEW.corrected_by <> NEW.closed_by);

        -- ⛔ Lo que una corrección NO puede mover: el día, la sucursal, quién cerró y cuándo, y
        -- las tres cifras que vienen del LIBRO (fondo, ingresos, gastos, depósitos, esperado).
        -- Una corrección arregla el CONTEO; si lo que está mal es el libro, eso se captura, no
        -- se reescribe acá.
        IF v_corrige THEN
          IF (NEW.fecha, NEW.sucursal, NEW.fondo_inicial, NEW.fondo_origen,
              NEW.total_ingresos, NEW.total_gastos, NEW.total_depositos,
              NEW.esperado, NEW.closed_by, NEW.closed_at)
             IS DISTINCT FROM
             (OLD.fecha, OLD.sucursal, OLD.fondo_inicial, OLD.fondo_origen,
              OLD.total_ingresos, OLD.total_gastos, OLD.total_depositos,
              OLD.esperado, OLD.closed_by, OLD.closed_at) THEN
            RAISE EXCEPTION 'La corrección del corte % sólo puede cambiar el conteo, no el libro ni quién cerró.', OLD.folio
              USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_correccion_alcance_chk';
          END IF;
          RETURN NEW;
        END IF;

        -- Sin corrección en regla, el corte sigue congelado exactamente como antes.
        IF (NEW.fecha, NEW.sucursal, NEW.fondo_inicial, NEW.fondo_origen,
            NEW.total_ingresos, NEW.total_gastos, NEW.total_depositos,
            NEW.esperado, NEW.contado, NEW.morralla, NEW.diferencia,
            NEW.closed_by, NEW.closed_at, NEW.conteo_previo, NEW.reconteo_motivo)
           IS DISTINCT FROM
           (OLD.fecha, OLD.sucursal, OLD.fondo_inicial, OLD.fondo_origen,
            OLD.total_ingresos, OLD.total_gastos, OLD.total_depositos,
            OLD.esperado, OLD.contado, OLD.morralla, OLD.diferencia,
            OLD.closed_by, OLD.closed_at, OLD.conteo_previo, OLD.reconteo_motivo) THEN
          RAISE EXCEPTION 'El corte % ya está %: sus cifras ya no cambian. Para corregir el conteo hace falta una corrección con constancia (conteo previo + motivo).', OLD.folio, OLD.estado
            USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_firmado_inmutable_chk';
        END IF;
        RETURN NEW;
      END IF;

      -- 3. El reconteo deja constancia exacta de lo que reemplaza, y abre la puerta (sólo en
      --    esta transacción) para cambiar el conteo sellado.
      IF NEW.conteo_previo IS DISTINCT FROM OLD.conteo_previo THEN
        IF OLD.contado IS NULL OR NEW.conteo_previo IS NULL
           OR (NEW.conteo_previo->>'contado') IS NULL
           OR (NEW.conteo_previo->>'contado')::numeric <> OLD.contado THEN
          RAISE EXCEPTION 'El reconteo del corte % tiene que conservar el conteo que reemplaza (%).',
            OLD.folio, coalesce(OLD.contado::text, 'no había conteo')
            USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_reconteo_constancia_chk';
        END IF;
        PERFORM set_config('finance.cash_cut_reconteo', OLD.id::text, true);
      END IF;

      -- 2. Un conteo sellado sólo cambia por reconteo.
      IF OLD.contado IS NOT NULL AND NEW.contado IS DISTINCT FROM OLD.contado
         AND coalesce(current_setting('finance.cash_cut_reconteo', true), '') <> OLD.id::text THEN
        RAISE EXCEPTION 'El conteo del corte % ya está sellado (%): para cambiarlo hay que recontar, y el reconteo pide motivo.',
          OLD.folio, OLD.contado
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_conteo_sellado_chk';
      END IF;

      RETURN NEW;
    END
    $function$;
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── Guarda: la función tiene que ser la que medimos. Si otra sesión la cambió, parar.
  const { rows: viva } = await knex.raw(
    `SELECT pg_get_functiondef('finance.cash_cut_guardia'::regproc) AS src`);
  const src = String(viva[0]?.src ?? '');
  if (!src.includes('cut_firmado_inmutable_chk') || !src.includes('cut_reconteo_constancia_chk')) {
    throw new Error('[CGS.4] cash_cut_guardia() no es la que se midió: no se reescribe a ciegas.');
  }
  if (src.includes('cut_correccion_alcance_chk')) return; // ya aplicada: idempotente

  for (const col of COLUMNAS) {
    const existe = await knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', col);
    if (!existe) {
      await knex.schema.withSchema('finance').alterTable('cash_ledger_cuts', (t) => {
        if (col === 'corrected_by') t.uuid('corrected_by').nullable();
        else t.timestamp('corrected_at', { useTz: true }).nullable();
      });
    }
  }

  /**
   * ⛔ El CHECK acompaña al trigger, no lo reemplaza. El trigger sabe comparar contra `OLD` —que
   * es lo único que puede decir si el conteo anterior se conservó— y el CHECK garantiza que las
   * dos columnas nuevas viajen **juntas**, incluso en un INSERT, donde no hay `OLD` que mirar.
   */
  const { rows: chk } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'cut_correccion_completa_chk'
       AND conrelid = 'finance.cash_ledger_cuts'::regclass`);
  if (!chk.length) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger_cuts
        ADD CONSTRAINT cut_correccion_completa_chk CHECK (
          (corrected_at IS NULL AND corrected_by IS NULL)
          OR (corrected_at IS NOT NULL
              AND length(btrim(coalesce(reconteo_motivo, ''))) >= 10
              AND conteo_previo IS NOT NULL)
        )`);
  }

  await knex.raw(GUARDIA_NUEVA);

  // ── Comprobación: la función quedó, y las ramas viejas siguen ahí.
  const { rows: fin } = await knex.raw(
    `SELECT pg_get_functiondef('finance.cash_cut_guardia'::regproc) AS src`);
  const nueva = String(fin[0]?.src ?? '');
  for (const marca of ['cut_correccion_alcance_chk', 'cut_firmado_inmutable_chk',
    'cut_reconteo_constancia_chk', 'cut_conteo_sellado_chk']) {
    if (!nueva.includes(marca)) throw new Error(`[CGS.4] la guardia nueva perdió ${marca}`);
  }

  await probarElCandado(knex);

  // eslint-disable-next-line no-console
  console.log('  ✅ [CGS.4] un corte cerrado ya se puede corregir CON constancia; sin ella sigue congelado.');
};

/**
 * ⭐⭐ **La prueba negativa vive DENTRO de la migración, y si no muerde, la migración no entra.**
 *
 * Regla dura del proyecto: *un gate sin prueba negativa es una intención*. Y acá no había dónde
 * probarlo antes: el rol con el que se lee producción desde una máquina de trabajo tiene
 * `default_transaction_read_only = on` a nivel de rol —la barandilla que se puso justo para que
 * ninguna sesión de escritorio escriba en prod—, así que el candado no se podía ejercer desde
 * afuera. **El único lugar donde corre con permiso de escribir es esta migración.**
 *
 * Seis casos sobre un corte cerrado de verdad, cada uno en su `SAVEPOINT` y revertido. Cinco
 * tienen que **fallar** —son el candado— y uno tiene que **pasar**: un candado cerrado para todo
 * tampoco sirve, y sin ese caso la prueba no distinguiría «muerde bien» de «muerde siempre».
 *
 * Si cualquiera se comporta distinto, esto lanza y **la migración entera se revierte**.
 */
async function probarElCandado(knex) {
  const { rows: cs } = await knex.raw(
    `SELECT id, folio, contado, closed_by FROM finance.cash_ledger_cuts
      WHERE estado <> 'borrador' AND contado IS NOT NULL AND conteo_previo IS NULL
      ORDER BY fecha DESC LIMIT 1`);
  if (!cs.length) {
    // eslint-disable-next-line no-console
    console.log('  ⚠️ [CGS.4] NO MEDIDO: no hay ningún corte cerrado con conteo contra el cual probar el candado.');
    return;
  }
  const c = cs[0];
  const previo = JSON.stringify({ contado: Number(c.contado), denominaciones: [], morralla: 0 });
  const previoMal = JSON.stringify({ contado: -1, denominaciones: [], morralla: 0 });
  const MOT = 'Prueba del candado [CGS.4], revertida';
  const U = (sets) => `UPDATE finance.cash_ledger_cuts SET ${sets}, updated_at = now() WHERE id = '${c.id}'`;

  const casos = [
    ['corrección en regla', 'PASA',
      U(`contado = contado + 1, diferencia = contado + 1 - esperado, conteo_previo = '${previo}'::jsonb,
         reconteo_motivo = '${MOT}', corrected_at = now(), corrected_by = NULL`)],
    ['sin conteo previo', 'FALLA',
      U(`contado = contado + 1, reconteo_motivo = '${MOT}', corrected_at = now()`)],
    ['el conteo previo no conserva el conteo que reemplaza', 'FALLA',
      U(`contado = contado + 1, conteo_previo = '${previoMal}'::jsonb, reconteo_motivo = '${MOT}', corrected_at = now()`)],
    ['motivo de menos de 10 caracteres', 'FALLA',
      U(`contado = contado + 1, conteo_previo = '${previo}'::jsonb, reconteo_motivo = 'ups', corrected_at = now()`)],
    ['quien cerró se corrige a sí mismo', 'FALLA',
      U(`contado = contado + 1, conteo_previo = '${previo}'::jsonb, reconteo_motivo = '${MOT}',
         corrected_at = now(), corrected_by = closed_by`)],
    ['la corrección toca el esperado (que viene del libro)', 'FALLA',
      U(`contado = contado + 1, esperado = 1, conteo_previo = '${previo}'::jsonb,
         reconteo_motivo = '${MOT}', corrected_at = now()`)],
    ['UPDATE pelado del conteo (el candado de siempre)', 'FALLA',
      U(`contado = contado + 1`)],
  ];

  const fallos = [];
  for (const [nombre, espera, sql] of casos) {
    await knex.raw('SAVEPOINT cgs4_prueba');
    let real;
    try { await knex.raw(sql); real = 'PASA'; } catch { real = 'FALLA'; }
    await knex.raw('ROLLBACK TO SAVEPOINT cgs4_prueba');
    await knex.raw('RELEASE SAVEPOINT cgs4_prueba');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}`);
  }

  if (fallos.length) {
    throw new Error(`[CGS.4] el candado no se comporta como debe sobre ${c.folio}:\n    - ${fallos.join('\n    - ')}`);
  }
  // eslint-disable-next-line no-console
  console.log(`  ✔ [CGS.4] candado probado sobre ${c.folio}: ${casos.length} casos (1 pasa, ${casos.length - 1} rebotan), todos revertidos.`);
}

/**
 * Vuelve a la guardia anterior: el corte cerrado queda congelado sin excepción. Las columnas NO
 * se borran —hay datos de corrección que explicarían un conteo— y se DICE: borrarlas dejaría
 * cortes corregidos sin rastro de que lo fueron.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.cash_cut_guardia()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF OLD.estado <> 'borrador' THEN
            IF NEW.estado = 'borrador' OR (OLD.estado = 'autorizado' AND NEW.estado <> 'autorizado') THEN
              RAISE EXCEPTION 'El corte % ya está %: no se reabre.', OLD.folio, OLD.estado
                USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_firmado_inmutable_chk';
            END IF;
            IF (NEW.fecha, NEW.sucursal, NEW.fondo_inicial, NEW.fondo_origen,
                NEW.total_ingresos, NEW.total_gastos, NEW.total_depositos,
                NEW.esperado, NEW.contado, NEW.morralla, NEW.diferencia,
                NEW.closed_by, NEW.closed_at, NEW.conteo_previo, NEW.reconteo_motivo)
               IS DISTINCT FROM
               (OLD.fecha, OLD.sucursal, OLD.fondo_inicial, OLD.fondo_origen,
                OLD.total_ingresos, OLD.total_gastos, OLD.total_depositos,
                OLD.esperado, OLD.contado, OLD.morralla, OLD.diferencia,
                OLD.closed_by, OLD.closed_at, OLD.conteo_previo, OLD.reconteo_motivo) THEN
              RAISE EXCEPTION 'El corte % ya está %: sus cifras ya no cambian.', OLD.folio, OLD.estado
                USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_firmado_inmutable_chk';
            END IF;
            RETURN NEW;
          END IF;

          IF NEW.conteo_previo IS DISTINCT FROM OLD.conteo_previo THEN
            IF OLD.contado IS NULL OR NEW.conteo_previo IS NULL
               OR (NEW.conteo_previo->>'contado') IS NULL
               OR (NEW.conteo_previo->>'contado')::numeric <> OLD.contado THEN
              RAISE EXCEPTION 'El reconteo del corte % tiene que conservar el conteo que reemplaza (%).',
                OLD.folio, coalesce(OLD.contado::text, 'no había conteo')
                USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_reconteo_constancia_chk';
            END IF;
            PERFORM set_config('finance.cash_cut_reconteo', OLD.id::text, true);
          END IF;

          IF OLD.contado IS NOT NULL AND NEW.contado IS DISTINCT FROM OLD.contado
             AND coalesce(current_setting('finance.cash_cut_reconteo', true), '') <> OLD.id::text THEN
            RAISE EXCEPTION 'El conteo del corte % ya está sellado (%): para cambiarlo hay que recontar, y el reconteo pide motivo.',
              OLD.folio, OLD.contado
              USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_conteo_sellado_chk';
          END IF;

          RETURN NEW;
        END
        $function$;
  `);
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_correccion_completa_chk`);
};
