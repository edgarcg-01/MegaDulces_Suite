import type { PresentacionPrecio } from '@megadulces/contracts';
import type { PriceChange } from './etiquetas.service';

/**
 * `[ETQ-CAMBIOS.8]` Qué precio lleva la etiqueta cuando se manda desde «Cambios de precio».
 *
 * Es lo que la persona CONFIRMA antes de imprimir. `todos` imprime el precio grande de siempre
 * más las demás presentaciones debajo; el resto imprime sólo esa presentación.
 */
export type ModoPrecio = 'todos' | 'pieza' | 'paquete' | 'caja';

export const MODOS_PRECIO: { label: string; value: ModoPrecio }[] = [
  { label: 'Todos los precios', value: 'todos' },
  { label: 'Pieza', value: 'pieza' },
  { label: 'Paquete', value: 'paquete' },
  { label: 'Caja', value: 'caja' },
];

export const esModoPrecio = (v: unknown): v is ModoPrecio =>
  v === 'todos' || v === 'pieza' || v === 'paquete' || v === 'caja';

/**
 * El rótulo de la presentación que le toca a un modo, o `null` si el producto no la tiene.
 *
 * ⚠️ «Pieza» es la presentación BASE del ERP, no la que se llame `PZA`: en el 73.5% del catálogo
 * la base es `PAQ` y la etiqueta ya dice «Precio por paquete» para ese precio (ver `defaultHero`
 * en la etiquetera). `null` NO es un error — es un producto sin caja (o sin paquete): quien llama
 * lo declara y deja el precio grande que ya tenía, en vez de imprimir otra cosa en silencio.
 */
export function unidadDeModo(ps: readonly PresentacionPrecio[] | undefined, modo: ModoPrecio): string | null {
  if (modo === 'todos') return null;
  const conPrecio = (ps ?? []).filter((p) => !!p?.unidad && (p.precio_lista ?? 0) > 0);
  const rotulo = (p: PresentacionPrecio): string => String(p.unidad).trim().toUpperCase();
  const hit =
    modo === 'pieza' ? conPrecio.find((p) => p.origen === 'base')
    : modo === 'paquete' ? conPrecio.find((p) => rotulo(p) === 'PAQ')
    : conPrecio.find((p) => rotulo(p) === 'CJA');
  return hit ? String(hit.unidad) : null;
}

/** Un producto de la lista de cambios: UN código, con lo que cambió en cada presentación. */
export interface ProductoCambio {
  sku: string;
  name: string | null;
  /** Un renglón por presentación que cambió (pieza / paquete / caja). */
  filas: PriceChange[];
  /** Alguna presentación quedó SIN precio: el ERP se lo quitó y esa etiqueta saldría en blanco. */
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
function colapsarUnidad(grupo: PriceChange[]): PriceChange[] {
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

const proporcion = (r: PriceChange): number => {
  if (r.delta == null) return 0;
  const antes = r.precio_anterior;
  return antes != null && antes > 0 ? Math.abs(r.delta / antes) : Math.abs(r.delta);
};

/**
 * La bitácora de Kepler escribe UNA fila por presentación: el mismo código llegaba tres veces
 * (pieza, paquete, caja) y la persona creía ver tres productos. La etiqueta es una por PRODUCTO,
 * así que acá se agrupa por código.
 *
 * `direccion` tiene que dar UNA respuesta aunque las presentaciones se muevan en sentidos
 * distintos: manda la que cambió más en proporción. Así los tres totales de la pantalla
 * (suben + bajan + sin precio) siguen sumando el total de productos.
 */
export function agruparPorCodigo(items: readonly PriceChange[]): ProductoCambio[] {
  const porSku = new Map<string, PriceChange[]>();
  for (const r of items) {
    if (!r?.sku) continue;
    const lista = porSku.get(r.sku);
    if (lista) lista.push(r); else porSku.set(r.sku, [r]);
  }
  const out: ProductoCambio[] = [];
  for (const [sku, todas] of porSku) {
    // Una línea por presentación: la cadena de movimientos del día se resume en antes → ahora.
    const porUnidad = new Map<string, PriceChange[]>();
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
      .reduce<PriceChange | null>((a, b) => (a === null || proporcion(b) > proporcion(a) ? b : a), null);
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
