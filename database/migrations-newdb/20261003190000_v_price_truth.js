'use strict';
/**
 * `[VPR.1]` — **El precio de venta, resuelto por PLAZA y derivado del ERP.**
 *
 * Nace de un reporte de campo: *"mencionan desactualización de precios"* en
 * `/vendor/take-order`. Medido contra prod el 2026-10-03, **no era desactualización**.
 *
 * ── Lo que de verdad pasaba, con el mismo árbitro para las dos superficies ───────────────────
 * Contra `kepler_ods.kdii.c90` (el ERP, por plaza), sobre 69,782 pares SKU x plaza:
 *
 *     etiquetera (product_label_prices) ... 69,782 de 69,782 ... 100.0%
 *     vendedor   (product_prices) ........ 60,550 de 69,782 ....  86.8%
 *
 * Que la etiquetera dé 100% es lo que vuelve publicable el 86.8%: el árbitro discrimina, o sea
 * mide algo. Y la diferencia entre las dos es **el grano**: `product_label_prices` tiene columna
 * `sucursal` y `commercial.product_prices` NO — guarda **un solo número de red** (la moda de c90
 * entre plazas). Para los **393 SKUs** donde las plazas cotizan distinto de verdad, un número
 * único **no puede** acertar, se arregle lo que se arregle.
 *
 * ── Y encima dos procesos se peleaban la columna ────────────────────────────────────────────
 * `analytics.master_data_history` (lo que VP.3 construyó justo para esto) lo dejó por escrito:
 *
 *     SKU 83041 -- las NUEVE plazas cotizan 40.49
 *       09:32  importer:repoint-catalog-prices   38.94 -> 40.49
 *       09:33  (actor NULL)                      40.49 -> 38.94
 *       09:02  importer:repoint-catalog-prices   38.94 -> 40.49
 *       09:23  (actor NULL)                      40.49 -> 38.94   ...
 *
 * **1,222 filas en guerra, 302,273 vaivenes en 3 días (~100,758 por día)**, y al momento de medir
 * el escritor anónimo iba ganando **1,129 a 41**. O sea que el precio no estaba viejo: estaba
 * **inestable**, y lo que veía el vendedor dependía de quién escribió último. Baja el precio 10,349
 * veces contra 2,637 que lo sube; mediana **-3%**, sobre **837 SKUs con $14,371,773** de venta 30 d.
 *
 * ── ⭐ POR QUÉ ESTO ES UNA VISTA, Y POR QUÉ ESO ES LA SOLUCIÓN DEFINITIVA ────────────────────
 * El defecto no se arregla escribiendo el valor correcto: ya se escribe, 48 veces al día, y lo
 * pisan. Se arregla **quitando la columna de la pelea**. Una vista no se puede escribir: no hay
 * importer que la pise, ni actor anónimo que la revierta, ni carrera que ganar. El número deja de
 * depender de quién corrió último porque **ya no hay nadie corriendo**.
 *
 * Es además la regla principal del proyecto (cero importers, derivar en vez de copiar) aplicada
 * donde más duele, y la etiquetera ya demostró que a este grano se llega al 100%.
 *
 * ── Lo que se midió antes de elegir la forma ────────────────────────────────────────────────
 *  · **Costo**: 78,523 filas (producto x almacén) en **99 ms**. El gate es 1 s.
 *  · **Los códigos casan**: `commercial.warehouses.code` = `kdii.sucursal` para las 9 plazas
 *    (00-08), ~9,400 SKUs cada una. Las rutas (`RUTA-50x`) traen 0 y es correcto: una camioneta
 *    no cotiza, y en `take-order` el toggle de camioneta mueve badges de existencia, nunca precio.
 *  · **Nadie pone precios a mano**: `updated_by` y `created_by` están en **0 de 9,618**, y en 30
 *    días los **1,039,304** cambios de `product_prices` son del rol `postgres` (importers) y
 *    **cero** del rol de la app. La gestión manual existe en el código y jamás se usó — así que
 *    esta vista no le quita una capacidad a nadie.
 *
 * ⛔ **`commercial.product_prices` NO se toca.** La leen 14 lugares (portal, Thot, recomendaciones,
 * búsqueda, pedido AI, pricing). Esta vista **no la reemplaza**: la pone al lado y **declara**
 * cuándo difieren, que es lo que hoy nadie podía ver.
 *
 * ⛔ **No cambia ningún número publicado por sí sola**: agrega un objeto que todavía nadie consume.
 *
 * ── Deuda declarada, con nombre ─────────────────────────────────────────────────────────────
 * Un precio puesto por un humano y uno derivado del ERP **viven hoy en la misma columna**, y por
 * eso no se pueden distinguir (`updated_by` nunca se escribió). Mientras siga así, un override
 * manual es indistinguible de un feed y esta vista no puede respetarlo. El arreglo de fondo es
 * que el override tenga **columna propia**; acá se deja dicho, no resuelto.
 */

