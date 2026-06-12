import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PwaService } from './pwa.service';

/**
 * Banner no intrusivo cuando hay una nueva versión del SW lista (Fase 1).
 * Aparece abajo; el usuario decide cuándo recargar. Montado en AppComponent.
 */
@Component({
  selector: 'app-pwa-update-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pwa.updateReady() && !dismissed()) {
      <div class="pwa-update" role="status" aria-live="polite">
        <i class="pi pi-sparkles" aria-hidden="true"></i>
        <span class="pwa-update-text">Hay una nueva versión disponible</span>
        <button type="button" class="pwa-update-btn" (click)="pwa.applyUpdate()">Actualizar</button>
        <button type="button" class="pwa-update-x" (click)="dismissed.set(true)" aria-label="Descartar">
          <i class="pi pi-times" aria-hidden="true"></i>
        </button>
      </div>
    }
  `,
  styles: [`
    .pwa-update {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 1rem;
      z-index: 9998;
      display: flex;
      align-items: center;
      gap: .65rem;
      max-width: calc(100vw - 2rem);
      padding: .6rem .65rem .6rem 1rem;
      border-radius: 999px;
      background: #16130F;
      color: #fff;
      font-size: .875rem;
      box-shadow: 0 8px 28px rgba(0,0,0,.32);
    }
    .pwa-update i.pi-sparkles { color: #FDE707; }
    .pwa-update-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pwa-update-btn {
      flex: none;
      border: 0;
      cursor: pointer;
      font-weight: 700;
      font-size: .8125rem;
      color: #16130F;
      background: #FDE707;
      padding: .4rem .85rem;
      border-radius: 999px;
    }
    .pwa-update-x {
      flex: none;
      border: 0;
      background: transparent;
      color: #fff;
      opacity: .7;
      cursor: pointer;
      padding: .25rem;
      line-height: 1;
    }
    .pwa-update-x:hover { opacity: 1; }
  `],
})
export class PwaUpdateBannerComponent {
  protected readonly pwa = inject(PwaService);
  protected readonly dismissed = signal(false);
}
