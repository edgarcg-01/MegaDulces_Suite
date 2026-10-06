import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComprasService, RequisitionRow, RequisitionEstado, RequisitionResumen } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '@megadulces/contracts';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — bandeja de requisiciones de compra y traspasos entre sucursales. */
@Component({
  selector: 'app-compras-requisiciones',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, TagModule, TabsModule, ToastModule, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rq-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Requisiciones y Traspasos</h1>
          <p class="surf-page-sub">Gestión de abastecimiento interno entre sucursales y compras a proveedores.</p>
        </div>
      </header>

      <!-- [RQ.2] Antes de esto la pantalla devolvía una lista plana: ni un conteo, ni la
           antigüedad, con el filtro en "todos los estados" y 50 por página ordenadas por fecha.
           Medido en prod el 2026-10-06: 610 pendientes por $42.7 M, 24 días de promedio y 77 la
           más vieja — todo invisible desde acá, porque las viejas caen en la página 12. -->
      <app-metric-strip [items]="kpis()" ariaLabel="Requisiciones por estado" />

      @if (atascadas(); as a) {
        <div class="rq-alerta" role="status">
          <i class="pi pi-clock" aria-hidden="true"></i>
          <span><strong>{{ a.n | number }}</strong> requisición(es) llevan más de 30 días sin resolverse ({{ money(a.monto) }}).
            A esa edad el costo capturado ya no es el de hoy en la mayoría de los renglones: hay que <strong>recalcular</strong> antes de aprobar, o rechazarlas.</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="verPendientes()"><span class="p-button-label">Ver pendientes</span></button>
        </div>
      }

      <p-tabs [value]="tab()" (valueChange)="onTabChange($any($event))" styleClass="rq-tabs">
        <p-tablist>
          <p-tab value="supplier">
            <span class="rq-tab-title"><i class="pi pi-truck" aria-hidden="true"></i> Requerimientos a Proveedor</span>
          </p-tab>
          <p-tab value="branch">
            <span class="rq-tab-title"><i class="pi pi-arrow-right-arrow-left" aria-hidden="true"></i> Traspaso entre Sucursales</span>
          </p-tab>
        </p-tablist>

        <p-tabpanels>
          <!-- ── Pestaña 1: Requerimientos a Proveedor ── -->
          <p-tabpanel value="supplier">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
              <!-- [RQ.4] Mover las 610 pendientes exigia abrir 610 fichas: el costo de la bandeja
                   ERA el tramite. La barra solo existe cuando hay algo marcado -- un boton de lote
                   permanentemente apagado es ruido, no informacion. -->
              @if (sel().size > 0) {
                <div class="rq-lote" role="group" aria-label="Acciones en lote">
                  <span class="rq-lote-n">{{ sel().size }} marcada(s)</span>
                  <button pButton type="button" class="p-button-sm" [disabled]="!canManage || busy()" (click)="lote('approve')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [disabled]="!canManage || busy()" (click)="lote('reject')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarMarcas()"><span class="p-button-label">Quitar marcas</span></button>
                </div>
              }
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th class="rq-chk"><input type="checkbox" [checked]="todasMarcadas()" (change)="marcarTodas($any($event.target).checked)" aria-label="Marcar todas las de la página" /></th>
                  <th>Folio</th><th>Almacén</th><th>Proveedor</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo</th>
                  <th>Estado</th><th class="rq-r" title="Días desde que se creó. Lo calcula el servidor, no el reloj de esta máquina.">Días</th><th title="¿El costo capturado sigue siendo el de hoy? Se mide renglón por renglón contra el plan vigente.">Vigencia</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-chk" (click)="$event.stopPropagation()"><input type="checkbox" [checked]="sel().has(r.id)" (change)="marcar(r.id, $any($event.target).checked)" [attr.aria-label]="'Marcar ' + r.folio" /></td>
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td class="rq-muted">{{ r.supplier_name || 'Varios' }}</td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-r" [class.rq-viejo]="(r.dias ?? 0) > 30">{{ r.dias ?? '—' }}</td>
                  <td><p-tag [value]="vigLabel(r)" [severity]="vigSev(r)" [attr.title]="vigTitle(r)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="12" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar las requisiciones.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin requerimientos a proveedor todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── Pestaña 2: Traspaso entre Sucursales ── -->
          <p-tabpanel value="branch">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
              <!-- [RQ.4] Mover las 610 pendientes exigia abrir 610 fichas: el costo de la bandeja
                   ERA el tramite. La barra solo existe cuando hay algo marcado -- un boton de lote
                   permanentemente apagado es ruido, no informacion. -->
              @if (sel().size > 0) {
                <div class="rq-lote" role="group" aria-label="Acciones en lote">
                  <span class="rq-lote-n">{{ sel().size }} marcada(s)</span>
                  <button pButton type="button" class="p-button-sm" [disabled]="!canManage || busy()" (click)="lote('approve')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [disabled]="!canManage || busy()" (click)="lote('reject')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarMarcas()"><span class="p-button-label">Quitar marcas</span></button>
                </div>
              }
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th class="rq-chk"><input type="checkbox" [checked]="todasMarcadas()" (change)="marcarTodas($any($event.target).checked)" aria-label="Marcar todas las de la página" /></th>
                  <th>Folio</th><th>Origen</th><th>Destino</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo est.</th>
                  <th>Estado</th><th class="rq-r" title="Días desde que se creó. Lo calcula el servidor, no el reloj de esta máquina.">Días</th><th title="¿El costo capturado sigue siendo el de hoy? Se mide renglón por renglón contra el plan vigente.">Vigencia</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-chk" (click)="$event.stopPropagation()"><input type="checkbox" [checked]="sel().has(r.id)" (change)="marcar(r.id, $any($event.target).checked)" [attr.aria-label]="'Marcar ' + r.folio" /></td>
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-building rq-origin-icon" aria-hidden="true"></i> {{ r.source_warehouse_code || 'CEDIS' }}</span>
                  </td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-map-marker rq-dest-icon" aria-hidden="true"></i> {{ r.warehouse_code || '—' }}</span>
                  </td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-r" [class.rq-viejo]="(r.dias ?? 0) > 30">{{ r.dias ?? '—' }}</td>
                  <td><p-tag [value]="vigLabel(r)" [severity]="vigSev(r)" [attr.title]="vigTitle(r)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="12" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los traspasos.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin traspasos entre sucursales todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>
        </p-tabpanels>
      </p-tabs>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rq-tab-title { display: inline-flex; align-items: center; gap: .5rem; font-weight: 600; }
    .rq-filters { margin-bottom: .75rem; display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; } .rq-sel { min-width: 14rem; }
    .rq-lote { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .5rem;
               border: 1px solid var(--surface-border); border-radius: var(--radius-md);
               background: var(--surface-card); }
    .rq-lote-n { font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); margin-right: .25rem; }
    .rq-chk { width: 2.25rem; text-align: center; }
    .rq-chk input { cursor: pointer; }
    /* El rojo es del renglón que ya pasó los 30 días: a esa edad el costo capturado dejó de ser
       el de hoy en la mayoría de los renglones (83.5 % medido en prod en el tramo 31-60 d). */
    .rq-viejo { color: var(--bad-fg); font-weight: 700; }
    .rq-alerta { display: flex; align-items: center; gap: .6rem; margin: .5rem 0 .9rem;
                 padding: .6rem .8rem; border-radius: var(--radius-md);
                 border: 1px solid var(--warn-border);
                 background: var(--warn-soft-bg); font-size: var(--fs-body); }
    .rq-alerta i { color: var(--warn-soft-fg); }
    .rq-table { font-size: .84rem; }
    .rq-row { cursor: pointer; } .rq-row:hover { background: var(--surface-hover-bg); }
    .rq-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rq-mono { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; }
    .rq-muted { color: var(--text-muted); }
    .rq-empty { color: var(--text-muted); padding: 1.5rem; text-align: center; }
    .rq-wh-cell { display: inline-flex; align-items: center; gap: .35rem; }
    .rq-origin-icon { color: var(--primary, #0284c7); font-size: .85rem; }
    .rq-dest-icon { color: var(--text-color, #1f2937); font-size: .85rem; }
  `],
})
export class ComprasRequisicionesComponent implements OnInit {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  tab = signal<'supplier' | 'branch'>('supplier');
  rows = signal<RequisitionRow[]>([]);
  total = signal(0);
  loading = signal(false);
  error = signal(false); // §6: falla de carga ≠ "sin requisiciones"
  page = signal(1);
  /**
   * `[RQ.2]` ARRANCA EN "PENDIENTE DE APROBAR", no en "todos".
   *
   * Medido en prod el 2026-10-06: de 670 requisiciones, **610 están pendientes** y la bandeja
   * abría con el filtro vacío, 50 por página, ordenadas por fecha descendente — o sea que lo que
   * hay que resolver quedaba mezclado con lo cancelado y lo recibido, y las más viejas (hasta 77
   * días) caían en la página 12. Abrir en la cola que SÍ tiene trabajo es la diferencia entre una
   * bandeja y un archivo histórico.
   */
  fEstado: string = 'pending_approval';
  resumen = signal<RequisitionResumen[]>([]);
  busy = signal(false);
  /** `[RQ.4]` Lo marcado para el lote. Se limpia en cada recarga: otra consulta, otro universo. */
  sel = signal<Set<string>>(new Set());

  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  canManage = this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMPRAS_REQUISICIONES_GESTIONAR];

  estadoOpts = [
    { label: 'Pendiente de aprobar', value: 'pending_approval' },
    { label: 'Aprobada', value: 'approved' },
    { label: 'Ordenada', value: 'ordered' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void {
    const qTab = this.route.snapshot.queryParamMap.get('tab') || this.route.snapshot.queryParamMap.get('tipo');
    if (qTab === 'branch' || qTab === 'traspaso' || qTab === 'traspasos') {
      this.tab.set('branch');
    }
    this.reload();
  }

  onTabChange(newTab: 'supplier' | 'branch'): void {
    if (this.tab() === newTab) return;
    this.tab.set(newTab);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: newTab }, queryParamsHandling: 'merge' });
    this.reload();
  }

  reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.listRequisitions({
      estado: this.fEstado || undefined,
      source_type: this.tab(),
      page: this.page(),
      pageSize: 50,
    })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows); this.total.set(r.total); this.resumen.set(r.resumen ?? []);
          this.sel.set(new Set());   // otra consulta: lo marcado ya no aplica
          this.loading.set(false); this.error.set(false);
        },
        error: () => { this.loading.set(false); this.error.set(true); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    this.page.set(Math.floor((e.first || 0) / (e.rows || 50)) + 1);
    this.load();
  }

  open(r: RequisitionRow): void { this.router.navigate(['/compras/requisiciones', r.id]); }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }

  // ── `[RQ.2]` Lo que la bandeja no decía ────────────────────────────────────────────────────
  private deResumen(e: RequisitionEstado): RequisitionResumen | undefined {
    return this.resumen().find((x) => x.estado === e);
  }
  /**
   * El tablero de la bandeja. Las dos primeras casillas son la cola REAL de trabajo (pendientes y
   * aprobadas sin OC); las otras dos son el resultado.
   *
   * ⚠️ `format: 'text'` en las que pueden no existir: sin eso el strip toma la rama numérica y
   * `Number('—') || 0` pinta un **0**, que acá se leería "no hay nada pendiente" — justo el cero
   * dibujado que ADR-056 prohíbe.
   */
  kpis(): MetricStripItem[] {
    const p = this.deResumen('pending_approval');
    const a = this.deResumen('approved');
    const o = this.deResumen('ordered');
    const rc = this.deResumen('received');
    return [
      { label: 'Esperando aprobación', value: p?.n ?? 0, tone: (p?.n ?? 0) > 0 ? 'warn' : undefined,
        sub: p ? `${this.money(p.monto)} · ${p.dias_prom} d de promedio` : 'sin requisiciones' },
      { label: 'Aprobadas sin OC', value: a?.n ?? 0,
        sub: a ? `${this.money(a.monto)} · hasta ${a.dias_max} d parada(s)` : 'ninguna' },
      { label: 'Ordenadas', value: o?.n ?? 0, sub: o ? this.money(o.monto) : 'ninguna' },
      { label: 'Recibidas', value: rc?.n ?? 0, sub: rc ? this.money(rc.monto) : 'ninguna' },
    ];
  }
  /** Las pendientes que pasaron los 30 días — el escalón donde el costo deja de ser el de hoy. */
  atascadas(): { n: number; monto: number } | null {
    const p = this.deResumen('pending_approval');
    return p && p.n_mas_30 > 0 ? { n: p.n_mas_30, monto: p.monto_mas_30 } : null;
  }
  verPendientes(): void { this.fEstado = 'pending_approval'; this.reload(); }

  // ── `[RQ.1]` Vigencia en la fila ───────────────────────────────────────────────────────────
  /** TRES etiquetas, no dos: "sin medir" no es "al día" (ADR-056). */
  vigLabel(r: RequisitionRow): string {
    const v = r.vigencia;
    if (!v || v.vigente == null) return 'sin medir';
    return v.vigente ? 'al día' : `${v.movidos} movido(s)`;
  }
  vigSev(r: RequisitionRow): Sev {
    const v = r.vigencia;
    if (!v || v.vigente == null) return 'secondary';
    return v.vigente ? 'success' : 'warn';
  }
  vigTitle(r: RequisitionRow): string {
    const v = r.vigencia;
    if (!v) return 'No se pudo medir la vigencia de esta requisición.';
    if (v.vigente == null) return `Ninguno de sus ${v.renglones} renglones tiene costo comparable hoy: no se puede decir si sigue vigente.`;
    const cola = v.sin_medir > 0 ? ` · ${v.sin_medir} renglón(es) sin medir` : '';
    if (v.vigente) return `Los ${v.medibles} renglones medibles conservan el costo con el que se capturaron${cola}.`;
    return `${v.movidos} de ${v.medibles} renglones ya no tienen el costo de hoy: ${this.money(v.monto_capturado)} capturados contra ${this.money(v.monto_hoy)} actuales (${v.delta >= 0 ? '+' : ''}${this.money(v.delta)})${cola}. Recalculá antes de aprobar.`;
  }

  // ── `[RQ.4]` Lote ──────────────────────────────────────────────────────────────────────────
  marcar(id: string, on: boolean): void {
    this.sel.update((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }
  marcarTodas(on: boolean): void {
    this.sel.set(on ? new Set(this.rows().map((r) => r.id)) : new Set());
  }
  todasMarcadas(): boolean {
    const rs = this.rows();
    return rs.length > 0 && rs.every((r) => this.sel().has(r.id));
  }
  limpiarMarcas(): void { this.sel.set(new Set()); }
  /**
   * Manda el lote y **dice qué NO pasó, con su motivo**. El caso típico no es un error de sistema
   * sino el freno de `[RQ.3]`: la requisición ya no tiene el costo de hoy. Tragarlo dejaría al
   * usuario creyendo que aprobó 50 cuando aprobó 21.
   */
  lote(accion: 'approve' | 'reject'): void {
    const ids = [...this.sel()];
    if (!ids.length) return;
    this.busy.set(true);
    this.api.bulkRequisiciones(ids, accion).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.busy.set(false);
        const verbo = accion === 'approve' ? 'aprobada(s)' : 'rechazada(s)';
        if (r.hechas) this.toast.add({ severity: 'success', summary: `${r.hechas} ${verbo}`, life: 5000 });
        if (r.fallas.length) {
          const folios = new Map(this.rows().map((x) => [x.id, x.folio]));
          const det = r.fallas.slice(0, 3).map((f) => `${folios.get(f.id) || f.id.slice(0, 8)}: ${f.motivo}`).join(' · ');
          this.toast.add({
            severity: 'warn', summary: `${r.fallas.length} no se pudo(ieron)`, life: 15000,
            detail: det + (r.fallas.length > 3 ? ` · y ${r.fallas.length - 3} más` : ''),
          });
        }
        this.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo aplicar el lote', detail: e?.error?.message || 'Intentá de nuevo.' });
      },
    });
  }
}
