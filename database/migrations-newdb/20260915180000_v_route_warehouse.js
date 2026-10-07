/**
 * `[JZ.2]` — LA RUTA DEL CATÁLOGO Y EL ALMACÉN QUE VENDE SON LA MISMA COSA, Y NADIE LOS UNÍA.
 *
 * ── El defecto que cierra ──────────────────────────────────────────────────────────────────
 * Una ruta de detalle existe DOS veces en la base y con llaves que no casan:
 *
 *   · `trade.catalogs` (`catalog_id = 'rutas'`, `parent_id` = la zona) la llama  `RUTA 21`
 *   · `commercial.warehouses`, que es donde de verdad VENDE, la llama            `RUTA-21`
 *
 * El hecho de venta (`analytics.sales_daily`) cuelga del ALMACÉN, y la pertenencia a una zona
 * cuelga del CATÁLOGO. Sin un puente no se puede contestar «cuánto vendió mi zona», que es la
 * pregunta por la que existe la portada del jefe de zona.
 *
 * ── Medido en prod el 2026-09-15, antes de escribir una línea ──────────────────────────────
 *   · 24 rutas activas en el catálogo, sobre 8 zonas.
 *   · 13 casan con un almacén `RUTA-%`; **11 no tienen almacén** (las 6 vecinales, mayoreo, y
 *     `RUTA 29`), o sea que existen en el catálogo y no venden por esta vía.
 *   · 13 almacenes `RUTA-%`, **ninguno huérfano**: todos encuentran su ruta en el catálogo.
 *
 * ── ⛔ Y TRES CHOQUES QUE NO SE RESUELVEN ADIVINANDO ───────────────────────────────────────
 * Una misma clave normalizada la reclaman DOS zonas distintas:
 *
 *   | clave      | quiénes                                                    |
 *   |------------|------------------------------------------------------------|
 *   | `501`      | ZAMORA (`RUTA 501`)  ·  CANINDO (`Ruta 501`)                |
 *   | `502`      | ZAMORA (`RUTA 502`)  ·  CANINDO (`502`)                     |
 *   | `VECINAL1` | MORELIA MADERO (`Ruta Vecinal #1`) · MORELIA ABASTOS (`Ruta vecinal 1`) |
 *
 * Los dos primeros son dinero: `RUTA-501` y `RUTA-502` vendieron **$1.04M entre junio y agosto**.
 * Atribuirlos a las dos zonas los contaría dos veces; elegir una zona a dedo sería inventar un
 * hecho de negocio. Así que la vista **los marca `ambigua = true` y no elige** — el consumidor
 * suma lo inequívoco y DECLARA lo demás (ADR-056: lo que no se puede medir se declara, nunca se
 * dibuja como cero ni se resuelve por default).
 *
 * ⚠️ La sospecha razonable es que las de CANINDO estén mal capturadas —ZAMORA tiene la serie
 * completa 501→505 y CANINDO sólo dos, una de ellas sin el prefijo «RUTA»— pero eso lo arregla
 * quien administra el catálogo desde `/dashboard/admin`, no una vista. Cuando se corrija, estas
 * filas dejan de venir marcadas solas y no hay que tocar nada acá.
 *
 * ── Por qué VISTA y no tabla ───────────────────────────────────────────────────────────────
 * Regla principal del proyecto: **cero importers, derivar y no materializar**. Las dos fuentes
 * son tablas propias y vivas; una copia quedaría vieja el día que alguien renombre una ruta desde
 * la pantalla de catálogos. La normalización cuesta dos `regexp_replace` sobre 24 filas.
 *
 * ── La normalización, y por qué así ────────────────────────────────────────────────────────
 * `upper()` → quitar todo lo que no sea A-Z0-9 → quitar el prefijo `RUTA`. Con eso:
 *   `RUTA 21` · `RUTA-21` · `ruta21`  →  `21`
 *   `502`                             →  `502`   (sin prefijo, igual cae en su lugar)
 *   `Ruta Vecinal #1`                 →  `VECINAL1`
 *   `RVPH01`                          →  `RVPH01` (no empieza con RUTA: se respeta entero)
 *
 * ⚠️ Se quita el prefijo **una sola vez** y anclado al inicio: sin el ancla, una ruta que se
 * llamara `RUTA RUTA 3` colapsaría a `3` y se confundiría con otra.
 *
 * ⚠️ `trade.catalogs` y `trade.zones`, NO `public.*`: esos dos son VISTAS de compatibilidad y la
 * regla del repo es nombrar el schema real (ver `feedback_never_name_public_compat_views`).
 */

