import { BadRequestException } from '@nestjs/common';
import { DISCOUNT_REASONS, DISCOUNT_REASON_LABEL, type DiscountReason } from '@megadulces/contracts';

/**
 * `[PGP.51]` **El descuento que el proveedor da AL PAGAR, normalizado y verificado.**
 *
 * Hay proveedores que al pagarles conceden un descuento (3 % de pronto pago, uno por volumen) y
 * Kepler lo formaliza DESPUÉS con una nota de crédito. Hasta hoy Tesorería calculaba el neto a
 * mano y el sobrante de la factura se volvía a ofrecer. Esta función es el ÚNICO lugar donde se
 * decide si un descuento capturado es válido: la usan `createAllocation` y `addItem`.
 *
 * ⭐ La invariante: `applied_amount` es el **NETO que sale del banco** y la factura queda
 * **cubierta** por `applied_amount + discount_amount`. El tope del día y el cruce con el
 * `X-D-26` de Kepler leen el neto; el disponible de la obligación se descuenta con lo cubierto.
 *
 * ⛔ El servidor **revisa la cuenta, no le cree al cliente**: si llega la tasa, el descuento
 * tiene que ser esa tasa sobre la factura (con IVA) con ±1 centavo de redondeo.
 *
 * Pura: no toca la base. Lanza `BadRequestException` con el mensaje que ve el usuario.
 */
export interface DescuentoEntrada {
  applied_amount: unknown;
  discount_amount?: unknown;
  discount_reason?: unknown;
  discount_rate?: unknown;
  discount_note?: unknown;
}

export interface DescuentoNormalizado {
  /** NETO: lo que sale del banco por esta factura. */
  applied_amount: number;
  discount_amount: number;
  discount_reason: DiscountReason | null;
  /** Fracción (0.03 = 3 %), redondeada a 6 decimales; null si se capturó en pesos. */
  discount_rate: number | null;
  discount_note: string | null;
  /** Lo que la factura queda cubierta: neto + descuento. Es lo que se resta del disponible. */
  covered: number;
}

