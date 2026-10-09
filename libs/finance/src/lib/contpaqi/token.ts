import { createHash } from 'node:crypto';

/**
 * Fase CP `[CP.8.6]` — **El token de correlación del puente.**
 *
 * Es lo que permite reconocer, cuando el carril de vuelta trae una póliza de ContPAQi, cuál de
 * nuestros eventos la originó. Viaja dentro del `Concepto` del encabezado (100 caracteres, que
 * en las pólizas de compras van **vacíos en el 100%**), y el carril lo devuelve en
 * `analytics.gl_polizas.concepto` **cada minuto**.
 *
 * ⭐ **Es la pieza más sólida del puente porque no depende de ninguna duda de formato**: lo
 * decidimos nosotros enteros, y sobrevive aunque ContPAQi ignore el `guid` que mandamos.
 *
 * ── Por qué DETERMINISTA y no aleatorio ─────────────────────────────────────────────────────
 * El token sale de `(evento_tipo, evento_id)` por hash, así que el mismo evento produce siempre
 * el mismo token. Con uno aleatorio, re-emitir un evento crearía un token NUEVO y la entrega
 * anterior quedaría huérfana para siempre — parecería perdida cuando en realidad está asentada.
 * Determinista, re-emitir vuelve a casar con lo que ya está.
 *
 * Y de paso es reproducible a mano: dado un evento, se puede calcular qué buscar en ContPAQi sin
 * abrir la base.
 */

/** Buscable con `LIKE 'MD:%'`, que además permite indexarlo parcialmente el día que haga falta. */
export const PREFIJO = 'MD:';

/**
 * ⛔⛔ **12, y la primera versión decía 8 con un respaldo MAL RAZONADO.**
 *
 * El comentario original decía *"8 hex = 4,294,967,296 combinaciones; el universo es ~5k
 * eventos/año"*. Dos errores:
 *
 *  1. **El universo medido es 55,369**, no 5 mil — `finance.bank_movements` ya tiene eso cargado,
 *     y es sólo el arranque.
 *  2. ⭐ **Comparar el tamaño del espacio contra el volumen es el error clásico del cumpleaños.**
 *     Lo que importa no es si 55 mil entra en 4 mil millones (obvio que sí): es la probabilidad
 *     de que DOS de esos 55 mil caigan en el mismo valor, que va con `n²/2N`.
 *
 * Medido con la cota real:
 *
 * | hex | espacio | con n=55,369 | con n=553,690 (×10) |
 * |---|--:|--:|--:|
 * | 8 | 4.29e9 | **35.7 %** | ~100 % |
 * | 10 | 1.10e12 | 0.14 % | **13.9 %** |
 * | **12** | **2.81e14** | **0.0005 %** | **0.05 %** |
 *
 * Cuestan 2 caracteres cada 2 hex y el concepto tiene 100: no hay razón para arriesgar.
 */
export const LARGO_HEX = 12;

/** `MD:` + 12 hex = 15 caracteres. */
export const LARGO_TOKEN = PREFIJO.length + LARGO_HEX;

/**
 * El token de un evento. Determinista, estable entre corridas y entre máquinas.
 *
 * El separador `|` evita la ambigüedad de concatenar: sin él, `('a','bc')` y `('ab','c')` darían
 * el mismo hash, y son eventos distintos.
 */
export function tokenDe(eventoTipo: string, eventoId: string): string {
  const tipo = String(eventoTipo ?? '').trim();
  const id = String(eventoId ?? '').trim();
  if (!tipo || !id) {
    throw new Error('tokenDe: hacen falta evento_tipo y evento_id — un token sin identidad no correlaciona nada');
  }
  const hex = createHash('sha256').update(`${tipo}|${id}`, 'utf8').digest('hex');
  return PREFIJO + hex.slice(0, LARGO_HEX).toUpperCase();
}

/**
 * Saca el token de un concepto que volvió de ContPAQi. `null` cuando no hay — que **no es lo
 * mismo** que haber encontrado uno vacío, y por eso no devuelve `''`.
 *
 * Busca en cualquier posición y no sólo al principio: nosotros lo escribimos adelante, pero si
 * alguien edita el concepto en ContPAQi y lo empuja atrás, el token sigue siendo válido. Lo que
 * NO se admite es un token a medias.
 */
export function extraerToken(concepto: string | null | undefined): string | null {
  if (!concepto) return null;
  const m = new RegExp(`${PREFIJO}[0-9A-F]{${LARGO_HEX}}`).exec(String(concepto).toUpperCase());
  return m ? m[0] : null;
}

/**
 * Arma el concepto que se va a serializar: token adelante, descripción después.
 *
 * ⭐ **Se niega si no entra en `ancho`.** Recortar sería peor que fallar: un token cortado no
 * casa con nada, y el evento quedaría entregado y para siempre sin verificar — que en una tabla
 * se ve igual que uno que todavía no llega.
 *
 * ⚠️ La que se recorta, si hace falta, es la DESCRIPCIÓN — no el token. Es texto para que un
 * humano se ubique; perder su cola no rompe nada.
 */
export function conceptoConToken(token: string, descripcion: string, ancho = 100): string {
  if (!token) return String(descripcion ?? '').slice(0, ancho);
  if (token.length > ancho) {
    throw new Error(`conceptoConToken: el token "${token}" no entra en ${ancho} caracteres`);
  }
  const desc = String(descripcion ?? '').trim();
  const disponible = ancho - token.length - 1; // -1 por el espacio que los separa
  return desc ? `${token} ${desc.slice(0, Math.max(0, disponible))}`.trimEnd() : token;
}

/**
 * `[CP.8.24]` — **El `Guid` de la póliza, derivado del evento.**
 *
 * El archivo real de ContPAQi trae un `Guid` de 36 en cada encabezado (`[CP.8.13]` §10.3), y es
 * **el mejor candidato a llave de correlación del puente**: es estructural, no gasta los 100
 * caracteres del concepto y no depende de que nadie edite el texto.
 *
 * ⭐ Determinista por `(evento_tipo, evento_id)`, igual que `tokenDe` y por la misma razón: con
 * uno aleatorio, re-emitir el mismo evento dejaría huérfana la entrega anterior.
 *
 * ⚠️ **Sigue sin verificarse si ContPAQi RESPETA el guid que uno manda o genera el suyo.** Hasta
 * que se sepa, el token en el concepto es la llave y esto va de más — pero va, porque si no se
 * emite, la pregunta no se puede contestar nunca.
 *
 * Formato UUID v4 (variante y versión fijadas) para que su propio catálogo no lo rechace.
 */
export function guidDe(eventoTipo: string, eventoId: string): string {
  const h = createHash('sha256').update(`${eventoTipo}|${eventoId}`, 'utf8').digest('hex');
  const v = `4${h.slice(13, 16)}`;                              // versión 4
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);   // variante RFC 4122
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}
