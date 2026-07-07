import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CuadreService, Discrepancy, DiscStats, RuleHealth, DiscPlano } from '../cuadre.service';

/**
 * SM.4 — Bandeja de descuadres del Supervisor de Movimientos. Superficie Operations:
 * KPIs + filtros por plano/estado + tabla densa con triage (confirmar = acepta la
 * causa sugerida y entrena la precisión de la regla; descartar = falso positivo) +
 * evidencia + panel de salud de reglas. Espeja la bandeja de Hallazgos de Maat.
 */
@Component({
  selector: 'app-almacen-cuadre',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cd-page">
      <p-toast></p-toast>
      <header class="surf-page-head cd-head">
        <div class="surf-page-head-text">
          <h1>Cuadre de Movimientos</h1>
          <p class="surf-page-sub">Descuadres que el supervisor detecta: caja (arqueos), inventario y cruces. Confirma o descarta — el motor aprende de cada veredicto.</p>
        </div>
        <div class="cd-head-actions">
          <button pButton type="button" [label]="rulesOpen() ? 'Ocultar reglas' : 'Reglas'" icon="pi pi-sliders-h" class="p-button-sm p-button-text" (click)="rulesOpen.set(!rulesOpen())"></button>
          <button pButton type="button" label="Escanear ahora" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
        </div>
      </header>

      @if (stats(); as s) {
        <div class="cd-kpis">
          <div class="cd-kpi"><span class="cd-kpi-val">{{ s.pendientes | number }}</span><span class="cd-kpi-lbl">Pendientes</span></div>
          <div class="cd-kpi" [class.bad]="s.criticos > 0"><span class="cd-kpi-val">{{ s.criticos | number }}</span><span class="cd-kpi-lbl">Críticos</span></div>
          <div class="cd-kpi"><span class="cd-kpi-val">{{ money(s.monto_en_juego) }}</span><span class="cd-kpi-lbl">$ en juego</span></div>
          @for (p of s.por_plano; track p.plano) {
            <div class="cd-kpi"><span class="cd-kpi-val">{{ p.n | number }}</span><span class="cd-kpi-lbl">{{ planoLabel(p.plano) }}</span></div>
          }
        </div>
      }

      @if (rulesOpen()) {
        <div class="card-premium card-flat cd-rules">
          <h3 class="cd-card-title">Salud de las reglas <span class="muted">(precisión = confirmados / veredictos)</span></h3>
          <p-table [value]="rules()" styleClass="p-datatable-sm" [rowHover]="true">
            <ng-template pTemplate="header">
              <tr><th>Regla</th><th>Plano</th><th class="ta-r">Descuadres</th><th class="ta-r">✓ / ✗</th><th class="ta-r">Precisión</th><th>Estado</th><th style="width:5rem"></th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-r>
              <tr [class.cd-suppressed]="r.suppressed_auto">
                <td>{{ r.nombre }}</td>
                <td><span class="cd-tag" [ngClass]="'pl-' + r.plano">{{ planoLabel(r.plano) }}</span></td>
                <td class="ta-r">{{ r.findings_total | number }}</td>
                <td class="ta-r muted">{{ r.findings_confirmados }} / {{ r.findings_falsos }}</td>
                <td class="ta-r" [class.bad]="r.precision_score != null && r.precision_score < 0.3">{{ r.precision_score != null ? (r.precision_score * 100 | number:'1.0-0') + '%' : '—' }}</td>
                <td>
                  @if (r.suppressed_auto) { <span class="cd-tag pl-off">auto-suprimida</span> }
                  @else if (!r.enabled) { <span class="cd-tag pl-off">off</span> }
                  @else if (r.pinned) { <span class="cd-tag pl-pin">fijada</span> }
                  @else { <span class="muted">activa</span> }
                </td>
                <td class="ta-r"><button pButton type="button" [icon]="r.pinned ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'" class="p-button-text p-button-sm" [title]="r.pinned ? 'Desfijar' : 'Fijar (nunca auto-suprimir)'" (click)="pin(r)"></button></td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <div class="cd-filters">
        <div class="cd-seg">
          <button [class.active]="plano() === null" (click)="setPlano(null)">Todos</button>
          <button [class.active]="plano() === 'caja'" (click)="setPlano('caja')">Caja</button>
          <button [class.active]="plano() === 'inventario'" (click)="setPlano('inventario')">Inventario</button>
          <button [class.active]="plano() === 'cruce'" (click)="setPlano('cruce')">Cruce</button>
        </div>
        <div class="cd-seg">
          <button [class.active]="status() === 'pendientes'" (click)="setStatus('pendientes')">Pendientes</button>
          <button [class.active]="status() === 'confirmado'" (click)="setStatus('confirmado')">Confirmados</button>
          <button [class.active]="status() === 'descartado'" (click)="setStatus('descartado')">Descartados</button>
        </div>
      </div>

      <div class="card-premium card-flat">
        <p-table [value]="items()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()"
                 dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="560px" [paginator]="items().length > 50" [rows]="50">
          <ng-template pTemplate="header">
            <tr><th style="width:2.5rem"></th><th style="width:6rem">Severidad</th><th>Descuadre</th><th style="width:7rem">Plano</th><th class="ta-r" style="width:9rem">Diferencia</th><th style="width:13rem">Acciones</th></tr>
          </ng-template>
          <ng-template pTemplate="body" let-d let-expanded="expanded">
            <tr>
              <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" (click)="toggle(d)"></button></td>
              <td><span class="cd-sev" [ngClass]="'sev-' + d.severity">{{ sevLabel(d.severity) }}</span></td>
              <td>
                <div class="cd-titulo">{{ d.titulo }}</div>
                <div class="cd-resumen">{{ d.resumen }}</div>
              </td>
              <td><span class="cd-tag" [ngClass]="'pl-' + d.plano">{{ planoLabel(d.plano) }}</span></td>
              <td class="ta-r strong" [class.bad]="(d.diferencia || 0) > 0" [class.ok]="(d.diferencia || 0) < 0">{{ money(d.importe) }}</td>
              <td>
                <div class="cd-acts">
                  @if (d.status === 'nuevo' || d.status === 'en_revision') {
                    <button pButton type="button" icon="pi pi-check" label="Confirmar" class="p-button-sm p-button-success p-button-text" (click)="verdict(d, 'util')" [title]="'Es real · causa: ' + (d.causa_probable || 'otro')"></button>
                    <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" (click)="verdict(d, 'falso')" title="Falso positivo"></button>
                  } @else {
                    <span class="cd-status" [ngClass]="'st-' + d.status">{{ statusLabel(d.status) }}</span>
                    @if (d.causa_confirmada) { <span class="muted cd-causa">· {{ causaLabel(d.causa_confirmada) }}</span> }
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template pTemplate="rowexpansion" let-d>
            <tr><td colspan="6" class="cd-ev">
              <div class="cd-ev-grid">
                @for (kv of evidenceRows(d); track kv.k) { <div><span class="cd-ev-k">{{ kv.k }}</span><span class="cd-ev-v mono">{{ kv.v }}</span></div> }
              </div>
              <div class="cd-ev-meta muted">Regla: {{ d.regla || d.rule_key }} · causa probable: {{ causaLabel(d.causa_probable) }} · detectado {{ d.first_seen | date:'dd/MM/yy' }} · visto {{ d.last_seen | date:'dd/MM/yy' }}</div>
            </td></tr>
          </ng-template>
          <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="cd-empty">
            @if (loading()) { Cargando… } @else { Sin descuadres {{ status() === 'pendientes' ? 'pendientes' : '' }}. Corre "Escanear ahora" o revisa otro filtro. }
          </td></tr></ng-template>
        </p-table>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cd-head { display: flex; align-items: flex-start; gap: 1rem; }
    .cd-head-actions { margin-left: auto; display: flex; gap: .4rem; align-items: center; }
    .cd-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .cd-kpi { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-md, 10px); padding: .75rem 1rem; background: var(--card-bg, #fff); }
    .cd-kpi.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, var(--border-color, #e7e5e4)); }
    .cd-kpi-val { display: block; font-size: 1.3rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .cd-kpi-lbl { display: block; font-size: .7rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .cd-filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .cd-seg { display: inline-flex; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .cd-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .8rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .cd-seg button.active { background: var(--action, #FB923C); color: #fff; font-weight: 600; }
    .cd-card-title { margin: 0 0 .6rem; font-size: .85rem; font-weight: 700; }
    .cd-rules { padding: 1rem; margin-bottom: 1rem; }
    .cd-table { font-variant-numeric: tabular-nums; }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
    .bad { color: var(--bad-fg, #dc2626); font-weight: 600; }
    .ok { color: var(--ok-fg, #16a34a); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .cd-titulo { font-weight: 600; }
    .cd-resumen { font-size: .82rem; color: var(--text-muted, #78716c); margin-top: .1rem; max-width: 62ch; }
    .cd-sev { display: inline-block; padding: .1rem .5rem; border-radius: var(--r-pill, 999px); font-size: .68rem; font-weight: 700; text-transform: uppercase; }
    .sev-critical { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .sev-warn { background: color-mix(in srgb, #d97706 15%, transparent); color: #b45309; }
    .sev-info { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .cd-tag { display: inline-block; padding: .08rem .5rem; border-radius: var(--r-pill, 999px); font-size: .7rem; font-weight: 600; }
    .pl-caja { background: color-mix(in srgb, var(--action, #FB923C) 14%, transparent); color: var(--action, #FB923C); }
    .pl-inventario { background: color-mix(in srgb, #0ea5e9 14%, transparent); color: #0369a1; }
    .pl-cruce { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #6d28d9; }
    .pl-off { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #78716c); }
    .pl-pin { background: color-mix(in srgb, var(--action, #FB923C) 15%, transparent); color: var(--action, #FB923C); }
    .cd-acts { display: flex; align-items: center; gap: .1rem; }
    .cd-status { font-size: .75rem; font-weight: 600; }
    .cd-causa { font-size: .74rem; }
    .st-confirmado { color: var(--ok-fg, #16a34a); } .st-descartado { color: var(--text-muted, #a8a29e); } .st-corregido { color: var(--action, #FB923C); }
    .cd-suppressed { opacity: .55; }
    .cd-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .cd-ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .4rem 1.2rem; }
    .cd-ev-k { font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); display: block; }
    .cd-ev-v { font-size: .85rem; }
    .cd-ev-meta { font-size: .74rem; margin-top: .6rem; }
    .cd-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
  `],
})
export class AlmacenCuadreComponent implements OnInit {
  private readonly svc = inject(CuadreService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly items = signal<Discrepancy[]>([]);
  readonly stats = signal<DiscStats | null>(null);
  readonly rules = signal<RuleHealth[]>([]);
  readonly loading = signal(false);
  readonly scanning = signal(false);
  readonly rulesOpen = signal(false);
  readonly plano = signal<DiscPlano | null>(null);
  readonly status = signal<'pendientes' | 'confirmado' | 'descartado'>('pendientes');
  readonly expanded = signal<Record<string, boolean>>({});

  ngOnInit() { this.reload(); this.loadStats(); }

  private reload() {
    this.loading.set(true);
    const status = this.status() === 'pendientes' ? undefined : this.status();
    this.svc.list({ plano: this.plano() || undefined, status, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.items.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  private loadStats() {
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.rules().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.rules.set(r), error: () => {} });
  }

  setPlano(p: DiscPlano | null) { this.plano.set(p); this.reload(); }
  setStatus(s: 'pendientes' | 'confirmado' | 'descartado') { this.status.set(s); this.reload(); }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Escaneo listo', detail: `${r.total_nuevos} descuadre(s) nuevo(s).` }); this.reload(); this.loadStats(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo escanear.' }); },
    });
  }

  toggle(d: Discrepancy) {
    this.expanded.update((e) => { const c = { ...e }; if (c[d.id]) delete c[d.id]; else c[d.id] = true; return c; });
  }

  verdict(d: Discrepancy, v: 'util' | 'falso') {
    // Confirmar acepta la causa sugerida por el detector; descartar = falso positivo.
    const causa = v === 'util' ? (d.causa_probable || 'otro') : undefined;
    this.svc.feedback(d.id, v, causa).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.items.update((arr) => arr.filter((x) => x.id !== d.id));
        this.loadStats();
        const msg = v === 'util' ? 'Confirmado' : 'Descartado';
        const sup = res?.suppressed ? ' · regla auto-suprimida por baja precisión' : '';
        this.toast.add({ severity: v === 'util' ? 'success' : 'info', summary: msg, detail: `El supervisor aprende de esto${sup}.` });
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo registrar.' }),
    });
  }

  pin(r: RuleHealth) {
    this.svc.pinRule(r.rule_key, !r.pinned).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.loadStats(), error: () => {} });
  }

  evidenceRows(d: Discrepancy): { k: string; v: string }[] {
    const e = { ...(d.entity || {}), ...(d.evidencia || {}) };
    return Object.entries(e).filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => ({ k: k.replace(/_/g, ' '), v: String(v) }));
  }

  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  planoLabel(p: string): string { return p === 'caja' ? 'Caja' : p === 'inventario' ? 'Inventario' : p === 'cruce' ? 'Cruce' : p; }
  sevLabel(s: string): string { return s === 'critical' ? 'Crítico' : s === 'warn' ? 'Alerta' : 'Info'; }
  statusLabel(s: string): string { return s === 'confirmado' ? 'Confirmado' : s === 'descartado' ? 'Descartado' : s === 'corregido' ? 'Corregido' : s; }
  causaLabel(c: string | null): string {
    const map: Record<string, string> = { faltante_caja: 'Faltante de caja', sobrante_caja: 'Sobrante de caja', faltante_recurrente: 'Faltante recurrente', merma: 'Merma', robo: 'Robo', error_captura: 'Error de captura', traspaso_no_registrado: 'Traspaso no registrado', otro: 'Otro' };
    return c ? (map[c] || c.replace(/_/g, ' ')) : '—';
  }
}
