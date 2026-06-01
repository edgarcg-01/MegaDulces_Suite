import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { OfflineDailyCaptureService } from '../../../core/services/offline-daily-capture.service';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';

@Component({
  selector: 'app-offline-status',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  templateUrl: './offline-status.component.html',
  styleUrls: ['./offline-status.component.scss']
})
export class OfflineStatusComponent implements OnInit, OnDestroy {
  private subscriptions: Subscription[] = [];

  isOnline = true;
  isOffline = false;
  isSynchronizing = false;
  visitasPendientes = 0;
  visitasMuertas = 0;
  ultimaSincronizacion: string | null = null;
  showDetails = false;

  // Watchdog visual: si lleva >30s sincronizando, mostrar botón "Reiniciar".
  syncStuckMs = 0;
  private stuckTicker: any = null;
  private readonly STUCK_THRESHOLD_MS = 30_000;

  // Estado detallado
  tiendasOffline = 0;
  catalogosActualizados = false;
  gpsDisponible = false;
  
  constructor(
    private offlineService: OfflineDailyCaptureService,
    private syncService: OfflineSyncService
  ) {}

  ngOnInit(): void {
    this.loadInitialStatus();
    this.setupSubscriptions();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.stopStuckTicker();
  }

  private async loadInitialStatus(): Promise<void> {
    try {
      const estado = await this.offlineService.getEstadoOffline();
      this.updateStatus(estado);
    } catch (error) {
      console.error('[OfflineStatus] Error cargando estado inicial:', error);
    }
  }

  private setupSubscriptions(): void {
    // Suscribirse a cambios de sincronización
    const syncSub = this.syncService.syncStatus$.subscribe(status => {
      this.isOnline = status.online;
      this.isOffline = !status.online;
      this.isSynchronizing = status.sincronizando;
      this.visitasPendientes = status.visitasPendientes;
      this.visitasMuertas = status.visitasMuertas;
      this.ultimaSincronizacion = status.ultimoSync;

      // Tick para mostrar duración de la sincronización en vivo y activar
      // el botón "Reiniciar" si lleva >30s. Sin ticker, la UI no avisa al
      // usuario que algo está colgado hasta el watchdog del servicio (2 min).
      if (status.sincronizando) {
        this.startStuckTicker();
      } else {
        this.stopStuckTicker();
      }
    });

    this.subscriptions.push(syncSub);
  }

  private startStuckTicker(): void {
    if (this.stuckTicker) return;
    this.stuckTicker = setInterval(() => {
      this.syncStuckMs = this.syncService.getSyncElapsedMs();
    }, 1000);
  }

  private stopStuckTicker(): void {
    if (this.stuckTicker) {
      clearInterval(this.stuckTicker);
      this.stuckTicker = null;
    }
    this.syncStuckMs = 0;
  }

  /** Habilita el botón "Reiniciar" en la UI cuando el sync lleva mucho tiempo. */
  get isSyncStuck(): boolean {
    return this.isSynchronizing && this.syncStuckMs >= this.STUCK_THRESHOLD_MS;
  }

  /** Reset manual cuando la sincronización quedó colgada. */
  reiniciarSincronizacion(): void {
    if (!confirm('¿Reiniciar la sincronización? Esto descarta el intento actual; las visitas se reintentarán en el próximo ciclo.')) {
      return;
    }
    this.syncService.resetEstadoSincronizacion();
    this.showNotification('Sincronización reiniciada', 'info');
  }

  private updateStatus(estado: any): void {
    this.isOnline = estado.online;
    this.isOffline = !estado.online;
    this.visitasPendientes = estado.visitasPendientes;
    this.tiendasOffline = estado.tiendasDisponibles;
    this.catalogosActualizados = estado.catalogosActualizados;
    this.gpsDisponible = estado.gpsDisponible;
    this.ultimaSincronizacion = estado.ultimaSincronizacion;
  }

