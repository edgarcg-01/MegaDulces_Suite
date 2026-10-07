'use strict';
/**
 * `[WH.2b]` — **La venta histórica de Wincaja, derivada. Sin importer, sin copia.**
 *
 * `analytics.v_wincaja_hist_sales`: un renglón por (sucursal, día, artículo, ticket) leyendo por
 * FDW el espejo `wincaja` que vive en `pgvector-md`. **No copia nada** — regla principal del
 * proyecto. El corpus es CERRADO (Wincaja dejó de ser fuente viva cuando cada sucursal migró a
 * Kepler: `w32` 2026-09-08 · `w30` 2026-09-18 · `w00` 2026-09-30), así que una vista derivada
 * nunca se queda vieja.
 *
 * ⛔ **ESTA VISTA NO ES PARA CONSULTA INTERACTIVA.** Son ~9.7 M de tickets y ~60 M de renglones
 * al otro lado de un FDW, y `postgres_fdw` empuja poco agregado. Es la DEFINICIÓN, auditable y
 * en el repo; quien la consume es la matvista de `[WH.4]`. Leerla directo desde una pantalla está
 * dos órdenes de magnitud por encima del gate de 500 ms.
 *
 * ── Las cinco decisiones que trae adentro, todas medidas (ver FASE_WH) ───────────────────────
 *
 * 1. **El dinero es `ValorVenta`, SIN impuesto.** `IVA` e `IEPS` viajan aparte y se exponen por
 *    separado. Arbitrado por el margen contra `ValorCosto`: 10.2–10.4 %, consistente con el
 *    ~11.5 % que reporta el negocio. Placebo contra el carril vivo: cuadra al peso (Δ $0 en
 *    crédito y preventa; Δ $704 de redondeo en mostrador).
 *
 * 2. **El día sale de la FECHA, no del nombre del corte.** Medido: las carpetas-año traen
 *    ≥99.9 % de su año, pero el residuo existe (2020 tiene 1,059 tickets de otro año). El
 *    `_dataset` sirve para identidad, nunca para fechar.
 *    ⚠️ `Fecha` es TEXTO `MM/DD/YY HH:MM:SS` con año de DOS dígitos.
 *
 * 3. **Dedup por identidad, no por lista negra.** `DISTINCT ON (sucursal, Documento, Caja, fecha)`
 *    prefiriendo el corte anual. Medido: 10,055,420 filas → **9,724,420 tickets únicos**, y los
 *    187,000 repetidos cuadran al ticket con los cinco cortes de nombre propio. Borrar esos cortes
 *    daría el mismo número hoy, pero exige mantener una lista a mano y pierde el ticket huérfano
 *    de La Piedad. La identidad no necesita que nadie la mantenga.
 *
 * 4. **Venta vs. movimiento interno lo decide el PADRÓN, no la caja ni el nombre ni el código.**
 *    `analytics.wincaja_internal_parties` por el par `(sucursal, tercero)` — ver `[WH.3]` para las
 *    tres reglas más simples que se midieron y fallaron. Lo que no está en el padrón es
 *    `venta_cliente`; lo que está como `sin_clasificar` **se marca y NO se suma a la venta**.
 *
 * 5. **La cota de cordura es un VEREDICTO, no un filtro.** Dos renglones de ~67 millones
 *    (`h10` 2025, `Articulo` 83400 duplicado, `CantidadRegular` = 207 billones) inflan la venta en
 *    **$1.99 billones**. Se marcan `fuera_de_rango` **con su importe visible**, no se borran: un
 *    peso que desaparece sin que nadie lo note es peor que uno mal clasificado (ADR-056).
 *
 * ── Lo que esta vista NO decide, y se DECLARA ────────────────────────────────────────────────
 * **El canal** (`wincaja_mostrador` / `_credito` / `_preventa`). Está medido al peso en Padre
 * Hidalgo —caja 70 → crédito, caja 15 → preventa, cajas 10/12/13/14 → mostrador— pero **no está
 * probado que generalice**, y PH tiene 20 cajas distintas en nueve años. Por eso la vista expone
 * `caja` y `doc_prefijo` crudos y **no inventa un canal**. Lo resuelve `[WH.2c]` con el mismo
 * placebo en otra sucursal, antes de que `[WH.4]` escriba una sola fila en `sales_daily`.
 *
 * Sin RLS (patrón `analytics.*`: tenant explícito). `security_invoker` para que la vista no
 * preste privilegios del dueño.
 *
 * @param { import("knex").Knex } knex
 */

const MD = '00000000-0000-0000-0000-00000000d01c';

/** sucursal publicada ← schema foráneo del espejo. El CEDIS entra: su exclusión se DECLARA. */
const SUCURSALES = [
  ['00', 'wincaja_h00'], ['01', 'wincaja_h10'], ['02', 'wincaja_h42'],
  ['03', 'wincaja_h40'], ['04', 'wincaja_h44'], ['05', 'wincaja_h54'],
  ['06', 'wincaja_h50'], ['07', 'wincaja_h32'], ['08', 'wincaja_h30'],
];

