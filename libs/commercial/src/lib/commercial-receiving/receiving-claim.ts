import type { ReceivingOrigin } from './receiving-origin';

/**
 * **WMS-REC.8 — el reclamo de un faltante de recepción (lógica pura, ADR-053).**
 *
 * Todo lo que se puede decidir sin tocar la DB vive acá: qué renglón genera reclamo,
 * cuánto se reclama, cuánto vale, a quién se le reclama y qué transiciones de estado
 * son legales. Igual que `receiving-origin.ts`: puro, exportado y testeado, para que
 * el smoke por HTTP pruebe el CAMINO y el unit test pruebe la REGLA — y no al revés
 * (lección de WMS-REC.4: un smoke que espeja la regla en JS da 17/17 con la ruta caída).
 *
 * **Lo que acá NO se hace: recalcular el faltante.** `discrepancyFor()` ya lo computó
 * y lo persistió en `commercial.receiving_lines.discrepancy_kind`; esto sólo lo lee.
 */

/** Discrepancias que se le reclaman a alguien. `sobrante` y `ok` no son reclamo. */
export type ReceivingClaimKind = 'faltante' | 'dañado' | 'producto_incorrecto';

export type ReceivingClaimStatus = 'open' | 'claimed' | 'accepted' | 'discarded' | 'written_off';

/** `supplier` = proveedor externo · `branch` = la sucursal que embarcó el traspaso. */
export type ReceivingResponsibleKind = 'supplier' | 'branch';

export const CLAIMABLE_KINDS: readonly ReceivingClaimKind[] = ['faltante', 'dañado', 'producto_incorrecto'];

/** Estados desde los que el reclamo sigue vivo (aparece en la bandeja como trabajo abierto). */
export const OPEN_STATUSES: readonly ReceivingClaimStatus[] = ['open', 'claimed'];

/**
 * ¿Este renglón genera reclamo?
 *
 * `dañado` y `producto_incorrecto` entran **y no por completitud**: `discrepancyFor()`
 * deja que el override manual REEMPLACE a `faltante`, así que marcar un renglón como
 * dañado hoy borra la etiqueta de faltante — y el reclamo se perdería justo en el caso
 * más caro (llegó, pero no sirve). `sobrante` no es reclamo: llegó de más, no de menos.
 */
export function isClaimableDiscrepancy(kind: string | null | undefined): kind is ReceivingClaimKind {
  return CLAIMABLE_KINDS.includes(String(kind ?? '') as ReceivingClaimKind);
}

/**
 * Cuánto se reclama, en la unidad DEL DOCUMENTO.
 *
 * - `faltante`: `expected − received`, que es un hecho del cotejo.
 * - `dañado` / `producto_incorrecto`: **no hay columna que diga cuánto llegó dañado**.
 *   Si además faltó cantidad, ese hueco es el piso del reclamo; si no, devuelve `null`
 *   = "falta capturarla", y se teclea en la bandeja (la superficie tranquila), nunca en
 *   el andén con el camión esperando.
 *
 * Los `numeric` de Postgres llegan como **string** por JSON → `Number()` primero
 * (GOTCHAS §6). Nunca devuelve 0: un reclamo de cero no es un reclamo.
 *
 * (La regla es la misma para los tres tipos; lo que cambia es la lectura del `null`:
 * en `faltante` no puede pasar —si no hay hueco no hay faltante—, y en los otros dos
 * significa "llegó completo pero mal, falta capturar cuánto".)
 */
export function claimQtyFor(expectedQty: unknown, receivedQty: unknown): number | null {
  const expected = Number(expectedQty ?? 0) || 0;
  const received = Number(receivedQty ?? 0) || 0;
  const hueco = Math.max(0, expected - received);
  return hueco > 0 ? hueco : null;
}

/**
 * Monto estimado del reclamo = cantidad × costo por unidad **del documento**.
 *
 * `unitCost` sale de `importe/cantidad` del renglón del ERP: costo por unidad en la
 * MISMA unidad en que se cuenta (PZA/PAQ/CJA). **Cero factor de caja** — sólo 3.1% de
 * los SKU lo tienen, así que multiplicar por un `uxc` inventado es dibujar dinero.
 *
 * Sin costo del documento devuelve `null`, **no 0**: la bandeja tiene que decir
 * "sin costo del documento", porque un $0 se lee como "no cuesta nada".
 */
export function claimAmount(qty: unknown, unitCost: unknown): number | null {
  const q = Number(qty ?? 0);
  const c = Number(unitCost ?? 0);
  if (!Number.isFinite(q) || !Number.isFinite(c) || q <= 0 || c <= 0) return null;
  return Math.round(q * c * 100) / 100;
}

export interface ClaimResponsible {
  responsible_kind: ReceivingResponsibleKind;
  /** Nombre tal cual lo trae el documento; si no viene, el código. **Nunca deducido.** */
  responsible_label: string | null;
}

/**
 * A quién se le reclama, derivado del origen ya clasificado.
 *
 * Un traspaso **no** resuelve sucursal acá: `TI###` no mapea limpio (el ERP se
 * contradice: `TI005` sale como "ZAMORA CANINDO" y como "ABASTOS LP" mientras
 * `analytics.transfer_dest_map` dice que Canindo es `TI006`). El dueño concreto sale
 * del crosswalk capturado a mano `commercial.erp_transfer_origin`, y mientras esté
 * vacío el reclamo se mide sin dueño. Mostrar el nombre del documento es un hecho;
 * deducir la sucursal sería una invención.
 */
export function responsibleFor(origin: ReceivingOrigin, supplierCode?: string | null): ClaimResponsible {
  return {
    responsible_kind: origin.kind === 'transfer' ? 'branch' : 'supplier',
    responsible_label: origin.name || (supplierCode ? String(supplierCode).trim() : null) || null,
  };
}

/** Acciones que puede ejecutar quien trabaja la bandeja. */
export type ClaimAction = 'claim' | 'accepted' | 'discarded' | 'written_off';

/**
 * Máquina de estados del reclamo. Devuelve el estado siguiente o `null` si la
 * transición no es legal (el service la traduce a 409).
 *
 * `open → claimed` (se le pasó al responsable) y de cualquiera de los dos a un cierre.
 * **Un reclamo cerrado no se reabre desde acá**: el resultado de una negociación no se
 * edita en silencio; si hay que corregirlo, se levanta la conversación con quien lo cerró
 * (queda `resolved_by_username` + nota).
 */
export function nextClaimStatus(
  current: ReceivingClaimStatus,
  action: ClaimAction,
): ReceivingClaimStatus | null {
  const abierto = OPEN_STATUSES.includes(current);
  if (!abierto) return null;
  if (action === 'claim') return current === 'open' ? 'claimed' : null;
  return action;
}

/**
 * ¿Este reclamo penaliza el cumplimiento del responsable?
 *
 * `discarded` = nuestro conteo estaba mal → **no penaliza** (si penalizara, un error de
 * captura le bajaría el fill rate a un proveedor que surtió completo). Todo lo demás sí,
 * incluido `open`: si sólo contaran los confirmados, la desatención de la bandeja
 * protegería al proveedor — que es exactamente el efecto que este item viene a matar.
 */
export function penalizesFulfillment(status: ReceivingClaimStatus): boolean {
  return status !== 'discarded';
}

/** Idempotencia del alta: un reclamo por renglón, aunque el cierre se reintente. */
export function claimDedupKey(receivingLineId: string): string {
  return `recv-line:${receivingLineId}`;
}
