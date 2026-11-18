import type { Knex } from 'knex';
import {
  validarPagos, type ComprobanteBanco, type MovimientoBanco, type PagoAValidar, type ValidacionPago,
} from '@megadulces/contracts/finance/validacion-pago';
import { SQL_COBERTURA_CUENTAS, SQL_MOVIMIENTOS_BANCO, periodosDe } from './fuera-de-programa.sql';

/**
 * `[PGP.104]` **La lectura de la validación banco + comprobante de los pagos de un día.** La regla
 * vive en el contrato (`validarPagos`, `[PGP.103]`); aquí sólo se juntan sus tres fuentes, sin
 * tablas nuevas ni importers (regla 1): el estado de cuenta (`finance.bank_movements`, con las MISMAS
 * consultas que `[PGP.97]`), los comprobantes (`finance.supplier_payment_proofs`) y los pagos.
 *
 * ⛔ **Uno a uno se mide con los vecinos.** Una salida del banco puede casar con un pago de OTRO día
 * (±5 días): por eso se leen los pagos vigentes de ±{@link MARGEN_VECINOS_DIAS} días, no sólo los del
 * día — si no, dos pagos iguales en días contiguos se validarían los dos con la misma salida.
 *
 * El comprobante se liga a su cuenta propia por los últimos dígitos de la cuenta de origen que leyó
 * el OCR (`ocr_cuenta_origen` termina en `bank_accounts.account_label`), la misma regla que midió
 * `[PGP.102]`: 87 de 90 casan con su salida, placebo 0.
 */
export const MARGEN_VECINOS_DIAS = 10;

function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Los pagos vigentes (no cancelados) de la ventana, con su día. Parámetros: `[tenant, desde, hasta]`. */
export const SQL_PAGOS_A_VALIDAR = `
SELECT a.id::text AS id, to_char(l.lot_date, 'YYYY-MM-DD') AS dia, a.amount_assigned::float8 AS importe,
       a.bank_account_id::text AS cuenta_id, a.payment_method AS metodo
  FROM finance.payment_allocations a
  JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
 WHERE a.tenant_id = ? AND a.status <> 'cancelled'
   AND l.lot_date BETWEEN ?::date AND ?::date`;

/**
 * Los comprobantes vivos de la ventana: importe y fecha del OCR (o lo capturado), y los dígitos de la
 * cuenta de origen. Parámetros: `[tenant, desde, hasta]`.
 */
export const SQL_COMPROBANTES_A_VALIDAR = `
SELECT p.id::text AS id, coalesce(p.ocr_monto, p.pago_monto)::float8 AS importe,
       to_char(coalesce(p.ocr_fecha, p.pago_date), 'YYYY-MM-DD') AS fecha,
       regexp_replace(coalesce(p.ocr_cuenta_origen, ''), '\\D', '', 'g') AS origen
  FROM finance.supplier_payment_proofs p
 WHERE p.tenant_id = ? AND p.status <> 'rechazado'
   AND coalesce(p.ocr_fecha, p.pago_date) BETWEEN ?::date AND ?::date`;

/** La cuenta propia cuyo número termina la cuenta de origen del OCR (la más larga gana); null si ninguna. */
export function cuentaDeOrigen(origen: string, cuentas: readonly { cuenta_id: string; account_label: string | null }[]): string | null {
  if (!origen) return null;
  const c = cuentas
    .map((x) => ({ id: x.cuenta_id, l: String(x.account_label ?? '').replace(/\D/g, '') }))
    .filter((x) => x.l.length >= 4 && origen.endsWith(x.l))
    .sort((a, b) => b.l.length - a.l.length);
  // Dos cuentas con el mismo final no se adivinan.
  if (!c.length || (c.length > 1 && c[0].l.length === c[1].l.length)) return null;
  return c[0].id;
}

/**
 * La validación de los pagos del día `date` (sólo de un día que ya llegó: uno por venir no se ha
 * pagado). Devuelve un mapa por id de pago; los pagos del día que no aparecen no se validaron.
 */
export async function leerValidacionDelDia(trx: Knex | Knex.Transaction, tenantId: string, date: string, hoy: string): Promise<Map<string, ValidacionPago>> {
  return leerValidacionDeLosDias(trx, tenantId, [date], hoy);
}