/** Los nueve cortes anuales. `Actuales` y `Concentradas` NO entran: son 2026 y ya están en el fact. */
const CORTES_FUERA = `'Actuales','Concentradas'`;

function cabecerasDe([sucursal, schema]) {
  return `
    SELECT '${sucursal}'::text                          AS sucursal,
           m."_dataset"                                 AS dataset,
           m."Consecutivo"                              AS consecutivo,
           btrim(m."Documento"::text)                         AS documento,
           btrim(m."Caja"::text)                              AS caja,
           btrim(m."Tercero"::text)                           AS tercero,
           to_date(left(m."Fecha"::text, 8), 'MM/DD/YY')      AS fecha
      FROM ${schema}."MaestroMovAlmacen" m
     WHERE m."Tipo" = 'V'
       AND m."_dataset" NOT IN (${CORTES_FUERA})`;
}

function renglonesDe([sucursal, schema]) {
  return `
    SELECT '${sucursal}'::text AS sucursal, d."_dataset" AS dataset, d."Consecutivo" AS consecutivo,
           btrim(d."Articulo"::text) AS articulo, d."CantidadRegular" AS cantidad,
           d."ValorVenta" AS valor_venta, d."ValorCosto" AS valor_costo,
           d."IVA" AS iva, d."IEPS" AS ieps, btrim(d."UnidadVenta"::text) AS unidad
      FROM ${schema}."DetallesMovAlmacen" d`;
}

exports.up = async function (knex) {
  const cabeceras = SUCURSALES.map(cabecerasDe).join('\n    UNION ALL');
  const renglones = SUCURSALES.map(renglonesDe).join('\n    UNION ALL');

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_wincaja_hist_sales AS
    WITH cab AS (${cabeceras}
    ),
    -- Dedup por IDENTIDAD de ticket. El corte anual gana sobre el de nombre propio: es el
    -- completo (el de nombre propio resultó ser un SUBCONJUNTO, medido día por día).
    cab_unica AS (
      SELECT DISTINCT ON (sucursal, documento, caja, fecha) *
        FROM cab
       ORDER BY sucursal, documento, caja, fecha,
                (dataset ~ '^[0-9]{4}$') DESC, dataset
    ),
    det AS (${renglones}
    )
    SELECT
      '${MD}'::uuid                                     AS tenant_id,
      c.sucursal,
      c.fecha                                           AS sale_date,
      d.articulo,
      -- Crudos a propósito: el canal NO se decide acá (ver la cabecera de esta migración).
      c.caja,
      left(c.documento, 1)                              AS doc_prefijo,
      c.tercero,
      c.documento,
      c.dataset,
      -- Qué ES este movimiento. Lo que no está en el padrón es venta a cliente.
      COALESCE(p.clase, 'venta_cliente')                AS clase,
      d.cantidad,
      d.unidad,
      d.valor_venta,
      d.valor_costo,
      d.iva,
      d.ieps,
      -- Veredictos, nunca filtros silenciosos.
      CASE WHEN abs(d.valor_venta) >= 1000000 OR abs(d.cantidad) >= 1000000
           THEN 'fuera_de_rango' ELSE 'ok' END          AS cordura,
      CASE WHEN c.fecha < DATE '2009-01-01' THEN 'centinela'
           WHEN c.fecha > CURRENT_DATE      THEN 'futuro'
           ELSE 'ok' END                                AS fecha_veredicto
    FROM cab_unica c
    JOIN det d
      ON d.sucursal = c.sucursal AND d.dataset = c.dataset AND d.consecutivo = c.consecutivo
    LEFT JOIN analytics.wincaja_internal_parties p
      ON p.tenant_id = '${MD}'::uuid AND p.sucursal = c.sucursal AND p.tercero = c.tercero
  `);

  await knex.raw(`ALTER VIEW analytics.v_wincaja_hist_sales SET (security_invoker = true)`);

  await knex.raw(`COMMENT ON VIEW analytics.v_wincaja_hist_sales IS
    'WH.2b - La venta historica de Wincaja 2017-2025 DERIVADA del espejo por FDW (cero copia, cero importer). Dedup por (sucursal, documento, caja, fecha) prefiriendo el corte anual: 10,055,420 filas -> 9,724,420 tickets unicos. El dia sale de la FECHA parseada, no del corte. El dinero es ValorVenta SIN impuesto (IVA e IEPS aparte). La clase sale del padron wincaja_internal_parties por (sucursal, tercero): lo que no esta ahi es venta_cliente. La cota de cordura y el veredicto de fecha son COLUMNAS, no filtros -- quien consume decide, y lo raro se ve. NO DECIDE EL CANAL (mostrador/credito/preventa): expone caja y doc_prefijo crudos; lo resuelve WH.2c. NO ES PARA CONSULTA INTERACTIVA: la consume la matvista de WH.4.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_wincaja_hist_sales`);
};
