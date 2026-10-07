import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Web Push del vendedor (recordatorio de cierre de ruta).
 *
 *  - `enable()`: pide permiso (debe llamarse en un gesto del usuario), se suscribe
 *    con la clave VAPID del backend y registra la suscripción en `POST /push/subscribe`.
 *  - `initClicks()`: al tocar la notificación, navega a su `data.url` (ej. /vendor/close-route).
 *
 * Solo opera con el SW activo (producción) → `supported` es false en dev y todo
 * queda no-op. La forma del payload la define el backend (objeto `notification`
 * que ngsw auto-muestra).
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly swPush = inject(SwPush);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  /** El SW está activo y el navegador soporta notificaciones. */
  readonly supported = this.swPush.isEnabled && typeof Notification !== 'undefined';
  readonly permission = signal<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

  /** Engancha la navegación al tocar una notificación. Llamar al boot. */
  initClicks(): void {
    if (!this.swPush.isEnabled) return;
    this.swPush.notificationClicks.subscribe(({ notification }) => {
      const url = (notification?.data as { url?: string })?.url || '/vendor/route-home';
      this.router.navigateByUrl(url);
    });
  }

  /**
   * Pide permiso + se suscribe + registra en backend. Llamar en un gesto del
   * usuario (click). Devuelve true si quedó suscrito.
   */
  async enable(): Promise<boolean> {
    if (!this.supported) return false;
    try {
      const { publicKey, enabled } = await firstValueFrom(
        this.http.get<{ publicKey: string; enabled: boolean }>(`${environment.apiUrl}/push/public-key`),
      );
      if (!enabled || !publicKey) return false;
      const sub = await this.swPush.requestSubscription({ serverPublicKey: publicKey });
      await firstValueFrom(
        this.http.post(`${environment.apiUrl}/push/subscribe`, { subscription: sub.toJSON() }),
      );
      this.permission.set('granted');
      return true;
    } catch {
      // Permiso denegado o navegador sin soporte → no insistir.
      this.permission.set(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
      return false;
    }
  }
}
