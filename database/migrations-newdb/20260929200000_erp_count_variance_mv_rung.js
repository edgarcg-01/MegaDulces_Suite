'use strict';
/**
 * [IC.12] analytics.mv_erp_physical_count_variance — el descuadre, MATERIALIZADO y con el
 * peldaño del costo DECLARADO.
 *
 * Dos problemas medidos contra prod el 2026-09-29, los dos sobre la misma pantalla
 * (`/almacen/inventory/diferencias`).
 *
 * ── 1. EL DINERO: el ajuste valúa en CAJA una cantidad que declara en PIEZAS ─────────────
 *
 * El documento de ajuste (`N-A-30` / `N-D-30`) trae `c11 = 'PZA'` y un `c12` que es el costo
 * de la CAJA. Como `importe = cantidad × costo_unitario` se cumple en **7,301 de 7,301**
 * renglones de sep-2026, el error entra entero al dinero que la pantalla publica.
 *
 * Arbitrado contra DOS testigos independientes que coinciden al centavo — la captura
 * `N-A-45` del mismo día y la ficha de Kepler (`analytics.v_kepler_standard_cost`, Fase CE):
 *
 *   SKU 02135 (02, 23-sep) · ficha base 5.20 / caja 62.39 (factor 12) · captura 5.20
 *                           · **ajuste 62.39** = el costo de la caja, clavado
 *   SKU 88228 · base 10.53 / caja 105.28 (factor 10) · captura 10.53 · **ajuste 105.28**
 *   SKU 78210 · base  2.36 / caja  47.22 (factor 20) · captura  2.36 · **ajuste 114.29**
 *
 * Y es ASIMÉTRICO, que es lo que fabrica el neto que la Fase IC §6 declara sin explicar
 * (*"por qué el sobrante neto es +$4.35M — no se sabe"*): en sep-2026, con SKUs de factor > 1,
 * **44 renglones de SOBRANTE** están valuados al peldaño caja contra **1 de faltante**.
 * Sólo esos 44 publican $2,475,395 donde a costo de pieza serían $201,512.
 *
 * ⛔ **NO se corrige el importe.** `importe` sigue siendo el que Kepler asentó (ADR-040: no se
 * escribe al SoR, y tampoco se reescribe su número). Lo que se agrega es el VEREDICTO por fila
 * y el contrafactual `importe_en_costo_contado`, para que la pantalla pueda decir cuánto del
 * total está en disputa en vez de publicarlo liso.
 *
 * ── Por qué el testigo es la CAPTURA y no la ficha ───────────────────────────────────────
 *
 * Se ensayaron los dos contra la historia completa. La ficha es la de HOY y los conteos van de
 * nov-2025 a sep-2026: contra ella **12,250 de 22,332 renglones** no caen en ningún peldaño —
 * no porque estén mal, sino porque el costo derivó. La captura es CONTEMPORÁNEA (mismo día,
 * mismo almacén, mismo evento) y por eso arbitra. Ejercido contra prod el 2026-09-29 con el
 * SQL exacto de esta migración:
 *
 *   conteo · coincide        17,910 filas · $15,652,356 pub. vs $15,603,779   (Δ 0.31%)
 *   conteo · peldano_arriba     338 filas · $ 6,845,043 pub. vs $   487,714   → **$6,357,329**
 *   conteo · difiere          3,883 filas · $ 2,897,418 pub. vs $ 3,119,790   (−$222k, neto chico)
 *   conteo · peldano_abajo      183 filas · $    63,662 pub. vs $   511,604
 *   conteo · sin_testigo         18 filas · $   236,734 → NULL, declarado
 *
 * Dos cosas que ese cuadro prueba y que no son el titular: el bucket `coincide` **reproduce el
 * dinero publicado** (Δ 0.31%), o sea que el testigo no está sesgado; y `difiere` neta −$222k
 * repartido en las dos direcciones, que es exactamente la forma de una deriva de costo y no la
 * de un peldaño.
 *
 * ⭐ **El control de placebo, que es lo que vuelve creíble la regla:** sobre las CARGAS
 * INICIALES —que por construcción cuadran consigo mismas, captura == entrada línea por línea—
 * la misma regla da **`peldano_arriba` = 0 de 8,643**, y sus 8,629 `coincide` reproducen
 * $30,759,519 publicados con **$7 de diferencia**. Si esto fuera ruido marcaría las dos
 * poblaciones por igual: marca 338 renglones en los conteos y CERO en las cargas.
 *
 * ── 2. EL TIEMPO: la pantalla abría en 2.2 s contra un gate de 1 s ──────────────────────
 *
 * Medido en prod, dos corridas: `summary()` 2.02–2.24 s · `events()` 1.88 s · `detail()`
 * 1.39 s · `kpi()` 1.93 s. Del `EXPLAIN`: el plan **re-deriva la escalera entera del ODS una
 * vez por almacén** (`loops=8`) y el `LEFT JOIN catalog.products` cuesta ~480 ms aunque
 * `summary()` no selecciona `product_id` (el `deleted_at IS NULL` impide que el planificador
 * elimine el join). La única pestaña rápida era la ya materializada (roll-forward, 40 ms).
 *
 * Materializar por COSTO es legítimo (GOTCHAS §32: el pecado es materializar un valor
 * INVENTADO). Acá no hay valor nuevo: es la misma vista `v_erp_physical_count_variance`, más
 * dos testigos con nombre y origen. Y el dato sólo cambia cuando Kepler emite un conteo, que
 * es **cada tres meses** — un refresco nocturno sobra.
 *
 * El poblado cuesta **~92 s** medidos (el CTE `capt` recorre todos los `N-A-45` de la historia),
 * contra 30,975 filas de salida. Por eso va en el lote NOCTURNO y no en el de 15 min: el pool
 * admin es 0-2, y ocuparlo minuto y medio en horario hábil ya costó una vez 2.6 min por request
 * de sell-out.
 *
 * ⚠️ Su umbral queda registrado en `CRON_JOBS` (`analytics_refresh_count_variance`). Sin esa
 * fila el sensor cae en `cfg ? classify : 'ok'` y una MV parada se ve VERDE (lección OBS.1).
 *
 * ── 3. De paso, dos defectos que la materialización arregla por construcción ────────────
 *
 *  a) `contado` y `teorico` los calculaba `InventoryVarianceService.detail()` en SQL crudo,
 *     con el CTE `capt` filtrado por SUCURSAL y no por ALMACÉN. Hoy no explota (medido: 0
 *     fechas con dos almacenes), pero Padre Hidalgo tiene la tienda `01` y la Ruta 28
 *     `01-006`: el día que cuenten juntos, el «se contó» de la tienda sumaría el de la ruta.
 *     Acá la llave del testigo lleva el almacén. Una definición, no dos.
 *  b) La vista no exponía la identidad de RENGLÓN. Se agregan `serie` (`c5`) y `linea` (`c7`):
 *     con eso (sucursal, almacén, signo, serie, folio, línea) ES la PK de `kdm2` menos las
 *     columnas constantes, y el índice único del REFRESH CONCURRENTLY es estructural en vez
 *     de depender de que ningún documento repita un SKU (hoy no lo repite; en 2026-01-29 el
 *     mismo evento ya trae 2,658 renglones sobre 2,289 SKUs distintos).
 *
 * Aditiva y reversible: agrega dos columnas al final de una vista SIN dependientes (medido
 * con `pg_depend`: 0) y crea una matview nueva.
 */

