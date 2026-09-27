/**
 * `[RA-PRO.61]` Decisiones del PDF de la orden de compra de Kepler, sin Angular ni jsPDF, para
 * probarlas (ADR-056: lo que decide un número se prueba).
 */
import type { OcRenglonDto } from '@megadulces/contracts';
import { textoParaArchivo, fechaHoraArchivo } from './compras-pdf-comun';

/** Un renglón de la OC tal como lo manda la API: el tipo es el del contrato (ADR-052). */
export type RenglonOc = OcRenglonDto;

/**
 * Cajas de un renglón, SÓLO cuando el costo confirma la unidad.
 *
 * Kepler guarda `cantidad` en la unidad del renglón (PAQ, PZA, KG…) y `unidades_por_caja` en…
 * hay que comprobarlo: medido 2026-09-26 sobre 95,555 renglones de OC, en el 98.9%
 * `costo_caja = costo_unitario × unidades_por_caja`, o sea que el factor está en la MISMA unidad
 * del renglón y `cajas = cantidad / unidades_por_caja`. El resto son costos simbólicos ($0.0008)
 * o servicios, donde el factor no significa lo mismo.
 *
 * Por eso no se convierte a ciegas: si el costo no cuadra (±1%) o falta un dato, devuelve `null`
 * y el PDF muestra la cantidad en su unidad con las cajas "sin verificar" — nunca un número
 * de cajas inventado (CLAUDE.md: nunca adivinar una unidad).
 */
export function cajasDeRenglon(r: Pick<RenglonOc, 'cantidad' | 'unidades_por_caja' | 'costo_unitario' | 'costo_caja'>): number | null {
  const upc = Number(r.unidades_por_caja);
  const cu = Number(r.costo_unitario);
  const cc = Number(r.costo_caja);
  const cant = Number(r.cantidad);
  if (!(upc > 0) || !(cu > 0) || !(cc > 0) || !Number.isFinite(cant)) return null;
  if (Math.abs(cc - cu * upc) > 0.01 * cc) return null;
  return cant / upc;
}

/** Etiquetas del estatus de la OC en Kepler (kdm1.c43), las mismas que pinta la pantalla. */
export const ESTATUS_KEPLER: Record<string, string> = {
  N: 'Pendiente', F: 'Finalizada', C: 'Cancelada', R: 'Recibida', A: 'Otro',
};

/** La referencia de Kepler viene como '0' cuando no hay: eso no se imprime. */
export function referenciaUtil(ref: string | null | undefined): string | null {
  const r = String(ref ?? '').trim();
  return r && r !== '0' ? r : null;
}

/**
 * Nombre del archivo, con el mismo control que las requisiciones:
 * `OC_<SUC>-<FOLIO>_<PROVEEDOR>_AAAA-MM-DD-HH-MM.pdf`.
 */
export function nombreArchivoOc(sucursal: string, folio: string, proveedor: string | null, d: Date): string {
  const suc = textoParaArchivo(sucursal, 5) || 'SUC';
  const fol = textoParaArchivo(folio, 30) || 'SIN-FOLIO';
  const prov = textoParaArchivo(proveedor ?? '') || 'SIN-PROVEEDOR';
  return `OC_${suc}-${fol}_${prov}_${fechaHoraArchivo(d)}.pdf`;
}

/**
 * Cajas del renglón como texto, con el resto en la unidad DEL RENGLÓN (no "pz": puede ser PAQ o
 * KG): "45 cj", "44 cj + 10 paq", "10 paq" (menos de una caja). `null` si las cajas no se pueden
 * verificar (ver `cajasDeRenglon`).
 */
export function textoCajasRenglon(r: Pick<RenglonOc, 'cantidad' | 'unidades_por_caja' | 'costo_unitario' | 'costo_caja' | 'unidad'>): string | null {
  const cajas = cajasDeRenglon(r);
  if (cajas === null) return null;
  const upc = Number(r.unidades_por_caja);
  const cant = Number(r.cantidad);
  const cj = Math.floor(cajas + 1e-9);
  const resto = Math.round((cant - cj * upc) * 1000) / 1000;
  const u = (r.unidad || 'u').trim().toLowerCase();
  const restoTxt = `${resto.toLocaleString('es-MX')} ${u}`;
  if (cj && resto > 0) return `${cj.toLocaleString('es-MX')} cj + ${restoTxt}`;
  if (resto > 0) return restoTxt;
  return `${cj.toLocaleString('es-MX')} cj`;
}
