import type { FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

/**
 * `[AX.22]` — Las reglas que revisan un pedido / embarque / factura de Telemarketing. **Funciones
 * puras**: el servicio (`tlmk-revision.service.ts`) lee de Kepler y las llama; aquí no hay base.
 *
 * Caso que las abrió (Canindo, 2026-11-10): el pedido se capturó como 10 CJA × 40 = 400 PAQ, la
 * ficha de la 06 cambió a CJA = 25 el 29-oct, el embarque copió los 400 PAQ y la factura los
 * presentó con la ficha de hoy: 400 ÷ 25 = **16 cajas**. Salieron 10.
 *
 * Dos preguntas distintas, dos reglas:
 *  1. **¿Se capturó con una caja que ya cambió?** (`factor_cambio` de la vista
 *     `analytics.v_erp_order_line_box_factor`). En el embarque: hay que confirmar en bodega qué
 *     salió antes de facturar. En el pedido todavía sin embarcar: se puede corregir antes de surtir.
 *  2. **¿La factura dice lo mismo que el embarque?** Por producto, en UNIDAD BASE (`c9` en los dos
 *     lados), contra la SUMA de todas las facturas vivas del embarque — por factura, la segunda de un
 *     embarque partido saldría «de menos», que es falso (`[AX.17]`).
 *
 * ⚠️ La regla 2 NO ve el caso de Canindo (400 = 400): el desfase de ese caso está en el factor, no
 *    en la cantidad. Por eso existen las dos.
 */

export const REGLA_FACTOR_EMBARQUE = 'tlmk_embarque_caja_cambio';
export const REGLA_FACTOR_PEDIDO = 'tlmk_pedido_caja_cambio';
export const REGLA_FACTURA_EMBARQUE = 'tlmk_factura_distinta_embarque';

export const REGLAS_TLMK: FinanceRuleInput[] = [
  {
    rule_key: REGLA_FACTOR_EMBARQUE,
    nombre: 'Embarque TM capturado con una caja que ya cambió',
    descripcion: 'Un renglón del embarque (U-D-41) se capturó con un factor de caja que la ficha de Kepler de su sucursal ya no tiene. La factura presentará otra cantidad de cajas; hay que confirmar en bodega qué salió antes de facturar.',
    clase: 'error_captura',
  },
  {
    rule_key: REGLA_FACTOR_PEDIDO,
    nombre: 'Pedido TM capturado con una caja que ya cambió',
    descripcion: 'Un renglón de un pedido (U-D-40) todavía sin embarcar se capturó con un factor de caja que la ficha ya no tiene. Se puede corregir antes de surtir.',
    clase: 'error_captura',
  },
  {
    rule_key: REGLA_FACTURA_EMBARQUE,
    nombre: 'Factura TM distinta de su embarque',
    descripcion: 'La suma de las facturas vivas de un embarque no trae, por producto y en unidad base, la misma cantidad que el embarque.',
    clase: 'riesgo',
  },
];

/** Un renglón de `analytics.v_erp_order_line_box_factor` (lo que el servicio lee). */
export interface RenglonCaja {
  sku: string;
  captured_unit: string | null;
  captured_qty: number | null;
  captured_factor: number | null;
  base_qty: number;
  base_unit: string | null;
  base_unit_price: number | null;
  current_factor: number | null;
  status: string;
  qty_in_current_unit: number | null;
  base_qty_at_current_factor: number | null;
}

/** Lo que el servicio sabe del documento (cabecera de Kepler). */
export interface DocumentoTlmk {
  sucursal: string;
  doc_type: 40 | 41;
  serie: number;
  folio: string;
  folio_digital: string;
  /** `YYYY-MM-DD` del documento (`kdm1.c9`). */
  fecha: string;
  cliente: string | null;
  /** La cotización de la Suite que originó el pedido (`COT-…`), si nació aquí. */
  cotizacion: string | null;
}

/** Un renglón de una factura viva del embarque (`analytics.erp_sales_invoice_lines`). */
export interface RenglonFactura {
  factura: string;
  sku: string;
  cantidad: number;
}

const EPS = 1e-6;
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));
const pesos = (v: number): string => '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nombreDoc = (d: DocumentoTlmk): string => (d.doc_type === 41 ? 'Embarque' : 'Pedido');

/**
 * Regla 1. Un hallazgo por documento con TODOS sus renglones de caja cambiada (o ninguno).
 * El importe es lo que está en juego **si** salieron cajas de la medida nueva:
 * |base capturada − mismas cajas a la caja de hoy| × precio base. Si un renglón no trae precio, el
 * importe no se inventa: va en 0 y la evidencia dice `importe_medido: false`.
 */
