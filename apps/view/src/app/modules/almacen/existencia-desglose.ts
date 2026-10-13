/**
 * `[EX.U2]` — La existencia en CAJAS, PAQUETES y PIEZAS, en vez de una caja con decimales.
 *
 * Pedido (2026-10-12): *"no las quiero en decimales, tiene que mostrar cajas, paq y pz, no 333.7
 * ya que no nos da una idea clara y certera"*. Un `333.7` obliga a hacer la cuenta de cuánto es
 * ese `.7`; `333 cj 8 paq 4 pz` es lo que se cuenta en el anaquel.
 *
 * ⛔ NO convierte nada que el backend no haya convertido ya: parte de la cantidad NATIVA del
 * almacén (`nat`, lo que el ERP guarda) y de los MISMOS divisores con los que se calculó la cifra en
 * cajas (`bf` = unidades base por caja, `pf` = unidades base por paquete según la ficha de Kepler de
 * ese almacén). Es aritmética entera sobre el dato base — ADR-055: el divisor es de presentación.
 *
 * Reglas:
 *   - Sin factor de caja (`bf` ≤ 1) no hay cajas que contar: va la cantidad en su unidad base.
 *   - El paquete sólo existe si el backend lo mandó (peldaño intermedio real de la ficha).
 *   - Lo que se mide en PESO conserva decimales en su última parte (2.5 kg es un dato, no ruido);
 *     lo contado (piezas, paquetes) va entero.
 *   - Las partes en cero no se escriben: `12 cj 5 pz`, no `12 cj 0 paq 5 pz`. Todo en cero = `0`.
 */

export interface DesgloseParte { n: number; u: string; }

/** Rótulo corto para la unidad base que declara el ERP. */
export function rotuloUnidad(raw: string | null | undefined): string {
  const r = (raw || '').trim().toUpperCase();
  if (!r) return 'u';
  // Kepler a veces guarda el GRAMAJE en el rótulo ('500', '250'): no es un nombre de unidad.
  if (/^[\d.]+$/.test(r)) return 'u';
  const mapa: Record<string, string> = {
    PZA: 'pz', PZ: 'pz', PIEZA: 'pz', PZAS: 'pz',
    PAQ: 'paq', PAQUETE: 'paq',
    CJA: 'cj', CAJA: 'cj', CJ: 'cj',
    KG: 'kg', KGS: 'kg', GR: 'g', GRS: 'g',
    BTO: 'bto', BULTO: 'bto', LT: 'l', LTS: 'l',
  };
  return mapa[r] ?? r.toLowerCase();
}

const ES_PESO = new Set(['kg', 'g', 'l']);

/** Quita el ruido de float (1459.9999999 → 1460) sin tocar decimales reales. */
const limpio = (v: number) => Math.round(v * 1000) / 1000;

export function desglosar(
  nat: number | null | undefined,
  bf: number | null | undefined,
  pf: number | null | undefined,
  baseRaw: string | null | undefined,
  paqRaw?: string | null,
): DesgloseParte[] {
  const total = limpio(Number(nat) || 0);
  const base = rotuloUnidad(baseRaw);
  const peso = ES_PESO.has(base);
  const fmtResto = (v: number) => (peso ? Math.round(v * 100) / 100 : Math.round(v));

  if (total <= 0) return [{ n: 0, u: base }];

  const caja = Number(bf) > 1 ? Number(bf) : null;
  const paq = caja && Number(pf) > 1 && Number(pf) < caja ? Number(pf) : null;
  const partes: DesgloseParte[] = [];
  let resto = total;

  if (caja) {
    const cj = Math.floor(limpio(resto / caja));
    if (cj > 0) partes.push({ n: cj, u: 'cj' });
    resto = limpio(resto - cj * caja);
  }
  if (paq) {
    const pq = Math.floor(limpio(resto / paq));
    if (pq > 0) partes.push({ n: pq, u: rotuloUnidad(paqRaw) === 'u' ? 'paq' : rotuloUnidad(paqRaw) });
    resto = limpio(resto - pq * paq);
  }
  const r = fmtResto(resto);
  if (r > 0) partes.push({ n: r, u: base });
  return partes.length ? partes : [{ n: 0, u: base }];
}

/** El mismo desglose como texto plano, para tooltips y lectores de pantalla. */
export function desgloseTexto(partes: DesgloseParte[]): string {
  return partes.map((p) => `${p.n.toLocaleString('es-MX')} ${p.u}`).join(' ');
}
