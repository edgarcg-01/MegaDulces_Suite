'use strict';
/**
 * `[CANON.6.13]` — `inventory.products_active` pasa de TABLA rellenada por reloj a VISTA sobre `catalog.products`.
 *
 * La llenaba `refresh-products-active.js` cada día a las 05:20 con TRUNCATE + INSERT desde `catalog.products`
 * (los activos con SKU) + `inventory.products` (subfamilia, categoría, imagen), y en CADA corrida borraba una FK
 * (DDL en un cron). Lo que el catálogo cambiaba durante el día (nombre, alta, baja) no llegaba a sus lectores
 * (buscador, precios, portal, extractor de tickets, corpus del matcher) hasta la mañana siguiente. Como vista,
 * es la MISMA consulta, evaluada al leer: sin reloj y sin copia (regla 1 y 2).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-12) ────────────────────────────────────────
 *  · La consulta de la vista contra la tabla, columna por columna: 10,011 filas, iguales en código de barras,
 *    subfamilia, descripción, unidades, categoría e imagen; difieren 4 nombres (cambiados en Kepler después de
 *    las 05:20, p. ej. 17060 «FAJILLA … / 100» → «/ 50») y faltan 13 productos dados de alta hoy. Eso es el reloj.
 *  · Nadie escribe en ella salvo el script (la app sólo la lee, por `sku`); no hay vistas, funciones ni FKs que
 *    dependan de ella. Latencia de los lectores reales con la vista en línea: +6 a +21 ms (búsqueda 23 ms,
 *    catálogo completo 30 ms, corpus 13 ms).
 *  · El latido `products_active_refresh` fallaba el 20 % de las corridas (db-health, recurrencia de 7 días).
 *
 * ── Decisiones ──────────────────────────────────────────────────────────────────────────────
 *  · Dueño de la vista = quien migra (`postgres`, superusuario): la vista NO pasa por el RLS de
 *    `catalog.products`, igual que la tabla, que no tenía RLS. Por eso el tenant va FIJO (Mega Dulces): es lo
 *    que hacía el script (`CRON_TENANT_ID`) y así ningún lector depende de su contexto de tenant (el corpus del
 *    matcher lee sin `app.tenant_id`). La tabla ya era mono-tenant (sin `tenant_id`); la deuda no es nueva.
 *  · La tabla NO se borra (regla 5): se RENOMBRA a `inventory.products_active_congelada_20261112`, sin permisos
 *    para la app. Borrarla pide firma de Edgar.
 *  · `synced_at` ya no es «cuándo copió el cron»: es cuándo cambió la fila del catálogo (`updated_at`).
 *  · Piso anti-vaciado (el del script): si la vista diera menos de la mitad de lo que la tabla tenía, la
 *    migración ABORTA y no cambia nada.
 *
 * ⚠️ ORDEN: la ingesta sólo despliega el commit que la API ya sirve, y la API no sale con esta migración
 *    pendiente: así que se aplica ANTES de que la ingesta deje de agendar `refresh-products-active.js` (05:20).
 *    Si el script viejo alcanza a correr con la vista puesta, falla en su primer paso (`ALTER TABLE … DROP
 *    CONSTRAINT`: «no puede ser efectuada en la relación») y su transacción se revierte: ni TRUNCATE ni INSERT
 *    (además la vista, con su JOIN, no es actualizable). Ruidoso —latido en rojo esa mañana—, sin daño.
 *    Probado en una base local. Desplegar la ingesta el mismo día lo evita.
 *
 * Idempotente: si ya es vista, no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';
const CONGELADA = 'products_active_congelada_20261112';

const VISTA = `
  CREATE VIEW inventory.products_active AS
  SELECT p.sku::varchar                                                         AS sku,
         COALESCE(NULLIF(btrim(p.barcode), ''), ip.codigo_barras)::varchar      AS codigo_barras,
         ip.subfamilia::varchar                                                 AS subfamilia,
         COALESCE(NULLIF(btrim(p.nombre), ''), ip.nombre)::varchar              AS nombre,
         COALESCE(NULLIF(btrim(p.description), ''), ip.descripcion)::varchar    AS descripcion,
         COALESCE(NULLIF(btrim(p.unit_purchase), ''), ip.unidad_compra)::varchar AS unidad_compra,
         COALESCE(NULLIF(btrim(p.unit_sale), ''), ip.unidad_venta)::varchar     AS unidad_venta,
         ip.categoria::varchar                                                  AS categoria,
         COALESCE(p.updated_at, p.created_at)                                   AS synced_at,
         ip.image_url, ip.image_source, ip.image_storage_key, ip.image_updated_at
    FROM catalog.products p
    LEFT JOIN inventory.products ip ON ip.sku = p.sku
   WHERE p.tenant_id = '${T}' AND p.activo AND p.deleted_at IS NULL AND btrim(coalesce(p.sku, '')) <> ''`;

const relkind = async (knex, nombre) => ((await knex.raw(
  `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'inventory' AND c.relname = '${nombre}'`)).rows[0] || {}).relkind || null;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const k = await relkind(knex, 'products_active');
  if (k === 'v') { console.log('  inventory.products_active ya es vista — nada que hacer'); return; }
  let antes = 0;
  if (k === 'r') {
    if (await relkind(knex, CONGELADA)) throw new Error(`ya existe inventory.${CONGELADA}: no se pisa — revisar a mano`);
    antes = Number((await knex.raw(`SELECT count(*)::int AS n FROM inventory.products_active`)).rows[0].n);
    await knex.raw(`ALTER TABLE inventory.products_active RENAME TO ${CONGELADA}`);
    await knex.raw(`COMMENT ON TABLE inventory.${CONGELADA} IS
      '[CANON.6.13] CONGELADA el 2026-11-12: era inventory.products_active (copia diaria por cron). La reemplaza la VISTA inventory.products_active. Sin lectores. Borrarla pide firma (regla 5).'`);
    await knex.raw(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        EXECUTE 'REVOKE ALL ON inventory.${CONGELADA} FROM app_runtime';
      END IF; END $$`);
  } else if (k) {
    throw new Error(`inventory.products_active es relkind '${k}': no es tabla ni vista — revisar a mano`);
  }
  await knex.raw(VISTA);
  await knex.raw(`COMMENT ON VIEW inventory.products_active IS
    '[CANON.6.13] derive-no-copy: los productos ACTIVOS con SKU de catalog.products (tenant Mega Dulces) + subfamilia, categoria e imagen de inventory.products. Antes, tabla rellenada a las 05:20 por refresh-products-active.js (TRUNCATE+INSERT). Dueño postgres: no pasa por el RLS de catalog.products, por eso el tenant va fijo.'`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'GRANT SELECT ON inventory.products_active TO app_runtime'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON inventory.products_active TO dev_ro'; END IF;
    END $$`);
  const despues = Number((await knex.raw(`SELECT count(*)::int AS n FROM inventory.products_active`)).rows[0].n);
  if (antes > 0 && despues < Math.floor(antes / 2)) {
    throw new Error(`PISO: la vista da ${despues} filas y la tabla tenía ${antes} (mínimo la mitad). `
      + `¿catalog.products a medio poblar? No se cambia nada (la transacción se revierte).`);
  }
  console.log(`  inventory.products_active: tabla (${antes} filas) → vista (${despues} filas); la tabla queda como inventory.${CONGELADA}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista fuera y la tabla de vuelta con sus permisos. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await relkind(knex, 'products_active') !== 'v') return;
  if (!(await relkind(knex, CONGELADA))) {
    throw new Error(`no existe inventory.${CONGELADA}: bajar la vista dejaría a los lectores sin products_active`);
  }
  await knex.raw(`DROP VIEW inventory.products_active`);
  await knex.raw(`ALTER TABLE inventory.${CONGELADA} RENAME TO products_active`);
  await knex.raw(`COMMENT ON TABLE inventory.products_active IS NULL`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products_active TO app_runtime';
    END IF; END $$`);
};
