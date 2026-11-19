/**
 * `[RE.82]` — **La hoja de Kepler no es la factura del proveedor.**
 *
 * La «Aplica Orden Entrada» (`XA2001-…`) la imprime Kepler: trae NUESTRO folio y el MISMO total que
 * la entrada, así que subida sola «cuadra» siempre y no prueba nada de lo que cobró el proveedor.
 * Edgar (2026-11-19): «a veces suben únicamente la hoja de Kepler (la cual no sirve) y debemos
 * evitar eso».
 *
 * Medido en prod (sólo lectura, últimos 60 días, 1,985 comprobantes): **114** traían como único
 * documento reconocido la hoja de Kepler; **111** quedaron como «recibido» y todos con
 * `monto_match = true`. Control: 0 comprobantes con folio `XA20…` leído y una factura detectada, o
 * sea que el lector no confunde una factura con nuestra hoja.
 *
 * La regla frena sólo lo PROBADO: todas las hojas leídas y ninguna trae otro papel. Con que una hoja
 * traiga factura, remisión, ticket, vale u «otro» (la nota de venta del proveedor sale como ticket),
 * o con que una hoja no se haya podido leer, no frena: eso lo decide el revisor.
 */

/** Tipos del lector que son papel NUESTRO impreso por Kepler, no del proveedor. */
export const TIPOS_HOJA_KEPLER: ReadonlySet<string> = new Set(['aplica_orden_entrada']);

/** ¿Lo que el lector reconoció en UNA hoja es sólo la hoja de Kepler? Sin lectura → `false`. */
export function esSoloHojaKepler(tipos: readonly (string | null | undefined)[] | null | undefined): boolean {
  const t = (tipos || []).filter((x): x is string => !!x);
  return t.length > 0 && t.every((x) => TIPOS_HOJA_KEPLER.has(x));
}

/**
 * ¿El paquete entero (una entrada por hoja: los tipos que leyó el lector, o `null` si no se leyó)
 * es sólo la hoja de Kepler? Una hoja sin leer lo vuelve indecidible → `false` (no frena).
 */
export function paqueteSoloHojaKepler(tiposPorHoja: readonly (readonly (string | null | undefined)[] | null | undefined)[]): boolean {
  return tiposPorHoja.length > 0 && tiposPorHoja.every((t) => esSoloHojaKepler(t));
}

/** El aviso, dicho igual en la pantalla y en el servidor. */
export const MENSAJE_SOLO_HOJA_KEPLER =
  'Es la hoja de Kepler (Aplica Orden Entrada), no la factura del proveedor. Sube la factura o remisión que entregó el proveedor.';
