/**
 * `[MCP.21]` Modificar un pedido agendado desde su tarjeta: cuánto de cada producto y quitar.
 * Puro (sin Angular): se prueba solo en `editar-pedido.spec.ts`.
 *
 * ⚠️ La cantidad se edita EN LA UNIDAD en que se tomó (1 PAQ, 2 CJA), y viaja así con su sello
 * (`qty_unit` + `qty_factor`), igual que en «Tomar pedido». Un renglón cuya cantidad no cae entera en
 * su unidad no se edita aquí: mandarlo en base borraría su unidad (regla de unidades, ADR-051). Ése
 * se cambia en la captura.
 */
import type { OrderModifyChange } from '@megadulces/contracts';
import { cantidadMostrada, type LineaDelPedido } from './articulos-pedido';

/** Lo que la vendedora cambió de un renglón: la cuenta nueva, o quitarlo. */
export type CambioEnCurso = { cuenta: number } | 'quitar';
export type Edicion = Readonly<Record<string, CambioEnCurso>>;

export interface RenglonEditable {
  id: string;
  producto: string;
  /** Lo que tiene hoy el pedido, en su unidad. */
  original: number;
  unidad: string;
  /** El sello con el que viaja la cantidad; `null` = va en unidad base (el renglón no tenía unidad). */
  sello: { qty_unit: string; qty_factor: number } | null;
  /** `false` = la cantidad no cae entera en su unidad: se cambia en la captura. */
  editable: boolean;
}

export function renglonEditable(l: LineaDelPedido): RenglonEditable {
  const m = cantidadMostrada(l);
  const u = String(l.qty_unit ?? '').trim();
  const f = Number(l.qty_factor);
  const conUnidad = !!u && f > 0;
  // cantidadMostrada sólo devuelve la unidad del sello cuando la cuenta es entera en ella.
  const entera = conUnidad && m.unit === u;
  return {
    id: l.id,
    producto: l.product_name ?? 'Producto',
    original: m.qty,
    unidad: m.unit,
    sello: entera ? { qty_unit: u, qty_factor: f } : null,
    editable: entera || !u,
  };
}

/** La cuenta que se ve: la editada o la original. `0` = quitado. */
export function cuentaDe(r: RenglonEditable, e: Edicion): number {
  const c = e[r.id];
  if (c === 'quitar') return 0;
  return c ? c.cuenta : r.original;
}

/** Lo que se manda al servidor: sólo lo que cambió de verdad. */
export function cambiosDe(renglones: readonly RenglonEditable[], e: Edicion): OrderModifyChange[] {
  const out: OrderModifyChange[] = [];
  for (const r of renglones) {
    const c = e[r.id];
    if (!c || !r.editable) continue;
    if (c === 'quitar') { out.push({ line_id: r.id, remove: true }); continue; }
    if (c.cuenta === r.original) continue;
    out.push(r.sello
      ? { line_id: r.id, quantity: c.cuenta, qty_unit: r.sello.qty_unit, qty_factor: r.sello.qty_factor }
      : { line_id: r.id, quantity: c.cuenta });
  }
  return out;
}

/**
 * El motivo que se sugiere según lo que cambió (la vendedora lo puede cambiar): sólo sube → «agregar»;
 * sólo baja o quita → «quitar»; las dos → «cantidad».
 */
export function motivoSugerido(renglones: readonly RenglonEditable[], e: Edicion): 'agregar' | 'quitar' | 'cantidad' | null {
  let sube = false;
  let baja = false;
  for (const r of renglones) {
    const n = cuentaDe(r, e);
    if (n > r.original) sube = true;
    if (n < r.original) baja = true;
  }
  if (sube && baja) return 'cantidad';
  if (sube) return 'agregar';
  if (baja) return 'quitar';
  return null;
}

/** Sube o baja una pieza de la unidad del renglón; en 0 se queda en 1 (para dejarlo en 0 está «Quitar»). */
export function ajustar(e: Edicion, r: RenglonEditable, delta: 1 | -1): Edicion {
  const actual = cuentaDe(r, e) || r.original;
  const nueva = Math.max(1, actual + delta);
  return { ...e, [r.id]: { cuenta: nueva } };
}

export function quitar(e: Edicion, r: RenglonEditable): Edicion {
  return { ...e, [r.id]: 'quitar' };
}

/** Deshace lo que se le hizo a un renglón (vuelve a lo que tiene el pedido). */
export function deshacer(e: Edicion, r: RenglonEditable): Edicion {
  const { [r.id]: _fuera, ...resto } = e;
  return resto;
}
