import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PROMOS_TABS } from '../promos-tabs';
import {
  PromoSelloutService,
  ResultadoCanal,
  ResumenAcuerdo,
  CoberturaCodigos,
  Conciliacion,
  EstadoMedicion,
} from '../promo-sellout.service';

/**
 * `[MKT.6]` — **¿La promoción movió la aguja?**
 *
 * ── Qué contesta esta pantalla que la de Acuerdos no ────────────────────────────────────────
 * `/mkt/acuerdos` prueba que la promoción **se ejecutó**: hay evidencia, en tal plaza, en tal
 * fecha. Ésta dice si **sirvió**, comparando la venta real del ERP durante la vigencia contra una
 * **línea base del mismo largo inmediatamente anterior**. Son dos preguntas distintas y por eso
 * son dos pestañas: mezclarlas haría que "subió tres fotos" y "vendió $12,000 más" se lean como
 * el mismo hecho.
 *
 * ── Lo que la pantalla NO puede hacer, y por qué ────────────────────────────────────────────
 *
 *  1. **Dibujar un cero donde no hubo medición.** `monto_ventana: null` significa cosas opuestas
 *     según `medicion`: con `sin_alcance` es *no se pudo mirar* (ningún código ligado al
 *     catálogo) y con `sin_venta` es *se miró y no vendió*. Se dibujan distinto —"—" contra
 *     "$0.00"— porque colapsarlos haría que un acuerdo a medio capturar se lea como un fracaso
 *     comercial (ADR-056). El KPI de arriba dice **sobre cuántos canales** está calculado.
 *  2. **Recortar con un `*ngIf`.** Qué plazas ve cada quien lo decide el alcance en el servidor
 *     (ADR-050). Acá sólo se elige qué dibujar; si el corte viviera en la plantilla, el número
 *     ya habría viajado en el JSON.
 *  3. **Ocultar que una ventana sigue abierta.** Un "HASTA AGOTAR" se corta HOY, así que mañana
 *     la cifra cambia sola. La fila lo marca, en vez de que alguien compare dos capturas de
 *     pantalla y no entienda por qué no coinciden.
 */
