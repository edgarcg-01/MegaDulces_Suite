/**
 * KX.4 — UN OVERRIDE DE `1` NO PUEDE TAPAR AL ERP.
 *
 * Pedido de Edgar (2026-09-10): *"nada de corregir desde ui. debemos tener una verdad absoluta.
 * un 100% de que lo que decimos es real"*.
 *
 * ── Por qué NO se corrigen a mano ────────────────────────────────────────────────────────────
 *
 * El diagnóstico de KX.2 dejó 41 pares donde el ERP vendió una unidad MAYOR que la caja que
 * publicamos — imposible. La salida fácil era editar esas filas desde la pantalla de overrides.
 * Edgar la rechazó, y tiene razón por una razón medida: **el override manual es la fuente que el
 * ERP contradice 146× más seguido que la etiquetera** (2.92% contra 0.02%; ADR-057 ya lo había
 * medido contra el testigo de PAGO, y KX.2 lo confirmó contra el peldaño COBRADO). Corregir a
 * mano el dato de la fuente que más se equivoca a mano **reproduce el problema en la próxima
 * captura**. Lo que hay que arreglar es la PRECEDENCIA.
 *
 * ── Lo que estaba mal en la precedencia ──────────────────────────────────────────────────────
 *
 * `box_factor` se resolvía como `GREATEST(COALESCE(ovr, <cadena>), 1)`: el override gana SIEMPRE
 * y nada lo puede desplazar, ni la evidencia del propio ERP.
 *
 * Y el caso concreto: **un override de `1`**. Ese valor significa *"este producto no viene en
 * caja"*, que es exactamente lo mismo que el `default`. O sea **no aporta información**: un `1`
 * escrito a mano casi nunca es una afirmación, es un "no sé" — y al ganarle a la cadena **borra
 * evidencia del ERP**.
 *
 * ── La medición que define la regla (prod, 2026-09-10) ───────────────────────────────────────
 *
 *     overrides activos ....................... 278
 *       con valor > 1 (afirmaciones reales) ... 262   <- NO se tocan
 *       con valor = 1 ..........................  16
 *         y el ERP (c84) dice > 1 ..............  12   <- un no-dato tapando evidencia
 *
 * ⭐ Y el cierre que hace que esto alcance: **los 12 son EXACTAMENTE los mismos 12 productos que
 * el peldaño vendido (`kdm2.c58`) contradice.** Se midió por separado y coinciden uno a uno. O
 * sea esta regla —que cuesta CERO, porque no lee `kdm2`— cierra el 100% del caso del override.
 * Meter el peldaño observado a la vista costaba 29.5 s de agregación sobre 4M renglones y no
 * habría encontrado ni un caso más.
 *
 * Los 12, con el número en su propio nombre (todos granel por kilo):
 *
 *     95436 CHOC SUPER SPORTS GRANEL PALMER 10.89K   ovr 1  ->  c84 27
 *     94084 PAPEL ENVOLTURA NOGAL 25KG / DAMEX       ovr 1  ->  c84 25
 *     94203 CUCHARA GRANDE 6 KG REYHER               ovr 1  ->  c84 24
 *     89122 MAIZ PALOMERO CAMINO DE SANTIAGO GRANEL  ovr 1  ->  c84 20
 *     83742 PASTA B. 11 X 11 GUSTINOS / 20KG         ovr 1  ->  c84 20
 *     20555 CAR SURTIDO 18KG COLOMBINA               ovr 1  ->  c84 18
 *     70140 LA ROSA CONFICHOCKY GRANEL 9KG           ovr 1  ->  c84 18
 *     70006 SURTIDO CARAMELO Y PAL 18KG LA ROSA      ovr 1  ->  c84 18
 *     70043 GOMA A GRANEL LA ROSA 12KG               ovr 1  ->  c84 12
 *     14053 GRANILLO MULTICOLOR ECO 5K               ovr 1  ->  c84 10
 *     30540 ALMENDRA CONFITADA 10 KG / PROVIDENCIA   ovr 1  ->  c84 10
 *     44227 GALL ANIMALITOS 5KG MARIBEL / 1          ovr 1  ->  c84  5
 *
 * ── Efecto medido en la cifra que se muestra ─────────────────────────────────────────────────
 *
 *     existencia afectada .... 76 celdas · 18,005 unidades
 *     cajas mostradas HOY .... 18,005   (bf = 1, o sea las unidades sin dividir)
 *     cajas con el ERP .......  2,091
 *
 * O sea la pantalla sobredeclaraba **8.6×** las cajas de esos productos. ⚠️ Es un divisor de
 * PRESENTACIÓN: el dato base NO se convierte (ADR-055 — ya se intentó y rompió el pedido).
 *
 * ── Y lo que la regla NO hace, dicho ────────────────────────────────────────────────────────
 *
 * Quedan **10 pares** que el peldaño contradice y NO son override: 6 de `kepler_c84`, 2 de
 * `default` y 2 de `etiquetera` (el ERP vendió un peldaño mayor que su propio catálogo, lo que
 * puede ser una tarima legítima). Esos **se declaran** y los sigue contando el candado; no se
 * tocan sin un testigo que diga cuál miente.
 *
 * ⚠️ El descarte NO es silencioso: `source` pasa a `'override_no_dato'`, así que un override
 * tumbado se puede ver y contar. Borrarlo en silencio sería cambiar una mentira por otra.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` sólo admite agregar columnas al final, y **hay que re-aplicar el
 * `GRANT`** (lección U.7). Esta vista no tiene `security_invoker` hoy — no se le agrega acá
 * para no cambiar dos cosas en la misma migración.
 *
 * @param { import("knex").Knex } knex
 */

