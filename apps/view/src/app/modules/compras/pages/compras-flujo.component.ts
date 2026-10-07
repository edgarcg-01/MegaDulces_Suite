import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import {
  FLUJO_ETAPAS, FLUJO_ETAPA_LABEL, FlujoComprasDto, FlujoEtapa, FlujoRequisicionDto,
} from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ComprasService } from '../compras.service';

/**
 * `[RA-PRO.63]` Pestaña "Flujo" de `/compras/pedido`: cada requisición del periodo y hasta dónde
 * llegó — OC en Kepler, entrada — más los productos que se piden y no vienen en la OC.
 *
 * La liga requisición→OC es SUGERIDA por el servidor (misma sucursal y proveedor, la OC que trae
 * más de sus productos): la pantalla la muestra con su confianza, nunca como hecho.
 *
 * Superficie Operations (tabla densa + detalle expandible).
 */
@Component({
  selector: 'app-compras-flujo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fl fl-table">
      <div class="fl-filters">
        <p-select [options]="diasOpts" [(ngModel)]="fDias" (onChange)="reload()" optionLabel="label" optionValue="value"
                  appendTo="body" ariaLabel="Periodo"></p-select>
        <p-select [options]="sucOpts()" [(ngModel)]="fSuc" (onChange)="reload()" optionLabel="label" optionValue="value"
                  placeholder="Todas las sucursales" [showClear]="true" appendTo="body" ariaLabel="Sucursal"></p-select>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
        @if (data(); as d) { <span class="fl-count">{{ d.desde | date:'dd/MM/yy' }} – {{ d.hasta | date:'dd/MM/yy' }}</span> }
      </div>

      @if (error()) {
        <p class="fl-aviso fl-aviso-err" role="alert"><span class="pi pi-exclamation-triangle" aria-hidden="true"></span> {{ error() }}</p>
      }

      <app-metric-strip [items]="kpis()" ariaLabel="Resumen del flujo de compras" />

      <!-- Filtro por etapa, con su conteo (sobre todas las requisiciones del periodo). -->
      <div class="fl-bar" role="group" aria-label="Filtrar por etapa">
        <span class="fl-bar-lbl">Etapa</span>
        <button type="button" class="fl-chip" [class.fl-on]="fEtapa() === ''" [attr.aria-pressed]="fEtapa() === ''" (click)="fEtapa.set('')">
          Todas <b>{{ total() | number }}</b>
        </button>
        @for (e of etapas; track e) {
          <button type="button" class="fl-chip" [class.fl-on]="fEtapa() === e" [attr.aria-pressed]="fEtapa() === e"
                  [attr.data-etapa]="e" (click)="fEtapa.set(e)">
            {{ etapaLabel[e] }} <b>{{ (data()?.resumen?.por_etapa?.[e] ?? 0) | number }}</b>
          </button>
        }
      </div>

      <p-table [value]="filas()" [loading]="loading()" dataKey="id" [expandedRowKeys]="expandidas"
               [scrollable]="true" scrollHeight="flex" size="small">
        <ng-template #header>
          <tr>
            <th class="fl-exp" aria-label="Detalle"></th>
            <th>Requisición</th><th>Fecha</th><th>Suc.</th><th>Proveedor</th>
            <th class="fl-r">Renglones</th><th class="fl-r">$ Pedido</th><th>Etapa</th>
            <th title="OC de Kepler sugerida: misma sucursal y proveedor, la que trae más productos de la requisición">OC Kepler (sugerida)</th>
            <th title="Órdenes de entrada de esa OC: surtido en dinero">Entrada</th>
            <th class="fl-r" title="Productos de la requisición que no vinieron en la OC">Negados</th>
          </tr>
        </ng-template>
        <ng-template #body let-r let-expanded="expanded">
          <tr>
            <td class="fl-exp">
              <button type="button" class="fl-tog" [pRowToggler]="r"
                      [attr.aria-expanded]="expanded" [attr.aria-label]="(expanded ? 'Ocultar' : 'Ver') + ' renglones de ' + r.folio">
                <span class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></span>
              </button>
            </td>
            <td class="fl-mono">{{ r.folio }}</td>
            <td class="fl-muted">{{ r.fecha | date:'dd/MM/yy' }}</td>
            <td class="fl-mono fl-muted" [title]="r.almacen_nombre">{{ r.almacen }}</td>
            <td>{{ r.proveedor || '—' }}</td>
            <td class="fl-r fl-muted">{{ r.renglones | number }}</td>
            <td class="fl-r fl-strong">{{ money(r.costo) }}</td>
            <td><span class="fl-pill" [attr.data-etapa]="r.etapa" [title]="r.motivo || ''">{{ label(r.etapa) }}</span></td>
            <td>
              @if (r.oc; as oc) {
                <span class="fl-mono">{{ oc.sucursal }}-{{ oc.folio }}</span>
                <span class="fl-muted"> · +{{ oc.dias }} d</span>
                <span class="fl-conf" [attr.data-conf]="oc.confianza"
                      [title]="oc.coincidencia_pct + '% de los productos de la requisición vienen en esta OC' + (oc.ambigua ? '. Otra OC empata: se tomó la más cercana en fecha.' : '')">
                  {{ oc.coincidencia_pct }}%@if (oc.ambigua) {<span class="pi pi-question-circle" aria-label="liga ambigua"></span>}
                </span>
                @if (oc.requisiciones_en_oc > 1) {
                  <span class="fl-muted" [title]="'Esta OC cubre ' + oc.requisiciones_en_oc + ' requisiciones del periodo'"> · {{ oc.requisiciones_en_oc }} RQ</span>
                }
              } @else { <span class="fl-muted">—</span> }
            </td>
            <td>
              @if (r.entrada; as e) {
                <span class="fl-muted">{{ e.primera_fecha | date:'dd/MM' }}</span>
                @if (e.surtido_pct !== null) { <span [class]="surtidoCls(e.surtido_pct)"> {{ e.surtido_pct }}%</span> }
                @if (e.n > 1) { <span class="fl-muted"> · {{ e.n }}</span> }
              } @else { <span class="fl-muted">—</span> }
            </td>
            <td class="fl-r">
              @if (r.oc) { <span [class.fl-bad]="r.negados > 0">{{ r.negados | number }}</span> } @else { <span class="fl-muted">—</span> }
            </td>
          </tr>
        </ng-template>
        <ng-template #expandedrow let-r>
          <tr class="fl-det">
            <td colspan="11">
              @if (r.motivo) { <p class="fl-motivo">{{ r.motivo }}</p> }
              <table class="fl-sub">
                <thead><tr><th>SKU</th><th>Producto</th><th class="fl-r">$ Pedido</th><th>¿Vino en la OC?</th></tr></thead>
                <tbody>
                  @for (l of r.lineas; track $index) {
                    <tr>
                      <td class="fl-mono">{{ l.sku }}</td>
                      <td>{{ l.nombre }}</td>
                      <td class="fl-r">{{ money(l.costo) }}</td>
                      <td>
                        @if (l.en_oc === true) { <span class="fl-ok">Sí</span> }
                        @else if (l.en_oc === false) { <span class="fl-bad">No vino</span> }
                        @else { <span class="fl-muted">Sin OC ligada</span> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="11" class="fl-empty">No hay requisiciones de proveedor en este periodo.</td></tr>
        </ng-template>
      </p-table>

      <!-- Productos que se piden y no vienen en la OC una y otra vez. -->
      <section class="fl-neg" aria-labelledby="fl-neg-h">
        <h2 id="fl-neg-h" class="fl-h2">Productos negados recurrentes</h2>
        <p class="fl-sub-txt">Se pidieron en la requisición y no vinieron en la OC ligada, dos veces o más. Sólo cuentan las requisiciones con OC.</p>
        @if (negados().length) {
          <p-table [value]="negados()" size="small">
            <ng-template #header>
              <tr><th>SKU</th><th>Producto</th><th>Proveedor</th><th class="fl-r">Negado</th><th class="fl-r">$ Negado</th></tr>
            </ng-template>
            <ng-template #body let-n>
              <tr>
                <td class="fl-mono">{{ n.sku }}</td>
                <td>{{ n.nombre }}</td>
                <td class="fl-muted">{{ n.proveedor || '—' }}</td>
                <td class="fl-r"><span class="fl-bad fl-strong">{{ n.veces_negado }}</span><span class="fl-muted"> de {{ n.veces_pedido }}</span></td>
                <td class="fl-r">{{ money(n.costo_negado) }}</td>
              </tr>
            </ng-template>
          </p-table>
        } @else if (!loading()) {
          <p class="fl-empty">Ningún producto negado dos veces o más en el periodo.</p>
        }
      </section>

      @if (data(); as d) {
        <ul class="fl-foot">
          <li><strong>La OC es sugerida, no capturada:</strong> misma sucursal y proveedor, en los {{ d.ventana_dias }} días siguientes, la que trae más productos de la requisición. Con menos de la mitad no se liga.</li>
          <li><strong>No se compara la cantidad:</strong> el comprador arma su propia OC y a veces junta varias requisiciones, así que requisición→OC se mide como "¿vino el producto?" y OC→entrada en dinero.</li>
          <li>El surtido principal es la <strong>mediana por OC</strong>; ponderado por dinero da {{ pct(d.resumen.surtido_dinero_pct) }} (una OC grande a medio recibir lo arrastra).</li>
          @if (d.traspasos_fuera) { <li>{{ d.traspasos_fuera | number }} requisiciones de traspaso no se muestran: no pasan por una OC.</li> }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .fl { display: flex; flex-direction: column; gap: .75rem; }
    .fl-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .fl-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .fl-aviso { display: flex; gap: .45rem; margin: 0; padding: .5rem .7rem; font-size: .8rem; color: var(--text-main);
      border: 1px solid var(--border-color); border-left: 3px solid var(--warn-fg); border-radius: var(--r-sm, 8px); }
    .fl-aviso-err { border-left-color: var(--bad-fg); }
    .fl-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; }
    .fl-bar-lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; margin-right: .2rem; }
    .fl-chip { display: inline-flex; align-items: center; gap: .3rem; padding: .2rem .55rem; min-height: 28px;
      border: 1px solid var(--border-color); border-radius: 999px; background: transparent; color: var(--text-main);
      font: inherit; font-size: .76rem; cursor: pointer; }
    .fl-chip b { font-variant-numeric: tabular-nums; }
    .fl-chip:hover { background: var(--hover-bg, var(--overlay-hover)); }
    .fl-on { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .fl-chip:focus-visible, .fl-tog:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .fl-table { font-size: .82rem; }
    .fl-r { text-align: right; font-variant-numeric: tabular-nums; }
    .fl-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .fl-muted { color: var(--text-muted); }
    .fl-strong { font-weight: 700; }
    .fl-ok { color: var(--ok-fg); font-weight: 600; }
    .fl-warn { color: var(--warn-fg); font-weight: 600; }
    .fl-bad { color: var(--bad-fg); font-weight: 600; }
    .fl-exp { width: 2rem; }
    .fl-tog { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
      border: 0; border-radius: var(--r-sm, 8px); background: transparent; color: var(--text-muted); cursor: pointer; }
    .fl-pill { display: inline-flex; padding: .12rem .5rem; border-radius: 999px; border: 1px solid var(--border-color);
      font-size: .74rem; white-space: nowrap; }
    [data-etapa='con_entrada'].fl-pill { color: var(--ok-fg); border-color: var(--ok-fg); }
    [data-etapa='en_oc'].fl-pill { color: var(--action); border-color: var(--action); }
    [data-etapa='esperando'].fl-pill, [data-etapa='sin_fuente'].fl-pill { color: var(--text-muted); border-style: dashed; }
    [data-etapa='sin_oc'].fl-pill { color: var(--bad-fg); border-color: var(--bad-fg); }
    .fl-conf { margin-left: .3rem; font-size: .72rem; font-variant-numeric: tabular-nums; }
    .fl-conf[data-conf='alta'] { color: var(--ok-fg); }
    .fl-conf[data-conf='media'] { color: var(--warn-fg); }
    .fl-conf .pi { font-size: .7rem; margin-left: .15rem; }
    .fl-det td { background: var(--surface-1, transparent); }
    .fl-motivo { margin: .2rem 0 .45rem; font-size: .78rem; color: var(--text-muted); }
    .fl-sub { width: 100%; border-collapse: collapse; font-size: .78rem; }
    .fl-sub th { text-align: left; font-weight: 600; color: var(--text-muted); padding: .2rem .4rem; border-bottom: 1px solid var(--border-color); }
    .fl-sub td { padding: .2rem .4rem; border-bottom: 1px solid var(--border-color); }
    .fl-empty { color: var(--text-muted); padding: 1rem; text-align: center; margin: 0; }
    .fl-neg { display: flex; flex-direction: column; gap: .35rem; }
    .fl-h2 { margin: .5rem 0 0; font-size: .95rem; font-weight: 700; }
    .fl-sub-txt { margin: 0; font-size: .78rem; color: var(--text-muted); }
    .fl-foot { margin: .25rem 0 0; padding-left: 1.1rem; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  `],
})
export class ComprasFlujoComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = signal<FlujoComprasDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sucOpts = signal<{ label: string; value: string }[]>([]);
  readonly fEtapa = signal<FlujoEtapa | ''>('');
  readonly etapas = FLUJO_ETAPAS;
  readonly etapaLabel = FLUJO_ETAPA_LABEL;
  /** Filas abiertas del detalle (lo maneja p-table por `dataKey`). */
  expandidas: Record<string, boolean> = {};

  fDias = 60;
  fSuc = '';
  readonly diasOpts = [
    { label: 'Últimos 30 días', value: 30 },
    { label: 'Últimos 60 días', value: 60 },
    { label: 'Últimos 90 días', value: 90 },
  ];

  readonly total = computed(() => this.data()?.resumen.requisiciones ?? 0);
  readonly filas = computed<FlujoRequisicionDto[]>(() => {
    const f = this.fEtapa();
    const rs = this.data()?.requisiciones ?? [];
    return f ? rs.filter((r) => r.etapa === f) : rs;
  });
  readonly negados = computed(() => this.data()?.negados_recurrentes ?? []);

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.data()?.resumen;
    if (!r) return [];
    // Sobre las que YA deberían tener OC: las de la ventana de espera y las sin fuente no cuentan.
    const evaluables = r.requisiciones - r.por_etapa.esperando - r.por_etapa.sin_fuente;
    return [
      { label: 'Requisiciones', value: String(r.requisiciones), format: 'text',
        sub: `${r.por_etapa.esperando} esperando OC` },
      { label: 'Con OC en Kepler', value: `${r.con_oc}`, format: 'text',
        sub: evaluables > 0
          ? `${Math.round((r.con_oc / evaluables) * 100)}% de ${evaluables} que ya debían tenerla · ${r.ambiguas} con duda`
          : 'sin datos',
        tone: 'default' },
      { label: 'Productos que vinieron', value: this.pct(r.renglones_en_oc_pct), format: 'text',
        sub: `${r.negados} de ${r.renglones_ligados} renglones negados`, tone: r.negados ? 'warn' : 'ok' },
      { label: 'Surtido OC→entrada', value: this.pct(r.surtido_mediana_pct), format: 'text',
        sub: `mediana de ${r.ocs_con_entrada} OC con entrada` },
    ];
  });

  private reloadSub?: Subscription;

  ngOnInit(): void {
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => {
        const ws = (f.warehouses ?? []).filter((w) => /^\d{2}$/.test(String(w.code)));
        this.sucOpts.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: String(w.code) })));
      },
      error: () => this.sucOpts.set([]),
    });
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.expandidas = {};
    // Una recarga cancela la anterior: la respuesta vieja no pisa a la nueva.
    this.reloadSub?.unsubscribe();
    this.reloadSub = this.api.purchaseFlow({ dias: this.fDias, sucursal: this.fSuc || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.data.set(d); this.loading.set(false); },
        // Sin datos se dice: no se deja la carga anterior al lado de un filtro nuevo.
        error: () => {
          this.data.set(null);
          this.error.set('No se pudo cargar el flujo de compras. Intenta de nuevo.');
          this.loading.set(false);
        },
      });
  }

  label(e: string): string { return FLUJO_ETAPA_LABEL[e as FlujoEtapa] ?? e; }
  pct(v: number | null | undefined): string { return v === null || v === undefined ? 'sin datos' : `${v}%`; }
  surtidoCls(p: number): string { return p < 50 ? 'fl-bad' : p < 90 ? 'fl-warn' : 'fl-ok'; }
  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
