'use strict';
/**
 * `[CGP-D.3]` — Las reglas del dinero del corte de caja pasan a la BASE. Hasta hoy vivían sólo en
 * el servicio, y el servicio tenía caminos que las rompían en silencio.
 *
 * ── Lo medido antes (sólo lectura, sobre el código de `main` 07665276b) ─────────────────────
 *  · `cerrar()` usa el conteo que venga en el cuerpo en lugar del sellado y REESCRIBE el desglose
 *    sellado, sin compararlos (`cash-cut.service.ts:840-889`). O sea que el arqueo ciego se podía
 *    saltar: contar, ver el esperado, teclear otra cifra en la reja y cerrar. Sin `recontar()` y
 *    sin motivo. La pantalla lo permite porque la reja sigue editable después de revelar.
 *  · `recontar()` no exige que exista un conteo sellado antes.
 *  · `cut_cerrado_completo_chk` sólo pide que los campos no sean NULL: no comprueba que
 *    `diferencia = contado − esperado` ni que `contado` sea lo que suma el desglose.
 *  · Nada impide dos cortes de la misma sucursal y fecha (`abrir()` no valida la fecha; el único
 *    candado, `ux_cash_cut_abierto`, mira sólo los borradores).
 *  · Ninguna prueba ejercía estas reglas contra una base: los defectos del 12 al 14-oct vivían
 *    entre capas y aparecieron uno por uno en producción.
 *
 * ── Las cinco reglas ────────────────────────────────────────────────────────────────────────
 *  1. `cut_aritmetica_chk` — `diferencia = contado − esperado`. Exacta, sin tolerancia: el motor
 *     redondea cada valor a centavos ANTES de restar (`cash-cut.engine.ts`, `redondea`).
 *  2. `cut_conteo_sellado_chk` — un conteo sellado (contado NOT NULL) sólo cambia dentro de la
 *     MISMA transacción que registró el reconteo. `recontar()` hace dos UPDATE (primero
 *     `conteo_previo`, luego el contado nuevo); por eso la autorización es una marca local a la
 *     transacción (`finance.cash_cut_reconteo`) y no una comparación de columnas.
 *  3. `cut_reconteo_constancia_chk` — el registro del reconteo documenta exactamente lo que
 *     reemplaza: `conteo_previo->>'contado'` = el contado sellado. Un reconteo sin conteo previo
 *     no existe.
 *  4. `cut_firmado_inmutable_chk` — un corte cerrado o autorizado es una foto: no se reabre y sus
 *     cifras, fecha, sucursal, firma de cierre y reconteo no cambian. Autorizar sigue pudiendo.
 *  5. `cut_desglose_cuadra_chk` — al terminar la transacción, `contado = Σ desglose de cierre +
 *     morralla`. Es DIFERIDA a propósito: el servicio escribe primero el corte y después el
 *     desglose (`sellarConteo`, `cerrar`), y lo que importa es el estado final.
 *  Y `ux_cash_cut_sucursal_fecha`: un corte por sucursal y fecha.
 *
 * Se lanzan como `check_violation` con nombre de constraint, para que `traducirErrorDeCaja` las
 * convierta en una frase en vez de un 500 (`caja-errores.ts`, mapa por nombre).
 *
 * ── ⛔ Lo que NO cubre, dicho antes de que alguien lo suponga ───────────────────────────────
 *  · El desglose puede reescribirse SIN cambiar el total (otra composición, misma suma). La
 *    regla 5 lo deja pasar; protegerlo exige otra pieza y no se inventa acá.
 *  · Un corte que la regla 5 no puede ver por RLS (la función corre con los permisos de quien
 *    escribe) se da por bueno: la aplicación siempre escribe con su tenant fijado.
 *  · Las columnas agregadas al corte DESPUÉS de esta migración no quedan congeladas por la regla 4
 *    hasta que alguien las sume a su lista.
 *  · `cash_cut_fondo_coherente_chk` deja pasar un fondo sin procedencia (lógica de tres valores).
 *    Va en otra migración: corregirlo puede volver intocable un corte viejo, y eso se mide antes.
 *
 * ── Prevuelo: si una fila de hoy ya viola una regla, la migración NO se aplica ──────────────
 * Un CHECK `NOT VALID` o un trigger nuevo no revisan las filas existentes, pero SÍ cada UPDATE
 * futuro de esas filas: un corte viejo que viole una regla quedaría imposible de cerrar, en
 * silencio. Por eso se mide primero y, si algo viola, aborta con los folios. Y como RLS esconde
 * filas, el prevuelo exige un rol que las vea todas (GOTCHAS §80): si no, lo declara NO MEDIDO.
 *
 * Idempotente. Prueba: `database/tests/test-newdb-caja-invariantes.js`, con prueba negativa de
 * cada regla y la mutación que demuestra que la suite detecta su ausencia.
 *
 * @param { import("knex").Knex } knex
 */

