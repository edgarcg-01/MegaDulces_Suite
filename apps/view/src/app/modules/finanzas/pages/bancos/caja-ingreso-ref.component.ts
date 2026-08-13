import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { environment } from '../../../../../environments/environment';

/** Descomposición de ingresos de Caja General (CG.9). */
interface CajaIngresoRef { totals: { matched: number; caja_only: number; cobranza: number; residual: number } }

/**
 * Referencia compartida (CB.ref) — adjunta en los apartados de Bancos la descomposición
 * del ingreso bancario desde Caja General: depósito de tienda + fuga + cobranza + residual.
 * Resuelve el "memo de ingresos". Bancos REFERENCIA a Caja, no duplica la lógica.
 * Read-only: consume /finance/caja/conciliacion-detalle por periodo.
 */
@Component({
  selector: 'caja-ingreso-ref',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as ci) {
      <div class="cr-card">
        <h3 class="cr-title">Ingresos — de dónde vienen <span class="muted">— referencia de Caja General (el ingreso del banco, descompuesto)</span></h3>
        <div class="cr-grid">
          <div class="cr-cell"><span class="cr-l">Depósito de tienda</span><span class="cr-v ok">{{ ci.totals.matched | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="cr-s">Caja → banco</span></div>
          <div class="cr-cell"><span class="cr-l">Caja sin banco</span><span class="cr-v" [class.warn]="ci.totals.caja_only > 0">{{ ci.totals.caja_only | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="cr-s">fuga/rezago</span></div>
          <div class="cr-cell"><span class="cr-l">Cobranza de cliente</span><span class="cr-v">{{ ci.totals.cobranza | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="cr-s">cobros Kepler</span></div>
          <div class="cr-cell"><span class="cr-l">Residual</span><span class="cr-v">{{ ci.totals.residual | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="cr-s">directo/financiero</span></div>
        </div>
        <p class="cr-note">El ingreso del banco se explica como <b>depósito de tienda</b> (Caja) + <b>cobranza de cliente</b> + un <b>residual</b> honesto (transferencias directas, financiero). <a routerLink="/finanzas/caja" class="cr-link">Ver detalle en Caja General → Conciliación <i class="pi pi-arrow-right"></i></a></p>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .cr-card { background: var(--surface, var(--card-bg)); border: 1px solid var(--border-color); border-left: 3px solid var(--action); border-radius: var(--r-md); padding: 1rem 1.1rem; margin-bottom: var(--sp-3, .75rem); }
    .cr-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3, .75rem); }
    .muted { color: var(--text-muted); font-weight: 400; }
    .cr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--sp-3, .75rem); }
    .cr-cell { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3, .75rem); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .cr-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .cr-v { font-size: var(--fs-lg, 1.125rem); font-weight: 700; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cr-v.ok { color: var(--ok-fg); } .cr-v.warn { color: var(--warn-fg); }
    .cr-s { font-size: var(--fs-xs); color: var(--text-faint); }
    .cr-note { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2, .5rem) 0 0; line-height: 1.4; }
    .cr-link { color: var(--action); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .cr-link:hover { text-decoration: underline; }
  `],
})
export class CajaIngresoRefComponent {
  readonly period = input<string>('');
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  readonly data = signal<CajaIngresoRef | null>(null);
  private seq = 0;
  constructor() {
    effect(() => {
      const p = this.period();
      if (!p || !/^\d{4}-\d{2}$/.test(p)) { this.data.set(null); return; }
      // Guard de secuencia: al cambiar rápido de periodo, ignora la respuesta vieja (evita que
      // gane la del mes anterior y muestre datos que no corresponden al periodo actual).
      const token = ++this.seq;
      this.http.get<CajaIngresoRef>(`${environment.apiUrl}/finance/caja/conciliacion-detalle?month=${p}`)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (d) => { if (token === this.seq) this.data.set(d); },
          error: () => { if (token === this.seq) this.data.set(null); },
        });
    });
  }
}
