/**
 * `[MCP.10]` Reglas puras de la revisión en caja de un pedido de preventa surtido. Sin base ni HTTP:
 * se prueban solas (presale-review.engine.spec.ts).
 *
 * De dónde sale cada número:
 *  · `ordered` (lo que pidió el vendedor) = el reporte del surtido, que se congeló al cerrar. Un
 *    renglón que NO está en el reporte se surtió completo: lo pedido es lo que hoy dice el pedido.
 *    ⛔ No se usa `requested_quantity` para inventar faltantes: otros caminos (mínimo de compra, la
 *    vendedora editando) también lo separan de `quantity`, y eso no es algo que faltó al surtir.
 *  · `picked` (lo que dejó el surtidor) = lo que hoy dice el pedido (el surtido ya lo recortó).
 *  · Un renglón BORRADO al surtir ya no está en `order_lines`: vive sólo en `report.removed`.
 */
import type {
  PresalePickReport,
  PresalePickReportLine,
  PresalePickRestore,
  PresaleReviewLine,
  PresaleReviewResolution,
  PresaleReviewResultLine,
} from '@megadulces/contracts';
import { cantidadMostrada } from './presale-picking.engine';

const EPS = 1e-9;
const PESABLE = /^(KG|GR|LT|LTS|L|ML)$/i;

/** Un renglón vivo del pedido, como sale de `commercial.order_lines`. Cantidad en unidad BASE. */
export interface RenglonVivo {
  line_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
}

/** Un renglón de la revisión, más lo que el servidor necesita y no viaja a la pantalla. */
export interface RenglonRevision extends Omit<PresaleReviewLine, 'stock'> {
  /** El renglón vivo; `null` = lo borró el surtido. */
  line_id: string | null;
  /** Copia para reponerlo (sólo borrados con copia). */
  restore: PresalePickRestore | null;
}

export class RevisionInvalida extends Error {}

/** ¿Este renglón del reporte es el de este `line_id`? Con `line_id` exacto; sin él (reportes viejos), por nombre y unidad únicos. */
function delReporte(linea: RenglonVivo, unidad: string, reportadas: PresalePickReportLine[]): PresalePickReportLine | null {
  const exacta = reportadas.find((r) => r.line_id === linea.line_id);
  if (exacta) return exacta;
  const candidatas = reportadas.filter((r) => !r.line_id && r.product_name === linea.product_name && r.unit === unidad);
  return candidatas.length === 1 ? candidatas[0] : null;
}

/** Los renglones que la caja revisa: los vivos del pedido y, al final, los que el surtido borró. */
export function armarRenglonesRevision(vivos: RenglonVivo[], reporte: PresalePickReport | null): RenglonRevision[] {
  const ajustados = reporte?.adjusted ?? [];
  const out: RenglonRevision[] = vivos.map((l) => {
    const m = cantidadMostrada({ quantity: l.quantity, qty_unit: l.qty_unit, qty_factor: l.qty_factor });
    const rep = delReporte(l, m.unit, ajustados);
    return {
      key: l.line_id,
      line_id: l.line_id,
      product_id: l.product_id,
      product_name: l.product_name,
      unit: m.unit,
      factor: m.factor,
      ordered: rep && rep.ordered > m.qty ? rep.ordered : m.qty,
      picked: m.qty,
      // El renglón existe: se puede subir hasta lo pedido repreciándolo.
      restorable: true,
      restore: null,
    };
  });
  (reporte?.removed ?? []).forEach((r, i) => {
    const restore = r.restore ?? null;
    const factor = restore && r.ordered > 0 ? restore.quantity / r.ordered : 1;
    out.push({
      key: `borrado:${i}`,
      line_id: null,
      product_id: restore?.product_id ?? null,
      product_name: r.product_name,
      unit: r.unit,
      factor: Number.isFinite(factor) && factor > 0 ? factor : 1,
      ordered: r.ordered,
      picked: 0,
      restorable: !!restore,
      restore,
    });
  });
  return out;
}

