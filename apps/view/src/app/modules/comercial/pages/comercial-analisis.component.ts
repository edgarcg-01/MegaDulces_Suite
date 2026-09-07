import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, SellOutReport } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { REPORTS_TABS } from '../reports-tabs';

/**
 * BI.0 — Sub-modulo "Analisis" (Sell-Out BI). Andamio: reusa el SellOutReport del
 * reporte base (misma verdad verificada a factura) y expone los KPIs. Sobre esto
 * montan las capacidades BI: Explica el cambio (BI.3), Preguntale (BI.5) y Radar
 * (BI.6). El reporte /comercial/sell-out NO se toca; este es su hermano de exploracion.
 */
@Component({
  selector: 'app-comercial-analisis',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DatePickerModule, ToastModule, PageTabsComponent, MetricStripComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="reportTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Análisis</h1>
          <p>Explora la misma venta del Sell-Out — pero para responder: qué cambió, por qué, y qué se movió raro. Misma verdad que el reporte, otra forma de interrogarla.</p>
        </div>
      </header>

      <section class="an-filter">
        <label>
          <span>Mes</span>
          <p-datepicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true" [readonlyInput]="true" />
        </label>
        <button pButton type="button" label="Generar" icon="pi pi-play" (click)="generate()" [loading]="loading()"></button>
      </section>

      @if (report(); as r) {
        <app-metric-strip [items]="kpiItems()" />
      }

      <section class="an-grid">
        <article class="an-card" [class.ready]="false">
          <i class="pi pi-arrows-h"></i>
          <h3>Explica el cambio</h3>
          <p>Ante una caída o subida, descompone al centavo quién la movió — marca, sucursal, vendedor, canal. Causa raíz navegable sobre dato verificado.</p>
          <span class="an-soon">Próximamente · BI.3</span>
        </article>
        <article class="an-card">
          <i class="pi pi-comments"></i>
          <h3>Pregúntale al Sell-Out</h3>
          <p>En español: "¿por qué bajó Padre Hidalgo en agosto?", "top 5 marcas que cayeron vs julio". Números del modelo, no inventados.</p>
          <span class="an-soon">Próximamente · BI.5</span>
        </article>
        <article class="an-card">
          <i class="pi pi-bell"></i>
          <h3>Radar</h3>
          <p>El tablero te avisa qué se movió raro sin que preguntes: caídas contra el promedio, marcas que aparecen o desaparecen.</p>
          <span class="an-soon">Próximamente · BI.6</span>
        </article>
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .an-filter { display: flex; align-items: flex-end; gap: 1rem; margin: 0 0 1.25rem; flex-wrap: wrap; }
    .an-filter label { display: flex; flex-direction: column; gap: .35rem; }
    .an-filter label > span { font-size: .75rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted); }
    .an-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .an-card { border: 1px solid var(--border-color); border-radius: var(--radius-lg, 14px); padding: 1.25rem; background: var(--surface-card, #fff); display: flex; flex-direction: column; gap: .5rem; }
    .an-card > i { font-size: 1.4rem; color: var(--text-muted); }
    .an-card h3 { margin: 0; font-size: 1rem; }
    .an-card p { margin: 0; font-size: .85rem; color: var(--text-muted); line-height: 1.45; }
    .an-soon { margin-top: auto; font-size: .72rem; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--text-muted); opacity: .8; }
  `],
})
export class ComercialAnalisisComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly reportTabs = REPORTS_TABS;
  monthDate: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  readonly report = signal<SellOutReport | null>(null);
  readonly loading = signal(false);

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    return [
      { label: 'Monto total', value: r.grand_total.monto, format: 'currency', sub: 'Sell-out del periodo' },
      { label: 'Cajas', value: r.grand_total.cajas, format: 'decimal1', sub: 'Unidades ÷ UXC' },
      { label: 'Empresas', value: r.rows.length, sub: 'Con venta' },
      { label: 'Sucursales', value: r.coverage.branches_with_data.length, sub: r.columns.length + ' columnas' },
    ];
  });

  generate() {
    const d = this.monthDate;
    if (!d) { this.toast.add({ severity: 'warn', summary: 'Selecciona un mes' }); return; }
    const from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
    const to = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    this.loading.set(true);
    this.svc
      .sellOut({ from, to })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo generar el análisis' }); },
      });
  }

  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
