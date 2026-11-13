import { BadRequestException } from '@nestjs/common';
import { DISCOUNT_REASONS, DISCOUNT_REASON_LABEL, type DiscountReason, type PaymentCalendarDiscountLine } from '@megadulces/contracts';

/**
 * `[PGP.91]` **El descuento que el proveedor da AL PAGAR, normalizado y verificado.**
 *
 * Hay proveedores que al pagarles conceden un descuento (3 % de pronto pago, uno por volumen) y
 * Kepler lo formaliza DESPUÉS con una nota de crédito. Hasta hoy Tesorería calculaba el neto a
 * mano y el sobrante de la factura se volvía a ofrecer. Esta función es el ÚNICO lugar donde se
 * decide si un descuento capturado es válido: la usan `createAllocation`, `addItem` y
 * `setItemDiscount` (ésta a través de `descuentoSobreCubierto`).
 *
 * ⭐ La invariante: `applied_amount` es el **NETO que sale del banco** y la factura queda
 * **cubierta** por `applied_amount + discount_amount`. El tope del día y el cruce con el
 * `X-D-26` de Kepler leen el neto; el disponible de la obligación se descuenta con lo cubierto.
 *
 * ⛔ El servidor **revisa la cuenta, no le cree al cliente**: si llega la tasa, el descuento
 * tiene que ser esa tasa sobre la factura (con IVA) con ±1 centavo de redondeo.
 *
 * Pura: no toca la base. Lanza `BadRequestException` con el mensaje que ve el usuario.
 *
 * Historia: nació como `[PGP.44]`/`[PGP.51]` en el PR #482 (cerrado sin fusionar el 2026-11-06
 * cuando Edgar rehízo la pantalla de Pagos). Se trae tal cual, renumerada, más
 * `descuentoSobreCubierto`: en el rediseño casi toda factura entra COMPLETA (el «+», los grupos,
 * la propuesta del día), así que el descuento se fija sobre la factura ya puesta.
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
 * `[PGP.91]` Sólo una FACTURA de proveedor lleva descuento al pagar: es la que después recibe la
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
 * `[PGP.91]` El rótulo corto de un descuento: `Pronto pago 3 %` o `Volumen` (si se capturó en
 * pesos no hay tasa que decir). Lo usa el PDF del día.
 */
export function rotuloDescuento(reason: string | null | undefined, rate: number | string | null | undefined): string {
  const nombre = reason && reason in DISCOUNT_REASON_LABEL ? DISCOUNT_REASON_LABEL[reason as DiscountReason] : (reason || 'Descuento');
  const r = rate === null || rate === undefined || rate === '' ? null : Number(rate);
  return r !== null && Number.isFinite(r) && r > 0 ? `${nombre} ${pct(r)}` : nombre;
}

/**
 * `[PGP.91]` **Fijar (o quitar, con 0) el descuento de una factura que YA está en un pago.**
 *
 * Lo CUBIERTO no cambia —la factura sigue apartada por lo mismo, así que no hay disponible ni saldo
 * de Kepler que volver a medir—; lo que baja es lo que sale del banco: neto = cubierto − descuento.
 * Valida con la MISMA regla que el alta (`normalizarDescuento`): un solo validador para los
 * tres caminos. Pura: no toca la base.
 */
export function descuentoSobreCubierto(cubierto: number, body: Omit<DescuentoEntrada, 'applied_amount'>): DescuentoNormalizado {
  const c = round2(Number(cubierto));
  if (!(c > 0)) throw new BadRequestException('La factura no tiene importe cubierto: no hay a qué descontarle.');
  const d = vacio(body.discount_amount) ? 0 : Number(body.discount_amount);
  if (Number.isFinite(d) && d >= c - 0.005) throw new BadRequestException('El descuento no puede ser toda la factura: entonces no hay pago que programar.');
  // Un `d` inválido (NaN o negativo) deja el neto en lo cubierto y `normalizarDescuento` da SU mensaje.
  const n = normalizarDescuento({ ...body, applied_amount: Number.isFinite(d) && d > 0 ? round2(c - round2(d)) : c });
  if (Math.abs(n.covered - c) > 0.005) throw new BadRequestException('El descuento cambió lo cubierto de la factura: no se guarda.');
  return n;
}

