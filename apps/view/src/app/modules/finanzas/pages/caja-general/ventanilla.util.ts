import type { VeredictoDePago } from '@megadulces/contracts';
import type { MovimientoPendiente } from '../../cash-ledger.service';

/**
 * `[LE.2.13]` La cola «Por pagar hoy» de la Ventanilla, armada con la cola de Kepler
 * (`movimientos-pendientes`) y el veredicto del servidor (`pagos/veredictos`). Función pura: la
 * pantalla sólo la pinta.
 *
 *  · `pagable`  → se paga ya: la compra o el gasto aprobado por una persona ya fue la autorización.
 *  · `firma`    → Kepler no dice qué paga: sale con la firma de Tesorería.
 *  · `detenido` → no sale (ni con firma); la fila dice por qué y, si aplica, dónde se arregla.
 *
 * El orden es el de la tarea: primero lo que se puede pagar, después lo que pide firma, al final lo
 * detenido; dentro de cada grupo, el orden de la cola.
 */
export type EstadoFila = 'pagable' | 'firma' | 'detenido';

export interface FilaVentanilla {
  doc: MovimientoPendiente;
  veredicto: VeredictoDePago | null;
  estado: EstadoFila;
  /** Lo que dice la pastilla, corto. */
  etiqueta: string;
  /** Por qué no sale, o por qué firma Tesorería; `null` si sale sin más. */
  motivo: string | null;
  arreglo: 'aprobacion_gastos' | null;
}

const ETIQUETA_DETENIDO: Readonly<Record<string, string>> = {
  gasto_sin_aprobar: 'gasto sin aprobar',
  gasto_sin_expediente: 'gasto sin expediente',
  vale_rechazado: 'gasto rechazado',
  compra_pagada_de_mas: 'compra pagada de más',
  respaldo_no_cuadra: 'no cuadra con Kepler',
  ya_ordenado: 'ya tiene su orden',
  ya_pagado: 'ya está en el libro',
  documento_inexistente: 'no está en Kepler',
  documento_ambiguo: 'documento repetido en Kepler',
  documento_invalido: 'no es un pago de caja',
};

function etiquetaQueSale(v: VeredictoDePago): string {
  const n = v.detalle.length;
  if (v.respaldo === 'compra') return n === 1 ? 'compra · 1 entrada' : `compra · ${n} entradas`;
  if (v.respaldo === 'gasto') return n === 1 ? `gasto aprobado · vale ${v.detalle[0].vale_folio ?? '—'}` : `${n} gastos aprobados`;
  return 'sin respaldo';
}

export function filaDe(doc: MovimientoPendiente, v: VeredictoDePago | null): FilaVentanilla {
  // Sin veredicto no se afirma nada: no se sabe qué paga, así que no sale.
  if (!v) return { doc, veredicto: null, estado: 'detenido', etiqueta: 'sin medir', motivo: 'No se pudo leer qué paga este documento.', arreglo: null };
  if (!doc.kepler_cuenta) {
    return { doc, veredicto: v, estado: 'detenido', etiqueta: 'sin cuenta de Kepler', motivo: doc.motivo_texto ?? 'Falta su cuenta de Kepler.', arreglo: null };
  }
  if (!v.puede) return { doc, veredicto: v, estado: 'detenido', etiqueta: ETIQUETA_DETENIDO[v.bloqueo ?? ''] ?? 'detenido', motivo: v.motivo, arreglo: v.arreglo };
  if (v.requiere_firma) {
    return { doc, veredicto: v, estado: 'firma', etiqueta: v.respaldo === 'no_medido' ? 'sin medir qué paga · firma Tesorería' : 'firma Tesorería',
      motivo: v.motivo, arreglo: null };
  }
  return { doc, veredicto: v, estado: 'pagable', etiqueta: etiquetaQueSale(v), motivo: null, arreglo: null };
}

const ORDEN: Readonly<Record<EstadoFila, number>> = { pagable: 0, firma: 1, detenido: 2 };

export function armarCola(docs: readonly MovimientoPendiente[], veredictos: readonly VeredictoDePago[]): FilaVentanilla[] {
  const porRef = new Map(veredictos.map((v) => [v.origen_ref, v]));
  return docs.map((d, i) => ({ f: filaDe(d, porRef.get(d.origen_ref) ?? null), i }))
    .sort((a, b) => ORDEN[a.f.estado] - ORDEN[b.f.estado] || a.i - b.i)
    .map((x) => x.f);
}

export interface ResumenCola { n: number; monto: number }

/** Cuántos y cuánto en cada estado: los tres suman la cola entera (nada se esconde). */
export function resumenCola(filas: readonly FilaVentanilla[]): Record<EstadoFila, ResumenCola> {
  const r: Record<EstadoFila, ResumenCola> = { pagable: { n: 0, monto: 0 }, firma: { n: 0, monto: 0 }, detenido: { n: 0, monto: 0 } };
  for (const f of filas) {
    r[f.estado].n += 1;
    r[f.estado].monto = Math.round((r[f.estado].monto + Number(f.doc.monto || 0)) * 100) / 100;
  }
  return r;
}
