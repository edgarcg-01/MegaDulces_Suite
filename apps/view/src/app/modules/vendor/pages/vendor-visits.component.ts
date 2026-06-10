import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';

/**
 * Apartado "Por visitar": cobertura del día sobre la cartera ordenada por
 * visit_sequence, con check-in explícito por cliente. Stub — se implementa en
 * V.4 (requiere registro de visitas/check-in).
 */
@Component({
  selector: 'app-vendor-visits',
  standalone: true,
  imports: [CommonModule, CardModule],
  template: `
    <h1 class="page-title">Por visitar</h1>
    <p-card>
      <div class="soon">
        <i class="pi pi-map-marker"></i>
        <p>Acá vas a recorrer tu cartera en orden de visita y marcar cada cliente como visitado (check-in), para llevar tu cobertura del día.</p>
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
export class VendorVisitsComponent {}
