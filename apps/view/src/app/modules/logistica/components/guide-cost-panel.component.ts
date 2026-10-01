import { ChangeDetectionStrategy, Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DrawerModule } from 'primeng/drawer';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { LogisticaService, GuideCostRow, GuideCostBreakdown, GuideCostLines,
         GuideCostFiltroOpcion } from '../logistica.service';

/** Opción de filtro con su etiqueta ya armada para el select. */
type Opt = GuideCostFiltroOpcion & { etiqueta: string };
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
    DatePickerModule, SelectModule, InputTextModule, SkeletonModule, ButtonModule,
    SegmentedComponent,
    MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Filtros. Dos filas: el periodo y el canal arriba (lo que cambia el universo), el
         resto abajo (lo que acota dentro de el). -->
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
      <div class="gc-field gc-grow">
        <label>Canal</label>
        <app-segmented [options]="canales" [value]="canal()"
                       (valueChange)="setCanal($event)" ariaLabel="Canal de la guía" />
      </div>
    </div>

    <div class="gc-bar gc-bar2">
      <div class="gc-field">
        <label>Sucursal</label>
        <p-select [options]="f().sucursales" [(ngModel)]="sucursal" optionLabel="etiqueta"
                  optionValue="valor" placeholder="Todas" [showClear]="true"
                  appendTo="body" (onChange)="cargar()" />
      </div>
      <div class="gc-field">
        <label>Unidad</label>
        <p-select [options]="f().unidades" [(ngModel)]="unidad" optionLabel="etiqueta"
                  optionValue="valor" placeholder="Todas" [showClear]="true" [filter]="true"
                  appendTo="body" (onChange)="cargar()" />
      </div>
      <div class="gc-field gc-grow">
        <label>Tipo de gasto</label>
        <p-select [options]="f().conceptos" [(ngModel)]="conceptoFiltro" optionLabel="etiqueta"
                  optionValue="valor" placeholder="Todos los tipos" [showClear]="true"
                  [filter]="true" appendTo="body" (onChange)="cargar()" />
      </div>
      <div class="gc-field">
        <label>Buscar guía</label>
        <input pInputText [(ngModel)]="guiaBuscar" placeholder="folio…"
               (keyup.enter)="cargar()" (blur)="cargar()" />
      </div>
      <div class="gc-field">
        <label>Ordenar por</label>
        <p-select [options]="ordenes" [(ngModel)]="orden" optionLabel="label" optionValue="value"
                  appendTo="body" (onChange)="cargar()" />
      </div>
      <div class="gc-field gc-check">
        <!-- El filtro de CALIDAD del dato: que guias no se estan pudiendo costear. -->
        <label for="gcSinCosto">
          <input id="gcSinCosto" type="checkbox" [(ngModel)]="soloSinCosto" (change)="cargar()" />
          Sólo sin costear
        </label>
        <button pButton [text]="true" size="small" (click)="limpiar()"
                *ngIf="hayFiltros()">Limpiar</button>
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
      <div class="gc-roi-cell gc-roi-merc" *ngIf="lista()?.mercancia as mc">
        <span>Mercancía movida</span>
        <strong>{{ mc.valor | currency:'MXN':'symbol-narrow':'1.0-0' }}</strong>
        <small [title]="mc.nota">valor de lo movido, no su costo</small>
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
              <th class="comm-num">Directo</th>
              <th class="comm-num">Prorrateo</th>
              <th class="comm-num">Costo</th>
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
                <span *ngIf="g.costo_directo !== null">{{ g.costo_directo | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span *ngIf="g.costo_directo === null" class="gc-nm">—</span>
              </td>
              <td class="comm-num gc-pro">
                <span *ngIf="g.costo_prorrateado !== null">{{ g.costo_prorrateado | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
                <span *ngIf="g.costo_prorrateado === null" class="gc-nm">—</span>
              </td>
              <td class="comm-num">
                <!-- null NO es cero: se dice, no se dibuja -->
                <span *ngIf="g.costo !== null; else sinCosto" class="gc-costo">
                  {{ g.costo | currency:'MXN':'symbol-narrow':'1.0-0' }}
                </span>
                <ng-template #sinCosto>
                  <span class="gc-nm" [title]="g.costo_motivo">sin medir</span>
                </ng-template>
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
            <tr><td colspan="9">
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
            <!-- Agrupado por FAMILIA y plegable: el combustible es UNA linea de 13%, no tres
                 conceptos perdidos entre 97. Se abre para ver de que se compone. -->
            <div class="gc-fams">
              <div class="gc-fam" *ngFor="let f of detalle()?.familias">
                <button class="gc-fam-head" (click)="toggleFam(f.familia)"
                        [attr.aria-expanded]="abierta() === f.familia">
                  <i class="pi" [class.pi-chevron-right]="abierta() !== f.familia"
                     [class.pi-chevron-down]="abierta() === f.familia"></i>
                  <span class="gc-fam-name">{{ etiquetaFam(f.familia) }}</span>
                  <span class="gc-fam-n">{{ f.conceptos.length }}</span>
                  <span class="gc-fam-pct">{{ f.pct_del_total }}%</span>
                  <span class="gc-fam-split" *ngIf="f.prorrateado"
                        [title]="'Directo ' + (f.directo | currency:'MXN') + ' · prorrateo ' + (f.prorrateado | currency:'MXN')">
                    {{ f.directo | currency:'MXN':'symbol-narrow':'1.0-0' }}
                    <em>+{{ f.prorrateado | currency:'MXN':'symbol-narrow':'1.0-0' }}</em>
                  </span>
                  <strong>{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
                </button>
                <table class="surf-table surf-table--plain gc-conc"
                       *ngIf="abierta() === f.familia">
                  <tbody>
                    <tr *ngFor="let c of f.conceptos" (click)="abrirConcepto(c.concepto)"
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
                        <small class="gc-share">
                          {{ c.paradas_guia }} de {{ c.paradas_bucket }} paradas
                          · {{ c.ventanas === 'mes' ? 'del mes' : c.ventanas === 'diario' ? 'del día' : c.ventanas }}
                        </small>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
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
    <!-- ⚠️ El ancho va en [style] y NO en una clase: el drawer se monta fuera del componente y
         styleClass apuntaba a una clase que ademas nunca se definio, asi que se quedaba con el
         ancho por defecto de PrimeNG -- la tabla se apretaba y el IMPORTE quedaba cortado tras un
         scroll horizontal. Mismo patron que /finanzas/egresos/detalle. -->
    <p-drawer [(visible)]="verLineas" position="right" appendTo="body"
              [style]="{ width: '52rem', maxWidth: '96vw' }"
              [header]="conceptoSel() || 'Detalle del gasto'">
      <ng-container *ngIf="lineas() as L">
        <div *ngIf="L.bucket as b" class="gc-bucket">
          <p class="gc-bnote">{{ b.nota }}</p>
          <div class="gc-brow">
            <span>Gasto del {{ b.ventana === 'mes' ? 'mes' : 'día' }}</span>
            <strong>{{ b.total_bucket | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
          </div>
          <div class="gc-brow">
            <span>Le toca a esta guía
              <em>{{ b.paradas_guia }} de {{ b.paradas_bucket }} paradas</em></span>
            <strong>{{ b.atribuido_a_esta_guia | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong>
          </div>
        </div>

        <table class="surf-table surf-table--plain gc-pol">
          <colgroup>
            <col style="width:6.5rem" />
            <col style="width:11rem" />
            <col />
            <col style="width:7.5rem" />
          </colgroup>
          <thead>
            <tr><th>Fecha</th><th>Documento</th><th>Beneficiario / concepto</th>
                <th class="comm-num">Importe</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let l of L.lineas">
              <td class="gc-fecha">{{ l.fecha | date:'dd/MM/yy' }}</td>
              <td>
                <span class="gc-mono">{{ l.doc_tipo }}-{{ l.doc_folio }}</span>
                <small class="gc-cta">{{ l.cuenta }}</small>
              </td>
              <td>
                <span class="gc-benef">{{ l.beneficiario || '—' }}</span>
                <!-- El comentario es la pista de QUE unidad o ruta fue: se conserva, pero
                     acotado a dos lineas para que no empuje la columna del importe. -->
                <small *ngIf="l.comentario" class="gc-com" [title]="l.comentario">{{ l.comentario }}</small>
              </td>
              <td class="comm-num gc-imp">{{ l.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
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
    /* table-layout fijo + colgroup: las columnas no se reacomodan segun el contenido, que es
       lo que empujaba el IMPORTE fuera de la vista. */
    .gc-pol { width:100%; font-size:.8rem; table-layout:fixed; }
    .gc-pol td { vertical-align:top; padding:.45rem .5rem; }
    .gc-fecha { white-space:nowrap; font-variant-numeric:tabular-nums; }
    .gc-benef { display:block; font-weight:500; overflow-wrap:anywhere; }
    .gc-imp { white-space:nowrap; font-variant-numeric:tabular-nums; font-weight:600; }
    .gc-com { display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden; overflow-wrap:anywhere; }
    .gc-brow em { font-style:normal; color:var(--text-muted,#78716c); font-size:.75rem;
      display:block; }
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
    /* La mercancia se separa visualmente del costo operativo: son dos naturalezas distintas y
       sumarlas no significa nada. */
    .gc-roi-merc { border-left:3px solid var(--border-strong,#d6d3d1); }
    .gc-fams { display:flex; flex-direction:column; gap:.3rem; }
    .gc-fam { border:1px solid var(--border,#e7e5e4); border-radius:var(--radius-sm,6px);
      overflow:hidden; }
    .gc-fam-head { display:flex; align-items:center; gap:.5rem; width:100%; padding:.55rem .7rem;
      background:var(--surface,#fff); border:0; cursor:pointer; text-align:left; font-size:.82rem; }
    .gc-fam-head:hover, .gc-fam-head:focus-visible { background:var(--surface-soft,#faf9f7);
      outline:none; }
    .gc-fam-head i { font-size:.7rem; color:var(--text-muted,#78716c); }
    .gc-fam-name { font-weight:600; flex:1; }
    .gc-fam-n { font-size:.7rem; color:var(--text-muted,#78716c);
      background:var(--surface-soft,#faf9f7); padding:.05rem .4rem; border-radius:999px; }
    .gc-fam-pct { font-size:.72rem; color:var(--text-muted,#78716c); min-width:2.6rem;
      text-align:right; }
    .gc-fam-head strong { font-variant-numeric:tabular-nums; min-width:6.5rem; text-align:right; }
    /* El prorrateo se distingue del costo propio: es lo que se le ASIGNÓ, no lo que gastó. */
    .gc-fam-split { font-size:.7rem; color:var(--text-muted,#78716c); font-variant-numeric:tabular-nums; }
    .gc-fam-split em { font-style:normal; color:var(--action,#c2410c); }
    .gc-pro { color:var(--text-muted,#78716c); }
    .gc-bar2 { padding-top:.2rem; border-top:1px dashed var(--border,#e7e5e4); }
    .gc-bar2 .gc-field { min-width:10rem; }
    .gc-check { justify-content:flex-end; flex-direction:row; align-items:center; gap:.6rem; }
    .gc-check label { display:flex; align-items:center; gap:.35rem; cursor:pointer;
      font-size:.78rem; text-transform:none; color:var(--text,#292524); }
    .gc-check input[type=checkbox] { accent-color:var(--action,#c2410c); }
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
  /** Catálogo de filtros: sale de los datos, no de listas fijas. */
  readonly f = signal<{ conceptos: Opt[]; sucursales: Opt[]; unidades: Opt[] }>(
    { conceptos: [], sucursales: [], unidades: [] });
  conceptoFiltro: string | null = null;
  sucursal: string | null = null;
  unidad: string | null = null;
  guiaBuscar = '';
  soloSinCosto = false;
  orden = 'fecha';
  readonly ordenes = [
    { label: 'Más reciente', value: 'fecha' },
    { label: 'Mayor costo', value: 'costo' },
    // Otra pregunta distinta: un viaje de 19 paradas siempre cuesta más en total.
    { label: 'Mayor costo por parada', value: 'por_parada' },
    { label: 'Más paradas', value: 'paradas' },
    { label: 'Mayor mercancía', value: 'mercancia' },
  ];
  readonly lista = signal<import('../logistica.service').GuideCostList | null>(null);
  readonly cargando = signal(false);
  readonly guias = computed(() => this.lista()?.guias ?? []);

  sel: GuideCostRow | null = null;
  readonly detalle = signal<GuideCostBreakdown | null>(null);
  readonly cargandoDet = signal(false);

  /** Qué familia está abierta. Una sola a la vez: el detalle es para comparar, no para inundar. */
  readonly abierta = signal<string | null>(null);
  toggleFam(f: string) { this.abierta.set(this.abierta() === f ? null : f); }

  readonly FAM_LABEL: Record<string, string> = {
    personal: 'Personal (sueldos, comisiones, bonos)',
    combustible: 'Combustible',
    vehiculo: 'Vehículo (arrendamiento, mantenimiento, seguro)',
    viaje: 'Viaje (casetas, viáticos, maniobras)',
    valores: 'Traslado de valores',
    local: 'Local (renta y servicios)',
    tecnologia: 'Tecnología (GPS, telefonía)',
    otros: 'Otros',
  };
  etiquetaFam(f: string) { return this.FAM_LABEL[f] || f; }

  verLineas = false;
  readonly conceptoSel = signal<string | null>(null);
  readonly lineas = signal<GuideCostLines | null>(null);

  ngOnInit() { this.cargar(); }

  private fmt(d: Date) {
    // Fecha en LOCAL, no toISOString(): en MX (UTC-6) el ISO corre el día hacia atrás.
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  setCanal(v: string) {
    // El canal cambia el universo: los catálogos se recalculan y un concepto o una unidad del
    // canal anterior puede no existir acá. Se limpian en vez de dejar un filtro que no aplica.
    this.canal.set(v); this.conceptoFiltro = null; this.unidad = null; this.cargar();
  }

  private opt(o: { valor: string; detalle?: string; guias: number }, sub: string) {
    return { ...o, etiqueta: `${o.detalle || o.valor} · ${sub}` };
  }

  hayFiltros() {
    return !!(this.sucursal || this.unidad || this.conceptoFiltro || this.guiaBuscar.trim()
      || this.soloSinCosto || this.orden !== 'fecha' || this.canal());
  }

  limpiar() {
    this.sucursal = null; this.unidad = null; this.conceptoFiltro = null;
    this.guiaBuscar = ''; this.soloSinCosto = false; this.orden = 'fecha';
    this.canal.set(''); this.cargar();
  }

  cargar() {
    this.cargando.set(true);
    this.sel = null; this.detalle.set(null);
    this.api.guideCostFiltros({
      from: this.fmt(this.desde), to: this.fmt(this.hasta), canal: this.canal() || undefined,
    }).subscribe({
      next: (r) => this.f.set({
        conceptos: r.conceptos.map((o) => this.opt(o, `${o.guias} guías`)),
        sucursales: r.sucursales.map((o) => this.opt(o, `${o.guias} guías · ${o.paradas} paradas`)),
        unidades: r.unidades.map((o) => this.opt(o, `${o.guias} guías`)),
      }),
    });
    this.api.guideCosts({
      from: this.fmt(this.desde), to: this.fmt(this.hasta),
      canal: this.canal() || undefined, concepto: this.conceptoFiltro || undefined,
      sucursal: this.sucursal || undefined, unidad: this.unidad || undefined,
      guia: this.guiaBuscar.trim() || undefined,
      solo_sin_costo: this.soloSinCosto || undefined,
      orden: this.orden, limit: 300,
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
      { label: 'Costo operativo directo', value: t.costo_directo, format: 'currency',
        tone: 'brand', sub: 'su departamento es este canal' },
      { label: 'Prorrateo administrativo', value: t.costo_prorrateado, format: 'currency',
        sub: `${t.pct_prorrateado ?? 0}% del costo · repartido por actividad` },
      { label: 'Guías', value: t.guias, format: 'number',
        sub: t.truncado ? `${t.paradas} paradas · mostrando ${t.mostradas}` : `${t.paradas} paradas` },
      { label: 'Costo por parada', value: t.costo_por_parada ?? 0, format: 'currency',
        sub: 'directo + prorrateo' },
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
