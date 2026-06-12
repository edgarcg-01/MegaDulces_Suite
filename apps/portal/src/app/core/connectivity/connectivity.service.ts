import { Injectable, NgZone, signal, inject } from '@angular/core';
import { TelemetryService } from '../telemetry/telemetry.service';

/**
 * Estado de conectividad del navegador (E3 — resiliencia).
 *
 * Expone un signal `online` que la UI usa para mostrar un banner offline y que
 * otros servicios pueden leer para diferir trabajo. Los reps de campo (tienditas)
 * pierden señal seguido; el estándar q-commerce es avisar, no fallar en silencio.
 *
 * `navigator.onLine` solo dice si hay interfaz de red, no si el backend responde,
 * pero es la señal barata y suficiente para el banner. La verdad de "backend
 * caído" la cubre el retry/telemetría del interceptor.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly zone = inject(NgZone);
  private readonly telemetry = inject(TelemetryService);

  readonly online = signal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this.set(true));
    window.addEventListener('offline', () => this.set(false));
  }

  private set(value: boolean): void {
    // Los eventos online/offline llegan fuera de la zona de Angular en algunos
    // navegadores → corremos el set dentro para que el signal refresque la UI.
    this.zone.run(() => {
      this.online.set(value);
      this.telemetry.track('connectivity_change', { online: value });
    });
  }
}
