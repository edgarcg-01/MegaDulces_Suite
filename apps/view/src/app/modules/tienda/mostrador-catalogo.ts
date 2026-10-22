/**
 * `[MOS.1]` — Lo que el buscador del mostrador («¿Te pidieron algo?») sabe hacer con el catálogo.
 *
 * Funciones PURAS, separadas del componente para poder probarlas sin montar Angular: la búsqueda
 * por cuatro campos, cuántos paquetes trae la caja y cómo se dice el mayoreo.
 *
 * ── Las tres reglas, cada una con su porqué ──────────────────────────────────────────────────
 *  1. **Busca por nombre, proveedor, SKU o código de barras**, y dice POR QUÉ salió cada renglón.
 *     Sin ese «por qué», buscar `rosa` y ver un mazapán sin «rosa» en el nombre parece un error.
 *  2. **La caja se cuenta en paquetes** cuando el producto tiene paquete y la división es exacta.
 *     El factor de Kepler cuenta desde la base (`ERP_KEPLER.md` §2.1.1), así que 800 piezas en
 *     paquetes de 40 son 20 paquetes. Si no divide exacto, se dicen las piezas: un «12.5
 *     paquetes» sería inventar un empaque que no existe.
 *  3. **El mayoreo se dice en la presentación en que Kepler lo captura**, por unidad: el precio de
 *     un escalón de paquete es el de UN paquete (medido: mediana 0.93 contra el precio del paquete
 *     y 8.99 contra el de la pieza, `KpService.tiersDeFila`). Convertirlo a pieza sería cotizar
 *     algo que la caja no cobra.
 */
import { normalizarBusqueda, tokensDeBusqueda } from '@megadulces/ui-web';
import type { MayoreoTier, VerificadorSnapshotItem } from '@megadulces/contracts';

/** Una presentación tal como llega: base primero, `factor` en unidades BASE. */
export interface UnidadConFactor {
  u: string;
  precio_con_iva: number;
  factor: number;
}

const SINGULAR: Record<string, string> = { PZA: 'pieza', PAQ: 'paquete', CJA: 'caja', KG: 'kg' };
const PLURAL: Record<string, string> = { PZA: 'piezas', PAQ: 'paquetes', CJA: 'cajas', KG: 'kg' };
const NOMBRE: Record<string, string> = { PZA: 'Pieza', PAQ: 'Paquete', CJA: 'Caja', KG: 'Kilo' };

/** `pieza`, `paquete`… — una unidad desconocida se dice con su clave, no se traduce a ojo. */
export const singularDe = (u: string): string => SINGULAR[u] ?? u.toLowerCase();
export const pluralDe = (u: string): string => PLURAL[u] ?? u.toLowerCase();
export const nombreDe = (u: string): string => NOMBRE[u] ?? u;

export interface Presentacion {
  u: string;
  nombre: string;
  precio: number;
  /** Qué trae, en la unidad de abajo. `null` = es la base (o Kepler no dice el factor). */
  trae: { n: number; u: string; palabra: string } | null;
  /** Lo que sale cada una de lo que trae (`$163.75 c/paquete`). `null` sin `trae`. */
  precioPorTrae: number | null;
  /** `c/paquete`, `c/pieza`. `null` sin `trae`. */
  etiquetaPorTrae: string | null;
}

/**
 * Las presentaciones con lo que trae cada una. La caja va en paquetes cuando se puede.
 */
export function presentacionesDe(unidades: readonly UnidadConFactor[]): Presentacion[] {
  if (!unidades.length) return [];
  const base = unidades[0].u;
  const paq = unidades.find((x) => x.u === 'PAQ' && x.u !== base && x.factor > 1);
  return unidades.map((x) => {
    let trae: Presentacion['trae'] = null;
    if (x.factor > 1) {
      const enPaquetes = x.u === 'CJA' && paq && Number.isInteger(x.factor / paq.factor);
      trae = enPaquetes && paq
        ? { n: x.factor / paq.factor, u: 'PAQ', palabra: pluralDe('PAQ') }
        : { n: x.factor, u: base, palabra: pluralDe(base) };
    }
    return {
      u: x.u,
      nombre: nombreDe(x.u),
      precio: x.precio_con_iva,
      trae,
      precioPorTrae: trae ? redondea(x.precio_con_iva / trae.n) : null,
      etiquetaPorTrae: trae ? `c/${singularDe(trae.u)}` : null,
    };
  });
}

export interface Escalon {
  /** La presentación en que Kepler lo captura (`PZA`, `PAQ`, `KG`…). */
  u: string;
  singular: string;
  plural: string;
  desde: number;
  /** El precio de mayoreo de UNA unidad de esa presentación. */
  precio: number;
  /** El precio normal de esa misma presentación (debajo del mínimo). `null` = no está a la venta. */
  precioNormal: number | null;
  descuentoPct: number;
  /** `c/paquete`, `c/pieza`, `c/kg`. */
  etiqueta: string;
}

/**
 * Los escalones de mayoreo, en la presentación en que Kepler los captura.
 *
 * `aplica_a: 'paquete'` sólo lo pone el servidor cuando el producto tiene un paquete real; todo lo
 * demás es de la unidad base (incluido el «paquete» de un producto cuya base YA es paquete).
 */
