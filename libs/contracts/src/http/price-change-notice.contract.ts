/**
 * `[ETQ-AVISOS.1]` Cambios de precio: la lista por producto y los avisos que salen de ella.
 *
 * ── Por qué vive en `libs/contracts` ─────────────────────────────────────────────────────────
 * La pantalla «Cambios de precio» y el generador de avisos tienen que contar LO MISMO. Si el
 * aviso dice «47 productos» y la pantalla muestra 52, nadie vuelve a creerle a ninguno de los
 * dos — y eso pasa solo si la regla vive duplicada en el frontend y en el worker. Una función,
 * dos consumidores (ADR-056: un primitivo no se copia).
 *
 * Es lógica PURA: sin I/O, sin fechas del sistema, sin framework.
 */

/** Un renglón de la bitácora de Kepler, tal como lo entrega `GET /store/labels/price-changes`. */
export interface PriceChangeRow {
  sku: string;
  name: string | null;
  unidad: string | null;
  precio_anterior: number | null;
  precio_nuevo: number | null;
  delta: number | null;
  /** El precio nuevo es cero: no es una rebaja, el ERP le quitó el precio. */
  es_baja: boolean;
  /** Hora del día del movimiento. Sólo sirve para ORDENAR dentro de un mismo día. */
  hora: string | null;
}

/** Un producto de la lista: UN código, con lo que cambió en cada presentación. */
export interface ProductoCambio {
  sku: string;
  name: string | null;
  /** Un renglón por presentación que cambió (pieza / paquete / caja). Vacío = terminó donde empezó. */
  filas: PriceChangeRow[];
  /** Alguna presentación quedó SIN precio. */
  es_baja: boolean;
  /** Hacia dónde se movió el producto, por la presentación que MÁS cambió en proporción. */
  direccion: 'sube' | 'baja' | 'sin_precio' | 'sin_cambio';
}

const redondea = (n: number): number => Math.round(n * 100) / 100;

/**
 * Una presentación puede moverse VARIAS veces el mismo día: el 91059 pasó de $5,602.87 a $6,523.34
 * y después a $203.85 en la misma unidad (`500`), y la pantalla lo mostraba como dos renglones de
 * la misma unidad encadenados. A quien reimprime no le sirve la cadena: le sirve lo que está hoy
 * en el anaquel (el primer «antes» del día) contra lo que dice Kepler ahora (el último «ahora»).
 *
 * ⚠️ Se colapsa SÓLO si se puede ordenar con certeza: la consulta ordena por tamaño del cambio, no
 * por hora, así que sin horas distintas y completas no hay cadena que reconstruir y las filas se
 * dejan tal cual (mejor repetir una unidad que inventar cuál fue primero).
 */
function colapsarUnidad(grupo: PriceChangeRow[]): PriceChangeRow[] {
  if (grupo.length === 1) return grupo;
  const horas = grupo.map((r) => r.hora);
  // Sin orden cierto no hay cadena que reconstruir: se devuelven TODAS tal como llegaron.
  if (horas.some((h) => !h) || new Set(horas).size !== grupo.length) return grupo;
  const ord = [...grupo].sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
  const primera = ord[0];
  const ultima = ord[ord.length - 1];
  const antes = primera.precio_anterior;
  const ahora = ultima.precio_nuevo;
  return [{
    ...ultima,
    precio_anterior: antes,
    precio_nuevo: ahora,
    delta: antes != null && ahora != null ? redondea(ahora - antes) : null,
    es_baja: ultima.es_baja,
  }];
}

const proporcion = (r: PriceChangeRow): number => {
  if (r.delta == null) return 0;
  const antes = r.precio_anterior;
  return antes != null && antes > 0 ? Math.abs(r.delta / antes) : Math.abs(r.delta);
};

/**
 * La bitácora de Kepler escribe UNA fila por presentación y una por cada vez que se movió el
 * precio: el mismo código llegaba tres veces y la persona creía ver tres productos. La etiqueta es
 * una por PRODUCTO, así que acá se agrupa por código.
 *
 * `direccion` tiene que dar UNA respuesta aunque las presentaciones se muevan en sentidos
 * distintos: manda la que cambió más en proporción. Así suben + bajan + sin precio suman el total
 * de productos.
 */
