/**
 * `analytics.v_erp_stock_truth` — LA VERDAD DE LA EXISTENCIA DE KEPLER, con testigo propio.
 *
 * Pedido de Edgar: *"necesitamos verdad absoluta de existencia, ventas y unidades"* ·
 * *"solo hay que enfocarnos en kepler"*.
 *
 * ── Lo que ya era verdad, y no hay que tocar ────────────────────────────────────────────────
 *
 * La CANTIDAD de la existencia de Kepler ya cierra. Medido contra prod el 2026-09-08:
 *   - la fuente `analytics.v_erp_stock_on_hand` acierta **100%** contra el POS en vivo
 *     (22,090 SKUs; la tabla `commercial.stock` acierta 91.0% — por eso la vista manda);
 *   - la identidad `entradas - salidas = qty` cuadra en **20,681 de 22,426 (92.22%)** y las
 *     **1,748** restantes son EXACTAMENTE los renglones con saldo negativo que la vista recorta
 *     a cero por diseño: **SIN EXPLICAR = 0 en las seis sucursales**;
 *   - el `baseline = 0` del dictamen es correcto: `kdil.c4` es 0 en el **100%** de las filas;
 *   - y la sucursal `00` de Kepler, que deriva **122,096,465** unidades fantasma (dos órdenes de
 *     magnitud sobre cualquier otra), ya está excluida por `w.kepler_code <> '00'`.
 *
 * ── Lo que NO era verdad: el VALOR ⭐ ───────────────────────────────────────────────────────
 *
 * La existencia se valúa con `catalog.products` — un costo por PRODUCTO, global, en la unidad en
 * que el catálogo lo tenga. Y Kepler trae SU costo unitario **por sucursal × SKU**, o sea al mismo
 * grano que la cantidad: `kdik.c16`. Nadie lo había usado para esto. Está poblado en el 99.84% de
 * las filas con existencia.
 *
 * Contrastados (16,391 filas comparables, prod, 2026-09-08):
 *
 *     mediana cost_base     / kdik.c16 = 1.0000   pega +-2% en 11,877 (72.46%)
 *     mediana cost_with_tax / kdik.c16 = 1.0800   pega +-2% en  3,230 (19.71%)
 *
 * O sea: **`cost_base` ES el costo de Kepler** — y el dictamen valúa con
 * `COALESCE(cost_with_tax, cost_base)`, es decir **con impuesto**.
 *
 * Y debajo del impuesto hay algo peor. Con la mediana en 1.0000 exacto, el agregado difiere 13.3%
 * — o sea la discrepancia está CONCENTRADA, no repartida:
 *
 *     clase                              filas   valor catalogo   valor Kepler        brecha   mediana
 *     coincide (+-2%)                   11,894      $28,552,088    $28,550,530        $1,558    1.0000
 *     difiere <50% (precio, no unidad)   4,246       $7,982,338     $7,991,263       -$8,925    0.9775
 *     catalogo MAYOR por un factor         186       $5,541,904       $513,149    $5,028,755    9.3372
 *     catalogo menor por un factor          83          $35,121       $125,518      -$90,397    0.4659
 *
 * **186 renglones cargan $5,028,755 de sobrevaluación.** Y las razones los delatan: 16.2 · 21.6 ·
 * 20.0 · 14.0 · **32.0** · 31.4 · 10.8 · 3.3 — son factores de caja, no diferencias de precio. Los
 * nombres cierran el caso: ROLLO GUAYABA CHICO GRANEL · CHOC HERSHEY BARRA GRANEL 14KG · TURIN
 * CONF SEMIAMARGO 16KG · ALTENO CAR SURTIDO GRANEL / 5KG. `cost_base` viene por BULTO; `c16` por
 * pieza o por kilo. Es ADR-051 (el costo del catálogo viene por caja) y ADR-055 (la unidad no se
 * hereda de su fuente), medidos por primera vez sobre la VALUACIÓN del inventario y con el propio
 * costo de Kepler como árbitro.
 *
 * ── Las reglas de esta vista ────────────────────────────────────────────────────────────────
 *
 *  1. **El costo sale del MISMO ERP y del MISMO almacén que la cantidad.** Ésa es la lección: un
 *     costo por producto no puede valuar una cantidad por almacén sin declarar en qué unidad está.
 *  2. **ANTI-RÉPLICA obligatorio en `kdik`**: 3,667 de 31,084 filas traen `c1 <> sucursal` (el
 *     costo de OTRA sucursal). Sin el filtro, el testigo mezcla almacenes. (Verificado: cero pares
 *     duplicados por (sucursal, almacén, SKU), así que el `max()` no elige entre rivales.)
 *  3. **`valor_arbitrado` es NULL sin testigo — nunca un relleno** (ADR-056). Y el veredicto
 *     distingue las DOS ausencias: `sin_testigo` (Kepler no da costo) de `sin_costo_catalogo`
 *     (el catálogo no lo da). Una fila ausente en un LEFT JOIN llega NULL y se lee como sana.
 *  4. **NO se elige el costo bueno acá.** La vista devuelve los dos, su razón y su veredicto. Quién
 *     valúa la pantalla es una decisión aparte, con su antes/después.
 *
 * ⚠️ `kdik.c16` está limpio: en el ODS es `double precision` y **las 31,084 filas son numéricas**. Lo
 * que parecía basura (`4.1667e-06`) es notación científica válida — el `[^0-9.-]` con el que la medí
 * la primera vez le quitaba la `e` y producía `4.1667-06`, que sí revienta el cast. El error era
 * mío, no de Kepler.
 *
 * ⛔ Y el guard de esa columna NO puede ser un regex — ver la nota sobre knex y los `?` junto a la
 * constante `C16`. Fue el segundo error silencioso de esta misma migración.
 *
 * ⚠️ Y la columna del ERP en `v_erp_stock_on_hand` se llama **`source = 'kepler_ods'`**, NO
 * `'kepler'` — eso es `unit_source`. Filtrar por el valor equivocado devuelve CERO filas en
 * silencio; lo cazó la auto-verificación de esta migración al primer intento.
 *
 * ⚠️ Tras `CREATE OR REPLACE VIEW` hay que re-aplicar `security_invoker` y el `GRANT`: no se
 * heredan (lección U.7).
 *
 * @param { import("knex").Knex } knex
 */

