'use strict';
/**
 * ⭐⭐ `[CGS.52]` — **Los cortes del 12 al 22-oct se recalculan con el conteo físico de su día y con
 * el libro que de verdad tienen atado. Lo que no se midió queda «sin medir», no inventado.**
 *
 * Decisión del PM, 2026-10-23: *«re actualicemos todas las cifras… debemos ser claros y no confundir
 * al supervisor»*. Corrección en la base CON constancia del valor anterior (como `[CGS.4]`/`[CGS.5]`).
 *
 * ── Lo medido antes (sólo lectura, prod `7688376744939610156`, 2026-10-23) ───────────────────
 *
 * El `esperado` guardado se reproduce AL CENTAVO en los 10 cortes: la aritmética está bien. Lo que
 * está mal son las ENTRADAS, por cuatro causas, cada una con su evidencia:
 *
 *  1. **El conteo del 13-oct es el del 15-oct.** `CC-2026-00002` se abrió y cerró el 15-oct 18:02,
 *     y su desglose es pieza por pieza el arqueo de Control `A23655` del **15-oct 17:55** (siete
 *     minutos antes). ⛔ `[CGS.5]` lo leyó al revés («Control copió el conteo del 13»); las horas
 *     dicen que el efectivo se contó el 15. El 12 y el 13 Control no arqueó: **el 13 no tiene
 *     conteo físico.** Y el 15-oct guardó `$11,820`, que no coincide con ningún arqueo.
 *  2. **Ingresos atados DESPUÉS de cerrar, sin recalcular.** El 22-oct 14:18:02 se aplicó la
 *     decisión **D13** (bitácora de `FASE_CGS`, `kubectl exec`): 5 ingresos ligados a `CC-2026-00002`,
 *     `CI-2026-00010/26/27/28/29` = **$121,130.53**. Correcto como amarre, pero los totales firmados
 *     siguieron diciendo $273,258.00: el libro creció y el corte no.
 *  3. **Reclasificación después de cerrar.** `[CGA-A.42]` (20-oct) pasó `CI-2026-00063` ($10,105)
 *     de ingreso a gasto en `CC-2026-00007`; el corte siguió con los totales viejos.
 *  4. **Fondo que no es lo que quedó en caja.** `CC-2026-00004` arrancó con $24,960 cuando el día
 *     anterior se contaron $14,128.50; `CC-2026-00005` con $11,820 (el conteo falso del 15).
 *
 * ── La regla con la que se recalcula (la misma del motor `calcularCorte`) ───────────────────
 *
 *   fondo        = lo que QUEDÓ EN CAJA en el corte anterior (su conteo físico). Sin él: sin medir.
 *   totales      = lo que hoy tiene atado el corte (`corte_id`), sin cancelados.
 *   esperado     = fondo + ingresos − gastos − depósitos + dispensado CAOS − depositado CAOS (del día).
 *   contado      = el arqueo físico de ese día. Sin él: sin medir.
 *   diferencia   = contado − esperado, sólo si los dos existen.
 *
 * ── ⛔ Lo que esto NO arregla, y se declara ───────────────────────────────────────────────
 *
 * El 15, 16, 17, 19 y 21-oct siguen con diferencias de $49k a $245k, y varios `esperado`
 * NEGATIVOS. Un esperado negativo es imposible en una caja física: es la prueba de que al libro le
 * faltan ingresos (el PM confirmó el 23-oct que los pagos de Abastos/Morelia SÍ salen de esta caja,
 * así que el gasto se queda). Esta migración pone las cifras correctas; NO inventa el ingreso que
 * falta. La pantalla dice «no calculable» donde el esperado es negativo.
 *
 * ── Cómo se abre el candado ─────────────────────────────────────────────────────────────────
 *
 * La guardia `finance.cash_cut_guardia()` se copia TAL CUAL de prod (leída el 2026-10-23) y se le
 * agrega UNA rama: el **recálculo con constancia**. Pasa sólo si `recalculo_previo` guarda las
 * cifras exactas que se reemplazan, `recalculo_motivo` tiene ≥10 caracteres y `recalculado_at`
 * es nuevo. Ni así puede mover el día, la sucursal, el estado ni quién cerró.
 * `cut_cerrado_completo_chk` acepta esperado/contado/diferencia nulos SÓLO con
 * `sin_medir_motivo` escrito: lo que no se midió se declara (ADR-056), nunca se dibuja.
 *
 * ⚠️ Escribe filas de un corte firmado: va como `[CGS.5]`, con plan medido y abortando si cualquier
 * cifra difiere de lo medido. Idempotente: un corte ya recalculado no se vuelve a tocar.
 * ⚠️ NO usar el signo de interrogación en el SQL: knex lo toma por parámetro (así terminó un `$1`
 * dentro de un comentario de la guardia en `[CGS.4]`).
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSAL = '00';
const DESDE = '2026-10-12';
const HASTA = '2026-10-22';
const MOTIVO_BASE = '[CGS.52] Recalculo con el conteo fisico de su dia y el libro atado hoy';

/** El arqueo físico de cada día (Control), o el de la Suite donde Control no arqueó. `null` = no hubo. */
const CONTEO_FISICO = {
  '2026-10-12': { contado: 3653.50, fuente: 'Suite (Control no arqueo el 12)' },
  '2026-10-13': { contado: null, fuente: 'sin conteo fisico' },
  '2026-10-14': { contado: 14128.50, fuente: 'Control A23648' },
  '2026-10-15': { contado: 57571.00, fuente: 'Control A23655 15-oct 17:55' },
  '2026-10-16': { contado: 32198.50, fuente: 'Control A23665' },
  '2026-10-17': { contado: 618.50, fuente: 'Control A23672' },
  '2026-10-19': { contado: 87772.50, fuente: 'Control A23677' },
  '2026-10-20': { contado: 25787.00, fuente: 'Control A23683' },
  '2026-10-21': { contado: 23756.50, fuente: 'Control A23706' },
  '2026-10-22': { contado: 28962.00, fuente: 'Suite (Control jubilado el 22)' },
};

