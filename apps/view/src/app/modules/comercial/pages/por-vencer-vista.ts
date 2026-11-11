import { warehouseName } from '@megadulces/contracts';
import type { ExpiringLot } from '../comercial.service';
import type { EstadoLote, JuicioLotes, LoteCaducidad } from '../../compras/productos-flujo.service';

/**
 * `[CE.1.4]` + `[CE.3.1]` Lo que «Por vencer» dice de cada renglón, en funciones puras (probadas en
 * `por-vencer-vista.spec.ts`). El juicio NO se calcula aquí: es el de `juzgarLotes` del servidor
 * (`GET /commercial/products/flow/lotes`), ADR-056 — un primitivo vive en un solo lugar.
 */

/** Lo más que acepta el servidor por llamada (como la lista del flujo). */
export const MAX_IDS_JUICIO = 200;

/** Los productos de la lista, sin repetir, en tandas que el servidor acepta. */
export function tandasDeProductos(lots: Pick<ExpiringLot, 'product_id'>[], max = MAX_IDS_JUICIO): string[][] {
  const ids = [...new Set(lots.map((l) => l.product_id).filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += max) out.push(ids.slice(i, i + max));
  return out;
}

/** El juicio de cada lote por el id de su renglón (los que no traen id no se pueden casar y no entran). */
export function juicioPorLote(respuestas: Pick<JuicioLotes, 'productos'>[]): Map<string, LoteCaducidad> {
  const out = new Map<string, LoteCaducidad>();
  for (const r of respuestas) for (const p of r.productos) for (const l of p.lotes) if (l.lot_id) out.set(l.lot_id, l);
  return out;
}

const cantidadFmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const cantidad = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? cantidadFmt.format(n) : '—';
};

/** ¿Se puede creer la cantidad del lote? `vendido` = puede estar ya vendido; `sin_dato` = no se supo. */
export type ConfianzaLote = 'cierta' | 'vendido' | 'sin_dato';

export function confianzaLote(l: Pick<ExpiringLot, 'dated_may_be_stale'>): ConfianzaLote {
  if (l.dated_may_be_stale === true) return 'vendido';
  if (l.dated_may_be_stale === false) return 'cierta';
  return 'sin_dato'; // servidor previo o NA no leído: nunca se dibuja como cierto
}

/** La declaración del renglón en llano; NULL si la cantidad se puede creer. */
export function textoConfianza(l: Pick<ExpiringLot, 'dated_may_be_stale' | 'na_qty'>): string | null {
  switch (confianzaLote(l)) {
    case 'vendido':
      return `Puede estar ya vendido: hay ${cantidad(l.na_qty)} sin fecha de este producto en este almacén y la venta descuenta primero lo sin fecha`;
    case 'sin_dato':
      return 'No se pudo comprobar si ya se vendió';
    default:
      return null;
  }
}

/** Cuántos renglones están en cada situación y cuánto valor no se puede dar por cierto. */
export function resumenConfianza(lots: Pick<ExpiringLot, 'dated_may_be_stale' | 'value_at_cost'>[]) {
  let vendido = 0;
  let sinDato = 0;
  let valorIncierto = 0;
  for (const l of lots) {
    const c = confianzaLote(l);
    if (c === 'cierta') continue;
    if (c === 'vendido') vendido++;
    else sinDato++;
    valorIncierto += Number(l.value_at_cost || 0);
  }
  return { total: lots.length, vendido, sinDato, valorIncierto };
}

export const ESTADO_SEVERIDAD: Record<EstadoLote, 'danger' | 'warn' | 'success'> = {
  caducado: 'danger', no_alcanza: 'danger', justo: 'warn', a_tiempo: 'success',
};

/** «Mover 100 a La Piedad Abastos y 40 a Zamora»: la sucursal SIEMPRE por nombre, jamás por código. */
export function textoMover(j: Pick<LoteCaducidad, 'mover_a'>): string | null {
  if (!j.mover_a.length) return null;
  const partes = j.mover_a.map((m) => `${cantidad(m.cantidad)} a ${m.nombre || warehouseName(m.plaza) || m.plaza}`);
  const lista = partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}`;
  return `Mover ${lista}`;
}

/** ¿El juicio propone moverlo? Entonces el lugar de actuar es Pedido (ahí Compras arma el traspaso). */
export function proponeMover(j: Pick<LoteCaducidad, 'mover_a'> | null | undefined): boolean {
  return !!j && j.mover_a.length > 0;
}
