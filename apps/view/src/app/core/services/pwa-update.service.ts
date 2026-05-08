import { Injectable, inject } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { ConfirmationService } from 'primeng/api';

@Injectable({ providedIn: 'root' })
export class PwaUpdateService {
  private swUpdate = inject(SwUpdate);
  private confirmationService = inject(ConfirmationService);

  /**
   * Inicia el monitoreo de actualizaciones del Service Worker
   */
  checkForUpdates(): void {
    if (!this.swUpdate.isEnabled) {
      console.log('[PwaUpdateService] Service Worker no está habilitado');
      return;
    }

    console.log('[PwaUpdateService] Monitoreando actualizaciones...');

    // Escuchar cuando hay una versión nueva lista para ser activada
    this.swUpdate.versionUpdates.pipe(
      filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY')
    ).subscribe(() => {
      this.promptUserToUpdate();
    });

    // Verificar actualizaciones periódicamente (cada 6 horas)
    // El navegador también lo hace automáticamente al recargar o navegar
    setInterval(() => {
      this.swUpdate.checkForUpdate().then(found => {
        if (found) console.log('[PwaUpdateService] Nueva versión detectada por verificación periódica');
      });
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Notifica al usuario con un diálogo de confirmación
   */
  private promptUserToUpdate(): void {
    this.confirmationService.confirm({
      header: 'Actualización Disponible',
      message: 'Hay una nueva versión de la aplicación lista. ¿Deseas actualizar ahora para obtener las últimas mejoras?',
      icon: 'pi pi-refresh',
      acceptLabel: 'Actualizar Ahora',
      rejectLabel: 'Más tarde',
      acceptButtonStyleClass: 'p-button-brand',
      accept: () => {
        document.location.reload();
      }
    });
  }
}