export function agruparPorCodigo(items: readonly PriceChangeRow[]): ProductoCambio[] {
  const porSku = new Map<string, PriceChangeRow[]>();
  for (const r of items) {
    if (!r?.sku) continue;
    const lista = porSku.get(r.sku);
    if (lista) lista.push(r); else porSku.set(r.sku, [r]);
  }
  const out: ProductoCambio[] = [];
  for (const [sku, todas] of porSku) {
    // Una línea por presentación: la cadena de movimientos del día se resume en antes → ahora.
    const porUnidad = new Map<string, PriceChangeRow[]>();
    for (const r of todas) {
      const k = r.unidad ?? '';
      const g = porUnidad.get(k);
      if (g) g.push(r); else porUnidad.set(k, [r]);
    }
    // Lo que terminó en el mismo precio con el que empezó el día no necesita etiqueta nueva.
    const filas = Array.from(porUnidad.values()).flatMap(colapsarUnidad).filter((r) => r.delta == null || r.delta !== 0);
    const es_baja = filas.some((r) => r.es_baja);
    const mayor = filas
      .filter((r) => !r.es_baja)
      .reduce<PriceChangeRow | null>((a, b) => (a === null || proporcion(b) > proporcion(a) ? b : a), null);
    const delta = mayor?.delta ?? 0;
    out.push({
      sku,
      name: todas.find((r) => r.name)?.name ?? null,
      filas,
      es_baja,
      direccion: es_baja ? 'sin_precio' : delta > 0 ? 'sube' : delta < 0 ? 'baja' : 'sin_cambio',
    });
  }
  return out;
}

/** Los cuatro números del aviso (y de la franja de la pantalla). `productos` = suben + bajan + sin_precio. */
export interface PriceChangeSummary {
  productos: number;
  suben: number;
  bajan: number;
  sin_precio: number;
  /** Productos que se movieron y terminaron el día en su mismo precio: no se listan ni se avisan. */
  volvieron: number;
}

export function resumirCambios(items: readonly PriceChangeRow[]): PriceChangeSummary {
  const todos = agruparPorCodigo(items);
  const cuenta = (d: ProductoCambio['direccion']): number => todos.filter((p) => p.direccion === d).length;
  const suben = cuenta('sube');
  const bajan = cuenta('baja');
  const sin_precio = cuenta('sin_precio');
  return { productos: suben + bajan + sin_precio, suben, bajan, sin_precio, volvieron: cuenta('sin_cambio') };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Avisos
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cuándo salió el aviso. `manana` (07:30) resume el día de AYER; `tarde` (14:00) resume lo que va
 * de HOY; `compras` es el que manda una persona de Compras a mano.
 */
export type PriceNoticeCut = 'manana' | 'tarde' | 'compras';

export interface PriceChangeNoticeDto {
  id: string;
  /** Plaza de dos dígitos (`01`). */
  plaza: string;
  /** Nombre de la tienda («Padre Hidalgo»). `null` si el catálogo no la conoce: la campana cae al código. */
  plaza_nombre: string | null;
  /** Día de la bitácora que resume (`YYYY-MM-DD`). */
  fecha: string;
  corte: PriceNoticeCut;
  origen: 'auto' | 'compras';
  productos: number;
  suben: number;
  bajan: number;
  sin_precio: number;
  /** Nota que escribió Compras. `null` en los automáticos. */
  nota: string | null;
  /** Quién lo mandó. Sólo viene en los de Compras. */
  enviado_por: string | null;
  created_at: string;
}

/** Cómo terminó el envío a UNA plaza. El motivo viaja: un «no se envió» sin razón no se puede corregir. */
export type PriceNoticeShareStatus =
  | 'enviado'
  /** Esa plaza no tuvo cambios ese día: no se manda un aviso vacío. */
  | 'sin_cambios'
  /** La bitácora de esa plaza todavía no llega a ese día: «no sé» no es «no hubo». */
  | 'sin_dato'
  /** La misma persona ya mandó esa plaza y día hace poco. */
  | 'repetido'
  | 'plaza_invalida';

export interface PriceNoticeShareResultDto {
  plaza: string;
  estado: PriceNoticeShareStatus;
  productos: number;
  /** Cuántas personas con tienda asignada ven este aviso. 0 = sólo lo verá quien tenga alcance total. */
  destinatarios: number;
  id: string | null;
}

export interface PriceNoticeShareRequestDto {
  plazas: string[];
  /** `YYYY-MM-DD`. Si falta, ayer en hora de México. */
  fecha?: string;
  nota?: string;
}

export interface PriceNoticeRecipientsDto {
  plaza: string;
  nombre: string | null;
  destinatarios: number;
  /** Último día con bitácora para esa plaza. */
  ultimo_dia: string | null;
}
