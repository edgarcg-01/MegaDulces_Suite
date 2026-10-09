import type {
  AndenLineaOffline,
  AndenLlegada,
  AndenLlegadaEstado,
  AndenLlegadaLote,
  AndenLlegadaRenglon,
  AndenLlegadaRenglonEstado,
  AndenLlegadaResumen,
} from '@megadulces/contracts';

/**
 * `[WMS-REC.22]` **Llegadas al andén**, la parte pura.
 *
 * Con los renglones y los lotes ya leídos de la base, decide el estado de cada renglón y del
 * camión, y cuenta. No toca la base: el servicio lee, esto decide, y así se prueba aislado.
 *
 * Las dos ausencias que importan se distinguen en vez de juntarse en un "no hay fecha":
 *  - **`sin_caducidad`**: alguien declaró que el producto no tiene caducidad (el lote va sin
 *    fecha, lote `NA`). Es un hecho capturado y se audita.
 *  - **`sin_vale`**: nadie abrió el vale. Kepler ya le dio entrada y no hay nada capturado.
 */

/** Un lote tal como sale de `commercial.receiving_lot_captures`. */
export interface LoteCrudo {
  quantity: unknown;
  confirmed_lot: string | null;
  confirmed_expiry: string | null;
  verdict: string;
  status: string;
}

/** Un renglón de un vale tal como sale de `commercial.receiving_lines`. */
export interface RenglonValeCrudo {
  id: string;
  sku: string | null;
  nombre: string | null;
  expected_qty: unknown;
  /** El vale todavía lo espera: `pending` y con cantidad esperada (la misma regla del menú). */
  pendiente: boolean;
}

const SEMAFOROS = new Set(['green', 'yellow', 'red']);
const ESTATUS = new Set(['accepted', 'pending_authorization', 'authorized', 'rejected']);

export function aLote(c: LoteCrudo): AndenLlegadaLote {
  return {
    lote: String(c.confirmed_lot || 'NA'),
    caducidad: c.confirmed_expiry ? String(c.confirmed_expiry).slice(0, 10) : null,
    cantidad: Number(c.quantity) || 0,
    semaforo: (SEMAFOROS.has(c.verdict) ? c.verdict : 'green') as AndenLlegadaLote['semaforo'],
    estatus: (ESTATUS.has(c.status) ? c.status : 'accepted') as AndenLlegadaLote['estatus'],
  };
}

/**
 * Estado de un renglón de vale. Un renglón que el vale todavía espera es `falta` aunque ya tenga
 * algún lote: lo que importa es si se terminó. Lo rechazado no cuenta como recibido.
 */
export function estadoRenglon(pendiente: boolean, lotes: AndenLlegadaLote[]): AndenLlegadaRenglonEstado {
  if (pendiente) return 'falta';
  const vivos = lotes.filter((l) => l.estatus !== 'rejected');
  if (!vivos.length) return 'no_llego';
  return vivos.some((l) => l.caducidad) ? 'fechado' : 'sin_caducidad';
}

/**
 * Estado del camión. Con vale manda el vale; sin vale, un traspaso que Kepler todavía no recibe
 * va en camino y todo lo demás ya entró sin que nadie lo fechara.
 *
 * Un vale sin renglones (uno manual recién abierto) está a medias hasta que se cierra.
 */
export function estadoLlegada(t: {
  tipo: AndenLlegada['tipo'];
  vale: { status: string } | null;
  recibidoKepler: string | null;
  renglones: Array<Pick<AndenLlegadaRenglon, 'estado'>>;
}): AndenLlegadaEstado {
  if (t.vale) {
    if (!t.renglones.length) return t.vale.status === 'closed' ? 'completa' : 'a_medias';
    return t.renglones.some((r) => r.estado === 'falta') ? 'a_medias' : 'completa';
  }
  if (t.tipo === 'traspaso' && !t.recibidoKepler) return 'en_camino';
  return 'sin_abrir';
}

/**
 * Los renglones de un vale, con sus lotes. La cantidad es la que manda Kepler; en un renglón que
 * no venía en el documento (cantidad esperada 0), la que se declaró. La unidad sale del documento
 * de Kepler por SKU, como en el detalle del vale.
 *
 * Lo que falta va primero: es lo que hay que mirar.
 */
export function renglonesDeVale(
  filas: RenglonValeCrudo[],
  lotesPorRenglon: Map<string, AndenLlegadaLote[]>,
  unidadPorSku: Map<string, string | null>,
): AndenLlegadaRenglon[] {
  const out = filas.map((f) => {
    const lotes = lotesPorRenglon.get(f.id) ?? [];
    const esperada = Number(f.expected_qty) || 0;
    const declarada = lotes.filter((l) => l.estatus !== 'rejected').reduce((a, l) => a + l.cantidad, 0);
    return {
      sku: f.sku,
      nombre: f.nombre,
      cantidad: esperada > 0 ? esperada : declarada,
      unidad: f.sku ? unidadPorSku.get(f.sku) ?? null : null,
      estado: estadoRenglon(f.pendiente, lotes),
      lotes,
    };
  });
  return [...out.filter((r) => r.estado === 'falta'), ...out.filter((r) => r.estado !== 'falta')];
}

/** Lo que manda Kepler para un documento sin vale: ningún renglón tiene nada capturado. */
export function renglonesDeKepler(esperadas: AndenLineaOffline[]): AndenLlegadaRenglon[] {
  return esperadas.map((e) => ({
    sku: e.sku ?? e.expected_sku,
    nombre: e.product_name ?? e.expected_name,
    cantidad: e.expected_qty,
    unidad: e.expected_unit,
    estado: 'sin_vale' as const,
    lotes: [],
  }));
}

/** La unidad de cada SKU dentro de un documento: la que ya resolvió `lineasEsperadas`. */
export function unidadesPorSku(esperadas: AndenLineaOffline[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const e of esperadas) {
    for (const s of [e.sku, e.expected_sku]) if (s && !m.has(s)) m.set(s, e.expected_unit);
  }
  return m;
}

export function resumir(renglones: AndenLlegadaRenglon[]): AndenLlegadaResumen {
  const r: AndenLlegadaResumen = {
    renglones: renglones.length, listos: 0, faltan: 0, sin_caducidad: 0,
    verdes: 0, amarillos: 0, rojos: 0, por_autorizar: 0,
  };
  for (const x of renglones) {
    if (x.estado === 'falta' || x.estado === 'sin_vale') r.faltan++;
    else r.listos++;
    if (x.estado === 'sin_caducidad') r.sin_caducidad++;
    for (const l of x.lotes) {
      if (l.estatus === 'rejected') continue;
      if (l.estatus === 'pending_authorization') r.por_autorizar++;
      if (!l.caducidad) continue;
      if (l.semaforo === 'green') r.verdes++;
      else if (l.semaforo === 'yellow') r.amarillos++;
      else r.rojos++;
    }
  }
  return r;
}

/** Arma la llegada: le pone el estado y el resumen a lo que el servicio ya juntó. */
export function armarLlegada(
  x: Omit<AndenLlegada, 'estado' | 'resumen'>,
): AndenLlegada {
  return {
    ...x,
    estado: estadoLlegada({ tipo: x.tipo, vale: x.vale, recibidoKepler: x.recibido_kepler, renglones: x.renglones }),
    resumen: resumir(x.renglones),
  };
}
