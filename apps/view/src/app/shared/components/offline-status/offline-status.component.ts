import { Component, OnInit, OnDestroy, effect } from '@angular/core';
import { Subscription } from 'rxjs';
import { OfflineDailyCaptureService } from '../../../core/services/offline-daily-capture.service';
import { OfflineSyncService } from '../../../core/services/offline-sync.service';

@Component({
  selector: 'app-offline-status',
  templateUrl: './offline-status.component.html',
  styleUrls: ['./offline-status.component.scss']
})
export class OfflineStatusComponent implements OnInit, OnDestroy {
  private subscriptions: Subscription[] = [];
  
  isOnline = true;
  isOffline = false;
  isSynchronizing = false;
  visitasPendientes = 0;
  ultimaSincronizacion: string | null = null;
  showDetails = false;
  
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
      this.ultimaSincronizacion = status.ultimoSync;
    });

    this.subscriptions.push(syncSub);
  }

  // Efecto para escuchar cambios de conexión
  private offlineEffect = effect(() => {
    const status = this.syncService.getEstadoActual();
    this.isOffline = !status.online;
    this.isOnline = status.online;
  });

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

  private showNotification(message: string, type: 'success' | 'error' | 'info'): void {
    // Aquí podrías integrar un servicio de notificaciones
    // Por ahora, usamos console.log
    console.log(`[OfflineStatus] ${type.toUpperCase()}: ${message}`);
    
    // O mostrar un toast simple
    if (type === 'success') {
      alert(`✅ ${message}`);
    } else if (type === 'error') {
      alert(`❌ ${message}`);
    } else {
      alert(`ℹ️ ${message}`);
    }
  }
}
