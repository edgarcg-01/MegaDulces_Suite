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
  private pollingInterval: any;
  private isPolling = signal(false);

  // Signals para UI
  hasPendingUpdate = signal(false);
  updateMessage = signal<string>('');
  isRefreshing = signal(false);

  // Detectar si está en modo PWA instalado
  isPwaInstalled = computed(() => {
    return window.matchMedia('(display-mode: standalone)').matches ||
           (window.navigator as any).standalone === true ||
           document.referrer.includes('android-app://');
  });

  constructor(private http: HttpClient) {}

  /**
   * Inicia el polling periódico para verificar cambios en la API
   * @param intervalMinutes Intervalo en minutos (default: 5)
   */
  startPolling(intervalMinutes: number = 5): void {
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
    // Crear elemento de notificación
    const existingNotification = document.querySelector('.data-update-notification');
    if (existingNotification) {
      existingNotification.remove();
    }

    const notification = document.createElement('div');
    notification.className = 'data-update-notification';
    notification.innerHTML = `
      <div class="notification-content">
        <div class="notification-icon">🔄</div>
        <div class="notification-text">
          <div class="notification-title">Actualización disponible</div>
          <div class="notification-message">${this.updateMessage()}</div>
        </div>
        <div class="notification-actions">
          <button class="btn-refresh" onclick="window.dataUpdateService.refreshData()">
            Actualizar
          </button>
          <button class="btn-dismiss" onclick="window.dataUpdateService.dismissUpdate()">
            Ahora no
          </button>
        </div>
      </div>
    `;

    // Agregar estilos si no existen
    if (!document.querySelector('#data-update-styles')) {
      const styles = document.createElement('style');
      styles.id = 'data-update-styles';
      styles.textContent = `
        .data-update-notification {
          position: fixed;
          top: 20px;
          right: 20px;
          left: 20px;
          max-width: 400px;
          margin: 0 auto;
          background: white;
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          z-index: 10000;
          animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
          from { transform: translateY(-100px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .data-update-notification.hide {
          animation: slideOut 0.3s ease-out forwards;
        }

        @keyframes slideOut {
          from { transform: translateY(0); opacity: 1; }
          to { transform: translateY(-100px); opacity: 0; }
        }

        .notification-content {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
        }

        .notification-icon {
          font-size: 24px;
          flex-shrink: 0;
        }

        .notification-text {
          flex: 1;
        }

        .notification-title {
          font-weight: 600;
          font-size: 14px;
          color: #1a1a1a;
          margin-bottom: 2px;
        }

        .notification-message {
          font-size: 12px;
          color: #666;
        }

        .notification-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }

        .notification-actions button {
          padding: 8px 12px;
          border: none;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .btn-refresh {
          background: #1976d2;
          color: white;
        }

        .btn-refresh:hover {
          background: #1565c0;
          transform: translateY(-1px);
        }

        .btn-dismiss {
          background: transparent;
          color: #666;
          border: 1px solid #ddd;
        }

        .btn-dismiss:hover {
          background: #f5f5f5;
        }
      `;
      document.head.appendChild(styles);
    }

    // Hacer el servicio disponible globalmente
    (window as any).dataUpdateService = this;

    document.body.appendChild(notification);

    // Auto-ocultar después de 30 segundos
    setTimeout(() => {
      if (notification.parentElement) {
        notification.classList.add('hide');
        setTimeout(() => {
          if (notification.parentElement) {
            notification.remove();
          }
        }, 300);
      }
    }, 30000);
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
