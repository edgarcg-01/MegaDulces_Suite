/**
 * `[RE.64]` — **Las notas de crédito y devoluciones que Kepler aplicó a cada orden de entrada.** Un solo
 * primitivo para todo lo que en `/compras/revision-facturas` dice «ajuste»: la columna Ajuste/Neto y su
 * total, el filtro por ajuste, los hallazgos «Entrega incompleta» / «Ajuste comercial» y el lado Kepler de
 * «¿dónde está la rebaja?» (RE.63). Si dos de ésos leyeran fuentes distintas, la columna y el panel podrían
 * contar distinto.
 *
 * Sale del ODS (`kepler_ods`), no del importer: `analytics.erp_purchase_adjustments` ligaba por `kdm1.c39`
 * (folio de entrada escrito en el documento), que viene vacío en el 100 % de las notas de crédito — medido
 * 2026-11-10: 1,492 X-D-55 de 2026 ($23.8 M), 0 ligadas; la pantalla mostraba Ajuste «—» en 3,449 compras.
 *
 * La liga es estructural (ERP_KEPLER §3.z.4): `kdxf` con el cargo de la nota (`55` nota de crédito, `40`
 * devolución de compra) aplicado al abono A·20 de la entrada; mismo cruce que `v_supplier_payables`
 * (`btrim(c1) = sucursal`, proveedor `kdm1.c10 = kdxf.c2`). Se suman, además, las que NO tienen aplicación
 * en `kdxf` pero nombran su entrada en `c39` (casi todas devoluciones: 7 de 8 desde agosto). Las
 * canceladas (`kdm1.c43 = 'C'`) no cuentan: Kepler no borra su aplicación de `kdxf` (`[PGP.99]`).
 * ⚠️ NO MEDIDO: las devoluciones sin aplicación ni `c39` (45 desde agosto) no se pueden atribuir a una compra.
 *
 * El GRUPO (operativo / comercial / sin clasificar) sale del motivo (`kdm1.c24`) con el MISMO clasificador
 * del importer, traducido a SQL — cruzado documento por documento: 2,373 de 2,373 iguales. Lo que cambia
 * es qué se hace con el motivo vacío u «otro»: una devolución (`40`) es operativa por definición; una nota
 * (`55`) sin motivo que la clasifique queda **sin clasificar** (el importer la contaba como operativa, y
 * eso disparaba «Entrega incompleta» por un descuento sin motivo escrito).
 *
 * ⛔ Sin `?` en los textos (GOTCHAS §71): `trx.raw` toma cada `?` por parámetro y CAMBIA el regex sin dar error (medido:
 * con `DIF\.?` y `\s?` el clasificador difería del importer en 107 documentos). Los opcionales van como `{0,1}`;
 * lo vigila `ajustes-kepler.spec.ts`. `kepler_ods.*` no tiene tenant ni RLS.
 */
import { COMERCIAL_CATS } from './receipt-match';

/** Categorías del motivo que son físicas (llegó mal, faltó, no se pidió, vino cambiada, se devolvió). */
export const OPERATIVAS_CATS = ['no_solicitado', 'mal_estado', 'faltante', 'cambiada', 'devolucion_otra'];

const lista = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');

/**
 * El clasificador del motivo, en SQL: la traducción exacta de `categorize()` de
 * `database/importers/kepler/import-purchase-adjustments.js` (`\b` → `\y`). Mismo orden: físico → error de
 * captura → comercial.
 */
