/* eslint-disable no-console */
/**
 * Proyección canónica venta Wincaja → shape de analytics.sales_daily — ÚNICA fuente del SQL.
 * La usan: (a) el gold feed on-prem import-wincaja-analytics.js (corrida completa) y
 * (b) el handler wincaja-sales-bronze (re-derivación SCOPED a las (branch, día) tocadas).
 *
 * Todos los valores se INLINEAN tras validación estricta (UUID / branch / fecha) → el SQL
 * no lleva bind params, así funciona idéntico bajo knex.raw(sql) y pg client.query(sql)
 * (evita el choque de placeholders `?` vs `$n`). NO reimplementa lógica: es el mismo
 * SELECT_SRC histórico (canal, unidad CJA×factor/KGS, costo, blends por fecha).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_RE = /^[0-9A-Za-z_-]{1,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cutovers de blend Kepler/Wincaja para sucursales COMPARTIDAS (idénticos al gold feed).
const PH_CUTOVER = "DATE '2026-07-01'";
const LP_CUTOVER = "DATE '2025-10-01'";
const YURE_CUTOVER = "DATE '2026-02-18'";
const ZAMORA_CUTOVER = "DATE '2026-03-16'";
// Canindo (branch 50) migró su POS Wincaja→Kepler. El script de identidad le puso kepler_code='06'
// (→ wincaja_only pasó a FALSE) y renombró el almacén MD-50→'06'. Queda EXACTO como PH/LP/Yure/Zamora:
// sucursal COMPARTIDA que Wincaja aporta < cutover (histórico, última venta 13-ago) y Kepler '06' toma
// desde 15-ago (0 días de solape, verificado). Sin el remap 50→'06' + esta cláusula, su historia se
// caía (warehouse_code 'MD-50' ya no existe) y el blend la excluía (ya no es wincaja_only).
const CANINDO_CUTOVER = "DATE '2026-08-15'";
// [WH.6] Morelia Madero (branch 32 → almacén '07') y Morelia Abastos (branch 30 → '08'): el MISMO
// caso que Canindo, y se cayeron por la MISMA razón. Al migrar su POS a Kepler, el script de
// identidad les puso `kepler_code` (→ `wincaja_only` pasó a FALSE) y renombró su almacén a '07'/'08'
// — pero nadie les escribió la cláusula de abajo. Sin ella, el `WHERE` de esta proyección las
// excluye ENTERAS: el `wincaja_only = true` ya no las toma y no hay OR que las rescate.
//
// ⭐ Es la tercera vez que esta omisión cobra, y el comentario de Canindo la había predicho
// textual: *"Sin el remap + esta cláusula, su historia se caía"*. El síntoma no es un error: la
// pantalla simplemente muestra MENOS — en `/compras/pedido` el globo de 12 meses de Morelia salía
// vacío para casi todo el catálogo, porque `analytics.sales_daily` arrancaba el día del corte.
//
// Medido en prod el 2026-10-07, antes de tocar nada:
//   · branch 32 → 495,438 filas · 5,788 SKUs · $54,361,801 · hasta 2026-09-07
//   · branch 30 → 1,089,384 filas · 6,874 SKUs · $351,934,029 · hasta 2026-09-18
//   · `analytics.sales_daily` tenía CERO filas `wincaja_*` para '07' y '08'.
//
// Los dos cortes NO se inventaron: salen de `analytics.v_branch_erp_cutover` (el resolvedor
// canónico, que ya los declaraba) y coinciden al día con lo que miden las dos fuentes — Wincaja 32
// termina el 09-07 y Kepler '07' arranca el 09-08; Wincaja 30 termina el 09-18 y Kepler '08'
// arranca el 09-19. CERO días de solape en ambas, o sea cero doble conteo.
// ⚠️ NO se remapea `warehouse_code`: `wincaja.branches` ya dice '07'/'08', así que el `ELSE` del
// CASE de abajo acierta solo. Agregar un remap sería duplicar un dato que ya está bien.
const MADERO_CUTOVER = "DATE '2026-09-08'";
const ABASTOS_CUTOVER = "DATE '2026-09-19'";

// [WH.6.1] EL PISO DE FECHA, que no es una decisión de esta fase sino de `[AUD-DAT.2]`
// (`20260928190000_sales_daily_piso_de_fecha.js`): `analytics.sales_daily` lleva
// `CHECK (sale_date >= '2024-01-01') NOT VALID`, y esa migración eligió el año a propósito —
// *"el piso se pone un año ANTES para no bloquear un backfill histórico plausible desde la réplica
// de Wincaja, y aun así atajar la clase catastrófica (el año 2000, 2014)"*.
//
// ⭐ El freno hizo exactamente su trabajo: el primer `--apply` de [WH.6] murió con `23514` sobre
// una fila `2000-01-01`, y la transacción revirtió entera. La basura nace en el `.mdb` de Wincaja
// y es un CENTINELA, no un dato: Morelia trae **159 filas fechadas 2000-01-01, una por SKU** (más
// 1 de 2020), $12,275 contra $406M de venta real — 0.003%.
//
// Esto va acá y no en una cláusula por sucursal a propósito: el piso es una propiedad del HECHO,
// no de una plaza. Acotarlo a 30/32 dejaría a la próxima que migre chocando contra el mismo muro,
// que es justo el patrón que [WH.6] existe para cerrar.
//
// ⚠️ Lo que este piso NO hace, y es deliberado: NO borra las 226 filas bajo el piso que ya viven
// en el fact (01/02/05/06/RUTA-22, $263,273). `[AUD-DAT.2]` las dejó con `NOT VALID` justamente
// para no borrar en prod sin autorización, y barrerlas desde acá sería una puerta de una sola
// dirección —el CHECK ya no deja re-insertarlas—. Por eso `import-wincaja-analytics.js` acota su
// `DELETE` a este mismo piso: la deuda queda declarada donde estaba, no se amplía ni se tapa.
const PISO_FECHA = "DATE '2024-01-01'";

/**
 * @param {object} o
 * @param {string} o.tenantId  UUID (validado, inline).
 * @param {string[]=} o.branches  source_branch a acotar (p.ej. ['30','32','50']). Sin esto = todas.
 * @param {string[]=} o.days      business_date 'YYYY-MM-DD' a acotar. Sin esto = todas.
 * @returns {string} SQL SELECT (sin bind params).
 */
