/**
 * `[PGP.103]` **Un pago del Calendario está pagado cuando lo prueban el banco y su comprobante.**
 *
 * El flujo nuevo de Pagos (Edgar, 2026-11-09): armar → forma de pago → Dirección autoriza → se paga
 * → **se valida contra el estado de cuenta y el comprobante** → se escribe el `X-D-26` en Kepler.
 * «Pagado» deja de ser un clic: lo pone la evidencia (F2: banco Y comprobante).
 *
 * Medido en prod (sólo lectura, `[PGP.102]`, 2026-11-09), contra los 87 pagos del Calendario que
 * Kepler ya saldó como verdad independiente, con placebo (fechas corridas −35/−60 días):
 * - **Pago ↔ movimiento del banco**, MISMA cuenta de origen, ±$1, ±5 días del día del pago: 65 de 87
 *   casan, 0 con varios candidatos, **placebo 0**. Sin la cuenta (cualquier cuenta) el placebo sube a
 *   4–7 % por importes que se repiten (domiciliaciones, traspasos): por eso **sin cuenta no se
 *   valida** — se declara `sin_cuenta`, nunca se casa contra cualquier cuenta.
 * - **Comprobante ↔ movimiento**, por la cuenta de origen que lee el OCR, ±$1, ±5 días: 87 de 90,
 *   **placebo 0**. Así el comprobante se liga al pago A TRAVÉS del movimiento, sin depender del folio
 *   de Kepler (que en el flujo nuevo todavía no existe).
 * - Desfase salida ↔ día programado: 59 el mismo día, 12 a +1, 1 a +2, 2 a −4.
 * - Un pago partido en varias transferencias o varios pagos en una sola NO se distinguen del azar
 *   (7 reales contra 9 del placebo): no se casan solos, quedan para una persona.
 *
 * ⛔ **Uno a uno.** Un movimiento valida UN pago vigente y un comprobante, UN movimiento. Si dos los
 * reclaman, ninguno se valida: `discrepa` (medido: 1 par de pagos vigentes iguales del mismo acreedor).
 * ⛔ Lo que no se puede medir se DECLARA (ADR-056): sin cuenta de origen, efectivo (la ventanilla
 * hoy sólo deja rastro DESPUÉS de Kepler), estado de cuenta que no llega al día, y la CLABE destino
 * (el catálogo de cuentas de proveedor está vacío): nunca «validado» por omisión.
 */
import { TOLERANCIA_IMPORTE, VENTANA_MISMA_CUENTA_DIAS, difDias } from './salida-proveedor.contract';

/** Un pago vigente del Calendario, como lo necesita la validación. */
export interface PagoAValidar {
  id: string;
  /** Día al que está programado (`YYYY-MM-DD`). */
  dia: string;
  /** Lo que sale del banco: `amount_assigned` (el neto, con los descuentos al pagar ya restados). */
  importe: number;
  /** `payment_allocations.bank_account_id`; null = no se preparó la cuenta de origen. */
  cuenta_id: string | null;
  metodo: string | null;
}

/** Una salida del estado de cuenta (`finance.bank_movements`, `amount_out > 0`). */
export interface MovimientoBanco {
  id: string;
  cuenta_id: string;
  fecha: string;
  importe: number;
  /** Fecha imposible (posterior a hoy, o año mal tecleado): no se usa para validar. */
  fecha_invalida?: boolean;
}

/** Un comprobante de pago (PDF/OCR), con su cuenta de origen ya resuelta a `finance.bank_accounts`. */
export interface ComprobanteBanco {
  id: string;
  /** La cuenta propia que el OCR leyó como origen; null = no se pudo resolver. */
  cuenta_id: string | null;
  fecha: string | null;
  importe: number;
}

export type EstadoValidacion =
  | 'validado'
  | 'falta_comprobante'
  | 'sin_movimiento'
  | 'esperando_banco'
  | 'discrepa'
  | 'sin_cuenta'
  | 'efectivo_no_medido';

export interface ValidacionPago {
  estado: EstadoValidacion;
  movimiento_id: string | null;
  comprobante_id: string | null;
  /** Por qué no se validó, en palabras; null si se validó. */
  motivo: string | null;
  /** La CLABE destino no tiene contra qué compararse (catálogo de cuentas de proveedor vacío): se declara. */
  clabe: 'no_medido';
}

export interface EntradaValidacion {
  pagos: readonly PagoAValidar[];
  movimientos: readonly MovimientoBanco[];
  comprobantes: readonly ComprobanteBanco[];
  /** Hasta qué día está cargado el estado de cuenta de cada cuenta (`YYYY-MM-DD`). Sin fila = nada cargado. */
  cargado_hasta: ReadonlyMap<string, string>;
}

const casa = (importeA: number, importeB: number, fechaA: string, fechaB: string): boolean =>
  Math.abs(importeA - importeB) <= TOLERANCIA_IMPORTE && Math.abs(difDias(fechaA, fechaB)) <= VENTANA_MISMA_CUENTA_DIAS;

/** `YYYY-MM-DD` + n días. */
function masDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const resultado = (estado: EstadoValidacion, motivo: string | null, movimiento_id: string | null = null, comprobante_id: string | null = null): ValidacionPago =>
  ({ estado, movimiento_id, comprobante_id, motivo, clabe: 'no_medido' });

