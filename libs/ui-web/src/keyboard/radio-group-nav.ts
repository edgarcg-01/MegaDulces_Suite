/**
 * `[TAB.3]` — El teclado de los selectores de una sola opción, para todos de una vez.
 *
 * ── Qué encontró la revisión (2026-10-05) ───────────────────────────────────────────────────
 * Al volver el segmentado iOS el default de `PageTabs`, apareció que **37 archivos declaraban
 * `role="tablist"` + `role="tab"` sin NINGÚN `role="tabpanel"`** — la regla D.4(c) de
 * `DESIGN.md`, incumplida en todo el repo. Revisados uno por uno (ésa fue la indicación), el
 * veredicto es que **no son pestañas**: son selectores de una opción entre varias. Lo dicen sus
 * propias etiquetas — *"Filtrar por estado"*, *"Vistas de caja"*, *"Qué historial"*, *"Etapa del
 * gasto"*, *"Rango"*, *"Día de entrega"*. Y la regla ya prescribía el arreglo: *"Si no hay panel,
 * no son tabs — es un radiogroup"*.
 *
 * ⛔ **Pero cambiar sólo el rol los dejaba rotos de otra forma.** `35 de 37 no tenían roving
 * tabindex`: con `role="radio"` y sin él, el tabulador para en CADA opción —lo que D.4(a)
 * prohíbe— y las flechas no hacen nada, que es lo que un lector de pantalla anuncia que sí
 * funciona. Se pasa de una mentira a otra.
 *
 * ── Por qué un listener global y no una directiva ───────────────────────────────────────────
 * Es la misma decisión, con el mismo motivo, que `installRowNavGuard` y `installNumberWheelGuard`:
 * una directiva hay que acordarse de importarla en cada componente standalone, **el que la olvida
 * no rompe nada —simplemente vuelve a quedar sin teclado— y así es como se llegó a 35 de 37**.
 * Un listener cubre lo que existe hoy y lo que se escriba mañana.
 *
 * ── Qué NO toca, y es la parte que evita pelear ─────────────────────────────────────────────
 * **Un grupo cuyos ítems ya declaran `tabindex` se deja en paz.** Son los que ya manejan su foco
 * (`app-segmented`, `anden-segmented`, `doc-viewer`): si esto también escribiera `tabindex`,
 * Angular lo repintaría en cada render y los dos se estarían pisando. El criterio es detectable
 * y no depende de una lista de excepciones que se desactualice.
 *
 * ⚠️ Tampoco decide cuál está seleccionado: eso lo sabe el componente. Esto sólo mueve el FOCO y
 * dispara un clic, que es lo que el componente ya escucha.
 */

/** El grupo y sus opciones, en el orden del DOM. */
const GRUPO = '[role="radiogroup"]';
const OPCION = '[role="radio"]';

/** Teclas que mueven dentro de un radiogroup, según el patrón ARIA. */
const SIGUIENTE = new Set(['ArrowRight', 'ArrowDown']);
const ANTERIOR = new Set(['ArrowLeft', 'ArrowUp']);

function opcionesDe(grupo: Element): HTMLElement[] {
  return Array.from(grupo.querySelectorAll<HTMLElement>(OPCION)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  );
}

/** `true` si el grupo ya administra su propio foco: entonces no se toca. */
function seAdministraSolo(grupo: Element): boolean {
  return Array.from(grupo.querySelectorAll(OPCION)).some((el) => el.hasAttribute('tabindex'));
}

/**
 * Deja UN solo tab stop por grupo: la opción marcada, o la primera si ninguna lo está.
 * Es lo que convierte N paradas de tabulador en una (D.4a).
 */
function fijarRoving(grupo: Element): void {
  const ops = opcionesDe(grupo);
  if (!ops.length) return;
  const marcada = ops.find((el) => el.getAttribute('aria-checked') === 'true');
  const ancla = marcada ?? ops[0];
  for (const el of ops) el.tabIndex = el === ancla ? 0 : -1;
}

/**
 * Instala el teclado de radiogroup en todo el documento.
 *
 * @param doc documento a cubrir. Se inyecta para poder probarlo.
 * @returns función para desinstalar (la usan los tests).
 */
export function installRadioGroupNav(doc: Document): () => void {
  /** Pone el roving en los grupos que todavía no lo tienen. Barato: sólo escribe si cambió. */
  const repasar = (): void => {
    for (const g of Array.from(doc.querySelectorAll(GRUPO))) {
      if (seAdministraSolo(g)) continue;
      fijarRoving(g);
    }
  };

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const esMover = SIGUIENTE.has(e.key) || ANTERIOR.has(e.key);
    const esHome = e.key === 'Home';
    const esEnd = e.key === 'End';
    if (!esMover && !esHome && !esEnd) return;

    const opcion = (e.target as Element | null)?.closest<HTMLElement>(OPCION);
    if (!opcion) return;
    const grupo = opcion.closest(GRUPO);
    if (!grupo || seAdministraSolo(grupo)) return;

    const ops = opcionesDe(grupo);
    const i = ops.indexOf(opcion);
    if (i < 0) return;

    // No da la vuelta en los extremos, igual que D.5: dar la vuelta desorienta.
    let destino = i;
    if (esHome) destino = 0;
    else if (esEnd) destino = ops.length - 1;
    else if (SIGUIENTE.has(e.key)) destino = Math.min(i + 1, ops.length - 1);
    else destino = Math.max(i - 1, 0);
    if (destino === i) { e.preventDefault(); return; }

    e.preventDefault();
    const siguiente = ops[destino];
    for (const el of ops) el.tabIndex = el === siguiente ? 0 : -1;
    siguiente.focus();
    // En un radiogroup la selección SIGUE al foco (patrón ARIA). El componente ya escucha
    // el clic, así que se dispara ése en vez de inventar un canal nuevo.
    siguiente.click();
  };

  // El roving se repasa cuando el DOM cambia: estas pantallas crean y destruyen el grupo al
  // navegar, y un `querySelectorAll` al arrancar no vería ninguno.
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
