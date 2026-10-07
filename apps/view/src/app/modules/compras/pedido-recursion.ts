/**
 * `[RA-PERF.6]` **El testigo del "Maximum call stack" de `/compras/pedido`, despierto.**
 *
 * ── Qué estaba mal, y por qué nadie lo vio en 69 días ───────────────────────────────────────
 * El commit `c684fc36d` (2026-07-30) dejó un guard en `money()` que decía *"quitar cuando se
 * identifique la causa"*. La causa nunca se identificó, y **no podía**: el guard hacía
 *
 *     const depth = (new Error().stack || '').split('\n').length;
 *     if (depth > 300) { ...log...; throw ...; }
 *
 * y `Error.stackTraceLimit` vale **10** por default en V8 — y no se sube en ningún lado del repo
 * (verificado con grep sobre `apps/` y `libs/`). Medido el 2026-10-07 con 500 marcos REALES
 * anidados, esa expresión devuelve **11**. `depth > 300` no podía ser verdad nunca: el guard no
 * logueaba, no cortaba, y de paso pagaba un `queueMicrotask` por tick para siempre.
 *
 * ⭐ La lección, que es la de ADR-056 aplicada a un instrumento y no a un dato: **un guard sin
 * prueba negativa es una intención.** Éste nunca se rompió a propósito ni una vez; si se hubiera
 * forzado una recursión de 500 marcos en una prueba, habría salido 11 el primer día.
 *
 * ── Qué mide ahora ──────────────────────────────────────────────────────────────────────────
 * Dos señales, no una:
 *
 *   1. `marcos` — la profundidad REAL del stack (subiendo el límite antes de capturar). Sirve,
 *      pero depende de un umbral que nadie ha medido en esta pantalla.
 *   2. `vueltas` — **cuántas veces aparece `money` en su PROPIO stack**. Ésta es la señal sin
 *      umbral: tres vueltas no son volumen, son re-entrada. Es la que de verdad separa
 *      "expandir todo llama a money 900 veces" (stack corto, 1 vuelta) de "el render se llama a
 *      sí mismo" (stack hondo, N vueltas), que es justo la distinción que el guard viejo decía
 *      estar haciendo y no hacía.
 *
 * ⚠️ `vueltas` sobrevive a la minificación porque Angular compila el template a `ctx.money(...)`
 * y la CLI **no manglea nombres de propiedad**; el marco queda como `… .money (…)`. Si algún día
 * se activa el mangling de propiedades, esta señal se apaga en silencio — y por eso `marcos`
 * sigue existiendo al lado, para no quedarse sin ninguna.
 */

/** Marcos a partir de los cuales un stack ya no se explica por render anidado normal. */
export const MARCOS_RECURSION = 300;
/** Apariciones de `money` en su propio stack que ya no se explican por composición. */
export const VUELTAS_RECURSION = 3;
/** Cuántos marcos pedirle a V8 al capturar. Suficiente para pasar el umbral con margen. */
export const LIMITE_CAPTURA = 400;

export interface VeredictoStack {
  marcos: number;
  vueltas: number;
  recursion: boolean;
  /** Los primeros marcos, ya limpios: el diagnóstico que faltaba (quién llama a quién). */
  cima: string;
}

/**
 * Captura el stack actual **con la profundidad real**, y deja `Error.stackTraceLimit` como estaba.
 *
 * `Error.stackTraceLimit` es de V8. En un motor que no lo tenga, la asignación no hace nada y
 * `stack` ya viene con lo que ese motor dé — por eso no se asume ni se exige.
 */
export function capturarStack(): string {
  const previo = (Error as { stackTraceLimit?: number }).stackTraceLimit;
  try { (Error as { stackTraceLimit?: number }).stackTraceLimit = LIMITE_CAPTURA; } catch { /* motor sin V8 */ }
  const stack = new Error().stack || '';
  try { (Error as { stackTraceLimit?: number }).stackTraceLimit = previo; } catch { /* idem */ }
  return stack;
}

/**
 * El punto delante evita contar un nombre de archivo o de variable; el límite de palabra del
 * final impide que `moneyCorto` cuente como una vuelta de `money`.
 *
 * ⚠️ **Literal a propósito, nunca `new RegExp('...' + x + '...')`.** Construirla por concatenación
 * obliga a escribir las barras escapadas, y basta perder un nivel para que `\b` deje de ser un
 * límite de palabra y pase a ser el carácter de retroceso (U+0008): la regex sigue compilando, no
 * avisa nada, y la señal se apaga **en silencio**. Pasó al escribir este mismo archivo, y lo
 * agarró el candado de abajo — que es justamente lo que al guard viejo le faltaba.
 */
const RE_VUELTA = /\.money\b/g;

/** Lee un stack ya capturado y dice si lo que se ve es recursión o sólo volumen. */
export function analizarStack(stack: string): VeredictoStack {
  const lineas = stack.split('\n');
  const marcos = lineas.length;
  // `String.match` con una regex global reinicia `lastIndex`, así que reusar la constante es seguro.
  const vueltas = (stack.match(RE_VUELTA) || []).length;
  return {
    marcos,
    vueltas,
    recursion: vueltas >= VUELTAS_RECURSION || marcos > MARCOS_RECURSION,
    cima: lineas.slice(1, 12).map((l) => l.trim()).join(' | ').slice(0, 900),
  };
}
