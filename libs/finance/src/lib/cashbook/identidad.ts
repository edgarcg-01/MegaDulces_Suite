/**
 * `[LE.2.4]` — La identidad de un hecho externo y su huella (Fase LE, reglas B3 y B42).
 *
 * Un hecho de fuera (un movimiento de la máquina, un cobro de Kepler) entra al libro UNA vez por
 * versión: `event_ref` dice CUÁL es y `event_hash` dice QUÉ decía cuando se asentó. Si la fuente
 * lo reescribe, la huella cambia, la base rechaza el asiento (`cashbook_evento_cambio`) y el
 * cambio se registra como reversa + versión nueva. Nunca se edita.
 *
 * La huella es `sha256` de un JSON con llaves ORDENADAS: el mismo contenido da la misma huella sin
 * importar el orden en que la fuente mande las columnas.
 */
import { createHash } from 'node:crypto';
import type { PiezasTexto } from '@megadulces/contracts';
import { efectoDeTipo } from '../caos/caos-saldo';

type Plano = string | number | boolean | null | Plano[] | { [k: string]: Plano };

function canonico(valor: Plano): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
  }
  return JSON.stringify(valor);
}

export const huella = (valor: Plano): string => createHash('sha256').update(canonico(valor), 'utf8').digest('hex');

/** Un renglón de `analytics.caos_cash_denominations` (lo que trae el feed de la máquina). */
export interface PiezaCaos {
  denom: string | number;
  pieza_tipo: string;
  quantity: string | number;
}

/** Un renglón de `analytics.caos_cash_movements` con su desglose. */
export interface MovimientoCaos {
  device: string;
  external_id: string | number;
  type_id: number;
  type_label: string;
  occurred_at: string | Date;
  total: string | number;
  ref: string | null;
  user_external: string | null;
  piezas: readonly PiezaCaos[];
}

export class HechoInvalido extends Error {
  constructor(readonly codigo: string, mensaje: string) {
    super(mensaje);
    this.name = 'HechoInvalido';
  }
}

/**
 * La llave del catálogo para una pieza de la máquina. Medido en prod el 2026-10-27: la máquina sólo
 * maneja billetes (`pieza_tipo = 'B'`) de $20 a $500. La moneda de $20 lleva `m` (catálogo SM.39).
 * Un tipo de pieza desconocido REVIENTA: es dinero que no se sabría contar.
 */
export function llaveDePiezaCaos(denom: string | number, piezaTipo: string): string {
  const valor = Math.abs(Number(denom));
  if (!Number.isFinite(valor) || valor <= 0) throw new HechoInvalido('pieza_caos_invalida', `denominación «${denom}»`);
  const texto = Number.isInteger(valor) ? String(valor) : String(valor).replace(/0+$/, '');
  if (piezaTipo === 'B') return texto;
  if (piezaTipo === 'M') return valor === 20 ? '20m' : texto;
  throw new HechoInvalido('pieza_caos_invalida', `tipo de pieza «${piezaTipo}» (se esperaba B o M)`);
}

/**
 * Las piezas que ENTRAN a la máquina en un movimiento, con signo, o `null` si la dirección del tipo
 * no está probada. El signo sale de `efectoDeTipo` (`caos-saldo.ts`, medido): depósito y dotar
 * entran, dispensar y vaciar salen. En «Cambio» la denominación misma trae el signo (lo que sale
 * viene negativo, medido el 2026-10-27), pero el tipo está marcado «indeterminado»: se devuelve
 * con esa advertencia en `direccionProbada`.
 */
export function piezasQueEntranALaMaquina(m: MovimientoCaos): { piezas: PiezasTexto; direccionProbada: boolean } | null {
  const efecto = efectoDeTipo(m.type_id);
  const esCambio = m.type_id === 7;
  if (efecto.signo === 0 && !esCambio) return null;
  const signoDelTipo = esCambio ? 1n : BigInt(efecto.signo);
  const acumulado = new Map<string, bigint>();
  for (const p of m.piezas) {
    const signoDeLaDenominacion = Number(p.denom) < 0 ? -1n : 1n;
    const n = BigInt(String(p.quantity)) * signoDelTipo * signoDeLaDenominacion;
    const k = llaveDePiezaCaos(p.denom, p.pieza_tipo);
    acumulado.set(k, (acumulado.get(k) ?? 0n) + n);
  }
  const fuera: PiezasTexto = {};
  for (const [k, n] of [...acumulado].sort(([a], [b]) => a.localeCompare(b))) if (n !== 0n) fuera[k] = n.toString();
  return { piezas: fuera, direccionProbada: !esCambio };
}

/** `event_ref` + `event_hash` de un movimiento de la máquina. */
export function identidadDeCaos(m: MovimientoCaos): { event_ref: string; event_hash: string } {
  return {
    event_ref: `caos:${m.device}:${String(m.external_id)}`,
    event_hash: huella({
      type_id: m.type_id,
      total: String(m.total),
      occurred_at: new Date(m.occurred_at).toISOString(),
      ref: m.ref,
      user_external: m.user_external,
      // Las piezas CRUDAS, ordenadas: la huella no depende de cómo se interprete la dirección.
      piezas: [...m.piezas].map((p) => `${String(p.pieza_tipo)}|${Number(p.denom)}|${String(p.quantity)}`).sort(),
    }),
  };
}

/** `event_ref` + `event_hash` de un cobro de Kepler (su `origen_ref`, el mismo que usa el libro viejo). */
export function identidadDeCobroKepler(c: { origen_ref: string; monto: string; fecha: string; ruta: string }): { event_ref: string; event_hash: string } {
  return { event_ref: `kepler:${c.origen_ref}`, event_hash: huella({ monto: c.monto, fecha: c.fecha, ruta: c.ruta }) };
}
