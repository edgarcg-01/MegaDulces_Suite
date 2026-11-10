/**
 * `[MOS.1]` — Lo que el buscador del mostrador («¿Te pidieron algo?») sabe hacer con el catálogo.
 *
 * Funciones PURAS, separadas del componente para poder probarlas sin montar Angular: la búsqueda
 * por cuatro campos, cuántos paquetes trae la caja y cómo se dice el mayoreo.
 *
 * ⭐ `[VTK.17]` **Se movió acá desde `apps/view/src/app/modules/tienda/mostrador-catalogo.ts`**
 * (que ahora sólo reexporta) para que el checador de precios de la app de vendedores busque y
 * cuente la caja con LA MISMA regla que el verificador de la tienda, en vez de una copia. Se movió
 * con su spec. Los tipos del respaldo son ESTRUCTURALES (`RenglonRespaldo`, `TramoMayoreo`): son la
 * misma forma que `VerificadorSnapshotItem` y `MayoreoTier` de `@megadulces/contracts`, que no se
 * importan porque `ui-web` no depende de ninguna otra librería del repo.
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
import { normalizarBusqueda, tokensDeBusqueda } from '../search/buscar-en-cliente';

/**
 * Un renglón del respaldo de precios (`/api/kp/precios-todos`), en la forma mínima que esto lee.
 * Es estructuralmente `VerificadorSnapshotItem` de `@megadulces/contracts`.
 */
export interface RenglonRespaldo {
  /** Clave de Kepler, con ceros a la izquierda (`00052`). */
  c: string;
  /** Los códigos de barras (las cinco casillas de Kepler, las que tengan algo). */
  b?: string[];
  /** La unidad de cada código, en el mismo índice que `b`. Ausente en respaldos anteriores. */
  bu?: (string | null)[];
  n: string;
  /** Presentaciones, base primero: `p` con IVA, `f` unidades base que trae (ausente = no se sabe). */
  u?: ReadonlyArray<{ u: string; p: number; s?: number; f?: number }>;
  /** Índice en el diccionario de proveedores del respaldo. */
  pv?: number;
  /** `1` = promoción/ajuste de Kepler, no un producto. */
  pm?: 1;
}

/** Un escalón de mayoreo, en la forma mínima que esto lee (estructuralmente `MayoreoTier`). */
export interface TramoMayoreo {
  aplica_a?: string | null;
  desde: number;
  precio_con_iva: number;
  descuento_pct: number;
}

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

/**
 * `[VTK.17]` Las presentaciones de un renglón del RESPALDO, en la forma de `presentacionesDe`.
 * `f` llega desde el formato 3: un respaldo más viejo no lo trae y queda en 1, que se lee como
 * «no sé cuánto trae» (la presentación no dice nada en vez de inventar un contenido).
 */
export function unidadesDelRespaldo(item: Pick<RenglonRespaldo, 'u'>): UnidadConFactor[] {
  return (item.u || []).map((x) => ({ u: x.u, precio_con_iva: x.p, factor: x.f ?? 1 }));
}

/**
 * `[VTK.17]` ¿De qué presentación es ESTE código de barras? Sale de `bu` (mismo índice que `b`).
 * `null` = el código no dice su unidad (la clave misma, un código sin unidad, o un respaldo viejo).
 * Sólo se afirma la unidad si además tiene precio en el renglón: decir «leíste la caja» y no poder
 * mostrar el precio de la caja sería peor que no decir nada.
 */
export function unidadDelCodigo(item: Pick<RenglonRespaldo, 'b' | 'bu' | 'u'>, codigo: string): string | null {
  const c = String(codigo ?? '').trim();
  if (!c) return null;
  const i = (item.b || []).indexOf(c);
  const unidad = i >= 0 ? item.bu?.[i] ?? null : null;
  return unidad && (item.u || []).some((x) => x.u === unidad) ? unidad : null;
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
export function escalonesDe(unidades: readonly UnidadConFactor[], mayoreo: readonly TramoMayoreo[]): Escalon[] {
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
export interface Buscable<T extends RenglonRespaldo = RenglonRespaldo> {
  item: T;
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
export function aBuscable<T extends RenglonRespaldo>(item: T, proveedores: readonly string[]): Buscable<T> {
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

export interface Coincidencia<T extends RenglonRespaldo = RenglonRespaldo> {
  b: Buscable<T>;
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
export function buscarEnCatalogo<T extends RenglonRespaldo>(buscables: readonly Buscable<T>[], consulta: string, limite = 40): Coincidencia<T>[] {
  const tokens = tokensDeBusqueda(consulta);
  if (!tokens.length) return [];
  const unico = tokens.length === 1 ? tokens[0] : null;
  const unicoCorto = unico ? unico.replace(/^0+/, '') : '';
  const todos = (campo: string) => tokens.every((t) => campo.includes(t));

  const res: Coincidencia<T>[] = [];
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

/**
 * `[VTK.17]` Los productos cuyo código de barras o clave ES exactamente este (la clave, con o sin
 * ceros a la izquierda). Vacío = ninguno: un pedazo de código NO cuenta, porque esto se usa para
 * decir «leíste tal producto» y un parecido no es una lectura.
 *
 * Devuelve TODOS los que casan, no el primero: `[TDA.9]` midió un mismo código en las casillas de
 * dos productos distintos (`7503008008816`). Quien llama dice que es ambiguo en vez de elegir uno
 * en silencio. El código de barras gana a la clave: es lo que lee la cámara.
 */
export function productosPorCodigo<T extends RenglonRespaldo>(buscables: readonly Buscable<T>[], codigo: string): Buscable<T>[] {
  const c = String(codigo ?? '').trim();
  if (!c) return [];
  const porBarras = buscables.filter((b) => b.barcodes.includes(c));
  if (porBarras.length) return porBarras;
  const corto = c.replace(/^0+/, '');
  return buscables.filter((b) => b.codigo === c || (!!corto && b.corto === corto));
}

function redondea(n: number): number {
  return Math.round(n * 100) / 100;
}
