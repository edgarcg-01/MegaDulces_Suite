import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { concatMap, from } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import type { VendorAgendaDay, VendorSummaryDay, VendorSummaryResponse } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CarteraService, RouteWarehouseRow, TeamAgendaRow, VendorOption, WarehouseOption } from '../cartera.service';
import { SupervisorBoardService } from '../supervisor-board.service';
import { routeCode } from './comercial-visitas-dia.component';
import { money, periodLabel, ymdMx } from './comercial-supervisor-board.component';

/** Días ISO (1 = lunes … 7 = domingo), para leer la agenda. */
export const DOW_LABEL = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'] as const;
const SEMANA = [1, 2, 3, 4, 5, 6, 7] as const;

/** Rutas de la agenda de cada vendedor (distintas, en el orden de los días). */
export function agendaByVendor(rows: readonly TeamAgendaRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of [...rows].sort((a, b) => Number(a.day_of_week) - Number(b.day_of_week))) {
    const list = out.get(r.user_id) ?? [];
    if (!list.includes(r.route_name)) list.push(r.route_name);
    out.set(r.user_id, list);
  }
  return out;
}

/**
 * Cómo se lee una agenda: una sola ruta los 7 días = «toda la semana»; si no, día por día
 * («Lun 1V003 · Mar — · …»), para que nadie la crea completa cuando le faltan días.
 */
export function agendaInfo(agenda: readonly VendorAgendaDay[]): { route: string | null; allWeek: boolean; detail: string } {
  const byDay = new Map(agenda.map((a) => [Number(a.day_of_week), a.route]));
  const distinct = [...new Set(agenda.map((a) => a.route))];
  const allWeek = distinct.length === 1 && SEMANA.every((d) => byDay.get(d) === distinct[0]);
  const detail = SEMANA.map((d) => `${DOW_LABEL[d - 1]} ${byDay.has(d) ? routeCode(byDay.get(d)!) : '—'}`).join(' · ');
  return { route: distinct.length === 1 ? distinct[0] : null, allWeek, detail };
}

/** La ruta que más días tiene en la agenda (la que se propone en el selector). */
export function mainRouteId(agenda: readonly VendorAgendaDay[]): string | null {
  const n = new Map<string, number>();
  for (const a of agenda) n.set(a.route_id, (n.get(a.route_id) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, k] of n) if (best == null || k > (n.get(best) ?? 0)) best = id;
  return best;
}

