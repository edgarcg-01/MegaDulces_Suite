'use strict';
/**
 * `[CANON.6.15]` — `inventory.products` pasa de TABLA (foto de junio del FDW muerto + altas por cron) a VISTA sobre
 * `catalog.products`, con lo que el catálogo no tiene tomado de la foto congelada.
 *
 * La llenaba el FDW `erp.catalogo_completo` hasta junio (13,852 filas) y desde agosto `refresh-inventory-products.js`
 * (05:10) le AGREGABA los SKUs nuevos del catálogo (909), sin actualizar nunca los existentes. Es el «catálogo del
 * almacén» del conteo físico, de la ficha de producto (`entity-ref`) y de `products_active`.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-12) ────────────────────────────────────────
 *  · De sus 14,761 filas, 10,222 son productos vivos del catálogo; de ésos, 1,346 con OTRO nombre y 1,310 con OTRO
 *    código de barras (la foto nunca se actualizó). 13 productos vivos no estaban.
 *  · Las 4,539 que no están en el catálogo vivo: 2,676 borrados del catálogo, 1,333 que no existen en ningún lado
 *    (ni catálogo ni `kdii`) y 530 que están en `kdii` sin producto — 521 de ésos se llaman «* DESCONTINUADO».
 *  · Nadie escribe en ella salvo el cron y el script manual de imágenes; no hay vistas, FKs ni triggers que dependan.
 *    El conteo físico no se usa desde junio (6 folios, todos cancelados).
 *
 * ── Decisiones ──────────────────────────────────────────────────────────────────────────────
 *  · Universo = productos VIVOS del catálogo con SKU (activos o no: el almacén cuenta lo que hay). Salen los
 *    borrados y los fantasmas. Lo que falte en el catálogo se arregla en el catálogo (presencia), no aquí.
 *  · Del catálogo, al momento: sku, nombre, código de barras, descripción y unidades — lo mismo que la tabla ya
 *    tomaba de ahí para las altas, y lo que `products_active` toma desde `[CANON.6.13]`. Si el catálogo lo trae
 *    vacío, el de la foto.
 *  · De la foto congelada, TAL CUAL (como hoy): subfamilia, categoría, factores, impuestos, estadísticas anuales,
 *    fechas, `a_1..a_3` e imágenes. Los factores NO se toman del catálogo: catálogo y Kepler discrepan en unidades
 *    (UNIDADES_DE_MEDIDA.md) y cambiar la fuente de una unidad sin verificarla sería adivinar.
 *  · La tabla NO se borra (regla 5): se RENOMBRA a `inventory.products_legado_fdw` y sigue siendo la dueña de lo que
 *    no se deriva — la foto del FDW y las IMÁGENES (las escribe `upload-product-images-to-cloudinary.js`). Sin
 *    permisos para la app; la leen las vistas (dueño `postgres`).
 *  · Vista de `postgres` con tenant FIJO: no pasa por el RLS de `catalog.products`, como la tabla (sin RLS ni
 *    `tenant_id`); así ningún lector depende de su contexto de tenant.
 *  · Piso anti-vaciado: si la vista diera menos de la mitad de lo que la tabla tenía, ABORTA.
 *
 * ⚠️ ORDEN: igual que 20261112135015 — se aplica antes de que la ingesta deje de agendar el cron de las 05:10; si el
 *    cron viejo corre con la vista, su INSERT falla y se revierte (latido rojo esa mañana, sin daño).
 *
 * Idempotente: si ya es vista, no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';
const LEGADO = 'products_legado_fdw';

const VISTA = `
  CREATE VIEW inventory.products AS
  SELECT p.sku::varchar                                                           AS sku,
         l.producto_servicio,
         COALESCE(NULLIF(btrim(p.barcode), ''), l.codigo_barras)::varchar        AS codigo_barras,
         l.subfamilia,
         COALESCE(NULLIF(btrim(p.nombre), ''), l.nombre)::varchar                AS nombre,
         COALESCE(NULLIF(btrim(p.description), ''), l.descripcion)::varchar      AS descripcion,
         COALESCE(NULLIF(btrim(p.unit_purchase), ''), l.unidad_compra)::varchar  AS unidad_compra,
         COALESCE(NULLIF(btrim(p.unit_sale), ''), l.unidad_venta)::varchar       AS unidad_venta,
         l.factor_compra, l.factor_venta,
         l.venta_valor_anual, l.venta_valor_costo_anual, l.venta_unidad_anual,
         l.categoria, l.ieps_compra, l.iva_compra, l.ieps_venta, l.iva_venta, l.ptos_frecuencia,
         l.fecha_alta, l.fecha_ultima_modificacion, l.a_1, l.a_2, l.a_3,
         COALESCE(p.updated_at, p.created_at)                                     AS synced_at,
         'catalog.products'::varchar                                              AS synced_from,
         l.image_url, l.image_source, l.image_storage_key, l.image_updated_at
    FROM catalog.products p
    LEFT JOIN inventory.${LEGADO} l ON l.sku = p.sku
   WHERE p.tenant_id = '${T}' AND p.deleted_at IS NULL AND btrim(coalesce(p.sku, '')) <> ''`;

const relkind = async (knex, nombre) => ((await knex.raw(
  `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'inventory' AND c.relname = '${nombre}'`)).rows[0] || {}).relkind || null;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const k = await relkind(knex, 'products');
  if (k === 'v') { console.log('  inventory.products ya es vista — nada que hacer'); return; }
  if (k !== 'r') throw new Error(`inventory.products es relkind '${k}': no es tabla ni vista — revisar a mano`);
  if (await relkind(knex, LEGADO)) throw new Error(`ya existe inventory.${LEGADO}: no se pisa — revisar a mano`);
  const antes = Number((await knex.raw(`SELECT count(*)::int AS n FROM inventory.products`)).rows[0].n);
  // Las vistas que ya leían la tabla (p. ej. products_active de [CANON.6.13]) la siguen leyendo por OID: tras el
  // renombre leen la foto congelada, que es justo lo que toman de ella (subfamilia, categoría, imagen).
  await knex.raw(`ALTER TABLE inventory.products RENAME TO ${LEGADO}`);
  await knex.raw(`COMMENT ON TABLE inventory.${LEGADO} IS
    '[CANON.6.15] Era inventory.products: foto de junio-2026 del FDW erp.catalogo_completo + altas del cron refresh-inventory-products (retirado). Queda como dueña de lo que NO se deriva del catalogo: subfamilia, categoria, factores, impuestos, estadisticas anuales e IMAGENES (las escribe upload-product-images-to-cloudinary.js). La lee la vista inventory.products. Borrarla pide firma (regla 5).'`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'REVOKE ALL ON inventory.${LEGADO} FROM app_runtime'; END IF;
    END $$`);
  await knex.raw(VISTA);
  await knex.raw(`COMMENT ON VIEW inventory.products IS
    '[CANON.6.15] derive-no-copy: productos VIVOS con SKU de catalog.products (tenant Mega Dulces; nombre, codigo, descripcion y unidades al momento) + lo que el catalogo no tiene, de inventory.${LEGADO}. Antes, tabla: foto del FDW + altas del cron de las 05:10. Duena postgres: no pasa por el RLS de catalog.products, por eso el tenant va fijo.'`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'GRANT SELECT ON inventory.products TO app_runtime'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON inventory.products TO dev_ro'; END IF;
    END $$`);
  const despues = Number((await knex.raw(`SELECT count(*)::int AS n FROM inventory.products`)).rows[0].n);
  if (antes > 0 && despues < Math.floor(antes / 2)) {
    throw new Error(`PISO: la vista da ${despues} filas y la tabla tenía ${antes} (mínimo la mitad). `
      + `¿catalog.products a medio poblar? No se cambia nada (la transacción se revierte).`);
  }
  console.log(`  inventory.products: tabla (${antes} filas) → vista (${despues} filas); la tabla queda como inventory.${LEGADO}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista fuera y la tabla de vuelta con sus permisos. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await relkind(knex, 'products') !== 'v') return;
  if (!(await relkind(knex, LEGADO))) throw new Error(`no existe inventory.${LEGADO}: bajar la vista dejaría a los lectores sin inventory.products`);
  await knex.raw(`DROP VIEW inventory.products`);
  await knex.raw(`ALTER TABLE inventory.${LEGADO} RENAME TO products`);
  await knex.raw(`COMMENT ON TABLE inventory.products IS NULL`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products TO app_runtime';
    END IF; END $$`);
};
