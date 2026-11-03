import { redondear2, totalesCotizacion } from '@megadulces/contracts';

/**
 * `[COT.7.1]` — **La cotización, en las columnas del «Pedido Telemarketing» de Kepler.**
 *
 * Plan: [`FASE_COT7_PEDIDO_TLMK_A_KEPLER.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_COT7_PEDIDO_TLMK_A_KEPLER.md) §7b.
 * Pura a propósito: el adapter la llama con la ficha que leyó del servidor destino, y la prueba la
 * llama con un pedido real (`kepler-pedido-tlmk.spec.ts`). Cada regla viene medida sobre
 * pedidos `U-D-40` TELEMARK de 01/06/08 (2026-11-03):
 *
 *   renglón  `c9 = c51 × c58` · `c12 = round(c57 / c58, 2)` · `c13 = c12 × c9` (406/406)
 *            `c17 = kdii.c18` y `c18 = kdii.c19`, ya negativos = impuesto incluido (5,010/5,010)
 *            `c11 = kdii.c11` (5,009/5,010) · `c63` = costo estándar `kdii.c77`, `c62` el de la presentación
 *            `c66` = lista de la presentación ÷ `c58`, sin redondear (el precio original)
 *   cabecera `c16`/`c14`/`c15` = `totalesCotizacion` (la misma cuenta que la cotización y el
 *            replay: 79/79) · `c13` = descuento SIN impuestos (168/168) · `c19` = % del cliente
 *
 * ⚠️ `c57` se escribe como la cotización lo cobra (base redondeada × factor), no como Kepler lo
 * captura (base sin redondear × factor): difieren en centavos (718.40 contra 718.36), **el importe
 * no** (`c13 = c12 × c9` en los dos), y las dos invariantes de Kepler se cumplen por construcción.
 *
 * ⛔ Falla cerrada: un solo renglón que no se puede escribir como Kepler lo escribiría rechaza el
 * pedido entero, con el SKU y el porqué. Escribir parcial deja un pedido incompleto que parece completo.
 */

/** Un renglón de la cotización tal como lo guardó el motor (`commercial.quote_lines`). */
export interface RenglonCotizacion {
  sku: string;
  /** `quantity`: en la presentación cotizada. */
  cantidad: number;
  /** `qty_unit`: el rótulo de la presentación. null = la unidad base. */
  presentacion: string | null;
  /** `qty_factor`: unidades base por presentación. null = la base (factor 1). */
  factor: number | null;
  /** `unit_price`: precio de la presentación (base a centavos × factor). */
  precio: number;
  /** `list_price`: lista de la presentación, antes de volumen y promociones. */
  lista: number | null;
  /** `line_total`: importe del renglón. */
  importe: number;
}

/** La ficha del producto en el servidor DESTINO (`md.kdii`), ya interpretada por el adapter. */
export interface FichaTlmk {
  nombre: string;
  /** `c11`. */
  unidad_base: string;
  /** `c18`, IVA como lo guarda Kepler (negativo = incluido: -16, 0). */
  iva: number;
  /** `c19`, IEPS (-8, 0). */
  ieps: number;
  /** `c77`, costo estándar por unidad base. */
  costo_base: number;
  /** Unidades base de la presentación cotizada según la ficha (`factorPresentacionFicha`). null = no la declara. */
  factor_presentacion: number | null;
}

export interface RenglonPedidoKepler {
  sku: string;
  nombre: string;
  /** `c9` cantidad en unidad base · `c11` unidad base · `c12` precio por unidad base · `c13` importe. */
  c9: number;
  c11: string;
  c12: number;
  c13: number;
  /** `c51` (= `c56`) cantidad en la presentación `c55` · `c58` factor · `c57` (= `c65`) precio de la presentación. */
  c51: number;
  c55: string;
  c57: number;
  c58: number;
  /** `c62` costo de la presentación · `c63` costo por unidad base · `c66` precio original por unidad base. */
  c62: number;
  c63: number;
  c66: number;
  /** `c17` IVA · `c18` IEPS, negativos (incluidos). */
  c17: number;
  c18: number;
}

