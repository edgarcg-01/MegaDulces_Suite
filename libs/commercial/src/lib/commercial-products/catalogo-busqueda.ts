import type { Knex } from 'knex';
import { PATRON_DESCONTINUADO_PG, PATRON_PROMOCION_PG, esNombreDePromocion, esNombreDescontinuado } from '@megadulces/contracts';

/**
 * Buscador de Compras › Catálogo.
 *
 * Reemplaza el `ILIKE '%texto%'` de un solo bloque (nombre/sku/barcode/descripción), que medido
 * en prod fallaba así: «mazapan rosa» daba 0 (el nombre es «LA ROSA MAZAPAN /30»), «pina» daba
 * 11 contra 181 de «piña», no buscaba por proveedor y no veía los 1,606 códigos de barras
 * secundarios de `catalog.product_barcodes`.
 *
 * Mismo enfoque que `applySmartSearch` (`@megadulces/platform-core`): tokeniza, normaliza con
 * `public.f_unaccent(lower(...))` en SQL y NFD sin diacríticos en JS, y exige CADA palabra (AND).
 * No se llama a `applySmartSearch` directamente porque sólo acepta COLUMNAS: aquí cada palabra
 * puede coincidir también por subconsultas `EXISTS` (códigos secundarios, proveedor, unidades),
 * que no son columnas del query. Por eso el WHERE va con `whereRaw` parametrizado: el texto del
 * usuario viaja SIEMPRE como binding, nunca concatenado.
 *
 * Diferencias deliberadas con `applySmartSearch`: sin trigramas (un buscador de catálogo con
 * «parecidos» trae ruido) y con escape de `%`/`_` en la palabra.
 */

/** Rango de marcas diacríticas combinantes (igual que smart-search / f_unaccent). */
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Normaliza igual que `f_unaccent(lower(...))` en SQL: sin acentos (ñ→n) + minúsculas. */
export function normalizarBusqueda(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(DIACRITICS, '').toLowerCase().trim();
}

/** Palabras del texto, normalizadas. Vacío si el texto es vacío o sólo espacios. */
export function palabrasDeBusqueda(texto: string | null | undefined): string[] {
  return normalizarBusqueda(texto).split(/\s+/).filter(Boolean);
}

/**
 * Palabra que dice la gente → rótulo de unidad en la escalera de Kepler
 * (`analytics.v_kepler_unit_ladder.u1_label/u2_label/u3_label`). Rótulos medidos en la base:
 * PAQ, CJA, PZA, KG, BTO (más ruido como «500», «SER», «CUB» que no se mapea).
 */
export const UNIDAD_POR_PALABRA: Readonly<Record<string, string>> = {
  caja: 'CJA', cajas: 'CJA', cja: 'CJA',
  paquete: 'PAQ', paquetes: 'PAQ', paq: 'PAQ',
  pieza: 'PZA', piezas: 'PZA', pza: 'PZA',
  kilo: 'KG', kilos: 'KG', kg: 'KG',
  bulto: 'BTO', bultos: 'BTO', bto: 'BTO',
};

/** Escapa los comodines de LIKE para que «50%» o «a_b» se busquen literales. */
function escaparLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Aplica la búsqueda del catálogo a un query que ya tiene `catalog.products` con alias `p`
 * (y opcionalmente `catalog.suppliers` con alias `s` unido por p.supplier_id).
 * Por palabras, en cualquier orden, sin acentos ni ñ, sobre: nombre, sku, descripción,
 * TODOS los códigos de barras (catalog.product_barcodes activos, por EXISTS), nombre del proveedor
 * y las unidades del producto (palabras caja/cajas→CJA, paquete→PAQ, pieza→PZA, kilo→KG, bulto→BTO,
 * comparadas contra analytics.v_kepler_unit_ladder u1/u2/u3 por EXISTS).
 * Texto vacío o sólo espacios: no filtra.
 *
 * Notas de esquema (verificadas contra la base):
 *  - `p` puede ser `catalog.products` o la vista `public.products` (ambas tienen nombre, sku,
 *    barcode, description, tenant_id). Si `conProveedor` es falso, el proveedor se busca por
 *    `EXISTS` sobre `catalog.products`→`catalog.suppliers` por `p.id`, porque la vista
 *    `public.products` NO expone `supplier_id`.
 *  - `catalog.product_barcodes` se liga por `(tenant_id, sku)`: `product_id` sólo existe donde
 *    corrió `[NORM.2]` y todavía puede venir nulo (sus escritores no lo llenan).
 *  - La escalera de unidades no tiene `tenant_id`: es la de Kepler (un solo tenant), por `sku`.
 */
