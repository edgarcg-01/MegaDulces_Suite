import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { SD_PRIORITIES, SD_STATUSES, SD_UBICACIONES_EXTRA, type SdAgentDto, type SdCategoryDto, type SdRequestRow, type SdStatsResponse } from '@megadulces/contracts';
import { STORE_BRANCHES } from '../../../core/constants/store-branches';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PRIORITY_LABEL, STATUS_LABEL, ServiceDeskService, sdError, slaTexto, type SdInboxQuery } from '../service-desk.service';
import { SdRequestDetailComponent } from '../sd-request-detail.component';

/**
 * `[MS.3.4]` Mesa de Servicio › Bandeja (`/servicio/bandeja`) — el trabajo de quien atiende.
 *
 * Orden del servidor: prioridad → vencimiento → antigüedad por omisión, o la columna que se pulse (`[MS.3.16]`, también en el
 * servidor: la bandeja trae 100 de N y ordenar sólo esas 100 en la pantalla mentiría); acá se filtra. Los KPI de arriba
 * salen de `GET /requests/stats` (marcas idempotentes del barrido del SLA), no se recalculan en el
 * navegador. Operations (DESIGN.md): tabla densa a la izquierda, ficha a la derecha; abajo de
 * 1100 px la ficha reemplaza a la lista, y en teléfono se esconden las columnas secundarias.
 */
/** Las columnas que el servidor sabe ordenar (`libs/service-desk/.../inbox-sort.ts`); el E2E comprueba que cada una se acepta. */
type ColumnaOrden = 'folio' | 'solicitud' | 'reporto' | 'ubicacion' | 'prioridad' | 'estado' | 'atiende' | 'plazo' | 'alta';
/** Lo que casi siempre se quiere ver primero al pulsar una columna: lo más urgente / más reciente, o de la A a la Z. */
const direccionInicial = (c: ColumnaOrden): 'asc' | 'desc' => (c === 'prioridad' || c === 'alta' ? 'desc' : 'asc');