/** `[PGP.101]` Los renglones del descuento tal como se guardan y se leen. */
export type LineaDescuento = PaymentCalendarDiscountLine;

/** `[PGP.101]` El resultado de fijar VARIOS descuentos: las columnas de siempre (agregadas) + los renglones. */
export interface DescuentosNormalizados extends DescuentoNormalizado {
  /** El mayor primero. `[]` = sin descuento. */
  lines: LineaDescuento[];
}

/** Máximo de renglones por factura: más que esto es una captura equivocada, no un trato con el proveedor. */
export const MAX_RENGLONES_DESCUENTO = 5;

/**
 * `[PGP.101]` **Fijar VARIOS descuentos sobre una factura ya puesta** (pronto pago 3 % + volumen 2 %).
 * Cada renglón se valida con la MISMA regla que el descuento único (`normalizarDescuento`): motivo,
 * detalle si es «Otro», y si trae tasa, que cuadre con lo cubierto ±1 centavo. Cada % va sobre lo
 * cubierto de la factura; el que es en cascada se captura en pesos. La suma no puede ser toda la factura.
 *
 * Las columnas de siempre quedan como AGREGADO —`discount_amount` es la suma, así que lo cubierto, el
 * neto, el tope del día y el cruce con Kepler no cambian—: motivo del renglón mayor, y tasa y nota sólo
 * si hay uno (con varios, decir una sola tasa mentiría). `[]` quita el descuento. Pura.
 */
export function descuentosSobreCubierto(cubierto: number, renglones: unknown): DescuentosNormalizados {
  const c = round2(Number(cubierto));
  if (!(c > 0)) throw new BadRequestException('La factura no tiene importe cubierto: no hay a qué descontarle.');
  if (!Array.isArray(renglones)) throw new BadRequestException('Los descuentos llegan como una lista (discounts).');
  if (renglones.length > MAX_RENGLONES_DESCUENTO) throw new BadRequestException(`Son ${renglones.length} descuentos para una factura: el máximo es ${MAX_RENGLONES_DESCUENTO}.`);
  const anticiposVistos = new Set<string>();
  const lines: LineaDescuento[] = renglones.map((r, i) => {
    const x = (r ?? {}) as Record<string, unknown>;
    // `[PGP.120]` El anticipo tiene su propia regla: con su documento, en pesos, una vez por documento.
    // Que el documento exista, sea del acreedor y alcance lo verifica el servicio contra Kepler.
    if (String(x['discount_reason'] ?? '').trim() === 'anticipo') {
      const ref = refDeAnticipo(x['anticipo']);
      const llave = `${ref.sucursal}|${ref.folio}`;
      if (anticiposVistos.has(llave)) throw new BadRequestException(`El anticipo ${ref.folio} viene dos veces: va una sola vez por factura.`);
      anticiposVistos.add(llave);
      if (!vacio(x['discount_rate'])) throw new BadRequestException(`El anticipo ${ref.folio} se aplica en pesos: no lleva porcentaje.`);
      const monto = Number(x['discount_amount']);
      if (!Number.isFinite(monto) || !(round2(monto) > 0)) throw new BadRequestException(`El anticipo ${ref.folio} no trae importe: di cuánto se aplica.`);
      // Que no alcance para toda la factura lo cuida la suma de abajo (un renglón solo es una suma de uno).
      return { reason: 'anticipo' as const, amount: round2(monto), rate: null, note: null, anticipo: ref };
    }
    const d = vacio(x['discount_amount']) ? 0 : Number(x['discount_amount']);
    if (Number.isFinite(d) && d === 0) throw new BadRequestException(`El descuento ${i + 1} es cero: quítalo o captura cuánto es.`);
    // Cada renglón se revisa solo, como si fuera el único: si la suma no cabe se dice abajo.
    const n = normalizarDescuento({ ...x, applied_amount: Number.isFinite(d) && d > 0 && d < c ? round2(c - round2(d)) : c });
    if (!(n.discount_amount < c)) throw new BadRequestException('El descuento no puede ser toda la factura: entonces no hay pago que programar.');
    return { reason: n.discount_reason as DiscountReason, amount: n.discount_amount, rate: n.discount_rate, note: n.discount_note };
  });
  const total = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (total >= c - 0.005) {
    throw new BadRequestException(lines.some((l) => l.reason === 'anticipo')
      ? MSG_ANTICIPO_TODA_LA_FACTURA
      : `Los descuentos suman $${total.toFixed(2)} y el pago cubre $${c.toFixed(2)}: no puede ser toda la factura.`);
  }
  lines.sort((a, b) => b.amount - a.amount);
  const uno = lines.length === 1 ? lines[0] : null;
  return {
    applied_amount: round2(c - total), discount_amount: total, covered: c,
    discount_reason: lines[0]?.reason ?? null, discount_rate: uno?.rate ?? null, discount_note: uno?.note ?? null,
    lines,
  };
}

