/**
 * `[KBD.1]` Navegación de filas con el teclado — la guarda y el salto que PrimeNG no trae.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * LO QUE **NO** HAY QUE CONSTRUIR, Y SE MIDIÓ ANTES DE ESCRIBIR ESTO
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `pSelectableRow` de PrimeNG **ya navega**: `↑ ↓` mueven el foco entre filas, `Home`/`End` van
 * a los extremos, `Enter` y `Space` activan, y el `tabindex` ya es ROVING (la tabla entera es UN
 * solo stop de tabulador, que es lo que pide DESIGN D.4a). Escribir una directiva propia sería
 * la segunda implementación de algo que funciona.
 *
 * **Lo que falta es otra cosa, y son dos huecos concretos:**
 *
 * ── HUECO 1 · La guarda ⛔ (esto es un BUG VIVO, no una mejora) ──────────────────────────────
 *
 * `SelectableRow.onKeyDown` conmuta sobre `event.code` **sin mirar `event.target`** (verificado
 * en `primeng@22.0.0`, `primeng-table.mjs`). El listener vive en el `<tr>`, así que una tecla
 * apretada dentro de un `<input>` de ese renglón **burbujea hasta la fila** y PrimeNG la atiende
 * como si fuera suya — con `preventDefault()` incluido. Lo que se pierde, por tecla:
 *
 *   · `Space`      → `onSpaceKey` selecciona la fila y previene el default: **no se puede
 *                     escribir un espacio** en ese campo. Un nombre de proveedor queda sin
 *                     separar y nadie entiende por qué.
 *   · `Enter`      → `handleRowClick`: en vez de confirmar lo que escribiste, ABRE el detalle.
 *   · `Home`/`End` → saltan a la primera/última fila en vez de al principio/fin del texto.
 *   · `↑ ↓`        → mueven de fila. Y en una columna de captura esto choca de frente con
 *                     DESIGN D.5, donde `↑↓` YA significan "siguiente renglón": los dos
 *                     manejadores corren y el foco salta de a dos.
 *
 * **Medido hoy: 9 de los 13 archivos que usan `pSelectableRow` tienen controles en línea.** O sea
 * que el defecto ya está en producción; y encender la navegación en las otras 140 tablas lo
 * REPARTIRÍA en vez de sólo agregar teclado.
 *
 * ── HUECO 2 · El salto buscador → lista ─────────────────────────────────────────────────────
 *
 * Con el foco en el buscador, `↓` tiene que bajar al primer renglón; `Escape` tiene que volver.
 * Es el gesto que separa "tiene teclado" de "se siente rápido", y existía en **1** archivo de 153.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ UN LISTENER GLOBAL Y NO UNA DIRECTIVA
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Es la MISMA decisión, ya tomada y documentada, de `installNumberWheelGuard`: *"una directiva
 * hay que acordarse de importarla en cada componente standalone; el que la olvida no rompe nada,
 * simplemente vuelve a quedar expuesto, y eso es exactamente cómo se llegó a 29 de 30 sin
 * guarda."* Acá vale igual y de más: son 153 tablas y la lista crece cada semana.
 *
 * Y hay una razón extra, propia de este caso: la guarda tiene que correr **en fase de captura**,
 * ANTES de que el evento llegue al `<tr>`. Una directiva sobre la fila llegaría tarde — PrimeNG
 * ya habría hecho `preventDefault()`.
 */

/** Lo que PrimeNG estampa en cada fila navegable. Es SU contrato, no una clase nuestra. */
const SELECTOR_FILA = '[data-p-selectable-row="true"]';

/**
 * ¿El evento nació en algo donde el usuario está ESCRIBIENDO o eligiendo?
 *
 * ⚠️ No alcanza con `tagName === 'INPUT'`: un `<input type="checkbox">` sí quiere que `Space` lo
 * marque pero **no** le sirve `Home`/`End`, y los `contenteditable` no son `INPUT` de ningún tipo.
 * Se mira el rol real del elemento, no su etiqueta.
 */