/**
 * Valida cada pago contra el estado de cuenta y los comprobantes. Pura: no toca la base.
 * Devuelve un resultado por cada pago de la entrada.
 */
export function validarPagos(e: EntradaValidacion): Map<string, ValidacionPago> {
  const movs = e.movimientos.filter((m) => !m.fecha_invalida && m.importe > 0);
  const out = new Map<string, ValidacionPago>();

  // 1. Candidatos de cada pago (misma cuenta, ±$1, ±5 días) y cuántos pagos reclaman cada movimiento.
  const candidatos = new Map<string, MovimientoBanco[]>();
  const reclamos = new Map<string, number>();
  for (const p of e.pagos) {
    if (p.metodo === 'efectivo' || !p.cuenta_id) continue;
    const c = movs.filter((m) => m.cuenta_id === p.cuenta_id && casa(p.importe, m.importe, p.dia, m.fecha));
    candidatos.set(p.id, c);
    for (const m of c) reclamos.set(m.id, (reclamos.get(m.id) ?? 0) + 1);
  }

  // 2. Cada comprobante, contra los movimientos (cuenta de origen del OCR, ±$1, ±5 días).
  const compPorMov = new Map<string, ComprobanteBanco[]>();
  const movsPorComp = new Map<string, number>();
  for (const c of e.comprobantes) {
    if (!c.cuenta_id || !c.fecha || !(c.importe > 0)) continue;
    for (const m of movs) {
      if (m.cuenta_id !== c.cuenta_id || !casa(c.importe, m.importe, c.fecha, m.fecha)) continue;
      const arr = compPorMov.get(m.id) ?? [];
      arr.push(c);
      compPorMov.set(m.id, arr);
      movsPorComp.set(c.id, (movsPorComp.get(c.id) ?? 0) + 1);
    }
  }

  for (const p of e.pagos) {
    if (p.metodo === 'efectivo') {
      out.set(p.id, resultado('efectivo_no_medido', 'Pago en efectivo: hoy la ventanilla sólo deja rastro después de capturarlo en Kepler. Se valida a mano.'));
      continue;
    }
    if (!p.cuenta_id) {
      out.set(p.id, resultado('sin_cuenta', 'Falta la cuenta de origen: sin ella no se puede buscar el pago en el estado de cuenta.'));
      continue;
    }
    const c = candidatos.get(p.id) ?? [];
    if (!c.length) {
      const hasta = e.cargado_hasta.get(p.cuenta_id) ?? null;
      // Mientras el estado de cuenta no cubra toda la ventana, la ausencia no prueba nada.
      if (!hasta || hasta < masDias(p.dia, VENTANA_MISMA_CUENTA_DIAS)) {
        out.set(p.id, resultado('esperando_banco', hasta
          ? `El estado de cuenta de esa cuenta llega al ${hasta}: todavía no cubre los días en que debió salir.`
          : 'No hay estado de cuenta cargado de esa cuenta.'));
      } else {
        out.set(p.id, resultado('sin_movimiento', 'No hay una salida de esa cuenta por ese importe (±$1) cerca del día del pago (±5 días).'));
      }
      continue;
    }
    if (c.length > 1) {
      out.set(p.id, resultado('discrepa', `Hay ${c.length} salidas posibles por ese importe en esa cuenta: elige cuál es.`));
      continue;
    }
    const m = c[0];
    if ((reclamos.get(m.id) ?? 0) > 1) {
      out.set(p.id, resultado('discrepa', 'La misma salida del banco casa con otro pago del Calendario: decide de cuál es.', m.id));
      continue;
    }
    const comps = (compPorMov.get(m.id) ?? []).filter((x) => (movsPorComp.get(x.id) ?? 0) === 1);
    if (!comps.length) {
      const ambiguos = (compPorMov.get(m.id) ?? []).length > 0;
      out.set(p.id, ambiguos
        ? resultado('discrepa', 'El comprobante casa con más de una salida del banco: decide de cuál es.', m.id)
        : resultado('falta_comprobante', 'La salida está en el banco; falta subir su comprobante.', m.id));
      continue;
    }
    if (comps.length > 1) {
      out.set(p.id, resultado('discrepa', `Hay ${comps.length} comprobantes para la misma salida: deja uno.`, m.id));
      continue;
    }
    out.set(p.id, resultado('validado', null, m.id, comps[0].id));
  }
  return out;
}

const TEXTO: Record<EstadoValidacion, string> = {
  validado: 'Pagado: banco y comprobante',
  falta_comprobante: 'En el banco · falta el comprobante',
  sin_movimiento: 'No aparece en el banco',
  esperando_banco: 'Esperando el estado de cuenta',
  discrepa: 'Revisar: no casa solo',
  sin_cuenta: 'Sin cuenta de origen: no se puede validar',
  efectivo_no_medido: 'Efectivo: se valida a mano',
};
/** La frase corta del renglón; el motivo largo va aparte. */
export function textoValidacion(e: EstadoValidacion): string { return TEXTO[e]; }

/** ¿Este pago ya se puede escribir en Kepler? Sólo lo validado con banco Y comprobante (F2). */
export function validadoParaKepler(v: ValidacionPago | null | undefined): boolean {
  return !!v && v.estado === 'validado';
}