// ⛔ ACÁ NO VA UN REGEX, Y LA RAZÓN IMPORTA. El primer intento guardaba `c16` con un guard de texto
// `~ '^-?[0-9]+(\.[0-9]+)?...'`. Knex tomó **cada `?` como placeholder de binding** y Postgres
// terminó almacenando `'^-$1[0-9]+(\.[0-9]+)$2([eE][+-]$3[0-9]+)$4$'`. El repo ya tiene anotado que
// un `?` en un `raw` da 42P18 — pero acá NO falló: corrompió el regex en silencio, no matcheó nada,
// y la vista devolvió `sin_testigo` en las 16,453 filas. Es decir: se leía como "Kepler no tiene
// costo". Lo cazó la auto-verificación de esta migración, no una pantalla.
//
// `kdik.c16` ya es `double precision` en el ODS, así que el guard correcto es de VALOR, no de texto:
// `c16 = c16` es falso sólo para NaN, y las cotas excluyen los infinitos (los tres revientan el
// cast a numeric). Sin `?`, sin regex, sin nada que knex pueda reinterpretar.
const C16 = `CASE WHEN k.c16 = k.c16
                   AND k.c16 > '-Infinity'::float8
                   AND k.c16 < 'Infinity'::float8
              THEN k.c16::numeric END`;