function buildSalesDailySrc({ tenantId, branches = null, days = null } = {}) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new Error(`sales-daily-projection: tenantId inválido: ${tenantId}`);
  let scope = '';
  if (Array.isArray(branches) && branches.length) {
    for (const b of branches) if (!BRANCH_RE.test(String(b))) throw new Error(`branch inválido: ${b}`);
    scope += ` AND s.source_branch IN (${branches.map((b) => `'${b}'`).join(',')})`;
  }
  if (Array.isArray(days) && days.length) {
    for (const d of days) if (!DAY_RE.test(String(d))) throw new Error(`día inválido: ${d}`);
    scope += ` AND s.business_date IN (${days.map((d) => `DATE '${d}'`).join(',')})`;
  }
  return `
  WITH am AS (
    SELECT DISTINCT ON (tenant_id, articulo)
           tenant_id, articulo,
           upper(btrim(coalesce(unidad_venta, ''))) AS uv, factor_venta
      FROM wincaja.articulos
     ORDER BY tenant_id, articulo, source_dataset DESC
  )
  SELECT
    p.id                         AS product_id,
    w.id                         AS warehouse_id,
    s.business_date              AS sale_date,
    'wincaja_' || CASE s.sale_channel
       WHEN 'mayoreo_credito'  THEN 'credito'
       WHEN 'preventa_vecinal' THEN 'preventa'
       WHEN 'ruta_venta'       THEN 'ruta'
       WHEN 'mostrador'        THEN 'mostrador'
       ELSE s.sale_channel END   AS channel,
    SUM(CASE WHEN am.uv = 'CJA' THEN s.qty * COALESCE(NULLIF(am.factor_venta, 0), 1)
             ELSE s.qty END)      AS units,
    CASE WHEN bool_or(am.uv = 'KGS') THEN 'weight' ELSE 'piece' END AS unit_kind,
    -- [R.2] EL DIVISOR QUE ESTA PROYECCION YA APLICA, ahora escrito en vez de tirado.
    -- Es la TERCERA vez que el mismo defecto aparece: primero unit-normalization.js lo mandaba
    -- a un console.log, despues el fact deducia por PRECIO un peldano que Kepler traia escrito en
    -- c58, y aca la linea de arriba lo calcula y lo descarta. Consecuencia medida: rung_factor
    -- NULL en las 343,015 celdas de Wincaja (55% del ingreso) con units_unresolved en 0, o sea
    -- un NULL MUDO -- justo lo que ADR-056 prohibe.
    --
    -- El divisor es 1 en el 99.69% y factor_venta en el 0.31% (solo uv='CJA'), y ESO ES CORRECTO:
    -- ADR-055 dice que Wincaja guarda en SU unidad de venta, asi que un factor_venta sobre un
    -- articulo 'PZA' es divisor de DISPLAY, no de conversion. Medido: 15,177 articulos PZA con
    -- factor_venta mediana 16, y ninguno se multiplica.
    CASE WHEN count(DISTINCT CASE WHEN am.uv = 'CJA'
                                  THEN COALESCE(NULLIF(am.factor_venta, 0), 1) ELSE 1 END) > 1
         THEN NULL
         ELSE max(CASE WHEN am.uv = 'CJA'
                       THEN COALESCE(NULLIF(am.factor_venta, 0), 1) ELSE 1 END)
    END                          AS rung_factor,
    count(DISTINCT CASE WHEN am.uv = 'CJA'
                        THEN COALESCE(NULLIF(am.factor_venta, 0), 1) ELSE 1 END) > 1 AS rung_mixed,
    -- Lo que NO se pudo resolver: un articulo sin ficha en wincaja.articulos cae al ELSE de arriba
    -- y se trataria como factor 1 SIN evidencia. Hoy son 0 celdas -- y eso es una medicion, no un
    -- supuesto: se conto. Si maniana aparece una, el numero deja de ser cero solo.
    SUM(CASE WHEN am.articulo IS NULL THEN s.qty ELSE 0 END) AS units_unresolved,
    SUM(s.importe)               AS revenue,
    SUM(s.costo)                 AS cost,
    SUM(s.importe) - SUM(s.costo) AS margin,
    SUM(s.tickets)               AS tickets
  FROM wincaja.v_sales_daily s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.deleted_at IS NULL
   AND w.code = CASE WHEN s.source_branch = '10' THEN '01'
                     WHEN s.source_branch = '42' THEN '02'
                     WHEN s.source_branch = '44' THEN '04'
                     WHEN s.source_branch = '54' THEN '05'
                     WHEN s.source_branch = '50' THEN '06'
                     ELSE s.warehouse_code END
  LEFT JOIN am ON am.tenant_id = s.tenant_id AND am.articulo = s.sku
  WHERE s.tenant_id = '${tenantId}'
    AND s.business_date >= ${PISO_FECHA}
    AND ( s.wincaja_only = true
          OR (s.source_branch = '10' AND s.business_date < ${PH_CUTOVER})
          OR (s.source_branch = '42' AND s.business_date < ${LP_CUTOVER})
          OR (s.source_branch = '44' AND s.business_date < ${YURE_CUTOVER})
          OR (s.source_branch = '54' AND s.business_date < ${ZAMORA_CUTOVER})
          OR (s.source_branch = '50' AND s.business_date < ${CANINDO_CUTOVER})
          OR (s.source_branch = '32' AND s.business_date < ${MADERO_CUTOVER})
          OR (s.source_branch = '30' AND s.business_date < ${ABASTOS_CUTOVER}) )
    ${scope}
  GROUP BY p.id, w.id, s.business_date, channel`;
}

// `PISO_FECHA` se exporta para que el `DELETE` del gold feed use EL MISMO piso que el SELECT.
// Si cada lado llevara el suyo, el día que uno cambie el otro borraría lo que el primero ya no
// produce — que es la forma exacta en que un merge "sin churn" se convierte en un barrido.
module.exports = { buildSalesDailySrc, UUID_RE, PISO_FECHA };
