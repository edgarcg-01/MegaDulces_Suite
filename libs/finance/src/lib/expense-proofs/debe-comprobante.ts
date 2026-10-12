/**
 * `[GX.81]` — **¿Este vale debe todavía su comprobante?** Una sola regla para aprobar y para subir.
 *
 * ## El defecto que cierra (medido en prod el 2026-10-12)
 * Un vale que llega sólo con COTIZACIÓN se aprueba a `aprobada` aunque nadie marque
 * «provisional» (`[GX.54]`), y la pantalla le dice a la persona «te toca subir la factura». Pero
 * `addEvidence` sólo dejaba pasar si el gasto era comprobable o `provisional = true`, y como la
 * captura fija `no_comprobable` (`[GX.19]`), lo rebotaba con «este gasto no lleva evidencia».
 * **70 vales** quedaron así del 5 al 9 de octubre: sin salida en la Suite, y ya pagados en
 * Kepler (estado `F`).
 *
 * `[GX.55]` había cerrado el camino para los marcados `provisional`; el de sólo-cotización
 * quedó abierto porque las dos señales de «falta el comprobante» vivían en lugares distintos.
 * Acá se juntan.
 */

export interface ArchivoConRol { role?: string | null }

/** Trae cotización y ningún comprobante: lo que se aprobó es un presupuesto, no el gasto. */
export function soloCotizacion(files: readonly ArchivoConRol[] | null | undefined): boolean {
  const roles = (files ?? []).map((f) => String(f?.role || ''));
  return roles.some((r) => r.startsWith('cotizacion')) && !roles.some((r) => r.startsWith('comprobante'));
}

/**
 * ¿Se le puede subir el comprobante? Sí, si se aprobó debiéndolo por CUALQUIERA de las dos
 * señales (la casilla `provisional` o que sólo traiga cotización), o si su clase lo exige.
 */
export function debeComprobante(v: {
  provisional?: boolean | null;
  lleva_evidencia: boolean;
  files: readonly ArchivoConRol[] | null | undefined;
}): boolean {
  return v.lleva_evidencia || v.provisional === true || soloCotizacion(v.files);
}