function esControlDeEscritura(el: Element | null): boolean {
  if (!el) return false;
  const t = el.tagName;
  if (t === 'TEXTAREA' || t === 'SELECT') return true;
  if (t === 'INPUT') {
    const tipo = (el as HTMLInputElement).type;
    // Los de PULSAR (checkbox/radio/button) no capturan texto: ahí el teclado de la fila sí sirve.
    return tipo !== 'checkbox' && tipo !== 'radio' && tipo !== 'button'
      && tipo !== 'submit' && tipo !== 'reset';
  }
  if ((el as HTMLElement).isContentEditable) return true;
  // PrimeNG monta sus combos sobre un div con rol: ahí las flechas abren y recorren SU lista.
  const rol = el.getAttribute('role');
  return rol === 'combobox' || rol === 'textbox' || rol === 'searchbox' || rol === 'spinbutton';
}

/** Teclas que `SelectableRow` se queda. Fuera de esta lista no hay nada que proteger. */
const TECLAS_QUE_ROBA = new Set([
  'ArrowDown', 'ArrowUp', 'Home', 'End', 'Space', 'Enter',
]);

/**
 * Instala la guarda. Una sola vez por app, en `main.ts`, igual que la guarda de la rueda.
 *
 * **Qué hace exactamente:** si la tecla nació en un control de escritura que vive DENTRO de una
 * fila navegable, se detiene la propagación para que el `<tr>` no la vea. No se llama
 * `preventDefault()`: la tecla tiene que seguir haciendo lo suyo en el campo (escribir el
 * espacio, mover el cursor, enviar el formulario).
 *
 * ⚠️ **`stopPropagation` y NO `stopImmediatePropagation`**: otros listeners del MISMO elemento
 * —el `(keydown)` que la pantalla puso en su propio input, por ejemplo el de D.5 que mueve de
 * renglón— tienen que seguir corriendo. Lo único que se corta es el viaje hacia arriba.
 *
 * @param doc documento a proteger. Se inyecta para poder probarlo.
 * @returns función para desinstalar (la usan los tests).
 */
export function installRowNavGuard(doc: Document): () => void {
  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (!TECLAS_QUE_ROBA.has(e.key) && !TECLAS_QUE_ROBA.has(e.code)) return;
    const origen = e.target as Element | null;
    if (!esControlDeEscritura(origen)) return;
    // Sólo si de verdad hay una fila navegable arriba: fuera de una tabla no hay nada que cortar.
    if (!origen!.closest(SELECTOR_FILA)) return;
    e.stopPropagation();
  };

  doc.addEventListener('keydown', onKeyDown, { capture: true });
  return () => doc.removeEventListener('keydown', onKeyDown, { capture: true });
}

/**
 * `[KBD.1]` El salto del buscador a la lista.
 *
 * Se llama desde el `(keydown.arrowdown)` del input de búsqueda. Mueve el foco al primer renglón
 * navegable que haya dentro de `alcance` (o del documento, si no se acota).
 *
 * ⚠️ **Acotá el alcance cuando la pantalla tiene dos tablas.** Sin `alcance`, "la primera fila"
 * es la primera del DOCUMENTO, que puede ser la del panel de detalle y no la de la lista que el
 * buscador filtra. Pasar el contenedor de la tabla es una línea y evita un salto absurdo.
 *
 * @returns `true` si encontró a dónde ir. `false` si la lista está vacía — y ahí **el foco se
 *          queda donde está a propósito**: mandar el foco a la nada deja al usuario sin
 *          referencia y sin forma de volver sin el mouse.
 */
export function bajarAlPrimerRenglon(alcance?: Element | Document | null): boolean {
  const raiz = alcance ?? (typeof document !== 'undefined' ? document : null);
  if (!raiz) return false;
  const fila = raiz.querySelector(SELECTOR_FILA) as HTMLElement | null;
  if (!fila) return false;
  fila.focus();
  return true;
}

/**
 * `[KBD.1]` La vuelta: `Escape` desde la lista devuelve el foco al buscador.
 *
 * Es la mitad que casi siempre falta. Sin ella el teclado es de ida: bajás a la lista y para
 * corregir el texto hay que ir al mouse, que es justo lo que se estaba evitando.
 *
 * @returns `true` si devolvió el foco.
 */
export function volverAlBuscador(buscador: HTMLElement | null | undefined): boolean {
  if (!buscador) return false;
  buscador.focus();
  // Al volver, el texto queda seleccionado: teclear lo reemplaza, que es lo que uno quiere
  // después de mirar los resultados y decidir que la búsqueda no era ésa.
  if (typeof (buscador as HTMLInputElement).select === 'function') {
    (buscador as HTMLInputElement).select();
  }
  return true;
}
