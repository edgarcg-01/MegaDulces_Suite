/**
 * `[RD.103.2]` — **Qué escalón le toca a una ruta y si el chofer pasa el piso.** Lógica pura:
 * sin base, para que la regla se pruebe contra el libro sin levantar nada.
 *
 * Dos formas de escalonar, las dos ya en uso en la empresa:
 *  · Ruta Directa: por VENTA en pesos (`gate_field = 'venta'`), el primer escalón en $189,999.99.
 *  · Vecinal: por MARKUP (`gate_field = 'markup'`, subtotal ÷ costo − 1, en %), y el chofer cobra
 *    sólo si la venta del periodo pasa de `piso_chofer_venta` (libro: $129,999.99). El supervisor
 *    no tiene piso: en el libro cobra aunque el chofer quede en «NO APLICA».
 */

export type GateField = 'venta' | 'subtotal' | 'markup';

export interface ReglaEscala {
  gate_field: GateField | string;
  base_field: 'venta' | 'subtotal' | string;
  /** NULL = sin piso. El chofer cobra si la venta es MAYOR que esto (el libro usa `>`). */
  piso_chofer_venta?: number | string | null;
}

export interface Escalon { min_amount: string | number; max_amount: string | number | null; pct: string | number }

export type DecisionEscalon =
  | { paga: false; motivo: 'sin_costo' | 'bajo_umbral' }
  | { paga: true; pct: number; base: number; escalon: Escalon; chofer_bajo_piso: boolean };

/** min inclusivo, max exclusivo, `max IS NULL` = sin techo (FASE_RD §4.6). */
export function elegirEscalon<T extends Escalon>(tiers: T[], valor: number): T | null {
  for (const t of tiers) {
    const min = Number(t.min_amount);
    const max = t.max_amount === null ? Infinity : Number(t.max_amount);
    if (valor >= min && valor < max) return t;
  }
  return null;
}

export function decidirEscalon(
  regla: ReglaEscala,
  tiers: Escalon[],
  v: { venta: number; subtotal: number },
  markupPct: number | null,
): DecisionEscalon {
  let valor: number;
  if (regla.gate_field === 'markup') {
    // Sin costo no hay markup: se DECLARA, no se cae al primer escalón (ADR-056).
    if (markupPct === null || !Number.isFinite(markupPct)) return { paga: false, motivo: 'sin_costo' };
    valor = markupPct;
  } else {
    valor = regla.gate_field === 'subtotal' ? v.subtotal : v.venta;
  }
  const escalon = elegirEscalon(tiers, valor);
  if (!escalon) return { paga: false, motivo: 'bajo_umbral' };
  const piso = regla.piso_chofer_venta === null || regla.piso_chofer_venta === undefined
    ? null : Number(regla.piso_chofer_venta);
  return {
    paga: true,
    pct: Number(escalon.pct),
    base: regla.base_field === 'subtotal' ? v.subtotal : v.venta,
    escalon,
    chofer_bajo_piso: piso !== null && !(v.venta > piso),
  };
}