/** La reja del arqueo A23655 (15-oct 17:55), leída de `analytics.v_caja_control_cortes`. Suma $57,571. */
const REJA_A23655 = [
  ['1000', 1000, 1], ['500', 500, 79], ['200', 200, 38], ['100', 100, 10], ['50', 50, 45], ['20', 20, 35],
  ['10', 10, 247], ['5', 5, 423], ['2', 2, 173], ['1', 1, 577], ['0.5', 0.5, 26],
];

/**
 * Lo medido el 2026-10-23. La migración COMPRUEBA que antes y después den esto; si no, aborta.
 * `null` en `despues` = sin medir.
 */
const PLAN = {
  'CC-2026-00001': { antes: { fondo: 3327.50, esperado: 3402.45, contado: 3653.50, diferencia: 251.05 },
    despues: { fondo: 3327.50, esperado: 3402.45, contado: 3653.50, diferencia: 251.05 } },
  'CC-2026-00002': { antes: { fondo: 3653.50, esperado: -149915.32, contado: 57571.00, diferencia: 207486.32 },
    despues: { fondo: 3653.50, esperado: -28784.79, contado: null, diferencia: null } },
  'CC-2026-00003': { antes: { fondo: 57571.00, esperado: 87781.66, contado: 14128.50, diferencia: -73653.16 },
    despues: { fondo: null, esperado: null, contado: 14128.50, diferencia: null } },
  'CC-2026-00004': { antes: { fondo: 24960.00, esperado: -68199.86, contado: 11820.00, diferencia: 80019.86 },
    despues: { fondo: 14128.50, esperado: -79031.36, contado: 57571.00, diferencia: 136602.36 } },
  'CC-2026-00005': { antes: { fondo: 11820.00, esperado: -62631.80, contado: 32198.50, diferencia: 94830.30 },
    despues: { fondo: 57571.00, esperado: -16880.80, contado: 32198.50, diferencia: 49079.30 } },
  'CC-2026-00006': { antes: { fondo: 32198.50, esperado: -81227.27, contado: 618.50, diferencia: 81845.77 },
    despues: { fondo: 32198.50, esperado: -81227.27, contado: 618.50, diferencia: 81845.77 } },
  'CC-2026-00007': { antes: { fondo: 618.50, esperado: 296867.09, contado: 87772.50, diferencia: -209094.59 },
    despues: { fondo: 618.50, esperado: 276657.09, contado: 87772.50, diferencia: -188884.59 } },
  'CC-2026-00008': { antes: { fondo: 87772.50, esperado: 24585.37, contado: 25787.00, diferencia: 1201.63 },
    despues: { fondo: 87772.50, esperado: 24585.37, contado: 25787.00, diferencia: 1201.63 } },
  'CC-2026-00009': { antes: { fondo: 25787.00, esperado: -221512.14, contado: 23756.50, diferencia: 245268.64 },
    despues: { fondo: 25787.00, esperado: -221512.14, contado: 23756.50, diferencia: 245268.64 } },
  'CC-2026-00010': { antes: { fondo: 23756.50, esperado: 45772.25, contado: 28962.00, diferencia: -16810.25 },
    despues: { fondo: 23756.50, esperado: 45772.25, contado: 28962.00, diferencia: -16810.25 } },
};
/** Del conteo del 12 al del 14, los dos días juntos (el 13 no tuvo conteo). Medido. */
const TRAMO_12_14 = { esperado: 1425.87, contado: 14128.50, diferencia: 12702.63 };