// La cadena SIN el override, para poder preguntar si el override tapa algo.
const CADENA = `GREATEST(COALESCE(c84,1), COALESCE(etiq,1), COALESCE(fs,1))`;

// ⭐ EL GUARD. Un override cuenta salvo que sea un `1` con evidencia del ERP por encima.
const OVR = `CASE WHEN ovr IS NOT NULL AND NOT (ovr = 1 AND ${CADENA} > 1) THEN ovr END`;
const OVR_TUMBADO = `(ovr IS NOT NULL AND ovr = 1 AND ${CADENA} > 1)`;

const SQL = `
CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
WITH ladder AS (
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
         CASE WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$' THEN upper(l.u_base) END AS unit_base
    FROM catalog.products p
    LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
                 FROM commercial.product_label_prices
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
         -- KX.4: el override entra por ${'OVR'}, no por COALESCE(ovr, ...) directo.
         GREATEST(COALESCE(${OVR},
           CASE WHEN inner_ok AND c84 >= 3 * fs THEN fs
                WHEN c84  > 1 THEN c84
                WHEN etiq > 1 THEN etiq
                WHEN fs   > 1 THEN fs
                ELSE 1 END), 1) AS box_factor,
         -- El override tumbado se DECLARA con su propia etiqueta: si desapareciera dentro de
         -- kepler_c84, nadie podria contar cuantas ediciones manuales estamos ignorando.
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

exports.up = async function up(knex) {
  const antes = (await knex.raw(
    `SELECT count(*) FILTER (WHERE source = 'override')::int ovr,
            count(*) FILTER (WHERE source = 'override_no_dato')::int tumbados
       FROM analytics.v_product_box_factor`)).rows[0];

  await knex.raw(SQL);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);

  const despues = (await knex.raw(
    `SELECT count(*) FILTER (WHERE source = 'override')::int ovr,
            count(*) FILTER (WHERE source = 'override_no_dato')::int tumbados,
            count(*) FILTER (WHERE source = 'override_no_dato' AND box_factor > 1)::int recuperados
       FROM analytics.v_product_box_factor`)).rows[0];

  console.log(`  [box-factor] override: ${antes.ovr} -> ${despues.ovr}`
    + ` · tumbados por no-dato: ${despues.tumbados} (de los cuales ${despues.recuperados} ya publican el factor del ERP)`);

  // ── Auto-verificación: la regla tiene que MORDER y tiene que morder POCO ──
  if (despues.tumbados < 1) {
    throw new Error('override_no_dato = 0: el guard no encontró nada, o el override dejó de llegar');
  }
  if (despues.tumbados > 40) {
    throw new Error(`override_no_dato = ${despues.tumbados}: son muchos más que los 12 medidos — revisar antes de seguir`);
  }
  if (despues.recuperados !== despues.tumbados) {
    throw new Error(`${despues.tumbados - despues.recuperados} tumbados siguen publicando 1: el guard descartó sin recuperar nada`);
  }
  // Y los overrides legítimos NO se tocan.
  if (despues.ovr !== antes.ovr - despues.tumbados) {
    throw new Error(`el conteo de overrides no cuadra: ${antes.ovr} -> ${despues.ovr} con ${despues.tumbados} tumbados`);
  }
};

exports.down = async function down() {
  // No se restaura: la version anterior dejaba que un no-dato tapara al ERP.
};
