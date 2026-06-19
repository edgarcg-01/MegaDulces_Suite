import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { ComercialService, AbcRow, AbcSummary, CycleDueResult, Warehouse } from '../comercial.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent, PageTab } from '../../../shared/components/page-tabs/page-tabs.component';

/**
 * Fase ABC.3b — Conteo cíclico (ABC). Surface Operations (DESIGN.md):
 * page-head Hanken bold, KPI strip + tabla densa como organismos, in-page sin sombra,
 * p-tag [severity] mapeado a tokens, tabular-nums en cifras, acción=sunset / ghost.
 *
 * Dos vistas de la misma data: AGENDA (qué toca contar, cycle-due, accionable) y
 * CLASIFICACIÓN (ABC por valor de consumo). Acciones: recalcular ABC + generar folios.
 */
@Component({
  selector: 'app-comercial-inventory-abc',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, SelectButtonModule, ToastModule, ConfirmDialogModule, TooltipModule, PageTabsComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <app-page-tabs [tabs]="inventoryTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Conteo cíclico</h1>
          <p class="surf-page-sub">Clasificá por valor (ABC) y contá lo que toca — control continuo</p>
        </div>
        <div class="abc-head-actions">
          <p-select [options]="whOptions()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
                    placeholder="Todos los almacenes" [showClear]="true" (onChange)="load()" styleClass="abc-wh"
                    ariaLabel="Filtrar por almacén"></p-select>
          <button pButton type="button" label="Recalcular ABC" icon="pi pi-sync" [text]="true" severity="secondary"
                  size="small" (click)="recalc()" [loading]="working()"></button>
          <button pButton type="button" label="Generar folios" icon="pi pi-plus" size="small"
                  (click)="confirmGenerate()" [loading]="working()" [disabled]="!warehouseId()"
                  [pTooltip]="warehouseId() ? '' : 'Seleccioná un almacén para generar su folio cíclico'"></button>
        </div>
      </header>

      <!-- KPI strip: variedad por tipo de dato (DESIGN §9) -->
      <div class="abc-kpis">
        <div class="abc-kpi">
          <span class="abc-kpi-l">Por contar ahora</span>
          <span class="abc-kpi-v">{{ due()?.count ?? 0 }}</span>
          <div class="abc-kpi-foot">
            <span class="abc-dot abc-a"></span>A {{ due()?.by_class?.A ?? 0 }}
            <span class="abc-dot abc-b"></span>B {{ due()?.by_class?.B ?? 0 }}
            <span class="abc-dot abc-c"></span>C {{ due()?.by_class?.C ?? 0 }}
          </div>
        </div>
        <div class="abc-kpi">
          <span class="abc-kpi-l">Valor clasificado (costo/año)</span>
          <span class="abc-kpi-v">{{ (summary()?.total_value ?? 0) | currency:'MXN':'symbol-narrow':'1.0-0' }}</span>
          <div class="abc-kpi-foot">{{ summary()?.total_count ?? 0 }} SKUs · {{ computedLabel() }}</div>
        </div>
        <div class="abc-kpi abc-kpi-wide">
          <span class="abc-kpi-l">Distribución ABC</span>
          <div class="abc-dist-bar" role="img" [attr.aria-label]="distAria()">
            @if (total() > 0) {
              <div class="abc-dist-seg abc-a" [style.flexBasis.%]="pct('A')" [title]="'A: ' + classCount('A')"></div>
              <div class="abc-dist-seg abc-b" [style.flexBasis.%]="pct('B')" [title]="'B: ' + classCount('B')"></div>
              <div class="abc-dist-seg abc-c" [style.flexBasis.%]="pct('C')" [title]="'C: ' + classCount('C')"></div>
            }
          </div>
          <div class="abc-kpi-foot">
            <span class="abc-dot abc-a"></span>A {{ classCount('A') }}
            <span class="abc-dot abc-b"></span>B {{ classCount('B') }}
            <span class="abc-dot abc-c"></span>C {{ classCount('C') }}
          </div>
        </div>
      </div>

      <!-- Toggle de vista -->
      <p-selectButton [options]="views" [(ngModel)]="view" optionLabel="label" optionValue="value"
                      [allowEmpty]="false" styleClass="abc-views" ariaLabel="Cambiar vista"></p-selectButton>

      @if (view() === 'due') {
        <!-- AGENDA: qué toca contar -->
        <p-table [value]="due()?.items ?? []" [loading]="loading()" styleClass="p-datatable-sm surf-table"
                 [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th>Clase</th><th>SKU</th><th>Producto</th><th>Almacén</th>
              <th>Último conteo</th><th class="abc-num">Cadencia</th><th>Estado</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-it>
            <tr>
              <td><p-tag [value]="it.abc_class" [severity]="classSeverity(it.abc_class)"></p-tag></td>
              <td class="abc-mono">{{ it.sku || '—' }}</td>
              <td class="abc-name">{{ it.product_name || '—' }}</td>
              <td class="abc-mono">{{ it.warehouse_code }}</td>
              <td class="abc-mono">{{ it.last_counted_at ? (it.last_counted_at | date:'dd/MM/yy') : 'Nunca' }}</td>
              <td class="abc-num">{{ it.cadence_days }} d</td>
              <td><p-tag [value]="dueLabel(it)" [severity]="dueSeverity(it)"></p-tag></td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="7" class="abc-empty">
              Nada pendiente de contar en esta vista. Si no clasificaste aún, usá <b>Recalcular ABC</b>; el conteo se agenda por cadencia (A 30d · B 90d · C 365d).
            </td></tr>
          </ng-template>
        </p-table>
      } @else {
        <!-- CLASIFICACIÓN ABC -->
        <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table"
                 [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="50">
          <ng-template pTemplate="header">
            <tr>
              <th>Clase</th><th>SKU</th><th>Producto</th><th>Almacén</th>
              <th class="abc-num">Valor anual</th><th class="abc-num">Unidades</th><th class="abc-num">% acum.</th>
            </tr>
          </ng-template>
          <ng-template pTemplate="body" let-it>
            <tr>
              <td><p-tag [value]="it.abc_class" [severity]="classSeverity(it.abc_class)"></p-tag></td>
              <td class="abc-mono">{{ it.sku || '—' }}</td>
              <td class="abc-name">{{ it.product_name || '—' }}</td>
              <td class="abc-mono">{{ it.warehouse_code }}</td>
              <td class="abc-num">{{ it.annual_value | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
              <td class="abc-num">{{ it.units_window }}</td>
              <td class="abc-num">{{ (+it.value_share * 100) | number:'1.0-1' }}%</td>
            </tr>
          </ng-template>
          <ng-template pTemplate="emptymessage">
            <tr><td colspan="7" class="abc-empty">
              Sin clasificación ABC. Corré <b>Recalcular ABC</b> para clasificar por valor de consumo (ventas 90d × costo).
            </td></tr>
          </ng-template>
        </p-table>
      }
    </div>
  `,
  styles: [`
    .abc-head-actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    :host ::ng-deep .abc-wh { min-width: 220px; }
    .abc-kpis { display: flex; gap: .75rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .abc-kpi { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); padding: .8rem 1.1rem; display: flex; flex-direction: column; gap: .35rem; min-width: 190px; }
    .abc-kpi-wide { min-width: 280px; flex: 1; }
    .abc-kpi-l { font-size: .6875rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
    .abc-kpi-v { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--text-main); }
    .abc-kpi-foot { font-size: .75rem; color: var(--text-muted); display: flex; align-items: center; gap: .35rem; font-variant-numeric: tabular-nums; }
    .abc-dot { width: 9px; height: 9px; border-radius: 999px; display: inline-block; }
    .abc-dot.abc-a, .abc-dist-seg.abc-a { background: var(--ok-fg); }
    .abc-dot.abc-b, .abc-dist-seg.abc-b { background: var(--warn-fg); }
    .abc-dot.abc-c, .abc-dist-seg.abc-c { background: var(--stone-400, #b0a595); }
    .abc-dot:not(:first-child) { margin-left: .5rem; }
    .abc-dist-bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; background: var(--surface-ground); }
    .abc-dist-seg { min-width: 2px; transition: flex-basis 250ms var(--ease-standard, ease); }
    :host ::ng-deep .abc-views { margin-bottom: .75rem; }
    :host ::ng-deep .abc-views .p-button { font-size: .8125rem; padding: .35rem .9rem; }
    .abc-mono { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .abc-name { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .abc-num { text-align: right; font-variant-numeric: tabular-nums; }
    .abc-empty { text-align: center; padding: 2rem; color: var(--text-muted); line-height: 1.5; }
  `],
})
export class ComercialInventoryAbcComponent {
  readonly inventoryTabs: PageTab[] = [
    { label: 'Existencias', route: '/comercial/inventory', icon: 'pi pi-box', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Folios', route: '/comercial/inventory/sessions', icon: 'pi pi-clipboard', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Por vencer', route: '/comercial/inventory/expiring', icon: 'pi pi-calendar-times', permission: Permission.COMMERCIAL_INVENTORY_VER },
    { label: 'Cíclico', route: '/comercial/inventory/abc', icon: 'pi pi-sync', permission: Permission.COMMERCIAL_INVENTORY_SUPERVISAR },
    { label: 'Pasillos', route: '/comercial/inventory/aisles', icon: 'pi pi-th-large', permission: Permission.COMMERCIAL_INVENTORY_ASIGNAR },
  ];
  readonly views = [
    { label: 'Agenda de conteo', value: 'due' },
    { label: 'Clasificación ABC', value: 'class' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly destroyRef = inject(DestroyRef);

  loading = signal(false);
  working = signal(false);
  view = signal<'due' | 'class'>('due');
  warehouseId = signal<string | null>(null);
  whOptions = signal<{ label: string; value: string }[]>([]);
  summary = signal<AbcSummary | null>(null);
  rows = signal<AbcRow[]>([]);
  due = signal<CycleDueResult | null>(null);

  total = computed(() => this.summary()?.total_count ?? 0);

  constructor() {
    this.svc.listWarehouses()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (ws: Warehouse[]) => this.whOptions.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }))) });
    this.load();
  }

  load() {
    this.loading.set(true);
    const wh = this.warehouseId() || undefined;
    forkJoin({
      summary: this.svc.abcSummary(wh),
      rows: this.svc.listAbc({ warehouse_id: wh }),
      due: this.svc.cycleDue({ warehouse_id: wh, only_due: true }),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.summary.set(r.summary); this.rows.set(r.rows || []); this.due.set(r.due); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar ABC' }); },
      });
  }

  recalc() {
    this.working.set(true);
    this.svc.refreshAbc(90)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          this.toast.add({ severity: 'success', summary: 'ABC recalculado', detail: `${r.classified} SKUs clasificados` });
          this.load();
        },
        error: () => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo recalcular ABC' }); },
      });
  }

  confirmGenerate() {
    const whLabel = this.whOptions().find((o) => o.value === this.warehouseId())?.label || 'el almacén';
    this.confirm.confirm({
      header: 'Generar folios cíclicos',
      message: `Se abrirá un folio de conteo cíclico para ${whLabel} con los productos que toca contar (prioriza clase A). ¿Continuar?`,
      acceptLabel: 'Generar',
      rejectLabel: 'Cancelar',
      accept: () => this.generate(),
    });
  }

  private generate() {
    this.working.set(true);
    this.svc.generateCycleFolios({ warehouse_id: this.warehouseId() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          if (r.folios_created > 0)
            this.toast.add({ severity: 'success', summary: 'Folios generados', detail: `${r.folios_created} folio(s) cíclico(s) abierto(s)` });
          else if (r.skipped > 0)
            this.toast.add({ severity: 'info', summary: 'Sin cambios', detail: 'Ya hay un folio abierto para este almacén' });
          else
            this.toast.add({ severity: 'info', summary: 'Nada que contar', detail: 'No hay productos pendientes en este almacén' });
          this.load();
        },
        error: () => { this.working.set(false); this.toast.add({ severity: 'error', summary: 'No se pudieron generar folios' }); },
      });
  }

  classCount(c: 'A' | 'B' | 'C'): number {
    return this.summary()?.by_class?.[c]?.count ?? 0;
  }
  pct(c: 'A' | 'B' | 'C'): number {
    const t = this.total();
    return t > 0 ? (this.classCount(c) / t) * 100 : 0;
  }
  distAria(): string {
    return `Distribución ABC: A ${this.classCount('A')}, B ${this.classCount('B')}, C ${this.classCount('C')}`;
  }
  computedLabel(): string {
    const at = this.summary()?.computed_at;
    if (!at) return 'sin calcular';
    const d = new Date(at);
    return `calc. ${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}`;
  }

  classSeverity(c: string): 'success' | 'warn' | 'secondary' {
    return c === 'A' ? 'success' : c === 'B' ? 'warn' : 'secondary';
  }
  dueLabel(it: { is_due: boolean; last_counted_at: string | null; days_overdue: number | null }): string {
    if (!it.is_due) return 'A tiempo';
    if (it.last_counted_at == null) return 'Nunca contado';
    if ((it.days_overdue ?? 0) > 0) return `Vencido ${it.days_overdue}d`;
    return 'Toca contar';
  }
  dueSeverity(it: { is_due: boolean; days_overdue: number | null }): 'danger' | 'warn' | 'secondary' {
    if (!it.is_due) return 'secondary';
    return (it.days_overdue ?? 0) > 0 ? 'danger' : 'warn';
  }
}
