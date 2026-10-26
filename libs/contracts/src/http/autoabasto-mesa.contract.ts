import {
  ESTADOS_RENGLON,
  yaSeMandoACompras,
  type AutoabastoPedidoLinea,
  type EstadoRenglon,
  type SurteRenglon,
} from './autoabasto-pedido.contract';

/**
 * `[AB.27]` La mesa de Autoabasto sobre la cuenta única del renglón (AB.26).
 *
 * Hasta AB.26 la mesa y «Mi pedido» partían del mismo motor y después cada una seguía su camino:
 * medido el 2026-10-23 (AB.25), de 8,534 renglones de la mesa, 393 ya venían y se volvían a pedir y
 * 3,264 tenían una «Acción» que contradecía a quién se le pide. Desde AB.27 el renglón de la mesa ES
 * el renglón de «Mi pedido» (`AutoabastoPedidoLinea`, armado por `armarRenglon`) más lo que sólo la
 * mesa muestra para explicar la posición (mínimo, reorden, máximo, entrega). Nada se recalcula acá:
 * estas funciones sólo filtran, ordenan y resumen renglones ya armados.
 *
 * Un almacén a la vez (FASE_AB D2: cada sucursal ve sólo su mesa).
 */

/** `[AB.27]` Lo que sólo la mesa muestra, tal como lo devuelve el motor. Cajas, como el resto de la mesa. */
export interface DiagnosticoRenglon {
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  /** OC a proveedor en camino (se muestra, no se resta: política de tránsito `'ignorar'`). */
  oc_en_camino: number;
  /** Venta diaria en cajas. `null` = sin venta medida. */
  venta_diaria: number | null;
  /** Próxima entrega del canal (AAAA-MM-DD). `null` = sin canal con cadencia. */
  next_due_date: string | null;
  lead_time_days: number | null;
  cadence_days: number | null;
  abc_class: string | null;
  /** Veredicto del peldaño cuando el $ viene retenido. `null` = nada impide valuar. */
  rung_veredicto: string | null;
  /**
   * Lugar del producto por venta en $ dentro del almacén (#1 = el que más vende). **`null` = no vendió
   * en el periodo medido.** Es la señal de «sin venta» confiable: la venta diaria llega redondeada en
   * cajas y una venta chica sale 0.00 (medido en Padre Hidalgo, AB.13: 1,440 contra 1,011 reales).
   */
  sales_rank: number | null;
}

export interface AutoabastoMesaRenglon extends AutoabastoPedidoLinea {
  diagnostico: DiagnosticoRenglon;
}

export const ORDENES_MESA = ['lectura', 'falta_neta', 'valor', 'falta', 'sku'] as const;
export type OrdenMesa = typeof ORDENES_MESA[number];

/** `[AB.27]` Filtros de la mesa. Todos opcionales; el almacén lo exige el endpoint, no esto. */
export interface FiltroMesa {
  estado?: EstadoRenglon | null;
  /** La posición contra la política (`agotado`, `bajo_minimo`, …), la misma de «Mi pedido». */
  posicion?: string | null;
  surte?: SurteRenglon['tipo'] | null;
  /** SKU o nombre, sin distinguir mayúsculas ni acentos. */
  search?: string | null;
}

/** Lo que de verdad lleva el renglón: el ajuste guardado si lo hay; si no, lo sugerido. */
export function cantidadEfectiva(l: AutoabastoPedidoLinea): number {
  return l.ajuste ? l.ajuste.cantidad : l.a_pedir.cantidad;
}

const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filtrarRenglones<T extends AutoabastoPedidoLinea>(rs: readonly T[], f: FiltroMesa): T[] {
  const q = f.search ? sinAcentos(f.search.trim()) : '';
  return rs.filter((r) =>
    (!f.estado || r.estado === f.estado)
    && (!f.posicion || r.posicion === f.posicion)
    && (!f.surte || r.surte.tipo === f.surte)
    && (!q || sinAcentos(r.sku).includes(q) || sinAcentos(r.nombre).includes(q)));
}

/**
 * `[AB.27]` El orden de LECTURA (default): primero lo que nadie ha pedido, después lo que Compras
 * planeó, lo que ya viene y lo que está en política (el orden de `ESTADOS_RENGLON`); dentro de cada
 * estado, lo que más vale arriba. Un empate siempre se rompe por SKU: sin eso, la página 2 podría
 * repetir o saltarse renglones entre dos llamadas.
 */
