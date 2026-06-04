import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { VendorCloseRouteComponent } from '../../vendor/pages/vendor-close-route.component';

/**
 * Apartado "Agregar ticket" del módulo Trade. Reusa el flujo de cierre de ruta
 * del vendedor (3 tipos: venta/carga/combustible + foto + OCR). El wrapper provee
 * MessageService + <p-toast> porque VendorCloseRouteComponent inyecta MessageService
 * de un ancestor (en el shell de vendor lo da el shell; acá lo damos nosotros).
 */
@Component({
  selector: 'app-dashboard-route-tickets',
  standalone: true,
  imports: [ToastModule, VendorCloseRouteComponent],
  providers: [MessageService],
  template: `
    <p-toast></p-toast>
    <app-vendor-close-route></app-vendor-close-route>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardRouteTicketsComponent {}
