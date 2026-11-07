/**
 * `[NP.7.L.1]` El universo del levantamiento de una sucursal, derivado en vivo (derive-no-copy): nada de
 * esto se copia, se lee del ODS y de las fichas propias en cada consulta. Una sola fuente para «faltan»
 * en la pantalla A, para los sugeridos y para la cobertura (E): si las pantallas cuentan distinto, es que
 * alguien copió este SQL.
 *
 * Universo (D24, Francisco 2026-11-02): SKU de la ficha de Kepler de la sucursal con **venta en 90 días
 * o existencia** en el almacén de la sucursal, **sin promociones** (no se fotografían). `c99` (obsoleto)
 * viene vacío en las 9 sucursales y no sirve para excluir (§10a.1).
 *
 * ⚠️ Medido el 2026-11-02 contra prod en sólo lectura (Padre Hidalgo): ver §10a del plan.
 * ⚠️ El almacén `01` de `v_erp_stock_on_hand` no está verificado como el de PISO (podría sumar bodega).
 *
 * Bindings nombrados: `:tenant`, `:branch`, `:no_fisico`.
 */

/**
 * Promociones y servicios que Kepler da de alta como SKU («1 JELLY DOO = GRATIS 1 XPLOSODA», «TIEMPO
 * AIRE», «$120 NUTRESA = GRATIS…», «* DESC …»). Filtro por NOMBRE: es aproximado — medido el
 * 2026-11-02, 133 de 4,054 activos de Padre Hidalgo; `is_promo` de las ventas marca sólo 94, y
 * «2X1 EN ESTUCHES» todavía se cuela. Se declara así hasta tener un marcador en Kepler.
 */
export const NO_FISICO_REGEX = '=|GRATIS|TIEMPO AIRE|^\\*|^DESC |^\\$';

/** Estados que dicen «este SKU ya tiene ficha» (§7.1; misma lista que `ESTADOS_CON_FICHA`). */
const CON_FICHA = `'publicada','conciliada','con_diferencias'`;
/**
 * Ya levantado (esperando a Catálogo o a la IA), o apartado y VIVO: no se vuelve a sugerir. Una captura
 * soltada («Salir sin terminar», «No es éste», el tope de 3) o vencida se queda `en_captura` sin dueño:
 * sin mirar el apartado, ese SKU desaparecía de los sugeridos para siempre aunque seguía en «faltan».
 */
export const EN_CURSO_SQL = `status IN ('fotos_tomadas','analizada','por_revisar')
            OR (status = 'en_captura'
                AND coalesce((sheet #>> ARRAY['peldanos', sheet->>'principal', 'apartado', 'until'])::timestamptz > now(), false))`;

export const UNIVERSO_LEVANTAMIENTO_SQL = `
WITH ve AS MATERIALIZED (
  SELECT d.sku, sum(d.monto) AS monto
    FROM analytics.mv_kepler_sales_daily d
   WHERE d.tenant_id = :tenant AND d.warehouse_code = :branch
     AND d.business_date >= (now() AT TIME ZONE 'America/Mexico_City')::date - 90
   GROUP BY d.sku
  HAVING sum(d.monto) > 0
), st AS MATERIALIZED (
  SELECT s.sku
    FROM analytics.v_erp_stock_on_hand s
   WHERE s.tenant_id = :tenant AND s.warehouse_code = :branch AND s.qty_stock_units > 0
   GROUP BY s.sku
), k AS MATERIALIZED (
  SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre,
         upper(NULLIF(btrim(c11), '')) AS u1,
         upper(NULLIF(btrim(c80), '')) AS u2, NULLIF(btrim(c81::text), '')::numeric AS f2,
         upper(NULLIF(btrim(c83), '')) AS u3, NULLIF(btrim(c84::text), '')::numeric AS f3
    FROM kepler_ods.kdii
   WHERE btrim(sucursal) = :branch
   ORDER BY btrim(c1), NULLIF(btrim(c84::text), '')::numeric DESC NULLS LAST
), r AS MATERIALIZED (
  -- Sin btrim: medido 2026-11-02, sucursal y sku vienen limpios (4,479 = 4,479) y con btrim el
  -- planificador estimaba 141 filas y recorría esta tabla 8,305 veces (2.8 s de 3.5 s).
  SELECT sku, rung_modal::numeric AS rm
    FROM analytics.mv_kepler_sold_rung
   WHERE sucursal = :branch
), fichas AS MATERIALIZED (
  SELECT sku,
         bool_or(status IN (${CON_FICHA})) AS con_ficha,
         bool_or(${EN_CURSO_SQL}) AS en_curso
    FROM catalog.product_sheets
   WHERE tenant_id = :tenant AND deleted_at IS NULL AND superseded_at IS NULL AND sku IS NOT NULL
   GROUP BY sku
)
SELECT k.sku, k.nombre,
       ve.monto,
       (st.sku IS NOT NULL) AS con_existencia,
       r.rm AS unidad_factor,
       CASE WHEN r.rm = 1 THEN k.u1 WHEN r.rm = k.f2 THEN k.u2 WHEN r.rm = k.f3 THEN k.u3 END AS unidad_rotulo,
       coalesce(fichas.con_ficha, false) AS con_ficha,
       coalesce(fichas.en_curso, false) AS en_curso
  FROM k
  LEFT JOIN ve ON ve.sku = k.sku
  LEFT JOIN st ON st.sku = k.sku
  LEFT JOIN r ON r.sku = k.sku
  LEFT JOIN fichas ON fichas.sku = k.sku
 WHERE (ve.sku IS NOT NULL OR st.sku IS NOT NULL)
   AND k.nombre !~* :no_fisico`;