const r2 = (n) => (n === null || n === undefined ? null : Math.round((Number(n) + Number.EPSILON) * 100) / 100);
const mx = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const firmado = (n) => `${n < 0 ? '-' : '+'}${mx(n)}`;

/** La guardia viva en prod (2026-10-23) + la rama `[CGS.52]`. Lo demás, idéntico. */
const GUARDIA = `
CREATE OR REPLACE FUNCTION finance.cash_cut_guardia()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE
      v_corrige boolean;
      v_recalcula boolean;
    BEGIN
      -- 4. Un corte que dejó de ser borrador es una foto. Se puede CORREGIR, nunca reabrir.
      IF OLD.estado <> 'borrador' THEN
        IF NEW.estado = 'borrador' OR (OLD.estado = 'autorizado' AND NEW.estado <> 'autorizado') THEN
          RAISE EXCEPTION 'El corte % ya está %: no se reabre.', OLD.folio, OLD.estado
            USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_firmado_inmutable_chk';
        END IF;

        -- ⭐ [CGS.52] Recálculo con constancia: guarda las cifras EXACTAS que reemplaza, con motivo.
        -- Puede mover fondo, totales, esperado, conteo y diferencia; nunca el día, la sucursal,
        -- el estado ni quién cerró.
        v_recalcula := NEW.recalculado_at IS NOT NULL
          AND NEW.recalculado_at IS DISTINCT FROM OLD.recalculado_at
          AND NEW.recalculo_previo IS NOT NULL
          AND (NEW.recalculo_previo->>'esperado')::numeric IS NOT DISTINCT FROM OLD.esperado
          AND (NEW.recalculo_previo->>'contado')::numeric IS NOT DISTINCT FROM OLD.contado
          AND (NEW.recalculo_previo->>'diferencia')::numeric IS NOT DISTINCT FROM OLD.diferencia
          AND (NEW.recalculo_previo->>'fondo_inicial')::numeric IS NOT DISTINCT FROM OLD.fondo_inicial
          AND (NEW.recalculo_previo->>'total_ingresos')::numeric IS NOT DISTINCT FROM OLD.total_ingresos
          AND (NEW.recalculo_previo->>'total_gastos')::numeric IS NOT DISTINCT FROM OLD.total_gastos
          AND length(btrim(coalesce(NEW.recalculo_motivo, ''))) >= 10;

        IF v_recalcula THEN
          IF (NEW.fecha, NEW.sucursal, NEW.estado, NEW.closed_by, NEW.closed_at,
              NEW.conteo_previo, NEW.reconteo_motivo, NEW.corrected_by, NEW.corrected_at)
             IS DISTINCT FROM
             (OLD.fecha, OLD.sucursal, OLD.estado, OLD.closed_by, OLD.closed_at,
              OLD.conteo_previo, OLD.reconteo_motivo, OLD.corrected_by, OLD.corrected_at) THEN
            RAISE EXCEPTION 'El recálculo del corte % no puede cambiar el día, la sucursal, el estado ni quién cerró.', OLD.folio
              USING ERRCODE = 'check_violation', CONSTRAINT = 'cut_recalculo_alcance_chk';
          END IF;
          RETURN NEW;
        END IF;

        -- ⭐ [CGS.4] Corrección del conteo en regla: las cuatro condiciones a la vez.
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
        -- Una corrección arregla el CONTEO; si lo que está mal es el libro, eso se recalcula
        -- con constancia ([CGS.52]), no se reescribe acá.
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

        -- Sin corrección ni recálculo en regla, el corte sigue congelado exactamente como antes.
        IF (NEW.fecha, NEW.sucursal, NEW.fondo_inicial, NEW.fondo_origen,
            NEW.total_ingresos, NEW.total_gastos, NEW.total_depositos,
            NEW.esperado, NEW.contado, NEW.morralla, NEW.diferencia,
            NEW.closed_by, NEW.closed_at, NEW.conteo_previo, NEW.reconteo_motivo,
            NEW.recalculo_previo, NEW.recalculo_motivo, NEW.recalculado_at, NEW.sin_medir_motivo)
           IS DISTINCT FROM
           (OLD.fecha, OLD.sucursal, OLD.fondo_inicial, OLD.fondo_origen,
            OLD.total_ingresos, OLD.total_gastos, OLD.total_depositos,
            OLD.esperado, OLD.contado, OLD.morralla, OLD.diferencia,
            OLD.closed_by, OLD.closed_at, OLD.conteo_previo, OLD.reconteo_motivo,
            OLD.recalculo_previo, OLD.recalculo_motivo, OLD.recalculado_at, OLD.sin_medir_motivo) THEN
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
    $function$
`;

