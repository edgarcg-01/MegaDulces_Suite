/**
 * Retira el FDW a `Mega_Dulces` (.245): 3 vistas `analytics_external.*_legacy`, sus 3 foreign
 * tables `erp.*`, el user mapping y el server `mega_dulces_srv`. Regla ⭐: cero importers, todo
 * del ODS — esto es el último resto del linaje viejo (archivos .mdb/.csv → Mega_Dulces → FDW).
 *
 * POR QUÉ SE VA (medido contra prod el 2026-09-05, no asumido):
 *
 * 1. **La fuente está muerta.** `Mega_Dulces.public.ventas` se alimentaba por EXPORT MANUAL de
 *    archivos por sucursal; el último cargado es del **2026-05-20**, y arrastra el bug de parseo
 *    DD/MM↔MM/DD que mandaba filas a meses futuros.
 *
 * 2. **El FDW es inalcanzable desde prod.** El server apunta a `192.168.0.245`, una IP de LAN que
 *    Railway no rutea. Cualquier `SELECT` sobre las tres vistas **se cuelga** hasta el
 *    statement_timeout (comprobado en esta sesión: la consulta se colgó y hubo que abortarla).
 *    O sea no es sólo peso muerto: es una trampa de cuelgue para el próximo que las toque.
 *
 * 3. **Cero lectores vivos.** El código ya fue repuntado; de las tres vistas sólo quedan menciones
 *    en COMENTARIOS que explican por qué se dejaron de usar — `commercial-analytics.service.ts`
 *    dice textual "inalcanzable desde Railway", "muerto en Railway" y "el FDW Railway→.245 colgaba".
 *    `analytics_external.productos_activos_legacy` no tiene ni una mención en código.
 *
 * 4. **`catalog.products_active` TAMBIÉN cuelga del FDW, y también se cuelga.** Se descubrió
 *    midiendo, no leyendo: un `count(*)` sobre ella dio `statement timeout`. La cadena es
 *    `public.products_active` → `catalog.products_active` → `JOIN erp.productos_activos`. Un chequeo
 *    que sólo busca `erp.*` en la definición de la vista de arriba **no la encuentra** — hay que
 *    seguir la dependencia transitiva (`pg_depend`/`pg_rewrite`).
 *    ⚠️ Y el `search_path` es `identity, catalog, trade, commercial, logistics, public`: **`catalog`
 *    va ANTES que `public`**, así que un `products_active` SIN CALIFICAR resuelve a la vista con el
 *    FDW. Es una trampa de cuelgue para cualquier SQL nuevo que se escriba sin schema.
 *
 * ⚠️ LO QUE **NO** SE TOCA: **`inventory.products_active` es una TABLA**, no una vista, y no toca el
 * FDW. Es la que leen los **9 consumidores reales** (matcher de IA, búsqueda de catálogo, pricing,
 * extractor de tickets, portal) — todos la califican como `inventory.`. La llena
 * `refresh-products-active.js` desde `catalog.products` + `kepler_ods.kdii`, explícitamente "NO desde
 * el FDW legacy `erp.productos_activos` (stale/dormido)". O sea el corpus ya estaba repuntado al ODS;
 * lo único que seguía enchufado al FDW eran las dos vistas homónimas, sin un solo lector.
 *
 * Por eso esta migración **repunta** `catalog.products_active` al ODS en vez de borrarla: preserva el
 * nombre (y con él cualquier SQL sin calificar) y le quita el cuelgue. El predicado es el MISMO que
 * ya usa `refresh-products-active.js` para decidir "activo en el ERP": existe en `kepler_ods.kdii`
 * con `c1` = sku y `c2` (nombre) no vacío.
 *
 * Junto con esta migración se dan de baja los sensores `mega_dulces` y `kp_concentrada` de
 * `db-health.service.ts`: un sensor que apunta a algo que ya no existe se pinta rojo para siempre
 * y entrena al equipo a ignorar el tablero (la falla que ADR-053 / Fase OBS existe para evitar).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1) Las tres vistas legacy: cero lectores, se van.
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ventas_legacy`);
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ranking_legacy`);
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.productos_activos_legacy`);

  // 2) `catalog.products_active` se REPUNTA al ODS (mismo predicado de activo que usa
  //    refresh-products-active.js), no se borra: conserva el nombre al que resuelve un
  //    `products_active` sin calificar y deja de colgarse. CREATE OR REPLACE y no DROP+CREATE:
  //    recrear una vista viva puede dar 0A000 por planes en caché (ver GOTCHAS).
  //    FIEL a la definición que reemplaza: misma lista de columnas (`p.*` de catalog.products, 39
  //    columnas en el mismo orden — requisito de CREATE OR REPLACE), mismo `LEFT JOIN brands` y
  //    mismo `WHERE p.deleted_at IS NULL AND COALESCE(b.is_commercial, true)`. Lo ÚNICO que cambia
  //    es el filtro de "activo en el ERP": el `JOIN erp.productos_activos pa ON pa.articulo = p.sku`
  //    pasa a `EXISTS` sobre `kepler_ods.kdii`. Se usa EXISTS y no JOIN a propósito: `kdii` tiene una
  //    fila por (sucursal, sku) — un JOIN multiplicaría el producto por sucursal (fan-out), que es
  //    justo el bug de doble conteo que ya nos costó antes (Fase FKJ).
  //    OJO: la vista NO filtra `p.activo` — no se le agrega, para no cambiar su semántica de paso.
  await knex.raw(`CREATE OR REPLACE VIEW catalog.products_active AS
    SELECT p.*
      FROM catalog.products p
      LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
     WHERE p.deleted_at IS NULL
       AND COALESCE(b.is_commercial, true) = true
       AND EXISTS (
         SELECT 1 FROM kepler_ods.kdii k
          WHERE btrim(k.c1) = p.sku::text AND btrim(coalesce(k.c2, '')) <> ''
       )`);
  await knex.raw(`COMMENT ON VIEW catalog.products_active IS
    'Activos del ERP derive-no-copy sobre kepler_ods.kdii (c1=sku, c2=nombre no vacío). Repuntada '
    '2026-09-05: antes hacía JOIN a erp.productos_activos (FDW a Mega_Dulces .245), inalcanzable '
    'desde Railway -> la vista se COLGABA hasta el statement_timeout. Ojo: el search_path pone '
    'catalog antes que public, así que un products_active sin calificar resuelve ACÁ. El corpus que '
    'consume la app es la TABLA inventory.products_active, que llena refresh-products-active.js.'`);

  // 3) Ahora sí, las foreign tables (ya sin dependientes).
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS erp.ventas`);
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS erp.ranking_productos`);
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS erp.productos_activos`);

  // El server se lleva su user mapping por CASCADE. Si alguien agregó otra foreign table sobre él
  // sin pasar por migración, CASCADE la borra: por eso el paso anterior es explícito y este es el
  // cierre, no el atajo.
  await knex.raw(`DROP SERVER IF EXISTS mega_dulces_srv CASCADE`);
};

/**
 * Reversible en FORMA, no en fondo: recrea el server y las foreign tables, pero la base de origen
 * `Mega_Dulces` en .245 se dio de baja en la misma maniobra, así que un rollback devuelve los
 * objetos y NO el dato. Si alguna vez hiciera falta de verdad, el camino correcto no es este
 * rollback sino derivar del ODS (`kepler_ods.*`), que es lo que ya hacen sus ex-consumidores.
 */