export function hallazgoCajaCambiada(doc: DocumentoTlmk, renglones: RenglonCaja[]): FinanceFindingInput | null {
  const malos = renglones.filter((r) => r.status === 'factor_cambio');
  if (!malos.length) return null;

  let importe = 0;
  let medido = true;
  const detalle = malos.map((r) => {
    const base = n(r.base_qty);
    const nueva = r.base_qty_at_current_factor === null ? null : n(r.base_qty_at_current_factor);
    const precio = r.base_unit_price === null ? null : n(r.base_unit_price);
    if (nueva === null || precio === null) medido = false;
    else importe += Math.abs(base - nueva) * precio;
    return {
      sku: r.sku,
      capturado: `${fmt(n(r.captured_qty))} ${r.captured_unit} de ${fmt(n(r.captured_factor))}`,
      base: `${fmt(base)} ${r.base_unit ?? ''}`.trim(),
      caja_hoy: r.current_factor === null ? null : n(r.current_factor),
      factura_dira: r.qty_in_current_unit === null ? null : `${fmt(n(r.qty_in_current_unit))} ${r.captured_unit}`,
      si_cajas_nuevas: nueva === null ? null : `${fmt(nueva)} ${r.base_unit ?? ''}`.trim(),
    };
  });
  importe = Math.round(importe * 100) / 100;

  const primero = detalle[0];
  const queHacer = doc.doc_type === 41
    ? 'Confirmar en bodega qué medida de caja salió y, si fue la nueva, corregir el embarque en Kepler antes de facturar.'
    : 'Corregir el pedido en Kepler con la caja de hoy antes de surtir.';
  return {
    rule_key: doc.doc_type === 41 ? REGLA_FACTOR_EMBARQUE : REGLA_FACTOR_PEDIDO,
    clase: 'error_captura',
    severity: 'warn',
    score: Math.min(100, 50 + Math.round(importe / 200)),
    titulo: `${nombreDoc(doc)} ${doc.folio_digital}: ${malos.length} producto(s) capturado(s) con una caja que ya cambió`,
    resumen:
      `${primero.sku}: ${primero.capturado} = ${primero.base}; hoy la caja es de ${fmt(n(primero.caja_hoy))}` +
      (doc.doc_type === 41 ? `, la factura dirá ${primero.factura_dira}` : '') +
      (primero.si_cajas_nuevas ? `. Con cajas nuevas serían ${primero.si_cajas_nuevas}` : '') +
      (malos.length > 1 ? ` (+${malos.length - 1} producto(s) más)` : '') +
      `. ${queHacer}` +
      (medido ? ` En juego: ${pesos(importe)}.` : ' Importe no medido: falta precio en algún renglón.'),
    entity: { sucursal: doc.sucursal, doc_type: doc.doc_type, serie: doc.serie, folio: doc.folio, folio_digital: doc.folio_digital, cliente: doc.cliente },
    periodo: doc.fecha.slice(0, 7),
    importe,
    evidencia: { renglones: detalle, importe_medido: medido, cotizacion: doc.cotizacion, fuente: 'analytics.v_erp_order_line_box_factor' },
    dedup_key: `tlmk_caja|${doc.sucursal}|${doc.doc_type}|${doc.serie}|${doc.folio}`,
  };
}

/**
 * Regla 2. Embarque contra la suma de sus facturas vivas, por producto y en unidad base.
 * Sin facturas vivas no hay nada que comparar (eso es «embarque sin factura», `[AX.18]`).
 */
export function hallazgoFacturaDistinta(
  doc: DocumentoTlmk,
  renglones: RenglonCaja[],
  facturas: RenglonFactura[],
): FinanceFindingInput | null {
  if (doc.doc_type !== 41 || !facturas.length) return null;

  const emb = new Map<string, { q: number; precio: number | null; unidad: string | null }>();
  for (const r of renglones) {
    const x = emb.get(r.sku) ?? { q: 0, precio: null, unidad: r.base_unit };
    x.q += n(r.base_qty);
    if (x.precio === null && r.base_unit_price !== null) x.precio = n(r.base_unit_price);
    emb.set(r.sku, x);
  }
  const fac = new Map<string, number>();
  for (const f of facturas) fac.set(f.sku, (fac.get(f.sku) ?? 0) + n(f.cantidad));

  const difs: { sku: string; embarcado: number; facturado: number; diferencia: number; unidad: string | null }[] = [];
  let importe = 0;
  let medido = true;
  for (const sku of new Set([...emb.keys(), ...fac.keys()])) {
    const e = emb.get(sku);
    const q = e?.q ?? 0;
    const f = fac.get(sku) ?? 0;
    if (Math.abs(f - q) <= EPS) continue;
    difs.push({ sku, embarcado: q, facturado: f, diferencia: f - q, unidad: e?.unidad ?? null });
    if (e?.precio === null || e?.precio === undefined) medido = false;
    else importe += Math.abs(f - q) * e.precio;
  }
  if (!difs.length) return null;
  importe = Math.round(importe * 100) / 100;

  const folios = [...new Set(facturas.map((f) => f.factura))].sort();
  const d = difs[0];
  return {
    rule_key: REGLA_FACTURA_EMBARQUE,
    clase: 'riesgo',
    severity: importe >= 5000 ? 'critical' : 'warn',
    score: Math.min(100, 60 + Math.round(importe / 200)),
    titulo: `Embarque ${doc.folio_digital}: la factura no dice lo mismo que lo embarcado (${difs.length} producto(s))`,
    resumen:
      `${d.sku}: embarcado ${fmt(d.embarcado)}, facturado ${fmt(d.facturado)} ${d.unidad ?? ''}`.trimEnd() +
      (difs.length > 1 ? ` (+${difs.length - 1} producto(s) más)` : '') +
      `. Facturas: ${folios.join(', ')}.` +
      (medido ? ` Diferencia: ${pesos(importe)}.` : ' Importe no medido: un producto facturado no está en el embarque.'),
    entity: { sucursal: doc.sucursal, doc_type: 41, serie: doc.serie, folio: doc.folio, folio_digital: doc.folio_digital, cliente: doc.cliente },
    periodo: doc.fecha.slice(0, 7),
    importe,
    evidencia: { diferencias: difs, facturas: folios, importe_medido: medido, cotizacion: doc.cotizacion },
    dedup_key: `tlmk_fac_emb|${doc.sucursal}|${doc.serie}|${doc.folio}`,
  };
}

/** La cotización de la Suite dentro del comentario del pedido (`kdm1.c24`), si la hay. */
export function cotizacionDe(comentario: string | null | undefined): string | null {
  const m = /COT-\d{4}-\d+/.exec(String(comentario ?? ''));
  return m ? m[0] : null;
}
