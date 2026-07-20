import { CanDeactivateFn } from '@angular/router';

/**
 * DESIGN §8 (estado sucio) — guard anti-pérdida de captura. Cualquier componente de
 * formulario largo lo implementa exponiendo `hasUnsavedChanges()`; si devuelve true,
 * la navegación interna (Router) se intercepta y pide confirmación antes de salir.
 *
 * Uso:
 *   1. El componente implementa `HasUnsavedChanges` y trackea su estado dirty.
 *   2. En la ruta: `{ path: '...', component: FooForm, canDeactivate: [unsavedChangesGuard] }`.
 *   3. Complemento para salida EXTERNA (cerrar pestaña / F5) — en el componente:
 *        @HostListener('window:beforeunload', ['$event'])
 *        onBeforeUnload(e: BeforeUnloadEvent) { if (this.hasUnsavedChanges()) e.preventDefault(); }
 *      (el navegador muestra su prompt nativo; el texto ya no es customizable — es lo esperado.)
 *
 * Usa `window.confirm` a propósito: funciona sin montar <p-confirmDialog> y es
 * consistente con el prompt nativo del beforeunload. Una pantalla puede sobre-escribir
 * con un modal propio resolviendo la navegación por su cuenta.
 */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component?.hasUnsavedChanges?.()) return true;
  return window.confirm('Tienes cambios sin guardar. ¿Descartarlos y salir de la pantalla?');
};
