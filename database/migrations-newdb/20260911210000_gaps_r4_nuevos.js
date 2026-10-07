/**
 * R.4 — DOS HUECOS QUE DESTAPÓ VERIFICAR R.2, sembrados con su condición de caducidad.
 *
 * Los dos salieron de mirar la fuente en vez de la pantalla, y ninguno estaba en
 * `docs/VERDAD_ABSOLUTA.md` §7. Van acá porque el mecanismo de R.0 sólo vigila lo que está
 * sembrado: *"un hueco SIN fila acá es invisible para este mecanismo"*.
 *
 * ── 1. `wincaja_unidad_no_conmensurable` ⭐ la media verdad que R.2 NO cierra ────────────────
 *
 * R.2 escribe el divisor que la proyección de Wincaja aplica, y con eso el NULL deja de ser mudo.
 * Pero el plan pedía persistir **dos** cosas —el divisor **y en qué unidad quedó**— y sólo se
 * persistió la primera. `rung_factor = 1` en Wincaja dice "no se convirtió", que es cierto; lo que
 * NO dice es que ese `units` está en la **unidad de venta del artículo** mientras el de Kepler está
 * en **unidad base** (ADR-055). Sumar las dos columnas es sumar peras con cajas de peras.
 *
 * Medido 2026-09-11 sobre el catálogo de Wincaja (1 fila por artículo, dataset más reciente):
 *
 * ```text
 *   PZA .... 15,177 articulos   13,297 con factor_venta > 1   <- NINGUNO se multiplica
 *   CJA ....    197 articulos        4 con factor_venta > 1   <- los unicos que multiplican
 *   KGS ....    166 articulos       13 con factor_venta > 1
 * ```
 *
 * O sea: el divisor es 1 en prácticamente todo, y por eso R.2 **no mueve ninguna cifra
 * publicada**. El riesgo no es el divisor — es que `units` no es conmensurable entre ERPs.
 *
 * ⚠️ Se declara en vez de "arreglarse" porque el arreglo tiene dueño y costo: convertir el `units`
 * de Wincaja a unidad base movería toda su serie histórica, y ADR-055 ya advierte que **el dato
 * base NO se convierte** (se intentó y rompió el pedido).
 *
 * ── 2. `ventas_fecha_futura` ────────────────────────────────────────────────────────────────
 *
 * 4 celdas de Wincaja fechadas **2026-12-06** ($230) con la corrida del 2026-09-11. Es chico, pero
 * es un error de captura que el fact propaga tal cual, y cualquier ventana "últimos N días" o
 * "cierre de mes" lo arrastra. Se declara con umbral de no-crecimiento.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

const GAPS = [
  {
    clave: 'wincaja_unidad_no_conmensurable',
    titulo: 'El units de Wincaja y el de Kepler viven en unidades distintas en la misma columna',
    monto: 923078781,
    unidad: 'MXN historico',
    declarado_en: '2026-09-11',
    motivo: 'ADR-055: Wincaja guarda en la unidad de VENTA del articulo y Kepler en unidad BASE. '
      + 'analytics.sales_daily.units mezcla las dos y no hay columna que diga cual es cual. '
      + 'R.2 escribio el divisor aplicado (rung_factor) pero NO la unidad en que quedo, que era la '
      + 'segunda mitad del plan. Medido: de 15,552 articulos de Wincaja solo 197 son CJA y solo 4 '
      + 'multiplican, o sea el divisor es 1 casi siempre -- el problema no es el divisor.',
    resolver_faltante: 'una columna que declare la unidad nativa por celda (v_unit_truth.'
      + 'veredicto_nativo ya la calcula por almacen x producto), o la decision de convertir -- que '
      + 'ADR-055 desaconseja: el dato base NO se convierte.',
    estado: 'abierto',
    recheck_sql: `
      SELECT (count(*) FILTER (WHERE c.column_name IN ('unit_native','rung_unit')) = 0)
               AS sigue_siendo_hueco,
             CASE WHEN count(*) FILTER (WHERE c.column_name IN ('unit_native','rung_unit')) = 0
                  THEN 'sales_daily sigue sin columna que declare la unidad nativa de la celda'
                  ELSE 'ya existe columna de unidad nativa: ' ||
                       string_agg(c.column_name, ', ') FILTER (
                         WHERE c.column_name IN ('unit_native','rung_unit')) END AS detalle
        FROM information_schema.columns c
       WHERE c.table_schema = 'analytics' AND c.table_name = 'sales_daily'`,
  },
  {
    clave: 'ventas_fecha_futura',
    titulo: 'Celdas de venta fechadas en el futuro',
    monto: 230,
    unidad: 'MXN',
    declarado_en: '2026-09-11',
    motivo: 'Error de captura en el POS que el fact propaga tal cual: 4 celdas de Wincaja con '
      + 'sale_date 2026-12-06, medidas el 2026-09-11. Chico en monto, pero contamina cualquier '
      + 'ventana de cierre y cualquier "ultimos N dias".',
    resolver_faltante: 'una correccion en el origen (el ticket mal fechado) o una regla explicita '
      + 'de cuarentena en la proyeccion -- hoy no hay ninguna de las dos.',
    estado: 'abierto',
    recheck_sql: `
      SELECT (count(*) > 0) AS sigue_siendo_hueco,
             CASE WHEN count(*) = 0 THEN 'ya no hay celdas fechadas en el futuro'
                  ELSE count(*) || ' celdas fechadas en el futuro por $' ||
                       round(COALESCE(sum(revenue), 0)::numeric, 2) ||
                       ' (hasta ' || max(sale_date) || ')' END AS detalle
        FROM analytics.sales_daily
       WHERE tenant_id = '${T}' AND sale_date > current_date`,
  },
];

exports.up = async function up(knex) {
  for (const g of GAPS) {
    // El recheck se ejercita ANTES de sembrarlo: un recheck roto se leeria como "todo en orden".
    const r = (await knex.raw(g.recheck_sql)).rows[0];
    if (!r || typeof r.sigue_siendo_hueco !== 'boolean') {
      throw new Error(`el recheck de ${g.clave} no cumple el contrato: ${JSON.stringify(r)}`);
    }
    if (r.sigue_siendo_hueco !== true) {
      throw new Error(`${g.clave} se siembra como abierto pero su recheck dice que no es hueco: `
        + `${r.detalle}`);
    }
    await knex('analytics.declared_gaps')
      .insert({
        tenant_id: T,
        clave: g.clave,
        titulo: g.titulo,
        monto: g.monto,
        unidad: g.unidad,
        declarado_en: g.declarado_en,
        motivo: g.motivo,
        resolver_faltante: g.resolver_faltante,
        recheck_sql: g.recheck_sql,
        estado: g.estado,
        ultima_medicion: knex.fn.now(),
        ultimo_detalle: r.detalle,
      })
      .onConflict(['tenant_id', 'clave'])
      .merge(['titulo', 'monto', 'unidad', 'motivo', 'resolver_faltante', 'recheck_sql',
        'estado', 'ultima_medicion', 'ultimo_detalle']);
    console.log(`  [gap] ${g.clave.padEnd(34)} ${r.detalle}`);
  }

  const n = (await knex('analytics.declared_gaps').where({ tenant_id: T }).count('* as n'))[0].n;
  console.log(`  [gap] la tabla queda con ${n} huecos declarados`);
};

exports.down = async function down(knex) {
  await knex('analytics.declared_gaps')
    .where({ tenant_id: T })
    .whereIn('clave', GAPS.map((g) => g.clave))
    .del();
};
