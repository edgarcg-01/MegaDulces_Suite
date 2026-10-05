/**
 * `[MS.3.14]` Las ubicaciones de una solicitud: las sucursales Kepler (`00`–`08`) más las que NO son sucursal
 * (`SD_UBICACIONES_EXTRA`, p. ej. las oficinas corporativas). Funciones puras.
 *
 * Reglas, y por qué:
 *  · Un código de Kepler se sigue validando EXACTAMENTE como antes (`00`–`08`, y los de las eras de Wincaja `30`/`32`/`50`
 *    siguen rechazados): esto no relaja nada, sólo agrega.
 *  · Un código extra se acepta sin distinguir mayúsculas (`of` → `OF`): es lo que escribe quien llama por API; el
 *    formulario siempre manda el código tal cual.
 *  · Para NOMBRAR primero se busca en los extras y luego en el catálogo de sucursales. Los extras no pueden chocar con
 *    los de Kepler (letras contra dos dígitos), así que el orden no cambia ningún nombre existente.
 */
import { SD_UBICACIONES_EXTRA } from '@megadulces/contracts';

/** El código canónico de una ubicación extra, o `null` si no lo es. */
export function ubicacionExtra(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SD_UBICACIONES_EXTRA, c) ? c : null;
}

/** El nombre de una ubicación extra, o `null` si el código no es de las extras. */
export function nombreUbicacionExtra(code: string | null | undefined): string | null {
  const c = ubicacionExtra(code);
  return c ? SD_UBICACIONES_EXTRA[c] : null;
}