export function aplicarBusquedaCatalogo(
  qb: Knex.QueryBuilder,
  texto: string | null | undefined,
  opts?: { conProveedor?: boolean },
): Knex.QueryBuilder {
  const palabras = palabrasDeBusqueda(texto);
  if (!palabras.length) return qb;

  const hay = opts?.conProveedor
    ? `public.f_unaccent(lower(concat_ws(' ', p.nombre, p.sku, p.barcode, p.description, s.name)))`
    : `public.f_unaccent(lower(concat_ws(' ', p.nombre, p.sku, p.barcode, p.description)))`;

  for (const palabra of palabras) {
    const patron = `%${escaparLike(palabra)}%`;
    const partes: string[] = [`${hay} LIKE ?`];
    const valores: unknown[] = [patron];

    // Códigos de barras (todos, no sólo el principal). Sólo si la palabra trae dígitos: un EAN
    // no tiene letras, y así una palabra como «rosa» no paga la subconsulta.
    if (/\d/.test(palabra)) {
      partes.push(
        `EXISTS (SELECT 1 FROM catalog.product_barcodes pb
                  WHERE pb.tenant_id = p.tenant_id AND pb.sku = p.sku
                    AND pb.deleted_at IS NULL AND lower(pb.barcode) LIKE ?)`,
      );
      valores.push(patron);
    }

    // Proveedor por subconsulta cuando el caller no unió `catalog.suppliers` como `s`.
    if (!opts?.conProveedor) {
      partes.push(
        `EXISTS (SELECT 1 FROM catalog.products cpb
                   JOIN catalog.suppliers spb
                     ON spb.id = cpb.supplier_id AND spb.tenant_id = cpb.tenant_id
                  WHERE cpb.id = p.id AND cpb.tenant_id = p.tenant_id
                    AND public.f_unaccent(lower(spb.name)) LIKE ?)`,
      );
      valores.push(patron);
    }

    // Unidad en que se maneja el producto (caja → CJA, ...).
    const unidad = UNIDAD_POR_PALABRA[palabra];
    if (unidad) {
      partes.push(
        `EXISTS (SELECT 1 FROM analytics.v_kepler_unit_ladder ul
                  WHERE ul.sku = p.sku AND ? IN (ul.u1_label, ul.u2_label, ul.u3_label))`,
      );
      valores.push(unidad);
    }

    qb.andWhereRaw(`(${partes.join(' OR ')})`, valores as readonly Knex.Value[]);
  }
  return qb;
}