/** El cuerpo de la guardia que había ANTES, para `down`: se lee de prod en `up` y se guarda acá. */
const MARCA_GUARDIA = 'v_recalcula';

const CHK_CERRADO_NUEVO = `CHECK ((estado = 'borrador') OR ((closed_by IS NOT NULL) AND (closed_at IS NOT NULL)
  AND (((esperado IS NOT NULL) AND (contado IS NOT NULL) AND (diferencia IS NOT NULL))
       OR (length(btrim(coalesce(sin_medir_motivo, ''))) >= 10))))`;
const CHK_CERRADO_VIEJO = `CHECK ((estado = 'borrador') OR ((closed_by IS NOT NULL) AND (closed_at IS NOT NULL)
  AND (esperado IS NOT NULL) AND (contado IS NOT NULL) AND (diferencia IS NOT NULL)))`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  const abortar = (m) => { throw new Error(`[CGS.52] ${m} -- migracion abortada, sin tocar ninguna fila.`); };

  // ── 1. Columnas (aditivas, nulables) ──────────────────────────────────────────────────────
  const T = 'finance.cash_ledger_cuts';
  const cols = {
    recalculo_previo: (t) => t.jsonb('recalculo_previo'),
    recalculo_motivo: (t) => t.text('recalculo_motivo'),
    recalculado_at: (t) => t.timestamp('recalculado_at', { useTz: true }),
    sin_medir_motivo: (t) => t.text('sin_medir_motivo'),
  };
  for (const [c, def] of Object.entries(cols)) {
    if (!(await knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', c))) {
      await knex.schema.withSchema('finance').alterTable('cash_ledger_cuts', (t) => { def(t); });
    }
  }
  await knex.raw(`COMMENT ON COLUMN ${T}.recalculo_previo IS '[CGS.52] Las cifras exactas que reemplazo un recalculo (y el desglose si cambio).'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.sin_medir_motivo IS '[CGS.52] Por que el corte no tiene esperado, conteo o diferencia: lo que no se midio se declara.'`);

  // ── 2. Candados ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS cut_cerrado_completo_chk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cut_cerrado_completo_chk ${CHK_CERRADO_NUEVO}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS cut_recalculo_completo_chk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cut_recalculo_completo_chk CHECK (
      ((recalculado_at IS NULL) AND (recalculo_previo IS NULL))
      OR ((recalculado_at IS NOT NULL) AND (recalculo_previo IS NOT NULL)
          AND (length(btrim(coalesce(recalculo_motivo, ''))) >= 10)))`);
  await knex.raw(GUARDIA);

  // ── 3. Los cortes, uno por uno ──────────────────────────────────────────────────────────
  const cortes = await knex('finance.cash_ledger_cuts')
    .where({ tenant_id: TENANT, sucursal: SUCURSAL })
    .whereBetween('fecha', [DESDE, HASTA])
    .orderBy('fecha')
    .select('*', knex.raw(`to_char(fecha, 'YYYY-MM-DD') AS dia`));
  if (cortes.length !== Object.keys(PLAN).length) abortar(`hay ${cortes.length} cortes del ${DESDE} al ${HASTA}, se midieron ${Object.keys(PLAN).length}`);

  let quedo = null;         // lo que quedó en caja en el corte anterior (su conteo físico)
  const nuevos = [];
  for (const [ix, c] of cortes.entries()) {
    const plan = PLAN[c.folio];
    if (!plan) abortar(`${c.folio} (${c.dia}) no estaba en el plan`);
    if (c.recalculado_at) {
      // eslint-disable-next-line no-console
      console.log(`  ↷ [CGS.52] ${c.folio} ya se recalculo: se deja como esta.`);
      quedo = c.contado === null ? null : Number(c.contado);
      nuevos.push(null);
      continue;
    }
    const a = plan.antes;
    for (const k of ['esperado', 'contado', 'diferencia']) {
      if (r2(c[k]) !== a[k]) abortar(`${c.folio} tiene ${k}=${c[k]}, se midio ${a[k]}: alguien lo cambio, parar`);
    }
    if (r2(c.fondo_inicial) !== a.fondo) abortar(`${c.folio} tiene fondo=${c.fondo_inicial}, se midio ${a.fondo}`);

    const [lib] = await knex('finance.cash_ledger')
      .where({ tenant_id: TENANT, corte_id: c.id }).whereNull('deleted_at').whereNot('estado', 'cancelado')
      .select(
        knex.raw(`coalesce(sum(monto) FILTER (WHERE tipo = 'ingreso'), 0)::numeric AS ing`),
        knex.raw(`coalesce(sum(monto) FILTER (WHERE tipo = 'gasto'), 0)::numeric AS gas`),
        knex.raw(`coalesce(sum(monto) FILTER (WHERE tipo = 'deposito'), 0)::numeric AS dep`));
    // Las dos piernas del cajero del día: la MISMA consulta que `conciliacionCajero()`.
    const [cj] = await knex('analytics.caos_cash_movements')
      .where('tenant_id', TENANT).whereRaw(`accounting_date = '${c.dia}'::date`)
      .select(
        knex.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = 0), 0)::numeric AS depositado`),
        knex.raw(`coalesce(sum(abs(total)) FILTER (WHERE type_id = 4), 0)::numeric AS dispensado`));

    const fondo = ix === 0 ? Number(c.fondo_inicial) : quedo;
    const flujo = Number(lib.ing) - Number(lib.gas) - Number(lib.dep) + Number(cj.dispensado) - Number(cj.depositado);
    const esperado = fondo === null ? null : r2(fondo + flujo);
    const contado = CONTEO_FISICO[c.dia]?.contado;
    if (contado === undefined) abortar(`no hay conteo fisico declarado para ${c.dia}`);
    const diferencia = esperado === null || contado === null ? null : r2(contado - esperado);
    const d = plan.despues;
    if (r2(fondo) !== d.fondo || esperado !== d.esperado || r2(contado) !== d.contado || diferencia !== d.diferencia) {
      abortar(`${c.folio}: calculo fondo=${r2(fondo)} esperado=${esperado} contado=${contado} dif=${diferencia}; `
        + `se midio ${JSON.stringify(d)}`);
    }
    nuevos.push({ c, fondo, esperado, contado, diferencia, ing: r2(lib.ing), gas: r2(lib.gas), dep: r2(lib.dep), flujo: r2(flujo) });
    quedo = contado;
  }

  // El tramo 12→14 juntos, comprobado con los mismos números.
  const n13 = nuevos[1], n14 = nuevos[2];
  if (n13 && n14) {
    const e = r2(Number(cortes[0].contado) + n13.flujo + n14.flujo);
    if (e !== TRAMO_12_14.esperado || r2(TRAMO_12_14.contado - e) !== TRAMO_12_14.diferencia) {
      abortar(`el tramo 12-14 da esperado ${e}; se midio ${JSON.stringify(TRAMO_12_14)}`);
    }
  }

  for (const n of nuevos) {
    if (!n) continue;
    const { c } = n;
    const igual = r2(c.fondo_inicial) === r2(n.fondo) && r2(c.esperado) === n.esperado && r2(c.contado) === r2(n.contado)
      && r2(c.diferencia) === n.diferencia && r2(c.total_ingresos) === n.ing && r2(c.total_gastos) === n.gas
      && r2(c.total_depositos) === n.dep;
    if (igual) continue;   // nada que corregir: no se deja una constancia vacía

    const cambiaConteo = r2(c.contado) !== r2(n.contado);
    const desglosePrevio = cambiaConteo
      ? await knex('finance.cash_ledger_cut_denominations')
        .where({ tenant_id: TENANT, cut_id: c.id, momento: 'cierre' })
        .orderBy('denominacion', 'desc').select('denom_key', 'denominacion', 'piezas')
      : null;
    const previo = {
      fondo_inicial: c.fondo_inicial === null ? null : Number(c.fondo_inicial), fondo_origen: c.fondo_origen,
      total_ingresos: Number(c.total_ingresos), total_gastos: Number(c.total_gastos), total_depositos: Number(c.total_depositos),
      esperado: Number(c.esperado), contado: Number(c.contado), morralla: Number(c.morralla ?? 0), diferencia: Number(c.diferencia),
      ...(desglosePrevio ? { desglose_cierre: desglosePrevio } : {}),
      recalculado_por: '[CGS.52] migracion',
    };

    const razones = [];
    if (r2(c.total_ingresos) !== n.ing || r2(c.total_gastos) !== n.gas) razones.push(`libro atado hoy (ingresos ${mx(n.ing)}, gastos ${mx(n.gas)})`);
    if (r2(c.fondo_inicial) !== r2(n.fondo)) razones.push(n.fondo === null ? 'el corte anterior no tuvo conteo fisico' : `fondo = lo que quedo en caja el corte anterior (${mx(n.fondo)})`);
    if (cambiaConteo) razones.push(n.contado === null ? 'sin conteo fisico ese dia' : `conteo fisico ${CONTEO_FISICO[c.dia].fuente} (${mx(n.contado)})`);
    const motivo = `${MOTIVO_BASE}: ${razones.join('; ')}.`;

    let sinMedir = null;
    if (c.dia === '2026-10-13') {
      sinMedir = 'No hubo conteo fisico al cierre del 13-oct: lo que se sello ($57,571.00) es el arqueo A23655 de Control '
        + `del 15-oct 17:55, pieza por pieza. Sin conteo no hay diferencia del dia. Del conteo del 12-oct al del 14-oct, `
        + `los dos dias juntos: deberia haber ${mx(TRAMO_12_14.esperado)}, se conto ${mx(TRAMO_12_14.contado)}, `
        + `diferencia ${firmado(TRAMO_12_14.diferencia)}.`;
    } else if (c.dia === '2026-10-14') {
      sinMedir = 'El 13-oct no tuvo conteo fisico, asi que no se sabe con cuanto arranco la caja el 14. Del conteo del '
        + `12-oct (${mx(Number(cortes[0].contado))}) al del 14-oct (${mx(TRAMO_12_14.contado)}), los dos dias juntos: `
        + `deberia haber ${mx(TRAMO_12_14.esperado)}, diferencia ${firmado(TRAMO_12_14.diferencia)}.`;
    }

    if (cambiaConteo) {
      await knex('finance.cash_ledger_cut_denominations').where({ tenant_id: TENANT, cut_id: c.id, momento: 'cierre' }).del();
    }
    await knex('finance.cash_ledger_cuts').where({ id: c.id, tenant_id: TENANT }).update({
      fondo_inicial: n.fondo === null ? null : r2(n.fondo),
      fondo_origen: n.fondo === null ? 'sin_medir' : (c.dia === DESDE ? c.fondo_origen : 'cierre_anterior'),
      total_ingresos: n.ing, total_gastos: n.gas, total_depositos: n.dep,
      esperado: n.esperado,
      contado: n.contado === null ? null : r2(n.contado),
      morralla: cambiaConteo ? 0 : c.morralla,
      diferencia: n.diferencia,
      sin_medir_motivo: sinMedir,
      recalculo_previo: JSON.stringify(previo),
      recalculo_motivo: motivo,
      recalculado_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    if (cambiaConteo && n.contado !== null) {
      if (c.dia !== '2026-10-15') abortar(`${c.folio}: solo el 15-oct tiene reja fisica para reemplazar`);
      const suma = REJA_A23655.reduce((s, [, v, p]) => s + v * p, 0);
      if (r2(suma) !== r2(n.contado)) abortar(`la reja A23655 suma ${suma} y el contado es ${n.contado}`);
      await knex('finance.cash_ledger_cut_denominations').insert(REJA_A23655.map(([k, v, p]) => ({
        tenant_id: TENANT, cut_id: c.id, momento: 'cierre', denom_key: k, denominacion: v, piezas: p,
      })));
    }
    // eslint-disable-next-line no-console
    console.log(`  ✓ [CGS.52] ${c.folio} (${c.dia}): esperado ${c.esperado} -> ${n.esperado}, contado ${c.contado} -> ${n.contado}, dif ${c.diferencia} -> ${n.diferencia}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: devuelve cada corte a su `recalculo_previo`, y la guardia y el candado a como estaban. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  const T = 'finance.cash_ledger_cuts';
  const hay = await knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', 'recalculo_previo');
  if (hay) {
    // La guardia nueva no deja volver atrás sin otra constancia; para deshacer se apaga dentro de esta transacción.
    await knex.raw(`ALTER TABLE ${T} DISABLE TRIGGER trg_cash_cut_guardia`);
    const filas = await knex(T).where({ tenant_id: TENANT }).whereNotNull('recalculo_previo').select('id', 'recalculo_previo');
    for (const f of filas) {
      const p = typeof f.recalculo_previo === 'string' ? JSON.parse(f.recalculo_previo) : f.recalculo_previo;
      if (p.desglose_cierre) {
        await knex('finance.cash_ledger_cut_denominations').where({ tenant_id: TENANT, cut_id: f.id, momento: 'cierre' }).del();
        if (p.desglose_cierre.length) {
          await knex('finance.cash_ledger_cut_denominations').insert(p.desglose_cierre.map((d) => ({
            tenant_id: TENANT, cut_id: f.id, momento: 'cierre', denom_key: d.denom_key, denominacion: d.denominacion, piezas: d.piezas,
          })));
        }
      }
      await knex(T).where({ id: f.id }).update({
        fondo_inicial: p.fondo_inicial, fondo_origen: p.fondo_origen,
        total_ingresos: p.total_ingresos, total_gastos: p.total_gastos, total_depositos: p.total_depositos,
        esperado: p.esperado, contado: p.contado, morralla: p.morralla, diferencia: p.diferencia,
        sin_medir_motivo: null, recalculo_previo: null, recalculo_motivo: null, recalculado_at: null,
      });
    }
    await knex.raw(`ALTER TABLE ${T} ENABLE TRIGGER trg_cash_cut_guardia`);
  }
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS cut_recalculo_completo_chk`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS cut_cerrado_completo_chk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cut_cerrado_completo_chk ${CHK_CERRADO_VIEJO}`);
  // La guardia vuelve a la de [CGS.4]: la misma de arriba sin la rama del recálculo ni sus columnas.
  const vieja = GUARDIA
    .replace(/\n\s*v_recalcula boolean;/, '')
    .replace(/\n\s*-- ⭐ \[CGS\.52\][\s\S]*?RETURN NEW;\n\s*END IF;\n/, '\n')
    .replace(/,\n\s*NEW\.recalculo_previo, NEW\.recalculo_motivo, NEW\.recalculado_at, NEW\.sin_medir_motivo\)/, ')')
    .replace(/,\n\s*OLD\.recalculo_previo, OLD\.recalculo_motivo, OLD\.recalculado_at, OLD\.sin_medir_motivo\)/, ')');
  if (vieja.includes(MARCA_GUARDIA)) throw new Error('[CGS.52] down: no se pudo quitar la rama del recalculo de la guardia');
  await knex.raw(vieja);
  // Las columnas se quedan: borrar columnas en prod pide autorizacion aparte (regla 5).
};
