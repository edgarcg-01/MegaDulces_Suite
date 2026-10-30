/**
 * `[MCP.3]` + `[MCP.8]` Reglas puras del surtido de preventa por pedido. Sin base ni HTTP: así se
 * prueban solas (presale-picking.engine.spec.ts).
 */
import type {
  PresaleCandidate,
  PresalePickBucket,
  PresalePickReport,
  PresalePickReportLine,
  PresalePickRestore,
} from '@megadulces/contracts';

/** `YYYY-MM-DD` + n días, sin pasar por la zona horaria del servidor. */
export function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Días entre dos fechas `YYYY-MM-DD` (b − a). */
export function diasEntre(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/**
 * La pestaña de la bandeja. Lo vencido cae en `hoy`: un pedido atrasado se surte hoy, no
 * desaparece de la vista del surtidor.
 */
export function pestanaDe(fechaEntrega: string, hoy: string): { bucket: PresalePickBucket; days_late: number } {
  const dif = diasEntre(hoy, fechaEntrega);
  if (dif <= 0) return { bucket: 'hoy', days_late: dif === 0 ? 0 : -dif };
  if (dif === 1) return { bucket: 'manana', days_late: 0 };
  return { bucket: 'proximos', days_late: 0 };
}

/** Cantidad del renglón en la unidad en que se capturó. Sin sello (o sello que no divide exacto), en base. */
export function cantidadMostrada(l: { quantity: number; qty_unit: string | null; qty_factor: number | null }): {
  qty: number; unit: string; factor: number;
} {
  const base = Number(l.quantity);
  const f = Number(l.qty_factor);
  const u = String(l.qty_unit ?? '').trim();
  if (u && f > 0) {
    const q = base / f;
    if (Math.abs(q - Math.round(q)) < 1e-6) return { qty: Math.round(q), unit: u, factor: f };
  }
  return { qty: base, unit: u && !(f > 0) ? u : 'PZA', factor: 1 };
}

export interface RenglonParaCerrar {
  line_id: string;
  product_name: string;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
  line_total: number;
  /**
   * `[MCP.10]` Lo que hace falta para reponer el renglón si se borra y la caja lo completa. Sin
   * esto el reporte se arma igual que antes (sin `restore`).
   */
  restore?: PresalePickRestore;
}

export interface PlanCierre {
  outcome: 'completo' | 'con_faltantes';
  /** Renglones a borrar (no hubo nada). */
  quitar: string[];
  /** Renglones a recortar: nueva cantidad en unidad BASE. */
  recortar: Array<{ line_id: string; quantity: number }>;
  removed: PresalePickReportLine[];
  adjusted: PresalePickReportLine[];
}

export class CierreInvalido extends Error {}

/**
 * Valida lo que marcó el surtidor y arma el plan. Reglas:
 *  · tiene que venir CADA renglón del pedido, una sola vez, y ninguno ajeno;
 *  · lo surtido va de 0 a lo pedido, en la unidad mostrada, y entero si la unidad no es de peso;
 *  · si no hubo NADA de ningún renglón no se cierra aquí: un pedido vacío se cancela, no se surte.
 */
export function planearCierre(
  renglones: RenglonParaCerrar[],
  marcados: Array<{ line_id: string; picked: number }>,
): PlanCierre {
  const porId = new Map<string, number>();
  for (const m of marcados ?? []) {
    if (!m || typeof m.line_id !== 'string') throw new CierreInvalido('Renglón sin identificador.');
    if (porId.has(m.line_id)) throw new CierreInvalido('Un renglón viene repetido.');
    porId.set(m.line_id, Number(m.picked));
  }
  const ids = new Set(renglones.map((r) => r.line_id));
  for (const id of porId.keys()) {
    if (!ids.has(id)) throw new CierreInvalido('Llegó un renglón que no es de este pedido.');
  }
  const plan: PlanCierre = { outcome: 'completo', quitar: [], recortar: [], removed: [], adjusted: [] };
  let algoHubo = false;
  for (const r of renglones) {
    if (!porId.has(r.line_id)) throw new CierreInvalido(`Falta marcar «${r.product_name}».`);
    const m = cantidadMostrada(r);
    const picked = porId.get(r.line_id) as number;
    if (!Number.isFinite(picked) || picked < 0) throw new CierreInvalido(`Cantidad inválida en «${r.product_name}».`);
    if (picked > m.qty + 1e-9) throw new CierreInvalido(`«${r.product_name}»: no se puede surtir más de lo pedido (${m.qty} ${m.unit}).`);
    const pesable = /^(KG|GR|LT|LTS|L|ML)$/i.test(m.unit);
    if (!pesable && Math.abs(picked - Math.round(picked)) > 1e-9) {
      throw new CierreInvalido(`«${r.product_name}»: la cantidad en ${m.unit} va entera.`);
    }
    if (picked > 0) algoHubo = true;
    if (picked >= m.qty - 1e-9) continue;
    plan.outcome = 'con_faltantes';
    // [MCP.10] El renglón va en el reporte: la revisión en caja lo encuentra sin adivinar por nombre.
    const linea: PresalePickReportLine = { product_name: r.product_name, unit: m.unit, ordered: m.qty, picked, line_id: r.line_id };
    if (picked <= 0) {
      plan.quitar.push(r.line_id);
      plan.removed.push(r.restore ? { ...linea, restore: r.restore } : linea);
    } else {
      plan.recortar.push({ line_id: r.line_id, quantity: +(picked * m.factor).toFixed(4) });
      plan.adjusted.push(linea);
    }
  }
  if (!algoHubo) {
    throw new CierreInvalido('No hubo nada de este pedido. Avísale a la vendedora para cancelarlo en lugar de surtirlo vacío.');
  }
  return plan;
}

export function armarReporte(plan: PlanCierre, totalAntes: number, totalDespues: number): PresalePickReport | null {
  if (plan.outcome === 'completo') return null;
  return { removed: plan.removed, adjusted: plan.adjusted, total_before: totalAntes, total_after: totalDespues };
}

/**
 * ¿Cuál ticket de Kepler cobró el pedido? Sólo se DETECTA (no se liga: la liga la confirma una
 * persona, D2/D6). Se acepta un candidato sólo si es el ÚNICO que:
 *  · no está ligado a otro pedido;
 *  · es del día en que se terminó de surtir o posterior;
 *  · trae todos los productos que quedaron en el pedido.
 * Si dos tickets cumplen (el cliente compró dos veces), no se adivina: `null`.
 */
export function detectarCobro(candidatos: PresaleCandidate[], productosPedido: number, surtidoEl: string): PresaleCandidate | null {
  if (!(productosPedido > 0)) return null;
  const buenos = (candidatos ?? []).filter(
    (c) => !c.linked_to_order_code && !!c.fecha && c.fecha >= surtidoEl && c.shared_products >= productosPedido,
  );
  return buenos.length === 1 ? buenos[0] : null;
}
