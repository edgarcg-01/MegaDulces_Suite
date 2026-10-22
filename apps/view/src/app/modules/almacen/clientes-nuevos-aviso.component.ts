import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { NewCustomersSummary } from '@megadulces/contracts';
import { ClientesNuevosService } from './clientes-nuevos.service';

/**
 * `[MCP.3.8]` Aviso de la pantalla Surtir: «Hay N clientes nuevos sin clave de Kepler». Pieza
 * propia para que Surtir sólo la coloque (edición mínima en un archivo que tocan varias sesiones).
 * Emite los pedidos de esos clientes para que Surtir los marque «Cliente nuevo · sin clave».
 *
 * Error ≠ vacío: si no se pudo revisar, lo dice (con reintento) en vez de callarse como si no
 * hubiera ninguno. Sin clientes por ligar no pinta nada.
 */
@Component({
  selector: 'app-clientes-nuevos-aviso',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (resumen(); as r) {
      @if (r.customers > 0) {
        <a class="cna cna-warn" routerLink="/almacen/clientes-nuevos" role="status">
          <i class="pi pi-user-plus" aria-hidden="true"></i>
          <span class="cna-txt">
            <strong>{{ r.customers === 1 ? '1 cliente nuevo' : r.customers + ' clientes nuevos' }} sin clave de Kepler</strong>
            @if (r.order_ids.length) {
              <span class="cna-sub">{{ r.order_ids.length === 1 ? '1 pedido suyo espera' : r.order_ids.length + ' pedidos suyos esperan' }} · no se cobran en Kepler hasta ligarlos</span>
            }
          </span>
          <span class="cna-ir">Ligar <i class="pi pi-chevron-right" aria-hidden="true"></i></span>
        </a>
      }
    } @else if (fallo()) {
      <button type="button" class="cna cna-muted" (click)="cargar()">
        <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
        <span class="cna-txt">No se pudo revisar si hay clientes nuevos sin clave de Kepler.</span>
        <span class="cna-ir">Reintentar</span>
      </button>
    }
  `,
  styles: [`
    :host { display: block; }
    .cna { display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-height: var(--tap-min); margin-bottom: var(--sp-3);
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); border: 1px solid; text-align: left; text-decoration: none;
      font-size: var(--fs-body); cursor: pointer; background: var(--card-bg); }
    .cna-warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .cna-muted { color: var(--text-muted); border-color: var(--border-color); }
    .cna-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .cna-sub { font-size: var(--fs-sm); }
    .cna-ir { white-space: nowrap; font-weight: var(--fw-bold); }
    .cna:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class ClientesNuevosAvisoComponent implements OnInit {
  private readonly api = inject(ClientesNuevosService);
  private readonly destroyRef = inject(DestroyRef);

  /** Pedidos de clientes sin clave de Kepler (para marcarlos en la lista de Surtir). */
  readonly sinClave = output<Set<string>>();

  readonly resumen = signal<NewCustomersSummary | null>(null);
  readonly fallo = signal(false);

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.fallo.set(false);
    this.api.resumen().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resumen.set(r);
        this.sinClave.emit(new Set(r.order_ids));
      },
      error: () => {
        this.resumen.set(null);
        this.fallo.set(true);
      },
    });
  }
}