const SQL = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_truth AS
WITH kk AS (
  -- El costo unitario PROPIO de Kepler, al grano sucursal x SKU (el mismo de la cantidad).
  -- c1 = almacen, c2 = SKU, c16 = costo unitario promedio. Verificado: c8/c5 = c16.
  -- ANTI-REPLICA: 3,667 de 31,084 filas traen c1 distinto de sucursal.
  SELECT k.sucursal                AS suc,
         btrim(k.c2::text)         AS sku,
         max(${C16})               AS costo_kepler
    FROM kepler_ods.kdik k
   WHERE k.sucursal = btrim(k.c1::text)
   GROUP BY 1, 2
)
SELECT s.tenant_id,
       s.warehouse_id,
       s.warehouse_code,
       w.kepler_code,
       s.product_id,
       s.sku,
       p.nombre,
       s.qty_stock_units                                   AS qty,
       kk.costo_kepler,
       p.cost_base                                         AS costo_catalogo,
       COALESCE(p.cost_with_tax, p.cost_base)              AS costo_publicado_hoy,
       CASE WHEN COALESCE(kk.costo_kepler, 0) > 0 AND COALESCE(p.cost_base, 0) > 0
            THEN round(p.cost_base / kk.costo_kepler, 4) END AS razon,
       -- EL VEREDICTO. Una sola pregunta: como se compara el costo del catalogo con el de Kepler.
       -- Las dos AUSENCIAS van primero y separadas: no son lo mismo y no se pueden confundir.
       CASE
         WHEN COALESCE(kk.costo_kepler, 0) <= 0                      THEN 'sin_testigo'
         WHEN COALESCE(p.cost_base, 0)     <= 0                      THEN 'sin_costo_catalogo'
         WHEN abs(p.cost_base / kk.costo_kepler - 1) <= 0.02         THEN 'confirmado'
         WHEN p.cost_base / kk.costo_kepler >= 1.5                   THEN 'contradicho_por_factor'
         WHEN p.cost_base / kk.costo_kepler <= 0.667                 THEN 'contradicho_por_factor'
         ELSE                                                             'precio_movido'
       END                                                 AS veredicto,
       -- El factor que el catalogo parece traer de mas (o de menos). Solo donde contradice:
       -- ponerlo siempre invitaria a usarlo como divisor universal.
       CASE
         WHEN COALESCE(kk.costo_kepler, 0) > 0 AND COALESCE(p.cost_base, 0) > 0
          AND (p.cost_base / kk.costo_kepler >= 1.5 OR p.cost_base / kk.costo_kepler <= 0.667)
         THEN round(p.cost_base / kk.costo_kepler, 2)
       END                                                 AS factor_aparente,
       -- VALOR ARBITRADO: la cantidad de Kepler por el costo de Kepler. NULL sin testigo.
       CASE WHEN COALESCE(kk.costo_kepler, 0) > 0
            THEN round(s.qty_stock_units * kk.costo_kepler, 2) END AS valor_arbitrado,
       -- VALOR PUBLICADO HOY: lo que el dictamen usa, con impuesto incluido. Para el antes/despues.
       round(s.qty_stock_units * COALESCE(p.cost_with_tax, p.cost_base, 0), 2) AS valor_publicado_hoy,
       CASE WHEN COALESCE(kk.costo_kepler, 0) > 0
            THEN round(s.qty_stock_units * COALESCE(p.cost_with_tax, p.cost_base, 0)
                     - s.qty_stock_units * kk.costo_kepler, 2) END AS brecha
  FROM analytics.v_erp_stock_on_hand s
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.id = s.product_id
  LEFT JOIN kk
    ON kk.suc = w.kepler_code AND kk.sku = s.sku
 WHERE s.source = 'kepler_ods'
`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  // No se heredan tras CREATE OR REPLACE (leccion U.7).
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_truth SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_truth TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_stock_truth IS
    'Existencia de Kepler con su propio costo por sucursal x SKU (kdik.c16) como testigo. Devuelve los DOS costos y el veredicto; no elige. valor_arbitrado es NULL sin testigo.'`);

  // ── Auto-verificacion: la vista tiene que reproducir lo MEDIDO, o la migracion falla ──
  const meta = await knex.raw(
    `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname='v_erp_stock_truth'`);
  const opts = (meta.rows[0] || {}).reloptions || [];
  if (!opts.some((o) => String(o).includes('security_invoker'))) {
    throw new Error('v_erp_stock_truth perdio security_invoker');
  }

  const r = (await knex.raw(
    `SELECT veredicto, count(*)::bigint filas,
            sum(valor_publicado_hoy)::numeric pub,
            sum(valor_arbitrado)::numeric arb
       FROM analytics.v_erp_stock_truth
      WHERE qty > 0
      GROUP BY 1 ORDER BY 1`)).rows;
  const by = Object.fromEntries(r.map((x) => [x.veredicto, x]));
  const conf = Number((by.confirmado || {}).filas || 0);
  const contra = Number((by.contradicho_por_factor || {}).filas || 0);
  // Pisos deliberadamente holgados: son candados contra que la vista se quede MUDA, no
  // asserts sobre cifras del dia. El candado fino vive en test-newdb-stock-truth.js.
  if (conf < 5000) throw new Error(`confirmado=${conf}: la vista no esta encontrando el testigo`);
  if (contra < 1) throw new Error('contradicho_por_factor=0: un arbitro que nunca contradice es un espejo');
  console.log('  [stock-truth] veredicto:');
  for (const x of r) {
    console.log(`    ${String(x.veredicto).padEnd(24)} ${Number(x.filas).toLocaleString('en-US')} filas`
      + ` · publicado $${Number(x.pub || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      + ` · arbitrado $${Number(x.arb || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_stock_truth`);
};
