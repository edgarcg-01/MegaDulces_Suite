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
import { SelectButtonModule } from 'primeng/selectbutton';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { MessageService, ConfirmationService } from 'primeng/api';
import { debounceTime } from 'rxjs/operators';
import { ComercialService, InventoryCountItem, InventorySupervisorProgress, AssignableUser, InventoryInterruptions, InventoryCountSession } from '../comercial.service';
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
  ],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ progress()?.folio || 'Folio' }}</h1>
          <p class="surf-page-sub">
            <p-tag [value]="statusLabel(progress()?.status)" [severity]="statusSeverity(progress()?.status)"></p-tag>
          </p>
        </div>
        <div class="in-head-actions">
          @if (live()) {
            <span class="in-live" title="Monitoreo en vivo activo"><span class="in-live-dot"></span> EN VIVO</span>
          }
          <button pButton icon="pi pi-arrow-left" label="Volver" [text]="true" severity="secondary" size="small" routerLink="/almacen/inventory/sessions"></button>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()"></button>
        </div>
      </header>

      <div class="in-body" [class.in-body-live]="!isTerminal()">
      @if (!isTerminal()) {
        <aside class="in-live-rail">
          <div class="in-live-head">
            <span class="in-live-title"><i class="pi pi-bolt"></i> En vivo</span>
            @if (liveFeed().length) { <span class="in-live-count">{{ liveFeed().length }}</span> }
            <button pButton [icon]="feedCollapsed() ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" [text]="true" severity="secondary" size="small"
                    class="in-live-toggle" [attr.aria-label]="feedCollapsed() ? 'Mostrar feed en vivo' : 'Ocultar feed en vivo'"
                    (click)="feedCollapsed.set(!feedCollapsed())"></button>
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
                    <span class="in-live-qty">{{ e.qty }}</span>
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
      <div class="in-kpis">
        <div class="in-kpi"><span class="in-kpi-v">{{ progress()?.coverage_pct ?? 0 }}%</span><span class="in-kpi-l">Cobertura</span></div>
        <div class="in-kpi"><span class="in-kpi-v">{{ progress()?.counted_once ?? 0 }}/{{ progress()?.total ?? 0 }}</span><span class="in-kpi-l">Contados</span></div>
        <div class="in-kpi" [class.in-kpi-bad]="(progress()?.uncounted ?? 0) > 0"><span class="in-kpi-v">{{ progress()?.uncounted ?? 0 }}</span><span class="in-kpi-l">Sin contar</span></div>
        <div class="in-kpi" [class.in-kpi-warn]="(progress()?.discrepancies ?? 0) > 0"><span class="in-kpi-v">{{ progress()?.discrepancies ?? 0 }}</span><span class="in-kpi-l">Discrepancias</span></div>
        <div class="in-kpi"><span class="in-kpi-v">{{ (+(progress()?.value_at_variance ?? 0)) | currency:'MXN':'symbol-narrow':'1.0-0' }}</span><span class="in-kpi-l">Valor en riesgo</span></div>
      </div>

      <!-- Fase actual + avance -->
      @if (progress()?.status === 'counting') {
        <div class="in-phase">
          <div class="in-phase-info">
            <span class="in-phase-badge">Fase {{ progress()?.current_pass }}</span>
            <span class="in-phase-label">{{ progress()?.current_pass === 1 ? 'Primer conteo' : 'Segundo conteo (ciego)' }}</span>
            <span class="in-phase-cov">{{ progress()?.pass_coverage_pct ?? 0 }}% cubierto</span>
          </div>
          @if (canAdvance()) {
            <button pButton [label]="advanceLabel()" icon="pi pi-arrow-right" severity="success" size="small" [loading]="advancing()" (click)="advancePass()"></button>
          } @else {
            <small class="in-phase-hint">Completá el 100% de la pasada para avanzar de fase.</small>
          }
        </div>
      }

      <!-- Acciones -->
      @if (!isTerminal()) {
        <div class="in-actions">
          <button pButton icon="pi pi-calculator" label="Calcular discrepancias" size="small" severity="secondary" [loading]="computing()" (click)="compute()"></button>
          @if (canAssign()) {
            <button pButton icon="pi pi-users" label="Equipos por pasillo" size="small" [text]="true" severity="secondary"
                    [routerLink]="['/almacen/inventory/sessions', countId, 'teams']"></button>
          }
          @if (canReconcile()) {
            <button pButton icon="pi pi-check-circle" label="Reconciliar" size="small" severity="success" [loading]="reconciling()" (click)="confirmReconcile()"></button>
          }
          @if (canReconcile()) {
            <button pButton icon="pi pi-times" label="Cancelar folio" size="small" [text]="true" severity="danger" (click)="confirmCancel()"></button>
          }
        </div>
      }

      <!-- Asignación de personas (Fase I.4) -->
      @if (canAssign() && !isTerminal()) {
        <div class="in-assign">
          <div class="in-assign-col">
            <label>Contadores asignados</label>
            <p-multiSelect [options]="counterOpts()" [(ngModel)]="selCounters" optionLabel="label" optionValue="value"
                           placeholder="Todos (folio abierto)" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('counter')"></p-multiSelect>
            <small>Si no asignás ninguno, cualquiera con permiso de contar puede contar este folio.</small>
          </div>
          <div class="in-assign-col">
            <label>Supervisores asignados</label>
            <p-multiSelect [options]="supervisorOpts()" [(ngModel)]="selSupervisors" optionLabel="label" optionValue="value"
                           placeholder="Sin asignar" [filter]="true" display="chip" styleClass="in-ms"
                           appendTo="body" scrollHeight="45vh" [panelStyle]="{ maxWidth: '92vw' }"
                           (onPanelHide)="saveAssign('supervisor')"></p-multiSelect>
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
          <p-table [value]="sessions()" responsiveLayout="scroll" styleClass="p-datatable-sm surf-table surf-table--sticky surf-table--zebra">
            <ng-template pTemplate="header">
              <tr>
                <th scope="col">Contador</th><th scope="col" class="in-num num">Fase</th><th scope="col">Inició</th><th scope="col">Terminó</th><th scope="col">Estado</th>
                <th scope="col" class="in-num num">SKUs</th><th scope="col" class="in-num num">Unidades</th><th scope="col" class="in-num num">Interrup.</th>
              </tr>
            </ng-template>
            <ng-template pTemplate="body" let-s>
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
        <p-selectButton [options]="filterOptions" [(ngModel)]="filter" (onChange)="load()" optionLabel="label" optionValue="value"></p-selectButton>
      </div>

      <!-- Tabla de items -->
      <p-table [value]="items()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra" [scrollable]="true" scrollHeight="flex">
        <ng-template pTemplate="header">
          <tr>
            <th scope="col">SKU</th><th scope="col">Producto</th><th scope="col">Ubic.</th>
            <th scope="col" class="in-num num">Teórico</th><th scope="col" class="in-num num">C1</th><th scope="col" class="in-num num">C2</th><th scope="col" class="in-num num">C3</th>
            <th scope="col" class="in-num num">Final</th><th scope="col" class="in-num num">Var.</th><th scope="col">Estado</th><th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-it>
          <tr [class.in-row-disc]="it.status === 'discrepancy'">
            <td class="in-mono">{{ it.sku || '—' }}</td>
            <td class="in-name">{{ it.product_name || '—' }}</td>
            <td class="in-mono">{{ it.location || '—' }}</td>
            <td class="in-num num">{{ it.expected_qty }}</td>
            <td class="in-num num">{{ it.count_1 ?? '·' }}</td>
            <td class="in-num num">{{ it.count_2 ?? '·' }}</td>
            <td class="in-num num">{{ it.count_3 ?? '·' }}</td>
            <td class="in-num num"><b>{{ it.final_qty ?? '·' }}</b></td>
            <td class="in-num num" [class.in-var-neg]="+(it.variance ?? 0) < 0" [class.in-var-pos]="+(it.variance ?? 0) > 0">
              {{ it.variance != null ? (+it.variance > 0 ? '+' : '') + it.variance : '·' }}
            </td>
            <td><p-tag [value]="itemStatusLabel(it.status)" [severity]="itemStatusSeverity(it.status)"></p-tag></td>
            <td>
              @if (!isTerminal() && it.status !== 'resolved') {
                <button pButton icon="pi pi-pencil" [text]="true" size="small" (click)="openResolve(it)" pTooltip="Resolver"></button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="11" class="in-empty">Sin items para este filtro.</td></tr>
        </ng-template>
      </p-table>
      </div>
      </div>

      <!-- Dialog resolver -->
      <p-dialog [(visible)]="resolveVisible" header="Resolver item" [modal]="true" [style]="{ width: '420px' }">
        @if (resolveItem()) {
          <div class="in-form">
            <p class="in-resolve-name">{{ resolveItem()?.product_name }}</p>
            <p class="in-resolve-meta">Teórico: <b>{{ resolveItem()?.expected_qty }}</b> · C1: {{ resolveItem()?.count_1 ?? '—' }} · C2: {{ resolveItem()?.count_2 ?? '—' }} · C3: {{ resolveItem()?.count_3 ?? '—' }}</p>
            <label>Cantidad física final</label>
            <p-inputNumber [(ngModel)]="resolveQty" [min]="0" styleClass="in-w-full"></p-inputNumber>
            <label>Motivo de la varianza</label>
            <p-select [options]="reasonCodes()" optionLabel="label" optionValue="code" [(ngModel)]="resolveReason" placeholder="Clasificar (opcional)" [showClear]="true" appendTo="body" styleClass="in-w-full"></p-select>
            <label>Nota (detalle libre)</label>
            <input pInputText [(ngModel)]="resolveNotes" class="in-w-full" placeholder="Opcional" />
          </div>
        }
        <ng-template pTemplate="footer">
          <button pButton label="Cancelar" [text]="true" severity="secondary" (click)="resolveVisible.set(false)"></button>
          <button pButton label="Guardar" icon="pi pi-check" [loading]="resolving()" [disabled]="resolveQty() === null" (click)="saveResolve()"></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .in-head-actions { display: flex; gap: .5rem; align-items: center; }
    .in-live { display: inline-flex; align-items: center; gap: .35rem; font-size: .7rem; font-weight: 700; letter-spacing: .05em; color: var(--ok-fg); padding: .2rem .5rem; border-radius: 99px; background: color-mix(in srgb, var(--ok-fg) 14%, transparent); }
    .in-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok-fg); animation: in-pulse 1.4s ease-in-out infinite; }
    @keyframes in-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    .in-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
    .in-kpi { background: var(--card-bg); border: 1px solid var(--surface-200, #e7e5e4); border-radius: 12px; padding: .85rem 1rem; display: flex; flex-direction: column; }
    .in-kpi-v { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .in-kpi-l { font-size: .75rem; color: var(--text-muted, #78716c); text-transform: uppercase; letter-spacing: .03em; }
    .in-kpi-bad .in-kpi-v { color: var(--bad-fg); }
    .in-kpi-warn .in-kpi-v { color: var(--orange-500, #f97316); }
    .in-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .in-assign { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .85rem 1rem; background: var(--card-bg); border: 1px solid var(--surface-200,#e7e5e4); border-radius: 12px; }
    .in-assign-col { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: .3rem; }
    .in-assign-col label { font-size: .8rem; font-weight: 600; color: var(--text-muted,#78716c); }
    .in-assign-col small { color: var(--text-muted,#78716c); }
    :host ::ng-deep .in-ms { width: 100%; }
    .in-filter { margin-bottom: .75rem; }
    .in-mono { font-family: var(--font-mono, monospace); }
    .in-name { max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .in-num { text-align: right; font-variant-numeric: tabular-nums; }
    .in-var-neg { color: var(--bad-fg); font-weight: 600; }
    .in-var-pos { color: var(--ok-fg); font-weight: 600; }
    .in-row-disc { background: color-mix(in srgb, var(--orange-500, #f97316) 8%, transparent); }
    .in-empty { text-align: center; padding: 2rem; color: var(--text-muted, #78716c); }
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
    .in-interrupt-stat { font-size: .75rem; color: var(--text-muted,#78716c); font-variant-numeric: tabular-nums; }
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
    @media (min-width: 1100px) {
      .in-body-live { grid-template-columns: 1fr minmax(300px, 360px); }
      .in-body-live .in-main { grid-column: 1; grid-row: 1; }
      .in-body-live .in-live-rail { grid-column: 2; grid-row: 1; position: sticky; top: 1rem; }
    }
    .in-main { min-width: 0; }
    .in-live-rail { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e8e2d7); border-radius: var(--r-lg, 16px); overflow: hidden; }
    .in-live-head { display: flex; align-items: center; gap: .5rem; padding: .5rem .4rem .5rem .75rem; border-bottom: 1px solid var(--border-color, #e8e2d7); }
    .in-live-title { display: inline-flex; align-items: center; gap: .4rem; font-weight: 700; font-size: .9rem; color: var(--text-main, #100d09); }
    .in-live-title i { color: var(--action, #f05a28); }
    .in-live-count { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: .75rem; font-weight: 700; color: var(--action, #f05a28); background: color-mix(in srgb, var(--action, #f05a28) 12%, transparent); padding: .05rem .45rem; border-radius: var(--r-pill, 999px); }
    .in-live-toggle { margin-left: auto; }
    .in-live-body { max-height: 60vh; overflow-y: auto; }
    @media (max-width: 1099.98px) { .in-live-body { max-height: 38vh; } }
    .in-live-row { display: flex; align-items: center; gap: .6rem; padding: .55rem .75rem; border-bottom: 1px solid var(--border-color, #e8e2d7); animation: in-live-in .25s var(--ease-out, ease); }
    .in-live-row:last-child { border-bottom: none; }
    .in-live-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .in-live-prod { font-weight: 600; font-size: .85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-main, #100d09); }
    .in-live-meta { font-size: .72rem; color: var(--text-muted, #5e564b); }
    .in-live-qty { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 1rem; color: var(--text-main, #100d09); }
    .in-live-empty { padding: 1.5rem .75rem; text-align: center; color: var(--text-muted, #5e564b); font-size: .85rem; }
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
  items = signal<InventoryCountItem[]>([]);
  loading = signal(false);
  computing = signal(false);
  reconciling = signal(false);
  resolving = signal(false);

  filter = signal<string>('all');
  filterOptions = [
    { label: 'Todos', value: 'all' },
    { label: 'Discrepancias', value: 'discrepancy' },
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
    this.svc.inventorySupervisorProgress(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (p) => this.progress.set(p), error: () => this.toast.add({ severity: 'error', summary: 'Error al cargar avance' }) });

    const status = this.filter() === 'all' ? undefined : this.filter();
    this.svc.inventoryCountItems(this.countId, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (its) => { this.items.set(its); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar items' }); },
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