// El SELECT de la vista, en un solo lugar: `up` le agrega `serie`/`linea` y `down` lo repone
// sin ellas. Una vista se instala entera en cada migración que la toca, así que la alternativa
// era copiar sesenta líneas dos veces y que una de las dos se quedara vieja.
const SELECT_VISTA = (cols) => `
    WITH doc AS (
      -- Un renglón por documento (sucursal, ALMACEN, fecha, doctype). El almacen es parte de
      -- la identidad: sin el, dos documentos distintos con el mismo folio se funden.
      -- ⛔ SIN el folio en el GROUP BY: un mismo evento puede traer DECENAS de folios del
      -- mismo doctype (medido: 64 en la 02 del 2026-01-08, 62 en nov-2025). Agrupando por
      -- folio y sacando despues max() se compara el folio MAS GRANDE de captura contra el
      -- mas grande de entrada, en vez del total del evento -- y la firma de carga inicial
      -- deja de significar lo que dice. Lo destapo el candado cruzado con IC.3.
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, m.c3 AS nat, m.c4 AS tipo_doc,
             count(l.*)::int AS lineas
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
       WHERE m.c2 = 'N' AND m.c4 IN ('30', '45') AND m.c3 IN ('A', 'D')
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       GROUP BY 1, 2, 3, 4, 5
    ),
    firma AS (
      -- CARGA INICIAL: la entrada replica la captura (mas menos una linea) y no hay faltante.
      -- Un conteo trimestral deja la entrada muy por debajo de la captura.
      SELECT d.sucursal, d.almacen, d.fecha,
             max(d.lineas) FILTER (WHERE d.tipo_doc = '45' AND d.nat = 'A') AS cap,
             max(d.lineas) FILTER (WHERE d.tipo_doc = '30' AND d.nat = 'A') AS ent,
             coalesce(max(d.lineas) FILTER (WHERE d.tipo_doc = '30' AND d.nat = 'D'), 0) AS sal
        FROM doc d GROUP BY 1, 2, 3
    )
    SELECT w.tenant_id,
           w.id                                   AS warehouse_id,
           w.code                                 AS warehouse_code,
           w.name                                 AS warehouse_name,
           m.sucursal                             AS kepler_sucursal,
           m.c1                                   AS kepler_almacen,
           m.c9::date                             AS fecha,
           m.c6                                   AS folio,
           CASE WHEN f.cap IS NOT NULL AND f.ent IS NOT NULL
                     AND abs(f.cap - f.ent) <= 1 AND f.sal = 0
                THEN 'carga_inicial' ELSE 'conteo' END                 AS tipo_evento,
           CASE WHEN m.c3 = 'A' THEN 'sobrante' ELSE 'faltante' END    AS signo,
           pr.id                                  AS product_id,
           btrim(l.c8)                            AS sku,
           l.c10                                  AS descripcion,
           l.c11                                  AS unidad_erp,
           l.c9::numeric                          AS cantidad,
           l.c12::numeric                         AS costo_unitario,
           l.c13::numeric                         AS importe${cols}
      FROM kepler_ods.kdm1 m
      JOIN kepler_ods.kdm2 l
        ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
       AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
      JOIN firma f
        ON f.sucursal = m.sucursal AND f.almacen = m.c1 AND f.fecha = m.c9::date
      JOIN commercial.warehouses w
        ON w.kepler_code = m.sucursal
       AND w.kepler_code <> '00'   -- OFICINAS, no el CEDIS: su existencia es un artefacto
       AND w.deleted_at IS NULL
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id AND pr.sku = btrim(l.c8) AND pr.deleted_at IS NULL
     WHERE m.c2 = 'N' AND m.c4 = '30' AND m.c3 IN ('A', 'D')
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       AND btrim(l.c8) <> ALL (ARRAY['00001', '00002', '00022'])`;

