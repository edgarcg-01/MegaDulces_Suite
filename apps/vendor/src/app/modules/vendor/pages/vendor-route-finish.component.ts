import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';
import { timeout } from 'rxjs';
import type { SellerRouteDay } from '@megadulces/contracts';
import { RouteDayService, horaMx } from '../route-day.service';

/**
 * `[MCP.3.6]` El aviso al cerrar la ruta: primero a cuántos clientes llegó; luego, en una frase,
 * qué le llegó al surtidor (sin contar pedidos: el vendedor mide su ruta por clientes).
 */
export function avisoAlFinalizar(d: Pick<SellerRouteDay, 'visited' | 'orders'>): string {
  const n = Number(d.visited) || 0;
  const visitas = n === 1 ? 'Visitaste 1 cliente.' : `Visitaste ${n} clientes.`;
  return d.orders > 0 ? `${visitas} Al surtidor le llegó tu pedido.` : `${visitas} No hubo pedidos que mandar al surtidor.`;
}

/**
 * `[MCP.3.6]` Confirmación de «Finalizar ruta». Lee la ruta de hoy para mostrar cuántos clientes
 * visitó (el dato principal), desde qué hora va y cuánto vendió; al confirmar, el backend junta los
 * pedidos de la ruta en UN pedido para el surtidor. Si el resumen no carga se declara (no se pintan
 * ceros) y aun así se puede finalizar.
 */
