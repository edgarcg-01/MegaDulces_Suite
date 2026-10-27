import type { Knex } from 'knex';

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
