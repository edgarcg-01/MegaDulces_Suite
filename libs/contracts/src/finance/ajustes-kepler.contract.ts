/**
 * `[RE.64]` — **Las notas de crédito y devoluciones que Kepler aplicó a cada orden de entrada.** Un solo
 * primitivo para todo lo que en `/compras/revision-facturas` dice «ajuste»: la columna Ajuste/Neto y su
 * total, el filtro por ajuste, los hallazgos «Entrega incompleta» / «Ajuste comercial» y el lado Kepler de
 * «¿dónde está la rebaja?» (RE.63). Si dos de ésos leyeran fuentes distintas, la columna y el panel podrían
 * contar distinto.
 *
 * `[RE.68]` **El documento sale de la vista `analytics.v_purchase_adjustments`** (migración
 * `20261110160453_re68_v_purchase_adjustments`): una fila por nota (X-D-55) o devolución (X-D-40) de Kepler,
 * todas las sucursales, sin canceladas, con su `categoria` (el clasificador del motivo) y su `grupo`
 * (comercial / operativo / sin_clasificar / traslado). **El clasificador y la regla del traslado viven SÓLO
 * en la vista**: aquí ya no se repiten (antes estaban aquí y la vista habría sido una segunda copia). La vista
 * reemplaza al importer `import-purchase-adjustments.js` (sólo CEDIS, contaba canceladas, inventaba categoría).
 *
 * Lo que este archivo agrega es la ATRIBUCIÓN a la entrada: `kdxf` con el cargo de la nota aplicado al abono
 * A·20 (ERP_KEPLER §3.z.4; mismo cruce que `v_supplier_payables`: `btrim(c1) = sucursal`, proveedor
 * `kdm1.c10 = kdxf.c2`, con las llaves crudas `kepler_c*` de la vista), más las que no tienen aplicación pero
 * nombran su entrada (`entrada_folio` de la vista, que es `c39`). Las canceladas no cuentan: Kepler no borra
 * su aplicación de `kdxf` (`[PGP.99]`) y la vista ya las quitó.
 * ⚠️ NO MEDIDO: las devoluciones sin aplicación ni `c39` (45 desde agosto) no se pueden atribuir a una compra.
 *
 * ⛔ Sin `?` en los textos (GOTCHAS §71): `trx.raw` toma cada `?` por parámetro. Lo vigila
 * `ajustes-kepler.spec.ts` (libs/finance), también sobre el texto de la vista. `kepler_ods.*` no tiene tenant
 * ni RLS; la vista declara `tenant_id` del único tenant.
 *
 * `[RE.67]` Vive en `contracts` (y no en `libs/finance`) porque lo leen DOS dominios —finanzas (Revisión de
 * facturas) y comercial (Costo por proveedor)— y un dominio no puede importar a otro (eslint, depConstraints).
 * Mismo patrón que `kepler-payable-key`: mapeo explícito en `tsconfig.base.json` y `tsconfig.ts7.json`.
 */

/** La vista con las notas de crédito y devoluciones de Kepler (una fila por documento). */
export const VISTA_AJUSTES = 'analytics.v_purchase_adjustments';

/** Las categorías del motivo que son descuento negociado (pronto pago, descuento, apoyo de marca). */
export const COMERCIAL_CATS = ['descuento_comercial', 'pronto_pago', 'apoyo_marca'];

/** Categorías del motivo que son físicas (llegó mal, faltó, no se pidió, vino cambiada, se devolvió). */
export const OPERATIVAS_CATS = ['no_solicitado', 'mal_estado', 'faltante', 'cambiada', 'devolucion_otra'];

/**
 * Una fila por (sucursal, entrada, nota): lo que esa nota rebajó de esa entrada. `liga` = `kdxf` (aplicación
 * estructural) o `c39` (el documento nombra la entrada y no tiene aplicación).
 *
 * `[RE.66]` **Notas de la copia del CEDIS**: las que Kepler aplicó a la copia (00) se atribuyen a la entrada
 * original de sucursal, que es la fila que muestra la lista (la copia se excluye): ahí se aplicaban los
 * descuentos reales de las compras concentradas. `sucursal_kepler` / `folio_kepler` dicen dónde estaba
 * aplicada. El **traslado al CEDIS** (`grupo = 'traslado'`) lo decide la vista.
 */