  async forzarSincronizacion(): Promise<void> {
    if (this.isSynchronizing) {
      // Antes este path retornaba silencioso → el usuario clickeaba y nada
      // pasaba. Ahora le avisamos qué está pasando + sugerimos reset si
      // lleva mucho tiempo.
      const elapsed = Math.round(this.syncService.getSyncElapsedMs() / 1000);
      this.showNotification(
        this.isSyncStuck
          ? `Sincronización lleva ${elapsed}s. Usá "Reiniciar" si crees que está colgada.`
          : `Sincronización en progreso (${elapsed}s)…`,
        'info',
      );
      return;
    }

    if (!this.isOnline) {
      this.showNotification('Sin conexión a internet — no se puede sincronizar.', 'error');
      return;
    }

    try {
      const resultado = await this.offlineService.forzarSincronizacionManual();
      if (resultado.exito) {
        // Mostrar notificación de éxito
        this.showNotification('Sincronización completada', 'success');
      } else {
        this.showNotification(resultado.mensaje, 'error');
      }
    } catch (error) {
      console.error('[OfflineStatus] Error forzando sincronización:', error);
      this.showNotification('Error al sincronizar', 'error');
    }
  }

  async limpiarDatosOffline(): Promise<void> {
    // Confirmación inline via toast no aplica — usamos confirm() nativo del browser
    // solo para acciones destructivas. UX mejor que un dialog modal aquí porque
    // es opcional y el usuario rara vez la dispara.
    if (!confirm('¿Está seguro de que desea limpiar los datos antiguos offline?')) {
      return;
    }

    try {
      const resultado = await this.offlineService.limpiarDatosOffline();
      if (resultado.exito) {
        this.showNotification('Datos limpiados exitosamente', 'success');
        await this.loadInitialStatus();
      } else {
        this.showNotification(resultado.mensaje, 'error');
      }
    } catch (error) {
      console.error('[OfflineStatus] Error limpiando datos:', error);
      this.showNotification('Error al limpiar datos', 'error');
    }
  }

  toggleDetails(): void {
    this.showDetails = !this.showDetails;
  }

  getStatusIcon(): string {
    if (this.isSynchronizing) {
      return 'pi pi-spin pi-spinner';
    }
    if (this.isOffline) {
      return 'pi pi-wifi-off';
    }
    if (this.visitasPendientes > 0) {
      return 'pi pi-exclamation-triangle';
    }
    return 'pi pi-wifi';
  }

  getStatusColor(): string {
    if (this.isSynchronizing) {
      return 'text-blue-500';
    }
    if (this.isOffline) {
      return 'text-orange-500';
    }
    if (this.visitasPendientes > 0) {
      return 'text-yellow-500';
    }
    return 'text-green-500';
  }

  getStatusText(): string {
    if (this.isSynchronizing) {
      return 'Sincronizando...';
    }
    if (this.isOffline) {
      return 'Modo Offline';
    }
    if (this.visitasPendientes > 0) {
      return `${this.visitasPendientes} visitas pendientes`;
    }
    return 'Conectado';
  }

  getUltimaSincronizacionText(): string {
    if (!this.ultimaSincronizacion) {
      return 'Nunca';
    }
    
    const fecha = new Date(this.ultimaSincronizacion);
    const ahora = new Date();
    const diffMs = ahora.getTime() - fecha.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) {
      return 'Ahora';
    } else if (diffMins < 60) {
      return `Hace ${diffMins} min`;
    } else if (diffMins < 1440) {
      return `Hace ${Math.floor(diffMins / 60)} h`;
    } else {
      return `Hace ${Math.floor(diffMins / 1440)} días`;
    }
  }

  /**
   * MessageService es optional: si el padre no lo provee (componente standalone
   * fuera de captures), caemos a console silencioso. Antes esto usaba `alert()`
   * que bloqueaba el thread y era horrible UX en mobile.
   */
  private toast = inject(MessageService, { optional: true });

  private showNotification(message: string, type: 'success' | 'error' | 'info'): void {
    if (this.toast) {
      const severityMap: Record<typeof type, 'success' | 'error' | 'info'> = {
        success: 'success',
        error: 'error',
        info: 'info',
      };
      this.toast.add({
        severity: severityMap[type],
        summary:
          type === 'success' ? 'Listo' :
          type === 'error' ? 'Error' : 'Info',
        detail: message,
        life: type === 'error' ? 5000 : 3000,
      });
    } else {
      console.log(`[OfflineStatus] ${type.toUpperCase()}: ${message}`);
    }
  }
}
