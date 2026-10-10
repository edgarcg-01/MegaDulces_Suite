'use strict';
/**
 * `[CPA.0.1]` — **El TECHO del semáforo, uno POR FAMILIA; y el piso de compras, corregido.**
 *
 * ── Hueco 1: un mes posteado dos veces se veía sano ─────────────────────────────────────────
 * Las cinco familias se clasifican con `higher_is_better`, así que `clasificarKpi` **sólo mira el
 * piso**: una cobertura del doble salía `ok`. Si la póliza de compras de un mes se asentara
 * **duplicada** —el riesgo contra el que el Libro de Compras tiene cuatro puertas— la cobertura
 * treparía y el tablero diría **verde**.
 *
 * ⛔ **No se arregla invirtiendo la dirección:** `lower_is_better` en la fila de piso rompería la
 * detección de ausencia, que es para lo que el semáforo existe. Hacen falta **dos lecturas del
 * mismo número**, y el engine se queda con el peor veredicto.
 *
 * ⭐ **Y no inventa nada:** el techo vive en el MISMO registro con el MISMO clasificador, sólo con
 * `direction = 'lower_is_better'` y la clave sufijada `.alto` (ADR-056: cero primitivos nuevos).
 *
 * ── ⛔⛔ Un techo ÚNICO no sirve, y el candado lo destapó ────────────────────────────────────
 * La primera versión de esta migración ponía **1.60 para las cinco**. Está mal, y el error se ve
 * al medir **por familia** sobre los meses cerrados de prod (2026-10-10):
 *
 *   | familia | n  | mín    | mediana | máx    | duplicado (2× mediana) | techo |
 *   |---------|---:|-------:|--------:|-------:|-----------------------:|------:|
 *   | compras | 20 | 0.5340 |  0.6711 | 0.8198 |                   1.34 |  0.94 |
 *   | ventas  | 21 | 0.8907 |  0.9053 | 0.9181 |                   1.81 |  1.06 |
 *   | bancos  |  9 | 0.8740 |  0.9090 | 1.1063 |                   1.82 |  1.27 |
 *   | gastos  | 20 | 0.8390 |  1.0590 | 1.3868 |                   2.12 |  1.59 |
 *   | nomina  | 20 | 0.7445 |  1.0078 | 1.3631 |                   2.02 |  1.57 |
 *
 * Con 1.60 para todas, **un mes de compras duplicado (1.34) habría pasado como sano** — justo la
 * familia que el hueco pone en riesgo — y a `gastos` (máx real 1.3868) le habría quedado aire de
 * apenas 0.21 para dar falsas alarmas. El techo se deriva de la banda de CADA familia:
 * `target = máx × 1.15`, y `escalate_at` **por debajo del duplicado**, que es lo que tiene que
 * atrapar. Verificado: en las cinco, `2× mediana > escalate_at`.
 *
 * ── Hueco 2: el piso de compras estaba demasiado cerca ──────────────────────────────────────
 * `[CPA.0]` fijó el piso de compras en **0.50** midiendo **5 meses** (banda 0.667–0.723). Con
 * **20 meses**, el mínimo real es **0.5340** — quedaban **3.4 pp** de margen. Y esos meses bajos
 * **están sanos**: 2025-04 tiene $34.9 M en 250 renglones, lo que baja la razón es que el testigo
 * de CFDI fue alto ese mes. Un piso a 3 pp de lo normal es una falsa alarma esperando su turno, y
 * una falsa alarma enseña a ignorar el tablero — que es exactamente cómo se pierde el mes que de
 * verdad falta. Se baja a **0.40** (25 % por debajo del mínimo observado), sin tocar
 * `escalate_at = 0.10`: la ausencia (0.0000) se sigue atrapando igual.
 *
 * ⚠️ Sólo se corrige la fila cuya procedencia es la de `[CPA.0]`. Si alguien la ajustó a mano, su
 * valor **gana** y esta migración no lo pisa.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

const FUENTE_TECHO =
  'CPA.0.1 — techo POR FAMILIA, derivado de su propia banda en pg-prod (2026-10-10, meses '
  + 'cerrados): target = maximo observado x 1.15 y escalate_at por DEBAJO del duplicado '
  + '(2x mediana), que es lo que tiene que atrapar. Ver FASE_CPA_AUTOMATIZACION_CONTABLE.md.';

/** `target` = máx × 1.15 · `escalate_at` siempre por debajo de `2 × mediana`. */
const TECHOS = [
  { familia: 'compras', target: 0.94, warn_at: 1.15, escalate_at: 1.30 }, // duplicado 1.34
  { familia: 'ventas',  target: 1.06, warn_at: 1.35, escalate_at: 1.55 }, // duplicado 1.81
  { familia: 'bancos',  target: 1.27, warn_at: 1.60, escalate_at: 1.80 }, // duplicado 1.82
  { familia: 'gastos',  target: 1.59, warn_at: 1.85, escalate_at: 2.05 }, // duplicado 2.12
  { familia: 'nomina',  target: 1.57, warn_at: 1.80, escalate_at: 1.95 }, // duplicado 2.02
];

/** La procedencia que escribió `[CPA.0]`; se usa para no pisar un ajuste humano posterior. */
const FUENTE_PISO_CPA0 =
  'CPA.0 — banda medida contra pg-prod el 2026-10-10 sobre los meses cerrados de 2026 ';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const t of TECHOS) {
    await knex.raw(
      `INSERT INTO analytics.kpi_thresholds
         (tenant_id, kpi_key, position_code, period, target, warn_at, escalate_at,
          direction, escalate_to, source, manual_lock)
       VALUES (?, ?, NULL, 'mes', ?, ?, ?, 'lower_is_better', 'jefe_finanzas', ?, true)
       ON CONFLICT (tenant_id, kpi_key, period, COALESCE(position_code, ''))
         WHERE deleted_at IS NULL
       DO NOTHING`,
      [TENANT, `cierre_contable.${t.familia}.alto`, t.target, t.warn_at, t.escalate_at, FUENTE_TECHO],
    );
  }

  // El piso de compras, re-medido sobre 20 meses en vez de 5. No toca `escalate_at`.
  const upd = await knex.raw(
    `UPDATE analytics.kpi_thresholds
        SET target = 0.40,
            source = source || ' | CPA.0.1: target 0.50 -> 0.40, remedido sobre 20 meses '
                   || '(minimo real 0.5340, y esos meses estan sanos).',
            updated_at = now()
      WHERE tenant_id = ? AND kpi_key = 'cierre_contable.compras' AND period = 'mes'
        AND deleted_at IS NULL AND target = 0.50 AND source LIKE ? || '%'`,
    [TENANT, FUENTE_PISO_CPA0],
  );

  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.kpi_thresholds
      WHERE tenant_id = ? AND kpi_key LIKE 'cierre_contable.%.alto' AND deleted_at IS NULL`,
    [TENANT],
  );
  console.log(`  [CPA.0.1] techos: ${rows[0].n} de ${TECHOS.length} · piso de compras ajustado: ${upd.rowCount}`);
};

/** Borra sólo los techos de esta fase. El piso NO se revierte: 0.50 era el valor mal medido. */
exports.down = async function down(knex) {
  await knex.raw(
    `DELETE FROM analytics.kpi_thresholds
      WHERE tenant_id = ? AND kpi_key LIKE 'cierre_contable.%.alto' AND source = ?`,
    [TENANT, FUENTE_TECHO],
  );
};
