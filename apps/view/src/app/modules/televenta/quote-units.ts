/**
 * Unidades de venta de un artículo cotizable (COT.16). Funciones PURAS, sin Angular: se usan
 * en las pantallas de cotización y en el Excel/PDF, y se prueban en `quote-units.spec.ts`.
 * `quotes.service.ts` las re-exporta para no cambiar ninguna importación existente.
 */
import type { QuoteCatalogRow, Rung } from './quotes.service';

/**
 * Nombre para mostrar de la unidad mayor (el peldaño `box`). No siempre es "Caja": el granel se
 * vende por bulto y algunos productos por cubeta, y el ERP lo declara así (`kdii.c83`/`c80`).
 */
export function nombreUnidadMayor(label: string | null | undefined): string {
  const l = (label || '').trim().toUpperCase();
  if (l === 'BTO' || l === 'BULTO') return 'Bulto';
  if (l === 'CUB' || l === 'CUBETA') return 'Cubeta';
  if (l === 'CJA' || l === 'CAJA' || l === '') return 'Caja';
  // Un rótulo que no conocemos se muestra TAL CUAL, con la palabra del ERP: decirle "Caja" a algo
  // que el ERP llama de otra forma es inventar la unidad (hay `SER` de factor 50 en el catálogo).
  return l;
}

/**
 * Nombre para mostrar de la unidad BASE (el peldaño `base`). Antes el botón decía "Pieza" siempre:
 * el cliente pedía "8 paquetes de gansito" y había que presionar "Pieza · 1 PAQ" (COT.16).
 * Rótulos que el ERP usa como unidad pero no lo son (`500`, `250`, `IND`…) se muestran como
 * "Unidad" — UNIDADES_DE_MEDIDA §7.6: son unidad desconocida, no texto válido.
 */
export function nombreUnidadBase(unitBase: string | null | undefined, soldByKg = false): string {
  if (soldByKg) return 'Kilo';
  const u = (unitBase || '').trim().toUpperCase();
  if (u === 'KG') return 'Kilo';
  if (u === 'PAQ') return 'Paquete';
  if (u === 'CJA') return 'Caja';
  if (u === 'BTO') return 'Bulto';
  if (u === 'CUB') return 'Cubeta';
  if (u === 'PZA' || u === '') return 'Pieza';
  return 'Unidad';
}

/**
 * Abreviatura de la unidad base para el desglose "(12 PAQ $41.82)". Antes era "12PZS" fijo —
 * también para un bulto de 20 KG o una caja de 12 PAQUETES — y así llegaba al Excel/PDF del
 * cliente (COT.16). Rótulo desconocido → "u." (no se inventa una unidad).
 */
export function abrevUnidadBase(unitBase: string | null | undefined, soldByKg = false): string {
  if (soldByKg) return 'KG';
  const u = (unitBase || '').trim().toUpperCase();
  if (['KG', 'PAQ', 'CJA', 'BTO', 'CUB', 'PZA'].includes(u)) return u;
  return u ? 'u.' : 'PZA';
}

/** Un botón de unidad de venta del artículo. */
export interface OpcionUnidad {
  rung: Rung;
  titulo: string;
  /** Cuántas unidades base trae (1 para la base). Ordena los botones. */
  tamano: number;
  /** "1 kg", "10 PZA", "20 kg"… */
  detalle: string;
  icono: string;
}

/**
 * Las unidades que el ERP declara para el artículo, de MENOR a MAYOR (izquierda → derecha):
 * KINDER DELICE = Pieza 1 · Paquete 10 · Caja 140. Antes salían base · caja · paquete (COT.16).
 * Sólo las que existen: sin unidad mayor no hay botón de caja.
 */
export function opcionesUnidad(e: QuoteCatalogRow): OpcionUnidad[] {
  const base = abrevUnidadBase(e.unit_base, e.sold_by_kg);
  const enBase = (n: number) => `${n} ${e.sold_by_kg ? 'kg' : base}`;
  const out: OpcionUnidad[] = [
    { rung: 'base', titulo: nombreUnidadBase(e.unit_base, e.sold_by_kg), tamano: 1, detalle: enBase(1), icono: 'pi-tag' },
  ];
  if (e.pack_size && e.pack_size > 1) {
    out.push({ rung: 'pack', titulo: 'Paquete', tamano: e.pack_size, detalle: enBase(e.pack_size), icono: 'pi-clone' });
  }
  if (e.box_size || e.box_label) {
    out.push({
      rung: 'box',
      titulo: nombreUnidadMayor(e.box_label),
      // Sin tamaño declarado va al final (es la unidad MAYOR por definición).
      tamano: e.box_size || Number.MAX_SAFE_INTEGER,
      detalle: e.box_size ? enBase(e.box_size) : 'Empaque mayor',
      icono: 'pi-box',
    });
  }
  return out.sort((a, b) => a.tamano - b.tamano);
}