/**
 * `[PF.12.1]` El orden por omisión de la lista Sencillo de Compras › Catálogo: **lo vendible primero**.
 *
 * Ordenaba por `p.nombre`. Medido en producción el 2026-10-29: 49 de los 50 renglones de la primera página
 * no eran mercancía —nombres `***` y `.`, promociones «= GRATIS» (339) y productos sin SKU ni unidades
 * (1,132)—, y buscar «70001» ponía primero los productos cuyo CÓDIGO DE BARRAS contiene 70001.
 *
 * Las llaves, en este orden (cada una decide sólo si empatan las anteriores):
 *  1. coincidencia EXACTA con lo buscado: el SKU o el código de barras principal (sólo si hay texto);
 *  2. con SKU antes que sin SKU;
 *  3. nombre con al menos una letra antes que sin letras (`***`, `.`);
 *  4. promociones y descontinuados al final, con las reglas de `esNombreDePromocion` y `esNombreDescontinuado`
 *     (en SQL, `PATRON_PROMOCION_PG` y `PATRON_DESCONTINUADO_PG`: las mismas). `[PF.20]` Kepler marca el
 *     descontinuado reemplazando el nombre por «* DESCONTINUADO»: tampoco es lo que se busca primero;
 *  5. con unidades antes que sin unidades — SÓLO con precio por sucursal: la columna sale del lateral `sp`
 *     (`SIN_PRECIO_LATERAL_SQL`), que sin ese grano no se une; sin él, esta llave no aplica (no se inventa);
 *  6. nombre sin signos al inicio, sin acentos, en minúsculas y comparado byte a byte (`COLLATE "C"`: igual en
 *     cualquier servidor), y `p.id` para que el corte entre páginas sea estable.
 *
 * Sólo ORDENA: no filtra ni une nada, así que los conteos y el total no cambian. El texto viaja como binding.
 * Requiere `p` (`catalog.products`) y, con `conUnidades`, el lateral `sp`. Su testigo en JS es
 * `claveDeOrdenCatalogo`: cada llave lleva el mismo número; si cambia una, cambia la otra.
 */
export function ordenListaCatalogo(
  texto: string | null | undefined,
  conUnidades: boolean,
): { llaves: string[]; sql: string; bindings: string[] } {
  const exacto = (texto ?? '').trim();
  const llaves: string[] = [];
  const bindings: string[] = [];
  if (exacto) {
    llaves.push('CASE WHEN btrim(p.sku) = ? OR btrim(p.barcode) = ? THEN 0 ELSE 1 END'); // 1
    bindings.push(exacto, exacto);
  }
  llaves.push(`CASE WHEN nullif(btrim(p.sku), '') IS NULL THEN 1 ELSE 0 END`); // 2
  llaves.push(`CASE WHEN p.nombre ~ '[[:alpha:]]' THEN 0 ELSE 1 END`); // 3
  llaves.push(`CASE WHEN coalesce(p.nombre, '') ~* ? OR coalesce(p.nombre, '') ~* ? THEN 1 ELSE 0 END`); // 4
  bindings.push(PATRON_PROMOCION_PG, PATRON_DESCONTINUADO_PG);
  if (conUnidades) llaves.push('CASE WHEN sp.con_unidades THEN 0 ELSE 1 END'); // 5
  llaves.push(`public.f_unaccent(lower(regexp_replace(coalesce(p.nombre, ''), '^[^[:alnum:]]+', ''))) COLLATE "C"`); // 6
  llaves.push('p.id'); // 6
  return { llaves, sql: llaves.join(', '), bindings };
}

/** Lo que mira el orden de la lista de un renglón. `conUnidades` = el lateral `sp.con_unidades`. */
export interface FilaParaOrden {
  id: string;
  sku: string | null;
  barcode: string | null;
  nombre: string | null;
  conUnidades?: boolean | null;
}

