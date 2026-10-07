/**
 * VA.3 — `catalog.products.factor_sale` DEJA DE SER UN HECHO PROPIO.
 *
 * Edgar, 2026-09-11: **"no quiero parches, quiero una verdad absoluta"**. Tenía razón: los
 * trinquetes y baselines que se construyeron antes (VA.1, VA.2) *administran* la divergencia —
 * formalizan la deuda en vez de eliminarla.
 *
 * ── Por qué un trinquete no alcanzaba ───────────────────────────────────────────────────────
 *
 * La causa de las discrepancias no es que nadie mida: es que **hay dos lugares guardando el mismo
 * hecho**. Mientras los dos existan van a divergir, y lo único que se puede hacer es contar
 * cuánto. La regla principal del proyecto ya lo prohibía: *"NUNCA hacer copias — siempre contra la
 * tabla principal. Si necesitás otra forma del dato, DERIVÁ"*. `factor_sale` publicado ES una
 * copia de un hecho que ya tiene derivación canónica (`analytics.v_product_box_factor`, ADR-055).
 *
 * Y no era cosmético. Medido el 2026-09-11, sobre un factor que el árbitro contradice descansan:
 *
 *     plan de reabasto ....  5,608 lineas · 1,189 productos
 *     salud de inventario .  6,514 filas  · 1,177 productos
 *     politica de reorden .  3,923 filas  ·   714 productos
 *     demanda .............  3,390 filas  ·   546 productos
 *
 * Factor mal → demanda mal → punto de reorden mal → compra mal. La columna tiene **3 escritores**
 * (`import-catalog-bulk`, `backfill-factor-from-wincaja`, `import-wincaja-missing-products`) y
 * **10 importers que calculan sobre ella**.
 *
 * ── ⭐ Lo que se escribe, y lo que NO ───────────────────────────────────────────────────────
 *
 *     difieren en total ......................... 2,333
 *       source = 'default'  (SIN testigo) ....... 1,479   <- NO se tocan
 *       con testigo real ........................   854   <- se escriben
 *          kepler_c84 449 · override 261 · etiquetera 132 · override_no_dato 12
 *          de esos: 232 pasan de NULL a un valor · 622 cambian de un valor a otro
 *
 * ⛔ **Los 1,479 con `source = 'default'` NO se escriben.** `default` no es una afirmación: es la
 * ausencia de testigo, y el resolvedor la representa con un 1. Escribirlo convertiría **"no sé" en
 * "1"** en mil cuatrocientos productos — exactamente el pecado que ADR-056 prohíbe, cometido en
 * nombre de la verdad absoluta. 1,442 de ellos tienen `factor_sale` en NULL hoy, y NULL se queda.
 *
 * ── ⭐ Punto fijo: escribir el resolvedor NO lo mueve ───────────────────────────────────────
 *
 * `v_product_box_factor` **lee** `factor_sale` (es una de sus fuentes, `source='factor_sale'`), así
 * que escribirle su propia salida podía ser circular. Se probó en transacción con ROLLBACK antes
 * de decidir: tras escribir, las discrepancias quedan en **0**, y **ninguno** de los que cambian
 * tiene `source='factor_sale'` — el CASE de la vista prefiere `override > inner_box_guard > c84 >
 * etiquetera` y recién después `fs`, así que el valor escrito no se vuelve su propia fuente. La
 * migración lo re-verifica acá mismo: si dejara de ser punto fijo, lanza.
 *
 * ── ⚠️ Lo que esta migración NO cierra ──────────────────────────────────────────────────────
 *
 * Corrige el VALOR de hoy. Los **3 escritores siguen existiendo** y pueden volver a divergir: eso
 * es un cambio de importers y va aparte (editar un importer despliega a prod al instante). Hasta
 * que se retiren, el candado `test-newdb-truth-parity.js` con objetivo **CERO** es el cable
 * trampa — y un objetivo de cero, a diferencia de un baseline de 208, no es un parche.
 *
 * ⚠️ **58 de los 854 tienen a lo PAGADO al proveedor contradiciendo al resolvedor**, y 33 vienen
 * marcados `is_master_suspect`. Se escriben igual —excluirlos recrearía dos verdades— y quedan
 * DECLARADOS en `analytics.declared_gaps` para que nadie los lea como confirmados.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// ⛔ El filtro que define la verdad: sólo donde el árbitro tiene TESTIGO. 'default' es ausencia.
const CON_TESTIGO = `b.source <> 'default'`;

exports.up = async function up(knex) {
  const contar = async (extra = '') => (await knex.raw(`
    SELECT count(*)::int n
      FROM catalog.products p
      JOIN analytics.v_product_box_factor b ON b.product_id = p.id AND b.tenant_id = p.tenant_id
     WHERE p.tenant_id = ? AND p.deleted_at IS NULL
       AND p.factor_sale::numeric IS DISTINCT FROM b.box_factor::numeric ${extra}`,
  [T])).rows[0].n;

  const antesTodo = await contar();
  const antesTestigo = await contar(`AND ${CON_TESTIGO}`);
  const antesDefault = await contar(`AND b.source = 'default'`);
  const antesNulos = (await knex.raw(`
    SELECT count(*)::int n FROM catalog.products
     WHERE tenant_id = ? AND deleted_at IS NULL AND factor_sale IS NULL`, [T])).rows[0].n;

  console.log(`  [va3] antes: ${antesTodo} difieren · ${antesTestigo} con testigo`
    + ` · ${antesDefault} sin testigo (NO se tocan) · ${antesNulos} con factor_sale NULL`);

  if (antesTestigo < 1) throw new Error('cero filas con testigo que escribir: revisar la premisa');

  // ── La escritura: SOLO donde el arbitro tiene testigo ──
  const upd = await knex.raw(`
    UPDATE catalog.products p
       SET factor_sale = b.box_factor, updated_at = now()
      FROM analytics.v_product_box_factor b
     WHERE b.product_id = p.id AND b.tenant_id = p.tenant_id
       AND p.tenant_id = ? AND p.deleted_at IS NULL
       AND p.factor_sale::numeric IS DISTINCT FROM b.box_factor::numeric
       AND ${CON_TESTIGO}`, [T]);
  console.log(`  [va3] escritas ${upd.rowCount} filas`);

  // ── Auto-verificación ──────────────────────────────────────────────────────────────────────
  const despuesTestigo = await contar(`AND ${CON_TESTIGO}`);
  const despuesDefault = await contar(`AND b.source = 'default'`);
  const despuesNulos = (await knex.raw(`
    SELECT count(*)::int n FROM catalog.products
     WHERE tenant_id = ? AND deleted_at IS NULL AND factor_sale IS NULL`, [T])).rows[0].n;

  console.log(`  [va3] despues: ${despuesTestigo} con testigo · ${despuesDefault} sin testigo`
    + ` · ${despuesNulos} NULL`);

  // ⭐ PUNTO FIJO: tras escribir, el arbitro no se movio.
  if (despuesTestigo !== 0) {
    throw new Error(`quedan ${despuesTestigo} discrepancias CON TESTIGO despues de escribir: `
      + 'el resolvedor se movio al escribirle, o sea es circular. Abortado');
  }

  // ⭐⭐ PRUEBA NEGATIVA: los SIN testigo tienen que seguir INTACTOS. Si bajaran, se habria
  // escrito un `default` -- convertir "no se" en 1, que es lo que esta migracion existe para NO
  // hacer. Y los NULL sin testigo tienen que seguir siendo NULL.
  if (despuesDefault !== antesDefault) {
    throw new Error(`los SIN TESTIGO pasaron de ${antesDefault} a ${despuesDefault}: `
      + 'se escribio un default y eso convierte "no se" en 1');
  }
  const nulosEsperados = antesNulos - 232; // los 232 con testigo que pasan de NULL a valor
  if (despuesNulos > antesNulos) {
    throw new Error(`aparecieron NULLs nuevos (${antesNulos} -> ${despuesNulos})`);
  }
  console.log(`  [va3] NULL ${antesNulos} -> ${despuesNulos}`
    + ` (esperado ~${nulosEsperados}: solo los que GANARON testigo dejan de ser NULL)`);
  if (despuesNulos < 1000) {
    throw new Error(`quedaron solo ${despuesNulos} NULL: se rellenaron ausencias que no `
      + 'tenian testigo');
  }

  // ⭐ El caso que abrio todo.
  const caso = (await knex.raw(`
    SELECT factor_sale FROM catalog.products
     WHERE tenant_id = ? AND sku = '96504' AND deleted_at IS NULL`, [T])).rows[0];
  console.log(`  [va3] 96504 RUFFLES QUESO 27G: factor_sale = ${caso && caso.factor_sale}`);
  if (!caso || Number(caso.factor_sale) !== 58) {
    throw new Error(`96504 quedo en ${caso && caso.factor_sale} y el arbitro dice 58`);
  }

  // ── El subconjunto EN DISPUTA se declara, no se esconde ───────────────────────────────────
  const disputa = (await knex.raw(`
    SELECT count(*)::int n
      FROM catalog.products p
      JOIN analytics.v_product_box_factor b ON b.product_id = p.id AND b.tenant_id = p.tenant_id
      JOIN analytics.v_supplier_cost_ladder sc ON sc.sku = p.sku
     WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND b.source <> 'default'
       AND sc.units_per_box IS NOT NULL
       AND abs(sc.units_per_box::numeric - b.box_factor::numeric) > 0.6`, [T])).rows[0].n;
  console.log(`  [va3] ⚠️ ${disputa} productos donde lo PAGADO al proveedor contradice al arbitro`);
  console.log('  [va3]    se escribieron igual (excluirlos recrearia dos verdades) y quedan');
  console.log('  [va3]    declarados en analytics.declared_gaps');

  await knex('analytics.declared_gaps')
    .insert({
      tenant_id: T,
      clave: 'factor_caja_arbitro_vs_pagado',
      titulo: 'Productos donde el factor arbitrado contradice a lo pagado al proveedor',
      monto: disputa,
      unidad: 'productos',
      declarado_en: '2026-09-11',
      motivo: 'VA.3 escribio catalog.products.factor_sale con el valor de '
        + 'analytics.v_product_box_factor en las 854 filas con testigo. En ' + disputa + ' de '
        + 'ellas el testigo INDEPENDIENTE (units_per_box de v_supplier_cost_ladder, o sea lo que '
        + 'se le pago al proveedor) dice otra cosa. Se escribieron igual: excluirlas habria '
        + 'recreado dos verdades, que es el defecto que VA.3 vino a eliminar.',
      resolver_faltante: 'un desempate entre el ERP y la factura del proveedor para esos SKU. '
        + 'Hoy no hay tercer testigo: el precio no vota (ADR-059 R2).',
      estado: 'abierto',
      recheck_sql: `
        SELECT (count(*) > 0) AS sigue_siendo_hueco,
               count(*) || ' productos con el arbitro contradicho por lo pagado' AS detalle
          FROM catalog.products p
          JOIN analytics.v_product_box_factor b
            ON b.product_id = p.id AND b.tenant_id = p.tenant_id
          JOIN analytics.v_supplier_cost_ladder sc ON sc.sku = p.sku
         WHERE p.tenant_id = '${T}' AND p.deleted_at IS NULL AND b.source <> 'default'
           AND sc.units_per_box IS NOT NULL
           AND abs(sc.units_per_box::numeric - b.box_factor::numeric) > 0.6`,
      ultima_medicion: knex.fn.now(),
      ultimo_detalle: `${disputa} productos con el arbitro contradicho por lo pagado`,
    })
    .onConflict(['tenant_id', 'clave'])
    .merge(['titulo', 'monto', 'unidad', 'motivo', 'resolver_faltante', 'recheck_sql',
      'estado', 'ultima_medicion', 'ultimo_detalle']);
};

exports.down = async function down() {
  // ⛔ No se revierte: volver atras seria restaurar 854 valores que el arbitro contradice, y no
  // hay copia de los valores viejos (a proposito -- guardarla seria otra segunda verdad).
  // Si hiciera falta, se recalculan desde los importers que los escribieron.
};
