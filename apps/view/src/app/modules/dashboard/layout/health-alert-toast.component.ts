import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { Subscription } from 'rxjs';
import { AlertsSocketService } from '../command-center/alerts-socket.service';

/**
 * Toast GLOBAL de salud de datos. Se monta una vez en el layout del dashboard →
 * conecta al WS `/alerts` y muestra un toast cuando llega una alerta `db_health`
 * (feed caído / tabla congelada / recuperación), estés en la pantalla que estés.
 *
 * Autónomo: provee su propio MessageService + <p-toast> (no depende de que el
 * layout tenga toast). Solo filtra `db_health` para no meter ruido de otras alertas.
 * El registro persistente vive en /admin/db-health (bandeja).
 */
@Component({
  selector: 'app-health-alert-toast',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ToastModule],
  providers: [MessageService],
  template: `<p-toast position="bottom-right" key="dbhealth" [baseZIndex]="9000" />`,
})
export class HealthAlertToastComponent implements OnInit, OnDestroy {
  private readonly socket = inject(AlertsSocketService);
  private readonly toast = inject(MessageService);
  private sub?: Subscription;

  ngOnInit(): void {
    this.socket.connect();
    this.sub = this.socket.alert$.subscribe((a) => {
      if (a.type !== 'db_health') return;
      const resolved = a.data?.event === 'resolved';
      this.toast.add({
        key: 'dbhealth',
        severity: resolved ? 'success' : (a.severity === 'critical' ? 'error' : 'warn'),
        summary: a.title,
        detail: a.message,
        life: resolved ? 5000 : (a.severity === 'critical' ? 0 : 12000), // crítico = sticky
        sticky: !resolved && a.severity === 'critical',
      });
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.socket.disconnect();
  }
}
