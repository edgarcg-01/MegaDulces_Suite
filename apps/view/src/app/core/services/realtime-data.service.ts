import { Injectable, signal, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WebSocketService, CaptureEvent, DebouncedCaptureEvent } from './websocket.service';

@Injectable({ providedIn: 'root' })
export class RealtimeDataService {
  private ws = inject(WebSocketService);
  private destroyRef = inject(DestroyRef);

  lastCaptureEvent = signal<CaptureEvent | null>(null);
  lastDebouncedEvent = signal<DebouncedCaptureEvent | null>(null);
  isConnected = this.ws.connected;
  lastEventTime = this.ws.lastEventTime;
  lastEventType = this.ws.lastEvent;

  private init$ = false;

  init(): void {
    if (this.init$) return;
    this.init$ = true;

    this.ws.anyCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        this.lastCaptureEvent.set(event);
      });

    this.ws.debouncedCaptureEvent
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        this.lastDebouncedEvent.set(event);
      });
  }

  connect(token: string): void {
    this.ws.connect(token);
    this.init();
  }

  disconnect(): void {
    this.ws.disconnect();
  }
}