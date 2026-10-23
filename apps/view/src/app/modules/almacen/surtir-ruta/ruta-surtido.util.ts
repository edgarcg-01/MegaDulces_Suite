import type { RouteBatchBag, RouteBatchFinishRequest, RouteBatchProduct, RouteBatchRow } from '@megadulces/contracts';

/**
 * `[MCP.3.6]` Lo que no depende de la pantalla del surtido de una ruta: agrupar por marca, el
 * rango del contador «Hay menos», el cuerpo de «Ya junté todo» y lo que se guarda en el celular.
 * Funciones puras para poder probarlas sin montar nada.
 */

/** Lo recolectado de una ruta (product_id → cantidad en la `unit` del producto). */
export const PREF_RUTA_RECOLECTA = 'gp.surtir.ruta.v1.';
/** Las bolsas de una ruta ya recolectada y cuáles están listas (sobrevive a una recarga). */
export const PREF_RUTA_BOLSAS = 'gp.surtir.ruta.bolsas.v1.';

/** Unidades que se cuentan por peso o volumen: son las únicas que admiten decimales. */
const UNIDADES_CON_DECIMALES = new Set(['KG', 'GR', 'G', 'LT', 'L', 'ML']);

export function admiteDecimales(unit: string | null | undefined): boolean {
  return UNIDADES_CON_DECIMALES.has(String(unit ?? '').trim().toUpperCase());
}

/**
 * Lo que se tecleó o se sumó con −/+, dentro de [0, qty]. Sin decimales salvo peso/volumen
 * (milésimas). Lo que no es número cae en 0: nunca se manda un `NaN` al servidor.
 */
export function acotarCantidad(v: unknown, qty: number, unit: string | null | undefined): number {
  const n = Number(v);
  const max = Math.max(0, Number(qty) || 0);
  if (!Number.isFinite(n)) return 0;
  const r = admiteDecimales(unit) ? Math.round(n * 1000) / 1000 : Math.floor(n);
  return Math.min(max, Math.max(0, r));
}

export interface GrupoMarca {
  marca: string;
  productos: RouteBatchProduct[];
}

/** Agrupa por marca respetando el orden en que llegan (el servidor ya ordena la vuelta). */
export function agruparPorMarca(productos: readonly RouteBatchProduct[]): GrupoMarca[] {
  const grupos: GrupoMarca[] = [];
  const porMarca = new Map<string, GrupoMarca>();
  for (const p of productos) {
    const marca = (p.brand ?? '').trim() || 'Sin marca';
    let g = porMarca.get(marca);
    if (!g) {
      g = { marca, productos: [] };
      porMarca.set(marca, g);
      grupos.push(g);
    }
    g.productos.push(p);
  }
  return grupos;
}

/** Un producto una sola vez, aunque el detalle lo trajera repetido. */
export function productosUnicos(productos: readonly RouteBatchProduct[]): RouteBatchProduct[] {
  const vistos = new Set<string>();
  return productos.filter((p) => (vistos.has(p.product_id) ? false : (vistos.add(p.product_id), true)));
}

/** El cuerpo de «Ya junté todo»: cada producto del pedido global UNA vez, con lo encontrado. */
export function cuerpoTerminar(
  productos: readonly RouteBatchProduct[],
  recolectado: Readonly<Record<string, number>>,
): RouteBatchFinishRequest {
  return {
    products: productosUnicos(productos).map((p) => ({
      product_id: p.product_id,
      picked: acotarCantidad(recolectado[p.product_id] ?? 0, p.qty, p.unit),
    })),
  };
}

/** `3` / `2.5`: sin ceros de relleno. */
export function fmtCantidad(n: number): string {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toLocaleString('es-MX', { maximumFractionDigits: 3 });
}

/** `14:05` en hora de México (el servidor manda ISO en UTC). */
export function horaMx(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });
}

/** «Ruta de Paulina»; sin nombre no se inventa uno. */
export function nombreRuta(r: Pick<RouteBatchRow, 'seller_name'> & Partial<Pick<RouteBatchRow, 'kind'>>): string {
  // [MCP.3.6] Lo levantado después de cerrar la ruta también es un pedido global, con su propio nombre.
  if (r.kind === 'fuera_de_ruta') return r.seller_name ? `Fuera de la ruta · ${r.seller_name}` : 'Fuera de la ruta';
  return r.seller_name ? `Ruta de ${r.seller_name}` : 'Ruta sin vendedor';
}

/**
 * `[MCP.3.13]` Rótulo de un pedido agrupado: «Parte de P-10482 · también surte PH». El principal del
 * grupo dice «Pedido agrupado · …». Suelto → `null` (no se pinta nada).
 */
export function textoParte(p: {
  code: string;
  group_code?: string | null;
  group_other_warehouses?: readonly string[] | null;
}): string | null {
  if (!p.group_code) return null;
  const base = p.group_code === p.code ? 'Pedido agrupado' : `Parte de ${p.group_code}`;
  const otras = (p.group_other_warehouses ?? []).filter((s) => !!s && !!s.trim());
  return otras.length ? `${base} · también surte ${otras.join(', ')}` : base;
}

/** `[MCP.3.13]` Para la ruta: qué otras sucursales surten partes de sus pedidos; `null` si ninguna. */
export function textoOtrasSucursales(r: { group_other_warehouses?: readonly string[] | null }): string | null {
  const otras = (r.group_other_warehouses ?? []).filter((s) => !!s && !!s.trim());
  return otras.length ? `Pedidos agrupados · también surte ${otras.join(', ')}: aquí va sólo lo de tu sucursal` : null;
}

/** Lo que quedó guardado en el celular de una ruta ya recolectada. */
export interface BolsasGuardadas {
  route: RouteBatchRow;
  bags: RouteBatchBag[];
  listas: string[];
}

export function leerLocal(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

export function guardarLocal(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* sin almacenamiento local: se pierde el avance al recargar, no el trabajo del servidor */
  }
}

export function leerJson<T>(k: string): T | null {
  try {
    const v = JSON.parse(leerLocal(k) || 'null');
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}
