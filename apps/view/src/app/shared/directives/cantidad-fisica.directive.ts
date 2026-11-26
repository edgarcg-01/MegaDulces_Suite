import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/**
 * `[IC.F8][IC.F9]` **Un campo donde se teclea una cantidad CONTADA.**
 *
 * `p-inputnumber` trae dos comportamientos que en un conteo físico son defectos, los dos medidos
 * el 2026-11-26 en `/comercial/inventario/conteo` (`docs/MODULOS/inventario-fisico.md` §9d):
 *
 * - **F8 — corregir CONCATENA.** Al enfocar, `selectionStart` y `selectionEnd` quedan los dos al
 *   final: quien quiera cambiar **75** por **3** termina con **753**. Y no alcanza con seleccionar
 *   al enfocar: `onInputClick()` de PrimeNG llama a `initCursor()`, que **deshace** la selección en
 *   cada clic. Por eso se vuelve a seleccionar en el `click`, que burbujea DESPUÉS del suyo.
 * - **F9 — las flechas cambian la cantidad.** `onInputKeyDown` manda `ArrowUp`/`ArrowDown` a
 *   `spin()`. Una flecha que suma una pieza en vez de mover el cursor es un error que nadie ve:
 *   el conteo sale mal y la pantalla se ve igual.
 *
 * ⛔ **Por qué en fase de CAPTURA y con `stopPropagation`:** PrimeNG escucha el `keydown` en el
 * `<input>` y emite su `onKeyDown` **al final**, después de haber hecho el `spin`. Un
 * `preventDefault()` desde el componente llega tarde — el número ya cambió. El único lugar que
 * corre antes es la captura sobre un ancestro. Mismo razonamiento, mismo mecanismo y mismo motivo
 * que `ConteoCajonComponent` (`[LE.6.11]`, conteo de efectivo), que mueve entre campos; acá no hay
 * a dónde moverse, así que la flecha sólo deja de tocar el número.
 *
 * No se tocan los botones `+`/`−`: un toque es deliberado, una flecha al lado del Enter no.
 *
 * ⚠️ **Esto no se puede probar en jsdom**: `ArrowDown` sobre un `input` con 34 deja **34** en jsdom
 * y **33** en Chrome. Lo que su prueba sí afirma —y es lo que importa— es que el evento **nunca
 * llega** al escucha de PrimeNG.
 */
@Directive({ selector: 'p-inputnumber[appCantidadFisica]', standalone: true })
export class CantidadFisicaDirective {
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);

    const esElCampo = (t: EventTarget | null): t is HTMLInputElement =>
      t instanceof HTMLInputElement && host.contains(t);

    /** F9 — la flecha mueve el cursor (comportamiento normal de un campo de texto), no el número. */
    const sinFlechas = (ev: KeyboardEvent): void => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (!esElCampo(ev.target)) return;
      ev.stopPropagation();
    };

    /** F8 — teclear REEMPLAZA lo que hay. `focusin` burbujea (`focus` no). */
    const seleccionarTodo = (ev: Event): void => {
      const campo = ev.target;
      if (!esElCampo(campo)) return;
      campo.select();
    };

    host.addEventListener('keydown', sinFlechas, true);
    host.addEventListener('focusin', seleccionarTodo);
    host.addEventListener('click', seleccionarTodo);
    destroyRef.onDestroy(() => {
      host.removeEventListener('keydown', sinFlechas, true);
      host.removeEventListener('focusin', seleccionarTodo);
      host.removeEventListener('click', seleccionarTodo);
    });
  }
}
