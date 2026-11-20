import type { CeroEnFicha, FilaEnCeros } from '@megadulces/contracts';

/** Qué está en cero en una unidad, en palabras. */
export function queEstaEnCero(z: Pick<CeroEnFicha, 'costo' | 'precio_cero'>): string {
  const partes: string[] = [];
  if (z.costo === 'cero') partes.push('costo $0');
  if (z.costo === 'vacio') partes.push('costo vacío');
  if (z.precio_cero) partes.push('precio $0');
  return partes.join(' y ');
}

/** Las etiquetas del renglón: lo que tiene en cero en alguna sucursal, sin repetir. */
export function etiquetasEnCero(f: Pick<FilaEnCeros, 'ceros'>): Array<{ texto: string; grave: boolean }> {
  const out: Array<{ texto: string; grave: boolean }> = [];
  if (f.ceros.some((z) => z.precio_cero)) out.push({ texto: 'Precio $0', grave: true });
  if (f.ceros.some((z) => z.costo === 'cero')) out.push({ texto: 'Costo $0', grave: false });
  if (f.ceros.some((z) => z.costo === 'vacio')) out.push({ texto: 'Costo vacío', grave: false });
  return out;
}

/**
 * `[CAT-PRECIO.6]` Dónde está en cero, DERIVADO para que no haya que leer ocho renglones iguales: se agrupa por
 * (unidad, qué está en cero). Si un grupo cubre todas las sucursales donde existe la ficha, se dice «en sus N
 * sucursales»; si no, se nombran. Una sola sucursal se nombra siempre.
 */
export function dondeEnCero(f: Pick<FilaEnCeros, 'ceros' | 'plazas'>): string[] {
  const grupos = new Map<string, { unidad: string; que: string; sucursales: string[] }>();
  for (const z of f.ceros) {
    const que = queEstaEnCero(z);
    const k = `${z.unidad}|${que}`;
    const g = grupos.get(k) ?? { unidad: z.unidad, que, sucursales: [] };
    g.sucursales.push(z.sucursal_nombre ?? z.sucursal);
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => {
    const donde = g.sucursales.length > 1 && g.sucursales.length === f.plazas ? `En sus ${f.plazas} sucursales` : g.sucursales.join(', ');
    return `${donde} · ${g.unidad}: ${g.que}`;
  });
}
