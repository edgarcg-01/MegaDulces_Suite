import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';

/**
 * Apartado "Por entregar": pedidos faltantes de la cartera (preventa del Portal
 * B2B + de campo) en pending_approval / confirmed, con aprobar y marcar
 * entregado. Stub — se implementa en V.3 sobre VendorService.pendingDeliveries()
 * / approve() / fulfill() (ya disponibles en backend).
 */
@Component({
  selector: 'app-vendor-pending',
  standalone: true,
  imports: [CommonModule, CardModule],
  template: `
    <h1 class="page-title">Por entregar</h1>
    <p-card>
      <div class="soon">
        <i class="pi pi-truck"></i>
        <p>Acá vas a ver los pedidos pendientes de tu cartera —los que tomaste y los que el cliente pidió por su cuenta— para aprobarlos y marcarlos como entregados.</p>
        <span class="badge">Disponible pronto</span>
      </div>
    </p-card>
  `,
  styles: [
    `
      .page-title { margin: 0 0 1rem; font-size: 1.5rem; color: var(--text-main); }
      .soon { text-align: center; padding: 1.5rem 1rem; color: var(--text-muted); }
      .soon i { font-size: 2.5rem; display: block; margin-bottom: 0.75rem; color: var(--brand-700); }
      .soon p { margin: 0 0 1rem; line-height: 1.5; }
      .badge {
        display: inline-block;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.25rem 0.625rem;
        border-radius: 999px;
        background: var(--surface-100);
        color: var(--text-muted);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorPendingComponent {}
