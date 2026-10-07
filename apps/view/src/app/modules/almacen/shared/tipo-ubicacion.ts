/**
 * **El vocabulario de las ubicaciones de bodega: rack, tarima u otra.**
 *
 * No es una tabla ni una columna: `commercial.warehouse_bins` guarda `code` y
 * `label`, y el tipo se **deriva** de ellos. Se eligió así a propósito en
 * WMS-REC.9 — agregar una columna `kind` obliga a una migración y a un backfill
 * para un dato que el propio nombre ya lleva ("Rack 12", `R-12`), y que nadie
 * consulta sin mirar también el nombre.
 *
 * Vive acá y no dentro de una pantalla porque lo usan **dos**: el Andén, para
 * proponer el código al crear la ubicación con la tarima en las manos, y la
 * pantalla de Ubicaciones, para agrupar y filtrar lo que ya existe. Extraerlo al
 * segundo uso es la regla (ADR-056): el primero lo escribe, el segundo lo saca.
 *
 * **La derivación es una pista, no un hecho.** Una ubicación llamada `X-9` sin
 * etiqueta cae en *Otra*, y está bien: es lo que se sabe de ella. Nunca se
 * inventa un tipo que el nombre no dice.
 */

export const TIPOS_UBICACION = [
  { key: 'rack', label: 'Rack', prefijo: 'R' },
  { key: 'tarima', label: 'Tarima', prefijo: 'T' },
  { key: 'otro', label: 'Otra', prefijo: 'U' },
] as const;

export type TipoUbicacion = (typeof TIPOS_UBICACION)[number]['key'];

const OTRO = TIPOS_UBICACION[2];

/**
 * Qué tipo de ubicación es, a partir de su nombre o su código.
 *
 * Manda el **nombre** ("Rack 12"), porque es lo que escribió una persona; el
 * código es el respaldo (`R-12`, `T-3`). Un código que arranca con la letra del
 * prefijo pero sigue con letra —`RETORNO`— **no** cuenta: se exige que después
 * venga un separador o un dígito, o cualquier rack que se llame `TIENDA-1`
 * quedaría clasificado como tarima.
 */
export function tipoDeUbicacion(
  code: string | null | undefined,
  label?: string | null,
): (typeof TIPOS_UBICACION)[number] {
  const nombre = (label || '').trim().toLowerCase();
  if (nombre) {
    const porNombre = TIPOS_UBICACION.find((t) => t.key !== 'otro' && nombre.startsWith(t.label.toLowerCase()));
    if (porNombre) return porNombre;
  }
  const c = (code || '').trim().toUpperCase();
  const porCodigo = TIPOS_UBICACION.find(
    (t) => t.key !== 'otro' && new RegExp(`^${t.prefijo}[-_ ]?\\d`).test(c),
  );
  return porCodigo ?? OTRO;
}
