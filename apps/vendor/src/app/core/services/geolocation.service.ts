import { Injectable } from '@angular/core';

export interface GeoFix {
  lat: number;
  lng: number;
  /** Precisión en metros reportada por el dispositivo. */
  accuracy: number;
}

/**
 * GPS one-shot compartido. Mismo patrón que `daily-capture.service` (/capture):
 * intento de alta precisión y, si falla, fallback a baja precisión con caché
 * reciente. No hace detección de cercanía — eso vive en el caller (cada módulo
 * decide contra qué set medir). Reutilizable por /vendor y /capture.
 */
@Injectable({ providedIn: 'root' })
export class GeolocationService {
  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  /** Obtiene una posición. Rechaza si no hay soporte o el usuario niega el permiso. */
  getCurrentPosition(): Promise<GeoFix> {
    return new Promise<GeoFix>((resolve, reject) => {
      if (!this.supported) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      const ok = (pos: GeolocationPosition) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });

      navigator.geolocation.getCurrentPosition(
        ok,
        () => {
          // Fallback baja precisión (caché reciente si existe).
          navigator.geolocation.getCurrentPosition(ok, (err) => reject(err), {
            enableHighAccuracy: false,
            timeout: 5000,
            maximumAge: 60000,
          });
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }
}
