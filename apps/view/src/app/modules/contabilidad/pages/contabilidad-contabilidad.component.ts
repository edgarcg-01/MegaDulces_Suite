import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { CONTABILIDAD_TABS } from '../contabilidad-tabs';
import { ContabilidadService } from '../contabilidad.service';

/**
 * FISCAL.9 — Contabilidad electrónica (Operations). Genera y descarga los XML que
 * exige el SAT: catálogo de cuentas y balanza de comprobación, desde la balanza
 * (analytics.ledger_monthly). ⚠️ CodAgrupador es placeholder (falta mapeo SAT).
 */
@Component({
  selector: 'app-contabilidad-contabilidad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head cb-head">
        <div class="surf-page-head-text">
          <h1>Contabilidad electrónica</h1>
          <p class="surf-page-sub">Genera los XML que exige el SAT desde la balanza contable: catálogo de cuentas y balanza de comprobación (1.3).</p>
        </div>
      </header>

      <div class="card-premium card-flat cb-panel">
        <div class="cb-form">
          <label class="cb-f"><span>Periodo</span><input type="month" [(ngModel)]="period" aria-label="Periodo" /></label>
          <label class="cb-f"><span>RFC (opcional)</span><input type="text" pInputText [(ngModel)]="rfc" placeholder="e.firma activa si vacío" maxlength="13" style="text-transform:uppercase" /></label>
        </div>
        <div class="cb-cards">
          <div class="cb-card">
            <div class="cb-card-body">
              <i class="pi pi-book"></i>
              <div><div class="cb-card-title">Catálogo de cuentas</div><div class="cb-card-desc">Estructura de cuentas con nivel y naturaleza (1.3).</div></div>
            </div>
            <button pButton type="button" label="Descargar XML" icon="pi pi-download" class="p-button-sm p-button-outlined" [loading]="dl()==='catalogo'" (click)="descargar('catalogo')"></button>
          </div>
          <div class="cb-card">
            <div class="cb-card-body">
              <i class="pi pi-list"></i>
              <div><div class="cb-card-title">Balanza de comprobación</div><div class="cb-card-desc">SaldoIni / Debe / Haber / SaldoFin por cuenta (BCE 1.3).</div></div>
            </div>
            <button pButton type="button" label="Descargar XML" icon="pi pi-download" class="p-button-sm p-button-outlined" [loading]="dl()==='balanza'" (click)="descargar('balanza')"></button>
          </div>
        </div>
        <p class="cb-note"><i class="pi pi-info-circle"></i> El <strong>CodAgrupador</strong> del catálogo usa la cuenta mayor como marcador; para un XML 100% válido ante el SAT falta el mapeo cuenta → código agrupador SAT.</p>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cb-panel { padding: 1.2rem; }
    .cb-form { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.2rem; }
    .cb-f { display: flex; flex-direction: column; gap: .25rem; font-size: .7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cb-f input { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .45rem .6rem; background: var(--card-bg); color: var(--text-main); font-family: var(--font-mono, monospace); min-width: 12rem; }
    .cb-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
    .cb-card { border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: 1rem; display: flex; flex-direction: column; gap: .8rem; justify-content: space-between; background: var(--card-bg); }
    .cb-card-body { display: flex; gap: .8rem; align-items: flex-start; }
    .cb-card-body .pi { font-size: 1.4rem; color: var(--action); margin-top: .1rem; }
    .cb-card-title { font-size: .9rem; font-weight: 700; color: var(--text-main); }
    .cb-card-desc { font-size: .78rem; color: var(--text-muted); margin-top: .15rem; }
    .cb-card button { align-self: flex-start; }
    .cb-note { font-size: .75rem; color: var(--text-muted); background: var(--surface-hover-bg, #f7f7f6); border-radius: var(--r-sm, 8px); padding: .55rem .75rem; margin: 1.2rem 0 0; display: flex; gap: .4rem; }
  `],
})
export class ContabilidadContabilidadComponent {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(ContabilidadService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  period = this.currentMonth();
  rfc = '';
  readonly dl = signal<'' | 'catalogo' | 'balanza'>('');

  descargar(tipo: 'catalogo' | 'balanza') {
    if (!/^\d{4}-\d{2}$/.test(this.period)) { this.toast.add({ severity: 'warn', summary: 'Periodo inválido', detail: 'Elige un mes válido.' }); return; }
    this.dl.set(tipo);
    const rfc = this.rfc ? this.rfc.toUpperCase() : undefined;
    const obs = tipo === 'catalogo' ? this.svc.catalogo(this.period, rfc) : this.svc.balanza(this.period, rfc);
    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (xml) => { this.dl.set(''); this.saveXml(xml, `${tipo}_${this.period}.xml`); this.toast.add({ severity: 'success', summary: 'XML generado', detail: `${tipo === 'catalogo' ? 'Catálogo' : 'Balanza'} ${this.period} descargado.` }); },
      error: () => { this.dl.set(''); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo generar el XML (¿hay balanza en el periodo? ¿RFC/e.firma?).' }); },
    });
  }

  private saveXml(xml: string, filename: string) {
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  private currentMonth(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
}
