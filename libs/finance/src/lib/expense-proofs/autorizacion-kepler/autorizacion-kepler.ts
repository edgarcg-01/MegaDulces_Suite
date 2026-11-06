/**
 * `[PGP.79]` **Firmar en Aprobación de gastos AUTORIZA la solicitud en Kepler.**
 *
 * Decisión del usuario (2026-11-06): la firma de `/finanzas/aprobacion-gastos` reemplaza a la
 * pantalla «Autorización de Sol Gasto» de Kepler. Rechazar NO cancela en Kepler (D2: por ahora no).
 *
 * ## Qué escribe, medido por ingeniería inversa (2026-11-06)
 * El «Grabar» de esa pantalla reescribe TODA su lista pendiente, una transacción por renglón
 * (`md_00` xid 94181386–418; `md_01` 10948045–059 y 11589329–339). En esas transacciones, sobre las
 * **360 tablas** de `md_01` (leídas con un superusuario): **sólo `kdm1`**. Sin disparadores, sin
 * bitácora de documentos (`orglogtbl_26` es la de SESIONES), sin póliza. Y ninguna columna dice
 * quién ni cuándo: lo único que distingue a una autorizada (5,180 solicitudes de 120 días) es
 * `c43`. O sea que autorizar es **`kdm1.c43: N → A`** y nada más.
 *
 * Aplicar el gasto (`A → F`) sí escribe 8 tablas —kdm1, kdm6, kdxe, kdxg, kdc126, kdcn26, la
 * póliza `kdc2AAMM`, sqliov—; eso lo sigue haciendo Kepler y aquí no se toca.
 *
 * ## ⛔ Sólo sobre una `N`
 * La Suite nunca escribe encima de lo que Kepler ya decidió: `A` (ya autorizada), `F` (el dinero
 * salió) o `C` (cancelada). El `WHERE c43 = 'N'` lo garantiza dentro del mismo UPDATE, sin
 * ventana entre leer y escribir; y eso lo vuelve **idempotente**: reintentar no escribe dos veces.
 *
 * Medido el 2026-11-06 (vales aprobados en 30 días): cuando la Suite firmó, Kepler ya tenía 338 en
 * `F` y 63 en `A`; sólo 1 en `N`. Hoy Finanzas autoriza en Kepler antes; esta escritura empieza a
 * contar cuando deje de hacerlo.
 *
 * Sin base de datos a propósito: se prueba en `autorizacion-kepler.spec.ts`.
 */
import { normalizarSucursal, valorDeEnv, type Env, type Resolucion } from '@megadulces/platform-core';

/** Lo que Kepler guarda en `kdm1.c43` de una solicitud `X-A-15-1`. */
export type EstadoSolicitudKepler = 'N' | 'A' | 'F' | 'C';

export type ResultadoAutorizacionKepler =
  /** La Suite la pasó de `N` a `A`. */
  | { estado: 'escrito' }
  /** Kepler ya la tenía autorizada (`A`) o aplicada (`F`): no había nada que escribir. */
  | { estado: 'ya_estaba'; kepler: 'A' | 'F' }
  /** No se escribió, y por qué. El vale queda aprobado en la Suite igual. */
  | { estado: 'no_escrito'; motivo: string };

/** Apagada por default. Sólo `KEPLER_GASTO_AUTORIZACION=encendida` la prende. */
export function escrituraDeAutorizacionEncendida(env: Env): boolean {
  return valorDeEnv(env, 'KEPLER_GASTO_AUTORIZACION') === 'encendida';
}

/** La llave de la solicitud en Kepler: `(c1, 'X', 'A', 15, 1, c6)`. Folio de 7 dígitos, como `kdm1.c6`. */
export function llaveDeSolicitud(v: { sucursal?: string | null; folio_solicitud?: string | null }): Resolucion<{ sucursal: string; folio: string }> {
  const s = normalizarSucursal(v.sucursal);
  if (!s.ok) return s;
  const folio = String(v.folio_solicitud ?? '').trim();
  if (!/^\d{7}$/.test(folio)) return { ok: false, motivo: `El vale no trae un folio de solicitud de Kepler válido («${folio}»): se esperan 7 dígitos` };
  return { ok: true, valor: { sucursal: s.valor, folio } };
}

/**
 * Qué significa lo que devolvió el UPDATE. `cambiadas` son las filas que tocó (0 o 1: es la llave
 * primaria) y `actual` el `c43` que tiene la solicitud cuando no tocó ninguna.
 */
export function veredictoAutorizacion(cambiadas: number, actual: string | null | undefined): ResultadoAutorizacionKepler {
  if (cambiadas === 1) return { estado: 'escrito' };
  if (cambiadas > 1) return { estado: 'no_escrito', motivo: `El UPDATE tocó ${cambiadas} solicitudes: se deshizo` };
  const e = String(actual ?? '').trim();
  if (e === 'A' || e === 'F') return { estado: 'ya_estaba', kepler: e };
  if (e === 'C') return { estado: 'no_escrito', motivo: 'Kepler tiene la solicitud cancelada (C): no se autoriza encima' };
  if (!e) return { estado: 'no_escrito', motivo: 'Kepler no tiene esa solicitud en esa sucursal' };
  return { estado: 'no_escrito', motivo: `Kepler tiene la solicitud en un estado que no se conoce («${e}»): no se toca` };
}
