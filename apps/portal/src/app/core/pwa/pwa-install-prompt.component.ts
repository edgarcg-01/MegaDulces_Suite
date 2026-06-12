import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PwaService } from './pwa.service';

const DISMISS_KEY = 'portal:pwa:install-dismissed';

/**
 * Invitación a instalar el portal como app (Fase 1).
 *  - Chromium: botón que dispara el prompt nativo (`promptInstall`).
 *  - iOS: instrucciones "Compartir → Agregar a inicio" (no hay prompt nativo).
 * Descartable y con memoria en localStorage para no insistir.
 *
 * Nota: para la versión "contextual" (mostrar tras confirmar un pedido), llamar
 * `pwa.promptInstall()` desde el handler de order_confirmed. Este banner es el
 * camino pasivo/siempre-disponible.
 */
@Component({
  selector: 'app-pwa-install-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (show()) {
      <div class="pwa-install" role="dialog" aria-label="Instalar la app">
        <img src="assets/logos/mega-dulces-logo-240.webp" alt="" class="pwa-install-ico" />
        <div class="pwa-install-body">
          <strong>Instala Mega Dulces</strong>
          @if (pwa.isIos) {
            <span>Toca <i class="pi pi-upload" aria-hidden="true"></i> Compartir y luego "Agregar a inicio".</span>
          } @else {
            <span>Pide en 1 tap, abre al instante y funciona sin conexión.</span>
          }
        </div>
        @if (!pwa.isIos) {
          <button type="button" class="pwa-install-btn" (click)="install()">Instalar</button>
        }
        <button type="button" class="pwa-install-x" (click)="dismiss()" aria-label="Ahora no">
          <i class="pi pi-times" aria-hidden="true"></i>
        </button>
      </div>
    }
  `,
  styles: [`
    .pwa-install {
      position: fixed;
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
      z-index: 9997;
      margin-inline: auto;
      max-width: 460px;
      display: flex;
      align-items: center;
      gap: .75rem;
      padding: .75rem;
      border-radius: 16px;
      background: #fff;
      color: #16130F;
      border: 1px solid rgba(0,0,0,.08);
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
    }
    .pwa-install-ico { width: 40px; height: 40px; border-radius: 10px; flex: none; object-fit: contain; }
    .pwa-install-body { display: flex; flex-direction: column; gap: .1rem; font-size: .8125rem; line-height: 1.25; }
    .pwa-install-body strong { font-size: .9375rem; }
    .pwa-install-body .pi-upload { font-size: .8rem; }
    .pwa-install-btn {
      flex: none;
      margin-left: auto;
      border: 0;
      cursor: pointer;
      font-weight: 700;
      color: #16130F;
      background: #FDE707;
      padding: .5rem .9rem;
      border-radius: 999px;
    }
    .pwa-install-x {
      flex: none;
      border: 0;
      background: transparent;
      color: #16130F;
      opacity: .5;
      cursor: pointer;
      padding: .25rem;
      line-height: 1;
    }
    .pwa-install-x:hover { opacity: 1; }
  `],
})
export class PwaInstallPromptComponent {
  protected readonly pwa = inject(PwaService);
  private readonly dismissed = signal(this.readDismissed());

  // Mostrar si: no está instalado, no fue descartado, y (Chromium puede instalar
  // O es iOS donde mostramos instrucciones).
  protected readonly show = computed(
    () => !this.pwa.isStandalone && !this.dismissed() && (this.pwa.canInstall() || this.pwa.isIos),
  );

  protected async install(): Promise<void> {
    const outcome = await this.pwa.promptInstall();
    if (outcome !== 'unavailable') this.dismiss();
  }

  protected dismiss(): void {
    this.dismissed.set(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* localStorage no disponible: el descarte dura la sesión */
    }
  }

  private readDismissed(): boolean {
    try {
      return !!localStorage.getItem(DISMISS_KEY);
    } catch {
      return false;
    }
  }
}
