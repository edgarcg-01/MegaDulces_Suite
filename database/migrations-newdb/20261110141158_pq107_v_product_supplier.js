'use strict';
/**
 * `[PQ.107]` — `analytics.v_product_supplier`: el proveedor de cada producto, leído de Kepler en el
 * ODS (derive-no-copy). Reemplaza a la copia nocturna que `import-kepler-suppliers.js` escribe en
 * `catalog.products.supplier_id` (Edgar, 2026-11-10: «hay que leer todo del ODS directo»).
 *
 * POR QUÉ: el 10211 (GALL ARTESANALES DE AVENA /12) salía con el proveedor «INHABILITADO» y nadie
 * entendía por qué la Suite no lo actualizaba. La Suite no decide el proveedor: copia la relación
 * proveedor→producto de Kepler («Costos por Proveedor por Productos», `kdpv_prov_prod`) a las 03:00,
 * y en Kepler el 10211 sigue ligado a CD43, renombrado «INHABILITADO» en 8 de 9 sucursales, aunque
 * desde octubre se le compra a CM036. Leer del ODS quita el rezago de un día y deja ver el hecho
 * tal cual, con sus conflictos DECLARADOS en vez de resueltos a mano.
 *
 * La regla es la del importer, para que el corte no mueva nada: la liga de la sucursal MÁS BAJA
 * gana (`DISTINCT ON … ORDER BY sku, sucursal`); el nombre es el de esa misma sucursal en `kdxd`.
 *
 * `estado` declara lo que la columna vieja escondía:
 *   · `kepler`               — la liga existe y su proveedor está vivo en `catalog.suppliers`.
 *   · `dado_de_baja_en_suite` — Kepler liga a un código que la Suite FUSIONÓ con otro
 *                              (`suppliers-normalize`): `supplier_id` sale NULL. No se repite la
 *                              fusión: Kepler dice BIMBO (CB004) y la columna decía BARCEL.
 *   · `no_esta_en_suite`     — el código no existe en `catalog.suppliers`.
 *   · `sin_liga_en_kepler`   — Kepler no liga el SKU a nadie.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-10) ────────────────────────────────────────
 *  · `kdpv_prov_prod`: 87,552 filas, 9,732 SKUs en 9 sucursales; `kdxd`: 804 códigos.
 *  · Contra la columna de hoy: de 9,090 productos con liga, 9,011 iguales y 79 distintos; 53 ligan
 *    a 8 códigos fusionados en la Suite, 11 a códigos que no están; 114 productos sin liga
 *    conservan un proveedor viejo en la columna.
 *  · Tres proveedores de Kepler se llaman «INHABILITADO» (CD43, CP051, CP056); un producto los usa.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

// ⛔ COLLATE "C" en el orden, no por gusto: ordenar 87,552 textos con la intercalación del idioma
// costaba 346 ms; en binario, 93 ms la pasada entera (medido en prod, mismo resultado en las 9,732
// ligas). Sólo ordena y agrupa: el texto que sale es el mismo.
// El desempate es explícito: el importer dejaba los EMPATES (dos proveedores en la misma sucursal
// más baja; 3 SKUs: 92169, 94288, 99997) al orden físico de la tabla. Acá gana el que Kepler tiene
// en más sucursales y luego el código — el 94288 se queda con CC035 (9 sucursales) y no con
// «00001 PRODUCTOS SIN PROVEEDOR ASIGNADO» (1).
const VISTA = `
WITH pares AS (
  SELECT btrim(pp.c2) AS sku, btrim(pp.c1) AS supplier_code, min(pp.sucursal) AS sucursal, count(*) AS en_sucursales
    FROM kepler_ods.kdpv_prov_prod pp
   WHERE NULLIF(btrim(pp.c1), '') IS NOT NULL AND NULLIF(btrim(pp.c2), '') IS NOT NULL
   GROUP BY 1, 2
),
liga AS (
  SELECT DISTINCT ON (sku COLLATE "C") sku, supplier_code, sucursal,
         count(*) OVER (PARTITION BY sku COLLATE "C") AS proveedores_kepler
    FROM pares
   ORDER BY sku COLLATE "C", sucursal COLLATE "C", en_sucursales DESC, supplier_code COLLATE "C"
)
SELECT p.tenant_id, p.id AS product_id, p.sku,
       l.supplier_code,
       CASE WHEN s.deleted_at IS NULL THEN s.id END AS supplier_id,
       COALESCE(NULLIF(btrim(x.c3), ''), s.name) AS supplier_name,
       COALESCE(upper(btrim(x.c3)) LIKE 'INHABILITAD%', false) AS inhabilitado_en_kepler,
       COALESCE(l.proveedores_kepler, 0)::int AS proveedores_kepler,
       CASE WHEN l.sku IS NULL THEN 'sin_liga_en_kepler'
            WHEN s.id IS NULL THEN 'no_esta_en_suite'
            WHEN s.deleted_at IS NOT NULL THEN 'dado_de_baja_en_suite'
            ELSE 'kepler' END AS estado
  FROM catalog.products p
  LEFT JOIN liga l ON l.sku = btrim(p.sku)
  LEFT JOIN kepler_ods.kdxd x ON x.sucursal = l.sucursal AND btrim(x.c2) = l.supplier_code
  LEFT JOIN catalog.suppliers s ON s.tenant_id = p.tenant_id AND s.code = l.supplier_code
 WHERE p.deleted_at IS NULL`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_product_supplier AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_product_supplier IS '[PQ.107] Proveedor de cada producto leido de Kepler (kdpv_prov_prod, gana la sucursal mas baja; nombre de kdxd en esa sucursal). estado: kepler | dado_de_baja_en_suite | no_esta_en_suite | sin_liga_en_kepler. Reemplaza a la copia nocturna en catalog.products.supplier_id.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_product_supplier TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_product_supplier TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_product_supplier`);
};
