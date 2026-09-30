import { ChangeDetectionStrategy, Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DrawerModule } from 'primeng/drawer';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { LogisticaService, GuideCostRow, GuideCostBreakdown, GuideCostLines,
         GuideCostConceptoCat } from '../logistica.service';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';

/**
 * `[CGU.5]` — **Costo por guía de embarque, hasta el renglón de póliza.**
 *
 * Tres niveles, que es el recorrido pedido: elegir la guía → ver todos sus tipos de gasto →
 * hacer clic en uno y ver de qué pólizas sale.
 *
 * ── ⛔ Lo que esta pantalla NO puede dejar de decir ────────────────────────────────────
 *
 * El gasto **no existe por guía**: llega a canal + día, y hay entre 3.7 y 10.9 guías por
 * canal-día. Entonces cada cifra de costo lleva su chip de atribución con el denominador a la
 * vista (`4 de 9 paradas`). Sin el denominador, "atribuido" es un número que hay que creer.
 *
 * ⚠️ **`costo === null` se pinta "sin medir", nunca `$0.00`.** Son cosas distintas: cero dice
 * que el viaje fue gratis, que nadie midió. Y un cero en el denominador de un ROI da infinito.
 */
@Component({
  selector: 'app-guide-cost-panel',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TableModule, TagModule, DrawerModule,
    DatePickerModule, SelectModule, SkeletonModule, ButtonModule, SegmentedComponent,
    MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Filtros -->
    <div class="gc-bar">
      <div class="gc-field">
        <label>Desde</label>
        <p-datepicker [(ngModel)]="desde" dateFormat="yy-mm-dd" [showIcon]="true"
                      appendTo="body" (onSelect)="cargar()" />
      </div>
      <div class="gc-field">
        <label>Hasta</label>
        <p-datepicker [(ngModel)]="hasta" dateFormat="yy-mm-dd" [showIcon]="true"
                      appendTo="body" (onSelect)="cargar()" />
      </div>
      <div class="gc-field">
        <label>Canal</label>
        <app-segmented [options]="canales" [value]="canal()"
                       (valueChange)="setCanal($event)" ariaLabel="Canal de la guía" />
      </div>
      <div class="gc-field gc-grow">
        <label>Tipo de gasto</label>
        <p-select [options]="conceptos()" [(ngModel)]="conceptoFiltro" optionLabel="etiqueta"
                  optionValue="concepto" placeholder="Todos los tipos" [showClear]="true"
                  [filter]="true" appendTo="body" (onChange)="cargar()" />
      </div>
    </div>

    <app-metric-strip [items]="kpis()" ariaLabel="Costo logístico del período" />

    <!-- El retorno que SÍ se puede medir. No es margen y lo dice. -->
    <div class="gc-roi" *ngIf="lista()?.retorno as r">
      <div class="gc-roi-cell">
        <span>Erosión logística</span>
        <strong>{{ r.erosion_pct !== null ? (r.erosion_pct + '%') : 'sin medir' }}</strong>
        <small>del valor movido se va en logística</small>
      </div>
      <div class="gc-roi-cell">
        <span>Por cada $1 de logística</span>
        <strong>{{ r.pesos_movidos_por_peso_gastado !== null
                   ? ('$' + r.pesos_movidos_por_peso_gastado) : 'sin medir' }}</strong>
        <small>de mercancía movida</small>
      </div>
      <div class="gc-roi-cell gc-roi-nm" *ngIf="lista()?.margen_declarado as m">
        <span>Margen de ganancia</span>
        <strong>no disponible</strong>
        <small [title]="m.motivo">{{ m.en_su_lugar || m.motivo }}</small>
      </div>
    </div>

    <!-- ⭐ La banda de lo que NO se midió va ARRIBA, no al pie: es la condición de lectura de
         todo lo de abajo, no una nota al margen. -->
    <div class="gc-declara" role="status">
      <i class="pi pi-info-circle"></i>
      <div>
        <strong>Todo costo de esta pantalla es atribuido.</strong>
        El gasto se registra por canal y día, no por guía — se reparte proporcional a las paradas.
        <span *ngIf="lista()?.cobertura as c"> {{ c.note }}.</span>
        <span *ngIf="lista()?.margen_declarado as m"> Sin margen: {{ m.motivo }}</span>
      </div>
    </div>

    <div class="gc-split">
      <!-- NIVEL 1 — las guías -->
      <section class="gc-master">
        <p-table [value]="guias()" [loading]="cargando()" selectionMode="single"
                 [(selection)]="sel" (selectionChange)="abrirGuia($event)"
                 dataKey="guia" [scrollable]="true" scrollHeight="52vh"
                 styleClass="surf-table surf-table--sticky surf-table--zebra p-datatable-sm">
          <ng-template #header>
            <tr>
              <th>Fecha</th><th>Guía</th><th>Canal</th>
              <th class="comm-num">Paradas</th>
              <th class="comm-num">Mercancía</th>
              <th class="comm-num">Costo</th>
              <th class="comm-num">$/parada</th>
              <th>Cómo se calculó</th>
            </tr>
          </ng-template>
          <ng-template #body let-g>
            <tr [pSelectableRow]="g" [class.gc-sel]="sel?.guia === g.guia && sel?.dia === g.dia">
              <td>{{ g.dia }}</td>
              <td class="gc-mono">{{ g.sucursal }} · {{ g.guia }}</td>
              <td><p-tag [value]="etiquetaCanal(g.canal)" [severity]="sevCanal(g.canal)" /></td>
              <td class="comm-num">{{ g.paradas }}</td>
              <td class="comm-num">{{ g.mercancia | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="comm-num">
                <!-- null NO es cero: se dice, no se dibuja -->
                <span *ngIf="g.costo !== null; else sinCosto" class="gc-costo">
                  {{ g.costo | currency:'MXN':'symbol-narrow':'1.0-0' }}
                </span>
                <ng-template #sinCosto>
                  <span class="gc-nm" [title]="g.costo_motivo">sin medir</span>
                </ng-template>
              </td>
              <td class="comm-num">
                <span *ngIf="g.costo_por_parada !== null">
                  {{ g.costo_por_parada | currency:'MXN':'symbol-narrow':'1.0-0' }}
                </span>
                <span *ngIf="g.costo_por_parada === null" class="gc-nm">—</span>
              </td>
              <td>
                <span *ngIf="g.costo !== null" class="gc-chip"
                      [class.gc-chip--directo]="g.origen_peor === 'directo'">
                  {{ g.origen_peor === 'directo' ? 'Directo' : 'Atribuido' }}
                  <span *ngIf="g.conceptos"> · {{ g.conceptos }} conceptos</span>
                  <span *ngIf="g.pct_admin"> · {{ g.pct_admin }}% prorrateo admin</span>
                </span>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="8">
              <div class="comm-empty">
                <i class="pi pi-truck"></i>
                <p>Sin guías en el período</p>
              </div>
            </td></tr>
          </ng-template>
        </p-table>
      </section>

      <!-- NIVEL 2 — los conceptos de la guía elegida -->
      <aside class="gc-detail">
        <ng-container *ngIf="sel as g; else pickOne">
          <header class="gc-dhead">
            <h3>{{ g.sucursal }} · {{ g.guia }}</h3>
            <p>{{ g.dia }} · {{ g.paradas }} paradas · {{ etiquetaCanal(g.canal) }}</p>
          </header>

          <div *ngIf="cargandoDet()" class="gc-sk">
            <p-skeleton height="2rem" *ngFor="let _ of [1,2,3,4,5]" styleClass="mb-2" />
          </div>

          <ng-container *ngIf="!cargandoDet() && detalle() as d">
            <div class="gc-dtotal">
              <span>Costo atribuido</span>
              <strong>{{ d.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
            </div>
            <table class="surf-table surf-table--plain gc-conc">
              <thead>
                <tr><th>Tipo de gasto</th><th class="comm-num">Importe</th><th>Reparto</th></tr>
              </thead>
              <tbody>
                <tr *ngFor="let c of d.conceptos" (click)="abrirConcepto(c.concepto)"
                    class="gc-crow" tabindex="0" role="button"
                    (keydown.enter)="abrirConcepto(c.concepto)">
                  <td>
                    <span class="gc-cname">{{ c.concepto }}</span>
                    <small class="gc-admin">
                      <span *ngIf="c.de_prorrateo">incluye {{ c.de_prorrateo | currency:'MXN':'symbol-narrow':'1.0-0' }} de prorrateo · </span>
                      cuenta {{ c.cuentas }}
                    </small>
                  </td>
                  <td class="comm-num">{{ c.atribuido | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td>
                    <!-- El denominador a la vista: sin él, "atribuido" hay que creerlo -->
                    <small class="gc-share">
                      {{ c.paradas_guia }} de {{ c.paradas_bucket }} paradas
                      · {{ c.ventanas === 'mes' ? 'del mes' : c.ventanas === 'diario' ? 'del día' : c.ventanas }}
                    </small>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="gc-hint"><i class="pi pi-arrow-right"></i> Clic en un tipo de gasto para ver
              las pólizas que lo componen</p>
          </ng-container>
        </ng-container>
        <ng-template #pickOne>
          <div class="comm-empty gc-pick">
            <i class="pi pi-arrow-left"></i>
            <p>Elegí una guía para ver su desglose</p>
          </div>
        </ng-template>
      </aside>
    </div>

    <!-- NIVEL 3 — los renglones de póliza reales -->
    <p-drawer [(visible)]="verLineas" position="right" styleClass="gc-drawer"
              [header]="conceptoSel() || 'Detalle del gasto'">
      <ng-container *ngIf="lineas() as L">
        <div *ngIf="L.bucket as b" class="gc-bucket">
          <p class="gc-bnote">{{ b.nota }}</p>
          <div class="gc-brow"><span>Gasto del {{ b.ventana === 'mes' ? 'mes' : 'día' }}</span>
            <strong>{{ b.total_bucket | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
          <div class="gc-brow"><span>Le toca a esta guía ({{ b.paradas_guia }} de
            {{ b.paradas_bucket }} paradas)</span>
            <strong>{{ b.atribuido_a_esta_guia | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></div>
        </div>
        <table class="surf-table surf-table--plain gc-pol">
          <thead>
            <tr><th>Fecha</th><th>Documento</th><th>Beneficiario</th>
                <th class="comm-num">Importe</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let l of L.lineas">
              <td>{{ l.fecha | date:'yyyy-MM-dd' }}</td>
              <td class="gc-mono">{{ l.doc_tipo }}-{{ l.doc_folio }}
                <small class="gc-cta">{{ l.cuenta }} {{ l.cuenta_nombre }}</small></td>
              <td>{{ l.beneficiario || '—' }}
                <small *ngIf="l.comentario" class="gc-com">{{ l.comentario }}</small></td>
              <td class="comm-num">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
            </tr>
          </tbody>
        </table>
      </ng-container>
    </p-drawer>
  `,
  styles: [`
    .gc-bar { display:flex; gap:1rem; align-items:flex-end; flex-wrap:wrap; margin-bottom:1rem; }
    .gc-field { display:flex; flex-direction:column; gap:.25rem; }
    .gc-field label { font-size:.75rem; color:var(--text-muted,#78716c); font-weight:600; }
    .gc-grow { flex:1; min-width:16rem; }
    .gc-declara { display:flex; gap:.6rem; align-items:flex-start; padding:.7rem .9rem;
      background:var(--surface-soft,#faf9f7); border:1px solid var(--border,#e7e5e4);
      border-radius:var(--radius-md,8px); margin:.9rem 0; font-size:.82rem; line-height:1.45; }
    .gc-declara i { color:var(--action,#c2410c); margin-top:.1rem; }
    .gc-split { display:grid; grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);
      gap:1rem; align-items:start; }
    @media (max-width:1100px) { .gc-split { grid-template-columns:1fr; } }
    .gc-master, .gc-detail { border:1px solid var(--border,#e7e5e4);
      border-radius:var(--radius-md,8px); overflow:hidden; background:var(--surface,#fff); }
    .gc-detail { padding:1rem; min-height:18rem; }
    .gc-dhead h3 { margin:0; font-size:1rem; font-weight:700; }
    .gc-dhead p { margin:.15rem 0 .8rem; font-size:.8rem; color:var(--text-muted,#78716c); }
    .gc-dtotal { display:flex; justify-content:space-between; align-items:baseline;
      padding:.6rem .7rem; background:var(--surface-soft,#faf9f7);
      border-radius:var(--radius-sm,6px); margin-bottom:.7rem; }
    .gc-dtotal strong { font-size:1.15rem; font-variant-numeric:tabular-nums; }
    .gc-conc { width:100%; font-size:.82rem; }
    .gc-crow { cursor:pointer; }
    .gc-crow:hover, .gc-crow:focus-visible { background:var(--surface-soft,#faf9f7); outline:none; }
    .gc-cname { font-weight:600; }
    .gc-admin, .gc-share, .gc-cta, .gc-com { display:block; font-size:.7rem;
      color:var(--text-muted,#78716c); }
    .gc-hint { font-size:.75rem; color:var(--text-muted,#78716c); margin-top:.7rem; }
    .gc-mono { font-family:var(--font-mono,ui-monospace,monospace); font-size:.8rem; }
    .gc-costo { font-weight:600; font-variant-numeric:tabular-nums; }
    .gc-nm { color:var(--text-muted,#a8a29e); font-style:italic; font-size:.78rem; }
    .gc-chip { display:inline-block; padding:.1rem .45rem; border-radius:999px; font-size:.7rem;
      background:#fef3c7; color:#92400e; }
    .gc-chip--directo { background:#dcfce7; color:#166534; }
    .gc-sel { background:var(--surface-soft,#faf9f7); }
    .gc-bucket { padding:.8rem; background:var(--surface-soft,#faf9f7);
      border-radius:var(--radius-sm,6px); margin-bottom:.9rem; }
    .gc-bnote { margin:0 0 .6rem; font-size:.75rem; color:var(--text-muted,#78716c); }
    .gc-brow { display:flex; justify-content:space-between; gap:1rem; font-size:.82rem;
      padding:.2rem 0; }
    .gc-pol { width:100%; font-size:.8rem; }
    .gc-pick { padding:3rem 1rem; }
    .gc-sk { display:flex; flex-direction:column; gap:.4rem; }
    .gc-roi { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:.75rem;
      margin:.9rem 0; }
    .gc-roi-cell { padding:.7rem .9rem; border:1px solid var(--border,#e7e5e4);
      border-radius:var(--radius-md,8px); background:var(--surface,#fff); }
    .gc-roi-cell span { display:block; font-size:.72rem; color:var(--text-muted,#78716c);
      font-weight:600; text-transform:uppercase; letter-spacing:.02em; }
    .gc-roi-cell strong { display:block; font-size:1.35rem; font-variant-numeric:tabular-nums;
      margin:.15rem 0; }
    .gc-roi-cell small { font-size:.72rem; color:var(--text-muted,#78716c); }
    .gc-roi-nm strong { color:var(--text-muted,#a8a29e); font-size:1rem; font-style:italic; }
  `],
})
export class GuideCostPanelComponent implements OnInit {
  private readonly api = inject(LogisticaService);

  readonly canales: SegOption[] = [
    { label: 'Todos', value: '' },
    { label: 'A cliente', value: 'cliente' },
    { label: 'Carga a ruta', value: 'carga_ruta' },
    { label: 'Traspaso', value: 'traspaso' },
  ];

  desde = new Date(Date.now() - 30 * 864e5);
  hasta = new Date();
  readonly canal = signal('');
  /** Catálogo de tipos de gasto: sale de los datos, no de una lista fija. */
  readonly conceptos = signal<Array<GuideCostConceptoCat & { etiqueta: string }>>([]);
  conceptoFiltro: string | null = null;
  readonly lista = signal<import('../logistica.service').GuideCostList | null>(null);
  readonly cargando = signal(false);
  readonly guias = computed(() => this.lista()?.guias ?? []);

  sel: GuideCostRow | null = null;
  readonly detalle = signal<GuideCostBreakdown | null>(null);
  readonly cargandoDet = signal(false);

  verLineas = false;
  readonly conceptoSel = signal<string | null>(null);
  readonly lineas = signal<GuideCostLines | null>(null);

  ngOnInit() { this.cargar(); }

  private fmt(d: Date) {
    // Fecha en LOCAL, no toISOString(): en MX (UTC-6) el ISO corre el día hacia atrás.
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  setCanal(v: string) { this.canal.set(v); this.conceptoFiltro = null; this.cargar(); }

  cargar() {
    this.cargando.set(true);
    this.sel = null; this.detalle.set(null);
    this.api.guideCostConceptos({
      from: this.fmt(this.desde), to: this.fmt(this.hasta), canal: this.canal() || undefined,
    }).subscribe({
      next: (cs) => this.conceptos.set(cs.map((c) => ({
        ...c, etiqueta: `${c.concepto} · ${c.guias} guías`,
      }))),
    });
    this.api.guideCosts({
      from: this.fmt(this.desde), to: this.fmt(this.hasta),
      canal: this.canal() || undefined, concepto: this.conceptoFiltro || undefined, limit: 300,
    }).subscribe({
      next: (r) => { this.lista.set(r); this.cargando.set(false); },
      error: () => { this.cargando.set(false); },
    });
  }

  abrirGuia(g: GuideCostRow | null) {
    if (!g) return;
    this.sel = g;
    this.cargandoDet.set(true); this.detalle.set(null);
    this.api.guideCostBreakdown(g.sucursal, g.guia, this.fmt(this.desde), this.fmt(this.hasta))
      .subscribe({
        next: (d) => { this.detalle.set(d); this.cargandoDet.set(false); },
        error: () => this.cargandoDet.set(false),
      });
  }

  abrirConcepto(concepto: string) {
    if (!this.sel) return;
    this.conceptoSel.set(concepto);
    this.lineas.set(null);
    this.verLineas = true;
    this.api.guideCostLines(this.sel.sucursal, this.sel.guia, concepto,
      this.fmt(this.desde), this.fmt(this.hasta))
      .subscribe({ next: (l) => this.lineas.set(l) });
  }

  /**
   * ⛔ Los KPIs vienen del SERVIDOR (`totales`), calculados sobre el rango COMPLETO.
   *
   * Sumarlos acá sobre `guias()` era el bug reportado: la lista trae 300 filas y en 30 días hay
   * **847 guías**, así que el total mostraba **$349,691 contra $1,251,514 reales** — subdeclaraba
   * el 72 % y se leía como un dato, no como un truncamiento. Un total que depende del tamaño de
   * página no es un total.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const t = this.lista()?.totales;
    const cob = this.lista()?.cobertura;
    if (!t) return [];
    return [
      { label: 'Costo atribuido', value: t.costo, format: 'currency', tone: 'brand',
        sub: `${t.guias_con_costo} de ${t.guias} guías costeadas` },
      { label: 'Guías', value: t.guias, format: 'number',
        sub: t.truncado ? `${t.paradas} paradas · mostrando ${t.mostradas}` : `${t.paradas} paradas` },
      { label: 'Costo por parada', value: t.costo_por_parada ?? 0, format: 'currency',
        sub: 'promedio del período' },
      { label: 'Cobertura', value: cob?.pct ?? 0, format: 'percent',
        sub: cob?.note || 'sin medir' },
    ];
  });

  etiquetaCanal(c: string) {
    return c === 'cliente' ? 'A cliente'
      : c === 'carga_ruta' ? 'Carga a ruta'
      : c === 'traspaso' ? 'Traspaso' : c;
  }
  sevCanal(c: string): 'success' | 'info' | 'warn' {
    return c === 'cliente' ? 'success' : c === 'carga_ruta' ? 'info' : 'warn';
  }
}