const V = 'analytics.v_price_truth';
const BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${V} AS
    SELECT
      w.tenant_id,
      w.id                                AS warehouse_id,
      w.code                              AS sucursal,
      p.id                                AS product_id,
      p.sku,
      -- El precio que ESA plaza cobra, dicho por el ERP. Es el unico conmensurable con lo que el
      -- cliente va a pagar ahi.
      k.c90::numeric                      AS precio_erp,
      -- Lo que la lista de red publica hoy, al lado y NO en lugar de: sin esto la divergencia es
      -- invisible, que es exactamente como vivio hasta ahora.
      pp.price                            AS precio_lista,
      CASE
        WHEN pp.price IS NULL                                 THEN 'sin_precio_lista'
        WHEN abs(pp.price - k.c90::numeric) < 0.005           THEN 'cuadra'
        ELSE 'difiere'
      END                                 AS veredicto,
      CASE WHEN pp.price IS NULL THEN NULL
           ELSE round(100.0 * (pp.price - k.c90::numeric) / NULLIF(k.c90::numeric, 0), 2)
      END                                 AS desvio_pct
      FROM kepler_ods.kdii k
      JOIN commercial.warehouses w
        ON w.code = btrim(k.sucursal) AND w.deleted_at IS NULL
      JOIN catalog.products p
        ON p.sku = btrim(k.c1) AND p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
      -- La lista BASE es la unica poblada (las otras cinco tienen 0 precios, medido). Se nombra
      -- explicita en vez de "la default" para que un cambio de bandera no mueva este numero en
      -- silencio.
      LEFT JOIN commercial.product_prices pp
        ON pp.tenant_id = p.tenant_id AND pp.product_id = p.id
       AND pp.price_list_id = '${BASE_LIST}' AND pp.deleted_at IS NULL
     -- Piso 0.05: en Kepler los c90 de 0.01/0.05 son MARCADORES DE PROMO (clave de regalo, solo
     -- rutas), no precio de venta. Entraron al precio base alguna vez y por eso el piso es
     -- explicito aca tambien, no solo en el importer.
     WHERE k.c90 IS NOT NULL AND k.c90::numeric > 0.05
  `);

  // ⚠️ `security_invoker` y el GRANT van EXPLÍCITOS: no se heredan en un `CREATE OR REPLACE VIEW`
  // (lección U.7 / ADR-057 — una migración de esa fase lo perdió y sólo lo vio el candado).
  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW ${V} IS
      '[VPR.1] Precio de venta por (almacen, producto) derivado de kepler_ods.kdii.c90 de ESA '
      'plaza. VISTA a proposito: la tabla commercial.product_prices la escribian dos procesos en '
      'guerra (302,273 vaivenes en 3 dias) y un numero que nadie puede escribir no se puede pisar. '
      'veredicto compara contra la lista de red, que NO se toca: 14 consumidores la leen.'`);

  // ── Verificación dentro de la migración ──────────────────────────────────────────────────
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int c FROM ${V}`);
  if (!n.c) throw new Error('[VPR.1] la vista no devolvió una sola fila');

  // ⭐ EL CONTROL, no el número. La vista existe porque la lista de red DIFIERE del ERP; si
  // coincidiera en todo, este objeto no haría falta y habría que decirlo en vez de publicarlo.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE veredicto = 'cuadra')::int   cuadran,
           count(*) FILTER (WHERE veredicto = 'difiere')::int  difieren,
           count(DISTINCT warehouse_id)::int                   plazas
      FROM ${V}`);
  if (!d.difieren) {
    throw new Error(
      '[VPR.1] la lista de red coincide con el ERP en TODO: o el defecto ya se arregló por otra ' +
      'vía y esta vista sobra, o el árbitro dejó de discriminar. Hay que mirarlo, no publicarlo.');
  }
  if (d.plazas < 2) {
    throw new Error(`[VPR.1] sólo ${d.plazas} plaza(s) resuelven: el join por código de almacén se rompió`);
  }

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${V}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[VPR.1] app_runtime no puede leer la vista');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
};
