import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ImpuestosService, ProvisionalResult } from '../impuestos.service';

/**
 * FISCAL.18 — Pago provisional ISR + IVA (Operations). ⚠️ Cálculo de APOYO —
 * validar con contador. El coeficiente de utilidad es input (declaración anual
 * del ejercicio anterior). ISR desde balanza; IVA con flujo efectivo PUE/PPD.
 */
@Component({
  selector: 'app-contabilidad-impuestos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head im-head">
        <div class="surf-page-head-text">
          <h1>Impuestos provisionales</h1>
          <p class="surf-page-sub">Pago provisional mensual ISR + IVA. Cálculo de apoyo desde la balanza y los CFDI con flujo efectivo.</p>
        </div>
      </header>

      <div class="im-warn"><i class="pi pi-exclamation-triangle"></i> Cálculo de <strong>apoyo</strong> — validar con contador antes de declarar. El coeficiente de utilidad proviene de la declaración anual del ejercicio anterior.</div>

      <div class="card-premium card-flat im-form">
        <div class="im-fields">
          <label class="im-f"><span>Periodo *</span><input type="month" [(ngModel)]="p.period" /></label>
          <label class="im-f"><span>Coef. utilidad *</span><input type="number" step="0.0001" min="0" pInputText [(ngModel)]="p.cu" placeholder="0.0500" /></label>
          <label class="im-f"><span>Tasa ISR</span><input type="number" step="0.01" pInputText [(ngModel)]="p.tasa" placeholder="0.30" /></label>
          <label class="im-f"><span>PTU pagada</span><input type="number" step="0.01" pInputText [(ngModel)]="p.ptu" placeholder="0" /></label>
          <label class="im-f"><span>Pérdidas pend.</span><input type="number" step="0.01" pInputText [(ngModel)]="p.perdidas" placeholder="0" /></label>
          <label class="im-f"><span>Pagos previos</span><input type="number" step="0.01" pInputText [(ngModel)]="p.pagos_previos" placeholder="0" /></label>
          <label class="im-f"><span>ISR retenido</span><input type="number" step="0.01" pInputText [(ngModel)]="p.retenido" placeholder="0" /></label>
          <button pButton type="button" label="Calcular" icon="pi pi-calculator" class="p-button-sm" [loading]="loading()" [disabled]="!valid()" (click)="calc()"></button>
        </div>
      </div>

      @if (res(); as r) {
        <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen de impuestos" />


        <div class="im-grid">
          <div class="card-premium card-flat im-block">
            <h3 class="im-block-title">ISR provisional</h3>
            <dl class="im-dl">
              <div><dt>Ingresos nominales acum.</dt><dd class="mono">{{ money(r.isr.ingresos_nominales_acumulados) }}</dd></div>
              <div><dt>× Coeficiente utilidad</dt><dd class="mono">{{ r.isr.coeficiente_utilidad }}</dd></div>
              <div><dt>= Utilidad estimada</dt><dd class="mono">{{ money(r.isr.utilidad_estimada) }}</dd></div>
              <div><dt>− PTU / pérdidas</dt><dd class="mono">{{ money(r.isr.ptu_pagada + r.isr.perdidas_pendientes) }}</dd></div>
              <div><dt>= Base gravable</dt><dd class="mono strong">{{ money(r.isr.base_gravable) }}</dd></div>
              <div><dt>× Tasa ISR ({{ r.isr.tasa_isr }})</dt><dd class="mono">{{ money(r.isr.isr_causado) }}</dd></div>
              <div><dt>− Pagos previos / retenido</dt><dd class="mono">{{ money(r.isr.pagos_provisionales_previos + r.isr.isr_retenido) }}</dd></div>
              <div class="im-total"><dt>ISR a pagar</dt><dd class="mono strong">{{ money(r.isr.isr_a_pagar) }}</dd></div>
            </dl>
          </div>
          <div class="card-premium card-flat im-block">
            <h3 class="im-block-title">IVA del periodo</h3>
            <dl class="im-dl">
              <div><dt>IVA trasladado (cobrado)</dt><dd class="mono">{{ money(r.iva.iva_trasladado) }}</dd></div>
              <div><dt>− IVA acreditable (pagado)</dt><dd class="mono">{{ money(r.iva.iva_acreditable) }}</dd></div>
              <div><dt>− IVA retenido</dt><dd class="mono">{{ money(r.iva.iva_retenido) }}</dd></div>
              <div class="im-total"><dt>{{ r.iva.iva_a_cargo > 0 ? 'IVA a cargo' : 'IVA a favor' }}</dt><dd class="mono strong">{{ money(r.iva.iva_a_cargo > 0 ? r.iva.iva_a_cargo : r.iva.iva_a_favor) }}</dd></div>
            </dl>
          </div>
        </div>
        <p class="im-note">{{ r.nota }}</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .im-warn { display: flex; gap: .5rem; align-items: center; font-size: .82rem; color: var(--warn-soft-fg, #b45309); background: color-mix(in srgb, var(--warn-fg, #d97706) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn-fg, #d97706) 30%, var(--border-color)); border-radius: var(--r-md, 10px); padding: .6rem .9rem; margin-bottom: 1rem; }
    .im-form { padding: 1rem 1.2rem; margin-bottom: 1rem; }
    .im-fields { display: flex; gap: .8rem; flex-wrap: wrap; align-items: flex-end; }
    .im-f { display: flex; flex-direction: column; gap: .25rem; font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .im-f input { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); font-family: var(--font-mono, monospace); width: 8.5rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .im-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 800px) { .im-grid { grid-template-columns: 1fr; } }
    .im-block { padding: 1rem 1.2rem; }
    .im-block-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; color: var(--text-main); }
    .im-dl { margin: 0; display: flex; flex-direction: column; }
    .im-dl > div { display: flex; justify-content: space-between; align-items: baseline; padding: .3rem 0; font-size: .82rem; border-bottom: 1px solid var(--border-color); }
    .im-dl dt { color: var(--text-muted); margin: 0; } .im-dl dd { margin: 0; color: var(--text-main); }
    .im-dl .im-total { border-bottom: none; border-top: 2px solid var(--border-color); margin-top: .2rem; padding-top: .5rem; }
    .im-total dt { color: var(--text-main); font-weight: 700; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; } .strong { font-weight: 700; }
    .im-note { font-size: .75rem; color: var(--text-muted); font-style: italic; margin-top: 1rem; }
  `],
})
export class ContabilidadImpuestosComponent {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(ImpuestosService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  p: { period: string; cu: number | null; tasa: number | null; ptu: number | null; perdidas: number | null; pagos_previos: number | null; retenido: number | null } =
    { period: this.currentMonth(), cu: null, tasa: 0.30, ptu: 0, perdidas: 0, pagos_previos: 0, retenido: 0 };
  readonly res = signal<ProvisionalResult | null>(null);

  kpiItems(r: ProvisionalResult): MetricStripItem[] {
    const cargo = r.iva.iva_a_cargo > 0;
    return [
      { label: 'ISR a pagar', value: r.isr.isr_a_pagar, format: 'currency', tone: r.isr.isr_a_pagar > 0 ? 'bad' : 'default' },
      { label: cargo ? 'IVA a cargo' : 'IVA a favor', value: cargo ? r.iva.iva_a_cargo : r.iva.iva_a_favor, format: 'currency', tone: cargo ? 'bad' : (r.iva.iva_a_favor > 0 ? 'ok' : 'default') },
      { label: 'Total a pagar', value: r.total_a_pagar, format: 'currency', tone: 'brand' },
    ];
  }
  readonly loading = signal(false);

  valid(): boolean { return /^\d{4}-\d{2}$/.test(this.p.period) && this.p.cu != null && this.p.cu >= 0; }

  calc() {
    if (!this.valid()) { this.toast.add({ severity: 'warn', summary: 'Faltan datos', detail: 'Periodo y coeficiente de utilidad son requeridos.' }); return; }
    this.loading.set(true);
    this.svc.provisional({
      period: this.p.period, cu: Number(this.p.cu),
      tasa: this.p.tasa ?? undefined, ptu: this.p.ptu ?? undefined, perdidas: this.p.perdidas ?? undefined,
      pagos_previos: this.p.pagos_previos ?? undefined, retenido: this.p.retenido ?? undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.res.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo calcular el pago provisional.' }); },
    });
  }

  private currentMonth(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
  money(v: number | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
