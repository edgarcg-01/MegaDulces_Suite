import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { EntradasSinOcResumen } from '@megadulces/contracts';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ENTRADAS_CONTROL_TABS } from '../entradas-control-tabs';
import { EntradasService } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';

/**
 * [RE.35.3] Control de entradas · Sin orden de compra.
 *
 * La OC es obligatoria sin excepción (decisión de Francisco, ADR-085): una entrada sin OC nunca pasa
 * sola en el expediente. Lo que sube el porcentaje automático no es aflojar la regla sino que la
 * captura la registre. Esta pestaña dice DÓNDE y QUIÉN, para corregir en el origen.
 * Kepler guarda quién capturó el vale de entrada, no quién pidió la mercancía.
 */
@Component({
  selector: 'app-compras-entradas-sin-oc',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, SegmentedComponent, LoadStateComponent, PageTabsComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <div class="surf-page in so">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Control de entradas · Sin orden de compra</h1>
          <p class="surf-page-sub">
            Una entrada sin orden de compra <strong>nunca pasa sola</strong> en el expediente de la factura.
            Acá se ve dónde se captura sin OC y quién la capturó en Kepler, para corregirlo en el origen.
            Kepler registra quién <strong>capturó</strong> la entrada, no quién pidió la mercancía.
          </p>
        </div>
        <div class="so-head">
          <app-segmented [options]="periodoOpts" [value]="periodo()" (valueChange)="setPeriodo($any($event))" ariaLabel="Periodo" />
          <app-freshness-pill measures="fetch" [since]="cargadoAt()" [staleAfterSec]="600" />
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (data()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Entradas sin orden de compra" />
      }

      @if (error()) {
        <app-load-state [error]="error()" (retry)="cargar()"></app-load-state>
      } @else {
        <section class="surf-card so-card">
          @if (loading() && !data()) {
            <p class="so-nota">Cargando…</p>
          } @else if (data(); as d) {
            @if (!d.filas.length) {
              <p class="so-nota">Ninguna entrada sin orden de compra del {{ d.desde }} al {{ d.hasta }}.</p>
            } @else {
              <div class="so-scroll">
                <table class="surf-table surf-table--plain surf-table--sticky so-table">
                  <thead>
                    <tr>
                      <th>Sucursal</th>
                      <th>Capturó en Kepler</th>
                      <th class="ta-r">Sin OC</th>
                      <th class="ta-r">De sus entradas</th>
                      <th class="so-bar-h">Proporción</th>
                      <th class="ta-r">Monto sin OC</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (f of d.filas; track f.sucursal + '|' + (f.usuario ?? '')) {
                      <tr>
                        <td>{{ sucursal(f.sucursal) }}</td>
                        <td class="mono">{{ f.usuario ?? 'sin dato' }}</td>
                        <td class="ta-r mono strong">{{ f.sin_oc }}</td>
                        <td class="ta-r mono">{{ f.entradas }}</td>
                        <td>
                          <div class="so-bar" role="img" [attr.aria-label]="pct(f.sin_oc, f.entradas) + ' sin orden de compra'">
                            <i [style.width.%]="(f.sin_oc / f.entradas) * 100"></i>
                          </div>
                          <span class="so-pct">{{ pct(f.sin_oc, f.entradas) }}</span>
                        </td>
                        <td class="ta-r mono">{{ money(f.monto_sin_oc) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .so-head { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .so-card { padding: 0; overflow: hidden; }
    .so-scroll { overflow-x: auto; }
    .so-table { width: 100%; }
    .ta-r { text-align: right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .strong { font-weight: 700; }
    .so-bar-h { width: 22%; }
    .so-bar { display: inline-block; vertical-align: middle; width: 70%; height: .5rem; border-radius: var(--r-sm); background: var(--surface-2); overflow: hidden; }
    .so-bar i { display: block; height: 100%; background: var(--warn-fg); }
    .so-pct { margin-left: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .so-nota { margin: 0; padding: var(--sp-3); color: var(--text-muted); }
  `],
})
export class ComprasEntradasSinOcComponent {
  private readonly svc = inject(EntradasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = ENTRADAS_CONTROL_TABS;
  readonly periodoOpts = [
    { label: '30 días', value: '30' },
    { label: '60 días', value: '60' },
    { label: '90 días', value: '90' },
  ];
  readonly periodo = signal<'30' | '60' | '90'>('30');
  readonly data = signal<EntradasSinOcResumen | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<number | null>(null);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Entradas del periodo', value: d.total_entradas },
      { label: 'Sin orden de compra', value: d.total_sin_oc, tone: 'warn' },
      { label: 'Proporción', value: this.pct(d.total_sin_oc, d.total_entradas) },
      { label: 'Monto sin OC', value: this.money(d.monto_sin_oc), tone: 'warn' },
    ];
  });

  constructor() { this.cargar(); }

  setPeriodo(v: '30' | '60' | '90'): void { this.periodo.set(v); this.cargar(); }

  cargar(): void {
    const hoy = new Date();
    const desde = new Date(hoy.getTime() - (Number(this.periodo()) - 1) * 864e5);
    const ymd = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    this.loading.set(true);
    this.error.set(null);
    this.svc.sinOc(ymd(desde), ymd(hoy)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); this.cargadoAt.set(Date.now()); },
      error: () => { this.loading.set(false); this.error.set('No se pudo cargar el tablero de entradas sin orden de compra.'); },
    });
  }

  sucursal(code: string): string { return branchName(code) || code; }
  pct(a: number, b: number): string { return b ? `${((100 * a) / b).toFixed(0)}%` : '—'; }
  money(n: number): string { return money(n); }
}
