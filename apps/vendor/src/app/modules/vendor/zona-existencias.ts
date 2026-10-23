import type { VendorZoneStockResponse } from '@megadulces/contracts';

/**
 * `[MCP.3.12]` La tira chica de existencias de la zona en cada producto de la toma de pedido.
 *
 * Pedido de David (2026-10-23): el vendedor ve cuánto hay en cada sucursal de su zona «en un tamaño
 * discreto pero visible». Esta parte SÓLO muestra; elegir de qué sucursal se surte es la parte 2.
 */
export interface ChipZona {
  id: string;
  short: string;
  name: string;
  mine: boolean;
  /** Existencia en la unidad que se está pidiendo (enteros); `null` = sin dato de esa sucursal. */
  qty: number | null;
  /** Texto del número: «14», «0» o «—» (sin dato). */
  texto: string;
}

/**
 * Las existencias de un producto en cada sucursal de la zona, en la unidad elegida.
 *
 * Devuelve `null` (no se pinta la tira) cuando no aporta nada o no se puede afirmar:
 *  · la zona no se cargó o vino declarada sin medir;
 *  · la zona tiene una sola sucursal (ya lo dice la existencia de siempre);
 *  · el producto no tiene existencia en ninguna sucursal de la zona (no viaja en `stock`).
 */
export function chipsDeZona(
  zona: VendorZoneStockResponse | null,
  productId: string,
  factor: number,
): ChipZona[] | null {
  if (!zona || zona.unmeasured_reason || zona.warehouses.length < 2) return null;
  const fila = zona.stock[productId];
  if (!fila) return null;
  const f = factor > 1 ? factor : 1;
  return zona.warehouses.map((w, i) => {
    const crudo = fila[i];
    const qty = crudo == null ? null : Math.floor(Number(crudo) / f);
    return { id: w.id, short: w.short, name: w.name, mine: w.mine, qty, texto: qty == null ? '—' : String(qty) };
  });
}

/** Para el lector de pantalla: «Existencias en tu zona, en CJA: LPA (tu sucursal) 0, PH 14, …». */
export function ariaZona(chips: readonly ChipZona[], unidad: string): string {
  const partes = chips.map((c) => `${c.name}${c.mine ? ' (tu sucursal)' : ''} ${c.qty == null ? 'sin dato' : c.qty}`);
  return `Existencias en tu zona${unidad ? ', en ' + unidad : ''}: ${partes.join(', ')}`;
}

/**
 * La edad de la existencia de las OTRAS sucursales (la más vieja), para declararla (ADR-056):
 * «hace 12 min». `null` si no hay otras sucursales o ninguna trae fecha.
 */
export function edadZona(zona: VendorZoneStockResponse | null, ahora: number): string | null {
  if (!zona || zona.warehouses.length < 2) return null;
  const fechas = zona.warehouses
    .filter((w) => !w.mine && w.as_of)
    .map((w) => new Date(w.as_of as string).getTime())
    .filter((t) => Number.isFinite(t));
  if (!fechas.length) return null;
  const min = Math.max(0, Math.round((ahora - Math.min(...fechas)) / 60_000));
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}
