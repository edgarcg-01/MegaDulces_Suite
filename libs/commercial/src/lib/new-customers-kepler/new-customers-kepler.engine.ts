/**
 * `[MCP.3.8]` Reglas puras del alta de cliente nuevo y su liga con Kepler. Sin base de datos:
 * el servicio junta los hechos y aquí se decide. Así cada regla tiene su prueba y su mutación.
 */

/** Palabras que casi todos los negocios llevan y no distinguen a uno de otro. */
const GENERICAS = new Set([
  'abarrotes', 'abarrote', 'tienda', 'tiendita', 'miscelanea', 'minisuper', 'mini', 'super',
  'deposito', 'cremeria', 'dulceria', 'la', 'el', 'los', 'las', 'de', 'del', 'y', 'sa', 'cv', 'rl', 'sc',
]);

/** Minúsculas, sin acentos ni signos, espacios simples. */
export function normalizarNombre(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Las palabras que sí distinguen al negocio (sin genéricas ni palabras de 1 letra). */
export function tokensSignificativos(s: string | null | undefined): string[] {
  return normalizarNombre(s)
    .split(' ')
    .filter((t) => t.length >= 2 && !GENERICAS.has(t));
}

function bigramas(s: string): string[] {
  const x = s.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2));
  return out;
}

/** Coeficiente de Dice sobre bigramas: 1 = iguales, 0 = nada en común. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigramas(a);
  const B = bigramas(b);
  if (!A.length || !B.length) return 0;
  const cuenta = new Map<string, number>();
  for (const g of A) cuenta.set(g, (cuenta.get(g) ?? 0) + 1);
  let comunes = 0;
  for (const g of B) {
    const n = cuenta.get(g) ?? 0;
    if (n > 0) {
      comunes++;
      cuenta.set(g, n - 1);
    }
  }
  return (2 * comunes) / (A.length + B.length);
}

/**
 * Qué tanto se parecen dos nombres de negocio (0–1). Compara lo que distingue —«Abarrotes
 * Lupita» y «Tienda Lupita» son el mismo— y tolera faltas («Esquina» / «Esquinita»).
 */
export function parecido(a: string, b: string): number {
  const ta = tokensSignificativos(a);
  const tb = tokensSignificativos(b);
  // Sin palabras que distingan (p. ej. sólo «Abarrotes»): se compara el nombre entero.
  if (!ta.length || !tb.length) return dice(normalizarNombre(a), normalizarNombre(b));
  const porTexto = dice(ta.join(' '), tb.join(' '));
  // Palabras en común sobre el nombre más corto: «Lupita» dentro de «Abarrotes Lupita Centro».
  const sb = new Set(tb);
  const comunes = ta.filter((t) => sb.has(t) || tb.some((u) => t.length >= 5 && u.length >= 5 && dice(t, u) >= 0.8)).length;
  const porPalabras = comunes / Math.min(ta.length, tb.length);
  return Math.max(porTexto, porPalabras);
}

export const UMBRAL_PARECIDO = 0.7;

/** Los candidatos que se parecen al nombre, del más al menos parecido, a lo más `max`. */
export function buscarParecidos<T extends { name: string }>(
  nombre: string,
  candidatos: T[],
  max = 5,
  umbral = UMBRAL_PARECIDO,
): Array<T & { score: number }> {
  if (!normalizarNombre(nombre)) return [];
  return candidatos
    .map((c) => ({ ...c, score: Math.round(parecido(nombre, c.name) * 100) / 100 }))
    .filter((c) => c.score >= umbral)
    .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, 'es'))
    .slice(0, max);
}

/**
 * La clave de Kepler como se escribe en Kepler: sin espacios alrededor y en mayúsculas. NO se
 * rellenan ceros ni se adivina: «2» y «00002» son claves distintas en el ERP.
 */
export function normalizarClave(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(s) ? s : null;
}