export const categoriaAjusteSql = (e: string): string => `CASE
  WHEN btrim(coalesce(${e}, '')) = '' THEN NULL
  WHEN upper(${e}) ~ 'NO SE SOLICIT|NO SOLICIT' THEN 'no_solicitado'
  WHEN upper(${e}) ~ 'MAL ESTADO|DA[ÑN]AD|CADUC|ROTO|PONCH|PES[OÓ] DE MENOS|MALTRAT' THEN 'mal_estado'
  WHEN upper(${e}) ~ 'FALT' THEN 'faltante'
  WHEN upper(${e}) ~ 'CAMBIAD|EQUIVOC|LLEGO CAMB|NO TRA[IÍ]A' THEN 'cambiada'
  WHEN upper(${e}) ~ 'DUPLICAD|FACTURAS DOBLES|COMPRAS DOBLES|DOBLE FACTUR' THEN 'factura_duplicada'
  WHEN upper(${e}) ~ 'DIFERENCIA (EN|DE) (MONTO|PRECIO)|DIF\\.{0,1} (MONTO|PRECIO)|MAL APLICAD' THEN 'diferencia_monto'
  WHEN upper(${e}) ~ 'PRONTO PAGO|\\yPP\\y|%\\s{0,1}PP|PP\\s{0,1}\\d' THEN 'pronto_pago'
  WHEN upper(${e}) ~ 'APOYO|MKT|MARKETING|MERCADOTECNIA' THEN 'apoyo_marca'
  WHEN upper(${e}) ~ 'RAPPEL|INCENTIVO|PROMOCION|\\yPROMO\\y|NEGOCIAD' THEN 'descuento_comercial'
  WHEN upper(${e}) ~ 'DESCUENTO|DESCEUNTO|DESCUETO|DESCUNTO|DESCTO|\\yDESC\\y|\\yDTO\\y|PLAN|PAQUETE|GRANEL|BONIF|\\d\\s{0,1}%' THEN 'descuento_comercial'
  WHEN upper(${e}) ~ 'SALDO A FAVOR' THEN 'saldo_favor'
  WHEN upper(${e}) ~ 'DEVOL|REGRES' THEN 'devolucion_otra'
  ELSE 'otro' END`;

/** El grupo: comercial si el motivo lo dice; operativo si el motivo es físico o es una devolución; si no, sin clasificar. */
export const grupoAjusteSql = (tipo: string, cat: string): string => `CASE
  WHEN ${cat} IN (${lista(COMERCIAL_CATS)}) THEN 'comercial'
  WHEN ${cat} IN (${lista(OPERATIVAS_CATS)}) OR ${tipo} = '40' THEN 'operativo'
  ELSE 'sin_clasificar' END`;

/** `[RE.66]` Una nota que cubre al menos esta fracción de su entrada se lee como traslado del pago (si además…). */
export const COBERTURA_TRASLADO = 0.95;

/**
 * Una fila por (sucursal, entrada, nota): lo que esa nota rebajó de esa entrada. `liga` = `kdxf` (aplicación
 * estructural) o `c39` (el documento nombra la entrada y no tiene aplicación).
 *
 * `[RE.66]` Dos correcciones, medidas en prod el 2026-11-10:
 *  · **Traslado al CEDIS** (`grupo = 'traslado'`): hasta el corte del 1-oct el CEDIS concentraba las compras; la
 *    entrada de sucursal se «blanqueaba» con una X-D-55 por su total y el pago iba por la COPIA del CEDIS. Esa
 *    nota no es rebaja: mueve el pago. Se reconoce estructuralmente — una nota de sucursal que cubre ≥ 95 % de su
 *    entrada (`kdxe`, el documento que rebaja) y la entrada tiene copia en `analytics.erp_goods_receipt_dedup`
 *    (la misma liga con la que la lista excluye las copias) o su motivo dice «blanqueo». Medido: 726 notas de
 *    jun–ago ($26.2 M), 19 desde septiembre (el corte). Sin esto la columna Neto decía $0 «que realmente pagamos»
 *    en 298 compras desde agosto que sí se pagan (en el CEDIS): $9.4 M de menos en el total.
 *  · **Notas de la copia del CEDIS**: las que Kepler aplicó a la copia (00) se atribuyen a la entrada original
 *    de sucursal, que es la fila que muestra la lista (la copia se excluye): ahí se aplicaban los descuentos
 *    reales de las compras concentradas. `sucursal_kepler` / `folio_kepler` dicen dónde estaba aplicada.
 */
