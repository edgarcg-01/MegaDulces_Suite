/**
 * VA.6 — NORM.3 REVIRTIÓ EN SILENCIO EL GUARD DE KX.4. Se restaura.
 *
 * Edgar, 2026-09-12: *"hay que corregir todo aquello que no va con el protocolo documentado y la
 * verdad absoluta que encontramos aquí"*.
 *
 * ── Cómo apareció ───────────────────────────────────────────────────────────────────────────
 *
 * Las cuatro migraciones de NORM.3 (commit `45793e1e`, 2026-09-11) nunca se aplicaron a prod, pero
 * su CÓDIGO sí se desplegó al contenedor de feeds. Resultado: `import-sales-fact`,
 * `import-replenishment-plan` e `import-label-data` fallaban en cinco carriles con
 * `relation "commercial.v_product_label_prices" does not exist`, y el hecho de ventas llevaba
 * ~1 h sin escribirse.
 *
 * Al aplicar las tres migraciones de VISTA (batch 407) con un antes/después, la cifra se movió:
 *
 * ```text
 *   analytics.v_product_box_factor
 *     antes  ... 11,239 filas · suma 314,122
 *     despues .. 11,239 filas · suma 313,888     <- -234, mismas filas
 * ```
 *
 * El etiquetero no era: la vista consolidada devuelve EXACTAMENTE lo que devolvía el `MAX()` sobre
 * la tabla (0 de 9,041 productos difieren, verificado). La causa es otra: **NORM.3 se escribió
 * sobre una copia ANTERIOR de la definición y, al reemplazarla entera, borró el guard de KX.4**
 * (`20260910120000_box_factor_override_no_tapa_al_erp.js`, batch 360, del día anterior).
 *
 * ── Qué borró exactamente ───────────────────────────────────────────────────────────────────
 *
 * KX.4 estableció que **un override de `1` no puede tapar al ERP**: un `1` escrito a mano casi
 * nunca es una afirmación, es un "no sé", y al ganarle a la cadena borra evidencia. Y midió que el
 * override manual es la fuente que el ERP contradice **146× más seguido** que la etiquetera
 * (2.92% contra 0.02%).
 *
 * NORM.3 volvió a `COALESCE(ovr, ...)` —el override gana siempre— y se llevó también la etiqueta
 * `override_no_dato`, que era justo la que permitía CONTAR cuántas ediciones manuales se están
 * ignorando. Sin ella el hecho desaparece del veredicto: no se puede declarar lo que no se nombra.
 *
 * ── La lección, que es de proceso y no de SQL ───────────────────────────────────────────────
 *
 * ⚠️ **Un `CREATE OR REPLACE VIEW` escrito a partir de una copia pegada es un revert silencioso.**
 * No hay conflicto de merge que avise: el archivo nuevo compila, la migración corre verde y la
 * regla del día anterior desaparece sin dejar rastro. Lo único que lo atrapó fue **medir la misma
 * cifra antes y después** — el guard de KX.4 no tenía candado propio que se pusiera rojo.
 *
 * Por eso esta migración no sólo restaura: deja la aserción de que el guard EXISTE, con prueba
 * negativa (si `override_no_dato` cayera a cero sin que se hayan corregido los overrides, es que
 * alguien volvió a borrarlo).
 *
 * @param { import("knex").Knex } knex
 */

// La cadena SIN el override, para poder preguntar si el override tapa algo. (KX.4, verbatim.)
const CADENA = `GREATEST(COALESCE(c84,1), COALESCE(etiq,1), COALESCE(fs,1))`;

// EL GUARD. Un override cuenta salvo que sea un 1 con evidencia del ERP por encima.
const OVR = `CASE WHEN ovr IS NOT NULL AND NOT (ovr = 1 AND ${CADENA} > 1) THEN ovr END`;
const OVR_TUMBADO = `(ovr IS NOT NULL AND ovr = 1 AND ${CADENA} > 1)`;

