import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { Subscription } from 'rxjs';
import { AlertsSocketService } from '../command-center/alerts-socket.service';
import { DesktopNoticeService } from '../../../core/services/desktop-notice.service';
import { irConservandoPanel } from '../../../core/panel/ir-conservando-panel';
import { avisoAnunciable } from '../../servicio/aviso-solicitud';

/**
 * `[MS.AVISO]` Ventana emergente cuando entra una solicitud nueva a la Mesa de Servicio, en cualquier pantalla de la Suite
 * mientras la sesión esté abierta.
 *
 * Vive en el layout, hermana de la campana y del toast de salud, y comparte el socket `/alerts` (cuenta de referencias en
 * `AlertsSocketService`). Sólo escucha el PUSH: lo que ya estaba en la bandeja al abrir la sesión no se anuncia —eso lo cuenta la
 * campana—, y sólo le llega a quien el servidor eligió (quien atiende la cola de esa solicitud).
 *
 * Si la pestaña no se está viendo, además sale el aviso del sistema operativo (cuando la persona dio permiso). Si no hay permiso,
 * la ventana queda esperando en la página: no se finge nada.
 *
 * Posición arriba a la derecha: abajo a la derecha ya la ocupa el toast de salud de la base y se taparían.
 */
@Component({
  selector: 'app-service-desk-aviso-toast',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ToastModule],
  providers: [MessageService],
  template: `
    <p-toast position="top-right" key="sd-aviso" [baseZIndex]="9000">
      <ng-template #message let-message>
        <button type="button" class="sd-aviso" (click)="abrir(message.data?.route)">
          <i class="pi pi-ticket sd-aviso__icono" aria-hidden="true"></i>
          <span class="sd-aviso__texto">
            <span class="sd-aviso__titulo">{{ message.summary }}</span>
            <span class="sd-aviso__detalle">{{ message.detail }}</span>
            <span class="sd-aviso__accion">Abrir en la bandeja</span>
          </span>
        </button>
      </ng-template>
    </p-toast>
  `,
  styles: [`
    .sd-aviso { display: flex; gap: var(--sp-3); align-items: flex-start; width: 100%; padding: 0; background: none; border: 0; text-align: left; color: inherit; cursor: pointer; font: inherit; }
    .sd-aviso:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .sd-aviso__icono { margin-top: 2px; }
    .sd-aviso__texto { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .sd-aviso__titulo { font-weight: 600; }
    .sd-aviso__detalle { font-size: var(--fs-sm); overflow-wrap: anywhere; }
    .sd-aviso__accion { font-size: var(--fs-xs); text-decoration: underline; }
  `],
})
export class ServiceDeskAvisoToastComponent implements OnInit, OnDestroy {
  private readonly socket = inject(AlertsSocketService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly escritorio = inject(DesktopNoticeService);
  private sub?: Subscription;

  ngOnInit(): void {
    this.socket.connect();
    this.sub = this.socket.alert$.subscribe((a) => {
      const aviso = avisoAnunciable(a);
      if (!aviso) return;
      this.toast.add({
        key: 'sd-aviso',
        severity: aviso.urgente ? 'error' : a.severity === 'warn' ? 'warn' : 'info',
        summary: aviso.title,
        detail: aviso.message,
        data: { route: aviso.route },
        // Lo urgente no se cierra solo; lo demás se queda lo bastante para leerse sin apuro.
        sticky: aviso.urgente,
        life: 20000,
      });
      // Pestaña oculta: la ventana de la página no la va a ver nadie. El aviso del sistema sí.
      if (typeof document !== 'undefined' && document.hidden) {
        this.escritorio.mostrar(aviso.title, aviso.message, () => this.abrir(aviso.route), 'sd-aviso');
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.socket.disconnect();
  }

  abrir(route?: string): void {
    this.toast.clear('sd-aviso');
    irConservandoPanel(this.router, route || '/servicio/bandeja');
  }
}
