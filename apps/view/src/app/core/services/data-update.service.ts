import { Injectable, signal, inject, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WebSocketService, CaptureEvent } from './websocket.service';
import { AuthService } from './auth.service';

export interface UpdateNotification {
  hasUpdate: boolean;
  timestamp: number;
  message?: string;
  eventType?: string;
}

@Injectable({ providedIn: 'root' })
export class DataUpdateService {
  private updateSource = new Subject<UpdateNotification>();
  public update$ = this.updateSource.asObservable();

  private destroyRef = inject(DestroyRef);
  private ws = inject(WebSocketService);
  private auth = inject(AuthService);

  hasPendingUpdate = signal(false);
  updateMessage = signal<string>('');
  isRefreshing = signal(false);
  lastCaptureEvent = signal<CaptureEvent | null>(null);
  wsConnected = this.ws.connected;
  lastEventTime = this.ws.lastEventTime;
  lastEventType = this.ws.lastEvent;

  isPwaInstalled = signal(
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in window.navigator && (window.navigator as any).standalone === true) ||
    document.referrer.includes('android-app://')
  );

  init(): void {
    const token = this.auth.token();
    if (token) {
      this.ws.connect(token);
    }

    this.ws.anyCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event: CaptureEvent) => {
        this.lastCaptureEvent.set(event);
        const label = event.type === 'capture:deleted' ? 'Eliminada' : 'Registrada';
        this.notifyUpdate(`${event.capturedByUsername || 'Usuario'}: Captura ${label}`);
      });
  }

  private notifyUpdate(message: string): void {
    this.hasPendingUpdate.set(true);
    this.updateMessage.set(message);

    this.updateSource.next({
      hasUpdate: true,
      timestamp: Date.now(),
      message,
      eventType: this.ws.lastEvent() || undefined,
    });
  }

  dismissUpdate(): void {
    this.hasPendingUpdate.set(false);
  }

  updateLocalTimestamp(): void {
    console.log('[DataUpdateService] Timestamp actualizado via WS');
  }

  destroy(): void {
    this.ws.disconnect();
  }
}