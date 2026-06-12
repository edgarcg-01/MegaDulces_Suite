import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PushService } from './push.service';

const DISMISS_KEY = 'portal:push:dismissed';

/**
 * Invitación a activar notificaciones de pedidos (Fase 3).
 * Aparece solo si el push está soportado (SW activo) y el permiso aún no se
 * pidió (`default`). Descartable con memoria. El botón es el gesto que dispara
 * el permiso del navegador.
 */
@Component({
  selector: 'app-push-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (show()) {
      <div class="push-prompt" role="dialog" aria-label="Activar notificaciones">
        <i class="pi pi-bell" aria-hidden="true"></i>
        <div class="push-prompt-body">
          <strong>Notificaciones de tus pedidos</strong>
          <span>Te avisamos cuando tu pedido se confirme y vaya en camino.</span>
        </div>
        <button type="button" class="push-prompt-btn" (click)="enable()" [disabled]="busy()">
          {{ busy() ? 'Activando…' : 'Activar' }}
        </button>
        <button type="button" class="push-prompt-x" (click)="dismiss()" aria-label="Ahora no">
          <i class="pi pi-times" aria-hidden="true"></i>
        </button>
      </div>
    }
  `,
  styles: [`
    .push-prompt {
      position: fixed;
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
      z-index: 9996;
      margin-inline: auto;
      max-width: 460px;
      display: flex;
      align-items: center;
      gap: .75rem;
      padding: .75rem 1rem;
      border-radius: 16px;
      background: #16130F;
      color: #fff;
      box-shadow: 0 12px 32px rgba(0,0,0,.22);
    }
    .push-prompt > .pi-bell { color: #FDE707; font-size: 1.1rem; }
    .push-prompt-body { display: flex; flex-direction: column; gap: .1rem; font-size: .8125rem; line-height: 1.25; }
    .push-prompt-body strong { font-size: .9375rem; }
    .push-prompt-btn {
      flex: none; margin-left: auto; border: 0; cursor: pointer; font-weight: 700;
      color: #16130F; background: #FDE707; padding: .5rem .9rem; border-radius: 999px;
    }
    .push-prompt-btn:disabled { opacity: .6; cursor: default; }
    .push-prompt-x { flex: none; border: 0; background: transparent; color: #fff; opacity: .6; cursor: pointer; padding: .25rem; }
    .push-prompt-x:hover { opacity: 1; }
  `],
})
export class PushPromptComponent {
  private readonly push = inject(PushService);
  private readonly dismissed = signal(this.readDismissed());
  protected readonly busy = signal(false);

  protected readonly show = computed(
    () => this.push.supported && this.push.permission() === 'default' && !this.dismissed(),
  );

  protected async enable(): Promise<void> {
    this.busy.set(true);
    await this.push.enable();
    this.busy.set(false);
    this.dismiss(); // se haya aceptado o no, no volver a insistir
  }

  protected dismiss(): void {
    this.dismissed.set(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* dura la sesión */
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