/** Redondeo a centavos. El `EPSILON` evita que 1.005 se vaya a 1.00 por la coma flotante. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const vacio = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function normalizarDescuento(it: DescuentoEntrada): DescuentoNormalizado {
  const appliedRaw = Number(it.applied_amount);
  // Mismo mensaje que ya devolvía el servicio: hay pantallas y pruebas que lo leen.
  if (!Number.isFinite(appliedRaw) || !(round2(appliedRaw) > 0)) throw new BadRequestException('applied_amount debe ser > 0');
  const applied = round2(appliedRaw);

  const discountRaw = vacio(it.discount_amount) ? 0 : Number(it.discount_amount);
  if (!Number.isFinite(discountRaw) || discountRaw < 0) {
    throw new BadRequestException('El descuento debe ser un importe en pesos mayor o igual a cero.');
  }
  const discount = round2(discountRaw);

  let reason: DiscountReason | null = null;
  if (!vacio(it.discount_reason)) {
    const r = String(it.discount_reason).trim();
    if (!(DISCOUNT_REASONS as readonly string[]).includes(r)) {
      throw new BadRequestException(`Motivo de descuento inválido: debe ser ${DISCOUNT_REASONS.map((x) => DISCOUNT_REASON_LABEL[x]).join(', ')}.`);
    }
    reason = r as DiscountReason;
  }

  if (discount === 0) {
    // Un motivo o una tasa sin pesos es una captura a medias: se dice, no se adivina cuál sobra.
    if (reason) throw new BadRequestException('Se eligió un motivo de descuento pero el descuento es cero: captura el descuento o quita el motivo.');
    if (!vacio(it.discount_rate)) throw new BadRequestException('Llegó una tasa de descuento sin descuento: captura el descuento o quita la tasa.');
    return { applied_amount: applied, discount_amount: 0, discount_reason: null, discount_rate: null, discount_note: null, covered: applied };
  }

  if (!reason) throw new BadRequestException('Falta el motivo del descuento (Pronto pago, Volumen u Otro).');
  const note = vacio(it.discount_note) ? null : String(it.discount_note).trim();
  if (reason === 'otro' && !note) throw new BadRequestException('El motivo «Otro» necesita un detalle: di qué descuento es.');

  const covered = round2(applied + discount);
  // Con `applied > 0` esto siempre se cumple; queda escrito porque ES la regla (el descuento no
  // puede cubrir la factura entera: entonces no hay pago, hay una nota de crédito).
  if (!(discount < covered)) throw new BadRequestException('El descuento no puede ser toda la factura: entonces no hay pago que programar.');

  let rate: number | null = null;
  if (!vacio(it.discount_rate)) {
    const rateRaw = Number(it.discount_rate);
    // El rango se revisa YA redondeado: 1e-7 pasaba como «> 0», se guardaba como 0 y la base lo
    // rechazaba con un 500 en vez de este mensaje.
    rate = Number.isFinite(rateRaw) ? Math.round(rateRaw * 1e6) / 1e6 : NaN;
    if (!(rate > 0 && rate < 1)) {
      throw new BadRequestException('La tasa del descuento debe estar entre 0 y 100 %.');
    }
    const esperado = round2(rate * covered);
    if (Math.abs(esperado - discount) > 0.01 + 1e-9) {
      throw new BadRequestException(
        `El descuento no cuadra con la tasa: ${pct(rate)} de $${covered.toFixed(2)} son $${esperado.toFixed(2)}, no $${discount.toFixed(2)}.`);
    }
  }

  return { applied_amount: applied, discount_amount: discount, discount_reason: reason, discount_rate: rate, discount_note: note, covered };
}

/**
 * `[PGP.51]` Sólo una FACTURA de proveedor lleva descuento al pagar: es la que después recibe la
 * nota de crédito en Kepler. En un gasto de presupuesto o un compromiso financiero no hay nota
 * que llegue: el «descuento» dejaba la obligación pagada por completo con menos dinero, y en el
 * gasto, la diferencia comprometida para siempre en su renglón de presupuesto.
 */
export const ORIGENES_CON_DESCUENTO: readonly string[] = ['supplier_payable', 'kepler_payable'];

/**
 * ⛔ El ORIGEN no basta: una deuda derivada de Kepler (`kepler_payable`) también puede ser un
 * compromiso financiero — los préstamos de socios lo son. Lo encontró la prueba visual: el
 * diálogo ofrecía descuento sobre un préstamo de $8,000,000. Por eso se exige además la
 * clasificación de mercancía, la misma que decide `classificationOf`.
 */
export function assertDescuentoPermitido(source: string, classification: string, discountAmount: number): void {
  if (discountAmount > 0 && (!ORIGENES_CON_DESCUENTO.includes(source) || classification !== 'proveedor_mercancia')) {
    throw new BadRequestException('El descuento al pagar sólo aplica a facturas de proveedor: en gastos y compromisos financieros no llega una nota de crédito que lo cierre.');
  }
}

/** `3 %`, `2.5 %`: la tasa como se lee en pantalla (hasta 2 decimales, sin ceros de sobra). */
export function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(2))} %`;
}

/**
 * `[PGP.51]` El rótulo corto de un descuento: `Pronto pago 3 %` o `Volumen` (si se capturó en
 * pesos no hay tasa que decir). Lo usa el PDF del día.
 */
export function rotuloDescuento(reason: string | null | undefined, rate: number | string | null | undefined): string {
  const nombre = reason && reason in DISCOUNT_REASON_LABEL ? DISCOUNT_REASON_LABEL[reason as DiscountReason] : (reason || 'Descuento');
  const r = rate === null || rate === undefined || rate === '' ? null : Number(rate);
  return r !== null && Number.isFinite(r) && r > 0 ? `${nombre} ${pct(r)}` : nombre;
}
