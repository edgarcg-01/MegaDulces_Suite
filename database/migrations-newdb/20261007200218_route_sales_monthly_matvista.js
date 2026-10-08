'use strict';
/**
 * ⛔⛔ **REVERTIDA POR `[RR.31]` (migracion 20261007201545). No la copies como ejemplo.**
 *
 * Esta migracion se aplico en prod (batch 804) y su objeto se tiro 4 minutos despues. El archivo
 * se conserva porque `knex_migrations` la tiene registrada y borrarlo deja el directorio
 * "corrupt" -- no porque sirva.
 *
 * **Por que estuvo mal, en una linea:** la medicion que la justificaba (44,773 ms) era de la
 * rama `if (factFilter)` de `salesByRoute`, que solo corre al filtrar por SKU o cliente. La
 * consulta que de verdad abre la pantalla cuesta **1,101 ms**, y encima ya se servia desde
 * `analytics.sales_by_route_monthly` -- o sea que esto materializo una SEGUNDA copia de algo ya
 * materializado. El detalle completo esta en la cabecera de `[RR.31]`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Lo que decia cuando se escribio, conservado tal cual:
 *
 * `[RR.30]` — **Ventas por ruta tardaba 45 SEGUNDOS para dibujar 232 renglones.**
 *
 * ── Lo medido (prod, 2026-10-07, con EXPLAIN ANALYZE DENTRO del pod, sin red de por medio) ──
 *
 *  · La consulta que la pantalla hace al abrir: **44,773 ms**. El gate del proyecto es 500 ms,
 *    o sea **90 veces**.
 *  · Procesa **623,828 filas** para devolver **232** (ruta x mes).
 *  · `analytics.v_route_sales_lines` es una VISTA sobre otra vista (`wincaja.v_sales_lines`) mas
 *    `wincaja.articulos`, `pagos_dia`, `formas_pago`, `analytics.route_push_lines` (230k),
 *    `catalog.products` y `analytics.v_kepler_vecinal_sales_lines`. Por debajo hay 1.5M de
 *    movimientos de Wincaja.
 *  · El planificador estima **102,643** filas en un nodo y salen **3,341,621** -- 32x corto --
 *    asi que elige nested loops donde haria falta un hash join.
 *
 * ⛔ **No se arregla con un indice ni afinando el plan.** Aunque el optimizador acertara, sigue
 * habiendo que recorrer 600k filas desde vistas apiladas sobre millones. Lo que no se puede
 * hacer rapido es la pregunta; lo que si, es no volver a hacerla en cada apertura.
 *
 * ── El grano, y por que este ───────────────────────────────────────────────────────────────
 *
 * El agregado completo (2025 + 2026, los unicos anios con datos reales: los movimientos de 1999,
 * 2014, 2020, 2024 y 2029 suman 505 filas de basura) cuesta **93.5 s** y produce **~500 filas**.
 * Se materializa con el anio DENTRO del grano para que el selector de anio de la pantalla siga
 * funcionando sin volver a la fuente.
 *
 * ⚠️ `tickets` es un `count(DISTINCT consecutivo)` POR MES: **no se puede sumar entre meses**.
 * Ya era asi en la consulta que esto reemplaza (agrupaba por mes), pero al materializarlo queda
 * guardado y se vuelve facil de sumar por error. Quien quiera tickets de un trimestre tiene que
 * ir a la fuente, no sumar tres filas de aca.
 *
 * ⚠️ El corte `business_date <= CURRENT_DATE` se evalua **al refrescar**, no al consultar: saca
 * la venta con fecha futura (hay movimientos de 2029 en Wincaja). Con refresco cada 30 min el
 * corte esta al dia; si algun dia se espacia, esta linea es lo primero que hay que mirar.
 *
 * ⚠️ **La rama de filtro por producto o cliente NO pasa por aca.** `salesByRoute` se bifurca con
 * `factFilter` y re-agrega en vivo desde `v_sales_lines`; esa rama sigue igual de lenta y queda
 * DECLARADA, no disimulada: filtrar por SKU es una pregunta distinta y con otro grano.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const MAT = 'analytics.mv_route_sales_monthly';
/** El primer anio con datos reales. Antes hay 505 filas de basura en 1999/2014/2020/2024. */
const DESDE = '2025-01-01';
const GATE_MS = 500;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // Construirla cuesta ~93 s y es una LECTURA larga, no una escritura pesada: toma ACCESS SHARE
  // sobre las fuentes y no bloquea al CDC. El timeout por statement se suelta a proposito.
  await knex.raw(`SET LOCAL statement_timeout = 0`);

  const { rows: [hay] } = await knex.raw(
    `SELECT to_regclass('analytics.v_route_sales_lines') IS NOT NULL AS si`);
  if (!hay.si) throw new Error('[RR.30] falta analytics.v_route_sales_lines');

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MAT} AS
    WITH rutas AS (
      -- Calcado del CTE de salesByRoute, con tenant_id adentro: la matvista sirve a todos los
      -- tenants y sin el la llave no seria unica.
      SELECT b.tenant_id, b.source_branch, w.code AS wcode,
             COALESCE(w.name, initcap(pb.branch_name)) AS wname
        FROM wincaja.branches b
        JOIN wincaja.branches pb ON pb.tenant_id = b.tenant_id AND pb.source_branch = b.parent_branch
        LEFT JOIN commercial.warehouses w ON w.tenant_id = b.tenant_id
             AND w.code = COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
       WHERE b.is_route = true AND COALESCE(b.source_branch,'') !~ '^[0-9]V[0-9]'
       UNION
      SELECT v.tenant_id, v.route_no, v.warehouse_code, w.name
        FROM analytics.v_kepler_vecinal_monthly v
        JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id
         AND w.code = v.warehouse_code AND w.deleted_at IS NULL
    )
    SELECT sl.tenant_id, r.wcode, r.wname,
           ('WIN-' || sl.source_branch)        AS route_code,
           sl.source_branch                    AS route_no,
           to_char(sl.business_date,'YYYY')    AS anio,
           to_char(sl.business_date,'MM')      AS mes,
           sum(sl.importe)                     AS revenue,
           sum(sl.qty)                         AS units,
           count(DISTINCT sl.consecutivo)      AS tickets
      FROM analytics.v_route_sales_lines sl
      JOIN rutas r ON r.tenant_id = sl.tenant_id AND r.source_branch = sl.source_branch
     WHERE sl.sale_channel = 'ruta_venta'
       AND sl.business_date >= DATE '${DESDE}'
       AND sl.business_date <= CURRENT_DATE
     GROUP BY 1,2,3,4,5,6,7`);

  // UNIQUE para habilitar REFRESH CONCURRENTLY: sin el, cada refresco bloquea la pantalla.
  await knex.raw(`CREATE UNIQUE INDEX mv_route_sales_monthly_pk
    ON ${MAT} (tenant_id, wcode, route_no, anio, mes)`);
  await knex.raw(`CREATE INDEX mv_route_sales_monthly_anio ON ${MAT} (tenant_id, anio)`);
  await knex.raw(`ANALYZE ${MAT}`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MAT} IS
    'RR.30 - el tablero de Ventas por ruta (ruta x mes x anio). La consulta viva tardaba 44,773 ms para devolver 232 filas: vista sobre vistas sobre 1.5M de movimientos Wincaja, con el planificador estimando 32x corto. tickets es un count(DISTINCT) POR MES y NO se puede sumar entre meses. El corte de fecha futura se evalua al REFRESCAR.'`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO dev_ro`);

  // ── Freno 1: tiene datos y de los anios que importan ─────────────────────────────────────
  const { rows: [res] } = await knex.raw(`
    SELECT count(*)::int AS filas, count(DISTINCT anio)::int AS anios,
           count(DISTINCT route_no)::int AS rutas, round(sum(revenue))::bigint AS revenue
      FROM ${MAT}`);
  if (Number(res.filas) === 0) throw new Error('[RR.30] la copia quedo VACIA: la fuente no devolvio nada');
  if (Number(res.rutas) < 2) throw new Error(`[RR.30] solo ${res.rutas} ruta(s): el CTE de rutas no esta casando`);
  console.log(`  · [RR.30] ${res.filas} filas · ${res.anios} anio(s) · ${res.rutas} rutas · revenue ${res.revenue}`);

  // ── Freno 2: PARIDAD contra lo que la pantalla publica HOY ───────────────────────────────
  //
  // ⛔ La primera version de este freno comparaba contra un CTE de rutas SIMPLIFICADO (sin
  // `wcode`) y fallo: viva 55,962,053 vs copia 68,811,198. **El freno tenia razon pero medía
  // otra cosa**, y al investigar aparecio un defecto de la pantalla que es anterior a esta
  // migracion -- esta documentado abajo, en el bloque de declaracion.
  //
  // Una optimizacion NO puede cambiar una cifra publicada: eso es un commit aparte (regla del
  // proyecto). Asi que la paridad se mide contra la consulta **exacta** del servicio, con su
  // mismo CTE de cuatro columnas. Si algun dia alguien arregla la duplicacion, este freno se
  // pone rojo y obliga a decidirlo a proposito, no de costado.
  const anio = new Date(Date.now() - 6 * 3600 * 1000).getUTCFullYear();
  const { rows: [par] } = await knex.raw(`
    WITH rutas AS (
      SELECT b.tenant_id, b.source_branch, w.code AS wcode,
             COALESCE(w.name, initcap(pb.branch_name)) AS wname
        FROM wincaja.branches b
        JOIN wincaja.branches pb ON pb.tenant_id = b.tenant_id AND pb.source_branch = b.parent_branch
        LEFT JOIN commercial.warehouses w ON w.tenant_id = b.tenant_id
             AND w.code = COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
       WHERE b.is_route = true AND COALESCE(b.source_branch,'') !~ '^[0-9]V[0-9]'
       UNION
      SELECT v.tenant_id, v.route_no, v.warehouse_code, w.name
        FROM analytics.v_kepler_vecinal_monthly v
        JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id
         AND w.code = v.warehouse_code AND w.deleted_at IS NULL
    ), viva AS (
      SELECT round(sum(sl.importe))::bigint AS revenue
        FROM analytics.v_route_sales_lines sl
        JOIN rutas r ON r.tenant_id = sl.tenant_id AND r.source_branch = sl.source_branch
       WHERE sl.sale_channel = 'ruta_venta'
         AND sl.business_date >= DATE '${anio}-01-01' AND sl.business_date <= CURRENT_DATE
    ), copia AS (
      SELECT round(sum(revenue))::bigint AS revenue FROM ${MAT} WHERE anio = '${anio}'
    )
    SELECT viva.revenue AS viva, copia.revenue AS copia FROM viva, copia`);
  if (String(par.viva) !== String(par.copia)) {
    throw new Error(`[RR.30] la copia NO cuadra con la pantalla en ${anio}: viva ${par.viva} vs copia ${par.copia}`);
  }
  console.log(`  · [RR.30] paridad OK en ${anio}: ${par.copia} (la copia publica exactamente lo mismo que hoy)`);

  // ── DECLARACION: el defecto que esta migracion NO arregla, medido ────────────────────────
  //
  // ⛔ El CTE de rutas trae **35 filas para 22 rutas**: las VECINALES aparecen repetidas, una
  // por plaza (`1V002` sale con los almacenes 01, 02, 03, 04 y 05). Como el join es por
  // `source_branch` a secas, la venta de esa ruta se multiplica por la cantidad de plazas.
  //
  // En pantalla salen como renglones separados, asi que no se ve raro -- pero **la suma de la
  // columna cuenta la misma venta hasta cinco veces**. Medido en 2026: la pantalla publica
  // 68.8 M y el total sin duplicar es 56.0 M; **12.8 M de mas, un 23%**.
  //
  // No se arregla aca a proposito: esto es una optimizacion y arreglarlo cambia cifras que
  // alguien esta leyendo. Se mide, se imprime y se decide aparte.
  const { rows: [dup] } = await knex.raw(`
    WITH rutas AS (
      SELECT b.tenant_id, b.source_branch, w.code AS wcode
        FROM wincaja.branches b
        JOIN wincaja.branches pb ON pb.tenant_id = b.tenant_id AND pb.source_branch = b.parent_branch
        LEFT JOIN commercial.warehouses w ON w.tenant_id = b.tenant_id
             AND w.code = COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
       WHERE b.is_route = true AND COALESCE(b.source_branch,'') !~ '^[0-9]V[0-9]'
       UNION
      SELECT v.tenant_id, v.route_no, v.warehouse_code
        FROM analytics.v_kepler_vecinal_monthly v
        JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id
         AND w.code = v.warehouse_code AND w.deleted_at IS NULL
    )
    SELECT count(*)::int AS filas, count(DISTINCT source_branch)::int AS rutas FROM rutas`);
  if (Number(dup.filas) > Number(dup.rutas)) {
    console.log(`  · [RR.30] ⚠️ DECLARADO: el CTE trae ${dup.filas} filas para ${dup.rutas} rutas — las vecinales se repiten por plaza y la SUMA de la columna las cuenta varias veces. No se arregla en una optimizacion.`);
  }

  // ── Freno 3: PROPOSITO. La consulta de la pantalla entra en el gate ──────────────────────
  const SEL = `SELECT wcode, wname, route_code, route_no, mes, revenue, units, tickets
                 FROM ${MAT} WHERE anio = '${anio}' ORDER BY wcode, route_no, mes`;
  const t = Date.now();
  const { rows: pant } = await knex.raw(SEL);
  const ms = Date.now() - t;
  const { rows: plan } = await knex.raw(`EXPLAIN (ANALYZE) ${SEL}`);
  const exec = /Execution Time: ([\d.]+) ms/.exec(plan.map((r) => r['QUERY PLAN']).join('\n'));
  console.log(`  · [RR.30] la pantalla: ${pant.length} filas · cliente ${ms} ms · servidor ${exec ? exec[1] : '?'} ms (antes 44,773 ms)`);
  if (ms > GATE_MS) {
    throw new Error(`[RR.30] la pantalla sigue en ${ms} ms: no alcanza el gate de ${GATE_MS} ms`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Las vistas fuente quedan intactas. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
};
