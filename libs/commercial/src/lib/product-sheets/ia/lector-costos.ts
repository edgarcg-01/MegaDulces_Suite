/**
 * `[NP.7.L.11d]` Cuánto costó UNA llamada, desde el `usage` que devuelve la API (no estimado). Función pura.
 *
 * El costo por ficha del piloto (primeras 100 fichas, proyectado × 6,500 y presentado a Edgar antes de abrir
 * otra sucursal) se SUMA de estos renglones guardados por llamada; por eso cada uno dice de qué tabla salió
 * su precio (`precio_fuente`). ⛔ Modelo sin precio en la tabla → `costo_usd: null`, nunca 0 (regla 11):
 * un cero se sumaría como «gratis». Igual si la respuesta no trae `usage`: el costo queda NO MEDIDO.
 *
 * Los tokens de razonamiento (thinking) ya vienen dentro de `output_tokens`: no se suman aparte.
 */
import type { UsoLlamada } from './lectura-foto.contract';

/** Fecha de la tabla de precios: si Anthropic los cambia, se actualiza la tabla Y esta fecha. */
export const PRECIOS_AL = '2026-10-06';
const FUENTE = `precios públicos de Anthropic, tabla al ${PRECIOS_AL}`;

/** Escritura de caché (TTL de 5 min, el `ephemeral` por defecto que usa `cachePrefix`) = 1.25 × entrada. */
const FACTOR_ESCRITURA_CACHE = 1.25;
/** Lectura de caché cuando la tabla no trae un precio explícito para el modelo = 0.1 × entrada. */
const FACTOR_LECTURA_CACHE = 0.1;

interface Tarifa {
  entrada: number;
  salida: number;
}

/** USD por 1M de tokens. `lecturaCache: null` = sin precio explícito en la tabla (se usa 0.1 × entrada). */
interface PrecioModelo extends Tarifa {
  lecturaCache: number | null;
  /** Tramo de prompt largo: arriba de `desde` tokens de prompt cambian entrada y salida. */
  largo?: Tarifa & { desde: number };
}

const PRECIOS: Record<string, PrecioModelo> = {
  'claude-opus-5-5': { entrada: 4, salida: 20, lecturaCache: 0.2 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, lecturaCache: 0.2 },
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5, lecturaCache: null, largo: { desde: 100_000, entrada: 0.5, salida: 2.5 } },
  'claude-haiku-4-5': { entrada: 1, salida: 5, lecturaCache: null },
};

/** El precio del modelo: id exacto o el mismo id con sufijo de fecha («claude-haiku-4-5-20251001»). */
function precioDe(modelo: string): { id: string; precio: PrecioModelo } | null {
  if (PRECIOS[modelo]) return { id: modelo, precio: PRECIOS[modelo] };
  const sinFecha = modelo.replace(/-\d{8}$/, '');
  return sinFecha !== modelo && PRECIOS[sinFecha] ? { id: sinFecha, precio: PRECIOS[sinFecha] } : null;
}

const tokens = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function costoDeLlamada(modelo: string, usage: unknown): UsoLlamada {
  const u = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const entrada = tokens(u['input_tokens']);
  const salida = tokens(u['output_tokens']);
  // La API manda los de caché en 0 o null cuando no hubo caché: ahí sí, ausente = 0.
  const lecturaCache = tokens(u['cache_read_input_tokens']) ?? 0;
  const escrituraCache = tokens(u['cache_creation_input_tokens']) ?? 0;

  const base: Omit<UsoLlamada, 'costo_usd' | 'precio_fuente'> = {
    modelo,
    input_tokens: entrada ?? 0,
    output_tokens: salida ?? 0,
    cache_read_input_tokens: lecturaCache,
    cache_creation_input_tokens: escrituraCache,
  };
  if (entrada === null || salida === null) {
    return { ...base, costo_usd: null, precio_fuente: 'la respuesta no trae usage completo: costo NO MEDIDO' };
  }
  const encontrado = precioDe(modelo);
  if (encontrado === null) return { ...base, costo_usd: null, precio_fuente: null };

  const { id, precio } = encontrado;
  const notas: string[] = [];
  const prompt = entrada + lecturaCache + escrituraCache;
  let tarifa: Tarifa = precio;
  if (precio.largo && prompt > precio.largo.desde) {
    tarifa = precio.largo;
    notas.push(`tramo de prompt > ${precio.largo.desde.toLocaleString('en-US')} tokens`);
  }
  let precioLectura = precio.lecturaCache;
  if (precioLectura === null || tarifa !== precio) {
    precioLectura = tarifa.entrada * FACTOR_LECTURA_CACHE;
    notas.push(`lectura de caché = ${FACTOR_LECTURA_CACHE} × entrada (sin precio explícito en la tabla)`);
  }
  notas.push(`escritura de caché = ${FACTOR_ESCRITURA_CACHE} × entrada (TTL 5 min)`);

  const usd =
    (entrada * tarifa.entrada +
      escrituraCache * tarifa.entrada * FACTOR_ESCRITURA_CACHE +
      lecturaCache * precioLectura +
      salida * tarifa.salida) /
    1_000_000;
  return {
    ...base,
    // 8 decimales (centésimas de microdólar): suficiente para sumar 6,500 fichas sin ruido de coma flotante.
    costo_usd: Math.round(usd * 1e8) / 1e8,
    precio_fuente: `${FUENTE}; ${id}: ${notas.join('; ')}`,
  };
}
