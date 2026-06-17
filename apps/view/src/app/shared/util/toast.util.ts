import { MessageService } from 'primeng/api';

/**
 * Handler de error estándar para `.subscribe({ error })`: toast rojo con summary
 * "Error" + el detalle dado. Estandariza el manejo de errores de carga, que estaba
 * inconsistente entre páginas.
 *
 * Uso:
 *   .subscribe({ next: ..., error: toastError(this.toast, 'No se pudieron cargar clientes') });
 */
export function toastError(toast: MessageService, detail: string): (err?: unknown) => void {
  return () => toast.add({ severity: 'error', summary: 'Error', detail });
}