/** El código legible del cliente ligado, igual al que pone la sincronización de rutas Kepler. */
export function codigoKepler(branch: string, clave: string): string {
  return `K${branch}-${clave}`;
}

/** Domicilio legible: el estructurado si lo hay; si no, la referencia que capturó el vendedor. */
export function domicilioLegible(addr: unknown, notes: string | null | undefined): string | null {
  const a = (addr && typeof addr === 'object' ? addr : null) as Record<string, unknown> | null;
  if (a) {
    const calle = [a['street'], a['exterior_number']].filter(Boolean).join(' ');
    const txt = [calle, a['neighborhood'], a['city']].filter(Boolean).join(', ');
    if (txt.trim()) return txt.trim();
  }
  const n = String(notes ?? '').trim();
  return n || null;
}

/** Los hechos que el servicio junta antes de ligar. */
export interface HechosLiga {
  cliente: { id: string; name: string; erp_customer_code: string | null; erp_source_branch: string | null } | null;
  /** Sucursal Kepler del cliente (por su ruta o sus pedidos). null = no se sabe. */
  branch: string | null;
  /** ¿La sucursal del cliente está en el alcance de quien liga? */
  enAlcance: boolean;
  clave: string | null;
  kepler: { nombre: string | null; es_interno: boolean } | null;
  /** Otro cliente de la Suite que ya tiene esa clave en esa sucursal. */
  yaLigadoA: { id: string; name: string } | null;
}

export type DecisionLiga =
  | { ok: true }
  | {
      ok: false;
      motivo:
        | 'no_encontrado'
        | 'fuera_de_alcance'
        | 'ya_ligado'
        | 'sin_sucursal'
        | 'clave_invalida'
        | 'clave_inexistente'
        | 'cuenta_interna'
        | 'duplicado';
      mensaje: string;
    };

/**
 * ¿Se puede ligar este cliente con esta clave? El orden importa: primero lo que no depende de la
 * clave (existe, es de tu sucursal, no está ligado), después la clave.
 */
export function decidirLiga(h: HechosLiga): DecisionLiga {
  // Un cliente de otra sucursal se reporta igual que uno que no existe: no se revela qué hay fuera.
  if (!h.cliente || !h.enAlcance) {
    return h.cliente
      ? { ok: false, motivo: 'fuera_de_alcance', mensaje: 'Ese cliente no es de tu sucursal.' }
      : { ok: false, motivo: 'no_encontrado', mensaje: 'No se encontró el cliente.' };
  }
  if (h.cliente.erp_customer_code) {
    return {
      ok: false,
      motivo: 'ya_ligado',
      mensaje: `Este cliente ya está ligado a la clave ${h.cliente.erp_customer_code} de Kepler.`,
    };
  }
  if (!h.branch) {
    return {
      ok: false,
      motivo: 'sin_sucursal',
      mensaje: 'No se sabe de qué sucursal es este cliente (su ruta no tiene sucursal y no tiene pedidos).',
    };
  }
  if (!h.clave) {
    return { ok: false, motivo: 'clave_invalida', mensaje: 'Escribe la clave como aparece en Kepler (letras y números).' };
  }
  if (!h.kepler) {
    return {
      ok: false,
      motivo: 'clave_inexistente',
      mensaje: `La clave ${h.clave} no existe en Kepler de la sucursal ${h.branch}.`,
    };
  }
  if (h.kepler.es_interno) {
    return {
      ok: false,
      motivo: 'cuenta_interna',
      mensaje: `La clave ${h.clave} es una cuenta interna de Kepler (tienda o vendedor), no un cliente.`,
    };
  }
  if (h.yaLigadoA && h.yaLigadoA.id !== h.cliente.id) {
    return {
      ok: false,
      motivo: 'duplicado',
      mensaje: `La clave ${h.clave} ya está ligada a otro cliente: ${h.yaLigadoA.name}. Puede ser un cliente duplicado.`,
    };
  }
  return { ok: true };
}