/** Conteos de la pantalla A (y de la cobertura): universo y cuántos no tienen ficha. */
export const CONTEOS_LEVANTAMIENTO_SQL = `
SELECT count(*)::int AS universe,
       count(*) FILTER (WHERE NOT u.con_ficha)::int AS missing
  FROM (${UNIVERSO_LEVANTAMIENTO_SQL}) u`;

/**
 * `[NP.7.L.5]` La cobertura de UNA sucursal (pestaña E, §10b.3 «Unidades de conteo»), sobre el MISMO
 * universo que la pantalla A: «faltan» sale de aquí y de `CONTEOS_LEVANTAMIENTO_SQL` con el mismo número
 * porque los dos envuelven `UNIVERSO_LEVANTAMIENTO_SQL`, no una copia.
 *
 * - `published` = SKUs del universo con su unidad principal publicada (`con_ficha`, de cualquier sucursal:
 *   un SKU cubierto lo está para toda la red, igual que en la pantalla A). «En revisión» nunca suma.
 * - `sales_share_pct` = MÉTRICA L: venta de 90 d EN PESOS de los cubiertos ÷ la del universo (⛔ no en
 *   unidades: están infladas ~3.9×). El numerador va con `coalesce(…, 0)`: sin ningún cubierto que venda,
 *   la cobertura es 0 %, no «no medible»; `null` queda sólo para una sucursal sin venta en la ventana.
 *
 * Medido el 2026-11-04 en Padre Hidalgo (sólo lectura): universo 4,230 · publicadas 7 · 0.888 %.
 * Mismos bindings que el universo: `:tenant`, `:branch`, `:no_fisico`. Se corre con
 * `SET LOCAL enable_nestloop = off`, como los conteos (el universo tardó 34 s sin eso, medido 2026-11-02).
 * ⚠️ El tiempo de ESTA consulta en prod: NO MEDIDO (se espera el del universo, ~0.5 s).
 */
export const COBERTURA_LEVANTAMIENTO_SQL = `
SELECT count(*)::int AS universe,
       count(*) FILTER (WHERE u.con_ficha)::int AS published,
       count(*) FILTER (WHERE NOT u.con_ficha)::int AS missing,
       100 * coalesce(sum(u.monto) FILTER (WHERE u.con_ficha), 0) / nullif(sum(u.monto), 0) AS sales_share_pct
  FROM (${UNIVERSO_LEVANTAMIENTO_SQL}) u`;

/**
 * Sugeridos: lo que hay en el anaquel (existencia > 0), sin ficha y sin captura en curso, los que más
 * venden primero. Desempate hasta el final (nombre, sku): sin él, dos lecturas iguales pueden dar
 * páginas distintas. Bindings extra: `:limit`, `:offset`.
 */
export const SUGERIDOS_LEVANTAMIENTO_SQL = `
SELECT u.sku, u.nombre, u.unidad_rotulo, u.unidad_factor, count(*) OVER ()::int AS total
  FROM (${UNIVERSO_LEVANTAMIENTO_SQL}) u
 WHERE u.con_existencia AND NOT u.con_ficha AND NOT u.en_curso
 ORDER BY u.monto DESC NULLS LAST, u.nombre, u.sku
 LIMIT :limit OFFSET :offset`;
