import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { NearbyCustomer } from '../vendor.service';

/**
 * `[MCP.3.7]` Tarjeta de llegada de «Mi ruta»: el vendedor está a menos de 80 m de un cliente de
 * su ruta. Nombre, dirección y un solo botón grande. Abrir al cliente registra la visita (eso lo
 * hace quien escucha `open`). Sin texto de relleno: lo pidió el usuario.
 */
@Component({
  selector: 'app-vendor-arrival-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (customer(); as c) {
      <section class="arr" aria-labelledby="arr-name">
        <p class="arr-ey">
          <i class="pi pi-map-marker" aria-hidden="true"></i>
          Llegaste · a {{ c.distance_m }} m del cliente
        </p>
        <h2 class="arr-name" id="arr-name">{{ c.name }}</h2>
        @if (c.address) {
          <p class="arr-addr">{{ c.address }}</p>
        }
        @if (pendingLabel()) {
          <p class="arr-pend"><i class="pi pi-inbox" aria-hidden="true"></i> {{ pendingLabel() }}</p>
        }
        <button type="button" class="arr-btn" [disabled]="busy()" (click)="open.emit(c)">
          <i class="pi" [class.pi-spin]="busy()" [class.pi-spinner]="busy()" [class.pi-arrow-right]="!busy()" aria-hidden="true"></i>
          Abrir cliente
        </button>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .arr {
      margin-bottom: 0.875rem; padding: 0.9rem 1rem 1rem; border-radius: var(--r-lg, 16px);
      background: var(--card-bg); border: 1px solid var(--action);
    }
    .arr-ey {
      margin: 0; display: flex; align-items: center; gap: 0.35rem;
      font-size: var(--fs-sm); font-weight: 700; color: var(--action);
    }
    .arr-name { margin: 0.25rem 0 0; font-size: 1.25rem; font-weight: 800; line-height: 1.15; color: var(--text-main); overflow-wrap: anywhere; }
    .arr-addr { margin: 0.2rem 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .arr-pend { margin: 0.35rem 0 0; display: flex; align-items: center; gap: 0.35rem; font-size: var(--fs-sm); font-weight: 700; color: var(--warn-soft-fg); }
    .arr-btn {
      margin-top: 0.8rem; width: 100%; min-height: 3.25rem; border: none; border-radius: var(--r-lg, 16px);
      background: var(--action); color: var(--action-ink); font-weight: 800; font-size: 1.05rem;
      display: flex; align-items: center; justify-content: center; gap: 0.55rem; cursor: pointer;
      transition: transform 0.08s var(--ease, ease);
    }
    .arr-btn:active:not(:disabled) { transform: scale(0.98); }
    .arr-btn:disabled { opacity: 0.6; }
    .arr-btn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .arr-btn { transition: none; } }
  `],
})
export class VendorArrivalCardComponent {
  readonly customer = input<NearbyCustomer | null>(null);
  /** Pedido pendiente del cliente (ya formateado), o null. */
  readonly pendingLabel = input<string | null>(null);
  readonly busy = input(false);
  readonly open = output<NearbyCustomer>();
}
