/**
 * `[LE.5.1a]` — La captura vieja de Caja General (`finance.cash_ledger`) pasada por las reglas del
 * libro. Pura: decide, captura por captura, si entra (con su asiento), si espera a una persona
 * (cola) o si NO entra porque ese dinero ya lo explica otro hecho. Cada caso medido en prod el
 * 2026-10-27 sobre las 393 capturas desde el 15-oct.
 *
 *  · gasto pagado del cajón → `gasto` (piezas del cajón + morralla, D16).
 *  · cobro de una ruta → `entrega_ruta` (Kepler ya dijo que la ruta lo debía: no hay doble conteo).
 *  · cobro que no es de ruta → `otro_ingreso` «cobro de sucursal» (D17).
 *  · «ingreso caos» o cobro ligado a un depósito de CAOS → FUERA: el efectivo entró a la máquina y
 *    ese depósito lo asienta el carril de CAOS. Contarlo aquí sería contarlo dos veces.
 *  · gasto pagado con un retiro de CAOS → COLA: el retiro está en Suspenso y una persona dice qué
 *    gastos pagó (un retiro, muchos gastos).
 *  · piezas + morralla ≠ monto → COLA: la captura no se explica a sí misma.
 *  · cancelada → FUERA (si ya estaba asentada, la reversa la pide una persona: B42).
 */
import type { PiezasTexto } from '@megadulces/contracts';
import { pesosACentavos, valorDePiezas } from '@megadulces/contracts';
import { entregaRuta, gasto, otroIngreso, type Contexto, type Propuesta } from './reglas';

export interface PiezaCapturada { denom_key: string; flujo: 'recibido' | 'devuelto'; piezas: number }

export interface CapturaVieja {
  id: string;
  folio: string;
  tipo: 'gasto' | 'ingreso';
  origen_tipo: string | null;
  origen_ref: string | null;
  origen_efectivo: string | null;
  estado: string;
  /** Pesos con dos decimales, como texto (`'1060.00'`). */
  monto: string;
  morralla: string | null;
  concepto: string | null;
  piezas: PiezaCapturada[];
  /** Tiene un enlace vivo con un movimiento de CAOS (`finance.caos_cash_links`). */
  ligada_a_caos: boolean;
  /** La ruta del cobro según `route_collections`, sin ceros a la izquierda; null si no es de ruta. */
  ruta: string | null;
  /** El nombre de la sucursal del cobro que no es de ruta (D17). */
  sucursal: string | null;
}

export type DestinoDeCaptura =
  | { destino: 'libro'; propuesta: Propuesta }
  | { destino: 'cola'; motivo: string }
  | { destino: 'fuera'; motivo: string };

/** Piezas netas que la captura mueve en el cajón, en valor absoluto del sentido del movimiento. */
export function piezasNetas(c: CapturaVieja): PiezasTexto {
  const neto = new Map<string, bigint>();
  for (const p of c.piezas) {
    const n = BigInt(p.piezas) * (p.flujo === 'devuelto' ? -1n : 1n);
    neto.set(p.denom_key, (neto.get(p.denom_key) ?? 0n) + n);
  }
  return Object.fromEntries([...neto].filter(([, n]) => n !== 0n).map(([k, n]) => [k, n.toString()]));
}

/** Valor en centavos de unas piezas, con el catálogo de denominaciones. */
const valor = (p: PiezasTexto): bigint => valorDePiezas(Object.fromEntries(Object.entries(p).map(([k, n]) => [k, Number(n)])));

export function hechoDeCaptura(c: CapturaVieja, ctx: Contexto): DestinoDeCaptura {
  if (c.estado === 'cancelado') return { destino: 'fuera', motivo: 'cancelada en la captura vieja' };
  if (c.origen_tipo === 'caos') return { destino: 'fuera', motivo: 'es un depósito a CAOS: lo asienta el carril de la máquina' };
  if (c.tipo === 'ingreso' && c.ligada_a_caos) {
    return { destino: 'fuera', motivo: 'el efectivo del cobro entró a CAOS: lo asienta el carril de la máquina' };
  }
  if (c.tipo === 'gasto' && (c.origen_efectivo === 'caos' || c.ligada_a_caos)) {
    return { destino: 'cola', motivo: 'gasto pagado con un retiro de CAOS: una persona dice qué retiro lo pagó' };
  }

  const piezas = piezasNetas(c);
  const morralla = c.morralla ? pesosACentavos(c.morralla) : 0n;
  const monto = pesosACentavos(c.monto);
  if (valor(piezas) + morralla !== monto) {
    return { destino: 'cola', motivo: `piezas ${valor(piezas)} + morralla ${morralla} ≠ monto ${monto} (centavos)` };
  }
  const mor = morralla > 0n ? morralla.toString() : undefined;   // las reglas reciben centavos
  const extra = { event_ref: `cash_ledger:${c.id}`, meta: { origen: 'cash_ledger', folio: c.folio, ...(c.origen_ref ? { origen_ref: c.origen_ref } : {}) } };

  if (c.tipo === 'gasto') {
    return { destino: 'libro', propuesta: gasto({ concepto: c.concepto || 'sin concepto', desde: { tipo: 'cajon', piezas, morralla: mor } }, ctx, extra) };
  }
  if (c.ruta) return { destino: 'libro', propuesta: entregaRuta({ ruta: c.ruta, piezas, morralla: mor }, ctx, extra) };
  return { destino: 'libro', propuesta: otroIngreso({ concepto: `cobro de sucursal ${c.sucursal ?? 'sin nombre'}`, piezas, morralla: mor }, ctx, extra) };
}
