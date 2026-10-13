/**
 * `[CG.98]` — El teclado de una BARRA DE ACCIONES, para todas de una vez.
 *
 * ── Por qué no alcanzaba `installRadioGroupNav` ──────────────────────────────────────────
 * Su hermano resuelve los selectores de UNA opción, y ahí el patrón ARIA manda que **la
 * selección siga al foco**: moverse con la flecha ya elige. Por eso termina en `.click()`.
 *
 * Una barra de acciones es lo contrario. Los chips de «lo que más repetís» de Caja General
 * **llenan cuenta, concepto, glosa y beneficiario** en cuanto se activan: si el foco disparara,
 * recorrer diez chips con la flecha pisaría la captura diez veces, y la décima quedaría como si
 * la persona la hubiera elegido. Acá la flecha **sólo mueve**; activa `Enter` o `Espacio`, que
 * es lo que un `<button>` ya hace solo.
 *
 * Darles `role="radio"` para reusar el hermano tampoco servía: un lector de pantalla anunciaría
 * *«no seleccionado»* sobre un botón que no es una elección, y eso es decir una mentira distinta
 * de la que D.4(c) vino a arreglar.
 *
 * ── Qué aporta ───────────────────────────────────────────────────────────────────────────
 * **Roving tabindex**: la barra se alcanza con UN tabulador y se recorre con flechas. Sin esto,
 * diez chips son diez paradas del tabulador antes del siguiente campo — que es exactamente lo
 * que D.4(a) prohíbe y lo que vuelve inservible un atajo pensado para no usar el mouse.
 *
 * ── Por qué un listener global y no una directiva ────────────────────────────────────────
 * La misma decisión y el mismo motivo que `installRowNavGuard` y `installRadioGroupNav`: una
 * directiva hay que acordarse de importarla, **el que la olvida no rompe nada —simplemente
 * vuelve a quedar sin teclado—** y así se llegó a 35 de 37 grupos sin roving.
 *
 * ⚠️ **Divergencia deliberada con el hermano.** Él detecta «se administra solo» mirando si
 * alguna opción trae `tabindex` escrito. Acá no sirve: los botones los pinta PrimeNG y lo que
 * emita en ese atributo no está bajo nuestro control, así que esa heurística podría apagar el
 * roving **en silencio** y dejar un primitivo que se ve instalado y no hace nada. La salida es
 * explícita: `data-nav="manual"` en la barra.
 */

const BARRA = '[role="toolbar"]';
const ACCION = 'button';

/** Teclas que mueven dentro de una toolbar, según el patrón ARIA. */
const SIGUIENTE = new Set(['ArrowRight', 'ArrowDown']);
const ANTERIOR = new Set(['ArrowLeft', 'ArrowUp']);

function accionesDe(barra: Element): HTMLElement[] {
  return Array.from(barra.querySelectorAll<HTMLElement>(ACCION)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  );
}

function seAdministraSola(barra: Element): boolean {
  return barra.getAttribute('data-nav') === 'manual';
}

/**
 * El ancla es la primera acción, no «la elegida»: en una barra no hay elegida. Sólo escribe si
 * cambió, para no pelear con el ciclo de render de Angular en cada mutación del DOM.
 */
function fijarRoving(barra: Element): void {
  const acciones = accionesDe(barra);
  if (!acciones.length) return;
  const yaTieneAncla = acciones.some((el) => el.tabIndex === 0);
  const ancla = yaTieneAncla ? acciones.find((el) => el.tabIndex === 0)! : acciones[0];
  for (const el of acciones) {
    const quiere = el === ancla ? 0 : -1;
    if (el.tabIndex !== quiere) el.tabIndex = quiere;
  }
}

export function installToolbarNav(doc: Document): () => void {
  const repasar = (): void => {
    for (const b of Array.from(doc.querySelectorAll(BARRA))) {
      if (seAdministraSola(b)) continue;
      fijarRoving(b);
    }
  };

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const esMover = SIGUIENTE.has(e.key) || ANTERIOR.has(e.key);
    const esHome = e.key === 'Home';
    const esEnd = e.key === 'End';
    if (!esMover && !esHome && !esEnd) return;

    const accion = (e.target as Element | null)?.closest<HTMLElement>(ACCION);
    if (!accion) return;
    const barra = accion.closest(BARRA);
    if (!barra || seAdministraSola(barra)) return;

    const acciones = accionesDe(barra);
    const i = acciones.indexOf(accion);
    if (i < 0) return;

    // No da la vuelta en los extremos, igual que D.5 y que el hermano: dar la vuelta desorienta.
    let destino = i;
    if (esHome) destino = 0;
    else if (esEnd) destino = acciones.length - 1;
    else if (SIGUIENTE.has(e.key)) destino = Math.min(i + 1, acciones.length - 1);
    else destino = Math.max(i - 1, 0);
    if (destino === i) { e.preventDefault(); return; }

    e.preventDefault();
    const siguiente = acciones[destino];
    for (const el of acciones) el.tabIndex = el === siguiente ? 0 : -1;
    siguiente.focus();
    // ⛔ Y acá NO va un `.click()`. Es la única línea que separa este archivo de su hermano, y
    // es la razón por la que existe: activar al mover llenaría el formulario en cada flecha.
  };

  let mo: MutationObserver | null = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(() => repasar());
    mo.observe(doc.documentElement, { childList: true, subtree: true });
  }
  repasar();
  doc.addEventListener('keydown', onKeyDown, { capture: true });

  return () => {
    doc.removeEventListener('keydown', onKeyDown, { capture: true });
    mo?.disconnect();
  };
}
