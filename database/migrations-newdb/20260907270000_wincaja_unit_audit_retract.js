/**
 * P.1 — RETRACTACIÓN: `caja_sin_capturar` no era un defecto. Lo inventé yo.
 *
 * ── Qué afirmé, y por qué era falso ───────────────────────────────────────────────────────
 * La mig `20260907260000` publicó el veredicto `caja_sin_capturar` para **1,286 SKUs de Wincaja**
 * ($1,513,977 con existencia), con esta regla: *"`unidad_compra = 'CJA'` con `factor_venta <= 1` es
 * incoherente por sí solo: no se compra una caja de una pieza."*
 *
 * Edgar respondió que Wincaja y Kepler funcionan bien y que la diferencia venía de una
 * investigación mal hecha. **Tenía razón.** Tres mediciones lo prueban, y ninguna la hice antes de
 * publicar el veredicto:
 *
 *  1. **El campo en el que apoyé la regla no se mantiene.** `unidad_compra` vale `'CJA'` en el
 *     **94.53%** de los artículos (14,685 de 15,535) — es casi constante, no discrimina nada. Y
 *     `factor_compra` vale **1 en 15,535 de 15,535 (100%)**. El par de compra de Wincaja está sin
 *     capturar por completo; construí un detector sobre datos que nadie llena.
 *
 *  2. **La evidencia de compra los contradice.** Los artículos que marqué tienen escalera de costo
 *     del proveedor en **13.6%**, contra **62.8%** del grupo sano. Si de verdad tuvieran una caja
 *     sin capturar, la evidencia debería aparecer al mismo ritmo. Aparece cinco veces menos.
 *
 *  3. ⭐ **El DINERO dice que su unidad de venta ES la caja.** Comparando el precio de lista de
 *     Wincaja contra el costo pagado al proveedor:
 *
 *         grupo                          precio parece de UNIDAD   parece de CAJA   mediana vs caja
 *         los que marqué (fv<=1, uc=CJA)          1.9%                95.1%             1.132
 *         sano (fv>1, uv=PZA)                    95.0%                 0.0%             0.063
 *         unidad_es_caja (uv=CJA)                18.2%                81.8%             1.122
 *
 *     Los que marqué se comportan **igual que el grupo que Wincaja rotula `CJA` explícitamente**.
 *     `factor_venta = 1` es CORRECTO para ellos: una unidad de venta por caja, porque la unidad de
 *     venta es la caja. No hay nada sin capturar.
 *
 * ── El error de método ────────────────────────────────────────────────────────────────────
 * Confié en un RÓTULO (`unidad_venta`, `unidad_compra`) por encima del DINERO. Es exactamente lo
 * que este repo tiene documentado tres veces (GOTCHAS: *"para convertir unidades de Kepler el
 * nombre de la unidad no sirve; el dinero sí"*), y horas antes yo mismo había escrito que el caso
 * `70031` probaba que el rótulo no miente. Después dejé que un rótulo me hiciera inventar un
 * defecto de $1.5M.
 *
 * ── Qué queda ─────────────────────────────────────────────────────────────────────────────
 * La vista deja de emitir veredictos de DEFECTO y pasa a DESCRIBIR lo que Wincaja declara. Wincaja
 * no tiene unidades incorrectas — medido: **0 de 46,577** artículos con más de una unidad de venta,
 * **0 de 15,535** SKUs con unidad distinta entre las 3 ramas vivas, `factor_venta` consistente entre
 * ramas en **99.92%**.
 *
 *     peso            unidad_venta = KGS      -> no se divide
 *     servicio        unidad_venta = SER      -> no es mercancia
 *     unidad_es_caja  unidad_venta = CJA      -> divisor 1, la unidad ya es la caja
 *     multipack       factor_venta > 1        -> divisor = factor_venta
 *     unidad_simple   factor_venta <= 1       -> divisor 1: una unidad de venta por caja
 *
 * `divisor_wincaja` **nunca es NULL**: Wincaja siempre declara su divisor. Lo que antes salía NULL
 * era mi veredicto falso, no una ausencia de dato.
 *
 * ⚠️ Lo que SÍ sigue siendo cierto y se conserva: dentro de Wincaja **no se puede distinguir pieza
 * de paquete**, porque no existe el rótulo `PAQ` (censo: PZA 15,161 · CJA 197 · KGS 165 · SER 11).
 * Eso se declara, no se adivina. Y las columnas `UnidadAuxiliar` / `UnidadDetallista` /
 * `FactorDetallista` / `PesoTeorico` del `.mdb` están **vacías** (medido en la réplica completa
 * `:5433/wincaja`), así que tampoco ayudan.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  const ok = (await knex.raw(`SELECT to_regclass('analytics.v_wincaja_unit_audit') AS v`)).rows[0];
  if (!ok?.v) {
    console.log('  [P.1] la vista no existe — no-op.');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_wincaja_unit_audit AS
    SELECT
      w.tenant_id,
      a.source_branch,
      w.id                                                AS warehouse_id,
      w.code                                              AS warehouse_code,
      a.articulo                                          AS sku,
      pr.id                                               AS product_id,
      a.nombre,
      upper(btrim(coalesce(a.unidad_venta,  '')))         AS unidad_venta,
      upper(btrim(coalesce(a.unidad_compra, '')))         AS unidad_compra,
      COALESCE(a.factor_venta, 0)::numeric                AS factor_venta,
      COALESCE(e.existencia, 0)::numeric                  AS existencia,
      e.costo_promedio,
      round((COALESCE(e.existencia,0) * COALESCE(e.costo_promedio,0))::numeric, 2) AS valor,
      e.fecha_ult_venta,
      -- DESCRIBE lo que Wincaja declara. Ya no hay veredicto de "defecto": la medicion del
      -- 2026-09-07 mostro que el unico que habia (caja_sin_capturar) era falso -- ver el header.
      CASE
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'KGS'    THEN 'peso'
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'SER'    THEN 'servicio'
        WHEN upper(btrim(coalesce(a.unidad_venta,''))) = 'CJA'    THEN 'unidad_es_caja'
        WHEN COALESCE(a.factor_venta,0) > 1                       THEN 'multipack'
        ELSE                                                           'unidad_simple'
      END                                                 AS veredicto,
      -- El divisor que Wincaja SOSTIENE. Nunca NULL: Wincaja siempre lo declara.
      CASE
        WHEN COALESCE(a.factor_venta,0) > 1
         AND upper(btrim(coalesce(a.unidad_venta,''))) NOT IN ('CJA','KGS','SER')
                                                                  THEN a.factor_venta::numeric
        ELSE                                                           1::numeric
      END                                                 AS divisor_wincaja
      FROM wincaja.articulos a
      JOIN commercial.warehouses w
        ON w.tenant_id = a.tenant_id
       AND w.wincaja_source_branch = a.source_branch
       AND w.kepler_code IS NULL
       AND w.deleted_at IS NULL
      LEFT JOIN wincaja.existencias e
        ON e.tenant_id = a.tenant_id AND e.source_branch = a.source_branch
       AND e.articulo = a.articulo AND e.source_dataset = 'actual'
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = a.tenant_id AND pr.sku = a.articulo AND pr.deleted_at IS NULL
     WHERE a.source_dataset = 'actual'
  `);

  await knex.raw('ALTER VIEW analytics.v_wincaja_unit_audit SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_wincaja_unit_audit TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_wincaja_unit_audit IS
    'P.1 - DESCRIBE la unidad que Wincaja declara, con datos de Wincaja. NO emite veredictos de defecto: el unico que hubo (caja_sin_capturar, 1,286 SKUs) era FALSO y se retiro el 2026-09-07. Se apoyaba en unidad_compra (constante CJA en 94.53%) y factor_compra (1 en el 100%), campos que Wincaja no mantiene; y el dinero lo desmiente: el precio de esos articulos es precio de CAJA en 95.1% de los casos. Wincaja no tiene unidades incorrectas: 0 de 46,577 articulos con mas de una unidad, factor_venta consistente entre ramas en 99.92%. divisor_wincaja nunca es NULL.'`);

  const v = (await knex.raw(`
    SELECT veredicto, count(DISTINCT sku)::int skus, count(*)::int celdas,
           count(*) FILTER (WHERE existencia > 0)::int con_exist
      FROM analytics.v_wincaja_unit_audit WHERE tenant_id = '${M}'::uuid
     GROUP BY 1 ORDER BY skus DESC`)).rows;
  for (const r of v) {
    console.log(`  ${String(r.veredicto).padEnd(16)} skus=${String(r.skus).padStart(6)}`
      + ` celdas=${String(r.celdas).padStart(6)} conExist=${String(r.con_exist).padStart(5)}`);
  }

  // Auto-verificacion de la retractacion.
  if (v.some((r) => r.veredicto === 'caja_sin_capturar')) {
    throw new Error('el veredicto falso sigue vivo');
  }
  const nulos = (await knex.raw(`
    SELECT count(*)::int n FROM analytics.v_wincaja_unit_audit
     WHERE tenant_id = '${M}'::uuid AND divisor_wincaja IS NULL`)).rows[0];
  if (nulos.n !== 0) throw new Error(`${nulos.n} celdas con divisor NULL: Wincaja siempre lo declara`);
};

exports.down = async function down() {
  // No-op: revertir seria volver a publicar un defecto que no existe.
};
