/**
 * `[CXC.52]` **La venta facturada por vendedor en un periodo** — `GET /finance/receivables/venta-vendedor`.
 *
 * Vive acá y no en el servicio porque la pantalla de Cartera declaraba su propia copia del mismo
 * objeto (`VentaVendedorResp` en `apps/view/.../cartera.service.ts`): dos declaraciones del mismo
 * contrato se separan sin que nada avise, que es justo lo que ADR-052 existe para impedir.
 *
 * ⚠️ **Deuda con nombre:** la copia del frontend sigue viva. Es estructuralmente idéntica hoy, pero
 * mientras exista el riesgo no está cerrado. Migrarla a este contrato es su propio cambio, con la
 * pantalla re-probada, y no se cuela dentro de un push ajeno.
 */

/** Un vendedor y lo que facturó en el periodo, en la sucursal donde lo hizo. */
export interface VentaVendedorFila {
  sucursal: string;
  vendedor: string;
  venta: number;
}

/**
 * ⭐ **Ausente ≠ cero.** Sólo vienen las claves que vendieron: la que no está no facturó con esa
 * clave en el periodo, y la pantalla lo dice así en vez de pintar un `$0` que nadie midió (ADR-056).
 */
export interface VentaVendedorResp {
  /** Inicio del periodo medido, `AAAA-MM-DD`. Resuelto por el servidor, no por el navegador. */
  date_from: string;
  /** Fin del periodo medido, `AAAA-MM-DD`. */
  date_to: string;
  /** El «hoy» del servidor (TZ `America/Mexico_City`) contra el que se resolvió el rango. */
  hoy: string;
  filas: VentaVendedorFila[];
  /** La suma de `filas`, redondeada a dos decimales por el servidor para que nadie la recalcule distinto. */
  total: number;
}