@Component({
  selector: 'app-mkt-resultado',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    PageTabsComponent, MetricStripComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="promoTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Resultado de la activación</h1>
          <p class="surf-page-sub">
            Venta durante la vigencia contra la misma cantidad de días anteriores · derivado del ERP
          </p>
        </div>
        <button pButton [text]="true" severity="secondary" size="small" (click)="recargar()"
                [loading]="cargando()" aria-label="Recargar">
          <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
        </button>
      </header>

      <app-metric-strip [items]="kpis()" />

      <!-- Lo que NO se pudo medir va arriba y con nombre: un tablero que lo esconde deja al
           lector creyendo que midió todo. -->
      @if (noMedidos() > 0) {
        <div class="res-aviso" role="status">
          <span class="pi pi-exclamation-triangle" aria-hidden="true"></span>
          <span>
            <strong>{{ noMedidos() }}</strong> de <strong>{{ filas().length }}</strong> canales no
            se pudieron medir:
            @if (cuenta('sin_alcance') > 0) {
              <b>{{ cuenta('sin_alcance') }}</b> sin códigos ligados al catálogo
            }
            @if (cuenta('sin_venta') > 0) {
              · <b>{{ cuenta('sin_venta') }}</b> sin ventas en la vigencia
            }
            @if (cuenta('sin_baseline') > 0) {
              · <b>{{ cuenta('sin_baseline') }}</b> sin periodo anterior con qué comparar
            }
          </span>
        </div>
      }

      <div class="surf-filters">
        @for (f of filtros; track f.valor) {
          <button type="button" class="surf-chip" [class.is-on]="filtro() === f.valor"
                  (click)="setFiltro(f.valor)">
            {{ f.label }} <span class="surf-chip-n">{{ conteoFiltro(f.valor) }}</span>
          </button>
        }
      </div>

      <div class="res-split">
        <section class="res-tabla dt-scope">
          <p-table [value]="visibles()" [loading]="cargando()" dataKey="channel_id"
                   selectionMode="single" [(selection)]="seleccion"
                   (selectionChange)="abrir($event)"
                   styleClass="p-datatable-sm surf-table" class="dt-stack" [scrollable]="true" scrollHeight="52vh">
            <ng-template #header>
              <tr>
                <th>Folio</th>
                <th>Proveedor</th>
                <th>Plaza</th>
                <th class="ta-r">Vigencia</th>
                <th class="ta-r">Venta</th>
                <th class="ta-r">Base</th>
                <th class="ta-r">Uplift</th>
                <th>Estado</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr [pSelectableRow]="r">
                <td class="mono" role="cell" data-label="Folio">{{ r.folio || '—' }}</td>
                <td class="dt-id" role="cell">{{ r.proveedor }}</td>
                <td role="cell" data-label="Plaza">
                  {{ r.warehouse_name || r.warehouse_code }}
                  <span class="res-plaza-code mono">{{ r.warehouse_code }}</span>
                </td>
                <td class="ta-r mono dt-num" role="cell" data-label="Vigencia">
                  {{ r.dias_ventana }} d
                  @if (r.ventana_abierta) {
                    <span class="res-abierta" title="HASTA AGOTAR: la ventana se corta hoy, la cifra es provisional">abierta</span>
                  }
                </td>
                <!-- El guion NO es un cero: es que no hay cifra. -->
                <td class="ta-r mono dt-num" role="cell" data-label="Venta">{{ dinero(r.monto_ventana) }}</td>
                <td class="ta-r mono dt-num" role="cell" data-label="Base">{{ dinero(r.monto_baseline) }}</td>
                <td class="ta-r mono dt-num" role="cell" data-label="Uplift" [class.res-sube]="(r.uplift_monto ?? 0) > 0"
                    [class.res-baja]="(r.uplift_monto ?? 0) < 0">
                  {{ dinero(r.uplift_monto) }}
                  @if (r.uplift_pct !== null) {
                    <span class="res-pct">{{ r.uplift_pct > 0 ? '+' : '' }}{{ r.uplift_pct }}%</span>
                  }
                </td>
                <td role="cell" data-label="Estado">
                  <p-tag [value]="etiqueta(r.medicion)" [severity]="tono(r.medicion)" />
                  @if (r.medicion === 'sin_alcance') {
                    <span class="res-cob mono">{{ r.codigos_ligados }}/{{ r.codigos_total }}</span>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="8" class="surf-empty">
                @if (cargando()) { Cargando… } @else { No hay activaciones con este filtro. }
              </td></tr>
            </ng-template>
          </p-table>
        </section>

        @if (seleccion) {
          <aside class="res-detalle">
            <header class="res-detalle-head">
              <div>
                <h2>{{ seleccion.proveedor }}</h2>
                <p class="mono">{{ seleccion.folio || 'sin folio' }} · {{ seleccion.warehouse_code }}</p>
              </div>
              <button pButton [text]="true" size="small" severity="secondary"
                      (click)="cerrar()" aria-label="Cerrar detalle">
                <span class="p-button-icon pi pi-times" aria-hidden="true"></span>
              </button>
            </header>

            <dl class="res-dl">
              <dt>Ventana</dt>
              <dd class="mono">{{ seleccion.desde }} → {{ seleccion.hasta }} ({{ seleccion.dias_ventana }} d)</dd>
              <dt>Días con venta</dt>
              <dd class="mono">{{ seleccion.dias_con_venta }} de {{ seleccion.dias_ventana }}</dd>
              <dt>Evidencia</dt>
              <dd class="mono">{{ seleccion.evidence_count }} de {{ seleccion.evidence_required }}</dd>
              <dt>Unidades</dt>
              <dd>
                @if (seleccion.unidad_estado === 'unica') {
                  <span class="mono">{{ seleccion.units_ventana }}</span>
                } @else if (seleccion.unidad_estado === 'mixta') {
                  <span class="res-nota">no comparables (la venta mezcla piezas y cajas)</span>
                } @else {
                  <span class="res-nota">sin dato</span>
                }
              </dd>
              <dt>Negociado</dt>
              <dd class="mono">{{ dinero(seleccion.monto_negociado) }}</dd>
            </dl>

            <!-- Diagnóstico: un "sin_alcance" mudo no le sirve a nadie. -->
            @if (cobertura(); as c) {
              <div class="res-bloque">
                <h3>Códigos del acuerdo</h3>
                <p>
                  <b>{{ c.ligados }}</b> de <b>{{ c.codigos_total }}</b> ligados al catálogo.
                  @if (c.sin_ligar_resolubles > 0) {
                    <span class="res-accion">
                      {{ c.sin_ligar_resolubles }} se pueden ligar: el SKU existe idéntico.
                      Se corrige al capturar el acuerdo.
                    </span>
                  }
                  @if (c.sin_ligar_sin_match > 0) {
                    <span class="res-nota">
                      {{ c.sin_ligar_sin_match }} sin producto que coincida.
                    </span>
                  }
                </p>
              </div>
            }

            <!-- El dinero del proveedor: lo pactado contra lo que de verdad acreditó. -->
            @if (conciliacion(); as k) {
              <div class="res-bloque">
                <h3>Negociado vs acreditado</h3>
                @if (k.estado === 'fuente_vacia') {
                  <p class="res-nota">{{ k.nota }}</p>
                } @else {
                  <p>
                    <span class="mono">{{ dinero(k.monto_negociado) }}</span> pactado ·
                    <span class="mono">{{ dinero(k.monto_acreditado) }}</span> acreditado
                    ({{ k.documentos }} doc.)
                  </p>
                  <p class="res-nota">{{ k.nota }}</p>
                }
              </div>
            }
          </aside>
        }
      </div>
    </div>
  `,
  styles: [`
    .res-aviso{display:flex;gap:.5rem;align-items:flex-start;padding:.6rem .75rem;margin:.5rem 0;
      border:1px solid var(--surf-border,#e7e5e4);border-left:3px solid var(--action,#c2410c);
      border-radius:var(--radius-sm,6px);font-size:var(--fs-sm);line-height:1.35;
      background:var(--surf-2,#fafaf9)}
    .surf-filters{display:flex;gap:.375rem;flex-wrap:wrap;margin:.5rem 0}
    .surf-chip{border:1px solid var(--surf-border,#e7e5e4);background:transparent;cursor:pointer;
      border-radius:999px;padding:.2rem .65rem;font-size:var(--fs-xs);line-height:1.6;
      color:var(--surf-fg-2,#57534e)}
    .surf-chip.is-on{border-color:var(--action,#c2410c);color:var(--action,#c2410c);font-weight:600}
    .surf-chip-n{opacity:.6;margin-left:.3rem;font-variant-numeric:tabular-nums}
    .res-split{display:grid;grid-template-columns:1fr;gap:.75rem}
    @media (min-width:68.75rem){.res-split:has(.res-detalle){grid-template-columns:1fr 340px}}
    .res-tabla{min-width:0}
    .mono{font-family:var(--font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
    .ta-r{text-align:right}
    .res-plaza-code{opacity:.55;margin-left:.4rem;font-size:.72rem}
    .res-abierta{margin-left:.35rem;font-size:.68rem;text-transform:uppercase;letter-spacing:.03em;
      color:var(--action,#c2410c)}
    .res-pct{margin-left:.35rem;font-size:.72rem;opacity:.75}
    .res-sube{color:var(--ok,#15803d)}
    .res-baja{color:var(--bad,#b91c1c)}
    .res-cob{margin-left:.35rem;font-size:.72rem;opacity:.6}
    .res-detalle{border:1px solid var(--surf-border,#e7e5e4);border-radius:var(--radius-md,8px);
      padding:.75rem;background:var(--surf-1,#fff);align-self:start}
    .res-detalle-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem}
    .res-detalle-head h2{font-size:.95rem;margin:0}
    .res-detalle-head p{margin:.1rem 0 0;font-size:var(--fs-xs);opacity:.65}
    .res-dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;margin:.75rem 0 0;
      font-size:var(--fs-sm)}
    .res-dl dt{opacity:.6}
    .res-dl dd{margin:0;text-align:right}
    .res-bloque{margin-top:.85rem;padding-top:.65rem;border-top:1px solid var(--surf-border,#e7e5e4)}
    .res-bloque h3{font-size:var(--fs-sm);margin:0 0 .3rem;text-transform:uppercase;
      letter-spacing:.04em;opacity:.7}
    .res-bloque p{margin:.2rem 0;font-size:var(--fs-sm);line-height:1.4}
    .res-nota{display:block;opacity:.7;font-size:var(--fs-xs);font-style:italic}
    .res-accion{display:block;color:var(--action,#c2410c);font-size:var(--fs-xs)}
    .surf-empty{text-align:center;padding:1.5rem;opacity:.6;font-size:var(--fs-sm)}
  `],
})
export class MktResultadoComponent {
  private readonly api = inject(PromoSelloutService);
  private readonly toast = inject(MessageService);

  readonly promoTabs = PROMOS_TABS;

  readonly filas = signal<ResultadoCanal[]>([]);
  readonly cargando = signal(false);
  readonly filtro = signal<'todos' | EstadoMedicion>('todos');
  readonly cobertura = signal<CoberturaCodigos | null>(null);
  readonly conciliacion = signal<Conciliacion | null>(null);

  /** La fila abierta. Plain property y no signal: `[(selection)]` de PrimeNG escribe acá. */
  seleccion: ResultadoCanal | null = null;

  readonly filtros: Array<{ valor: 'todos' | EstadoMedicion; label: string }> = [
    { valor: 'todos', label: 'Todos' },
    { valor: 'medida', label: 'Medidos' },
    { valor: 'sin_venta', label: 'Sin venta' },
    { valor: 'sin_baseline', label: 'Sin comparativo' },
    { valor: 'sin_alcance', label: 'Sin códigos ligados' },
  ];

  readonly visibles = computed(() => {
    const f = this.filtro();
    return f === 'todos' ? this.filas() : this.filas().filter((r) => r.medicion === f);
  });

  readonly medidos = computed(() => this.filas().filter((r) => r.medicion === 'medida'));
  readonly noMedidos = computed(() => this.filas().length - this.medidos().length);

  /**
   * KPIs. **Sólo sobre los canales medidos**, y el subtítulo dice sobre cuántos — un total que
   * suma los no medidos como cero afirma algo que nadie midió.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const m = this.medidos();
    const total = this.filas().length;
    const sub = total ? `sobre ${m.length} de ${total} canales` : 'sin datos';
    if (!m.length) {
      return [
        { label: 'Venta en vigencia', value: '—', format: 'text', sub },
        { label: 'Línea base', value: '—', format: 'text', sub },
        { label: 'Uplift', value: '—', format: 'text', sub: 'nada que se haya podido medir' },
        { label: 'Canales', value: total, format: 'number', sub: `${this.noMedidos()} sin medir` },
      ];
    }
    const venta = m.reduce((a, r) => a + (r.monto_ventana ?? 0), 0);
    const base = m.reduce((a, r) => a + (r.monto_baseline ?? 0), 0);
    const up = venta - base;
    return [
      { label: 'Venta en vigencia', value: venta, format: 'currency', sub },
      { label: 'Línea base', value: base, format: 'currency', sub: 'mismos días, justo antes' },
      {
        label: 'Uplift',
        value: up,
        format: 'currency',
        tone: up > 0 ? 'ok' : up < 0 ? 'bad' : 'default',
        // Sin base no hay porcentaje: no es "+infinito%", es que no había con qué comparar.
        sub: base > 0 ? `${Math.round((up / base) * 1000) / 10}%` : 'sin base para el %',
      },
      { label: 'Canales', value: total, format: 'number', sub: `${this.noMedidos()} sin medir` },
    ];
  });

  constructor() {
    this.recargar();
  }

  recargar(): void {
    this.cargando.set(true);
    this.api.listar().subscribe({
      next: (rows) => {
        this.filas.set(rows ?? []);
        this.cargando.set(false);
      },
      error: (e) => {
        this.cargando.set(false);
        this.toast.add({
          severity: 'error',
          summary: 'No se pudo cargar el resultado',
          detail: e?.error?.message || e?.message || 'Error de red',
        });
      },
    });
  }

  setFiltro(v: 'todos' | EstadoMedicion): void {
    this.filtro.set(v);
  }

  conteoFiltro(v: 'todos' | EstadoMedicion): number {
    return v === 'todos' ? this.filas().length : this.cuenta(v);
  }

  cuenta(e: EstadoMedicion): number {
    return this.filas().filter((r) => r.medicion === e).length;
  }

  abrir(r: ResultadoCanal | null): void {
    this.seleccion = r;
    this.cobertura.set(null);
    this.conciliacion.set(null);
    if (!r) return;
    this.api.cobertura(r.agreement_id).subscribe({
      next: (c) => this.cobertura.set(c),
      error: () => this.cobertura.set(null),
    });
    this.api.conciliacion(r.agreement_id).subscribe({
      next: (k) => this.conciliacion.set(k),
      error: () => this.conciliacion.set(null),
    });
  }

  cerrar(): void {
    this.seleccion = null;
    this.cobertura.set(null);
    this.conciliacion.set(null);
  }

  /**
   * `null` → guion, **nunca "$0.00"**. Es la regla entera de esta pantalla: un cero dibujado se
   * lee como una medición que dio cero, y acá casi siempre significa que no hubo medición.
   */
  dinero(v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  etiqueta(e: EstadoMedicion): string {
    return e === 'medida' ? 'Medido'
      : e === 'sin_venta' ? 'Sin venta'
      : e === 'sin_baseline' ? 'Sin comparativo'
      : 'Sin códigos ligados';
  }

  /** `sin_alcance` es `warn` y no `danger`: es un problema de captura, no un mal resultado. */
  tono(e: EstadoMedicion): 'success' | 'warn' | 'danger' | 'secondary' {
    return e === 'medida' ? 'success'
      : e === 'sin_venta' ? 'danger'
      : e === 'sin_baseline' ? 'secondary'
      : 'warn';
  }
}
