import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConnectivityService } from './connectivity.service';
import { OutboxService } from '../offline/outbox.service';

/**
 * Banner global de conectividad + sincronización (E3 + F2).
 * Se monta en AppComponent → visible en cualquier pantalla del portal.
 *
 *  - Offline: avisa que los cambios se encolan (con el nº pendiente si lo hay).
 *  - Online con cola pendiente: muestra el progreso de sincronización.
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!connectivity.online()) {
      <div class="offline-banner offline" role="status" aria-live="polite">
        <i class="pi pi-wifi" aria-hidden="true"></i>
        @if (outbox.pending() > 0) {
          Sin conexión — {{ outbox.pending() }} cambio(s) se enviarán al reconectar
        } @else {
          Sin conexión — tus cambios se enviarán al reconectar
        }
      </div>
    } @else if (outbox.pending() > 0 || outbox.syncing()) {
      <div class="offline-banner syncing" role="status" aria-live="polite">
        <i class="pi pi-sync" [class.spin]="outbox.syncing()" aria-hidden="true"></i>
        Sincronizando {{ outbox.pending() }} cambio(s)…
      </div>
    }
  `,
  styles: [`
    .offline-banner {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: .5rem;
      padding: .6rem 1rem;
      font-size: .875rem;
      font-weight: 600;
      color: #fff;
      box-shadow: 0 -2px 12px rgba(0, 0, 0, .25);
    }
    .offline-banner.offline { background: #b91c1c; }
    .offline-banner.syncing { background: #16130F; }
    .offline-banner .pi-sync.spin { animation: ob-spin 1s linear infinite; }
    @keyframes ob-spin { to { transform: rotate(360deg); } }
  `],
})
export class OfflineBannerComponent {
  protected readonly connectivity = inject(ConnectivityService);
  protected readonly outbox = inject(OutboxService);
}
