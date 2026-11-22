/**
 * `[COT.52]` Cerrar una cotización sin pedido, con motivo — la forma del wire de
 * `POST /commercial/quotes/:id/close`.
 *
 * Por qué existe (medido en prod el 2026-11-22): 122 borradores vivos, 94 de más de 7 días por
 * $1.82M, y **ninguna** cotización `rejected` ni `cancelled`. `POST /:id/cancel` existe con motivo
 * en texto libre, pero ninguna pantalla lo ofrece: no había cómo cerrar un borrador, y sin motivo
 * no se puede aprender por qué se pierde una venta. Los motivos los eligió Francisco (decisión del
 * 2026-11-22, punto 1 de la auditoría de uso y ML).
 *
 * Cada motivo dice a qué estado lleva, con la distinción que ya documenta `cancel()`:
 * `rejected` = el cliente no compró (tasa de conversión) · `cancelled` = la dimos de baja nosotros
 * (ruido operativo). «Otro» va a `cancelled`: nadie afirmó que el cliente dijera que no.
 */
export const MOTIVOS_CIERRE_COTIZACION = [
  { codigo: 'cliente_no_pidio', etiqueta: 'El cliente no hizo el pedido', estado: 'rejected' },
  { codigo: 'precio', etiqueta: 'Por el precio', estado: 'rejected' },
  { codigo: 'sin_existencia', etiqueta: 'No había existencia', estado: 'rejected' },
  { codigo: 'se_fue_con_otro', etiqueta: 'Se fue con otro proveedor', estado: 'rejected' },
  { codigo: 'prueba', etiqueta: 'Era una prueba o un error de captura', estado: 'cancelled' },
  { codigo: 'otro', etiqueta: 'Otro (escribe cuál)', estado: 'cancelled' },
] as const;

export type MotivoCierreCotizacion = (typeof MOTIVOS_CIERRE_COTIZACION)[number]['codigo'];

/** Tope del detalle: lo que cabe leer en una línea del historial. */
export const LARGO_NOTA_CIERRE = 300;

export interface CerrarCotizacionInput {
  motivo: MotivoCierreCotizacion;
  /** Obligatoria con «otro»; opcional en los demás. */
  nota?: string | null;
}

export interface CotizacionCerrada {
  id: string;
  code: string;
  status: 'rejected' | 'cancelled';
  /** `<codigo>` o `<codigo> — <nota>`: el código va siempre primero para poder contarlo. */
  close_reason: string;
}

/** El motivo de un `close_reason` guardado, o null si no empieza con un código conocido. */
export function motivoDeCierreCotizacion(closeReason: string | null | undefined): MotivoCierreCotizacion | null {
  const codigo = (closeReason ?? '').split(' — ')[0].trim();
  return MOTIVOS_CIERRE_COTIZACION.some((m) => m.codigo === codigo) ? (codigo as MotivoCierreCotizacion) : null;
}

/** El `close_reason` que se guarda. */
export function textoDeCierreCotizacion(motivo: MotivoCierreCotizacion, nota?: string | null): string {
  const n = (nota ?? '').trim().slice(0, LARGO_NOTA_CIERRE);
  return n ? `${motivo} — ${n}` : motivo;
}
