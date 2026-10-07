import { Injectable, NgZone, inject, signal } from '@angular/core';
import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { Geolocation } from '@capacitor/geolocation';
import { AuthService } from './auth.service';
import { OfflineDatabaseService, RoutePing } from './offline-database.service';
import { DailyCaptureService } from '../../modules/dashboard/captures/daily-capture.service';
import { RoutePingService } from './route-ping.service';

// Registro del plugin nativo vía proxy Capacitor. El `import type` de arriba se borra
// en compilación, así que el build web no intenta bundlear el paquete nativo (device-only).
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

@Injectable({
  providedIn: 'root'
})
export class TrackingService {
  private watcherId: string | null = null;
  private ngZone = inject(NgZone);
  private auth = inject(AuthService);
  private db = inject(OfflineDatabaseService);
  private captureSvc = inject(DailyCaptureService);
  private syncSvc = inject(RoutePingService);

  readonly isTracking = signal(false);

  /**
   * Verifica los permisos necesarios para el rastreo en segundo plano.
   */
  async checkPermissions(): Promise<{ location: string; background: string }> {
    try {
      const status = await Geolocation.checkPermissions();
      // En web/foreground no hay un permiso "background" consultable por separado; se
      // refleja el de ubicación. El permiso real de segundo plano se pide en addWatcher.
      return {
        location: status.location,
        background: status.location,
      };
    } catch (err) {
      console.error('Error al verificar permisos:', err);
      return { location: 'denied', background: 'denied' };
    }
  }

  /**
   * Solicita los permisos necesarios de primer plano.
   */
  async requestPermissions(): Promise<boolean> {
    try {
      const res = await Geolocation.requestPermissions({
        permissions: ['location']
      });
      return res.location === 'granted';
    } catch (err) {
      console.error('Error al solicitar permisos:', err);
      return false;
    }
  }

  /**
   * Abre los ajustes de la aplicación para que el usuario active manualmente
   * el permiso "Permitir todo el tiempo" (Background Location).
   */
  async openSettings() {
    await BackgroundGeolocation.openSettings();
  }

  /**
   * Inicia el rastreo continuo con notificación persistente.
   */
  async startBackgroundTracking() {
    try {
      if (this.watcherId) return;

      this.watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundMessage: 'Rastreo de ubicación activo para reporte de ruta.',
          backgroundTitle: 'Trade Marketing en Segundo Plano',
          requestPermissions: true,
          stale: false,
          distanceFilter: 10
        },
        (location, error) => {
          if (error) {
            if (error.code === 'NOT_AUTHORIZED') {
              console.error('El usuario denegó los permisos de ubicación en segundo plano.');
            }
            return;
          }

          if (location) {
            this.ngZone.run(() => {
              this.handleNewLocation(location);
            });
          }
        }
      );

      this.isTracking.set(true);
      console.log('Watcher de GPS iniciado:', this.watcherId);

    } catch (err) {
      console.error('Error al iniciar el rastreo:', err);
    }
  }

  async stopTracking() {
    if (this.watcherId) {
      await BackgroundGeolocation.removeWatcher({ id: this.watcherId });
      this.watcherId = null;
      this.isTracking.set(false);
      console.log('Rastreo detenido');
    }
  }

  private async handleNewLocation(location: any) {
    const user = this.auth.user();
    const userId = user?.sub || (user as any)?.id;
    if (!userId) return;

    const route = this.captureSvc.activeRoute();

    const ping: RoutePing = {
      id: crypto.randomUUID(),
      userId: String(userId),
      routeId: route?.id || null,
      capturedAt: new Date(location.time || Date.now()).toISOString(),
      lat: location.latitude,
      lng: location.longitude,
      accuracyM: location.accuracy ?? undefined,
      speedMps: location.speed ?? undefined,
      source: 'background',
      sincronizado: false,
      intentos_fallidos: 0,
    };

    try {
      await this.db.routePings.put(ping);
      if (navigator.onLine) {
        (this.syncSvc as any).drain();
      }
    } catch (err) {
      console.error('[TrackingService] Error al guardar ping:', err);
    }
  }
}
