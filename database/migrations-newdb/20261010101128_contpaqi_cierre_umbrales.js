'use strict';
/**
 * `[CPA.0]` — **Los cinco umbrales del semáforo de cierre, en el registro que YA existía.**
 *
 * ⛔ **No se crea una tabla nueva.** `analytics.kpi_thresholds` nació en `[CDRP.2]` justamente
 * porque ya había **tres** registros de umbrales distintos (`CRON_JOBS`, un array de TS;
 * `commercial.execution_thresholds`, una fila por tenant con el umbral como COLUMNA; y
 * `reorder_policy`, otro grano) y ninguno escalaba. Escribir un cuarto acá sería repetir
 * exactamente el defecto que ADR-056 prohíbe: *un primitivo inventado no cierra la fase*.
 * Éste es su **primer uso real** — la tabla estaba vacía a propósito.
 *
 * ── Qué miden, y por qué estos números ──────────────────────────────────────────────────────
 * El valor clasificado es la **cobertura** de `analytics.v_contpaqi_cierre_mensual`:
 * `señal contable ÷ testigo independiente` (o ÷ la mediana de los 6 meses previos, para las dos
 * familias que no tienen testigo).
 *
 * ⭐⭐ **Esto es un detector de AUSENCIA, no de varianza.** La pregunta que contesta es *«¿está
 * asentado este mes?»*, no *«¿se movió 3 % contra el mes pasado?»*. Por eso los umbrales son
 * **holgados respecto de la banda medida**: un semáforo que se pone amarillo por una variación
 * normal enseña a ignorarlo, y entonces el mes que de verdad falta pasa desapercibido — que es
 * justo lo que ocurrió con septiembre-2026.
 *
 * Bandas reales medidas contra prod (meses cerrados de 2026) y umbral elegido:
 *
 *   | kpi_key                    | banda medida     | target | warn_at | escalate_at |
 *   |----------------------------|------------------|--------|---------|-------------|
 *   | cierre_contable.compras    | 0.667 – 0.723    | 0.50   | 0.20    | 0.10        |
 *   | cierre_contable.ventas     | 0.902 – 0.918    | 0.70   | 0.30    | 0.15        |
 *   | cierre_contable.bancos     | 0.874 – 1.106    | 0.60   | 0.25    | 0.10        |
 *   | cierre_contable.gastos     | 0.839 – 1.387    | 0.50   | 0.25    | 0.10        |
 *   | cierre_contable.nomina     | 0.920 – 1.123    | 0.50   | 0.25    | 0.10        |
 *
 * Con estos números, medido sobre los datos reales de hoy:
 *  · jul-2026 y ago-2026 → las cinco familias en `ok`.
 *  · **sep-2026 compras → cobertura 0.0000 → `bad`, y escala.**
 *  · sep-2026 ventas 0.9045, bancos 0.9285, gastos 1.3868, nomina 1.0639 → `ok`.
 *
 * ⚠️ `direction` es `higher_is_better` en las cinco: **cobertura de más no es un problema de
 * cierre**. Un mes que publique 1.4 veces su mediana puede ser un mes caro o un reclasificado;
 * lo que este tablero persigue es el mes que **falta**. Vigilar el exceso es otro indicador, y
 * mezclarlos en una sola fila haría que la precedencia le mienta a uno de los dos.
 *
 * ⚠️ `escalate_to = 'jefe_finanzas'` porque es una silla **OCUPADA**: medido hoy, 2 personas.
 * `encargado_contabilidad` sería el dueño natural y tiene **0** — escalar ahí es escalar a nadie,
 * que es la lección central de ADR-076.
 *
 * ⚠️ `manual_lock = true`: estos umbrales salieron de una medición humana con procedencia escrita.
 * Un auto-calibrador que los mueva volvería a hacer invisible la ausencia (ADR-021).
 *
 * Idempotente: `ON CONFLICT` sobre el único `(tenant, kpi, period, puesto)`. **No pisa** una fila
 * que alguien haya ajustado después — sólo rellena la que falte.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

const FUENTE =
  'CPA.0 — banda medida contra pg-prod el 2026-10-10 sobre los meses cerrados de 2026 ' +
  '(abr-ago para las familias con testigo). Detector de AUSENCIA: el umbral es holgado a ' +
  'proposito respecto de la banda. Ver FASE_CPA_AUTOMATIZACION_CONTABLE.md seccion 10.';

const UMBRALES = [
  { kpi_key: 'cierre_contable.compras', target: 0.50, warn_at: 0.20, escalate_at: 0.10 },
  { kpi_key: 'cierre_contable.ventas',  target: 0.70, warn_at: 0.30, escalate_at: 0.15 },
  { kpi_key: 'cierre_contable.bancos',  target: 0.60, warn_at: 0.25, escalate_at: 0.10 },
  { kpi_key: 'cierre_contable.gastos',  target: 0.50, warn_at: 0.25, escalate_at: 0.10 },
  { kpi_key: 'cierre_contable.nomina',  target: 0.50, warn_at: 0.25, escalate_at: 0.10 },
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const u of UMBRALES) {
    await knex.raw(
      `INSERT INTO analytics.kpi_thresholds
         (tenant_id, kpi_key, position_code, period, target, warn_at, escalate_at,
          direction, escalate_to, source, manual_lock)
       VALUES (?, ?, NULL, 'mes', ?, ?, ?, 'higher_is_better', 'jefe_finanzas', ?, true)
       ON CONFLICT (tenant_id, kpi_key, period, COALESCE(position_code, ''))
         WHERE deleted_at IS NULL
       DO NOTHING`,
      [TENANT, u.kpi_key, u.target, u.warn_at, u.escalate_at, FUENTE],
    );
  }

  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.kpi_thresholds
      WHERE tenant_id = ? AND kpi_key LIKE 'cierre_contable.%' AND deleted_at IS NULL`,
    [TENANT],
  );
  console.log(`  [CPA.0] umbrales de cierre registrados: ${rows[0].n} de ${UMBRALES.length}`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: borra sólo las cinco claves de esta fase, y sólo si
 * nadie las editó (`manual_lock` sigue en `true` y la procedencia es la nuestra).
 */
exports.down = async function down(knex) {
  await knex.raw(
    `DELETE FROM analytics.kpi_thresholds
      WHERE tenant_id = ? AND kpi_key LIKE 'cierre_contable.%' AND source = ?`,
    [TENANT, FUENTE],
  );
};