exports.down = async function (knex) {
  const host = process.env.MEGA_DULCES_FDW_HOST || '192.168.0.245';
  const port = process.env.MEGA_DULCES_FDW_PORT || '5432';
  const user = process.env.MEGA_DULCES_FDW_USER;
  const pass = process.env.MEGA_DULCES_FDW_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'rollback de 20260905140000: faltan MEGA_DULCES_FDW_USER / MEGA_DULCES_FDW_PASSWORD. ' +
      'No se hardcodean credenciales en la migración; y ojo: la base Mega_Dulces en .245 se dio ' +
      'de baja, así que este rollback recrea los objetos pero NO devuelve el dato.',
    );
  }
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
  await knex.raw(
    `CREATE SERVER IF NOT EXISTS mega_dulces_srv FOREIGN DATA WRAPPER postgres_fdw
       OPTIONS (host ?, port ?, dbname 'Mega_Dulces', updatable 'false')`,
    [host, port],
  );
  await knex.raw(
    `CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER SERVER mega_dulces_srv
       OPTIONS (user ?, password ?)`,
    [user, pass],
  );
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS erp`);
  await knex.raw(`IMPORT FOREIGN SCHEMA public
    LIMIT TO (ventas, ranking_productos, productos_activos)
    FROM SERVER mega_dulces_srv INTO erp`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics_external`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics_external.ventas_legacy AS
    SELECT fecha, hora, zona, almacen, vendedor, tercero_id, tercero_nombre, folio,
           producto_id, producto, subfamilia, categoria, cantidad, venta_diaria, costo
      FROM erp.ventas`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics_external.ranking_legacy AS
    SELECT posicion, articulo, nombre, total_cajas, total_piezas, total_piezas_totales, total_venta
      FROM erp.ranking_productos`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics_external.productos_activos_legacy AS
    SELECT articulo FROM erp.productos_activos`);
};
