'use strict';
/**
 * `[MX.0.5]` — **Existencia en negativo: las vistas que la detectan y la tabla donde Prevención la resuelve.**
 *
 * Pedido de Edgar (2026-11-03), a partir del producto 17210 (GREENPACK ROLLO ALTA 60X90) en Zamora
 * Centro: «hay que hacer un apartado para avisar a prevención todos estos incidentes de existencias
 * en negativo». Hoy nadie se entera: `analytics.v_erp_stock_on_hand` recorta el negativo a 0
 * (`GREATEST(…, 0)`), así que la pantalla de Existencia dibuja un CERO donde Kepler tiene −260.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-03) ────────────────────────────────────────
 *  · 3,037 producto×sucursal en negativo en `kepler_ods.kdil` (`c4 + c8 − c9`, la fórmula de Kepler):
 *    1,450 con movimiento en 30 días ($1.56 M a costo estándar) y 1,587 sin movimiento ($0.47 M).
 *  · 17210 en 05: entradas 3,727.5 − salidas 3,987.5 = −260; la suma de `kdm2` de los documentos que
 *    afectan inventario (`kdmm.c8 = 'S'`) da EXACTO lo mismo → el negativo es de Kepler, no del ODS.
 *  · Sólo 14–20 de ~3,030 negativos (crece en el día: es vivo) tienen un vale de entrada (X-A-37) de
 *    los últimos 60 días SIN su orden de entrada (X-A-40, la única que suma inventario). 17210 es uno:
 *    OC 54-4087, vale 0000251 del 1-nov, 600 piezas. Los demás se vendieron sin existencia
 *    registrada. Dos implementaciones (anti-join y EXCEPT) dieron los mismos 14.
 *
 * ── Por qué DOS vistas y no una (medido) ───────────────────────────────────────────────────
 *  Juntas en una sola consulta, el planeador cambia de plan con cada cruce que se agrega y cae en
 *  ciclos anidados sobre `kdm2` (6 M renglones) porque estima 1–2 filas donde hay miles:
 *    NOT EXISTS entre renglones ........................ 16 s
 *    EXCEPT, sin cruzar almacén/producto ............... ~450 ms
 *    EXCEPT + almacén + producto + vale ................ > 60 s (cancelada)
 *    lo mismo con CTE MATERIALIZED ..................... ~820 ms (EXPLAIN: 711 ms)
 *    + acotar el EXCEPT a los SKU negativos (IN) ....... > 60 s (cancelada)
 *  Separadas, cada una tiene un plan estable y el servicio las lee EN PARALELO y las cruza en Node
 *  (el mismo remedio que PQ: «traer las tres y cruzar en Node»).
 *  ⛔ No «unificarlas» ni volver a NOT EXISTS sin repetir esta tabla de tiempos.
 *
 * ── `analytics.v_kepler_negative_stock` (derivada, sin copia) ───────────────────────────────
 *  · MISMA fórmula y mismos filtros que `v_erp_stock_on_hand` (sucursal = c1, sin 00001/00002/00022)
 *    pero SIN recortar a 0: la paridad con Kepler es la regla (feedback «misma fórmula que Kepler»).
 *  · No aplica el filtro de corte del CEDIS: un negativo viejo se publica y la pantalla lo rotula
 *    «rezago» por su última actividad (`ult_entrada`/`ult_salida`), no lo esconde.
 *  · El costo NO va aquí: el servicio lo lee de `mv_kepler_unit_cost` (el mismo primitivo que la
 *    pantalla de Existencia); una segunda implementación del costo divergiría.
 *  · `product_id` puede ser NULL (SKU de Kepler sin ficha en el catálogo): se publica igual.
 *
 * ── `analytics.v_kepler_unapplied_receipts` (derivada, sin copia) ───────────────────────────
 *  Renglones de vale de entrada (X-A-37, 60 días) que ninguna orden de entrada (X-A-40, 90 días)
 *  aplicó, sumados por sucursal × SKU. La orden apunta a su vale por `c19/c20/c22` = 'A' / 37 /
 *  folio del vale. Es la ÚNICA causa de un negativo que el dato prueba; el resto no se adivina.
 *
 * ── La tabla `commercial.negative_stock_reviews` (dato propio, HITL) ─────────────────────────
 *  Lo que decide la persona: motivo, nota, quién y cuándo, y la existencia que vio al resolver. Una
 *  fila viva por (sucursal, SKU); reabrir = `deleted_at` (queda la historia). Sin CHECK de motivo: el
 *  catálogo vive en `@megadulces/contracts` y el servicio lo valida (mismo criterio que MX.2.4).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA_NEGATIVOS = `
CREATE OR REPLACE VIEW analytics.v_kepler_negative_stock WITH (security_invoker = true) AS
WITH neg AS (
  SELECT k.sucursal,
         btrim(k.c3)                      AS sku,
         sum(k.c4 + k.c8 - k.c9)::numeric AS existencia,
         max(k.c6)::date                  AS ult_entrada,
         max(k.c7)::date                  AS ult_salida
    FROM kepler_ods.kdil k
   WHERE k.sucursal = k.c1
     AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
   GROUP BY k.sucursal, btrim(k.c3)
  HAVING sum(k.c4 + k.c8 - k.c9) < -0.001
)
SELECT w.tenant_id,
       w.id        AS warehouse_id,
       w.kepler_code,
       pr.id       AS product_id,
       n.sku,
       n.existencia,
       n.ult_entrada,
       n.ult_salida
  FROM neg n
  JOIN commercial.warehouses w
    ON w.kepler_code = n.sucursal AND w.deleted_at IS NULL
  LEFT JOIN catalog.products pr
    ON pr.tenant_id = w.tenant_id AND pr.sku::text = n.sku AND pr.deleted_at IS NULL
`;

const VISTA_VALES = `
CREATE OR REPLACE VIEW analytics.v_kepler_unapplied_receipts WITH (security_invoker = true) AS
WITH sin_aplicar AS MATERIALIZED (
  SELECT v.sucursal, v.c6 AS folio, btrim(v.c8) AS sku
    FROM kepler_ods.kdm2 v
   WHERE v.c2 = 'X' AND v.c3 = 'A' AND v.c4 = 37 AND v.c1 = v.sucursal
     AND v.c32 >= current_date - 60
  EXCEPT
  SELECT o.sucursal, o.c22, btrim(o.c8)
    FROM kepler_ods.kdm2 o
   WHERE o.c2 = 'X' AND o.c3 = 'A' AND o.c4 = 40 AND o.c1 = o.sucursal
     AND o.c20 = 37 AND btrim(o.c19) = 'A'
     AND o.c32 >= current_date - 90
)
SELECT w.tenant_id,
       w.id                             AS warehouse_id,
       w.kepler_code,
       btrim(v.c8)                      AS sku,
       sum(v.c9)::numeric               AS piezas,
       min(v.c32)::date                 AS desde,
       string_agg(DISTINCT v.c6, ',')   AS folios
  FROM kepler_ods.kdm2 v
  JOIN sin_aplicar s ON s.sucursal = v.sucursal AND s.folio = v.c6 AND s.sku = btrim(v.c8)
  JOIN commercial.warehouses w ON w.kepler_code = v.sucursal AND w.deleted_at IS NULL
 WHERE v.c2 = 'X' AND v.c3 = 'A' AND v.c4 = 37 AND v.c1 = v.sucursal
   AND v.c32 >= current_date - 60
 GROUP BY w.tenant_id, w.id, w.kepler_code, btrim(v.c8)
`;

const COMENTARIOS = [
  `COMMENT ON VIEW analytics.v_kepler_negative_stock IS
    'MX.0.5 - Producto x sucursal con existencia NEGATIVA en Kepler (kdil c4+c8-c9, misma formula que v_erp_stock_on_hand pero SIN recortar a 0). Sin costo (lo pone el servicio desde mv_kepler_unit_cost). product_id NULL = SKU sin ficha en catalogo.'`,
  `COMMENT ON VIEW analytics.v_kepler_unapplied_receipts IS
    'MX.0.5 - Vale de entrada (X-A-37, ultimos 60 dias) sin orden de entrada (X-A-40, 90 dias) que lo aplique, por sucursal x SKU: mercancia recibida que todavia no suma al inventario de Kepler. La unica causa de un negativo que el dato prueba.'`,
];

/** Las sondas piden TODAS las columnas: un count(*) pelado no compila la proyección. */
const SONDAS = [
  `SELECT tenant_id, warehouse_id, kepler_code, product_id, sku, existencia, ult_entrada, ult_salida
     FROM analytics.v_kepler_negative_stock LIMIT 5`,
  `SELECT tenant_id, warehouse_id, kepler_code, sku, piezas, desde, folios
     FROM analytics.v_kepler_unapplied_receipts LIMIT 5`,
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // `kepler_ods.*` lo crea la ingesta, no una migración: en una base recién creada sin moldes las
  // vistas no compilan. Se omiten CON aviso (la tabla sí se crea); el siguiente run las crea.
  const [{ ods }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdil') IS NOT NULL AND to_regclass('kepler_ods.kdm2') IS NOT NULL) AS ods`)).rows;
  if (ods) {
    await knex.raw(VISTA_NEGATIVOS);
    await knex.raw(VISTA_VALES);
    for (const c of COMENTARIOS) await knex.raw(c);
    for (const v of ['v_kepler_negative_stock', 'v_kepler_unapplied_receipts']) {
      await knex.raw(`GRANT SELECT ON analytics.${v} TO app_runtime`);
      await knex.raw(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
          GRANT SELECT ON analytics.${v} TO dev_ro;
        END IF; END $$`);
    }
    for (const s of SONDAS) await knex.raw(s);
  } else {
    // eslint-disable-next-line no-console
    console.log('  ⚠ [MX.0.5] falta kepler_ods.kdil / kdm2 — vistas omitidas (la tabla de resoluciones sí se crea)');
  }


  if (!(await knex.schema.withSchema('commercial').hasTable('negative_stock_reviews'))) {
    await knex.raw(`
      CREATE TABLE commercial.negative_stock_reviews (
        id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid        NOT NULL DEFAULT public.current_tenant_id(),
        warehouse_id       uuid        NOT NULL,
        -- SKU de Kepler (no product_id): un negativo puede ser de un SKU sin ficha en el catálogo.
        sku                text        NOT NULL,
        -- La existencia que la persona VIO al resolver. Si Kepler queda más negativo, reaparece.
        qty_at_resolution  numeric     NOT NULL,
        resolution_reason  text        NOT NULL,
        note               text,
        resolved_by        uuid,
        resolved_by_name   text,
        resolved_at        timestamptz NOT NULL DEFAULT now(),
        created_at         timestamptz NOT NULL DEFAULT now(),
        created_by         uuid,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        updated_by         uuid,
        deleted_at         timestamptz,
        deleted_by         uuid,
        CONSTRAINT negative_stock_reviews_pkey PRIMARY KEY (id),
        CONSTRAINT negative_stock_reviews_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        CONSTRAINT negative_stock_reviews_warehouse_fk
          FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id),
        CONSTRAINT negative_stock_reviews_sku_ck CHECK (btrim(sku) <> ''),
        CONSTRAINT negative_stock_reviews_reason_ck CHECK (btrim(resolution_reason) <> '')
      )`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_negative_stock_reviews_vivo
        ON commercial.negative_stock_reviews (tenant_id, warehouse_id, sku)
        WHERE deleted_at IS NULL`);
  }

  await knex.raw('ALTER TABLE commercial.negative_stock_reviews ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.negative_stock_reviews FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS negative_stock_reviews_tenant ON commercial.negative_stock_reviews');
  await knex.raw(`
    CREATE POLICY negative_stock_reviews_tenant ON commercial.negative_stock_reviews
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.negative_stock_reviews TO app_runtime');
  await knex.raw(`COMMENT ON TABLE commercial.negative_stock_reviews IS
    'MX.0.5 - Resolucion humana de una existencia negativa (sucursal x SKU) en /almacen/incidencias: motivo (catalogo MOTIVOS_EXISTENCIA_NEGATIVA de @megadulces/contracts), nota, quien, cuando y la existencia vista. Una fila viva por sucursal x SKU; reabrir = deleted_at. Dato propio.'`);

  // ── COMPUERTA ────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'negative_stock_reviews'`);
  if (!rows[0]?.on || !rows[0]?.forced) throw new Error('[MX.0.5] RLS no quedó habilitado+forzado en negative_stock_reviews.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.negative_stock_reviews');
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_unapplied_receipts');
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_negative_stock');
};

exports.SQL = { VISTA_NEGATIVOS, VISTA_VALES, SONDAS };
