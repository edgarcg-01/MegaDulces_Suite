import { Injectable, signal } from '@angular/core';

/**
 * Fase LM.11.2 — Geocerca de llegada para el flujo guiado del repartidor.
 *
 * Vigila la posición del dispositivo (`watchPosition`) y calcula la distancia
 * (haversine) al destino de la parada actual. Emite `distance`/`accuracy` y un
 * flag `arrived` cuando entra dentro del radio.
 *
 * El GPS de celular no es fiable a 10 m (precisión típica 10–30 m), por eso el
 * radio es CONFIGURABLE (default 40 m) y el flujo siempre ofrece un override
 * manual "Ya llegué". Esto vive en el cliente porque la detección debe ser en
 * vivo; el tracking al servidor lo sigue haciendo RoutePingService.
 */
@Injectable({ providedIn: 'root' })
export class GeofenceService {
  /** Radio de llegada en metros (ajustable). */
  readonly radiusM = signal(40);
  /** Distancia actual al destino (m) o null si aún no hay fix. */
  readonly distanceM = signal<number | null>(null);
  /** Precisión reportada por el GPS (m) o null. */
  readonly accuracyM = signal<number | null>(null);
  /** ¿Dentro del radio? (distancia ≤ radio). */
  readonly arrived = signal(false);
  /** Última posición conocida. */
  readonly lastFix = signal<{ lat: number; lng: number } | null>(null);
  /** Error de geolocalización legible (permiso denegado, sin señal…). */
  readonly geoError = signal<string | null>(null);

  private watchId: number | null = null;
  private target: { lat: number; lng: number } | null = null;

  /** Empieza a vigilar la llegada a un destino. Reinicia el estado. */
  watch(target: { lat: number; lng: number }): void {
    this.stop();
    this.target = target;
    this.distanceM.set(null);
    this.accuracyM.set(null);
    this.arrived.set(false);
    this.geoError.set(null);

    if (!('geolocation' in navigator)) {
      this.geoError.set('Este dispositivo no expone GPS.');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onFix(pos),
      (err) => this.onError(err),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 },
    );
  }

  /** Detiene la vigilancia. */
  stop(): void {
    if (this.watchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    this.target = null;
  }

  /** Distancia haversine en metros entre dos coords. */
  static distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  private onFix(pos: GeolocationPosition): void {
    if (!this.target) return;
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    this.lastFix.set(here);
    this.accuracyM.set(pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null);
    const d = GeofenceService.distanceMeters(here, this.target);
    this.distanceM.set(Math.round(d));
    this.arrived.set(d <= this.radiusM());
    this.geoError.set(null);
  }

  private onError(err: GeolocationPositionError): void {
    this.geoError.set(
      err.code === err.PERMISSION_DENIED
        ? 'Permiso de ubicación denegado — actívalo para detectar la llegada.'
        : 'Sin señal GPS por ahora.',
    );
  }
}
