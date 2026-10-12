import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { FilaProveedor, FlujoResumen, VeredictoCompra } from './productos-flujo.service';

/**
 * `[PF.9]` Lo que la pantalla de Compras › Catálogo hace con los datos, sin Angular: nombres legibles,
 * filtros por situación de compra, orden y la barra de cobertura. Se prueba en `catalogo-proveedor.spec.ts`.
 */

const MINUSCULAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'con', 'sin', 'en', 'para', 'por', 'a', 'al', 'x']);

/**
 * "PALETA DE DULCE LA ROSA 40G C/50" → "Paleta de Dulce la Rosa 40G C/50". Kepler guarda todo en mayúsculas,
 * que en una lista larga cansa. Lo que trae números (gramaje, piezas) se queda como viene.
 */
export function nombrePropio(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().replace(/\s+/g, ' ').split(' ').map((w, i) => {
    if (/\d/.test(w)) return w.toUpperCase();
    const l = w.toLocaleLowerCase('es-MX');
    if (i > 0 && MINUSCULAS.has(l)) return l;
    return l.charAt(0).toLocaleUpperCase('es-MX') + l.slice(1);
  }).join(' ');
}

/** Sufijos de razón social que no ayudan a reconocer al proveedor en una lista. */
const RAZON_SOCIAL = /[\s,]+(S\.?\s?A\.?\s?P\.?\s?I\.?|S\.?\s?A\.?|S\.?\s?DE\s?R\.?\s?L\.?|S\.?\s?C\.?|S\.?\s?P\.?\s?R\.?)(\s+DE\s+C\.?\s?V\.?)?\.?\s*$/i;

/** "DULCES LA ROSA, S.A. DE C.V." → "Dulces la Rosa". */
export function nombreProveedor(s: string | null | undefined): string {
  let t = (s ?? '').trim();
  for (let i = 0; i < 2 && RAZON_SOCIAL.test(t); i++) t = t.replace(RAZON_SOCIAL, '').trim();
  return nombrePropio(t.replace(/[,.]+$/, ''));
}

const compacto = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
/** "$1.2 M" / "$85.4 mil" — para la barra de proveedores, donde el centavo no ayuda. */
export const dineroCorto = (n: number | null | undefined) => (n === null || n === undefined ? '—' : '$' + compacto.format(n));

export type FiltroCatalogo = 'todos' | 'comprar' | 'mover' | 'esperar' | 'no_comprar' | 'lideres';

/** Qué veredictos cubre cada chip. "No comprar" junta todo lo que no pide compra: sobra, no se vende o no se mueve. */
export const FILTRO_VEREDICTOS: Record<Exclude<FiltroCatalogo, 'todos' | 'lideres'>, VeredictoCompra[]> = {
  comprar: ['comprar'],
  mover: ['traspasar'],
  esperar: ['esperar'],
  no_comprar: ['sobra', 'no_comprar', 'sin_movimiento'],
};

export const FILTRO_TEXTO: Record<FiltroCatalogo, string> = {
  todos: 'Todos', comprar: 'Comprar', mover: 'Mover entre sucursales', esperar: 'Esperar', no_comprar: 'No comprar', lideres: 'Líderes',
};

/** La forma mínima que la tabla necesita (los renglones de un proveedor y los de una búsqueda la comparten). */
export type FilaCatalogo = Pick<FilaProveedor, 'product_id' | 'sku' | 'nombre' | 'mes' | 'variacion' | 'cobertura_dias'
  | 'veredicto' | 'titulo' | 'motivo' | 'lider' | 'margen_real' | 'caducidad'>;

export function pasaFiltro(f: Pick<FilaCatalogo, 'veredicto' | 'lider'>, filtro: FiltroCatalogo): boolean {
  if (filtro === 'todos') return true;
  if (filtro === 'lideres') return !!f.lider;
  return FILTRO_VEREDICTOS[filtro].includes(f.veredicto);
}

export function contarFiltros(filas: FilaCatalogo[]): Record<FiltroCatalogo, number> {
  const c: Record<FiltroCatalogo, number> = { todos: filas.length, comprar: 0, mover: 0, esperar: 0, no_comprar: 0, lideres: 0 };
  for (const f of filas) {
    for (const k of ['comprar', 'mover', 'esperar', 'no_comprar', 'lideres'] as const) if (pasaFiltro(f, k)) c[k]++;
  }
  return c;
}

export type OrdenCatalogo = 'venta' | 'cobertura' | 'nombre';

export function filtrarYOrdenar(filas: FilaCatalogo[], filtro: FiltroCatalogo, texto: string, orden: OrdenCatalogo): FilaCatalogo[] {
  // El buscador canónico: sin acentos, por palabras y en cualquier orden, sobre nombre y SKU juntos.
  const xs = filtrarPorBusqueda(filas.filter((f) => pasaFiltro(f, filtro)), texto, (f) => [f.nombre, f.sku]);
  const nom = (f: FilaCatalogo) => f.nombre ?? f.sku ?? '';
  if (orden === 'nombre') return xs.sort((a, b) => nom(a).localeCompare(nom(b), 'es-MX'));
  if (orden === 'cobertura') {
    // Lo que se acaba primero arriba; lo que no se vende (sin cobertura) al final.
    return xs.sort((a, b) => (a.cobertura_dias ?? Infinity) - (b.cobertura_dias ?? Infinity) || b.mes - a.mes);
  }
  return xs.sort((a, b) => b.mes - a.mes || nom(a).localeCompare(nom(b), 'es-MX'));
}

/**
 * El ancho de la barra de cobertura, 0–100. El tope es el umbral de "sobra" del criterio: más allá de eso ya
 * no importa cuánto. NULL = no se vende (no hay ritmo con qué medir), y eso se dice, no se dibuja como vacío.
 */
export function coberturaAncho(dias: number | null, tope: number): number | null {
  if (dias === null) return null;
  if (tope <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((dias / tope) * 100)));
}

export function coberturaTexto(dias: number | null): string {
  if (dias === null) return 'No se vende';
  if (dias <= 0) return 'Sin existencia';
  if (dias < 1) return 'Menos de un día';
  const d = Math.round(dias);
  return d >= 365 ? 'Más de un año' : `${d} ${d === 1 ? 'día' : 'días'}`;
}

/**
 * Un renglón de la búsqueda (por nombre en todo el catálogo) en la forma de la tabla. La búsqueda trae el
 * flujo de la página, no la frase del servidor por proveedor: el porqué se arma con las alertas o el título.
 */
export function filaDeResumen(r: FlujoResumen, p: { sku: string | null; nombre: string | null }, alertas: string | null): FilaCatalogo {
  return {
    product_id: r.product_id, sku: p.sku ?? '', nombre: p.nombre, mes: r.mes, variacion: r.variacion,
    cobertura_dias: r.compra.cobertura_dias, veredicto: r.compra.veredicto, titulo: r.compra.titulo,
    motivo: alertas ?? r.compra.titulo, lider: r.lider,
    margen_real: r.margen_real ? { pct: r.margen_real.pct, cobertura: r.margen_real.cobertura } : null,
    caducidad: r.caducidad,
  };
}
