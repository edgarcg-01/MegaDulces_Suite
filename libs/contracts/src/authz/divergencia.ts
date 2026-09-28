/**
 * `[OR.2.1]` — **¿Elegir este perfil para este puesto es una decisión que hay que explicar?**
 *
 * ── Por qué es una función compartida y no tres `if` ────────────────────────────────────────
 * La misma regla vivía escrita tres veces —el formulario viejo (`admin-users`), el nuevo
 * (`persona-detalle`) y el backend (`detectarDesvio`)— y **dos de las tres no decían lo mismo**.
 * El formulario viejo tenía:
 *
 *     if (!propuesto || !rol || rol === propuesto) return false;   // sin propuesta ⇒ "no diverge"
 *
 * y el backend, con razón, lo contrario: sin propuesta **sí** hay que explicar, porque el perfil
 * es una elección a dedo y no hay contra qué contrastarla. El resultado medido: con **20 de los
 * 57 puestos** (los que tienen `default_role = null`) el alta era **imposible desde la pantalla**
 * — el formulario no pedía el motivo, el backend lo exigía, y no había forma de dárselo.
 *
 * Es exactamente el modo de falla de ADR-056: un primitivo copiado a mano diverge, y la copia
 * equivocada es la que pelea con el servidor.
 *
 * ── Las dos ausencias NO son la misma ───────────────────────────────────────────────────────
 * `sinPropuesta` viaja aparte del booleano porque las dos situaciones se arreglan distinto y por
 * lo tanto se le dicen distinto a quien está en la pantalla:
 *
 *   · el puesto propone OTRO perfil  → explicá por qué te apartás;
 *   · el puesto no propone ninguno   → explicá por qué ese, **y** el arreglo de fondo es darle
 *     un perfil al puesto, no escribir un motivo en cada alta.
 */

export interface EntradaDeDivergencia {
  /** `identity.positions.default_role`. `null`/vacío = el puesto no propone perfil. */
  propone: string | null | undefined;
  /** El perfil elegido para la persona. */
  elegido: string | null | undefined;
}

export interface Divergencia {
  /** ¿Hay que explicar esta combinación? */
  diverge: boolean;
  /** ¿Es porque el puesto no propone nada (y no porque propone otro)? */
  sinPropuesta: boolean;
}

const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/**
 * ⚠️ Sin perfil elegido **no** hay divergencia: todavía no se decidió nada. Devolver `true` ahí
 * pondría el formulario en rojo antes de que la persona toque el selector.
 */
export function evaluarDivergencia(e: EntradaDeDivergencia): Divergencia {
  const elegido = norm(e.elegido);
  const propone = norm(e.propone);
  if (!elegido) return { diverge: false, sinPropuesta: !propone };
  if (!propone) return { diverge: true, sinPropuesta: true };
  return { diverge: propone !== elegido, sinPropuesta: false };
}
