/**
 * `[IG.1]` Canales de venta del reporte de INGRESOS (`/finanzas/ingresos`).
 *
 * Hermano de `expense-family.contract.ts`, y por el mismo motivo (ADR-056): la etiqueta se define
 * UNA vez, o un canal nuevo sale en pantalla como `'reparto_vecinal'` pelado.
 *
 * ── DE DÓNDE SALE UN CANAL, Y POR QUÉ NO DE LA CUENTA ────────────────────────────────────
 * El canal **no** está en la subcuenta contable: está en el concepto `c6` de la póliza, y lo
 * clasifica `analytics.income_entries_src()` (mig `20260925150000`), port verificado del
 * `classify()` de `import-sales-by-channel.js`.
 *
 * ⚠️ **El nombre de la subcuenta MIENTE y no se debe usar para esto.** Medido en prod: `401-002`
 * —que concentra todo el detalle de 2026— se llama «VENTA FLETES A TERCEROS» en el catálogo del
 * CEDIS y **no es fletes**; `401-003` es «VENTAS VECINAL» en unas sucursales y «VENTAS MAYOREO» en
 * otras. La misma clave significa cosas distintas según quién la capturó.
 *
 * Verificado contra `analytics.sales_by_channel_monthly` (feb–jul 2026, seis meses cerrados):
 * delta **$0.00 exacto** por canal.
 */

/** Canal de venta, tal como lo emite `analytics.income_entries_src()`. */
export type SalesCanal = 'mostrador' | 'telemarketing' | 'ruta' | 'reparto_vecinal' | 'contado' | 'otro';

/** Etiqueta de pantalla. Fuente única (service + frontend). */
export const SALES_CANAL_LABEL: Record<SalesCanal, string> = {
  mostrador: 'Mostrador',
  telemarketing: 'Telemarketing',
  ruta: 'Ruta',
  reparto_vecinal: 'Reparto vecinal',
  contado: 'Contado',
  otro: 'Sin canal declarado',
};

/** Etiqueta corta para chips y leyendas. */
export const SALES_CANAL_SHORT: Record<SalesCanal, string> = {
  mostrador: 'Mostrador',
  telemarketing: 'TLMKT',
  ruta: 'Ruta',
  reparto_vecinal: 'Vecinal',
  contado: 'Contado',
  otro: 'Sin canal',
};

/** Clave de la serie mensual por canal (una columna por canal en el punto de la serie). */
export const SALES_CANAL_SERIES_KEY: Record<SalesCanal, string> = {
  mostrador: 'mostrador',
  telemarketing: 'telemarketing',
  ruta: 'ruta',
  reparto_vecinal: 'vecinal',
  contado: 'contado',
  otro: 'otro',
};

/** Orden de presentación: por peso medido en prod (90 d a 2026-09-25). */
export const SALES_CANAL_ORDER: SalesCanal[] = [
  'mostrador', 'telemarketing', 'ruta', 'reparto_vecinal', 'contado', 'otro',
];

/**
 * `otro` **no es un canal**: es el residuo del clasificador — crédito individual cuyo concepto
 * viene con nombre de cliente y sin prefijo. Medido: **233 de las 271 «plazas» del rango por
 * defecto caen acá** ($19.4M / 90 d). Por eso la pantalla lo muestra agrupado y rotulado como
 * residuo, y **nunca** desglosa sus plazas como si fueran puntos de venta.
 */
export const SALES_CANAL_RESIDUO: SalesCanal = 'otro';

/**
 * Etiqueta de un canal; devuelve el código pelado si llega uno desconocido (ADR-056: lo que no se
 * sabe se DECLARA, no se inventa).
 */
export function salesCanalLabel(c: string | null | undefined): string {
  if (!c) return '(sin canal)';
  return SALES_CANAL_LABEL[c as SalesCanal] ?? c;
}
