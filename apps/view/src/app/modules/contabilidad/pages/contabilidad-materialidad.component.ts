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
import { MaterialidadService, MaterialidadDossier } from '../materialidad.service';

/**
 * FISCAL.10.1 — Expediente de materialidad de un proveedor (Operations). Se busca
 * por RFC y arma el dossier de defensa: listas SAT + CFDIs + cadena de suministro
 * (la recepción física es la evidencia) + veredicto. Clave si el proveedor es EFOS.
 */
@Component({
  selector: 'app-contabilidad-materialidad',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, ToastModule, InputTextModule, PageTabsComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head mt-head">
        <div class="surf-page-head-text">
          <h1>Expediente de materialidad</h1>
          <p class="surf-page-sub">Defensa por proveedor: listas negras + CFDIs + cadena de suministro (orden → recepción → factura → pago). La recepción física es la evidencia más fuerte.</p>
        </div>
      </header>

      <div class="mt-search">
        <span class="p-input-icon-left">
          <i class="pi pi-search"></i>
          <input type="text" pInputText placeholder="RFC del proveedor (p.ej. DRO020122GZ9)" [(ngModel)]="rfc" (keyup.enter)="buscar()" maxlength="13" style="text-transform:uppercase;min-width:280px" aria-label="RFC del proveedor" />
        </span>
        <button pButton type="button" label="Armar expediente" icon="pi pi-folder-open" class="p-button-sm" [loading]="loading()" [disabled]="!rfcValid()" (click)="buscar()"></button>
      </div>

      @if (loading()) {
        <div class="mt-skel card-premium card-flat">Armando expediente…</div>
      } @else if (dossier()) {
        @if (dossier(); as d) {
        <div class="mt-veredicto" [ngClass]="'v-' + d.veredicto.nivel">
          <div class="mt-v-badge">{{ veredictoLabel(d.veredicto.nivel) }}</div>
          <div class="mt-v-body">
            <div class="mt-v-title">{{ d.beneficiario || d.rfc }} <span class="mono muted">{{ d.rfc }}</span></div>
            <div class="mt-v-msg">{{ d.veredicto.mensaje }}</div>
          </div>
        </div>

        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de materialidad" />


        <div class="mt-grid">
          <div class="card-premium card-flat mt-block">
            <h3 class="mt-block-title">Cadena de suministro</h3>
            <div class="mt-chain">
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_orden > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_orden | number }}</span><span>Orden</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_recepcion > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_recepcion | number }}</span><span>Recepción</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step on"><span class="mt-chain-n">{{ d.cadena_suministro.cadenas | number }}</span><span>Factura</span></div>
              <i class="pi pi-arrow-right"></i>
              <div class="mt-chain-step" [class.on]="d.cadena_suministro.con_pago > 0"><span class="mt-chain-n">{{ d.cadena_suministro.con_pago | number }}</span><span>Pago</span></div>
            </div>
          </div>

          <div class="card-premium card-flat mt-block">
            <h3 class="mt-block-title">Listas negras del SAT</h3>
            @if (d.listas_negras.length) {
              <ul class="mt-listas">
                @for (l of d.listas_negras; track l.lista + l.situacion) {
                  <li><span class="mt-lista-tag" [class.risk]="true">{{ listaLabel(l.lista) }}</span> <span class="mt-lista-sit">{{ l.situacion }}</span> <span class="muted">· {{ l.doc_count | number }} doc · {{ money(l.importe_total) }}</span></li>
                }
              </ul>
            } @else {
              <div class="mt-clean"><i class="pi pi-check-circle"></i> No aparece en EFOS 69-B ni Art. 69.</div>
            }
            <div class="mt-cfdi-line">CFDIs recibidos: <strong class="mono">{{ d.cfdis.total | number }}</strong> · monto <strong class="mono">{{ money(d.cfdis.monto) }}</strong></div>
          </div>
        </div>
        }
      } @else if (searched()) {
        <div class="mt-empty card-premium card-flat"><i class="pi pi-exclamation-triangle"></i> No se pudo armar el expediente de {{ rfc }}.</div>
      } @else {
        <div class="mt-empty card-premium card-flat"><i class="pi pi-id-card"></i> Ingresa el RFC de un proveedor para armar su expediente de materialidad.</div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mt-search { display: flex; gap: .6rem; align-items: center; margin-bottom: 1rem; }
    .mt-skel, .mt-empty { padding: 2.5rem 1rem; text-align: center; color: var(--text-muted); }
    .mt-empty .pi { display: block; font-size: 1.6rem; margin-bottom: .5rem; opacity: .6; }
    .mt-veredicto { display: flex; gap: 1rem; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-lg, 14px); padding: 1rem 1.2rem; margin-bottom: 1rem; background: var(--card-bg); }
    .mt-veredicto.v-solida { border-color: color-mix(in srgb, var(--ok-fg, #16a34a) 45%, var(--border-color)); }
    .mt-veredicto.v-critico { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 50%, var(--border-color)); }
    .mt-veredicto.v-revisar { border-color: color-mix(in srgb, var(--warn-fg, #d97706) 50%, var(--border-color)); }
    .mt-v-badge { font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: .3rem .7rem; border-radius: var(--r-pill, 999px); background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted); white-space: nowrap; }
    .v-solida .mt-v-badge { background: color-mix(in srgb, var(--ok-fg, #16a34a) 16%, transparent); color: var(--ok-fg, #16a34a); }
    .v-critico .mt-v-badge { background: color-mix(in srgb, var(--bad-fg, #dc2626) 16%, transparent); color: var(--bad-fg, #dc2626); }
    .v-revisar .mt-v-badge { background: color-mix(in srgb, var(--warn-fg, #d97706) 18%, transparent); color: var(--warn-soft-fg, #b45309); }
    .mt-v-title { font-size: .95rem; font-weight: 700; color: var(--text-main); }
    .mt-v-msg { font-size: .82rem; color: var(--text-muted); margin-top: .2rem; }
    app-metric-strip { display:block; margin-bottom: 1rem; }
    .mt-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 1rem; }
    @media (max-width: 800px) { .mt-grid { grid-template-columns: 1fr; } }
    .mt-block { padding: 1rem; }
    .mt-block-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; color: var(--text-main); }
    .mt-chain { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .mt-chain .pi { color: var(--text-faint, #a8a29e); font-size: .8rem; }
    .mt-chain-step { display: flex; flex-direction: column; align-items: center; gap: .1rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); padding: .5rem .7rem; min-width: 4.5rem; opacity: .5; }
    .mt-chain-step.on { opacity: 1; border-color: color-mix(in srgb, var(--action) 30%, var(--border-color)); }
    .mt-chain-n { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); font-family: var(--font-mono, monospace); }
    .mt-chain-step span:last-child { font-size: .68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .mt-listas { list-style: none; margin: 0 0 .7rem; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .mt-listas li { font-size: .82rem; color: var(--text-main); }
    .mt-lista-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .68rem; font-weight: 700; }
    .mt-lista-tag.risk { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .mt-lista-sit { font-weight: 600; text-transform: capitalize; }
    .mt-clean { font-size: .85rem; color: var(--ok-fg, #16a34a); display: flex; gap: .4rem; align-items: center; margin-bottom: .7rem; }
    .mt-cfdi-line { font-size: .8rem; color: var(--text-muted); border-top: 1px solid var(--border-color); padding-top: .6rem; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; } .muted { color: var(--text-muted); }
  `],
})
export class ContabilidadMaterialidadComponent {
  readonly tabs = CONTABILIDAD_TABS;
  private readonly svc = inject(MaterialidadService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rfc = '';
  readonly dossier = signal<MaterialidadDossier | null>(null);

  /** KPIs de materialidad vía MetricStrip (sin caja). */
  kpiItems(d: MaterialidadDossier): MetricStripItem[] {
    const rec = d.cadena_suministro.recepcion_pct;
    return [
      { label: 'Operaciones', value: d.operaciones },
      { label: 'Monto total', value: d.monto_total, format: 'currency' },
      { label: 'Con recepción física', value: rec, format: 'percent', tone: rec >= 80 ? 'ok' : rec < 50 ? 'warn' : 'default' },
      { label: 'CFDI cancelados', value: d.cfdis.cancelados, tone: d.cfdis.cancelados > 0 ? 'bad' : 'default' },
    ];
  }
  readonly loading = signal(false);
  readonly searched = signal(false);

  rfcValid(): boolean { return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test((this.rfc || '').toUpperCase()); }

  buscar() {
    if (!this.rfcValid()) { this.toast.add({ severity: 'warn', summary: 'RFC inválido', detail: 'Revisa el formato del RFC.' }); return; }
    this.loading.set(true); this.searched.set(true); this.dossier.set(null);
    this.svc.dossier(this.rfc.toUpperCase()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.dossier.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo armar el expediente.' }); },
    });
  }

  veredictoLabel(n: string): string { return n === 'solida' ? 'Sólida' : n === 'critico' ? 'Crítico' : n === 'revisar' ? 'Revisar' : 'Parcial'; }
  listaLabel(l: string): string { return l === '69B' ? 'EFOS 69-B' : l === '69' ? 'Art. 69' : l; }
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
}