// Cuerpo de NORM.3 (lee la vista consolidada) + el guard de KX.4. Los dos cambios, no uno.
// Sin acentos graves adentro: esto es un template literal de JS.
const SQL = `
CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
WITH ladder AS (
  -- La escalera del ERP. Excluye CEDIS 00 (trae valuacion de prueba) y consolida con MAX:
  -- c84 es estable entre sucursales (3 de 2,419 = 0.12%).
  SELECT c1 AS sku,
         MAX(NULLIF(btrim(c11), '')) AS u_base,
         MAX(c81)                    AS f_paq,
         MAX(c84)                    AS f_caja
    FROM kepler_ods.kdii
   WHERE sucursal <> '00'
   GROUP BY c1
), src AS (
  SELECT p.tenant_id, p.id AS product_id,
         COALESCE(p.factor_sale, 1)::numeric AS fs,
         lbl.bs::numeric                     AS etiq,
         kbf.box_factor::numeric             AS c84,
         uov.box_factor::numeric             AS ovr,
         -- Unidad base real del ERP. Los valores que son CANTIDADES y no unidades
         -- (500, 250, 400, 2KG) se anulan: es mas honesto no saber la unidad que
         -- afirmar una que no existe.
         CASE WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$' THEN upper(l.u_base) END AS unit_base
    FROM catalog.products p
    -- [NORM.3] LA vista consolidada, no la tabla: la tabla tiene grano por sucursal y este
    -- MAX() tomaria el mayor de ocho plazas.
    LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
                 FROM commercial.v_product_label_prices
                GROUP BY tenant_id, product_id) lbl
           ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
    LEFT JOIN analytics.product_box_factor kbf
           ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
    LEFT JOIN commercial.product_unit_overrides uov
           ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
    LEFT JOIN ladder l ON l.sku = p.sku
   WHERE p.deleted_at IS NULL
), r AS (
  SELECT src.*,
         src.fs > 1 AND src.etiq > 1 AND src.fs = src.etiq AS inner_ok,
         GREATEST(CASE WHEN src.fs   > 1 THEN src.fs   ELSE 1 END,
                  CASE WHEN src.etiq > 1 THEN src.etiq ELSE 1 END) AS inner_box,
         src.unit_base IN ('KG', 'KGS') AS is_weight
    FROM src
), resolved AS (
  SELECT r.*,
         -- [KX.4] El override entra por el GUARD, no por COALESCE(ovr, ...) directo.
         GREATEST(COALESCE(${OVR},
           CASE WHEN inner_ok AND c84 >= 3 * fs THEN fs
                WHEN c84  > 1 THEN c84
                WHEN etiq > 1 THEN etiq
                WHEN fs   > 1 THEN fs
                ELSE 1 END), 1) AS box_factor,
         -- [KX.4] El override tumbado se DECLARA con su propia etiqueta: si desapareciera dentro
         -- de kepler_c84, nadie podria contar cuantas ediciones manuales estamos ignorando.
         CASE WHEN ${OVR_TUMBADO} THEN 'override_no_dato'
              WHEN ovr IS NOT NULL THEN 'override'
              WHEN inner_ok AND c84 >= 3 * fs THEN 'inner_box_guard'
              WHEN c84  > 1 THEN 'kepler_c84'
              WHEN etiq > 1 THEN 'etiquetera'
              WHEN fs   > 1 THEN 'factor_sale'
              ELSE 'default' END AS source
    FROM r
)
SELECT tenant_id, product_id,
       COALESCE(
         (c84 > 1 AND inner_box > 1 AND c84 >= 3 * inner_box)
         OR (is_weight AND box_factor > 1)
         OR box_factor > 1000
         OR (source = 'factor_sale' AND box_factor > 1)
       , FALSE) AS is_master_suspect,
       box_factor, source,
       unit_base, is_weight,
       CASE WHEN source IN ('factor_sale', 'inner_box_guard') THEN 'ambiguous'
            WHEN box_factor > 1 THEN 'pieces'
            ELSE 'n/a' END AS factor_unit
  FROM resolved`;

const FOTO = `
  SELECT count(*)::int filas,
         round(sum(box_factor)::numeric, 2) AS suma,
         count(*) FILTER (WHERE source = 'override')::int         AS ovr,
         count(*) FILTER (WHERE source = 'override_no_dato')::int AS tumbados
    FROM analytics.v_product_box_factor`;

exports.up = async function up(knex) {
  const antes = (await knex.raw(FOTO)).rows[0];
  console.log(`  [va6] ANTES   filas ${antes.filas} · suma ${antes.suma}`
    + ` · override ${antes.ovr} · override_no_dato ${antes.tumbados}`);

  await knex.raw(SQL);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);

  const despues = (await knex.raw(FOTO)).rows[0];
  console.log(`  [va6] DESPUES filas ${despues.filas} · suma ${despues.suma}`
    + ` · override ${despues.ovr} · override_no_dato ${despues.tumbados}`);

  if (Number(antes.filas) !== Number(despues.filas)) {
    throw new Error(`el numero de filas cambio (${antes.filas} -> ${despues.filas}): esta migracion `
      + 'solo restaura una PRECEDENCIA, el universo de productos no se toca');
  }

  // PRUEBA NEGATIVA — el guard tiene que estar HACIENDO algo. Si `override_no_dato` sale en cero
  // sin que nadie haya corregido los overrides de 1, es que el guard volvio a desaparecer: es
  // exactamente el sintoma que esta migracion existe para que no vuelva a pasar en silencio.
  if (Number(despues.tumbados) < 1) {
    throw new Error('CERO overrides tumbados: el guard de KX.4 no esta discriminando nada. O los '
      + 'overrides de 1 ya se corrigieron en la fuente (verificar en commercial.product_unit_overrides) '
      + 'o el CASE volvio a quedar sin el guard');
  }
  if (Number(despues.suma) <= Number(antes.suma)) {
    throw new Error(`la suma no subio (${antes.suma} -> ${despues.suma}): restaurar el guard tiene `
      + 'que DEVOLVER el factor del ERP a los productos cuyo override de 1 lo estaba tapando');
  }
  console.log(`  [va6] guard restaurado: ${despues.tumbados} overrides de 1 vuelven a NO tapar al ERP`
    + ` · la suma sube ${(Number(despues.suma) - Number(antes.suma)).toFixed(2)}`);
};

exports.down = async function down(knex) {
  // No hay vuelta atras util: volver a la version sin guard es reintroducir el defecto de KX.4.
  // Se deja explicito en vez de un no-op silencioso.
  throw new Error('sin down: revertir esta migracion es reintroducir el defecto KX.4 (un override '
    + 'de 1 tapando la evidencia del ERP). Si hace falta, escribir la migracion inversa a mano.');
};
