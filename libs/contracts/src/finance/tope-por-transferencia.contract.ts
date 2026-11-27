import { bancoCanonico } from './mismo-banco.contract';

/**
 * `[PGP.221]` **El banco no deja pasar una transferencia de más de su tope por operación.**
 *
 * Francisco, 2026-11-26: *«la restricción en el banco BBVA es real, es el tope por operación»*. Medido en prod (sólo
 * lectura, la descarga del banco desde el 1-jun-2026): de las salidas de BBVA, **ninguna transferencia pasa de
 * $1,000,000.00** y 14 son de $1,000,000.00 exactos (9 SPEI, 1 traspaso entre cuentas BBVA y 4 de otros formatos de la
 * descarga); lo único arriba de un millón son pagos de crédito. Santander sí deja: 2 pagos de más de un millón desde
 * octubre. El caso que lo pidió: Effem, 25-nov, $1,020,891.81 desde BBVA salió en dos SPEI ($1,000,000.00 + el resto) sin
 * estar partido en la Suite, y su pago quedó en Kepler como UN documento por la suma.
 *
 * Por eso una transferencia de BBVA que pasa del tope se prepara partida (`[PGP.190]`): cada parte se casa con su salida
 * del banco, lleva su comprobante y su X-D-26. La misma regla en «Preparar pago» (que la parte sola) y en el servidor (que
 * no prepara ni autoriza una transferencia que el banco no va a dejar pasar).
 *
 * ⛔ Un banco sin tope conocido no se bloquea: sólo se aplica lo que se midió.
 */

/** El tope por operación de cada banco (nombre canónico de `bancoCanonico`). */
export const TOPE_POR_TRANSFERENCIA: Readonly<Record<string, number>> = Object.freeze({ BBVA: 1_000_000 });

/** `[PGP.190]` Un pago se parte en esta cantidad de transferencias como máximo (la pantalla y el servidor). */
export const MAX_TRANSFERENCIAS_POR_PAGO = 10;

const centavos = (n: number): number => Math.round(Number(n) * 100);
const pesos = (n: number): string => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** El tope por transferencia del banco, o `null` si no tiene uno conocido. */
export function topeDeTransferencia(banco: string | null | undefined): number | null {
  const b = bancoCanonico(banco);
  return b ? TOPE_POR_TRANSFERENCIA[b] ?? null : null;
}

/**
 * Las transferencias en que sale un importe con ese tope: el tope en cada una y el resto en la última, al centavo.
 * `null` si harían falta más de `MAX_TRANSFERENCIAS_POR_PAGO` (o si el importe o el tope no son positivos).
 */
export function partesPorTope(importe: number, tope: number): number[] | null {
  const c = centavos(importe), t = centavos(tope);
  if (!(c > 0) || !(t > 0)) return null;
  const n = Math.ceil(c / t);
  if (n > MAX_TRANSFERENCIAS_POR_PAGO) return null;
  return [...Array.from({ length: n - 1 }, () => t / 100), (c - t * (n - 1)) / 100];
}

export interface ExcesoDeTope {
  /** El banco, con su nombre canónico (`BBVA`). */
  banco: string;
  tope: number;
  /** Las transferencias en que sale (el tope y el resto); `null` si serían más de las que admite un pago. */
  partes: number[] | null;
}

/** Si el importe pasa del tope del banco: cuánto es el tope y en cuántas sale. `null` si cabe o el banco no tiene tope. */
export function excesoDeTope(importe: number, banco: string | null | undefined): ExcesoDeTope | null {
  const tope = topeDeTransferencia(banco);
  if (tope == null || !(centavos(importe) > centavos(tope))) return null;
  return { banco: bancoCanonico(banco) as string, tope, partes: partesPorTope(importe, tope) };
}

/**
 * El aviso en palabras, el mismo en la pantalla y en el servidor; `null` si la transferencia cabe.
 *  · `parte`: es la transferencia N de un pago partido → que se parta en más.
 *  · `esAnticipo`: un anticipo sale en UNA transferencia (`[PGP.128]` D12) → que salga de otro banco.
 *  · si no, el pago entero → en cuántas sale y dónde se parte.
 */
export function avisoDeTope(e: { importe: number; banco: string | null | undefined; esAnticipo?: boolean; parte?: number }): string | null {
  const x = excesoDeTope(e.importe, e.banco);
  if (!x) return null;
  const tope = pesos(x.tope), importe = pesos(e.importe);
  if (e.parte) {
    return `La transferencia ${e.parte} es de ${importe} y sale de ${x.banco}, que no deja pasar de ${tope} por operación: pártela en más transferencias.`;
  }
  if (e.esAnticipo) {
    return `${x.banco} no deja pasar de ${tope} por transferencia y este anticipo es de ${importe}: un anticipo sale en una sola transferencia, así que elige una cuenta de origen de otro banco.`;
  }
  const enCuantas = x.partes
    ? `${x.partes.length} transferencias (${x.partes.map(pesos).join(' + ')})`
    : `más de ${MAX_TRANSFERENCIAS_POR_PAGO} transferencias, más de las que admite un pago: elige una cuenta de origen de otro banco`;
  return `${x.banco} no deja pasar de ${tope} por transferencia y este pago es de ${importe}: sale en ${enCuantas}.`
    + (x.partes ? ' En «Preparar pago», márcalo «Sale en varias transferencias».' : '');
}
