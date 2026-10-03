import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { SD_PRIORITIES, type SdRequestRow, type SdStatsResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PRIORITY_LABEL, STATUS_LABEL, ServiceDeskService, sdError, slaTexto } from '../service-desk.service';
import { SdRequestDetailComponent } from '../sd-request-detail.component';

/**
 * `[MS.3.4]` Mesa de Servicio › Bandeja (`/servicio/bandeja`) — el trabajo de quien atiende.
 *
 * Orden del servidor: prioridad → vencimiento → antigüedad; acá sólo se filtra. Los KPI de arriba
 * salen de `GET /requests/stats` (marcas idempotentes del barrido del SLA), no se recalculan en el
 * navegador. Operations (DESIGN.md): tabla densa a la izquierda, ficha a la derecha; abajo de
 * 1100 px la ficha reemplaza a la lista, y en teléfono se esconden las columnas secundarias.
 */
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
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="recargar()" />
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

      @if (loadError(); as e) { <p class="sb-banner bad" role="alert">{{ e }}</p> }

      <div class="sb-body" [class.has-detail]="!!selId()">
        <section class="sb-list" aria-label="Solicitudes">
          <div class="sb-wrap dt-scope">
            <table class="sb-table dt-stack">
              <thead>
                <tr><th>Folio</th><th>Solicitud</th><th class="opc">Reportó</th><th class="opc">Sucursal</th><th>Prioridad</th><th>Estado</th><th class="opc">Atiende</th><th>Plazo</th></tr>
              </thead>
              <tbody>
                @for (t of rows(); track t.id) {
                  <tr [class.sel]="selId() === t.id" (click)="abrir(t.id)" tabindex="0" (keydown.enter)="abrir(t.id)">
                    <td class="mono" role="cell" data-label="Folio">{{ t.folio }}</td>
                    <td class="tit dt-id" role="cell" data-label="Solicitud">{{ t.title }}<small>{{ t.category_name }}</small></td>
                    <td class="opc" role="cell" data-label="Reportó">{{ t.requester_name || '—' }}</td>
                    <td class="opc" role="cell" data-label="Sucursal">{{ t.warehouse_name || '—' }}</td>
                    <td role="cell" data-label="Prioridad"><span class="pri" [attr.data-p]="t.priority">{{ priorityLabel[t.priority] }}</span></td>
                    <td role="cell" data-label="Estado"><span class="est" [attr.data-s]="t.status">{{ statusLabel[t.status] }}</span></td>
                    <td class="opc" role="cell" data-label="Atiende">{{ t.assigned_to_name || '—' }}</td>
                    <td role="cell" data-label="Plazo"><span class="sla" [attr.data-t]="plazo(t).tono">{{ plazo(t).texto }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="8" class="vacio">
                    @if (loading()) { Cargando… }
                    @else if (search() || prio() || scope() !== 'open') { Ninguna solicitud con estos filtros. }
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
    @media (max-width: 1100px) {
      .sb-body.has-detail { grid-template-columns: 1fr; }
      .sb-body.has-detail .sb-list { display: none; }
      .sb-detail { position: static; max-height: none; }
      .sb-back { display: inline-flex; align-self: flex-start; margin: calc(-1 * var(--sp-2)) 0 var(--sp-2) calc(-1 * var(--sp-2)); }
      /* La ficha REEMPLAZA a la lista, así que también a lo que la acompaña: KPIs y filtros dejaban la ficha bajo el pliegue. */
      .sb-page.con-ficha .sb-kpis, .sb-page.con-ficha .sb-chips, .sb-page.con-ficha .sb-head { display: none; }
    }
    @media (max-width: 640px) {
      .sb-page { padding: var(--sp-3); gap: var(--sp-3); }
      .sb-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .sb-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .sb-chip { flex: none; min-height: 36px; }
      .sb-search { flex: 0 0 220px; margin-left: 0; }
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

  readonly statusLabel = STATUS_LABEL;
  readonly priorityLabel = PRIORITY_LABEL;
  readonly prioridades = SD_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));
  readonly scopes = [
    { value: 'unassigned', label: 'Sin asignar' }, { value: 'mine', label: 'Mías' }, { value: 'waiting', label: 'En espera' },
    { value: 'open', label: 'Abiertas' }, { value: 'resolved', label: 'Resueltas' }, { value: 'all', label: 'Todas' },
  ];

  readonly rows = signal<SdRequestRow[]>([]);
  readonly total = signal(0);
  readonly st = signal<SdStatsResponse | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly scope = signal('unassigned');
  readonly prio = signal<string | null>(null);
  readonly search = signal('');
  readonly selId = signal<string | null>(null);
  /** Reasigna quien coordina; el servidor lo vuelve a exigir (`SERVICIO_COORDINAR` o god-mode). */
  readonly esCoordinador = computed(() => this.perms.has(Permission.SERVICIO_COORDINAR));

  ngOnInit(): void {
    // El alcance del enlace se fija ANTES de la primera carga: si no, se pedía «Sin asignar» y enseguida «Mías», dos
    // respuestas en carrera donde la lenta pisa a la rápida.
    const inicial = this.route.snapshot?.queryParamMap?.get('scope');
    if (inicial && this.scopes.some((s) => s.value === inicial)) this.scope.set(inicial);
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

  private cargarLista(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.inbox({ scope: this.scope(), priority: this.prio() ?? undefined, search: this.search().trim() || undefined, limit: 100 }).subscribe({
      next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: (e) => { this.loadError.set(sdError(e, 'No se pudo cargar la bandeja.')); this.loading.set(false); },
    });
  }

  setScope(s: string): void { this.scope.set(s); this.cargarLista(); }
  setPrio(p: string | null): void { this.prio.set(p); this.cargarLista(); }
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
