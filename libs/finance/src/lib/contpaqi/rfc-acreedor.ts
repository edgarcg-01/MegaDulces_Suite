/**
 * `[CP.8.71]` — **El RFC del acreedor en Kepler (`kdxd.c10`) no es de fiar: se valida y se repara.**
 *
 * Medido el 2026-10-21: en 249 pagos que el puente no podía armar, el RFC de Kepler no existía como emisor
 * de ningún CFDI. No era otra empresa: era captura — dedazos (PCP920**5**23**H**QA por PCP920**4**23**K**QA),
 * guiones y cortado («CCO-820507-BV»), cero por letra, el RFC de otra razón social o el de una persona física.
 * Con ese RFC la cadena pago → entrada → CFDI no encontraba la factura.
 *
 * Escalera, y **sólo si la respuesta es única** (con dos candidatos no se elige):
 *   1. el RFC tal cual existe como emisor
 *   2. sin guiones ni espacios
 *   3. a ≤ 2 ediciones de UN emisor
 *   4. el nombre del acreedor = el de UN emisor
 * De 795 acreedores con pagos: 242 · 1 · 23 · 160, y 369 sin resolver. La cadena pasó de 701 a 855 pólizas
 * completas e iguales a la contadora, con 14 errores contra 12.
 *
 * Puro, sin DB: recibe el padrón de emisores ya cargado.
 */

export type ViaRfc = 'tal_cual' | 'sin_formato' | 'parecido' | 'por_nombre';

export interface PadronEmisores {
  /** RFC de todo emisor de CFDI recibido. */
  rfcs: ReadonlySet<string>;
  /** Nombre normalizado (`normalizarNombre`) → RFC de los emisores que lo usan. */
  porNombre: ReadonlyMap<string, ReadonlySet<string>>;
  /** `normalizarTexto` → RFC: para el nombre que escribe tesorería en el concepto del banco. */
  porTexto?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Los nombres (`normalizarTexto`, ≥ 8 letras) que llevan a UN solo RFC. */
  unicosTexto?: readonly (readonly [string, string])[];
}

/** El padrón desde los CFDI recibidos. */
export function construirPadron(cfdis: readonly { rfc: string; nom: string | null }[]): PadronEmisores {
  const porNombre = new Map<string, Set<string>>(); const porTexto = new Map<string, Set<string>>();
  const agregar = (m: Map<string, Set<string>>, k: string, rfc: string): void => {
    const s = m.get(k); if (s) s.add(rfc); else m.set(k, new Set([rfc]));
  };
  for (const x of cfdis) {
    const n = normalizarNombre(x.nom); if (n) agregar(porNombre, n, x.rfc);
    const t = normalizarTexto(x.nom); if (t.length >= 5) agregar(porTexto, t, x.rfc);
  }
  const unicosTexto = [...porTexto.entries()].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0]] as const);
  return { rfcs: new Set(cfdis.map((x) => x.rfc)), porNombre, porTexto, unicosTexto };
}

/** Como `normalizarNombre`, quitando además artículos y conjunciones: para texto libre del banco. */
export function normalizarTexto(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(S\.?\s*A\.?|DE|DEL|LA|LOS|LAS|Y|C\.?\s*V\.?|S\.?\s*DE\s*R\.?\s*L\.?|SAPI|SA|CV|RL|S|R|L|SC|SPR)\b/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * `[CP.8.71]` El proveedor por el nombre que tesorería escribe en el concepto («Grupo Confitero de Dulces
 * de Occidente»): igual a UN emisor, o que contenga el nombre de UN emisor (≥ 8 letras). Medido: 46 de 50
 * bien cuando Kepler no lo da. `contpaqi.supplier_aliases` está vacía: nadie confirmó alias.
 */
export function rfcPorTexto(texto: string | null | undefined, padron: PadronEmisores): string | null {
  const t = normalizarTexto(texto); if (t.length < 6 || !padron.porTexto || !padron.unicosTexto) return null;
  const exacto = padron.porTexto.get(t); if (exacto && exacto.size === 1) return [...exacto][0];
  const hits = new Set(padron.unicosTexto.filter(([k]) => (k.length >= 8 && t.includes(k)) || (t.length >= 8 && k.startsWith(t))).map(([, r]) => r));
  return hits.size === 1 ? [...hits][0] : null;
}

/** Sin acentos ni razón social ni signos: «Botanas y Derivados, S.A. de C.V.» → `BOTANASYDERIVADOS`. */
export function normalizarNombre(s: string | null | undefined): string {
  return String(s ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(S\.?\s*A\.?|DE|C\.?\s*V\.?|S\.?\s*DE\s*R\.?\s*L\.?|SAPI|SA|CV|RL|S|R|L)\b/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

export function limpiarRfc(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9&Ñ]/g, '');
}

/** Distancia de edición con corte: devuelve `tope + 1` en cuanto sabe que la pasa. */
export function distanciaEdicion(a: string, b: string, tope = 2): number {
  if (Math.abs(a.length - b.length) > tope) return tope + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let minFila = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < minFila) minFila = cur[j];
    }
    if (minFila > tope) return tope + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function resolverRfcAcreedor(
  crudo: string | null | undefined,
  nombre: string | null | undefined,
  padron: PadronEmisores,
): { rfc: string; via: ViaRfc } | null {
  const tal = String(crudo ?? '').trim().toUpperCase();
  if (tal && padron.rfcs.has(tal)) return { rfc: tal, via: 'tal_cual' };
  const limpio = limpiarRfc(tal);
  if (limpio && padron.rfcs.has(limpio)) return { rfc: limpio, via: 'sin_formato' };
  if (limpio.length >= 10) {
    let unico: string | null = null;
    for (const e of padron.rfcs) {
      if (distanciaEdicion(limpio, e) <= 2) {
        if (unico) { unico = null; break; }
        unico = e;
      }
    }
    // ⚠️ `break` con `unico = null` deja «dos candidatos» igual que «ninguno»: no se elige.
    if (unico) return { rfc: unico, via: 'parecido' };
  }
  const s = padron.porNombre.get(normalizarNombre(nombre));
  if (s && s.size === 1) return { rfc: [...s][0], via: 'por_nombre' };
  return null;
}