export function ordenarRenglones<T extends AutoabastoPedidoLinea>(rs: readonly T[], orden: OrdenMesa = 'lectura', dir: 'asc' | 'desc' = 'desc'): T[] {
  const s = dir === 'asc' ? 1 : -1;
  const porSku = (a: T, b: T) => a.sku.localeCompare(b.sku);
  const cmp: Record<OrdenMesa, (a: T, b: T) => number> = {
    lectura: (a, b) => ESTADOS_RENGLON.indexOf(a.estado) - ESTADOS_RENGLON.indexOf(b.estado)
      || (b.valor ?? -1) - (a.valor ?? -1) || porSku(a, b),
    falta_neta: (a, b) => s * (a.falta_neta - b.falta_neta) || porSku(a, b),
    falta: (a, b) => s * (a.falta - b.falta) || porSku(a, b),
    // Sin valor (`null`) va siempre al final, en cualquier dirección: no es «el más barato».
    valor: (a, b) => (a.valor == null ? 1 : 0) - (b.valor == null ? 1 : 0) || s * ((a.valor ?? 0) - (b.valor ?? 0)) || porSku(a, b),
    sku: (a, b) => s * porSku(a, b),
  };
  return [...rs].sort(cmp[orden]);
}

export interface ResumenSurte {
  renglones: number;
  /** Renglones que llevan algo (cantidad efectiva > 0). */
  a_pedir: number;
  /** Valor de lo que llevan. `null` = ninguno se pudo valuar (no «$0»). */
  valor: number | null;
  /** Renglones que llevan algo y no se pudieron valuar. */
  sin_valuar: number;
}

export interface ResumenMesa {
  renglones: number;
  por_estado: Record<EstadoRenglon, number>;
  por_surte: Record<SurteRenglon['tipo'], ResumenSurte>;
  /** Valor total a pedir: la misma suma que los grupos de «Mi pedido». `null` = nada valuable. */
  valor_a_pedir: number | null;
  sin_valuar: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[AB.27]` El resumen se suma con la MISMA regla que los grupos de «Mi pedido»: sólo cuenta lo que
 * lleva algo, el valor es la suma de `linea.valor` y lo que no se pudo valuar se cuenta aparte, nunca
 * como $0 (ADR-056). `[AB.29]` Lo que la sucursal ya mandó a Compras se cuenta en su estado, pero no
 * como «a pedir» (`yaSeMandoACompras`).
 */
export function resumirRenglones(rs: readonly AutoabastoPedidoLinea[]): ResumenMesa {
  const vacio = (): ResumenSurte => ({ renglones: 0, a_pedir: 0, valor: null, sin_valuar: 0 });
  const por_estado = Object.fromEntries(ESTADOS_RENGLON.map((e) => [e, 0])) as Record<EstadoRenglon, number>;
  const por_surte: Record<SurteRenglon['tipo'], ResumenSurte> = { matriz: vacio(), proveedor: vacio(), sin_ruta: vacio() };
  let valor: number | null = null;
  let sin_valuar = 0;
  for (const r of rs) {
    por_estado[r.estado]++;
    const g = por_surte[r.surte.tipo];
    g.renglones++;
    if (cantidadEfectiva(r) > 0 && !yaSeMandoACompras(r)) {
      g.a_pedir++;
      if (r.valor != null) {
        g.valor = (g.valor ?? 0) + r.valor;
        valor = (valor ?? 0) + r.valor;
      } else {
        g.sin_valuar++;
        sin_valuar++;
      }
    }
  }
  for (const g of Object.values(por_surte)) if (g.valor != null) g.valor = r2(g.valor);
  return { renglones: rs.length, por_estado, por_surte, valor_a_pedir: valor == null ? null : r2(valor), sin_valuar };
}

/** `[AB.27]` La respuesta de `GET /commercial/autoabasto/renglones`. */
export interface AutoabastoRenglonesResponse {
  almacen: { id: string; code: string; name: string };
  /** Fecha y hora del servidor, en hora de México. */
  fecha_mx: string;
  hora_mx: string;
  cobertura_dias: number;
  /** `false` = la sucursal no tiene cliente de traspaso en Kepler: lo ya pedido NO se midió (≠ «cero»). */
  pedidos_medidos: boolean;
  /** Renglones que pasan el filtro (antes de paginar). */
  total: number;
  page: number;
  pageSize: number;
  /** Del almacén ENTERO, sin filtro: el filtro cambia la lista, no los totales de arriba. */
  resumen: ResumenMesa;
  renglones: AutoabastoMesaRenglon[];
}