export function escalonesDe(unidades: readonly UnidadConFactor[], mayoreo: readonly MayoreoTier[]): Escalon[] {
  if (!unidades.length) return [];
  const base = unidades[0].u;
  return mayoreo.map((t) => {
    const u = t.aplica_a === 'paquete' ? 'PAQ' : base;
    const normal = unidades.find((x) => x.u === u)?.precio_con_iva ?? null;
    return {
      u,
      singular: singularDe(u),
      plural: pluralDe(u),
      desde: t.desde,
      precio: t.precio_con_iva,
      precioNormal: normal,
      descuentoPct: t.descuento_pct,
      etiqueta: `c/${singularDe(u)}`,
    };
  });
}

/** Cómo se dice el tramo de precio normal: `1 a 2 paquetes`, `1 pieza`. */
export function tramoNormal(e: Escalon): string {
  const hasta = e.desde - 1;
  return hasta > 1 ? `1 a ${hasta} ${e.plural}` : `1 ${e.singular}`;
}

// ── Búsqueda ──────────────────────────────────────────────────────────────────────────────────

export type CampoCoincidencia = 'barcode' | 'sku' | 'nombre' | 'proveedor' | 'varios';

export const ETIQUETA_CAMPO: Record<CampoCoincidencia, string> = {
  barcode: 'Código de barras',
  sku: 'SKU',
  nombre: 'Nombre',
  proveedor: 'Proveedor',
  varios: 'Nombre y proveedor',
};

/** Un producto del respaldo, con sus campos ya normalizados una sola vez. */
export interface Buscable {
  item: VerificadorSnapshotItem;
  codigo: string;
  /** La clave sin ceros a la izquierda: así la teclea la gente. */
  corto: string;
  proveedor: string | null;
  barcodes: string[];
  nNombre: string;
  nProveedor: string;
  nTodo: string;
}

/** Prepara un producto del respaldo para buscarlo. `proveedores` es el diccionario del snapshot. */
export function aBuscable(item: VerificadorSnapshotItem, proveedores: readonly string[]): Buscable {
  const proveedor = item.pv != null ? (proveedores[item.pv] ?? null) : null;
  const corto = (item.c || '').replace(/^0+/, '');
  const barcodes = (item.b || []).filter(Boolean);
  const nNombre = normalizarBusqueda(item.n);
  const nProveedor = normalizarBusqueda(proveedor);
  return {
    item, codigo: item.c, corto, proveedor, barcodes, nNombre, nProveedor,
    nTodo: [nNombre, nProveedor, item.c, corto, ...barcodes].join(' '),
  };
}

export interface Coincidencia {
  b: Buscable;
  por: CampoCoincidencia;
  /** El código tecleado ES una clave o un código de barras de este producto. */
  exacto: boolean;
  /** `[ETQ-PROMO.2]` Es una promoción/ajuste de Kepler (`pm:1` del respaldo), no un producto. */
  esPromocion: boolean;
}

const RANGO_CAMPO: Record<CampoCoincidencia, number> = { sku: 0, barcode: 1, nombre: 2, proveedor: 3, varios: 4 };

/**
 * Busca en el respaldo por nombre, proveedor, SKU o código de barras.
 *
 * Mismas reglas que `coincideBusqueda`: sin acentos, todas las palabras, en cualquier orden. Lo que
 * se agrega es saber en QUÉ campo casó, y ordenar: primero el código exacto (es lo que se escaneó),
 * luego por campo, luego el que empieza con lo tecleado.
 */
export function buscarEnCatalogo(buscables: readonly Buscable[], consulta: string, limite = 40): Coincidencia[] {
  const tokens = tokensDeBusqueda(consulta);
  if (!tokens.length) return [];
  const unico = tokens.length === 1 ? tokens[0] : null;
  const unicoCorto = unico ? unico.replace(/^0+/, '') : '';
  const todos = (campo: string) => tokens.every((t) => campo.includes(t));

  const res: Coincidencia[] = [];
  for (const b of buscables) {
    let por: CampoCoincidencia | null = null;
    if (unico && b.barcodes.some((x) => x.includes(unico))) por = 'barcode';
    else if (unico && unicoCorto && (b.corto.startsWith(unicoCorto) || b.codigo.startsWith(unico))) por = 'sku';
    else if (todos(b.nNombre)) por = 'nombre';
    else if (b.nProveedor && todos(b.nProveedor)) por = 'proveedor';
    else if (todos(b.nTodo)) por = 'varios';
    if (!por) continue;
    const exacto = !!unico && (b.barcodes.includes(unico) || (!!unicoCorto && b.corto === unicoCorto));
    // `[ETQ-PROMO.2]` Una promoción/ajuste de Kepler SÍ sale (quien busca «OREO BASE 9 KG» quiere ver qué es),
    // pero marcada y después de los productos: igual que en el buscador de la etiquetera.
    res.push({ b, por, exacto, esPromocion: b.item.pm === 1 });
  }

  const primero = tokens[0];
  return res
    .sort((x, y) =>
      Number(y.exacto) - Number(x.exacto)
      // `[ETQ-PROMO.2]` Las promociones detrás de los productos (salvo que se teclee SU clave exacta: va primero).
      || Number(x.esPromocion) - Number(y.esPromocion)
      || RANGO_CAMPO[x.por] - RANGO_CAMPO[y.por]
      || Number(y.b.nNombre.startsWith(primero)) - Number(x.b.nNombre.startsWith(primero))
      || x.b.item.n.localeCompare(y.b.item.n))
    .slice(0, limite);
}

function redondea(n: number): number {
  return Math.round(n * 100) / 100;
}