const VISTA = 'analytics.v_route_warehouse';

/** `upper` → sólo A-Z0-9 → sin el prefijo RUTA. Misma expresión de los dos lados del puente. */
const CLAVE = (col) =>
  `regexp_replace(regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g'), '^RUTA', '')`;

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS
    WITH cat AS (
      SELECT
        c.tenant_id,
        c.id            AS route_catalog_id,
        c.value         AS route_label,
        c.parent_id     AS zona_id,
        z.name          AS zona_name,
        ${CLAVE('c.value')} AS route_key
      FROM trade.catalogs c
      JOIN trade.zones z
        ON z.id = c.parent_id
       AND z.tenant_id = c.tenant_id
       AND z.activo
       AND z.deleted_at IS NULL
      WHERE c.catalog_id = 'rutas'
        AND c.activo
        AND c.deleted_at IS NULL
    ),
    -- Una clave que reclaman dos zonas NO se resuelve: se marca.
    choque AS (
      SELECT tenant_id, route_key
      FROM cat
      GROUP BY 1, 2
      HAVING count(DISTINCT zona_id) > 1
    ),
    alm AS (
      SELECT
        w.tenant_id,
        w.id   AS warehouse_id,
        w.code AS warehouse_code,
        w.name AS warehouse_name,
        ${CLAVE('w.code')} AS route_key
      FROM commercial.warehouses w
      WHERE w.deleted_at IS NULL
        AND w.code LIKE 'RUTA-%'
    )
    SELECT
      cat.tenant_id,
      cat.route_key,
      cat.route_catalog_id,
      cat.route_label,
      cat.zona_id,
      cat.zona_name,
      alm.warehouse_id,
      alm.warehouse_code,
      alm.warehouse_name,
      -- La ruta existe en el catálogo y no vende por almacén (vecinales, mayoreo, RUTA 29).
      (alm.warehouse_id IS NULL)   AS sin_almacen,
      -- ⛔ Dos zonas reclaman esta clave: el consumidor NO debe sumarla a ninguna.
      (ch.route_key IS NOT NULL)   AS ambigua
    FROM cat
    LEFT JOIN alm
      ON alm.route_key = cat.route_key
     AND alm.tenant_id = cat.tenant_id
    LEFT JOIN choque ch
      ON ch.route_key = cat.route_key
     AND ch.tenant_id = cat.tenant_id
  `);

  await knex.raw(`
    COMMENT ON VIEW ${VISTA} IS
    '[JZ.2] Puente ruta del catalogo (trade.catalogs, catalog_id=rutas) <-> almacen que vende (commercial.warehouses RUTA-%). '
    'Normaliza la llave (upper, solo A-Z0-9, sin el prefijo RUTA). NO resuelve las claves que reclaman dos zonas: '
    'las marca ambigua=true para que el consumidor las declare en vez de contarlas dos veces (ADR-056). '
    'Medido 2026-09-15: 24 rutas activas, 13 con almacen, 11 sin almacen, 3 claves ambiguas (501, 502, VECINAL1).'
  `);

  // ⚠️ `security_invoker` ya va en el CREATE, pero el GRANT no se hereda de nada: sin esto el rol
  // de la app no puede leer la vista y el consumidor falla en runtime, no al migrar.
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