@Component({
  selector: 'app-servicio-bandeja',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, InputTextModule, ButtonModule, SdRequestDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sb-page" [class.con-ficha]="!!selId()">
      <header class="sb-head">
        <div>
          <h1>Bandeja de atención</h1>
          <p>Lo más urgente y lo que más tiempo lleva esperando va arriba. Toma una solicitud para empezar.</p>
        </div>
        <div class="sb-head-actions">
          <p-button icon="pi pi-plus" label="Levantar solicitud" (onClick)="levantar()" />
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="recargar()" />
        </div>
      </header>

      @if (st(); as s) {
        <section class="sb-kpis" aria-label="Resumen">
          <div class="sb-kpi"><b>{{ s.open_total }}</b><span>Abiertas</span></div>
          <div class="sb-kpi" [class.warn]="s.unassigned > 0"><b>{{ s.unassigned }}</b><span>Sin asignar</span></div>
          <div class="sb-kpi" [class.bad]="s.first_response_breached > 0"><b>{{ s.first_response_breached }}</b><span>Sin primera respuesta a tiempo</span></div>
          <div class="sb-kpi" [class.bad]="s.resolution_breached > 0"><b>{{ s.resolution_breached }}</b><span>Fuera de plazo</span></div>
        </section>
      }

      <section class="sb-chips" aria-label="Filtrar">
        @for (c of scopes; track c.value) {
          <button type="button" class="sb-chip" [class.on]="scope() === c.value" (click)="setScope(c.value)">{{ c.label }}</button>
        }
        <p-select class="sb-pri" [options]="prioridades" optionLabel="label" optionValue="value" [ngModel]="prio()"
                  (ngModelChange)="setPrio($event)" placeholder="Cualquier prioridad" [showClear]="true" appendTo="body" ariaLabel="Filtrar por prioridad" />
        <span class="sb-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Buscar folio, título o persona" [ngModel]="search()" (ngModelChange)="setSearch($event)" aria-label="Buscar solicitud" />
        </span>
      </section>

      <button type="button" class="sb-filtros-toggle" [attr.aria-expanded]="filtrosAbiertos()" (click)="filtrosAbiertos.set(!filtrosAbiertos())">
        <i class="pi pi-filter" aria-hidden="true"></i> Más filtros y orden@if (nFiltros() > 0) { <b>{{ nFiltros() }}</b> }
        <i class="pi" [ngClass]="filtrosAbiertos() ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true"></i>
      </button>
      <section class="sb-filtros" [class.abierto]="filtrosAbiertos()" aria-label="Más filtros">
        <p-select class="sb-f" [options]="estados" optionLabel="label" optionValue="value" [ngModel]="estado()" (ngModelChange)="setFiltro('estado', $event)"
                  placeholder="Cualquier estado" [showClear]="true" appendTo="body" ariaLabel="Filtrar por estado" />
        <p-select class="sb-f" [options]="categorias()" optionLabel="name" optionValue="id" [ngModel]="categoria()" (ngModelChange)="setFiltro('categoria', $event)"
                  placeholder="Cualquier categoría" [showClear]="true" [filter]="true" filterBy="name" appendTo="body" ariaLabel="Filtrar por categoría" />
        <p-select class="sb-f" [options]="atienden()" optionLabel="label" optionValue="value" [ngModel]="atiende()" (ngModelChange)="setFiltro('atiende', $event)"
                  placeholder="Quien atiende" [showClear]="true" [filter]="true" filterBy="label" appendTo="body" ariaLabel="Filtrar por quien atiende" />
        <p-select class="sb-f" [options]="ubicaciones" optionLabel="name" optionValue="code" [ngModel]="ubic()" (ngModelChange)="setFiltro('ubic', $event)"
                  placeholder="Cualquier ubicación" [showClear]="true" appendTo="body" ariaLabel="Filtrar por ubicación" />
        <label class="sb-fecha">Alta desde
          <input type="date" pInputText [ngModel]="desde()" [max]="hasta() || null" (ngModelChange)="setDesde($event)" aria-label="Alta desde" />
        </label>
        <label class="sb-fecha">hasta
          <input type="date" pInputText [ngModel]="hasta()" [min]="desde() || null" (ngModelChange)="setHasta($event)" aria-label="Alta hasta" />
        </label>
        @if (hayFiltros()) {
          <p-button class="sb-limpiar" icon="pi pi-filter-slash" label="Limpiar filtros" [text]="true" size="small" (onClick)="limpiar()" />
        }
        @if (sortCol(); as col) {
          <span class="sb-orden" role="status">Ordenado por {{ etiquetaColumna(col) }} {{ sortDir() === 'asc' ? '↑' : '↓' }}
            <button type="button" class="sb-quitar" (click)="quitarOrden()">Quitar orden</button></span>
        }
      </section>

      @if (loadError(); as e) { <p class="sb-banner bad" role="alert">{{ e }}</p> }

      <div class="sb-body" [class.has-detail]="!!selId()">
        <section class="sb-list" aria-label="Solicitudes">
          <div class="sb-wrap dt-scope">
            <table class="sb-table dt-stack">
              <thead>
                <tr>
                  @for (h of columnas; track h.col) {
                    <th [class.opc]="h.opc" [attr.aria-sort]="ariaSort(h.col)">
                      <button type="button" class="sb-th" [class.on]="sortCol() === h.col" (click)="ordenar(h.col)" [attr.aria-label]="'Ordenar por ' + h.label">
                        {{ h.label }}<i class="pi" [ngClass]="iconoOrden(h.col)" aria-hidden="true"></i>
                      </button>
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (t of rows(); track t.id) {
                  <tr [class.sel]="selId() === t.id" (click)="abrir(t.id)" tabindex="0" (keydown.enter)="abrir(t.id)">
                    <td class="mono" role="cell" data-label="Folio">{{ t.folio }}</td>
                    <td class="tit dt-id" role="cell" data-label="Solicitud">{{ t.title }}<small>{{ t.category_name }}</small></td>
                    <td class="opc" role="cell" data-label="Reportó">{{ t.requester_name || '—' }}</td>
                    <td class="opc" role="cell" data-label="Ubicación">{{ t.warehouse_name || '—' }}</td>
                    <td role="cell" data-label="Prioridad"><span class="pri" [attr.data-p]="t.priority">{{ priorityLabel[t.priority] }}</span></td>
                    <td role="cell" data-label="Estado"><span class="est" [attr.data-s]="t.status">{{ statusLabel[t.status] }}</span></td>
                    <td class="opc" role="cell" data-label="Atiende">{{ t.assigned_to_name || '—' }}</td>
                    <td role="cell" data-label="Plazo"><span class="sla" [attr.data-t]="plazo(t).tono">{{ plazo(t).texto }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="8" class="vacio">
                    @if (loading()) { Cargando… }
                    @else if (search() || hayFiltros() || scope() !== 'open') { Ninguna solicitud con estos filtros. }
                    @else { No hay solicitudes abiertas. }
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (total() > rows().length) { <p class="sb-more">Mostrando {{ rows().length }} de {{ total() }}. Filtra para acotar.</p> }
        </section>

        @if (selId(); as id) {
          <section class="sb-detail" aria-label="Ficha">
            <p-button class="sb-back" icon="pi pi-arrow-left" label="Volver a la bandeja" [text]="true" severity="secondary" size="small" (onClick)="cerrar()" />
            <app-sd-request-detail [id]="id" [agent]="true" [coord]="esCoordinador()" (cambio)="alCambiar()" (cerrar)="cerrar()" />
          </section>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sb-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .sb-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .sb-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); }
    .sb-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .sb-head-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .sb-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); }
    .sb-kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .sb-kpi b { font: 700 var(--fs-h2)/1 var(--font-mono); color: var(--text-main); }
    .sb-kpi span { font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-kpi.warn b { color: var(--warn-fg); }
    .sb-kpi.bad b { color: var(--bad-fg); }
    .sb-chips { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .sb-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill);
      padding: 4px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .sb-chip.on { border-color: var(--action); color: var(--text-main); background: var(--surface-selected-bg); }
    .sb-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sb-pri { min-width: 180px; }
    .sb-filtros-toggle { display: none; align-items: center; gap: var(--sp-2); border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main);
      border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; min-height: 40px; }
    .sb-filtros-toggle b { background: var(--action); color: var(--action-fg, #fff); border-radius: var(--r-pill); padding: 0 var(--sp-2); font-size: var(--fs-xs); }
    .sb-filtros-toggle .pi:last-child { margin-left: auto; }
    .sb-filtros-toggle:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sb-filtros { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .sb-f { min-width: 170px; }
    .sb-fecha { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .sb-fecha input { width: 9.5rem; }
    .sb-orden { font-size: var(--fs-xs); color: var(--text-muted); margin-left: auto; display: inline-flex; gap: var(--sp-2); align-items: center; }
    .sb-quitar { border: 0; background: none; color: var(--action); cursor: pointer; font-size: var(--fs-xs); padding: 2px 4px; text-decoration: underline; }
    .sb-quitar:focus-visible, .sb-th:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sb-th { border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .sb-th .pi { font-size: 0.65rem; color: var(--text-faint); }
    .sb-th.on, .sb-th.on .pi { color: var(--text-main); }
    .sb-th:hover { color: var(--text-main); }
    .sb-search { position: relative; flex: 1 1 220px; max-width: 360px; margin-left: auto; }
    .sb-search i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: var(--fs-xs); }
    .sb-search input { width: 100%; padding-left: 30px; }
    .sb-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .sb-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sb-body { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
    .sb-body.has-detail { grid-template-columns: minmax(0, 1.3fr) minmax(380px, 1fr); }
    .sb-list, .sb-detail { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .sb-wrap { overflow: auto; max-height: calc(100vh - 330px); }
    .sb-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .sb-table th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600; color: var(--text-muted);
      font-size: var(--fs-xs); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .sb-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: top; }
    .sb-table tbody tr { cursor: pointer; }
    .sb-table tbody tr:hover { background: var(--surface-hover-bg); }
    .sb-table tbody tr.sel { background: var(--surface-selected-bg); }
    .sb-table tbody tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .mono { font-family: var(--font-mono); font-size: var(--fs-xs); white-space: nowrap; }
    .tit { font-weight: 600; overflow-wrap: anywhere; }
    .tit small { display: block; font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
    .vacio { text-align: center; color: var(--text-muted); padding: var(--sp-6) !important; cursor: default; }
    .pri, .est, .sla { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; }
    .pri { color: var(--text-muted); }
    .pri[data-p='alta'] { color: var(--warn-fg); background: var(--warn-soft-bg); }
    .pri[data-p='urgente'] { color: var(--bad-fg); background: var(--bad-soft-bg); font-weight: 600; }
    .est { background: var(--surface-2); color: var(--text-muted); }
    .est[data-s='asignado'], .est[data-s='en_proceso'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .est[data-s='en_espera'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .est[data-s='resuelto'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .sla { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .sla[data-t='warn'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .sla[data-t='bad'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .sb-more { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    .sb-detail { padding: var(--sp-4); position: sticky; top: var(--sp-4); max-height: calc(100vh - 2 * var(--sp-4)); overflow: auto; }
    .sb-back { display: none; }
    /* Con la ficha abierta la lista es un ÍNDICE, no la tabla completa: quedan folio, solicitud, prioridad, estado y plazo.
       (Medido a 1440 px: con las 8 columnas el título se partía en 6 renglones.) La ficha trae el resto. */
    .sb-body.has-detail .opc { display: none; }
    @media (max-width: 68.75rem) {
      .sb-body.has-detail { grid-template-columns: 1fr; }
      .sb-body.has-detail .sb-list { display: none; }
      .sb-detail { position: static; max-height: none; }
      .sb-back { display: inline-flex; align-self: flex-start; margin: calc(-1 * var(--sp-2)) 0 var(--sp-2) calc(-1 * var(--sp-2)); }
      /* La ficha REEMPLAZA a la lista, así que también a lo que la acompaña: KPIs y filtros dejaban la ficha bajo el pliegue. */
      .sb-page.con-ficha .sb-kpis, .sb-page.con-ficha .sb-chips, .sb-page.con-ficha .sb-filtros, .sb-page.con-ficha .sb-head { display: none; }
    }
    @media (max-width: 40rem) {
      .sb-page { padding: var(--sp-3); gap: var(--sp-3); }
      .sb-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .sb-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .sb-chip { flex: none; min-height: 36px; }
      .sb-search { flex: 0 0 220px; margin-left: 0; }
      /* En teléfono los seis filtros apilados empujaban la lista fuera de la pantalla: quedan tras un botón. */
      .sb-filtros-toggle { display: flex; }
      .sb-filtros:not(.abierto) { display: none; }
      .sb-page.con-ficha .sb-filtros-toggle { display: none; }
      .sb-f { flex: 1 1 100%; }
      .sb-fecha { flex: 1 1 100%; justify-content: space-between; }
      .sb-orden { margin-left: 0; }
      .sb-wrap { max-height: none; }
      .sb-head p-button, .sb-head p-button ::ng-deep button { width: 100%; justify-content: center; }
    }
  `],
})
export class ServicioBandejaComponent implements OnInit {
  private readonly api = inject(ServiceDeskService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  /** `[MS.3.11]` Quien atiende también levanta solicitudes (a su nombre o a nombre de otra persona): el formulario es el mismo. */
  levantar(): void { void this.router.navigate(['/servicio/solicitudes'], { queryParams: { nueva: 1 } }); }

  readonly statusLabel = STATUS_LABEL;
  readonly priorityLabel = PRIORITY_LABEL;
  readonly prioridades = SD_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));
  readonly scopes = [
    { value: 'unassigned', label: 'Sin asignar' }, { value: 'mine', label: 'Mías' }, { value: 'waiting', label: 'En espera' },
    { value: 'open', label: 'Abiertas' }, { value: 'resolved', label: 'Resueltas' }, { value: 'all', label: 'Todas' },
  ];

  readonly estados = SD_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));
  readonly ubicaciones: { code: string; name: string }[] = [...STORE_BRANCHES, ...Object.entries(SD_UBICACIONES_EXTRA).map(([code, name]) => ({ code, name }))];
  /** Las columnas ordenables, con la clave que entiende el servidor (`sort=`). */
  readonly columnas: { col: ColumnaOrden; label: string; opc: boolean }[] = [
    { col: 'folio', label: 'Folio', opc: false }, { col: 'solicitud', label: 'Solicitud', opc: false }, { col: 'reporto', label: 'Reportó', opc: true },
    { col: 'ubicacion', label: 'Ubicación', opc: true }, { col: 'prioridad', label: 'Prioridad', opc: false }, { col: 'estado', label: 'Estado', opc: false },
    { col: 'atiende', label: 'Atiende', opc: true }, { col: 'plazo', label: 'Plazo', opc: false },
  ];

  readonly rows = signal<SdRequestRow[]>([]);
  readonly total = signal(0);
  readonly st = signal<SdStatsResponse | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly scope = signal('unassigned');
  readonly prio = signal<string | null>(null);
  readonly search = signal('');
  readonly estado = signal<string | null>(null);
  readonly categoria = signal<string | null>(null);
  readonly atiende = signal<string | null>(null);
  readonly ubic = signal<string | null>(null);
  readonly desde = signal('');
  readonly hasta = signal('');
  readonly sortCol = signal<ColumnaOrden | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  readonly categorias = signal<SdCategoryDto[]>([]);
  readonly agentes = signal<SdAgentDto[]>([]);
  /** «Sin asignar» primero (es lo que más se busca), luego las personas por nombre. */
  readonly atienden = computed(() => [
    { value: 'none', label: 'Sin asignar' },
    ...this.agentes().map((a) => ({ value: a.user_id, label: a.name || a.username })).sort((x, y) => x.label.localeCompare(y.label, 'es')),
  ]);
  /** Hay algún filtro puesto además del alcance (los chips) — decide el botón «Limpiar» y el texto del vacío. */
  /** Sólo teléfono: los filtros extra van tras un botón. En escritorio siempre se ven. */
  readonly filtrosAbiertos = signal(false);
  /** Cuántos filtros hay puestos (se muestra en el botón del teléfono, para no esconder que hay uno activo). */
  readonly nFiltros = computed(() => [this.prio(), this.estado(), this.categoria(), this.atiende(), this.ubic(), this.desde(), this.hasta(), this.sortCol()].filter(Boolean).length);
  readonly hayFiltros = computed(() => !!(this.prio() || this.estado() || this.categoria() || this.atiende() || this.ubic() || this.desde() || this.hasta() || this.sortCol()));
  readonly selId = signal<string | null>(null);
  /** Reasigna quien coordina; el servidor lo vuelve a exigir (`SERVICIO_COORDINAR` o god-mode). */
  readonly esCoordinador = computed(() => this.perms.has(Permission.SERVICIO_COORDINAR));

  ngOnInit(): void {
    // El alcance del enlace se fija ANTES de la primera carga: si no, se pedía «Sin asignar» y enseguida «Mías», dos
    // respuestas en carrera donde la lenta pisa a la rápida.
    const inicial = this.route.snapshot?.queryParamMap?.get('scope');
    if (inicial && this.scopes.some((s) => s.value === inicial)) this.scope.set(inicial);
    this.api.catalog().subscribe({ next: (c) => this.categorias.set(c.categories), error: () => this.categorias.set([]) });
    this.api.agents().subscribe({ next: (a) => this.agentes.set(a), error: () => this.agentes.set([]) });
    this.recargar();
    // Deep-link de la campana: `?id=<solicitud>` abre su ficha. Se ESCUCHA, no se lee una vez: si ya estás en la
    // bandeja y pulsas un aviso, Angular reutiliza el componente y sólo cambia el parámetro (medido en vivo: la URL
    // cambiaba y la pantalla no).
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const id = q.get('id');
      if (id) this.abrir(id);
      // `?scope=mine` (el enlace de «A tu nombre» en Mi trabajo). Sólo valores de la lista: uno inventado se ignora y la
      // bandeja abre como siempre, en vez de pedirle al servidor un alcance que no existe (devolvería 400).
      const scope = q.get('scope');
      if (scope && scope !== this.scope() && this.scopes.some((s) => s.value === scope)) this.setScope(scope);
    });
  }

  recargar(): void {
    this.cargarLista();
    this.api.stats().subscribe({ next: (s) => this.st.set(s), error: () => this.st.set(null) });
  }

  /** La consulta que se manda al servidor. Pública para que la prueba verifique QUÉ se pide, no sólo que se pide. */
  consulta(): SdInboxQuery {
    return {
      scope: this.scope(),
      priority: this.prio() ?? undefined,
      status: this.estado() ?? undefined,
      category_id: this.categoria() ?? undefined,
      assigned_to: this.atiende() ?? undefined,
      warehouse_code: this.ubic() ?? undefined,
      from: this.desde() || undefined,
      to: this.hasta() || undefined,
      sort: this.sortCol() ?? undefined,
      dir: this.sortCol() ? this.sortDir() : undefined,
      search: this.search().trim() || undefined,
      limit: 100,
    };
  }

  /** Número de la última consulta: si una respuesta vieja llega después de una nueva (clics seguidos en una columna), se descarta. */
  private seq = 0;
  private cargarLista(): void {
    const mi = ++this.seq;
    this.loading.set(true);
    this.loadError.set(null);
    this.api.inbox(this.consulta()).subscribe({
      next: (r) => { if (mi !== this.seq) return; this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: (e) => { if (mi !== this.seq) return; this.loadError.set(sdError(e, 'No se pudo cargar la bandeja.')); this.loading.set(false); },
    });
  }

  setScope(s: string): void { this.scope.set(s); this.cargarLista(); }
  setPrio(p: string | null): void { this.prio.set(p); this.cargarLista(); }
  setFiltro(cual: 'estado' | 'categoria' | 'atiende' | 'ubic', v: string | null): void {
    const s = { estado: this.estado, categoria: this.categoria, atiende: this.atiende, ubic: this.ubic }[cual];
    s.set(v || null);
    this.cargarLista();
  }
  /** Un rango al revés ('desde' después de 'hasta') no se manda: se arrastra el otro extremo, y no se llega al 400 del servidor. */
  setDesde(v: string | null): void {
    this.desde.set(v || '');
    if (v && this.hasta() && v > this.hasta()) this.hasta.set(v);
    this.cargarLista();
  }
  setHasta(v: string | null): void {
    this.hasta.set(v || '');
    if (v && this.desde() && v < this.desde()) this.desde.set(v);
    this.cargarLista();
  }
  /** Quita los filtros y el orden elegido; el alcance (los chips) se queda donde está. */
  limpiar(): void {
    this.prio.set(null); this.estado.set(null); this.categoria.set(null); this.atiende.set(null); this.ubic.set(null);
    this.desde.set(''); this.hasta.set('');
    this.sortCol.set(null); this.sortDir.set('asc');
    this.cargarLista();
  }

  /** Clic en una columna: primero su dirección natural, luego la contraria, y un tercer clic vuelve al orden por urgencia. */
  ordenar(col: ColumnaOrden): void {
    if (this.sortCol() !== col) { this.sortCol.set(col); this.sortDir.set(direccionInicial(col)); }
    else if (this.sortDir() === direccionInicial(col)) this.sortDir.set(direccionInicial(col) === 'asc' ? 'desc' : 'asc');
    else { this.sortCol.set(null); this.sortDir.set('asc'); }
    this.cargarLista();
  }
  quitarOrden(): void { this.sortCol.set(null); this.sortDir.set('asc'); this.cargarLista(); }
  ariaSort(col: ColumnaOrden): 'ascending' | 'descending' | 'none' {
    if (this.sortCol() !== col) return 'none';
    return this.sortDir() === 'asc' ? 'ascending' : 'descending';
  }
  iconoOrden(col: ColumnaOrden): string {
    if (this.sortCol() !== col) return 'pi-sort-alt';
    return this.sortDir() === 'asc' ? 'pi-arrow-up' : 'pi-arrow-down';
  }
  etiquetaColumna(col: ColumnaOrden): string { return this.columnas.find((c) => c.col === col)?.label ?? col; }
  private timer?: ReturnType<typeof setTimeout>;
  setSearch(v: string): void {
    this.search.set(v);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cargarLista(), 300);
  }

  abrir(id: string): void { this.selId.set(id); }
  cerrar(): void { this.selId.set(null); }
  /** Un cambio en la ficha mueve la fila de filtro (p. ej. tomarla la saca de «Sin asignar»). */
  alCambiar(): void { this.recargar(); }

  plazo(t: SdRequestRow): { texto: string; tono: 'ok' | 'warn' | 'bad' | 'mute' } { return slaTexto(t.sla, t.status); }
}
