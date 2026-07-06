import { Injectable, NgZone } from '@angular/core';
import { BackgroundGeolocation } from '@capacitor-community/background-geolocation';

@Injectable({
  providedIn: 'root'
})
export class TrackingService {
  private watcherId: string | null = null;

  constructor(private ngZone: NgZone) {}

  /**
   * Inicia el rastreo continuo con notificación persistente.
   */
  async startBackgroundTracking() {
    try {
      // 1. Configurar y arrancar el watcher nativo
      this.watcherId = await BackgroundGeolocation.addWatcher(
        {
          // La notificación persistente que obliga a Android a mantener la app viva
          backgroundMessage: 'Cancel to prevent battery drain.',
          backgroundTitle: 'Rastreo de ruta activo.',
          requestPermissions: true, // El plugin intentará pedir permisos automáticamente
          stale: false,
          distanceFilter: 10 // Actualiza cada vez que el usuario se mueva 10 metros
        },
        (location, error) => {
          if (error) {
            if (error.code === 'NOT_AUTHORIZED') {
              console.error('El usuario denegó los permisos de ubicación en segundo plano.');
              // Aquí podrías redirigir a una pantalla explicando por qué es necesario
            }
            return;
          }

          if (location) {
            // NgZone asegura que Angular detecte los cambios si actualizas variables de UI desde un evento nativo
            this.ngZone.run(() => {
              this.handleNewLocation(location);
            });
          }
        }
      );

      console.log('Watcher de GPS iniciado con ID:', this.watcherId);

    } catch (err) {
      console.error('Error al inicializar el rastreo:', err);
    }
  }

  /**
   * Detiene el rastreo y elimina la notificación de primer plano.
   */
  async stopTracking() {
    if (this.watcherId) {
      await BackgroundGeolocation.removeWatcher({ id: this.watcherId });
      this.watcherId = null;
      console.log('Rastreo detenido exitosamente');
    }
  }

  /**
   * Lógica para procesar la coordenada (guardar en base de datos local o enviar al backend)
   */
  private handleNewLocation(location: any) {
    const payload = {
      latitude: location.latitude,
      longitude: location.longitude,
      timestamp: location.time,
      accuracy: location.accuracy
    };

    console.log('Nueva ubicación recibida desde segundo plano:', payload);

    // TODO: Enviar a tu API o guardar en SQLite si no hay red
  }
}