/** Llave 6: sin signos al inicio, sin acentos, minúsculas (como `f_unaccent(lower(regexp_replace(...)))`). */
export function nombreParaOrden(nombre: string | null | undefined): string {
  return (nombre ?? '').replace(/^[^\p{L}\p{N}]+/u, '').normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/**
 * `[PF.12.1]` El MISMO orden que `ordenListaCatalogo`, en JS. No ordena nada en producción: es el testigo con
 * el que se prueba la regla con datos de ejemplo (sin base) y con el que se cruzó la consulta contra la base.
 *
 * Cruce del 2026-10-29 (base local, 11,008 productos activos, 20 combinaciones de búsqueda/sucursal/llave 5):
 * mismo orden salvo 5 posiciones de 11,008 en la lista sin búsqueda, todas por «½»: `f_unaccent` lo vuelve
 * « 1/2» y la normalización de JS lo deja igual. Diferencia conocida; no mueve nada de la primera página.
 */
export function claveDeOrdenCatalogo(f: FilaParaOrden, texto: string | null | undefined, conUnidades: boolean): Array<number | string> {
  const exacto = (texto ?? '').trim();
  const clave: Array<number | string> = [];
  if (exacto) clave.push((f.sku ?? '').trim() === exacto || (f.barcode ?? '').trim() === exacto ? 0 : 1); // 1
  clave.push((f.sku ?? '').trim() ? 0 : 1); // 2
  clave.push(/\p{L}/u.test(f.nombre ?? '') ? 0 : 1); // 3
  clave.push(esNombreDePromocion(f.nombre) || esNombreDescontinuado(f.nombre) ? 1 : 0); // 4
  if (conUnidades) clave.push(f.conUnidades ? 0 : 1); // 5
  clave.push(nombreParaOrden(f.nombre), f.id); // 6
  return clave;
}

/** Ordena una copia como la lista (testigo de `ordenListaCatalogo`). Comparación byte a byte, como `COLLATE "C"`. */
export function ordenarComoLaLista<T extends FilaParaOrden>(filas: readonly T[], texto: string | null | undefined, conUnidades: boolean): T[] {
  const conClave = filas.map((f) => ({ f, k: claveDeOrdenCatalogo(f, texto, conUnidades) }));
  conClave.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) {
      if (a.k[i] < b.k[i]) return -1;
      if (a.k[i] > b.k[i]) return 1;
    }
    return 0;
  });
  return conClave.map((x) => x.f);
}

/** Datos de un producto para explicar por qué coincidió. */
export interface ProductoParaRazon {
  nombre: string;
  sku: string | null;
  descripcion?: string | null;
  codigos: string[];
  codigoPrincipal?: string | null;
  proveedor?: string | null;
  unidades?: string[];
}

/**
 * Por qué coincidió un producto con el texto (para mostrar «Coincide por …»). Pura, sin base.
 *
 * Devuelve `null` si no hay texto o si TODAS las palabras están en el nombre/descripción (no hace
 * falta explicar). Si alguna palabra coincidió por otro lado, devuelve las razones unidas con
 * ' · ': 'SKU', 'código de barras', 'código de barras adicional 4510000170833', 'proveedor',
 * 'se maneja en CJA'. Si alguna palabra no coincide con nada, devuelve `null` (no hay coincidencia
 * que explicar; el SQL no lo habría traído).
 */
export function razonDeCoincidencia(p: ProductoParaRazon, texto: string): string | null {
  const palabras = palabrasDeBusqueda(texto);
  if (!palabras.length) return null;

  const nombre = normalizarBusqueda(p.nombre);
  const descripcion = normalizarBusqueda(p.descripcion);
  const sku = normalizarBusqueda(p.sku);
  const proveedor = normalizarBusqueda(p.proveedor);
  const principal = normalizarBusqueda(p.codigoPrincipal);
  const unidades = new Set((p.unidades ?? []).map((u) => (u ?? '').trim().toUpperCase()));

  const razones: string[] = [];
  const agregar = (r: string) => {
    if (!razones.includes(r)) razones.push(r);
  };

  for (const w of palabras) {
    if (nombre.includes(w) || descripcion.includes(w)) continue;
    let alguna = false;

    if (sku && sku.includes(w)) {
      agregar('SKU');
      alguna = true;
    }
    if (principal && principal.includes(w)) {
      agregar('código de barras');
      alguna = true;
    }
    for (const c of p.codigos ?? []) {
      const cn = normalizarBusqueda(c);
      if (!cn || !cn.includes(w)) continue;
      if (principal && cn === principal) agregar('código de barras');
      else agregar(`código de barras adicional ${c.trim()}`);
      alguna = true;
    }
    if (proveedor && proveedor.includes(w)) {
      agregar('proveedor');
      alguna = true;
    }
    const unidad = UNIDAD_POR_PALABRA[w];
    if (unidad && unidades.has(unidad)) {
      agregar(`se maneja en ${unidad}`);
      alguna = true;
    }
    if (!alguna) return null;
  }
  return razones.length ? razones.join(' · ') : null;
}
