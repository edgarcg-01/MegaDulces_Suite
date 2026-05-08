import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';

export interface UpdateNotification {
  hasUpdate: boolean;
  timestamp: number;
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class DataUpdateService {
  private updateSource = new Subject<UpdateNotification>();
  public update$ = this.updateSource.asObservable();

  private lastUpdateTimestamp = signal<number>(Date.now());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pollingInterval: any = null;
  private isPolling = signal(false);

  // Signals para UI
  hasPendingUpdate = signal(false);
  updateMessage = signal<string>('');
  isRefreshing = signal(false);

  // Detectar si está en modo PWA instalado
  isPwaInstalled = computed(() => {
    return window.matchMedia('(display-mode: standalone)').matches ||
           ('standalone' in window.navigator && (window.navigator as any).standalone === true) ||
           document.referrer.includes('android-app://');
  });

  constructor(private http: HttpClient) {}

  /**
   * Inicia el polling periódico para verificar cambios en la API
   * @param intervalMinutes Intervalo en minutos (default: 5)
   */
  startPolling(intervalMinutes = 5): void {
    if (this.isPolling()) {
      console.log('[DataUpdateService] Polling ya está activo');
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`[DataUpdateService] Iniciando polling cada ${intervalMinutes} minutos`);

    this.isPolling.set(true);
    
    // Verificación inicial
    this.checkForUpdates();

    // Configurar intervalo
    this.pollingInterval = setInterval(() => {
      this.checkForUpdates();
    }, intervalMs);
  }

  /**
   * Detiene el polling periódico
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.isPolling.set(false);
      console.log('[DataUpdateService] Polling detenido');
    }
  }

  /**
   * Verifica si hay cambios en la API
   */
  private async checkForUpdates(): Promise<void> {
    try {
      // Endpoint para verificar version de datos
      // Este endpoint debería devolver la última fecha de modificación de los datos
      const response = await this.http.get<{ lastModified: string; version: string }>(
        '/api/data/version'
      ).toPromise();

      if (response) {
        const serverTimestamp = new Date(response.lastModified).getTime();
        const localTimestamp = this.lastUpdateTimestamp();

        // Si el servidor tiene datos más recientes
        if (serverTimestamp > localTimestamp) {
          console.log('[DataUpdateService] Detectados cambios en el servidor');
          this.notifyUpdate('Hay datos actualizados disponibles');
        }
      }
    } catch (error) {
      console.error('[DataUpdateService] Error verificando actualizaciones:', error);
      // Si el endpoint no existe, no hacemos nada (puede que no esté implementado aún)
    }
  }

  /**
   * Notifica que hay una actualización disponible
   */
  private notifyUpdate(message: string): void {
    this.hasPendingUpdate.set(true);
    this.updateMessage.set(message);
    
    this.updateSource.next({
      hasUpdate: true,
      timestamp: Date.now(),
      message
    });

    // Mostrar notificación en UI
    this.showUpdateNotification();
  }

  /**
   * Muestra una notificación visual de actualización
   */
  private showUpdateNotification(): void {
    // El usuario solicitó eliminar esta notificación visual.
    // Se mantiene el polling en segundo plano pero sin mostrar el banner.
  }

  /**
   * Refresca los datos de la aplicación
   */
  async refreshData(): Promise<void> {
    this.isRefreshing.set(true);
    
    try {
      // Disparar recarga de la página
      console.log('[DataUpdateService] Refrescando aplicación...');
      
      // Actualizar timestamp local
      this.lastUpdateTimestamp.set(Date.now());
      this.hasPendingUpdate.set(false);
      
      // Recargar página
      window.location.reload();
    } catch (error) {
      console.error('[DataUpdateService] Error refrescando datos:', error);
      this.isRefreshing.set(false);
    }
  }

  /**
   * Descarta la notificación de actualización
   */
  dismissUpdate(): void {
    this.hasPendingUpdate.set(false);
    
    const notification = document.querySelector('.data-update-notification');
    if (notification) {
      notification.classList.add('hide');
      setTimeout(() => {
        notification.remove();
      }, 300);
    }
  }

  /**
   * Fuerza una verificación manual de actualizaciones
   */
  forceCheckUpdates(): void {
    console.log('[DataUpdateService] Forzando verificación de actualizaciones');
    this.checkForUpdates();
  }

  /**
   * Actualiza el timestamp local (llamar después de obtener datos frescos)
   */
  updateLocalTimestamp(): void {
    this.lastUpdateTimestamp.set(Date.now());
    console.log('[DataUpdateService] Timestamp local actualizado');
  }

  /**
   * Limpia recursos al destruir el servicio
   */
  destroy(): void {
    this.stopPolling();
  }
}