const PREVUELO = [
  {
    regla: 'diferencia = contado − esperado',
    sql: `SELECT folio FROM finance.cash_ledger_cuts
           WHERE diferencia IS NOT NULL AND contado IS NOT NULL AND esperado IS NOT NULL
             AND diferencia <> contado - esperado`,
  },
  {
    regla: 'contado = desglose de cierre + morralla',
    sql: `SELECT c.folio FROM finance.cash_ledger_cuts c
            LEFT JOIN LATERAL (
              SELECT coalesce(sum(d.denominacion * d.piezas), 0) AS s, count(*) AS n
                FROM finance.cash_ledger_cut_denominations d
               WHERE d.tenant_id = c.tenant_id AND d.cut_id = c.id AND d.momento = 'cierre') d ON true
           WHERE (c.contado IS NOT NULL AND d.s + c.morralla <> c.contado)
              OR (c.contado IS NULL AND d.n > 0)`,
  },
  {
    regla: 'reconteo con constancia del conteo que reemplaza',
    sql: `SELECT folio FROM finance.cash_ledger_cuts
           WHERE conteo_previo IS NOT NULL
             AND (conteo_previo->>'contado') IS NULL`,
  },
  {
    regla: 'un corte por sucursal y fecha',
    sql: `SELECT string_agg(folio, ' + ') AS folio FROM finance.cash_ledger_cuts
           GROUP BY tenant_id, sucursal, fecha HAVING count(*) > 1`,
  },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 0. Prevuelo ──────────────────────────────────────────────────────────────────────────
  const rol = await knex.raw(
    `SELECT rolsuper OR rolbypassrls AS ve_todo FROM pg_roles WHERE rolname = current_user`);
  if (!rol.rows[0]?.ve_todo) {
    throw new Error(
      '[CGP-D.3] NO MEDIDO: el rol que aplica la migración no salta RLS, así que el prevuelo no '
      + 've todos los cortes y podría dar por buena una fila que viola. Aplicala con un rol que '
      + 'tenga BYPASSRLS o sea superusuario.');
  }
  const violaciones = [];
  for (const p of PREVUELO) {
    const r = await knex.raw(p.sql);
    for (const fila of r.rows) violaciones.push(`${p.regla}: ${fila.folio}`);
  }
  if (violaciones.length > 0) {
    throw new Error(
      `[CGP-D.3] ${violaciones.length} corte(s) de hoy ya violan una regla nueva. Aplicarla así `
      + `los dejaría imposibles de cerrar. Revisalos antes:\n  · ${violaciones.join('\n  · ')}`);
  }

  // ── 1. Aritmética ────────────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_aritmetica_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger_cuts ADD CONSTRAINT cut_aritmetica_chk CHECK (
      diferencia IS NULL OR contado IS NULL OR esperado IS NULL OR diferencia = contado - esperado)`);

  // ── Un corte por sucursal y fecha ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_cut_sucursal_fecha
      ON finance.cash_ledger_cuts (tenant_id, sucursal, fecha)`);

  // ── 2, 3 y 4. La guardia del corte ───────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.cash_cut_guardia() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      -- 4. Un corte que dejó de ser borrador es una foto.
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
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_guardia ON finance.cash_ledger_cuts`);
  await knex.raw(`
    CREATE TRIGGER trg_cash_cut_guardia
      BEFORE UPDATE ON finance.cash_ledger_cuts
      FOR EACH ROW EXECUTE FUNCTION finance.cash_cut_guardia()`);

  // ── 5. El desglose cuadra con el contado, al terminar la transacción ─────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.cash_cut_desglose_cuadra() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_cut uuid; v_tenant uuid; c record; v_suma numeric; v_filas int;
    BEGIN
      IF TG_TABLE_NAME = 'cash_ledger_cuts' THEN
        v_cut := NEW.id; v_tenant := NEW.tenant_id;
      ELSIF TG_OP = 'DELETE' THEN
        v_cut := OLD.cut_id; v_tenant := OLD.tenant_id;
      ELSE
        v_cut := NEW.cut_id; v_tenant := NEW.tenant_id;
      END IF;

      SELECT folio, contado, morralla INTO c
        FROM finance.cash_ledger_cuts WHERE id = v_cut AND tenant_id = v_tenant;
      IF NOT FOUND THEN
        RETURN NULL;   -- el corte se borró (CASCADE) o no es visible: ver la cabecera
      END IF;

      SELECT coalesce(sum(denominacion * piezas), 0), count(*) INTO v_suma, v_filas
        FROM finance.cash_ledger_cut_denominations
       WHERE tenant_id = v_tenant AND cut_id = v_cut AND momento = 'cierre';

      IF c.contado IS NULL THEN
        IF v_filas > 0 THEN
          RAISE EXCEPTION 'El corte % tiene desglose de cierre pero no tiene contado.', c.folio
            USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_desglose_cuadra_chk';
        END IF;
      ELSIF v_suma + c.morralla <> c.contado THEN
        RAISE EXCEPTION 'El desglose del corte % suma % más % de morralla, y el contado dice %.',
          c.folio, v_suma, c.morralla, c.contado
          USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_desglose_cuadra_chk';
      END IF;
      RETURN NULL;
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_desglose_cuadra_corte ON finance.cash_ledger_cuts`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_cash_cut_desglose_cuadra_corte
      AFTER INSERT OR UPDATE OF contado, morralla ON finance.cash_ledger_cuts
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION finance.cash_cut_desglose_cuadra()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_desglose_cuadra_desglose ON finance.cash_ledger_cut_denominations`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_cash_cut_desglose_cuadra_desglose
      AFTER INSERT OR UPDATE OR DELETE ON finance.cash_ledger_cut_denominations
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION finance.cash_cut_desglose_cuadra()`);

  await knex.raw(`
    COMMENT ON FUNCTION finance.cash_cut_guardia() IS
      '[CGP-D.3] Conteo sellado solo cambia por reconteo (con constancia exacta), y un corte cerrado o autorizado no se reabre ni cambia sus cifras.'`);
  await knex.raw(`
    COMMENT ON FUNCTION finance.cash_cut_desglose_cuadra() IS
      '[CGP-D.3] Al terminar la transaccion: contado = suma del desglose de cierre + morralla.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_desglose_cuadra_desglose ON finance.cash_ledger_cut_denominations`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_desglose_cuadra_corte ON finance.cash_ledger_cuts`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_cut_desglose_cuadra()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_cut_guardia ON finance.cash_ledger_cuts`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_cut_guardia()`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_cash_cut_sucursal_fecha`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_cuts DROP CONSTRAINT IF EXISTS cut_aritmetica_chk`);
};