const COLS_NUEVAS = `,
           l.c5                                   AS serie,
           l.c7                                   AS linea`;

// Umbrales del veredicto. **Medidos, no elegidos de oído**, y son DOS cortes distintos porque
// son dos afirmaciones distintas:
//   · `difiere`  (fuera de 0.90–1.10) = "el costo no es el que la captura implica". La banda
//     de adentro es la deriva de costo entre la captura y el ajuste: 991 de 1,144 renglones
//     del evento 02/2026-09-23 caen ahí, con el 99% entre 0.99 y 1.01.
//   · `peldano_arriba` (>= 2) = "el costo es de OTRO peldaño de la escalera". El 2 sale de la
//     Fase CE, que midió el factor de caja mínimo del catálogo en **2.00, cero pares por
//     debajo**: una razón menor a 2 no PUEDE ser un salto de peldaño. Afirmar el peldaño con
//     un corte de 1.10 sería afirmar de más.
const BANDA_BAJA = 0.90;
const BANDA_ALTA = 1.10;
const PELDANO_MIN = 2.0;

exports.up = async function up(knex) {
  // `CREATE SCHEMA IF NOT EXISTS` pide el privilegio CREATE sobre la base AUNQUE el schema ya
  // exista — Postgres valida el permiso antes que la condición.
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('kepler_ods.kdm2') IS NOT NULL
        AND to_regclass('commercial.warehouses') IS NOT NULL
        AND to_regclass('analytics.v_erp_physical_count_variance') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta kepler_ods.kdm1/kdm2 o la vista base de IC.0 — matview omitida');
    return;
  }

  // ── 1. La vista base gana la identidad de renglón (aditivo: las columnas van al final) ──
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_erp_physical_count_variance
      WITH (security_invoker = true) AS ${SELECT_VISTA(COLS_NUEVAS)}`);
  // ⚠️ ADR-057: tras un `CREATE OR REPLACE VIEW` se re-aplican `security_invoker` y el GRANT.
  // Con REPLACE el objeto persiste y los conserva, pero re-aplicarlos es idempotente y barato,
  // y ya hubo una migración de esa familia que perdió el `security_invoker` en silencio.
  await knex.raw(`ALTER VIEW analytics.v_erp_physical_count_variance
      SET (security_invoker = true)`);
  await knex.raw('GRANT SELECT ON analytics.v_erp_physical_count_variance TO app_runtime');

  // ── 2. La matview: la vista + los dos testigos ──────────────────────────────────────────
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_physical_count_variance');
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_physical_count_variance AS
    WITH capt AS (
      -- EL TESTIGO CONTEMPORANEO: lo que la captura N-A-45 dice de ese SKU ESE dia en ESE
      -- almacen. La llave lleva el almacen (c1), no solo la sucursal: es lo que impide que
      -- la tienda 01 sume la captura de la Ruta 28 (01-006).
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, btrim(l.c8) AS sku,
             sum(l.c9::numeric)  AS contado,
             sum(l.c13::numeric) AS importe_contado
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
       WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45'
         AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       GROUP BY 1, 2, 3, 4
    ),
    base AS (
      SELECT v.*,
             c.contado,
             -- Costo implícito de lo CONTADO. NULL si no hay unidades: una división por cero
             -- no se dibuja como cero (ADR-056).
             -- ⛔ Y NULL tambien si la captura valuo el renglon en CERO. Un costo de cero no es
             -- un testigo: no puede arbitrar una razon. Medido: 16 renglones en la ventana de
             -- 60 dias. Dejarlo en 0 hacia que costo_contado existiera mientras el veredicto
             -- decia sin_testigo -- dos columnas contando historias distintas de la misma
             -- fila, que es como se cuela un numero sin respaldo a una pantalla.
             CASE WHEN c.contado > 0 AND c.importe_contado > 0
                  THEN round(c.importe_contado / c.contado, 6) END       AS costo_contado,
             k.costo_estandar    AS ficha_costo_base,
             k.costo_estandar_u2 AS ficha_costo_caja,
             k.factor_dos        AS ficha_factor_caja,
             k.unidad_base       AS ficha_unidad_base
        FROM analytics.v_erp_physical_count_variance v
        LEFT JOIN capt c
          ON c.sucursal = v.kepler_sucursal AND c.almacen = v.kepler_almacen
         AND c.fecha = v.fecha AND c.sku = v.sku
        -- La ficha CORROBORA (dice en qué peldaño está el costo), no arbitra: es la de hoy y
        -- los conteos son de hasta diez meses atrás.
        LEFT JOIN analytics.v_kepler_standard_cost k
          ON k.sucursal = v.kepler_sucursal AND k.sku = v.sku
    )
    SELECT b.*,
           -- EL TEÓRICO, derivado: Kepler no lo guarda (se revisaron las 38 columnas de la
           -- línea de captura). Un sobrante se contó de MÁS; un faltante, de menos.
           CASE WHEN b.contado IS NULL THEN NULL
                WHEN (CASE WHEN b.signo = 'sobrante' THEN b.contado - b.cantidad
                           ELSE b.contado + b.cantidad END) < 0 THEN NULL
                ELSE (CASE WHEN b.signo = 'sobrante' THEN b.contado - b.cantidad
                           ELSE b.contado + b.cantidad END) END          AS teorico,
           CASE WHEN b.contado IS NULL
                  THEN 'el SKU no aparece en la captura de ese dia'
                WHEN (CASE WHEN b.signo = 'sobrante' THEN b.contado - b.cantidad
                           ELSE b.contado + b.cantidad END) < 0
                  THEN 'no reconstruible: el ajuste excede lo contado (captura y ajuste con distinto grano)'
                ELSE NULL END                                            AS teorico_salvedad,
           -- LA RAZÓN, que es el dato crudo del que sale el veredicto. Va expuesta para que
           -- cualquiera pueda juzgar la fila sin creerle a la etiqueta.
           CASE WHEN b.costo_contado > 0
                THEN round(b.costo_unitario / b.costo_contado, 4) END     AS razon_costo,
           -- EL CONTRAFACTUAL: lo que ese renglón valdría al costo que la captura implica.
           -- NO reemplaza a importe: lo acompana, para poder decir cuanto esta en disputa.
           CASE WHEN b.costo_contado > 0
                THEN round(b.cantidad * b.costo_contado, 2) END           AS importe_en_costo_contado,
           -- En que peldano de la FICHA cae el costo del ajuste. base se evalua PRIMERO: con
           -- factor 1 el costo de caja es igual al base, y sin ese orden un SKU sano se
           -- clasificaría como caja. (Ese fue un falso positivo real de la primera medición.)
           CASE WHEN b.ficha_costo_base IS NULL THEN 'sin_ficha'
                WHEN b.ficha_costo_base > 0
                     AND abs(b.costo_unitario - b.ficha_costo_base) <= 0.02 * b.ficha_costo_base
                  THEN 'base'
                WHEN b.ficha_factor_caja > 1 AND b.ficha_costo_caja > 0
                     AND abs(b.costo_unitario - b.ficha_costo_caja) <= 0.02 * b.ficha_costo_caja
                  THEN 'caja'
                ELSE 'ninguno' END                                        AS ficha_peldano,
           -- EL VEREDICTO. Cinco estados y ninguno es "todo bien por omisión": sin testigo se
           -- dice sin_testigo, no coincide.
           CASE WHEN b.costo_contado IS NULL OR b.costo_contado <= 0 THEN 'sin_testigo'
                WHEN b.costo_unitario / b.costo_contado >= ${PELDANO_MIN} THEN 'peldano_arriba'
                WHEN b.costo_unitario / b.costo_contado <= 1.0 / ${PELDANO_MIN} THEN 'peldano_abajo'
                WHEN b.costo_unitario / b.costo_contado > ${BANDA_ALTA}
                  OR b.costo_unitario / b.costo_contado < ${BANDA_BAJA} THEN 'difiere'
                ELSE 'coincide' END                                       AS costo_veredicto
      FROM base b`);

  // (sucursal, almacén, signo, serie, folio, línea) es la PK de `kdm2` menos las columnas que
  // el WHERE fija (`c2='N'`, `c4='30'`), así que la unicidad es estructural, no una apuesta.
  await knex.raw(`CREATE UNIQUE INDEX uq_mv_count_variance
    ON analytics.mv_erp_physical_count_variance
       (tenant_id, kepler_sucursal, kepler_almacen, signo, serie, folio, linea)`);
  await knex.raw(`CREATE INDEX ix_mv_count_variance_evento
    ON analytics.mv_erp_physical_count_variance (tenant_id, warehouse_id, fecha)`);
  await knex.raw(`CREATE INDEX ix_mv_count_variance_sku
    ON analytics.mv_erp_physical_count_variance (tenant_id, warehouse_id, sku)`);
  await knex.raw(
    'GRANT SELECT ON analytics.mv_erp_physical_count_variance TO app_runtime');

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_physical_count_variance IS
    'IC.12 - El descuadre del conteo fisico, materializado, con el peldano del costo declarado. Arbitro = la CAPTURA N-A-45 del mismo dia/almacen/SKU (contemporanea); la ficha kdii (v_kepler_standard_cost) solo corrobora, porque es la de hoy y los conteos llegan a diez meses atras. costo_veredicto: coincide / difiere / peldano_arriba / peldano_abajo / sin_testigo - NUNCA verde por omision. importe NO se corrige (ADR-040): se acompana con importe_en_costo_contado para poder decir cuanto esta en disputa. Medido en prod 2026-09-29 con este mismo SQL: en los CONTEOS, 338 renglones caen en peldano_arriba y publican $6,845,043 donde al costo contado serian $487,714 (expuesto $6,357,329); el bucket coincide reproduce lo publicado con 0.31% de diferencia. CONTROL DE PLACEBO: sobre las CARGAS INICIALES -que cuadran consigo mismas por construccion- peldano_arriba da CERO de 8,643 y coincide reproduce $30,759,519 con $7 de diferencia. Materializada por COSTO: la pantalla abria en 2.2 s contra un gate de 1 s porque el plan re-derivaba el ODS una vez por almacen. Una matview no soporta RLS: el servicio filtra por tenant a mano.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_physical_count_variance');
  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_erp_physical_count_variance') IS NOT NULL AS hay`)).rows;
  if (!hay) return;
  // `CREATE OR REPLACE VIEW` no sabe QUITAR columnas, y la vista no tiene dependientes
  // (medido con pg_depend: 0), asi que se repone entera sin `serie`/`linea`.
  await knex.raw('DROP VIEW analytics.v_erp_physical_count_variance');
  await knex.raw(`CREATE VIEW analytics.v_erp_physical_count_variance
      WITH (security_invoker = true) AS ${SELECT_VISTA('')}`);
  await knex.raw('GRANT SELECT ON analytics.v_erp_physical_count_variance TO app_runtime');
};
