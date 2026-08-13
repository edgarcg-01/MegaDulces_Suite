import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BankService, IngresosControl } from '../../bank.service';
import { money0, dmShort } from './bancos-shared';

/**
 * CB.35 — CONTROL de ingresos (no memo): ¿cada depósito del banco tiene origen?
 * Clasifica cada depósito contra tesorería Kepler + cobranza (UA0501) + caja de tienda,
 * con prioridad de fuente + consumo greedy. Lo que no case = EXCEPCIÓN accionable
 * (sin explicar → investigar). Además FUGA: caja registrada que no llegó al banco.
 * Read-only: consume /finance/bank/ingresos-control por periodo. Se embebe en Conciliación
 * y Concentrado (referencia compartida al lado de ingresos).
 */
@Component({
  selector: 'caja-ingreso-ref',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as c) {
      <div class="ic-card" [class.ic-ok]="c.cuadra" [class.ic-warn]="!c.cuadra">
        <div class="ic-head">
          <h3 class="ic-title">Control de ingresos <span class="muted">— ¿cada depósito del banco tiene origen? ({{ c.bank_n }} depósitos · {{ c.bank_total | currency:'MXN':'symbol-narrow':'1.0-0' }})</span></h3>
          @if (c.cuadra) {
            <span class="ic-verdict ok"><i class="pi pi-check-circle"></i> Cuadra</span>
          } @else {
            <span class="ic-verdict warn"><i class="pi pi-exclamation-triangle"></i> {{ c.sin_explicar.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} sin explicar</span>
          }
        </div>

        <div class="ic-grid">
          <div class="ic-cell"><span class="ic-l">Tesorería Kepler</span><span class="ic-v ok">{{ c.via_tesoreria.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="ic-s">{{ c.via_tesoreria.n }} · casó kdm1</span></div>
          <div class="ic-cell"><span class="ic-l">Cobranza cliente</span><span class="ic-v">{{ c.via_cobranza.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="ic-s">{{ c.via_cobranza.n }} · UA0501</span></div>
          <div class="ic-cell"><span class="ic-l">Depósito de tienda</span><span class="ic-v">{{ c.via_caja.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="ic-s">{{ c.via_caja.n }} · Caja</span></div>
          <div class="ic-cell ic-excn" [class.hot]="c.sin_explicar.n > 0"><span class="ic-l">Sin explicar</span><span class="ic-v" [class.bad]="c.sin_explicar.n > 0">{{ c.sin_explicar.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="ic-s">{{ c.sin_explicar.n }} depósitos</span></div>
        </div>

        <div class="ic-bar" role="img" [attr.aria-label]="'Explicado ' + pctExpl(c) + '%'">
          <span class="ic-seg tes" [style.width.%]="pct(c.via_tesoreria.monto, c.bank_total)"></span>
          <span class="ic-seg cob" [style.width.%]="pct(c.via_cobranza.monto, c.bank_total)"></span>
          <span class="ic-seg caj" [style.width.%]="pct(c.via_caja.monto, c.bank_total)"></span>
          <span class="ic-seg sin" [style.width.%]="pct(c.sin_explicar.monto, c.bank_total)"></span>
        </div>
        <p class="ic-note">
          <b class="ok">{{ pctExpl(c) }}% explicado</b> ({{ c.explicado | currency:'MXN':'symbol-narrow':'1.0-0' }}).
          @if (c.sin_explicar.n > 0) {
            El resto son depósitos que ninguna fuente explica — <b>revísalos</b> (¿transferencia no registrada? ¿ingreso ajeno? ¿otra cuenta/mes?).
          } @else { Todo depósito tiene origen. }
        </p>

        @if (c.sin_explicar.n > 0) {
          <button type="button" class="ic-toggle" (click)="open.set(!open())" [attr.aria-expanded]="open()">
            <i class="pi" [class.pi-chevron-right]="!open()" [class.pi-chevron-down]="open()"></i>
            {{ open() ? 'Ocultar' : 'Ver' }} los {{ c.sin_explicar.n }} depósitos sin explicar
          </button>
          @if (open()) {
            <div class="ic-tablewrap">
              <table class="ic-table">
                <thead><tr><th>Fecha</th><th>Cuenta</th><th class="ta-r">Monto</th><th>Concepto</th></tr></thead>
                <tbody>
                  @for (e of c.exceptions; track e.id) {
                    <tr><td class="mono">{{ dmShort(e.fecha) }}</td><td class="mono">{{ e.account_label || e.bank || '—' }}</td>
                        <td class="ta-r mono bad">{{ e.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                        <td class="ic-concept" [title]="e.concept">{{ e.concept || '—' }}</td></tr>
                  }
                </tbody>
              </table>
              @if (c.sin_explicar.n > c.exceptions.length) { <p class="ic-more muted">… y {{ c.sin_explicar.n - c.exceptions.length }} más (mostrando los {{ c.exceptions.length }} mayores).</p> }
            </div>
          }
        }

        @if (c.fuga.n > 0) {
          <p class="ic-fuga"><i class="pi pi-arrow-circle-up"></i> <b>Fuga:</b> {{ c.fuga.monto | currency:'MXN':'symbol-narrow':'1.0-0' }} en {{ c.fuga.n }} depósitos que Caja registró pero <b>no llegaron al banco</b> (rezago / no depositado). <a routerLink="/finanzas/caja" class="ic-link">Ver en Caja General <i class="pi pi-arrow-right"></i></a></p>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .ic-card { background: var(--surface, var(--card-bg)); border: 1px solid var(--border-color); border-left: 3px solid var(--border-color); border-radius: var(--r-md); padding: 1rem 1.1rem; margin-bottom: var(--sp-3, .75rem); }
    .ic-card.ic-ok { border-left-color: var(--ok-fg); } .ic-card.ic-warn { border-left-color: var(--warn-fg); }
    .ic-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-3, .75rem); }
    .ic-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0; }
    .muted { color: var(--text-muted); font-weight: 400; }
    .ic-verdict { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 700; white-space: nowrap; padding: 2px var(--sp-2); border-radius: var(--r-pill); }
    .ic-verdict.ok { color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); }
    .ic-verdict.warn { color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 12%, transparent); }
    .ic-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-3, .75rem); }
    .ic-cell { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3, .75rem); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ic-cell.ic-excn.hot { border-color: var(--warn-fg); background: color-mix(in srgb, var(--warn-fg) 6%, transparent); }
    .ic-l { font-size: var(--fs-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .ic-v { font-size: var(--fs-lg, 1.125rem); font-weight: 700; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ic-v.ok { color: var(--ok-fg); } .ic-v.bad { color: var(--warn-fg); }
    .ic-s { font-size: var(--fs-xs); color: var(--text-faint); }
    .ic-bar { display: flex; height: 8px; border-radius: var(--r-pill); overflow: hidden; margin: var(--sp-3) 0 var(--sp-2); background: var(--border-color); }
    .ic-seg { height: 100%; } .ic-seg.tes { background: var(--ok-fg); } .ic-seg.cob { background: var(--chart-2, #6b8fb5); } .ic-seg.caj { background: var(--chart-4, #b58f6b); } .ic-seg.sin { background: var(--warn-fg); }
    .ic-note { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2, .5rem) 0 0; line-height: 1.4; }
    .ok { color: var(--ok-fg); } .bad { color: var(--warn-fg); }
    .ic-toggle { display: inline-flex; align-items: center; gap: 6px; margin-top: var(--sp-3); background: none; border: none; color: var(--action); font-weight: 600; font-size: var(--fs-sm); cursor: pointer; padding: 0; }
    .ic-toggle:hover { text-decoration: underline; }
    .ic-tablewrap { margin-top: var(--sp-2); overflow-x: auto; }
    .ic-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ic-table th { text-align: left; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border-color); }
    .ic-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-color); }
    .ta-r { text-align: right; } .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .ic-concept { max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .ic-more { font-size: var(--fs-xs); margin: var(--sp-2) 0 0; }
    .ic-fuga { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-3) 0 0; line-height: 1.4; }
    .ic-link { color: var(--action); font-weight: 600; text-decoration: none; white-space: nowrap; }
    .ic-link:hover { text-decoration: underline; }
  `],
})
export class CajaIngresoRefComponent {
  readonly period = input<string>('');
  private readonly api = inject(BankService);
  private readonly destroyRef = inject(DestroyRef);
  readonly data = signal<IngresosControl | null>(null);
  readonly open = signal(false);
  dmShort = dmShort;
  money0 = money0;
  private seq = 0;

  constructor() {
    effect(() => {
      const p = this.period();
      if (!p || !/^\d{4}-\d{2}$/.test(p)) { this.data.set(null); return; }
      const token = ++this.seq;
      this.open.set(false);
      this.api.ingresosControl(p).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { if (token === this.seq) this.data.set(d); },
        error: () => { if (token === this.seq) this.data.set(null); },
      });
    });
  }

  pct(part: number, total: number): number { return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0; }
  pctExpl(c: IngresosControl): number { return c.bank_total > 0 ? Math.round((c.explicado / c.bank_total) * 100) : 0; }
}
