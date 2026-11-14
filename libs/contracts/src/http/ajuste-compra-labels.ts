/**
 * `[RE.75]` — Cómo se nombran, para una persona, la categoría y el tipo de un ajuste de compra
 * (`analytics.v_purchase_adjustments`: devoluciones X-D-40 y notas de crédito X-D-55).
 *
 * El cajón del ajuste mostraba la llave cruda (`descuento_comercial`, `XD40`). La pantalla de
 * Descuentos tiene su propia copia de estos nombres (`CAT_LABEL` en `compras-descuentos.component.ts`):
 * deuda con nombre, a fundirse con ésta (ADR-056).
 */
export const CATEGORIA_AJUSTE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  faltante: 'Faltante', no_solicitado: 'No solicitado', mal_estado: 'Mal estado', cambiada: 'Cambios/reposición',
  devolucion_otra: 'Devolución', factura_duplicada: 'Factura duplicada', diferencia_monto: 'Diferencia de monto',
  pronto_pago: 'Pronto pago', apoyo_marca: 'Apoyo de marca', descuento_comercial: 'Descuento comercial',
  saldo_favor: 'Saldo a favor', otro: 'Otro',
});

/** La categoría en llano; una llave desconocida se devuelve tal cual (no se inventa un nombre). */
export function categoriaAjusteLabel(cat: string | null | undefined): string | null {
  if (!cat) return null;
  return CATEGORIA_AJUSTE_LABEL[cat] ?? cat;
}

/** `XD40` → «Devolución», `XD55` → «Nota de crédito». */
export function doctypeAjusteLabel(doctype: string | null | undefined): string {
  return doctype === 'XD40' ? 'Devolución' : doctype === 'XD55' ? 'Nota de crédito' : (doctype ?? '');
}