export interface CabeceraPedidoKepler {
  /** `c19` % del cliente (0 si no hay). */
  c19: number;
  /** `c13` descuento sin impuestos · `c14` IVA · `c15` IEPS · `c16` total (= `c42`, por facturar). */
  c13: number;
  c14: number;
  c15: number;
  c16: number;
}

export type PedidoArmado =
  | { ok: true; renglones: RenglonPedidoKepler[]; cabecera: CabeceraPedidoKepler }
  | { ok: false; motivos: string[] };

const norm = (v: string | null | undefined): string => String(v ?? '').trim().toUpperCase();

export function armarPedidoTlmk(
  renglones: RenglonCotizacion[],
  fichas: ReadonlyMap<string, FichaTlmk>,
  pctCliente: number | null,
): PedidoArmado {
  const motivos: string[] = [];
  if (!renglones.length) return { ok: false, motivos: ['La cotización no tiene renglones con precio'] };
  const out: RenglonPedidoKepler[] = [];

  for (const r of renglones) {
    const f = fichas.get(r.sku);
    if (!f) { motivos.push(`${r.sku}: Kepler no tiene la ficha del producto en esta sucursal`); continue; }
    const pres = norm(r.presentacion) || norm(f.unidad_base);
    const factor = r.factor && r.factor > 0 ? r.factor : 1;
    // ⛔ El error de 50× de KR.6: si la Suite y la ficha no dicen lo mismo de la presentación, la
    // cantidad en unidad base saldría otra, con el pedido viéndose perfecto en pantalla.
    if (f.factor_presentacion === null) {
      motivos.push(`${r.sku}: la ficha de Kepler no declara la presentación ${pres}`); continue;
    }
    if (Math.abs(f.factor_presentacion - factor) > 0.001) {
      motivos.push(`${r.sku}: la presentación ${pres} trae ${factor} en la cotización y ${f.factor_presentacion} en la ficha de Kepler`); continue;
    }
    if (!(r.cantidad > 0) || !(r.precio > 0)) { motivos.push(`${r.sku}: sin cantidad o sin precio`); continue; }
    const c9 = Number((r.cantidad * factor).toPrecision(12));
    const c12 = redondear2(r.precio / factor);
    const c13 = redondear2(c12 * c9);
    // El importe que se escribe tiene que ser el que el cliente aceptó, al centavo.
    if (Math.abs(c13 - r.importe) > 0.005) {
      motivos.push(`${r.sku}: el importe no cuadra (Kepler daría ${c13.toFixed(2)}, la cotización dice ${r.importe.toFixed(2)})`); continue;
    }
    out.push({
      sku: r.sku, nombre: f.nombre,
      c9, c11: norm(f.unidad_base), c12, c13,
      c51: r.cantidad, c55: pres, c57: redondear2(r.precio), c58: factor,
      c62: redondear2(f.costo_base * factor), c63: f.costo_base,
      c66: (r.lista && r.lista > 0 ? r.lista : r.precio) / factor,
      c17: f.iva, c18: f.ieps,
    });
  }
  if (motivos.length) return { ok: false, motivos };

  const p = pctCliente !== null && Number.isFinite(pctCliente) && pctCliente > 0 ? pctCliente : 0;
  const t = totalesCotizacion(
    out.map((l) => l.c13),
    p || null,
    out.map((l) => ({ iva: Math.abs(l.c17) / 100, ieps: Math.abs(l.c18) / 100 })),
  );
  // `c13` de Kepler: el descuento SOBRE LA BASE SIN IMPUESTOS (168/168). Los impuestos de
  // `totalesCotizacion` ya traen el % aplicado; antes del descuento eran ÷ (1 − %).
  const impuestosBrutos = p ? (t.iva + t.ieps) / (1 - p / 100) : t.iva + t.ieps;
  const c13 = p ? redondear2((t.importe - impuestosBrutos) * p / 100) : 0;
  return { ok: true, renglones: out, cabecera: { c19: p, c13, c14: t.iva, c15: t.ieps, c16: t.total } };
}