@Component({
  selector: 'app-vendor-route-finish',
  standalone: true,
  imports: [SkeletonModule],
  template: `
    <section class="rf" aria-labelledby="rf-title">
      <h1 id="rf-title">Finalizar ruta</h1>

      @if (status() === 'loading') {
        <div role="status" aria-live="polite">
          <span class="sr-only">Cargando el resumen de tu ruta</span>
          <p-skeleton height="9rem"></p-skeleton>
        </div>
      } @else if (status() === 'error') {
        <div class="rf-warn" role="status">
          <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
          <span class="rf-warn-text">No pudimos cargar el resumen de tu ruta.</span>
          <button type="button" class="rf-retry" (click)="load()">Reintentar</button>
        </div>
      } @else if (notInRoute()) {
        <p class="rf-msg">
          {{ day()?.state === 'finalizada' ? 'Tu ruta ya está finalizada.' : 'Tu ruta no está iniciada.' }}
        </p>
      } @else if (day(); as d) {
        <!-- [MCP.3.6] El dato principal son los CLIENTES VISITADOS (pedido de David, 2026-10-21):
             la ruta se mide por a cuántos llegó, no por cuántos pedidos levantó. -->
        <dl class="rf-sum">
          <div class="rf-row rf-total">
            <dt>Clientes visitados</dt>
            <dd class="num">{{ d.visited }}</dd>
          </div>
          <div class="rf-row">
            <dt>Ruta</dt>
            <dd class="num">{{ startedAt() }} a {{ now }}</dd>
          </div>
          <div class="rf-row">
            <dt>Vendido</dt>
            <dd class="num">{{ money(d.total) }}</dd>
          </div>
        </dl>
      }

      @if (confirming() && !notInRoute()) {
        <div class="rf-confirm" role="alertdialog" aria-labelledby="rf-confirm-title" aria-describedby="rf-confirm-text">
          <p id="rf-confirm-title" class="rf-confirm-title">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            ¿Seguro que quieres cerrar tu ruta?
          </p>
          <p id="rf-confirm-text" class="rf-confirm-text">
            Al surtidor le llega tu pedido para surtirlo. Lo que levantes después le llega aparte, como pedido fuera de la ruta.
          </p>
          <div class="rf-acts">
            <button type="button" class="rf-primary" [disabled]="finishing()" (click)="finish()">
              <i class="pi" [class.pi-send]="!finishing()" [class.pi-spin]="finishing()" [class.pi-spinner]="finishing()" aria-hidden="true"></i>
              {{ finishing() ? 'Cerrando…' : 'Sí, cerrar mi ruta' }}
            </button>
            <button type="button" class="rf-secondary" [disabled]="finishing()" (click)="confirming.set(false)">
              No, seguir en ruta
            </button>
          </div>
        </div>
      } @else {
        <div class="rf-acts">
          @if (!notInRoute()) {
            <button
              type="button"
              class="rf-primary"
              [disabled]="status() === 'loading'"
              (click)="confirming.set(true)"
              >
              <i class="pi pi-send" aria-hidden="true"></i>
              Finalizar y mandar al surtidor
            </button>
          }
          <button type="button" class="rf-secondary" (click)="back()">
            {{ notInRoute() ? 'Volver a Mi ruta' : 'Seguir en ruta' }}
          </button>
        </div>
      }
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .rf { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4) 0; }
      .rf h1 { margin: 0; font-size: var(--fs-h1); font-weight: 800; letter-spacing: -0.02em; color: var(--text-main); }
      .rf-sum {
        margin: 0; border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg);
      }
      .rf-row {
        display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3);
        padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border-color);
      }
      .rf-row:last-child { border-bottom: none; }
      .rf-row dt { font-size: var(--fs-body); color: var(--text-muted); }
      .rf-row dd { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
      .rf-total dd { font-size: var(--fs-h2); font-weight: 800; }
      .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
      .rf-msg { margin: 0; font-size: var(--fs-body); color: var(--text-muted); }
      .rf-warn {
        display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
        background: var(--warn-soft-bg); border: 1px solid var(--warn-border); color: var(--warn-soft-fg); font-size: var(--fs-sm);
      }
      .rf-warn-text { flex: 1; min-width: 0; }
      .rf-retry {
        flex-shrink: 0; min-height: 2.75rem; padding: 0 var(--sp-3); border-radius: var(--r-pill);
        border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer;
        font-family: var(--font-body); font-size: var(--fs-xs); font-weight: 700;
      }
      .rf-confirm {
        display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border-radius: var(--r-lg);
        background: var(--warn-soft-bg); border: 1px solid var(--warn-border);
      }
      .rf-confirm-title {
        margin: 0; display: flex; align-items: center; gap: var(--sp-2);
        font-size: var(--fs-lg); font-weight: 800; color: var(--warn-soft-fg);
      }
      .rf-confirm-text { margin: 0; font-size: var(--fs-body); color: var(--text-main); line-height: 1.4; }
      .rf-acts { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-2); }
      .rf-primary, .rf-secondary {
        min-height: 3.25rem; border-radius: var(--r-lg); cursor: pointer;
        font-family: var(--font-body); font-size: var(--fs-body); font-weight: 700;
        display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
        transition: transform 0.08s var(--ease, ease);
      }
      .rf-primary { border: none; background: var(--action); color: var(--action-ink); }
      .rf-secondary { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); }
      .rf-primary:active:not(:disabled), .rf-secondary:active:not(:disabled) { transform: scale(0.98); }
      .rf-primary:disabled, .rf-secondary:disabled { opacity: 0.6; }
      .rf-primary:focus-visible, .rf-secondary:focus-visible, .rf-retry:focus-visible {
        outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px;
      }
      @media (prefers-reduced-motion: reduce) { .rf-primary, .rf-secondary { transition: none; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorRouteFinishComponent implements OnInit {
  private readonly api = inject(RouteDayService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly day = signal<SellerRouteDay | null>(null);
  readonly status = signal<'loading' | 'ok' | 'error'>('loading');
  readonly finishing = signal(false);
  /** [MCP.3.6] Cerrar la ruta pide confirmación: un toque por error le mandaría la ruta al surtidor. */
  readonly confirming = signal(false);
  readonly now = horaMx(new Date().toISOString());
  private readonly fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

  readonly startedAt = computed(() => horaMx(this.day()?.started_at));
  /** Sólo con el estado LEÍDO: un error no cuenta como «no está en ruta». */
  readonly notInRoute = computed(() => {
    const st = this.status();
    const state = this.day()?.state;
    return st === 'ok' && state !== 'en_ruta';
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.status.set('loading');
    this.api
      .today()
      .pipe(timeout(6000), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.day.set(d);
          this.status.set('ok');
        },
        error: () => this.status.set('error'),
      });
  }

  finish(): void {
    if (this.finishing()) return;
    this.finishing.set(true);
    this.api
      .finish()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.toast.add({
            severity: 'success',
            summary: 'Ruta finalizada',
            detail: avisoAlFinalizar(d),
          });
          this.router.navigate(['/vendor/route-home']);
        },
        error: (e) => {
          this.finishing.set(false);
          this.toast.add({
            severity: 'error',
            summary: 'No se pudo finalizar la ruta',
            detail: e?.error?.message || 'Revisa tu conexión e intenta de nuevo.',
          });
        },
      });
  }

  back(): void {
    this.router.navigate(['/vendor/route-home']);
  }

  money(n: unknown): string {
    return this.fmt.format(Number(n) || 0);
  }
}