/**
 * `[PGP.101]` Los renglones de una factura como se leen de la base: la columna `discount_lines`, o —si
 * el descuento se capturó antes de que hubiera varios— UN renglón armado con las columnas de siempre.
 * Así nadie lee dos formatos.
 */
export function lineasDeDescuento(it: {
  discount_lines?: unknown; discount_amount?: unknown; discount_reason?: unknown; discount_rate?: unknown; discount_note?: unknown;
}): LineaDescuento[] {
  const raw = typeof it.discount_lines === 'string' ? JSON.parse(it.discount_lines) : it.discount_lines;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((l: Record<string, unknown>) => {
      const a = l['anticipo'] as { sucursal?: unknown; folio?: unknown } | null | undefined;
      return {
        reason: l['reason'] as DiscountReason, amount: Number(l['amount']),
        rate: l['rate'] === null || l['rate'] === undefined ? null : Number(l['rate']),
        note: (l['note'] ?? null) as string | null,
        // `[PGP.120]` Sólo el renglón de anticipo trae su documento; los demás no ganan la llave.
        ...(a && a.sucursal && a.folio ? { anticipo: { sucursal: String(a.sucursal), folio: String(a.folio) } } : {}),
      };
    });
  }
  const monto = Number(it.discount_amount ?? 0);
  if (!(monto > 0) || !it.discount_reason) return [];
  return [{
    reason: it.discount_reason as DiscountReason, amount: monto,
    rate: it.discount_rate === null || it.discount_rate === undefined || it.discount_rate === '' ? null : Number(it.discount_rate),
    note: (it.discount_note ?? null) as string | null,
  }];
}

/** `[PGP.101]` El rótulo de TODOS los descuentos de una factura: `Pronto pago 3 % + Volumen`. Lo usan el PDF y la ficha. */
export function rotuloDescuentos(lines: LineaDescuento[]): string {
  return lines.map((l) => (l.reason === 'anticipo' && l.anticipo ? `Anticipo ${l.anticipo.folio}` : rotuloDescuento(l.reason, l.rate))).join(' + ');
}

/**
 * `[PGP.120]` Cuando el anticipo (solo o con otros descuentos) alcanza para toda la factura, no hay pago
 * que programar: el dinero ya salió con el anticipo y lo que falta es aplicarlo en Kepler.
 */
export const MSG_ANTICIPO_TODA_LA_FACTURA =
  'El anticipo alcanza para toda la factura: no hay pago que programar. Quita la factura del pago; Cuentas por pagar aplica el anticipo en Kepler.';

/**
 * `[PGP.120]` El documento del anticipo como llega en el renglón: sucursal de dos dígitos y folio de
 * Kepler (con sus ceros a la izquierda). Liberal con la forma (espacios), estricto con el significado.
 */
export function refDeAnticipo(v: unknown): { sucursal: string; folio: string } {
  const x = (v ?? {}) as Record<string, unknown>;
  const sucursal = String(x['sucursal'] ?? '').trim();
  const folio = String(x['folio'] ?? '').trim();
  if (!/^\d{2}$/.test(sucursal) || !/^[0-9A-Za-z]{1,20}$/.test(folio)) {
    throw new BadRequestException('El renglón de anticipo necesita su documento de Kepler (sucursal y folio).');
  }
  return { sucursal, folio };
}