export const AJUSTES_KEPLER_SQL = `
  WITH doc AS MATERIALIZED (
    SELECT v.sucursal, v.kepler_c1 AS c1, v.kepler_c4 AS tipo, v.kepler_c5 AS c5, v.kepler_c6 AS c6, v.kepler_c10 AS c10,
           v.folio AS nc_folio, v.monto AS total, v.entrada_folio, to_char(v.adjustment_date, 'YYYY-MM-DD') AS fecha,
           v.motivo, v.categoria, v.grupo
      FROM ${VISTA_AJUSTES} v
  ), copia AS MATERIALIZED (
    SELECT DISTINCT cedis_folio, dup_of_sucursal, dup_of_folio FROM analytics.erp_goods_receipt_dedup
     WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c' AND status IN ('auto', 'confirmado')
  ), apl AS MATERIALIZED (
    SELECT d.sucursal, btrim(x.c9) AS folio, d.tipo, d.nc_folio, sum(x.c10)::numeric AS aplicado, d.fecha, d.motivo,
           'kdxf'::text AS liga, d.categoria, d.grupo
      FROM doc d
      JOIN kepler_ods.kdxf x
        ON x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.tipo AND x.c5 = d.c5 AND x.c6 = d.c6
     WHERE x.c7 = '20' AND btrim(x.c1) = x.sucursal
     GROUP BY d.sucursal, btrim(x.c9), d.tipo, d.nc_folio, d.fecha, d.motivo, d.categoria, d.grupo
  ), ref AS (
    SELECT d.sucursal, d.entrada_folio AS folio, d.tipo, d.nc_folio, d.total AS aplicado, d.fecha, d.motivo,
           'c39'::text AS liga, d.categoria, d.grupo
      FROM doc d
     WHERE d.entrada_folio IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdxf x
                        WHERE x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.tipo AND x.c5 = d.c5 AND x.c6 = d.c6)
  ), u AS (
    SELECT * FROM apl UNION ALL SELECT * FROM ref
  )
  SELECT COALESCE(c.dup_of_sucursal, u.sucursal) AS sucursal, COALESCE(c.dup_of_folio, u.folio) AS folio,
         u.sucursal AS sucursal_kepler, u.folio AS folio_kepler,
         u.tipo, u.nc_folio, u.aplicado, u.fecha, u.motivo, u.liga, u.categoria, u.grupo
    FROM u LEFT JOIN copia c ON u.sucursal = '00' AND c.cedis_folio = u.folio`;

/**
 * Por entrada: lo que se le rebajó, cuántas notas, y por grupo. Columnas con los nombres que lee la lista.
 * `[RE.66]` El traslado al CEDIS NO es rebaja: no entra a ningún total.
 */
export const AJUSTES_KEPLER_POR_ENTRADA_SQL = `
  SELECT n.sucursal, n.folio AS entrada_folio,
         COALESCE(sum(n.aplicado), 0)::numeric AS ajuste,
         count(*)::int AS n_ajuste,
         COALESCE(sum(n.aplicado) FILTER (WHERE n.grupo = 'comercial'), 0)::numeric AS ajuste_comercial,
         COALESCE(sum(n.aplicado) FILTER (WHERE n.grupo = 'operativo'), 0)::numeric AS ajuste_operativo,
         COALESCE(sum(n.aplicado) FILTER (WHERE n.grupo = 'sin_clasificar'), 0)::numeric AS ajuste_sin_clasificar
    FROM (${AJUSTES_KEPLER_SQL}) n
   WHERE n.grupo <> 'traslado'
   GROUP BY n.sucursal, n.folio`;

/** Una fila de `AJUSTES_KEPLER_SQL` tal como llega del driver. */
export interface AjusteKeplerFila {
  sucursal: string; folio: string; sucursal_kepler: string; folio_kepler: string; tipo: '55' | '40'; nc_folio: string;
  aplicado: number | string; fecha: string | null; motivo: string | null; liga: 'kdxf' | 'c39'; categoria: string | null;
  grupo: 'comercial' | 'operativo' | 'sin_clasificar' | 'traslado';
}

/**
 * `[RE.67]` Una fila por NOTA (no por entrada): para lo que se cuenta por proveedor y por fecha de la nota —el
 * descuento de «Costo por proveedor»—. `total` es `kdm1.c16`, que es la suma de sus aplicaciones en `kdxf` en
 * 1,353 de 1,358 notas del CEDIS y en el 100 % de las sucursales (medido 2026-11-10). `[RE.68]` Es la vista
 * con los nombres que ya leía comercial.
 */
export const NOTAS_KEPLER_DOC_SQL = `
  SELECT v.sucursal, v.kepler_c4 AS tipo, v.folio, v.proveedor_code, v.adjustment_date AS fecha, v.monto AS total,
         v.motivo, v.categoria, v.grupo
    FROM ${VISTA_AJUSTES} v`;