/** «mié 21 oct». Fecha YYYY-MM-DD. */
export function dayLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dia = d.toLocaleDateString('es-MX', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  const mes = d.toLocaleDateString('es-MX', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  return `${dia} ${d.getUTCDate()} ${mes}`;
}

export const vendorName = (v: VendorOption): string => (v.nombre || '').trim() || v.username;

/**
 * `[MCP.3.10]` «Asignar rutas»: un menú con los vendedores de tu equipo. Al elegir uno se ve:
 *  · **Resumen** — su meta de la catorcena contra lo cobrado en Kepler y sus días de la catorcena
 *    (a cuántos visitó, cuántos pidieron y cuánto cobró cada día);
 *  · **Configurar** — su ruta, la sucursal de surtido de esa ruta, su meta de venta y los clientes que
 *    debe visitar (los de su ruta: se calculan, no se capturan — decisión de David, 2026-10-22).
 *
 * Pedido de David (2026-10-22): «no los quiero como tarjetas, quiero que esté como menú por sus
 * vendedores» y «cuando le demos click a los vendedores, podamos ver resumen de sus actividades».
 *
 * Permisos (cada control se habilita con el permiso que exige su endpoint, no con el de la pantalla):
 *  · ruta: es la AGENDA semanal (`public.daily_assignments`), con `TRADE_ROUTE_PLAN_GESTIONAR` — el que
 *    `supervisor_ventas` tiene en prod (MATRIZ_ACCESOS: «Agenda de rutas» = G). ⛔ NO es
 *    `vendor_sales_routes`: la app del vendedor no la lee (`vendor-cartera.sql.ts`), así que asignar ahí
 *    no le cambiaba nada al vendedor, y leerla decía «Sin ruta» de quien sí tenía agenda;
 *  · sucursal: `COMMERCIAL_CARTERA_GESTIONAR`. ⚠️ `supervisor_ventas` NO lo tiene: la ve, no la cambia;
 *  · meta: `can_set_targets` del servidor (`USUARIOS_ASIGNAR_RUTA`).
 */
@Component({
  selector: 'app-comercial-vendor-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, TableModule, ButtonModule, SelectModule, InputNumberModule, InputTextModule, TagModule,
    LoadStateComponent, FreshnessPillComponent, SegmentedComponent,
  ],
  template: `
    <div class="vm" [class.vm--open]="!!selected()">
      <!-- ── Menú de vendedores ── -->
      <nav class="vm-menu" aria-label="Vendedores de tu equipo">
        <label class="sr-only" for="vm-q">Buscar vendedor</label>
        <input pInputText id="vm-q" type="search" class="vm-q" placeholder="Buscar vendedor o ruta"
          [ngModel]="q()" (ngModelChange)="q.set($event)" autocomplete="off" />
        <app-load-state [loading]="loadingList()" [error]="listError()" [isEmpty]="!loadingList() && !vendors().length"
          emptyIcon="pi-users" emptyTitle="No tienes vendedores en tu equipo"
          emptyHint="Un vendedor aparece aquí cuando en Usuarios tú quedas como su supervisor." (retry)="loadList()">
          @if (!filtered().length && vendors().length) {
            <p class="vm-none">Nadie coincide con «{{ q() }}».</p>
          }
          <ul class="vm-list">
            @for (v of filtered(); track v.id) {
              <li>
                <button type="button" class="vm-item" [class.vm-item--on]="selectedId() === v.id"
                  [attr.aria-current]="selectedId() === v.id ? 'true' : null" (click)="select(v.id)">
                  <span class="vm-iname">{{ name(v) }}</span>
                  <span class="vm-isub">
                    @if (routesOf(v.id).length) { <span class="vm-mono">{{ routesLabel(v.id) }}</span> }
                    @else if (noRoute(v.id)) { <span class="vm-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Sin ruta</span> }
                    @if (missingTarget(v.id)) { <span class="vm-warn"><i class="pi pi-flag" aria-hidden="true"></i> Falta meta</span> }
                  </span>
                </button>
              </li>
            }
          </ul>
        </app-load-state>
      </nav>

      <!-- ── Panel del vendedor ── -->
      <section class="vm-panel" [attr.aria-label]="selected() ? 'Vendedor ' + name(selected()!) : 'Elige un vendedor'">
        @if (selected(); as v) {
          <header class="vm-head">
            <div>
              <h2 class="vm-name">{{ name(v) }}</h2>
              <p class="vm-sub">
                <span class="vm-mono">{{ v.username }}</span>
                @if (routesOf(v.id).length) { <span aria-hidden="true">·</span><span class="vm-mono">{{ routesLabel(v.id) }}</span> }
              </p>
            </div>
            <app-segmented [options]="tabs" [value]="tab()" (valueChange)="tab.set($any($event))" ariaLabel="Qué ver del vendedor" />
          </header>

          <app-load-state [loading]="loadingSummary() && !summary()" [error]="summaryError()" [isEmpty]="false" (retry)="loadSummary()">
            @if (summary(); as s) {
              @if (tab() === 'resumen') {
                <!-- Meta de la catorcena -->
                <div class="vm-block">
                  <div class="vm-block-head">
                    <h3 class="vm-h3">Meta de la catorcena <span class="vm-muted">{{ period(s) }} · día {{ s.period.day }} de 14</span></h3>
                    <app-freshness-pill measures="data" [freshness]="s.freshness" label="Venta Kepler" />
                  </div>
                  @if (s.sales_period.amount == null) {
                    <p class="vm-declared"><span class="vm-unmeasured">Sin medir</span> {{ s.sales_period.unmeasured_reason }}</p>
                  } @else if (s.target == null) {
                    <p class="vm-figure"><span class="vm-strong">{{ fmt(s.sales_period.amount) }}</span> cobrado · <span class="vm-muted">sin meta capturada</span></p>
                    @if (s.can_set_targets) {
                      <button pButton type="button" size="small" [text]="true" (click)="tab.set('configurar')">
                        <span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span><span class="p-button-label">Capturar su meta</span></button>
                    }
                  } @else {
                    <p class="vm-figure">
                      <span class="vm-strong">{{ fmt(s.sales_period.amount) }}</span> cobrado de {{ fmt(s.target) }}
                      @if (s.progress_pct != null) { <span class="vm-pct">{{ pct(s.progress_pct) }}</span> }
                    </p>
                    <div class="vm-bar" role="img" [attr.aria-label]="'Avance ' + pct(s.progress_pct ?? 0) + ' de la meta'">
                      <span class="vm-bar-fill" [style.width.%]="barPct(s.progress_pct)"></span>
                    </div>
                  }
                </div>

                <!-- Sus últimos días -->
                <div class="vm-block">
                  <h3 class="vm-h3">Sus últimos días</h3>
                  <div class="dt-scope">
                    <p-table [value]="s.days" dataKey="date" class="dt-stack" tableStyleClass="surf-table surf-table--plain" size="small"
                      [tableStyle]="{ 'min-width': '30rem' }">
                      <ng-template #header>
                        <tr>
                          <th scope="col">Día</th>
                          <th scope="col">Ruta</th>
                          <th scope="col">Visitó</th>
                          <th scope="col" class="comm-num">Pedidos</th>
                          <th scope="col" class="comm-num">Cobrado</th>
                        </tr>
                      </ng-template>
                      <ng-template #body let-d>
                        <tr>
                          <td role="cell" data-label="Día" class="dt-id">{{ day(d.date) }}</td>
                          <td role="cell" data-label="Ruta">
                            @if (d.routes.length) { <span class="vm-mono">{{ d.routes.join(', ') }}</span> }
                            @else { <span class="vm-muted">Sin ruta</span> }
                          </td>
                          <td role="cell" data-label="Visitó">
                            @if (d.routes.length) { <span class="vm-mono">{{ d.customers_visited }} de {{ d.customers_total }}</span> }
                            @else { <span class="vm-muted">—</span> }
                          </td>
                          <td role="cell" data-label="Pedidos" class="comm-num dt-num"><span class="vm-mono">{{ d.routes.length ? d.orders : '—' }}</span></td>
                          <td role="cell" data-label="Cobrado" class="comm-num dt-num">
                            @if (d.sales.amount != null) { <span class="vm-mono">{{ fmt(d.sales.amount) }}</span> }
                            @else if (d.routes.length) { <span class="vm-unmeasured" [attr.title]="d.sales.unmeasured_reason">Sin medir</span> }
                            @else { <span class="vm-muted">—</span> }
                          </td>
                        </tr>
                      </ng-template>
                    </p-table>
                  </div>
                </div>
              } @else {
                <!-- ── Configurar ── -->
                <div class="vm-form">
                  <!-- Ruta: su AGENDA semanal (la que usa la app del vendedor) -->
                  <div class="vm-field">
                    <span class="vm-label" id="vm-l-ruta">Ruta <span class="vm-muted">su agenda de la semana</span></span>
                    <div class="vm-control" role="group" aria-labelledby="vm-l-ruta">
                      @if (agendaInfo(s); as a) {
                        @if (!s.agenda.length) {
                          <span class="vm-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Sin ruta en su agenda</span>
                        } @else if (a.allWeek) {
                          <span><span class="vm-mono">{{ a.route }}</span> <span class="vm-muted">· toda la semana</span></span>
                        } @else {
                          <span class="vm-mono vm-days">{{ a.detail }}</span>
                          <span class="vm-hint">Su ruta cambia según el día.</span>
                        }
                      }
                      @if (canRoute()) {
                        <span class="vm-row">
                          <p-select [options]="s.route_options" [ngModel]="routeDraft() ?? mainRoute(s)" (ngModelChange)="routeDraft.set($event)"
                            optionLabel="route" optionValue="id" placeholder="Elige su ruta…" [filter]="true" filterBy="route"
                            appendTo="body" styleClass="vm-select" ariaLabel="Ruta de la semana"
                            emptyMessage="No hay rutas de tu tipo en su zona" />
                          <button pButton type="button" size="small" severity="contrast" [disabled]="!routeDirty() || busy()"
                            [loading]="busy() === 'ruta'" (click)="saveRoute()"><span class="p-button-label">Guardar para toda la semana</span></button>
                        </span>
                        <span class="vm-hint">Se pone de lunes a domingo. Para variarla por día usa la Agenda de rutas.</span>
                      } @else {
                        <span class="vm-hint">Tu puesto no puede cambiar la agenda de rutas.</span>
                      }
                    </div>
                  </div>

                  <!-- Sucursal -->
                  <div class="vm-field">
                    <span class="vm-label" id="vm-l-suc">Sucursal de surtido</span>
                    <div class="vm-control" role="group" aria-labelledby="vm-l-suc">
                      @for (r of s.routes; track r.route) {
                        <span class="vm-row">
                          @if (s.routes.length > 1) { <span class="vm-mono vm-muted">{{ r.code ?? r.route }}</span> }
                          @if (canWarehouse()) {
                            @if (whRow(r.route); as w) {
                              <p-select [options]="warehouses()" [ngModel]="whDraft()[w.route_id] ?? w.warehouse_id ?? w.suggested_id"
                                (ngModelChange)="setWhDraft(w.route_id, $event)" optionLabel="name" optionValue="id"
                                placeholder="Sucursal…" [filter]="true" filterBy="name" appendTo="body" styleClass="vm-select"
                                [ariaLabel]="'Sucursal de la ruta ' + r.route" />
                              <button pButton type="button" size="small" severity="contrast" [disabled]="!whDirty(w) || busy()"
                                [loading]="busy() === 'suc'" (click)="saveWarehouse(w)"><span class="p-button-label">Guardar</span></button>
                              @if (!w.warehouse_id && w.suggested_name) { <span class="vm-hint">Sugerida por la zona: {{ w.suggested_name }}</span> }
                            } @else {
                              <span class="vm-muted">Esta ruta no está en el catálogo de rutas: no se le puede poner sucursal.</span>
                            }
                          } @else {
                            <span>{{ r.warehouse_name ?? 'Sin asignar' }}</span>
                          }
                        </span>
                      } @empty {
                        <span class="vm-muted">Primero asígnale una ruta.</span>
                      }
                      @if (!canWarehouse() && s.routes.length) {
                        <span class="vm-note"><i class="pi pi-lock" aria-hidden="true"></i>
                          Tu puesto puede ver la sucursal, pero no cambiarla. Pídeselo a quien administra la cartera.</span>
                      }
                    </div>
                  </div>

                  <!-- Meta -->
                  <div class="vm-field">
                    <label class="vm-label" for="vm-meta">Meta de venta <span class="vm-muted">catorcena {{ period(s) }}</span></label>
                    <div class="vm-control">
                      @if (s.can_set_targets) {
                        <span class="vm-row">
                          <p-inputnumber inputId="vm-meta" [ngModel]="targetDraft() === undefined ? s.target : targetDraft()"
                            (ngModelChange)="targetDraft.set($event ?? null)" mode="currency" currency="MXN" locale="es-MX"
                            [minFractionDigits]="0" [maxFractionDigits]="2" [min]="0" placeholder="Sin meta"
                            (keydown.enter)="saveTarget()" />
                          <button pButton type="button" size="small" severity="contrast" [disabled]="!targetDirty() || busy()"
                            [loading]="busy() === 'meta'" (click)="saveTarget()"><span class="p-button-label">Guardar</span></button>
                        </span>
                        <span class="vm-hint">Déjala vacía y guarda para quitarla.</span>
                      } @else {
                        <span id="vm-meta">{{ s.target != null ? fmt(s.target) : 'Sin meta' }}</span>
                        <span class="vm-hint">Tu puesto no puede capturar metas.</span>
                      }
                    </div>
                  </div>

                  <!-- Clientes a visitar -->
                  <div class="vm-field">
                    <span class="vm-label">Clientes a visitar</span>
                    <div class="vm-control">
                      @if (s.routes.length) {
                        <span class="vm-strong vm-mono">{{ customersOf(s) }}</span>
                        <span class="vm-hint">Son los clientes de su ruta; cambia si cambias la ruta.</span>
                      } @else {
                        <span class="vm-muted">— sin ruta, no tiene clientes que visitar</span>
                      }
                    </div>
                  </div>

                </div>
              }
            }
          </app-load-state>
        } @else {
          <div class="vm-empty">
            <i class="pi pi-arrow-left" aria-hidden="true"></i>
            <p>Elige un vendedor para ver su resumen y configurar su ruta, su sucursal y su meta.</p>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .vm { container-type: inline-size; container-name: vm; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
    @container vm (min-width: 48rem) { .vm { grid-template-columns: 17rem minmax(0, 1fr); } }
    .vm-menu { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--c-surface-1); padding: var(--sp-2); min-width: 0; }
    .vm-q { width: 100%; margin-bottom: var(--sp-2); }
    .vm-list { list-style: none; margin: 0; padding: 0; max-height: 70vh; overflow-y: auto; }
    .vm-item { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: transparent; border: 0; border-radius: var(--r-sm); padding: var(--sp-2); cursor: pointer; color: var(--text-main); font: inherit; }
    .vm-item:hover { background: var(--overlay-hover); }
    .vm-item--on { background: var(--overlay-selected); box-shadow: inset 2px 0 0 var(--action); }
    .vm-item:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .vm-iname { font-weight: 600; font-size: var(--fs-sm); }
    .vm-isub { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .vm-warn { color: var(--warn-fg); display: inline-flex; align-items: center; gap: 2px; }
    .vm-none { margin: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .vm-panel { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--c-surface-1); padding: var(--sp-3) var(--sp-4); min-width: 0; }
    .vm-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); }
    .vm-name { margin: 0; font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .vm-sub { margin: 2px 0 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
    .vm-block { margin-bottom: var(--sp-5); }
    .vm-block-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .vm-h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .vm-figure { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1); }
    .vm-strong { font-weight: 700; color: var(--text-main); font-size: var(--fs-md); }
    .vm-pct { margin-left: auto; font-family: var(--font-mono); font-weight: 700; color: var(--text-main); }
    .vm-bar { height: 8px; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; }
    .vm-bar-fill { display: block; height: 100%; background: var(--action); }
    .vm-declared { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .vm-unmeasured { font-size: var(--fs-xs); color: var(--text-muted); border: 1px dashed var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-1); white-space: nowrap; }
    .vm-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .vm-muted { color: var(--text-muted); font-weight: 400; }
    .vm-form { display: flex; flex-direction: column; gap: var(--sp-4); }
    .vm-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
    @container vm (min-width: 48rem) { .vm-field { grid-template-columns: 11rem minmax(0, 1fr); align-items: start; } }
    .vm-label { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); padding-top: var(--sp-1); }
    .vm-label .vm-muted { display: block; font-size: var(--fs-xs); }
    .vm-days { font-size: var(--fs-xs); overflow-wrap: anywhere; }
    .vm-control { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); min-width: 0; font-size: var(--fs-sm); }
    .vm-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .vm-chip { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 2px var(--sp-1) 2px var(--sp-2); font-size: var(--fs-xs); }
    .vm-chip-x { background: transparent; border: 0; cursor: pointer; color: var(--text-muted); width: 1.25rem; height: 1.25rem; border-radius: var(--r-sm); display: grid; place-items: center; }
    .vm-chip-x:hover { color: var(--bad-fg); background: var(--overlay-hover); }
    .vm-chip-x:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    :host ::ng-deep .vm-select { min-width: 14rem; }
    .vm-hint { font-size: var(--fs-xs); color: var(--text-muted); }
    .vm-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); display: flex; gap: var(--sp-1); align-items: baseline; }
    .vm-empty { padding: var(--sp-8) var(--sp-4); text-align: center; color: var(--text-muted); font-size: var(--fs-sm); }
    .vm-empty i { display: block; margin-bottom: var(--sp-2); }
  `],
})
export class ComercialVendorMenuComponent {
  private readonly cartera = inject(CarteraService);
  private readonly board = inject(SupervisorBoardService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Día consultado (`YYYY-MM-DD`); lo elige la barra de Cartera. */
  readonly date = input<string>(ymdMx(new Date()));
  /** Vendedor que se abre al entrar (llega del tablero). */
  readonly initialVendor = input<string | null>(null);

  readonly tabs: SegOption[] = [
    { label: 'Resumen', value: 'resumen' },
    { label: 'Configurar', value: 'configurar' },
  ];
  readonly tab = signal<'resumen' | 'configurar'>('resumen');

  // ── Menú ──
  readonly vendors = signal<VendorOption[]>([]);
  readonly agendaRows = signal<TeamAgendaRow[]>([]);
  /** `false` = no se pudo leer la agenda: no se afirma «Sin ruta» de nadie. */
  readonly agendaKnown = signal(false);
  readonly loadingList = signal(false);
  readonly listError = signal<string | null>(null);
  readonly q = signal('');
  /** user_id → meta de la catorcena según el tablero del día (sólo de quien salió en el tablero). */
  private readonly boardTargets = signal<Map<string, number | null>>(new Map());

  // ── Vendedor elegido ──
  readonly selectedId = signal<string | null>(null);
  readonly summary = signal<VendorSummaryResponse | null>(null);
  readonly loadingSummary = signal(false);
  readonly summaryError = signal<string | null>(null);
  private summarySeq = 0;

  // ── Configurar ──
  /** La agenda de rutas (lo que de verdad usa la app del vendedor). */
  readonly canRoute = computed(() => this.perms.has(Permission.TRADE_ROUTE_PLAN_GESTIONAR));
  /** `[MCP.3.11]` La misma regla que el endpoint: cualquiera de las dos llaves. */
  readonly canWarehouse = computed(() =>
    this.perms.hasAny(Permission.COMMERCIAL_CARTERA_GESTIONAR, Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR));
  readonly warehouses = signal<WarehouseOption[]>([]);
  readonly routesWh = signal<RouteWarehouseRow[]>([]);
  /** Ruta elegida y aún no guardada (`null` = sin tocar). */
  readonly routeDraft = signal<string | null>(null);
  /** route_id → sucursal elegida y aún no guardada. */
  readonly whDraft = signal<Record<string, string | null>>({});
  /** `undefined` = sin tocar (se muestra la meta guardada). */
  readonly targetDraft = signal<number | null | undefined>(undefined);
  /** Qué se está guardando (un solo guardado a la vez). */
  readonly busy = signal<'ruta' | 'suc' | 'meta' | null>(null);

  readonly assigned = computed(() => agendaByVendor(this.agendaRows()));

  readonly filtered = computed(() => {
    const q = this.q();
    const a = this.assigned();
    return [...this.vendors()]
      .sort((x, y) => vendorName(x).localeCompare(vendorName(y), 'es'))
      .filter((v) => coincideBusqueda(q, vendorName(v), v.username, ...(a.get(v.id) ?? [])));
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? this.vendors().find((v) => v.id === id) ?? null : null;
  });

  /** Hay cambio si eligió otra ruta, o si su agenda no tiene esa misma ruta los 7 días. */
  readonly routeDirty = computed(() => {
    const s = this.summary();
    const draft = this.routeDraft();
    const chosen = draft ?? (s ? mainRouteId(s.agenda) : null);
    if (!s || !chosen) return false;
    const byDay = new Map(s.agenda.map((a) => [Number(a.day_of_week), a.route_id]));
    return [1, 2, 3, 4, 5, 6, 7].some((d) => byDay.get(d) !== chosen);
  });

  readonly targetDirty = computed(() => {
    const d = this.targetDraft();
    const s = this.summary();
    if (d === undefined || !s) return false;
    return (d == null ? null : Number(d)) !== (s.target == null ? null : Number(s.target));
  });

  constructor() {
    this.loadList();
    if (this.canWarehouse()) this.loadWarehouses();
    // Si llega un vendedor desde el tablero, se abre en su Resumen.
    effect(() => {
      const id = this.initialVendor();
      if (id) untracked(() => { this.tab.set('resumen'); this.select(id); });
    });
    // Cambiar la fecha vuelve a pedir el resumen del vendedor elegido y las metas del tablero.
    effect(() => {
      this.date();
      untracked(() => {
        this.loadTargets();
        if (this.selectedId()) this.loadSummary();
      });
    });
  }

  loadList(): void {
    this.loadingList.set(true);
    this.listError.set(null);
    this.cartera.listVendors().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => { this.vendors.set(v); this.loadingList.set(false); },
      error: (e) => {
        this.vendors.set([]);
        this.loadingList.set(false);
        this.listError.set(e?.error?.message || 'No se pudieron cargar tus vendedores.');
      },
    });
    this.loadAgenda();
  }

  private loadAgenda(): void {
    this.cartera.teamAgenda().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.agendaRows.set(r); this.agendaKnown.set(true); },
      // Sin agenda no se sabe quién tiene ruta: no se dice «Sin ruta» de nadie.
      error: () => { this.agendaRows.set([]); this.agendaKnown.set(false); },
    });
  }

  private loadTargets(): void {
    this.board.board(this.date()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => this.boardTargets.set(new Map(b.vendors.map((v) => [v.user_id, v.target]))),
      // El aviso «Falta meta» es una ayuda: si no se pudo leer, no se afirma nada.
      error: () => this.boardTargets.set(new Map()),
    });
  }

  private loadWarehouses(): void {
    this.cartera.routesWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.warehouses.set(r.warehouses); this.routesWh.set(r.routes); this.whDraft.set({}); },
      error: () => { this.warehouses.set([]); this.routesWh.set([]); },
    });
  }

  select(id: string): void {
    if (this.selectedId() === id) return;
    this.selectedId.set(id);
    this.routeDraft.set(null);
    this.targetDraft.set(undefined);
    this.summary.set(null);
    this.loadSummary();
  }

  loadSummary(): void {
    const id = this.selectedId();
    if (!id) return;
    const n = ++this.summarySeq;
    this.loadingSummary.set(true);
    this.summaryError.set(null);
    this.board.vendorSummary(id, this.date()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => {
        if (n !== this.summarySeq) return;
        this.summary.set(s);
        this.targetDraft.set(undefined);
        this.routeDraft.set(null);
        this.loadingSummary.set(false);
      },
      error: (e) => {
        if (n !== this.summarySeq) return;
        this.summary.set(null);
        this.loadingSummary.set(false);
        this.summaryError.set(e?.error?.message || 'No se pudo cargar el resumen del vendedor.');
      },
    });
  }

  // ── Ruta (agenda de la semana) ──
  /**
   * Pone la ruta de lunes a domingo con el endpoint de agenda (un upsert por día). Va día por día y
   * en orden: si se corta a la mitad se dice cuántos quedaron, y volver a guardar es seguro (el
   * upsert no duplica).
   */
  saveRoute(): void {
    const s = this.summary();
    const routeId = this.routeDraft() ?? (s ? mainRouteId(s.agenda) : null);
    if (!s || !routeId || this.busy() || !this.canRoute() || !this.routeDirty()) return;
    const ruta = s.route_options.find((o) => o.id === routeId)?.route ?? 'la ruta';
    this.busy.set('ruta');
    let hechos = 0;
    from([1, 2, 3, 4, 5, 6, 7])
      .pipe(concatMap((d) => this.cartera.setAgendaDay(s.user_id, routeId, d)), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { hechos++; },
        complete: () => {
          this.busy.set(null);
          this.toast.add({ severity: 'success', summary: 'Ruta guardada', detail: `${ruta}, de lunes a domingo` });
          this.loadAgenda();
          this.loadSummary();
        },
        error: (e) => {
          this.busy.set(null);
          this.toast.add({
            severity: 'error', summary: 'La ruta quedó a medias',
            detail: `${e?.error?.message || 'No se pudo guardar'} — se guardaron ${hechos} de 7 días. Vuelve a guardar: no se duplica.`,
          });
          this.loadAgenda();
          this.loadSummary();
        },
      });
  }

  // ── Sucursal ──
  whRow(route: string): RouteWarehouseRow | null {
    return this.routesWh().find((w) => w.route === route) ?? null;
  }

  setWhDraft(routeId: string, whId: string | null): void {
    this.whDraft.update((d) => ({ ...d, [routeId]: whId }));
  }

  whDirty(w: RouteWarehouseRow): boolean {
    const d = this.whDraft();
    const chosen = w.route_id in d ? d[w.route_id] : w.warehouse_id ?? w.suggested_id;
    // Confirmar la sugerencia también es guardar: la ruta todavía no tiene sucursal.
    return !!chosen && chosen !== w.warehouse_id;
  }

  saveWarehouse(w: RouteWarehouseRow): void {
    const d = this.whDraft();
    const whId = w.route_id in d ? d[w.route_id] : w.warehouse_id ?? w.suggested_id;
    if (!whId || this.busy() || !this.canWarehouse()) return;
    this.busy.set('suc');
    this.cartera.setRouteWarehouse(w.route_id, whId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(null);
        this.toast.add({ severity: 'success', summary: 'Sucursal guardada', detail: w.route });
        this.loadWarehouses();
        this.loadSummary();
      },
      error: (e) => {
        this.busy.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó la sucursal', detail: e?.error?.message || w.route });
      },
    });
  }

  // ── Meta ──
  saveTarget(): void {
    const s = this.summary();
    const amount = this.targetDraft();
    if (!s || !s.can_set_targets || amount === undefined || !this.targetDirty() || this.busy()) return;
    if (amount != null && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
      this.toast.add({ severity: 'warn', summary: 'Meta inválida', detail: 'La meta va en pesos y no puede ser negativa.' });
      return;
    }
    this.busy.set('meta');
    this.board.setTarget({ user_id: s.user_id, period_start: s.period.start, amount: amount == null ? null : Number(amount) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.busy.set(null);
          this.toast.add({ severity: 'success', summary: r.amount == null ? 'Meta quitada' : 'Meta guardada', detail: s.name });
          this.boardTargets.update((m) => (m.has(s.user_id) ? new Map(m).set(s.user_id, r.amount) : m));
          this.loadSummary();
        },
        error: (e) => {
          // Lo tecleado se conserva para reintentar; la meta guardada no cambió.
          this.busy.set(null);
          this.toast.add({ severity: 'error', summary: 'No se guardó la meta', detail: e?.error?.message || `La meta de ${s.name} sigue como estaba.` });
        },
      });
  }

  // ── Lectura ──
  name(v: VendorOption): string {
    return vendorName(v);
  }
  routesOf(userId: string): string[] {
    return this.assigned().get(userId) ?? [];
  }
  routesLabel(userId: string): string {
    return this.routesOf(userId).map(routeCode).join(', ');
  }
  /** «Sin ruta» sólo cuando la agenda se leyó y no tiene nada suyo. */
  noRoute(userId: string): boolean {
    return this.agendaKnown() && !this.routesOf(userId).length;
  }
  customersOf(s: VendorSummaryResponse): number {
    return s.routes.reduce((t, r) => t + (Number(r.customers) || 0), 0);
  }
  agendaInfo(s: VendorSummaryResponse) {
    return agendaInfo(s.agenda);
  }
  mainRoute(s: VendorSummaryResponse): string | null {
    return mainRouteId(s.agenda);
  }
  /** «Falta meta» sólo cuando el tablero de hoy lo afirma; si no salió en el tablero, no se dice nada. */
  missingTarget(userId: string): boolean {
    const m = this.boardTargets();
    return m.has(userId) && m.get(userId) == null;
  }
  period(s: VendorSummaryResponse): string {
    return periodLabel(s.period.start, s.period.end);
  }
  day(ymd: VendorSummaryDay['date']): string {
    return dayLabel(ymd);
  }
  fmt(n: number | null): string {
    return money(n);
  }
  pct(n: number): string {
    return `${Math.round(Number(n))} %`;
  }
  barPct(n: number | null): number {
    return n == null ? 0 : Math.max(0, Math.min(100, Number(n)));
  }
}