/** Lo que hay que hacerle al pedido para que quede como lo dejó la caja. Cantidades en unidad BASE. */
export interface PlanRevision {
  /** Renglones vivos con cantidad nueva (subir o bajar). */
  poner: Array<{ line_id: string; quantity: number }>;
  /** Renglones vivos que se quitan (la caja confirmó que no hubo nada). */
  quitar: string[];
  /** Renglones borrados que vuelven al pedido. */
  reponer: Array<{ restore: PresalePickRestore; quantity: number }>;
  lines: PresaleReviewResultLine[];
  /** ¿Cambia algo del pedido? Si no, no se toca (ni se recalcula el total). */
  cambia: boolean;
}

/** Cómo se resolvió un renglón, para el registro y para la vendedora. */
export function resolucion(ordered: number, picked: number, final: number, returned: number): PresaleReviewResolution {
  if (final < ordered - EPS) return 'no_hubo';
  if (picked < ordered - EPS) return 'completo';
  return returned > EPS ? 'devuelto' : 'bien';
}

/**
 * Valida lo que marcó la caja y arma el plan. Reglas:
 *  · tiene que venir CADA renglón de la revisión, una sola vez, y ninguno ajeno;
 *  · `final` va de 0 a lo pedido, entero si la unidad no es de peso — no se cobra más de lo pedido;
 *  · un renglón borrado sin copia no se puede reponer (sólo «No hay»);
 *  · el pedido no puede quedar vacío: eso se cancela, no se cobra.
 */
export function planearRevision(
  renglones: RenglonRevision[],
  marcados: Array<{ key: string; final: number; returned?: number }>,
): PlanRevision {
  const porKey = new Map<string, { final: number; returned: number }>();
  for (const m of marcados ?? []) {
    if (!m || typeof m.key !== 'string') throw new RevisionInvalida('Renglón sin identificador.');
    if (porKey.has(m.key)) throw new RevisionInvalida('Un renglón viene repetido.');
    porKey.set(m.key, { final: Number(m.final), returned: m.returned == null ? 0 : Number(m.returned) });
  }
  const keys = new Set(renglones.map((r) => r.key));
  for (const k of porKey.keys()) {
    if (!keys.has(k)) throw new RevisionInvalida('Llegó un renglón que no es de este pedido.');
  }
  const plan: PlanRevision = { poner: [], quitar: [], reponer: [], lines: [], cambia: false };
  let queda = 0;
  for (const r of renglones) {
    const m = porKey.get(r.key);
    if (!m) throw new RevisionInvalida(`Falta revisar «${r.product_name}».`);
    const { final, returned } = m;
    if (!Number.isFinite(final) || final < 0) throw new RevisionInvalida(`Cantidad inválida en «${r.product_name}».`);
    if (!Number.isFinite(returned) || returned < 0) throw new RevisionInvalida(`Lo devuelto en «${r.product_name}» no es válido.`);
    if (final > r.ordered + EPS) {
      throw new RevisionInvalida(`«${r.product_name}»: no se cobra más de lo pedido (${r.ordered} ${r.unit}). Lo que sobra se devuelve.`);
    }
    if (!PESABLE.test(r.unit) && (Math.abs(final - Math.round(final)) > EPS || Math.abs(returned - Math.round(returned)) > EPS)) {
      throw new RevisionInvalida(`«${r.product_name}»: la cantidad en ${r.unit} va entera.`);
    }
    if (final > r.picked + EPS && !r.restorable) {
      throw new RevisionInvalida(`«${r.product_name}» se quitó del pedido antes de que la caja pudiera reponerlo: avísale a la vendedora.`);
    }
    if (final > EPS) queda++;
    plan.lines.push({
      key: r.key, product_name: r.product_name, unit: r.unit,
      ordered: r.ordered, picked: r.picked, final, returned, resolution: resolucion(r.ordered, r.picked, final, returned),
    });
    if (Math.abs(final - r.picked) <= EPS) continue;
    plan.cambia = true;
    const base = +(final * r.factor).toFixed(4);
    if (r.line_id) {
      if (final <= EPS) plan.quitar.push(r.line_id);
      else plan.poner.push({ line_id: r.line_id, quantity: base });
    } else if (r.restore) {
      plan.reponer.push({ restore: r.restore, quantity: base });
    }
  }
  if (!queda) throw new RevisionInvalida('El pedido quedaría vacío. Avísale a la vendedora para cancelarlo en lugar de cobrarlo.');
  return plan;
}
