/**
 * Guarda de rueda para `input[type=number]`.
 *
 * ── El problema ─────────────────────────────────────────────────────────────────────────────
 * Un `input type=number` ENFOCADO cambia su valor cuando la rueda del mouse pasa por encima.
 * Es el comportamiento por default del navegador y en una app de operaciones es un riesgo de
 * DATO, no una molestia de UX: scrolleás una tabla para mirar otro renglón y de paso alteraste
 * una cantidad —sin tocar el teclado, sin confirmar nada y sin que la pantalla lo avise—.
 *
 * Medido en este repo (2026-09-14): 65 `input[type=number]` en 30 archivos de las 3 apps; UNO
 * solo tenía guarda. El peor caso es `almacen-recepcion-sesion.component.ts`, que además
 * COMMITEA en `(blur)`: ahí la rueda cambiaba la cantidad recibida de un vale y el blur la
 * guardaba, alimentando la conciliación de entradas y cuentas por pagar con un número que nadie
 * tecleó.
 *
 * ── Por qué soltar el foco y no `preventDefault()` ──────────────────────────────────────────
 * `preventDefault()` sobre el `wheel` sí corta el incremento, pero también TRABA EL SCROLL de la
 * página: el usuario deja de poder recorrer la tabla justo cuando está capturando. Al soltar el
 * foco, en cambio, el incremento no ocurre (el navegador sólo lo aplica sobre el input enfocado),
 * el valor queda intacto y la página scrollea normal. Por eso el listener es `passive`.
 *
 * ── Efecto declarado ────────────────────────────────────────────────────────────────────────
 * Soltar el foco DISPARA el `blur` del elemento. En la pantalla que commitea en blur, eso escribe
 * el valor —el mismo que ya estaba, porque el incremento nunca ocurrió—: una escritura idempotente
 * de más por cada scroll accidental. Es estrictamente mejor que hoy, que escribe el valor
 * EQUIVOCADO, pero se declara acá en vez de disimularlo.
 *
 * ── Por qué global y no una directiva ───────────────────────────────────────────────────────
 * Una directiva hay que acordarse de importarla en cada componente standalone: el que la olvida
 * no rompe nada, simplemente vuelve a quedar expuesto, y eso es exactamente cómo se llegó a 29 de
 * 30 sin guarda. Un solo listener en fase de captura cubre lo que existe hoy y lo que se escriba
 * mañana. Ver DESIGN.md regla D.5.
 *
 * @param doc documento a proteger. Se inyecta para poder probarlo.
 * @returns función para desinstalar la guarda (la usan los tests).
 */
export function installNumberWheelGuard(doc: Document): () => void {
  const onWheel = (ev: Event): void => {
    const el = ev.target as HTMLInputElement | null;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
    // Sin foco el navegador no incrementa: no hay nada que evitar y no se toca el foco de nadie.
    if (doc.activeElement !== el) return;
    el.blur();
  };

  // `capture: true` para verlo aunque un componente detenga la propagación en el camino.
  // `passive: true` declara que nunca se llama `preventDefault()` — es lo que deja el scroll intacto.
  doc.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return () => doc.removeEventListener('wheel', onWheel, { capture: true });
}
