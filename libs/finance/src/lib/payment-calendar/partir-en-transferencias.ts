/**
 * `[PGP.190]` **Un pago que sale en varias transferencias se parte en varios pagos, uno por transferencia.**
 *
 * El pedido (Francisco, 2026-11-20): «hay pagos que se hacen con varias transferencias» (caso: un pago de más de un
 * millón de DE LA ROSA en un solo renglón del Calendario). Medido en prod (sólo lectura):
 *  - desde octubre, **8 de 179** pagos ejecutados del Calendario recibieron **dos** X-D-26 en Kepler; 3 de ellos desde
 *    dos cuentas nuestras distintas. Los 3 más grandes quedaron **sin casar con su salida del banco y sin validar**:
 *    la Suite busca UNA salida por el importe completo y el banco tiene dos parciales;
 *  - en Kepler **cada transferencia es su propio X-D-26** con su cuenta de origen (`kdxe.c22`), y cuando una factura
 *    se paga en dos, cada X-D-26 le abona una parte: CE012 (31-ago y 24-sep) y CP007 (4-nov), un millón y el resto;
 *  - **no hay tope fijo**: desde junio hubo 16 X-D-26 de más de un millón. Por eso los importes los escribe la persona.
 *    ⚠️ **Corregido el 2026-11-26 (`[PGP.221]`): BBVA SÍ tiene tope, $1,000,000.00 por operación** (Francisco; en la
 *    descarga del banco desde junio ninguna transferencia de BBVA pasa del millón). Los X-D-26 de más de un millón son de
 *    otros bancos. Una transferencia de BBVA que pasa del tope se prepara partida (`tope-por-transferencia.contract.ts`).
 *
 * Por eso cada transferencia es un PAGO (decisión de Francisco, 2026-11-20, «Partir en pagos»): su salida del banco
 * se casa sola por su importe, lleva su comprobante y su X-D-26 — igual que hoy lo hace Tesorería a mano —, y todo lo
 * que ya funciona por pago (autorizar, casar con el banco, escribir en Kepler, cerrar) no cambia.
 *
 * Aquí sólo el reparto, puro: los renglones del pago, en orden, llenan la 1ª transferencia, luego la 2ª…; la factura
 * que cae en la frontera se parte en dos renglones. ⛔ La que lleva descuento al pagar no se parte (el descuento es de
 * la factura entera y `ck_pai_discount_consistency` lo ata a su renglón): se dice a cuánto dejar la transferencia.
 */

import { MAX_TRANSFERENCIAS_POR_PAGO } from '@megadulces/contracts';

/**
 * Hasta cuántas transferencias se parte un pago. Medido desde agosto: una factura de proveedor llegó a 5 X-D-26 el mismo día.
 * `[PGP.221]` Vive en `@megadulces/contracts` (la pantalla lo usa al partir sola por el tope del banco).
 */
export const MAX_TRANSFERENCIAS = MAX_TRANSFERENCIAS_POR_PAGO;

/** La bitácora del pago (`finance.payment_allocation_history.event`): en el original y en cada parte nueva. */
export const EVENTO_PARTIDO_EN_TRANSFERENCIAS = 'partido_en_transferencias';

/** Un renglón del pago, en el orden en que se reparte. */
export interface RenglonParaPartir {
  id: string;
  /** Lo que el renglón paga (neto). */
  applied_amount: number;
  /** Descuento al pagar del renglón: si es mayor que cero, el renglón no se parte. */
  discount_amount: number;
  /** Cómo se nombra la factura en un aviso (p. ej. `20-1-0000101`). */
  factura: string;
}

/** Lo que una transferencia lleva de un renglón. Un mismo `item_id` aparece en dos partes si su factura se partió. */
export interface TramoDeRenglon {
  item_id: string;
  applied_amount: number;
}

export interface ParteDelPago {
  importe: number;
  tramos: TramoDeRenglon[];
}

/** Un reparto imposible, dicho para la persona (el servicio lo devuelve como 400). */
export class ErrorAlPartir extends Error {}

const centavos = (n: number): number => Math.round(n * 100);
const pesos = (c: number): string => (c / 100).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * Reparte los renglones entre las transferencias. Los importes van en el orden de las transferencias y tienen que
 * sumar exactamente el pago (al centavo).
 */
export function partirEnTransferencias(renglones: readonly RenglonParaPartir[], importes: readonly number[]): ParteDelPago[] {
  if (importes.length < 2) throw new ErrorAlPartir('Para partir el pago se necesitan al menos dos transferencias.');
  if (importes.length > MAX_TRANSFERENCIAS) throw new ErrorAlPartir(`Un pago se parte en ${MAX_TRANSFERENCIAS} transferencias como máximo.`);
  if (!renglones.length) throw new ErrorAlPartir('El pago no tiene facturas que repartir.');
  const imp = importes.map((x) => (Number.isFinite(x) ? centavos(x) : NaN));
  if (imp.some((x) => !(x > 0))) throw new ErrorAlPartir('Cada transferencia lleva un importe mayor que cero.');
  const total = renglones.reduce((s, r) => s + centavos(r.applied_amount), 0);
  const suma = imp.reduce((s, x) => s + x, 0);
  if (suma !== total) {
    throw new ErrorAlPartir(`Las transferencias suman ${pesos(suma)} y el pago es de ${pesos(total)}: tienen que sumar lo mismo.`);
  }

  const partes: ParteDelPago[] = imp.map((c) => ({ importe: c / 100, tramos: [] }));
  let k = 0;
  let cabe = imp[0];
  // Dónde empieza la parte k, contado desde el inicio del pago (para decir a cuánto dejarla).
  let inicioDeK = 0;
  let pos = 0;
  for (const r of renglones) {
    const monto = centavos(r.applied_amount);
    let resto = monto;
    while (resto > 0) {
      if (cabe === 0) { inicioDeK += imp[k]; k++; cabe = imp[k]; }
      const toma = Math.min(resto, cabe);
      if (toma < monto && r.discount_amount > 0) {
        // La frontera de la parte k cae dentro de esta factura: o la parte termina donde empieza la factura, o
        // donde acaba. Se proponen las que dejan la parte con algo.
        // Terminar antes de la factura sirve si la parte no queda vacía; terminar después, si a las que siguen les
        // queda algo.
        const opciones = [
          ...(pos > inicioDeK ? [pos - inicioDeK] : []),
          ...(pos + monto < suma ? [pos + monto - inicioDeK] : []),
        ].map(pesos);
        throw new ErrorAlPartir(`La factura ${r.factura} lleva descuento al pagar y no se parte entre dos transferencias`
          + (opciones.length
            ? `: deja la ${k + 1}ª transferencia en ${opciones.join(' o en ')}.`
            : ': es la única del pago, así que este pago sale en una sola transferencia.'));
      }
      partes[k].tramos.push({ item_id: r.id, applied_amount: toma / 100 });
      resto -= toma;
      cabe -= toma;
    }
    pos += monto;
  }
  return partes;
}
