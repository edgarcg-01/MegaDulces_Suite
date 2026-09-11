/**
 * R.1 — EL HUECO DE `U-D-8` NO SE CIERRA, Y MI RECHECK ESTABA MIDIENDO OTRA COSA.
 *
 * ⚠️ **Autocorrección.** El plan de la Fase R proponía cerrar `U-D-8` sustituyendo el `c62` que
 * Kepler no escribe por `c58 x v_erp_unit_cost.costo_unitario`. **Eso no arbitra nada: es un
 * espejo**, y ADR-059 regla 5 lo prohíbe explícitamente ("un árbitro que nunca contradice es un
 * espejo").
 *
 * ── Por qué es un espejo, medido (2026-09-11, prod) ─────────────────────────────────────────
 *
 * `v_erp_sales_line_units` arbitra la unidad comparando dos cosas:
 *
 * ```text
 *   factor_resuelto  = c58                     <- LO QUE SE AFIRMA (el peldano declarado)
 *   factor_por_costo = round(c62 / u1_cost)    <- EL TESTIGO, y es independiente de c58
 * ```
 *
 * El sustituto propuesto daba `round(c58 * ku / u1_cost)`, con `ku` = costo del almacén. O sea
 * `c58` multiplicado y dividido por dos constantes. Y esas dos constantes son **la misma**:
 *
 * ```text
 *   ku / u1_cost  sobre 24,532 pares:   mediana 1.0000   p10 0.9999   p90 1.1016
 *   dentro de la banda +-15% que usa factor_por_costo:  22,868 = 93.22%
 * ```
 *
 * Con la razón pegada a 1 dentro de la banda de tolerancia, `round(c58 * ku / u1) = c58` **por
 * construcción**. El sustituto habría marcado `confirmado` los 16,845 renglones de `U-D-8` sin
 * haber comprobado nada — y encima habría tapado las contradicciones reales donde las hubiera.
 *
 * ── Lo que estaba mal era el RECHECK, no ADR-059 ────────────────────────────────────────────
 *
 * El `recheck_sql` sembrado en `20260911180000` preguntaba *"¿hay peldano y hay costo?"* y
 * respondía **99.87%**. Pero esas son las **piezas**, no el **árbitro**: tener `c58` y tener un
 * costo por almacén no produce un testigo capaz de CONTRADECIR a `c58`. El único que puede es
 * `c62`, y ahí sigue vacío.
 *
 * ⭐ Así que ADR-059 **queda como está** — "`U-D-8` no es arbitrable y el límite es de la fuente"
 * es correcto. Lo que se corrige es mi plan y el recheck que lo daba por bueno.
 *
 * ⚠️ La lección es la que la fase vino a buscar: **un recheck que mide el insumo en vez del
 * veredicto es exactamente el mismo defecto que los huecos que no caducan** — se lee como una
 * medición y no lo es. Un hueco que se declara resuelto por sus piezas nunca se resolvió.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// Las SIETE columnas de la PK de kdm1 (R.5). Unir por 5 casa el documento equivocado.
const J7 = `h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
            AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6`;

// El testigo tiene que ser INDEPENDIENTE del peldano declarado. c62 lo es; c58 x costo NO.
const RECHECK = `
  WITH l AS (
    SELECT round(NULLIF(regexp_replace(d.c62, '[^0-9.-]', '', 'g'), '')::numeric, 6) c62,
           btrim(d.c8) sku
      FROM kepler_ods.kdm2 d
      JOIN kepler_ods.kdm1 h ON ${J7}
     WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.c4::text) = '8'
       AND h.c9 >= current_date - 90 AND d.sucursal = btrim(d.c1))
  SELECT (count(*) FILTER (WHERE l.c62 > 0 AND sc.u1_cost > 0) < count(*) * 0.90)
           AS sigue_siendo_hueco,
         'testigo INDEPENDIENTE (c62) en ' ||
         round(100.0 * count(*) FILTER (WHERE l.c62 > 0 AND sc.u1_cost > 0)
               / NULLIF(count(*), 0), 2) || '% de ' || count(*) || ' renglones. ' ||
         'El sustituto c58 x costo_almacen NO es testigo: costo_almacen/costo_pagado tiene ' ||
         'mediana 1.0000, asi que round(c58 x ku / u1) = c58 por construccion (espejo, ADR-059 R5)'
           AS detalle
    FROM l
    LEFT JOIN analytics.v_supplier_cost_ladder sc ON sc.sku = l.sku`;

const MOTIVO = 'ADR-059: Kepler no escribe c62 ni c63 en U-D-8 (vacios en ~98.85%), y ese es el '
  + 'UNICO testigo independiente del peldano declarado. Sustituirlo por c58 x costo_del_almacen '
  + 'seria un ESPEJO: medido 2026-09-11, costo_almacen/costo_pagado da mediana 1.0000 (93.22% '
  + 'dentro de la banda +-15% del arbitro), asi que el sustituto confirma c58 por construccion.';

const RESOLVER = 'un testigo de costo por RENGLON que no se derive de c58 -- hoy no existe en la '
  + 'fuente. El precio no vota (ADR-059 R2) y en U-D-8 cae al peldano base en 56.9%.';

exports.up = async function up(knex) {
  const antes = (await knex.raw(
    `SELECT motivo, estado FROM analytics.declared_gaps
      WHERE tenant_id = ? AND clave = 'ud8_sin_arbitro'`, [T])).rows[0];
  if (!antes) throw new Error('no existe el hueco ud8_sin_arbitro: corre antes la siembra R.0b');

  await knex('analytics.declared_gaps')
    .where({ tenant_id: T, clave: 'ud8_sin_arbitro' })
    .update({
      motivo: MOTIVO,
      resolver_faltante: RESOLVER,
      recheck_sql: RECHECK,
      estado: 'irresoluble_con_la_fuente',
    });

  // ── Auto-verificación: el recheck corregido tiene que decir que SIGUE siendo hueco ──
  // Si dijera que no, o el recheck volvió a medir las piezas, o la fuente cambió de verdad.
  const r = (await knex.raw(RECHECK)).rows[0];
  console.log(`  [ud8] ${r.detalle}`);
  if (r.sigue_siendo_hueco !== true) {
    throw new Error('el recheck corregido dice que ya NO es hueco: eso contradice a c62 vacio. '
      + `Detalle: ${r.detalle}`);
  }

  // Y la prueba de que el recheck nuevo NO es el viejo: el viejo daba >=90% y este da <10%.
  const viejo = (await knex.raw(`
    WITH l AS (
      SELECT d.sucursal, btrim(d.c8) sku,
             NULLIF(btrim(d.c58::text), '') IS NOT NULL AS tiene_peldano
        FROM kepler_ods.kdm2 d
        JOIN kepler_ods.kdm1 h ON ${J7}
       WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.c4::text) = '8'
         AND h.c9 >= current_date - 90 AND d.sucursal = btrim(d.c1))
    SELECT round(100.0 * count(*) FILTER (WHERE l.tiene_peldano AND kc.costo_unitario > 0)
                 / NULLIF(count(*), 0), 2) AS pct
      FROM l
      LEFT JOIN analytics.v_kepler_unit_cost kc
             ON kc.kepler_code = l.sucursal AND kc.sku = l.sku`)).rows[0].pct;
  console.log(`  [ud8] el recheck VIEJO (las piezas) daba ${viejo}% -- por eso daba el hueco por cerrado`);
  if (Number(viejo) < 90) {
    throw new Error(`el recheck viejo daba ${viejo}%: la autocorreccion pierde su premisa`);
  }
};

exports.down = async function down() {
  // No se revierte: volver al recheck viejo es volver a medir el insumo en vez del veredicto.
};
