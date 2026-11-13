/**
 * `[PGP.121]` **El banco dispara el pago.** Edgar, 2026-11-13: «hay que encenderla» — y, al preguntarle qué la
 * dispara, eligió el banco: la Suite marca pagado (y, con el interruptor encendido, escribe el `X-D-26` en Kepler)
 * cuando el estado de cuenta muestra la salida por ese importe. **Sin autorizar ni marcar pagado a mano, y sin
 * capturar la cuenta de origen**: la cuenta sale del propio movimiento del banco.
 *
 * ── Por qué se puede (medido en prod, sólo lectura, 2026-11-13) ─────────────────────────────────────
 * - Contra lo que Tesorería capturó en Kepler (459 pagos a proveedores de compra de agosto a noviembre, sucursal
 *   00): buscando la salida por importe (±$1) y fecha (±1 día) en TODAS las cuentas, **442 caen en una sola
 *   cuenta y 439 son la cuenta que Tesorería capturó** (99.3 %, el 97.7 % del dinero). Placebo (las mismas fechas
 *   +40 días): 1 de 459.
 * - Sobre los pagos DEL CALENDARIO (183 de días pasados), con la fecha planeada: 86 caen en una sola cuenta; los 60
 *   que tienen captura de Tesorería como testigo, **60 de 60 en la cuenta correcta**. Placebo: 0 de 183.
 *   Tesorería captura el mismo día que el plan (p50 0 días, p90 1, máximo 3): por eso la ventana es de 3 días.
 *
 * ── Lo que NO se decide aquí, y se dice ──────────────────────────────────────────────────────────────
 * - **`varias_cuentas`**: el mismo importe salió de dos cuentas en la ventana. No se adivina.
 * - **`disputada`**: la salida casa con más de un pago pendiente, o el pago con más de una salida. Uno a uno, o nada.
 * - **`excluido`**: cheque (Kepler lo registra distinto) y efectivo (no pasa por el banco).
 * - **`sin_salida`**: el banco no la tiene todavía (se carga por lotes, unas tres veces por semana) o no se pagó.
 *
 * Función pura: recibe los pagos pendientes, las salidas del banco y las que ya están ligadas a otro pago.
 */

/** Días alrededor del día planeado en que se busca la salida (medido: Tesorería paga el día, a lo más 3 después). */
export const VENTANA_BANCO_DIAS = 3;
/** Pesos de tolerancia entre el importe del pago y la salida (redondeos del banco). */
export const TOLERANCIA_BANCO = 1;

export interface PagoPendiente {
  id: string;
  /** Día planeado del pago (`YYYY-MM-DD`). */
  dia: string;
  importe: number;
  /** `payment_allocations.payment_method`; null = nadie lo preparó (casi todos hoy). */
  metodo: string | null;
}

export interface SalidaBanco {
  id: string;
  cuenta_id: string;
  fecha: string;
  importe: number;
}

export type DecisionBanco =
  | { estado: 'probado'; movimiento_id: string; cuenta_id: string; fecha: string; importe: number }
  | { estado: 'sin_salida' | 'varias_cuentas' | 'disputada' | 'excluido'; motivo: string };

/** Quién firma en la bitácora y en `updated_by` lo que hizo el banco. */
export const AUTOR_PAGO_POR_EL_BANCO = 'sistema:banco';
/** El evento de `finance.payment_allocation_history` (el catálogo crece sin migración). */
export const EVENTO_PAGADO_POR_EL_BANCO = 'pagado_por_el_banco';

export interface ResultadoPagoPorElBanco {
  hoy: string;
  /** Pagos pendientes de días que ya llegaron. */
  revisados: number;
  pagados: number;
  monto: number;
  ids_pagados: string[];
  /** Los que el banco no decide, por motivo: se dicen, no se callan. */
  sin_decidir: Record<'sin_salida' | 'varias_cuentas' | 'disputada' | 'excluido', number>;
}

/** Métodos que no salen como transferencia del estado de cuenta. */
const NO_TRANSFERENCIA = new Set(['cheque', 'efectivo']);

const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function casaConElPago(p: PagoPendiente, s: SalidaBanco): boolean {
  return Math.abs(s.importe - p.importe) <= TOLERANCIA_BANCO && Math.abs(dias(p.dia, s.fecha)) <= VENTANA_BANCO_DIAS;
}

/**
 * Decide, pago por pago, si el banco prueba que salió y de qué cuenta. Sólo los pagos de días que ya llegaron
 * (`dia <= hoy`); los demás no aparecen en el resultado. `ligadas`: salidas que ya son la prueba de otro pago.
 */
export function decidirPagosPorElBanco(
  pagos: readonly PagoPendiente[], salidas: readonly SalidaBanco[], hoy: string, ligadas: ReadonlySet<string> = new Set(),
): Map<string, DecisionBanco> {
  const out = new Map<string, DecisionBanco>();
  const libres = salidas.filter((s) => !ligadas.has(s.id) && s.importe > 0);
  const vigentes = pagos.filter((p) => p.dia <= hoy);
  const candidatas = new Map<string, SalidaBanco[]>();
  for (const p of vigentes) {
    if (p.metodo && NO_TRANSFERENCIA.has(p.metodo)) continue;
    candidatas.set(p.id, libres.filter((s) => casaConElPago(p, s)));
  }
  // Cuántos pagos reclaman cada salida: el uno a uno se mide con TODOS los pendientes, no sólo con el de al lado.
  const reclamos = new Map<string, number>();
  for (const c of candidatas.values()) for (const s of c) reclamos.set(s.id, (reclamos.get(s.id) ?? 0) + 1);

  for (const p of vigentes) {
    if (p.metodo && NO_TRANSFERENCIA.has(p.metodo)) {
      out.set(p.id, { estado: 'excluido', motivo: p.metodo === 'cheque'
        ? 'Pago con cheque: Kepler lo registra distinto, sigue a mano'
        : 'Pago en efectivo: no pasa por el banco' });
      continue;
    }
    const c = candidatas.get(p.id) ?? [];
    if (!c.length) {
      out.set(p.id, { estado: 'sin_salida', motivo: `El banco no tiene una salida de $${p.importe.toFixed(2)} (±$${TOLERANCIA_BANCO}) entre ${VENTANA_BANCO_DIAS} días antes y después del ${p.dia}` });
      continue;
    }
    const cuentas = new Set(c.map((s) => s.cuenta_id));
    if (cuentas.size > 1) {
      out.set(p.id, { estado: 'varias_cuentas', motivo: `El mismo importe salió de ${cuentas.size} cuentas en esos días: no se adivina de cuál fue` });
      continue;
    }
    if (c.length > 1 || (reclamos.get(c[0].id) ?? 0) > 1) {
      out.set(p.id, { estado: 'disputada', motivo: c.length > 1
        ? `Hay ${c.length} salidas de ese importe en esa cuenta: no se sabe cuál es la de este pago`
        : 'La misma salida del banco casa con otro pago pendiente: no se sabe de cuál es' });
      continue;
    }
    out.set(p.id, { estado: 'probado', movimiento_id: c[0].id, cuenta_id: c[0].cuenta_id, fecha: c[0].fecha, importe: c[0].importe });
  }
  return out;
}
