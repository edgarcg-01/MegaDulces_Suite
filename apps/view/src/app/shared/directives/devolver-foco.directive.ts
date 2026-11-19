import { DestroyRef, Directive, inject } from '@angular/core';
import { Dialog } from 'primeng/dialog';

/**
 * `[LE.6.11]` **Al cerrar una ventana, el foco vuelve a donde estaba.**
 *
 * PrimeNG enfoca la ventana al abrirla y la cierra con `Esc`, pero NO devuelve el foco al cerrar
 * (verificado en Caja General, `[CG]` «Teclado»: cero `previousFocus` en su runtime). Sin esto el foco
 * cae en el `<body>` y quien trabaja con teclado tiene que recorrer la pantalla entera para volver a
 * la fila donde estaba. Caja General lo resolvió a mano (`focoPrevio`); esto es lo mismo, una vez,
 * para cualquier `<p-dialog appDevolverFoco>`.
 *
 * Cómo: recuerda el último elemento enfocado FUERA de una ventana; al ocultarse ésta, lo enfoca si
 * sigue en la página. Si la lista se volvió a pintar (el elemento ya no existe), enfoca el primero
 * que coincida con `[data-foco-retorno]`, que la pantalla marca como su punto de regreso.
 */
@Directive({ selector: 'p-dialog[appDevolverFoco]', standalone: true })
export class DevolverFocoDirective {
  private previo: HTMLElement | null = null;

  constructor() {
    const dialog = inject(Dialog);
    const destroyRef = inject(DestroyRef);
    const recordar = (ev: FocusEvent): void => {
      const t = ev.target as HTMLElement | null;
      if (t && !t.closest('.p-dialog')) this.previo = t;
    };
    document.addEventListener('focusin', recordar, true);
    // `onHide` es un `OutputEmitterRef` (PrimeNG 22): se suscribe directo y se suelta al destruir.
    const sub = dialog.onHide.subscribe(() => setTimeout(() => this.devolver(), 0));
    destroyRef.onDestroy(() => { document.removeEventListener('focusin', recordar, true); sub.unsubscribe(); });
  }

  private devolver(): void {
    if (this.previo && document.contains(this.previo)) { this.previo.focus(); return; }
    // La lista se volvió a pintar: al primer elemento enfocable de la zona que la pantalla marcó.
    const zona = document.querySelector<HTMLElement>('[data-foco-retorno]');
    const el = zona?.querySelector<HTMLElement>('tr[tabindex], button:not([disabled]), a[href], [tabindex="0"]') ?? zona;
    el?.focus();
  }
}
