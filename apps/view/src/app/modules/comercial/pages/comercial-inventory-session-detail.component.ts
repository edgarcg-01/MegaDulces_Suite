import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TooltipModule } from 'primeng/tooltip';
import { SelectButtonModule } from 'primeng/selectbutton';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { MessageService, ConfirmationService } from 'primeng/api';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { ComercialService, InventoryCountItem, InventorySupervisorProgress, AssignableUser, InventoryInterruptions, InventoryCountSession } from '../comercial.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { CantidadFisicaDirective } from '../../../shared/directives/cantidad-fisica.directive';
import { InventoryMonitorSocketService } from '../inventory-monitor-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';

/** Entrada del feed en vivo del supervisor: un conteo individual recién hecho. */
interface LiveCountEntry {
  seq: number;
  username: string;
  product_name: string;
  sku: string;
  qty: number;
  slot: string;
  at: string;
}

/**
 * Detalle del folio para supervisor/reconciliador (Fase I.3): tablero (avance,
 * discrepancias, valor en riesgo) + tabla de items con teórico/varianza +
 * acciones (calcular discrepancias, resolver item, reconciliar, cancelar).
 */
@Component({
  selector: 'app-comercial-inventory-session-detail',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterModule,
    ButtonModule, TableModule, TagModule, DialogModule, InputNumberModule, InputTextModule,
    ToastModule, ConfirmDialogModule, SelectButtonModule, MultiSelectModule, SelectModule,
    MetricStripComponent, TooltipModule, CantidadFisicaDirective,
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ progress()?.folio || 'Folio' }}</h1>
          <p class="surf-page-sub">
            <p-tag [value]="statusLabel($safeNavigationMigration(progress()?.status))" [severity]="statusSeverity($safeNavigationMigration(progress()?.status))"></p-tag>
          </p>
        </div>
        <div class="in-head-actions">
          @if (live()) {
            <span class="in-live" title="Monitoreo en vivo activo"><span class="in-live-dot"></span> EN VIVO</span>
          }
          <button pButton [text]="true" severity="secondary" size="small" routerLink="/almacen/inventory/sessions"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Volver</span></button>
          <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <div class="in-body" [class.in-body-live]="!isTerminal()">
      @if (!isTerminal()) {
        <aside class="in-live-rail">
          <div class="in-live-head">
            <span class="in-live-title"><i class="pi pi-bolt"></i> En vivo</span>
            @if (liveFeed().length) { <span class="in-live-count">{{ liveFeed().length }}</span> }
            <p-button [icon]="feedCollapsed() ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" [text]="true" severity="secondary" size="small"
                    styleClass="in-live-toggle" [attr.aria-label]="feedCollapsed() ? 'Mostrar feed en vivo' : 'Ocultar feed en vivo'"
                    (click)="feedCollapsed.set(!feedCollapsed())"></p-button>
          </div>
          @if (!feedCollapsed()) {
            <div class="in-live-body">
              @if (liveFeed().length) {
                @for (e of liveFeed(); track e.seq) {
                  <div class="in-live-row">
                    <div class="in-live-main">
                      <span class="in-live-prod">{{ e.product_name }}</span>
                      <span class="in-live-meta">{{ e.username }} · {{ e.at | date:'HH:mm:ss' }}</span>
                    </div>
                    <span class="in-live-qty">{{ e.qty | number: '1.0-3' }}</span>
                    <p-tag [value]="slotLabel(e.slot)" [severity]="e.slot === 'count_2' ? 'success' : (e.slot === 'count_3' ? 'warn' : 'info')"></p-tag>
                  </div>
                }
              } @else {
                <div class="in-live-empty">
                  @if (live()) { <i class="pi pi-spin pi-spinner"></i> Esperando conteos… }
                  @else { <i class="pi pi-wifi"></i> Conectando al monitoreo… }
                </div>
              }
            </div>
          }
        </aside>
      }
      <div class="in-main">

      <!-- KPIs -->
      <app-metric-strip [items]="kpiItems()" ariaLabel="Avance del conteo" />


      <!-- Fase actual + avance -->
      @if (progress()?.status === 'counting') {
        <div class="in-phase">
          <div class="in-phase-info">
            <span class="in-phase-badge">Fase {{ progress()?.current_pass }}</span>
            <span class="in-phase-label">{{ progress()?.current_pass === 1 ? 'Primer conteo' : 'Segundo conteo (ciego)' }}</span>
            <span class="in-phase-cov">{{ progress()?.pass_coverage_pct ?? 0 }}% cubierto</span>
          </div>
          @if (canAdvance()) {
            <p-button [label]="advanceLabel()" icon="pi pi-arrow-right" severity="success" size="small" [loading]="advancing()" (click)="advancePass()"></p-button>
          } @else {
            <small class="in-phase-hint">Completa el 100% de la pasada para avanzar de fase.</small>
          }
        </div>
      }

      <!-- [CNT.1] QUE FALTA PARA PODER CERRAR, antes del boton y no despues del 409.
           Medido en prod: los 6 folios que existen estan CANCELADOS -- 18,845 renglones y 9
           contados. El coverage guard de reconcile() es correcto y de diseno (un no-contado no
           es un cero), pero solo se enteraba quien apretaba el boton al final. -->
      @if (!isTerminal() && progress(); as pr) {
        @if (pr.bloqueos?.length) {
          <div class="in-bloqueos">
            <b>Falta para poder cerrar este folio:</b>
            <ul>
              @for (b of pr.bloqueos; track b.code) { <li>{{ b.mensaje }}</li> }
            </ul>
            @if (pr.total) {
              <span class="in-bloqueos-pie">
                Van {{ pr.counted_once | number }} de {{ pr.total | number }} contados
                ({{ pr.coverage_pct }}%). Un folio se cierra completo o se cancela: lo no contado
                no se toma como cero.
              </span>
            }
          </div>
        } @else if (pr.puede_reconciliar) {
          <p class="in-listo">Todo contado y resuelto: el folio se puede reconciliar.</p>
        }
      }

      <!-- Acciones -->
      @if (!isTerminal()) {
        <div class="in-actions">
          <button pButton size="small" severity="secondary" [loading]="computing()" (click)="compute()"><span class="p-button-icon p-button-icon-left pi pi-calculator" aria-hidden="true"></span><span class="p-button-label">Calcular discrepancias</span></button>
          @if (canAssign()) {
            <button pButton size="small" [text]="true" severity="secondary" [routerLink]="['/almacen/inventory/sessions', countId, 'teams']"><span class="p-button-icon p-button-icon-left pi pi-users" aria-hidden="true"></span><span class="p-button-label">Equipos por pasillo</span></button>
          }
          @if (canReconcile()) {
            <button pButton size="small" severity="success" [loading]="reconciling()"
                    [disabled]="bloqueado()" [pTooltip]="bloqueoResumen()"
                    (click)="confirmReconcile()"><span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span><span class="p-button-label">Reconciliar</span></button>
          }
          @if (canReconcile()) {
            <button pButton size="small" [text]="true" severity="danger" (click)="confirmCancel()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Cancelar folio</span></button>
          }
        </div>
      }

      <!-- Asignación de personas (Fase I.4) -->
      @if (canAssign() && !isTerminal()) {
        <div class="in-assign">
          <div class="in-assign-col">
            <label>Contadores asignados</label>
            <p-multiselect [options]="counterOpts()" [(ngModel)]="selCounters" optionLabel="label" optionValue="value"
                           placeholder="Todos (folio abierto)" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('counter')"></p-multiselect>
            <small>Si no asignas ninguno, cualquiera con permiso de contar puede contar este folio.</small>
          </div>
          <div class="in-assign-col">
            <label>Supervisores asignados</label>
            <p-multiselect [options]="supervisorOpts()" [(ngModel)]="selSupervisors" optionLabel="label" optionValue="value"
                           placeholder="Sin asignar" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('supervisor')"></p-multiselect>
            <small>Responsables de este inventario (informativo).</small>
          </div>
        </div>
      }

      <!-- Bitácora de interrupciones (integridad del conteo) -->
      @if (interruptions()?.events?.length) {
        <div class="in-interrupt">
          <div class="in-interrupt-head">
            <i class="pi pi-eye-slash"></i>
            <span>Interrupciones del conteo</span>
            <small>el contador salió de la app / bloqueó el celular durante el folio</small>
          </div>
          <div class="in-interrupt-users">
            @for (u of interruptions()?.by_user; track u.user_id) {
              <div class="in-interrupt-chip" [class.in-interrupt-chip-warn]="u.count >= 3 || u.max_seconds >= 120">
                <span class="in-interrupt-user">{{ u.username || 'Contador' }}</span>
                <span class="in-interrupt-stat">{{ u.count }} {{ u.count === 1 ? 'salida' : 'salidas' }} · {{ fmtDuration(u.total_seconds) }} total · máx {{ fmtDuration(u.max_seconds) }}</span>
              </div>
            }
          </div>
          <div class="in-interrupt-timeline">
            @for (e of interruptions()?.events?.slice(0, 12); track e.id) {
              <div class="in-interrupt-row">
                <span class="in-interrupt-when">{{ e.left_at | date:'dd/MM HH:mm:ss' }}</span>
                <span class="in-interrupt-who">{{ e.username || '—' }}</span>
                <span class="in-interrupt-dur">{{ fmtDuration(e.duration_seconds) }}</span>
              </div>
            }
          </div>
        </div>
      }

      <!-- Control de personal: jornadas de conteo -->
      @if (sessions().length) {
        <div class="in-sessions">
          <div class="in-sessions-head"><i class="pi pi-users"></i> Jornadas de conteo del personal</div>
          <p-table [value]="sessions()" styleClass="p-datatable-sm surf-table surf-table--sticky">
            <ng-template #header>
              <tr>
                <th scope="col">Contador</th><th scope="col" class="in-num num">Fase</th><th scope="col">Inició</th><th scope="col">Terminó</th><th scope="col">Estado</th>
                <th scope="col" class="in-num num">SKUs</th><th scope="col" class="in-num num">Unidades</th><th scope="col" class="in-num num">Interrup.</th>
              </tr>
            </ng-template>
            <ng-template #body let-s>
              <tr>
                <td>{{ s.username || '—' }}</td>
                <td class="in-num num">{{ s.pass }}</td>
                <td>{{ s.started_at | date:'dd/MM HH:mm' }}</td>
                <td>{{ s.finished_at ? (s.finished_at | date:'dd/MM HH:mm') : '·' }}</td>
                <td><p-tag [value]="s.status === 'finished' ? 'Terminó' : 'Contando'" [severity]="s.status === 'finished' ? 'success' : 'info'"></p-tag></td>
                <td class="in-num num">{{ s.items_counted }}</td>
                <td class="in-num num">{{ s.units_counted }}</td>
                <td class="in-num num" [class.in-var-neg]="s.interruptions > 0">{{ s.interruptions }}{{ s.interrupt_seconds ? ' (' + fmtDuration(s.interrupt_seconds) + ')' : '' }}</td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- Filtro -->
      <div class="in-filter">
        <div class="in-filter-row">
          <p-selectbutton [options]="filterOptions" [(ngModel)]="filter" (onChange)="load()" optionLabel="label" optionValue="value" styleClass="sb-liquid"></p-selectbutton>
          <!--
            [IC.F5] La SALIDA al tope: esta busqueda pega contra el SERVIDOR y recorre el folio
            entero ANTES del corte de 2,000, asi que alcanza lo que la lista no muestra. Un
            filtro sobre las filas ya bajadas no podria, y es el error que parece lo mismo.
          -->
          <label class="sr-only" for="in-buscar">Buscar un articulo en todo el folio</label>
          <input id="in-buscar" pInputText type="search" class="in-buscar"
                 placeholder="Buscar en todo el folio: nombre, SKU, codigo de barras o ubicacion"
                 [ngModel]="busqueda()" (ngModelChange)="buscar($event)" />
          @if (busqueda()) {
            <button pButton type="button" [text]="true" size="small" icon="pi pi-times" label="Limpiar" (click)="limpiarBusqueda()"></button>
          }
        </div>
        @if (busqueda()) {
          <p class="in-tope">
            <i class="pi pi-search" aria-hidden="true"></i>
            <span>
              <strong>{{ items().length | number }}</strong> de
              <strong>{{ totalDelFolio() | number }}</strong> articulos del folio coinciden.
              @if (listaTopada()) { <strong>Hay mas de los que caben: afina la busqueda.</strong> }
            </span>
          </p>
        } @else if (listaTopada()) {
          <!--
            [IC.F5] Cruce 1: si el encabezado dice N, la lista tiene que poder llegar a N.
            La consulta se topa en 2,000 y devuelve un arreglo pelado, sin total ni has_more:
            con 3,363 articulos el supervisor no veia 1,363 y NADA se lo decia. El tope sigue
            -bajar el folio entero en cada carga no es gratis-, pero ya no encierra: el
            buscador de arriba llega a cualquiera de los que no caben.
          -->
          <p class="in-tope">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>
              Se muestran <strong>{{ items().length | number }}</strong> de
              <strong>{{ totalDelFolio() | number }}</strong> articulos:
              <strong>{{ totalDelFolio() - items().length | number }}</strong> no caben en esta
              lista. Para llegar a uno de esos, <strong>buscalo arriba</strong> por nombre o SKU.
            </span>
          </p>
        }
        @if (ubicacionesFaltantes() !== null) {
          <!--
            [IC.UB1] La columna «Ubic.» se ve vacia, y sin esto nadie sabe si es que el
            producto no tiene ubicacion o si la pantalla no la trae. Ademas lleva a donde
            se arregla, con el dato que lo justifica (Q.4: el numero que denuncia, navega).
          -->
          <p class="in-ubic">
            <i class="pi pi-map-marker" aria-hidden="true"></i>
            <span>
              <strong>{{ progress()?.located | number }}</strong> de
              <strong>{{ totalDelFolio() | number }}</strong> articulos tienen ubicacion
              asignada.
              @if (ubicacionesFaltantes()! > 0) {
                <a routerLink="/almacen/ubicaciones/asignacion">Asignar las otras
                  {{ ubicacionesFaltantes() | number }}</a>.
              }
            </span>
          </p>
        }
      </div>

      <!-- Tabla de items -->
      <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Ubic.</th>
            <th scope="col" class="in-num num">Teórico</th><th scope="col" class="in-num num">C1</th><th scope="col" class="in-num num">C2</th><th scope="col" class="in-num num">C3</th>
            <th scope="col" class="in-num num">Final</th><th scope="col" class="in-num num">Var.</th><th scope="col">Estado</th><th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-it>
          <tr [class.in-row-disc]="it.status === 'discrepancy'">
            <td class="in-mono">{{ it.sku || '—' }}</td>
            <td class="in-name">{{ it.product_name || '—' }}</td>
            <td class="in-mono">{{ it.location || '—' }}</td>
            <!--
              [IC.F14] Un SOLO formato para la misma cantidad. Postgres manda el numérico como
              texto con sus tres decimales ("5.000"), y en México eso se lee CINCO MIL — mientras
              el campo de captura de abajo escribe "999,999" con coma. Quien veía 5.000 arriba y
              tecleaba 5,000 abajo metía mil veces más. El pipe deja "5" y "999,999" en los dos
              lados, y conserva el decimal cuando de verdad lo hay (1.5 sigue siendo 1.5).
            -->
            <td class="in-num num">{{ it.expected_qty | number: '1.0-3' }}</td>
            <td class="in-num num">{{ (it.count_1 | number: '1.0-3') ?? '·' }}</td>
            <td class="in-num num">{{ (it.count_2 | number: '1.0-3') ?? '·' }}</td>
            <td class="in-num num">{{ (it.count_3 | number: '1.0-3') ?? '·' }}</td>
            <td class="in-num num"><b>{{ (it.final_qty | number: '1.0-3') ?? '·' }}</b></td>
            <td class="in-num num" [class.in-var-neg]="+(it.variance ?? 0) < 0" [class.in-var-pos]="+(it.variance ?? 0) > 0">
              {{ it.variance != null ? (+it.variance > 0 ? '+' : '') + (it.variance | number: '1.0-3') : '·' }}
            </td>
            <td><p-tag [value]="itemStatusLabel(it.status)" [severity]="itemStatusSeverity(it.status)"></p-tag></td>
            <td>
              <!--
                [IC.F3] El botón aparece donde el servidor lo va a aceptar: en discrepancia, y
                en lo ya resuelto para poder CORREGIRLO. Antes salía desde el minuto cero,
                sobre artículos que nadie había contado, en un folio de conteo ciego.
              -->
              @if (!isTerminal() && (it.status === 'discrepancy' || it.status === 'resolved')) {
                <button pButton [text]="true" size="small" (click)="openResolve(it)"
                  [pTooltip]="it.status === 'resolved' ? 'Corregir' : 'Resolver'"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span></button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <!--
            [IC.F17] Tres estados distintos, tres mensajes distintos. Antes los tres decían
            «Sin items para este filtro»: ante un 403 la tabla afirmaba que el folio estaba
            vacío mientras el encabezado publicaba «Sin contar 3,363».
          -->
          <tr>
            <td colspan="11" class="in-empty">
              @if (itemsFalla() === 'sin_permiso') {
                <span class="in-empty-ttl">No puedes ver los artículos de este folio.</span>
                <span class="in-empty-sub">Tu puesto no incluye el detalle del conteo. Pídeselo a quien lo supervisa.</span>
              } @else if (itemsFalla() === 'error') {
                <span class="in-empty-ttl">No se pudieron cargar los artículos.</span>
                <span class="in-empty-sub">No es que el folio esté vacío: la consulta falló. Vuelve a cargar.</span>
              } @else {
                Sin items para este filtro.
              }
            </td>
          </tr>
        </ng-template>
      </p-table>
      </div>
      </div>

      <!-- Dialog resolver -->
      <p-dialog [(visible)]="resolveVisible" header="Resolver item" [modal]="true" [style]="{ width: '420px' }">
        @if (resolveItem()) {
          <div class="in-form">
            <p class="in-resolve-name">{{ resolveItem()?.product_name }}</p>
            <p class="in-resolve-meta">Teórico: <b>{{ resolveItem()?.expected_qty | number: '1.0-3' }}</b> · C1: {{ (resolveItem()?.count_1 | number: '1.0-3') ?? '—' }} · C2: {{ (resolveItem()?.count_2 | number: '1.0-3') ?? '—' }} · C3: {{ (resolveItem()?.count_3 | number: '1.0-3') ?? '—' }}</p>
            <label>Cantidad física final</label>
            <p-inputnumber appCantidadFisica [(ngModel)]="resolveQty" [min]="0" styleClass="in-w-full"></p-inputnumber>
            <label>Motivo de la varianza</label>
            <p-select [options]="reasonCodes()" optionLabel="label" optionValue="code" [(ngModel)]="resolveReason" placeholder="Clasificar (opcional)" [showClear]="true" appendTo="body" styleClass="in-w-full"></p-select>
            <label>Nota (detalle libre)</label>
            <input pInputText [(ngModel)]="resolveNotes" class="in-w-full" placeholder="Opcional" />
          </div>
        }
        <ng-template #footer>
          <button pButton [text]="true" severity="secondary" (click)="resolveVisible.set(false)"><span class="p-button-label">Cancelar</span></button>
          <button pButton [loading]="resolving()" [disabled]="resolveQty() === null" (click)="saveResolve()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    /* [CNT.1] Lo que falta para cerrar va ARRIBA del boton y se ve: no es una nota al pie. */
    .in-bloqueos {
      font-size: var(--fs-xs); color: var(--warn-fg); margin: 0 0 1rem;
      padding: .55rem .8rem; border-left: 3px solid var(--warn-fg);
      background: color-mix(in srgb, var(--warn-fg) 7%, transparent); border-radius: 4px;
      line-height: 1.5; max-width: 90ch;
    }
    .in-bloqueos ul { margin: .25rem 0 .25rem 1.1rem; padding: 0; }
    .in-bloqueos-pie { display: block; color: var(--fg-3); margin-top: .25rem; }
    .in-listo { font-size: var(--fs-xs); color: var(--ok-fg); margin: 0 0 1rem; }
    .in-head-actions { display: flex; gap: .5rem; align-items: center; }
    .in-live { display: inline-flex; align-items: center; gap: .35rem; font-size: .7rem; font-weight: 700; letter-spacing: .05em; color: var(--ok-fg); padding: .2rem .5rem; border-radius: 99px; background: color-mix(in srgb, var(--ok-fg) 14%, transparent); }
    .in-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); animation: in-pulse 1.4s ease-in-out infinite; }
    @keyframes in-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    app-metric-strip { display:block; margin-bottom: 1.25rem; }
    .in-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .in-assign { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .85rem 1rem; background: var(--card-bg); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; }
    .in-assign-col { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: .3rem; }
    .in-assign-col label { font-size: .8rem; font-weight: 600; color: var(--text-muted,#78716c); }
    .in-assign-col small { color: var(--text-muted,#78716c); }
    :host ::ng-deep .in-ms { width: 100%; }
    .in-filter { margin-bottom: .75rem; }
    /*
      [IC.F5] El buscador vive al lado del filtro, que es donde la persona decide que mira.
      Se estira para que quepa el placeholder entero y baja solo en pantalla angosta.
    */
    .in-filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .in-buscar { flex: 1 1 22rem; min-width: 14rem; }
    /* [IC.UB1] Es un hecho de cobertura, no una alarma: va en texto secundario. */
    .in-ubic {
      margin: var(--sp-2) 0 0; display: flex; gap: var(--sp-2); align-items: baseline;
      color: var(--text-muted); font-size: var(--fs-sm);
    }
    .in-mono { font-family: var(--font-mono, monospace); }
    .in-name { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .in-num { text-align: right; font-variant-numeric: tabular-nums; }
    .in-var-neg { color: var(--bad-fg); font-weight: 600; }
    .in-var-pos { color: var(--ok-fg); font-weight: 600; }
    .in-row-disc { background: color-mix(in srgb, var(--orange-500, #f97316) 8%, transparent); }
    .in-empty { text-align: center; padding: 2rem; color: var(--text-muted); }
    /*
      [IC.F17] El motivo va VISIBLE, no en un tooltip: sin mouse no existe, y es justo el dato
      que distingue «el folio está vacío» de «no tienes permiso».
      (Sin acentos graves acá adentro: parten el template literal de styles. Séptima vez.)
    */
    /*
      [IC.F5] El aviso de tope. Va pegado al filtro, que es donde la persona decide qué mira,
      y usa el ambar de aviso en su variante de TEXTO (--warn-soft-fg): el -fg suelto da 2.15:1
      sobre blanco y no pasa AA.
    */
    .in-tope {
      margin: var(--sp-2) 0 0; display: flex; gap: var(--sp-2); align-items: baseline;
      color: var(--warn-soft-fg); font-size: var(--fs-sm);
    }
    .in-empty-ttl { display: block; color: var(--text-main); font-weight: 600; }
    .in-empty-sub { display: block; margin-top: var(--sp-1); color: var(--text-muted); }
    .in-form { display: flex; flex-direction: column; gap: .4rem; }
    .in-form label { font-size: .8rem; font-weight: 600; color: var(--text-muted, #78716c); margin-top: .6rem; }
    :host ::ng-deep .in-w-full { width: 100%; }
    .in-resolve-name { font-weight: 600; margin: 0; }
    .in-resolve-meta { color: var(--text-muted, #78716c); font-size: .85rem; margin: .25rem 0 0; }
    .in-interrupt { background: var(--card-bg); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; padding: .85rem 1rem; margin-bottom: 1rem; }
    .in-interrupt-head { display: flex; align-items: center; gap: .5rem; font-weight: 600; margin-bottom: .6rem; }
    .in-interrupt-head i { color: var(--orange-500,#f97316); }
    .in-interrupt-head small { font-weight: 400; color: var(--text-muted,#78716c); margin-left: auto; }
    .in-interrupt-users { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .6rem; }
    .in-interrupt-chip { display: flex; flex-direction: column; padding: .4rem .7rem; border-radius: 10px; background: var(--surface-100,#f5f5f4); }
    .in-interrupt-chip-warn { background: color-mix(in srgb, var(--orange-500,#f97316) 14%, transparent); }
    .in-interrupt-user { font-weight: 600; font-size: .85rem; }
    .in-interrupt-stat { font-size: var(--fs-xs); color: var(--text-muted,#78716c); font-variant-numeric: tabular-nums; }
    .in-interrupt-timeline { display: flex; flex-direction: column; }
    .in-interrupt-row { display: flex; gap: .75rem; padding: .3rem .15rem; border-top: 1px solid var(--surface-100,#f5f5f4); font-size: .8rem; }
    .in-interrupt-when { font-variant-numeric: tabular-nums; color: var(--text-muted,#78716c); min-width: 110px; }
    .in-interrupt-who { flex: 1; }
    .in-interrupt-dur { font-weight: 600; font-variant-numeric: tabular-nums; }
    .in-phase { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: .7rem 1rem; margin-bottom: 1rem; border-radius: 12px; background: color-mix(in srgb, var(--action,#ea580c) 9%, transparent); }
    .in-phase-info { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
    .in-phase-badge { font-weight: 700; background: var(--action,#ea580c); color: #fff; padding: .15rem .6rem; border-radius: 99px; font-size: .8rem; }
    .in-phase-label { font-weight: 600; }
    .in-phase-cov { color: var(--text-muted,#78716c); font-variant-numeric: tabular-nums; }
    .in-phase-hint { color: var(--text-muted,#78716c); }
    .in-sessions { margin-bottom: 1rem; }
    .in-sessions-head { font-weight: 600; margin-bottom: .5rem; display: flex; align-items: center; gap: .5rem; }
    .in-sessions-head i { color: var(--action,#ea580c); }

    /* Feed en vivo (#1) — productos apareciendo uno a uno. Lateral sticky en
       laptop (≥1100px), tarjeta colapsable arriba en móvil/tablet. */
    .in-body { display: grid; grid-template-columns: 1fr; gap: 1.25rem; align-items: start; }
    @media (min-width: 68.75rem) {
      .in-body-live { grid-template-columns: 1fr minmax(300px, 360px); }
      .in-body-live .in-main { grid-column: 1; grid-row: 1; }
      .in-body-live .in-live-rail { grid-column: 2; grid-row: 1; position: sticky; top: 1rem; }
    }
    .in-main { min-width: 0; }
    .in-live-rail { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #E4E4E7); border-radius: var(--r-lg, 16px); overflow: hidden; }
    .in-live-head { display: flex; align-items: center; gap: .5rem; padding: .5rem .4rem .5rem .75rem; border-bottom: 1px solid var(--border-color, #E4E4E7); }
    .in-live-title { display: inline-flex; align-items: center; gap: .4rem; font-weight: 700; font-size: .9rem; color: var(--text-main, #09090B); }
    .in-live-title i { color: var(--action, #f05a28); }
    .in-live-count { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); font-weight: 700; color: var(--action, #f05a28); background: color-mix(in srgb, var(--action, #f05a28) 12%, transparent); padding: .05rem .45rem; border-radius: var(--r-pill, 999px); }
    .in-live-toggle { margin-left: auto; }
    .in-live-body { max-height: 60vh; overflow-y: auto; }
    @media (max-width: 68.7488rem) { .in-live-body { max-height: 38vh; } }
    .in-live-row { display: flex; align-items: center; gap: .6rem; padding: .55rem .75rem; border-bottom: 1px solid var(--border-color, #E4E4E7); animation: in-live-in .25s var(--ease-out, ease); }
    .in-live-row:last-child { border-bottom: none; }
    .in-live-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .in-live-prod { font-weight: 600; font-size: .85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-main, #09090B); }
    .in-live-meta { font-size: .72rem; color: var(--text-muted, #52525B); }
    .in-live-qty { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 1rem; color: var(--text-main, #09090B); }
    .in-live-empty { padding: 1.5rem .75rem; text-align: center; color: var(--text-muted, #52525B); font-size: .85rem; }
    @keyframes in-live-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .in-live-row { animation: none; } }
  `],
})
export class ComercialInventorySessionDetailComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly monitor = inject(InventoryMonitorSocketService);

  live = this.monitor.connected;

  // Feed en vivo: conteos apilados al instante (uno a uno) para el supervisor.
  liveFeed = signal<LiveCountEntry[]>([]);
  feedCollapsed = signal(false);
  private feedSeq = 0;

  countId = this.route.snapshot.paramMap.get('id')!;
  progress = signal<InventorySupervisorProgress | null>(null);

  /**
   * ⛔⛔ `[IC.F18]` **Por qué el avance no está, cuando no está.** `null` = se pudo leer.
   *
   * Hasta el 2026-11-26 los KPIs hacían `?? 0` y un **403 se publicaba como CEROS**: a quien sólo
   * tiene `VER` —prevención, cuyo oficio ES el descuadre— la pantalla le mostraba «Cobertura 0.0 %
   * · Contados 0/0 · Sin contar 0 · Discrepancias 0 · Valor en riesgo $0» sobre un folio con
   * **3,363 artículos sin contar**. Eso no se lee como «no tengo permiso»: se lee como
   * **inventario contado y cuadrado**. Medido en vivo (`inventario-fisico.md` §9d, F18).
   *
   * Es la regla 11 del proyecto y el ADR-056: lo que no se pudo medir **se declara**, nunca se
   * dibuja como cero ni como verde.
   */
  avanceFalla = signal<'sin_permiso' | 'error' | null>(null);
  /** Lo mismo para la tabla de artículos (`[IC.F17]`): vacío ≠ sin permiso ≠ error. */
  itemsFalla = signal<'sin_permiso' | 'error' | null>(null);

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const p = this.progress();
    const falla = this.avanceFalla();
    // ⛔ Sin dato NO es cero. `no_medido` además inhabilita el tono, así que no queda un
    // indicador en verde ni en rojo afirmando algo que nadie midió.
    if (falla || !p) {
      const nota = falla === 'sin_permiso'
        ? 'No tienes permiso para ver el avance de este folio. Pídeselo a quien lo supervisa.'
        : 'No se pudo leer el avance. Vuelve a cargar.';
      return ['Cobertura', 'Contados', 'Sin contar', 'Discrepancias', 'Valor en riesgo'].map(
        (label): MetricStripItem => ({
          label, value: '—', format: 'text', state: 'no_medido', stateNote: nota,
        }),
      );
    }
    return [
      { label: 'Cobertura', value: p.coverage_pct ?? 0, format: 'percent' },
      { label: 'Contados', value: `${p.counted_once ?? 0}/${p.total ?? 0}`, format: 'text' },
      { label: 'Sin contar', value: p.uncounted ?? 0, tone: (p.uncounted ?? 0) > 0 ? 'bad' : 'default' },
      { label: 'Discrepancias', value: p.discrepancies ?? 0, tone: (p.discrepancies ?? 0) > 0 ? 'warn' : 'default' },
      { label: 'Valor en riesgo', value: +(p.value_at_variance ?? 0), format: 'currency' },
    ];
  });
  items = signal<InventoryCountItem[]>([]);

  /**
   * ⛔ `[IC.F5]` **El tope de la lista se DECLARA.** `listItems` corta en 2,000 y devuelve un
   * arreglo pelado —sin `total` ni `has_more`—, así que el front no podía avisarlo ni queriendo.
   * Medido el 2026-11-25 en `INV-2026-00010`: **2,000 de 3,363**, y como la consulta ordena
   * `discrepancy → pending → el resto` y después por nombre, lo que quedaba afuera era **todo el
   * final del alfabeto** y **los artículos ya resueltos** (eso era `F6`: no se excluían, se
   * caían por el tope — los dos son el mismo defecto).
   *
   * ⭐ No hace falta cambiar el contrato para decir la verdad: el total ya viene en `progress`.
   * El tope exacto de 2,000 es inequívoco, porque es el `limit` del servicio.
   */
  readonly TOPE_LISTA = 2000;

  /**
   * ⛔⛔ `[IC.UB1]` **La columna «Ubic.» mostraba una constante.**
   *
   * Medido en prod el 2026-11-27: `public.products.location` tiene **un solo valor distinto**
   * en los 11,816 productos que la traen, la cadena `Z000`, y el folio la copiaba al abrir —
   * **3,005 de los 3,364 artículos de `INV-2026-00010`** la decían. Una columna llena, con
   * cara de dato, que no ubicaba nada.
   *
   * Ahora la ubicación sale del catálogo de `/almacen/ubicaciones` (fase UB, ADR-090), y la
   * cobertura real es **39 de 3,364**. Bajar de 3,005 a 39 es el punto: lo que no está
   * asignado se ve vacío, y esta línea dice cuánto falta y dónde se asigna.
   *
   * `null` cuando el servidor no manda el campo (deploy viejo): no se dibuja un cero, que
   * sería afirmar «ninguno tiene ubicación».
   */
  readonly ubicacionesFaltantes = computed<number | null>(() => {
    const p = this.progress();
    if (!p || p.located == null) return null;
    return Math.max(0, (p.total ?? 0) - p.located);
  });
  readonly totalDelFolio = computed(() => this.progress()?.total ?? 0);
  readonly listaTopada = computed(() => {
    const n = this.items().length;
    // Sólo se afirma el recorte cuando se puede PROBAR: la lista vino llena hasta el tope y el
    // folio declara más. Sin `progress` (403) no se inventa un aviso: de eso habla F18.
    return n >= this.TOPE_LISTA && this.totalDelFolio() > n;
  });
  loading = signal(false);
  computing = signal(false);
  reconciling = signal(false);

  /**
   * [CNT.1] El boton se apaga cuando el servidor dice que no se puede cerrar. No es una regla
   * del frontend: `bloqueos` sale del MISMO metodo que `reconcile()` usa para rechazar.
   * ⚠️ Si el backend no manda el campo (deploy viejo), NO se bloquea: un `undefined` no puede
   * apagar un boton que antes funcionaba.
   */
  bloqueado(): boolean {
    // ⛔⛔ [IC.F11] FAIL-CLOSED cuando no se pudo leer el avance.
    //
    // Medido el 2026-11-25: **cuanto MENOS permiso tenía la persona, más habilitado se le veía
    // el botón.** Quien sí puede reconciliar recibe `bloqueos` y el botón se apaga ✅; a quien
    // recibe **403** le quedaba `progress = null` → `undefined` → `Array.isArray` falso →
    // **habilitado**. Una cuenta con sólo `VER` lo apretó, confirmó «No se puede deshacer» y
    // mandó el POST (lo rechazó el servidor, pero en silencio — ver F19).
    //
    // ⚠️ Se respeta la intención de `[CNT.1]`: un **deploy viejo que no manda el campo** sigue
    // sin bloquear. Lo que cambia es el otro caso, que antes no se distinguía: **no haber podido
    // leer el avance NO es "no hay bloqueos", es "no sé nada"**, y ahí se cierra.
    if (this.avanceFalla() !== null || this.progress() === null) return true;
    const b = this.progress()?.bloqueos;
    return Array.isArray(b) && b.length > 0;
  }

  bloqueoResumen(): string {
    const falla = this.avanceFalla();
    if (falla === 'sin_permiso')
      return 'No puedes cerrar este folio: tu puesto no incluye la reconciliación.';
    if (falla === 'error' || this.progress() === null)
      return 'No se pudo leer el avance del folio, así que no se puede cerrar. Vuelve a cargar.';
    const b = this.progress()?.bloqueos;
    if (!Array.isArray(b) || !b.length) return '';
    return 'No se puede cerrar todavia: ' + b.map((x) => x.mensaje).join(' ');
  }
  resolving = signal(false);

  filter = signal<string>('all');

  /**
   * `[IC.F5]` El texto que se busca EN EL SERVIDOR. Va con `debounceTime` porque cada pausa
   * dispara una consulta sobre 3,364 renglones; sin eso, escribir «oblea» serían cinco.
   */
  busqueda = signal<string>('');
  private readonly busquedaTecleada = new Subject<void>();

  buscar(texto: string): void {
    this.busqueda.set(texto ?? '');
    this.busquedaTecleada.next();
  }

  limpiarBusqueda(): void {
    this.buscar('');
  }
  /**
   * [IC.F6] Los estados que EXISTEN, no los que suponiamos.
   *
   * Medido en prod el 2026-11-27 sobre los 7 folios con articulos: los unicos estados vivos
   * son pending (22,197), counted (9) y resolved (3). discrepancy: CERO, porque nadie llego
   * nunca a calcular. El filtro ofrecia «Discrepancias» y «Pendientes», y ninguna de las dos
   * formas de ver trabajo YA HECHO.
   *
   * Y no era que estuvieran escondidas: listItems ordena discrepancy -> pending -> el resto y
   * corta en 2,000, asi que en INV-2026-00010 (3,364 articulos, 3,361 pendientes) lo contado y
   * lo resuelto caen SIEMPRE despues del corte. Sin filtro por estado eran inalcanzables; con
   * el, el servidor devuelve 3 filas. Eso cierra F6, y es lo que vuelve alcanzable el boton
   * «Corregir» de F3: resolver un articulo lo mandaba a un lugar al que nadie podia ir.
   *
   * El orden es por cuanta decision pide cada estado, no por el ciclo de vida: decidir ahora,
   * revisar lo decidido, lo que ya cuadro, lo que nadie toco.
   */
  filterOptions = [
    { label: 'Todos', value: 'all' },
    { label: 'Discrepancias', value: 'discrepancy' },
    { label: 'Resueltos', value: 'resolved' },
    { label: 'Contados', value: 'counted' },
    { label: 'Pendientes', value: 'pending' },
  ];

  resolveVisible = signal(false);
  resolveItem = signal<InventoryCountItem | null>(null);
  resolveQty = signal<number | null>(null);
  resolveNotes = signal<string>('');
  resolveReason = signal<string | null>(null);
  reasonCodes = signal<{ code: string; label: string }[]>([]);

  isTerminal = computed(() => {
    const s = this.progress()?.status;
    return s === 'reconciled' || s === 'cancelled';
  });

  canReconcile = computed(() => this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_RECONCILIAR] === true);
  canAssign = computed(() => this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR] === true);

  counterOpts = signal<{ label: string; value: string }[]>([]);
  supervisorOpts = signal<{ label: string; value: string }[]>([]);
  selCounters = signal<string[]>([]);
  selSupervisors = signal<string[]>([]);

  interruptions = signal<InventoryInterruptions | null>(null);
  sessions = signal<InventoryCountSession[]>([]);
  advancing = signal(false);

  // Botón de avance de fase: solo en 'counting' y con la pasada actual 100% cubierta.
  canAdvance = computed(() => {
    const p = this.progress();
    return !!p && p.status === 'counting' && (p.pass_coverage_pct ?? 0) >= 100;
  });
  advanceLabel = computed(() => {
    const p = this.progress();
    if (p && p.current_pass === 1 && p.blind_double_count) return 'Avanzar a Fase 2 (conteo ciego)';
    return 'Cerrar conteo y revisar';
  });

  constructor() {
    this.load();
    this.busquedaTecleada
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.loadItems());
    if (this.canAssign()) this.loadAssignments();
    this.loadInterruptions();
    this.loadSessions();
    this.loadReasons();

    // Monitoreo en vivo: cada evento del folio refresca el tablero (debounced
    // para no recargar en cada escaneo de una ráfaga).
    this.monitor.connect(this.countId);
    this.monitor.event$
      .pipe(debounceTime(800), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.load();
        this.loadSessions();
        this.loadInterruptions();
      });

    // Feed en vivo (sin debounce): cada conteo aparece al instante en el panel,
    // reusando los eventos 'count' que el backend ya emite por escaneo.
    this.monitor.event$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (e.type !== 'count') return;
        this.liveFeed.update((f) => [{
          seq: ++this.feedSeq,
          username: e['username'] || 'Contador',
          product_name: e['product_name'] || e['sku'] || '—',
          sku: e['sku'] || '',
          qty: Number(e['qty'] ?? 0),
          slot: e['slot'] || 'count_1',
          at: e.at,
        }, ...f].slice(0, 50));
      });
    this.destroyRef.onDestroy(() => this.monitor.disconnect());
  }

  private loadReasons() {
    this.svc.inventoryVarianceReasons()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.reasonCodes.set(r), error: () => { /* no crítico */ } });
  }

  private loadInterruptions() {
    this.svc.inventoryInterruptions(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.interruptions.set(r), error: () => { /* no crítico */ } });
  }

  private loadSessions() {
    this.svc.inventorySessions(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.sessions.set(r), error: () => { /* no crítico */ } });
  }

  advancePass() {
    this.advancing.set(true);
    this.svc.inventoryAdvancePass(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.advancing.set(false);
          this.toast.add({
            severity: 'success',
            summary: r.next === 'review' ? 'Conteo cerrado — en revisión' : `Fase ${r.current_pass} habilitada`,
          });
          this.load();
        },
        error: (e) => { this.advancing.set(false); this.toast.add({ severity: 'warn', summary: 'No se pudo avanzar', detail: e?.error?.message }); },
      });
  }

  fmtDuration(s: number | null): string {
    const sec = s || 0;
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return `${m}m ${sec % 60}s`;
  }

  private loadAssignments() {
    const opt = (u: AssignableUser) => ({ label: u.nombre || u.username, value: u.id });
    this.svc.inventoryAssignableUsers('counter').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => this.counterOpts.set(us.map(opt)) });
    this.svc.inventoryAssignableUsers('supervisor').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => this.supervisorOpts.set(us.map(opt)) });
    this.svc.inventoryListAssignments(this.countId).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (as) => {
          this.selCounters.set(as.filter((a) => a.assignment_role === 'counter').map((a) => a.user_id));
          this.selSupervisors.set(as.filter((a) => a.assignment_role === 'supervisor').map((a) => a.user_id));
        },
      });
  }

  saveAssign(role: 'counter' | 'supervisor') {
    const ids = role === 'counter' ? this.selCounters() : this.selSupervisors();
    this.svc.inventorySetAssignments(this.countId, role, ids)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.toast.add({ severity: 'success', summary: `Asignados ${r.count} ${role === 'counter' ? 'contadores' : 'supervisores'}` }),
        error: (e) => this.toast.add({ severity: 'warn', summary: 'No se guardó', detail: e?.error?.message }),
      });
  }

  load() {
    this.loading.set(true);
    this.avanceFalla.set(null);
    this.itemsFalla.set(null);
    this.svc.inventorySupervisorProgress(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (p) => { this.progress.set(p); this.avanceFalla.set(null); },
        // ⛔ [IC.F18] El progreso NO se queda en null en silencio: si queda, los KPIs
        // pintaban `?? 0` y la pantalla afirmaba un inventario cuadrado. Se declara.
        error: (e) => {
          this.progress.set(null);
          this.avanceFalla.set(e?.status === 403 ? 'sin_permiso' : 'error');
          this.toast.add({
            severity: 'error',
            summary: e?.status === 403 ? 'No tienes permiso para ver el avance' : 'Error al cargar avance',
          });
        },
      });

    this.loadItems();
  }

  /**
   * `[IC.F5]` Los artículos se recargan solos al buscar, SIN volver a pedir el avance: con
   * `load()` entero, cada pausa del teclado dispararía además un GET de progreso.
   */
  private loadItems() {
    this.loading.set(true);
    const status = this.filter() === 'all' ? undefined : this.filter();
    this.svc.inventoryCountItems(this.countId, status, this.busqueda().trim() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (its) => { this.items.set(its); this.itemsFalla.set(null); this.loading.set(false); },
        // ⛔ [IC.F17] Sin esto la tabla decía «Sin items para este filtro» ante un 403,
        // mientras el encabezado publicaba «SIN CONTAR 3,363». Dos verdades a la vez.
        error: (e) => {
          this.loading.set(false);
          this.items.set([]);
          this.itemsFalla.set(e?.status === 403 ? 'sin_permiso' : 'error');
          this.toast.add({
            severity: 'error',
            summary: e?.status === 403 ? 'No tienes permiso para ver los artículos' : 'Error al cargar items',
          });
        },
      });
  }

  compute() {
    this.computing.set(true);
    this.svc.inventoryComputeDiscrepancies(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.computing.set(false);
          this.toast.add({ severity: 'info', summary: 'Discrepancias calculadas', detail: `${r.resolved} resueltos · ${r.discrepancies} discrepancias` });
          this.load();
        },
        error: (e) => { this.computing.set(false); this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }); },
      });
  }

  confirmReconcile() {
    this.confirm.confirm({
      header: 'Reconciliar inventario',
      message: 'Esto ajusta el stock teórico al físico contado y genera los movimientos. No se puede deshacer. ¿Continuar?',
      acceptLabel: 'Reconciliar', rejectLabel: 'Cancelar',
      accept: () => this.reconcile(),
    });
  }

  reconcile() {
    this.reconciling.set(true);
    this.svc.inventoryReconcile(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.reconciling.set(false);
          this.toast.add({ severity: 'success', summary: `Folio ${r.folio} reconciliado`, detail: `${r.items_adjusted} ajustes · delta neto ${r.net_delta}` });
          this.load();
        },
        error: (e) => { this.reconciling.set(false); this.toast.add({ severity: 'warn', summary: 'No se reconcilió', detail: e?.error?.message }); },
      });
  }

  confirmCancel() {
    this.confirm.confirm({
      header: 'Cancelar folio',
      message: '¿Cancelar este folio de inventario? No se aplicará ningún ajuste.',
      acceptLabel: 'Sí, cancelar', rejectLabel: 'No',
      accept: () => {
        this.svc.inventoryCancelCount(this.countId)
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: () => { this.toast.add({ severity: 'info', summary: 'Folio cancelado' }); this.load(); },
            error: (e) => this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }),
          });
      },
    });
  }

  openResolve(it: InventoryCountItem) {
    this.resolveItem.set(it);
    this.resolveQty.set(it.final_qty != null ? +it.final_qty : (it.count_1 != null ? +it.count_1 : null));
    this.resolveNotes.set(it.notes || '');
    this.resolveReason.set(it.reason_code || null);
    this.resolveVisible.set(true);
  }

  saveResolve() {
    const it = this.resolveItem();
    const qty = this.resolveQty();
    if (!it || qty === null) return;
    this.resolving.set(true);
    this.svc.inventoryResolveItem(this.countId, it.id, { final_qty: qty, notes: this.resolveNotes() || undefined, reason_code: this.resolveReason() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.resolving.set(false);
          this.resolveVisible.set(false);
          this.toast.add({ severity: 'success', summary: 'Item resuelto' });
          this.load();
        },
        error: (e) => { this.resolving.set(false); this.toast.add({ severity: 'warn', summary: 'Error', detail: e?.error?.message }); },
      });
  }

  statusLabel(s?: string): string {
    return { open: 'Abierto', counting: 'Contando', review: 'Revisión', ready_to_reconcile: 'Por reconciliar', reconciled: 'Reconciliado', cancelled: 'Cancelado' }[s || ''] || s || '';
  }
  statusSeverity(s?: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'reconciled') return 'success';
    if (s === 'cancelled') return 'secondary';
    if (s === 'review' || s === 'ready_to_reconcile') return 'warn';
    return 'info';
  }
  itemStatusLabel(s: string): string {
    return { pending: 'Pendiente', counted: 'Contado', discrepancy: 'Discrepancia', resolved: 'Resuelto' }[s] || s;
  }
  itemStatusSeverity(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'resolved') return 'success';
    if (s === 'discrepancy') return 'danger';
    if (s === 'counted') return 'info';
    return 'secondary';
  }

  slotLabel(slot: string): string {
    if (slot === 'count_2') return '2do';
    if (slot === 'count_3') return 'reconteo';
    return '1er';
  }
}
