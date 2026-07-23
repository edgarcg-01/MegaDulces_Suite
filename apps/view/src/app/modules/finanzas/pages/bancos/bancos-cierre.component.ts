import { ChangeDetectionStrategy, Component, EventEmitter, Output, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { Diagnostico, Concentrado, Balances } from '../../bank.service';
import { cuadra } from './bancos-shared';

/**
 * CB.14 — Vista CIERRE (home: veredicto + resumen del dinero + "qué falta").
 * Presentacional: recibe diagnóstico + concentrado (para el toggle de traspasos) +
 * balances (KPI traspasos). El toggle "contar traspasos" es estado local. Emite
 * `itemAction` (tipo del ítem) para que el shell navegue al lugar de arreglarlo.
 */
@Component({
  selector: 'bancos-cierre',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, CheckboxModule, MetricStripComponent, ContextHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (diagnostico(); as d) {
      <div class="fb-diag-head" [class.ok]="d.cuadra" [class.bad]="!d.cuadra">
        @if (d.cuadra) {
          <i class="pi pi-check-circle"></i>
          <div><h2>Todo cuadra</h2><p>Los {{ d.movimientos | number }} movimientos de {{ d.period }} están clasificados y las {{ d.cuentas_total }} cuentas cierran su saldo.</p></div>
        } @else {
          <i class="pi pi-exclamation-triangle"></i>
          <div><h2>{{ d.items.length }} cosa(s) por resolver para que cuadre</h2><p>Ordenadas por impacto. Cada una salta al lugar exacto para arreglarla.</p></div>
        }
      </div>

      <app-metric-strip [items]="kpis(d)" ariaLabel="Resumen del periodo" />

      <label class="fb-toggle">
        <p-checkbox [ngModel]="countTransfers()" [binary]="true" inputId="ctTr" (onChange)="countTransfers.set($event.checked)" />
        <span>Incluir traspasos internos en ingresos/egresos</span>
        <span class="muted">— los traspasos (entre cuentas propias) netean a $0, así que NO cambian el neto; el toggle solo cambia el volumen bruto que ves.</span>
      </label>
      <p class="fb-diag-note muted"><i class="pi pi-info-circle"></i> El <b>neto</b> es el flujo del mes (lo que entró − lo que salió) — <b>no tiene que ser $0</b>. Lo que debe <b>cuadrar</b> es el saldo de cada cuenta (pestaña Cuentas: inicial + depósitos − retiros = final) y los traspasos internos (TI=TE).</p>

      @if (!d.tiene_balanza_kepler) {
        <p class="fb-diag-note muted"><i class="pi pi-info-circle"></i> La balanza de Kepler no está cargada para {{ d.period }}, así que el cruce contable no se está evaluando (solo el cuadre interno de saldos y la clasificación).</p>
      }

      @if (d.items.length) {
        <h3 class="fb-card-title fb-cierre-h3">Qué falta <span class="muted">— por impacto</span></h3>
        <div class="fb-diag-list">
          @for (it of d.items; track it.titulo) {
            <div class="fb-diag-item" [class]="'sev-' + it.severidad">
              <div class="fb-diag-item-head">
                <span class="fb-diag-dot"></span>
                <span class="fb-diag-title">{{ it.titulo }}</span>
                @if (helpTopic(it.tipo); as ht) { <app-context-help [topic]="ht" /> }
                @if (it.importe > 0) { <span class="fb-diag-amt mono">{{ it.importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</span> }
                <button pButton type="button" class="p-button-sm p-button-outlined fb-diag-cta"
                        [label]="actionLabel(it)" icon="pi pi-arrow-right" iconPos="right" (click)="itemAction.emit(it)"></button>
              </div>
              <p class="fb-diag-detalle">{{ it.detalle }}</p>
              @if (it.evidencia?.length) {
                <ul class="fb-diag-ev">
                  @for (e of it.evidencia; track e.label) {
                    <li>
                      <span class="fb-diag-ev-label">{{ e.label }}</span>
                      @if (e.count) { <span class="fb-diag-ev-meta">{{ e.count }} mov</span> }
                      @if (e.folio) { <span class="fb-diag-ev-folio">{{ e.folio }}</span> }
                      @if (e.monto != null) { <span class="fb-diag-ev-monto mono">{{ e.monto | currency:'MXN':'symbol-narrow':'1.0-0' }}</span> }
                    </li>
                  }
                </ul>
              }
              <p class="fb-diag-accion"><i class="pi pi-info-circle"></i> {{ it.accion }}</p>
            </div>
          }
        </div>
      }
    } @else {
      <div class="surf-empty"><i class="pi pi-inbox"></i><p>Sin datos para {{ period() }}. Sube un estado de cuenta para empezar.</p></div>
    }
  `,
  styles: [`
    :host { display: block; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .muted { color: var(--text-muted); }
    .fb-toggle { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-1) 0 var(--sp-3); }
    .fb-toggle .muted { font-size: var(--fs-xs); }
    .fb-card-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); }
    .fb-cierre-h3 { margin: var(--sp-4) 0 var(--sp-2); }
    .fb-diag-note { font-size: var(--fs-xs); margin: 0 0 var(--sp-3); }
    .fb-diag-head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4); margin-bottom: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; }
    .fb-diag-head.ok { border-left-color: var(--ok-fg); }
    .fb-diag-head.bad { border-left-color: var(--warn-fg); }
    .fb-diag-head i { font-size: 1.5rem; }
    .fb-diag-head.ok i { color: var(--ok-fg); }
    .fb-diag-head.bad i { color: var(--warn-fg); }
    .fb-diag-head h2 { font-size: var(--fs-md, 1rem); font-weight: 700; margin: 0; color: var(--text-main); }
    .fb-diag-head p { font-size: var(--fs-sm); color: var(--text-muted); margin: 2px 0 0; }
    .fb-diag-list { display: flex; flex-direction: column; gap: var(--sp-2); }
    .fb-diag-item { padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); border-left-width: 3px; }
    .fb-diag-item.sev-bad { border-left-color: var(--bad-fg); }
    .fb-diag-item.sev-warn { border-left-color: var(--warn-fg); }
    .fb-diag-item-head { display: flex; align-items: center; gap: var(--sp-2); }
    .fb-diag-dot { width: 8px; height: 8px; border-radius: var(--r-pill); flex: none; }
    .sev-bad .fb-diag-dot { background: var(--bad-fg); }
    .sev-warn .fb-diag-dot { background: var(--warn-fg); }
    .fb-diag-title { flex: 1; min-width: 0; font-weight: 600; color: var(--text-main); }
    .fb-diag-amt { font-weight: 700; }
    .fb-diag-cta { flex: none; }
    .fb-diag-detalle { font-size: var(--fs-sm); color: var(--text-main); margin: var(--sp-2) 0 var(--sp-1); }
    .fb-diag-accion { font-size: var(--fs-sm); color: var(--text-muted); margin: 0; display: flex; align-items: baseline; gap: var(--sp-1); }
    .fb-diag-accion i { color: var(--action); font-size: 0.75rem; }
    .fb-diag-ev { list-style: none; margin: 0 0 var(--sp-2); padding: var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: 2px;
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .fb-diag-ev li { display: flex; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-xs); }
    .fb-diag-ev-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--text-main); }
    .fb-diag-ev-meta { color: var(--text-muted); }
    .fb-diag-ev-folio { color: var(--text-muted); font-family: var(--font-mono); }
    .fb-diag-ev-monto { font-weight: 600; color: var(--text-main); min-width: 6rem; text-align: right; }
    .surf-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding: var(--sp-8); color: var(--text-muted); }
    .surf-empty i { font-size: 1.5rem; }
  `],
})
export class BancosCierreComponent {
  readonly diagnostico = input.required<Diagnostico | null>();
  readonly concentrado = input.required<Concentrado | null>();
  readonly balances = input.required<Balances | null>();
  readonly period = input<string>('');
  @Output() itemAction = new EventEmitter<{ tipo?: string }>();

  /** Toggle "contar traspasos": por default EXCLUYE los traspasos internos. */
  readonly countTransfers = signal(false);

  private totals(d: Diagnostico): { ingresos: number; egresos: number; neto: number } {
    // Excluir solo los traspasos internos REALES (raw_type TI/TE, de balances) — netean
    // a $0, así que el neto NO cambia al incluirlos/excluirlos: el toggle solo cambia el
    // volumen bruto de ingresos/egresos que se ve. (Usar el grupo 'traspaso' era el bug:
    // arrastraba Spei/G mal clasificados y falseaba el neto operativo.)
    const tr = this.balances()?.traspasos;
    if (this.countTransfers() || !tr) return { ingresos: d.ingresos, egresos: d.egresos, neto: d.neto };
    const ingresos = d.ingresos - (tr.entra || 0);
    const egresos = d.egresos - (tr.sale || 0);
    return { ingresos, egresos, neto: Math.round((ingresos - egresos) * 100) / 100 };
  }
  kpis(d: Diagnostico): MetricStripItem[] {
    const t = this.totals(d);
    const items: MetricStripItem[] = [
      { label: 'Ingresos', value: t.ingresos, format: 'currency', tone: 'ok' },
      { label: 'Egresos', value: t.egresos, format: 'currency' },
      { label: 'Neto', value: t.neto, format: 'currency', tone: t.neto >= 0 ? 'ok' : 'bad' },
      { label: 'Movimientos', value: d.movimientos, format: 'number' },
    ];
    const tr = this.balances()?.traspasos;
    if (tr) items.push({ label: 'Traspasos', value: tr.entra, format: 'currency', tone: cuadra(tr.delta) ? 'ok' : 'warn' });
    return items;
  }
  actionLabel(it: { tipo?: string }): string {
    switch (it?.tipo) {
      case 'sin_clasificar': return 'Ver sin clasificar';
      case 'traspaso_descuadre': return 'Ver traspasos';
      case 'saldo_no_cuadra': return 'Ver cuenta';
      case 'kepler_pnl': return 'Ver conciliación';
      case 'cuenta_sin_cargar': return 'Subir estado';
      default: return 'Revisar';
    }
  }
  helpTopic(tipo: string): string | null {
    const map: Record<string, string> = {
      sin_clasificar: 'bancos_sin_clasificar',
      saldo_no_cuadra: 'bancos_saldo_no_cuadra',
      traspaso_descuadre: 'bancos_traspaso_descuadre',
      cuenta_sin_cargar: 'bancos_cuenta_sin_cargar',
      kepler_pnl: 'bancos_caja',
    };
    return map[tipo] ?? null;
  }
}