/**
 * `[PGP.151]` La validación de los pagos de VARIOS días, con las cuatro lecturas UNA vez. Antes la bandeja la pedía día
 * por día: 14 días × 4 consultas = ~1.3 s de sus ~2.8 s (medido en prod el 2026-11-18). Cada día se sigue validando
 * con SU ventana (±{@link MARGEN_VECINOS_DIAS} días de pagos y ±5 más de movimientos y comprobantes), filtrada en
 * memoria sobre lo leído para todos: el resultado es el mismo que pidiéndolo solo. La cobertura no depende del día
 * (de ella sólo se usan la cuenta y hasta dónde llega el libro).
 */
export async function leerValidacionDeLosDias(trx: Knex | Knex.Transaction, tenantId: string, dates: readonly string[], hoy: string): Promise<Map<string, ValidacionPago>> {
  const out = new Map<string, ValidacionPago>();
  const dias = [...new Set(dates)].filter((d) => d <= hoy).sort();
  if (!dias.length) return out;
  const gDesde = sumarDias(dias[0], -MARGEN_VECINOS_DIAS);
  const gHasta = sumarDias(dias[dias.length - 1], MARGEN_VECINOS_DIAS);
  const pagosTodos = (await trx.raw(SQL_PAGOS_A_VALIDAR, [tenantId, gDesde, gHasta])).rows as PagoAValidar[];
  const conPago = dias.filter((d) => pagosTodos.some((p) => p.dia === d));
  if (!conPago.length) return out;
  const cobertura = (await trx.raw(SQL_COBERTURA_CUENTAS, [hoy, hoy, periodosDe(gDesde, gHasta), tenantId])).rows as
    { cuenta_id: string; account_label: string | null; hasta: string | null }[];
  // Los movimientos van más allá de la ventana de pagos (±5) para que el uno a uno vea todo lo que compite.
  const movsTodos = ((await trx.raw(SQL_MOVIMIENTOS_BANCO, [tenantId, sumarDias(gDesde, -5), sumarDias(gHasta, 5)])).rows as
    { id: string; cuenta_id: string; fecha: string; salida: number; fecha_invalida: boolean }[])
    .filter((m) => m.salida > 0)
    .map<MovimientoBanco>((m) => ({ id: m.id, cuenta_id: m.cuenta_id, fecha: m.fecha, importe: Number(m.salida), fecha_invalida: !!m.fecha_invalida || m.fecha > hoy }));
  const compsTodos = ((await trx.raw(SQL_COMPROBANTES_A_VALIDAR, [tenantId, sumarDias(gDesde, -5), sumarDias(gHasta, 5)])).rows as
    { id: string; importe: number | null; fecha: string | null; origen: string }[])
    .map<ComprobanteBanco>((c) => ({ id: c.id, importe: Number(c.importe ?? 0), fecha: c.fecha, cuenta_id: cuentaDeOrigen(c.origen, cobertura) }));
  const cargado = new Map(cobertura.filter((c) => c.hasta).map((c) => [c.cuenta_id, c.hasta as string]));
  const entre = (f: string | null, a: string, b: string) => !!f && f >= a && f <= b;
  for (const date of conPago) {
    // La ventana de ESTE día, igual que cuando se pedía solo.
    const desde = sumarDias(date, -MARGEN_VECINOS_DIAS);
    const hasta = sumarDias(date, MARGEN_VECINOS_DIAS);
    const pagos = pagosTodos.filter((p) => entre(p.dia, desde, hasta));
    const movs = movsTodos.filter((m) => entre(m.fecha, sumarDias(desde, -5), sumarDias(hasta, 5)));
    const comprobantes = compsTodos.filter((c) => entre(c.fecha, sumarDias(desde, -5), sumarDias(hasta, 5)));
    const todos = validarPagos({
      pagos: pagos.map((p) => ({ ...p, importe: Number(p.importe) })),
      movimientos: movs, comprobantes, cargado_hasta: cargado,
    });
    for (const p of pagos) if (p.dia === date) out.set(p.id, todos.get(p.id)!);
  }
  return out;
}