export const AJUSTES_KEPLER_SQL = `
  WITH doc AS MATERIALIZED (
    SELECT m.sucursal, m.c1, m.c4 AS tipo, m.c5, m.c6, m.c10, btrim(m.c6) AS nc_folio, m.c16::numeric AS total,
           NULLIF(btrim(m.c39), '') AS c39, to_char(m.c9::date, 'YYYY-MM-DD') AS fecha, NULLIF(btrim(m.c24), '') AS motivo
      FROM kepler_ods.kdm1 m
     WHERE m.c2 = 'X' AND m.c3 = 'D' AND m.c4 IN ('55', '40') AND btrim(m.c1) = m.sucursal AND m.c43 IS DISTINCT FROM 'C'
  ), copia AS MATERIALIZED (
    SELECT DISTINCT cedis_folio, dup_of_sucursal, dup_of_folio FROM analytics.erp_goods_receipt_dedup
     WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c' AND status IN ('auto', 'confirmado')
  ), ent AS MATERIALIZED (
    SELECT k.sucursal, btrim(k.c6) AS folio, max(k.c11)::numeric AS importe FROM kepler_ods.kdxe k
     WHERE btrim(k.c1) = k.sucursal AND k.c3 = 'A' AND k.c4 = '20'
     GROUP BY 1, 2
  ), apl AS MATERIALIZED (
    SELECT d.sucursal, btrim(x.c9) AS folio, d.tipo, d.nc_folio, sum(x.c10)::numeric AS aplicado, d.fecha, d.motivo, 'kdxf'::text AS liga
      FROM doc d
      JOIN kepler_ods.kdxf x
        ON x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.tipo AND x.c5 = d.c5 AND x.c6 = d.c6
     WHERE x.c7 = '20' AND btrim(x.c1) = x.sucursal
     GROUP BY d.sucursal, btrim(x.c9), d.tipo, d.nc_folio, d.fecha, d.motivo
  ), ref AS (
    SELECT d.sucursal, d.c39 AS folio, d.tipo, d.nc_folio, d.total AS aplicado, d.fecha, d.motivo, 'c39'::text AS liga
      FROM doc d
     WHERE d.c39 IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdxf x
                        WHERE x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.tipo AND x.c5 = d.c5 AND x.c6 = d.c6)
  ), u AS (
    SELECT * FROM apl UNION ALL SELECT * FROM ref
  ), cat AS (
    SELECT u.*, ${categoriaAjusteSql('u.motivo')} AS categoria FROM u
  ), cls AS (
    SELECT cat.*,
           CASE WHEN cat.sucursal <> '00' AND e.importe > 0 AND cat.aplicado >= ${COBERTURA_TRASLADO} * e.importe
                 AND (upper(coalesce(cat.motivo, '')) ~ 'BLANQ'
                      OR EXISTS (SELECT 1 FROM copia c WHERE c.dup_of_sucursal = cat.sucursal AND c.dup_of_folio = cat.folio))
                THEN 'traslado'
                ELSE ${grupoAjusteSql('cat.tipo', 'cat.categoria')} END AS grupo
      FROM cat LEFT JOIN ent e ON e.sucursal = cat.sucursal AND e.folio = cat.folio
  )
  SELECT COALESCE(c.dup_of_sucursal, cls.sucursal) AS sucursal, COALESCE(c.dup_of_folio, cls.folio) AS folio,
         cls.sucursal AS sucursal_kepler, cls.folio AS folio_kepler,
         cls.tipo, cls.nc_folio, cls.aplicado, cls.fecha, cls.motivo, cls.liga, cls.categoria, cls.grupo
    FROM cls LEFT JOIN copia c ON cls.sucursal = '00' AND c.cedis_folio = cls.folio`;

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
