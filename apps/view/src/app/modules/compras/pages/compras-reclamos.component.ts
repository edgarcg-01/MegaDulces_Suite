import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { MessageService } from 'primeng/api';
import { debounceTime, Subject } from 'rxjs';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ComercialService } from '../../comercial/comercial.service';
import {
  ReceivingClaimsService, ReceivingClaim, ReceivingClaimKpis, TransferOriginPending,
} from '../receiving-claims.service';

/**
 * **WMS-REC.8 (ADR-053) — Reclamos de recepción.**
 *
 * La bandeja donde muere el circuito que antes se evaporaba: el Andén detectaba el
 * faltante, lo pintaba, y al cerrar el vale no quedaba registro de que se reclamó, ni a
 * quién, ni si se resolvió.
 *
 * Superficie **Operations**: tabla densa + master-detail en `side-peek`, KPIs en
 * `MetricStrip` (ADR-033), cero hex crudo, `tabular-nums` en toda cifra, matriz de
 * estados vía `app-load-state` (vacío ≠ error de red) y estado de filtros en la URL.
 *
 * Dos responsables, una bandeja: al **proveedor** se le reclama y le pega en su fill
 * rate; a un **traspaso** se le reclama a la sucursal que embarcó y la merma es de la
 * casa. Lo que la pantalla NO hace es deducir cuál sucursal fue: muestra el nombre del
 * documento (un hecho) y pide que alguien capture el dueño (una decisión).
 */

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

@Component({
  selector: 'app-compras-reclamos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    SelectModule, InputTextModule, TextareaModule,
    MetricStripComponent, SidePeekComponent, LoadStateComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rc-page">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Reclamos de recepción</h1>
          <p class="surf-page-sub">
            Lo que faltó, llegó dañado o llegó equivocado en un vale ya cerrado. A un
            <strong>proveedor</strong> se le reclama y le pega en su fill rate; un
            <strong>traspaso</strong> se le reclama a la sucursal que embarcó y la merma es de la casa.
          </p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()"
                (click)="reload()" aria-label="Actualizar la bandeja">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
      </header>

      <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de reclamos abiertos"></app-metric-strip>

      @if (kpis()?.transfer_without_owner) {
        <div class="rc-note" role="status">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          <span>
            {{ kpis()!.transfer_without_owner | number }} reclamo(s) de traspaso sin dueño asignado.
            El código <code>TI###</code> del ERP no dice qué sucursal embarcó
            <span class="rc-none">(el mismo código aparece con nombres distintos)</span>, así que hay que capturarlo una vez.
            @if (pendingOrigins().length) {
              <button pButton type="button" class="p-button-sm p-button-text rc-note-btn" (click)="openFirstPending()">
                <span class="p-button-label">Capturar {{ pendingOrigins()[0].code }}</span>
              </button>
            }
          </span>
        </div>
      }

      <div class="rc-filters">
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="onFilter()" optionLabel="label"
                  optionValue="value" styleClass="rc-sel" appendTo="body" ariaLabel="Estado"></p-select>
        <p-select [options]="respOpts" [(ngModel)]="fResp" (onChange)="onFilter()" optionLabel="label"
                  optionValue="value" styleClass="rc-sel" appendTo="body" ariaLabel="Responsable"></p-select>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="onFilter()" optionLabel="label"
                  optionValue="value" styleClass="rc-sel" appendTo="body" ariaLabel="Tipo de reclamo"></p-select>
        @if (warehouseOpts().length > 1) {
          <p-select [options]="warehouseOpts()" [(ngModel)]="fWh" (onChange)="onFilter()" optionLabel="label"
                    optionValue="value" styleClass="rc-sel" appendTo="body" ariaLabel="Almacén que recibió"></p-select>
        }
        <span class="rc-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" [(ngModel)]="fSearch" (ngModelChange)="search$.next($event)"
                 placeholder="Vale, SKU, producto o responsable" aria-label="Buscar reclamos" />
        </span>
        @if (fSupplier) {
          <p-tag [value]="'Proveedor: ' + (supplierName() || 'seleccionado')" severity="info" styleClass="rc-chip"></p-tag>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="clearSupplier()"
                  aria-label="Quitar el filtro de proveedor">
            <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span>
            <span class="p-button-label">Quitar</span>
          </button>
        }
        <span class="rc-count">{{ total() | number }} reclamo(s)</span>
      </div>

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!rows().length" [skeletonRows]="8"
                      emptyIcon="pi-check-circle"
                      [emptyTitle]="filtered() ? 'Ningún reclamo con estos filtros' : 'Sin reclamos'"
                      [emptyHint]="filtered()
                        ? 'Probá con el estado en Todos, o limpiá la búsqueda.'
                        : 'Los reclamos se levantan solos al cerrar un vale con faltante, dañado o producto incorrecto en el Andén.'"
                      [emptyCta]="filtered() ? 'Limpiar filtros' : null"
                      emptyCtaIcon="pi pi-filter-slash"
                      (retry)="reload()" (cta)="clearFilters()">
        <p-table [value]="rows()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm rc-table"
                 [rowHover]="true" dataKey="id" [tableStyle]="{ 'min-width': '62rem' }">
          <ng-template #header>
            <tr>
              <th class="rc-sticky">Vale</th>
              <th class="rc-r" title="Días desde que se cerró el vale">Días</th>
              <th>Estado</th>
              <th>Tipo</th>
              <th>SKU</th>
              <th>Producto</th>
              <th class="rc-r">Esperado</th>
              <th class="rc-r">Llegó</th>
              <th class="rc-r">Reclamado</th>
              <th class="rc-r">Monto est.</th>
              <th>Responsable</th>
              <th>Recibió</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr class="rc-row" [class.rc-row-sel]="sel()?.id === c.id" (click)="openPeek(c)"
                tabindex="0" (keydown.enter)="openPeek(c)" [attr.aria-label]="'Reclamo del vale ' + c.folio">
              <td class="rc-sticky rc-mono">{{ c.folio }}</td>
              <td class="rc-r" [class.rc-warn]="c.age_days >= 7 && esAbierto(c)"
                  [class.rc-bad]="c.age_days >= 15 && esAbierto(c)">{{ c.age_days | number }}</td>
              <td><p-tag [value]="statusLabel(c.status)" [severity]="statusSev(c.status)"></p-tag></td>
              <td>
                <span class="rc-kind"><i [class]="'pi ' + kindIcon(c.kind)" aria-hidden="true"></i>{{ kindLabel(c.kind) }}</span>
              </td>
              <td class="rc-mono">{{ c.sku || '—' }}</td>
              <td class="rc-name">{{ c.product_name || '—' }}</td>
              <td class="rc-r rc-muted">{{ c.expected_qty | number:'1.0-2' }}</td>
              <td class="rc-r rc-muted">{{ c.received_qty | number:'1.0-2' }}</td>
              <td class="rc-r rc-strong">
                @if (c.qty_claimed === null) {
                  <span class="rc-todo" title="Falta capturar cuánto">capturar</span>
                } @else {
                  {{ c.qty_claimed | number:'1.0-2' }}<span class="rc-unit">{{ unidad(c) }}</span>
                }
              </td>
              <td class="rc-r">
                @if (c.amount === null) { <span class="rc-none" title="El documento no trae costo de ese renglón">sin costo</span> }
                @else { {{ money(c.amount) }} }
              </td>
              <td>
                <span class="rc-resp">
                  <p-tag [value]="c.responsible_kind === 'supplier' ? 'Proveedor' : 'Traspaso'"
                         [severity]="c.responsible_kind === 'supplier' ? 'info' : 'secondary'"></p-tag>
                  <span class="rc-resp-name">{{ c.supplier_name || c.responsible_label || c.responsible_code || '—' }}</span>
                </span>
              </td>
              <td class="rc-muted">{{ c.warehouse_code || '—' }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="rc-foot">
        El monto es una <strong>estimación para priorizar</strong>: sale de
        <code>importe ÷ cantidad</code> del renglón del documento, en <strong>la unidad del
        documento</strong> — no se convierte a cajas porque el factor de caja falta en 97 de
        cada 100 SKU. El reclamo <strong>no ajusta inventario ni dinero</strong>: lo que faltó
        nunca entró al stock, y la nota de crédito vive en el ERP.
      </p>

      <!-- Detalle + acciones -->
      <app-side-peek [open]="peek()" (openChange)="onPeekChange($event)" [width]="560"
                     [title]="sel() ? (sel()!.folio + ' · ' + kindLabel(sel()!.kind)) : ''"
                     [subtitle]="sel()?.product_name || sel()?.sku || null">
        @if (sel(); as c) {
          <div class="rc-peek">
            <section class="rc-blk">
              <h3>Qué pasó</h3>
              <dl class="rc-dl">
                <dt>Esperado</dt><dd class="rc-num">{{ c.expected_qty | number:'1.0-2' }}{{ unidad(c) }}</dd>
                <dt>Llegó</dt><dd class="rc-num">{{ c.received_qty | number:'1.0-2' }}{{ unidad(c) }}</dd>
                <dt>Reclamado</dt>
                <dd class="rc-num rc-strong">
                  @if (c.qty_claimed === null) { <span class="rc-todo">falta capturarlo</span> }
                  @else { {{ c.qty_claimed | number:'1.0-2' }}{{ unidad(c) }} }
                </dd>
                @if (c.notes) { <dt>Nota del andén</dt><dd>{{ c.notes }}</dd> }
                @if (c.source_ref) { <dt>Documento ERP</dt><dd class="rc-mono">{{ c.source_ref }}</dd> }
                <dt>Recibió</dt><dd>{{ c.warehouse_code }} <span class="rc-none">{{ c.warehouse_name }}</span></dd>
              </dl>

              @if (c.qty_claimed === null && esAbierto(c)) {
                <div class="rc-qty">
                  <p class="rc-hint">
                    Un <strong>{{ kindLabel(c.kind).toLowerCase() }}</strong> no trae cantidad desde el andén
                    (nadie iba a contar tarima dañada con el camión esperando). Capturala acá:
                  </p>
                  <div class="rc-qty-row">
                    <input pInputText type="number" min="0.01" [max]="maxQty(c)" step="1" [(ngModel)]="qtyInput"
                           class="rc-qty-in" [attr.aria-label]="'Cantidad reclamada en ' + (c.qty_unit || 'piezas')" />
                    <span class="rc-none">{{ c.qty_unit || 'piezas' }}</span>
                    <button pButton type="button" class="p-button-sm" [disabled]="busy() || !qtyInput"
                            (click)="saveQty(c)"><span class="p-button-label">Guardar cantidad</span></button>
                  </div>
                </div>
              }
            </section>

            <section class="rc-blk">
              <h3>A quién se le reclama</h3>
              @if (c.responsible_kind === 'supplier') {
                <dl class="rc-dl">
                  <dt>Proveedor</dt><dd>{{ c.supplier_name || c.responsible_label || '—' }}</dd>
                  <dt>Código</dt><dd class="rc-mono">{{ c.responsible_code || '—' }}</dd>
                </dl>
                <p class="rc-hint">
                  @if (c.status === 'discarded') { Descartado: este reclamo <strong>no</strong> cuenta en su fill rate. }
                  @else { Mientras el reclamo no se descarte, cuenta en su <strong>fill rate</strong> y por lo tanto en el sugerido de compra. }
                </p>
              } @else {
                <dl class="rc-dl">
                  <dt>Documento dice</dt><dd>{{ c.responsible_label || '—' }}</dd>
                  <dt>Código</dt><dd class="rc-mono">{{ c.responsible_code || '—' }}</dd>
                  <dt>Sucursal que embarcó</dt>
                  <dd>
                    @if (c.responsible_warehouse_id) { {{ c.responsible_warehouse_code }} <span class="rc-none">{{ c.responsible_warehouse_name }}</span> }
                    @else { <span class="rc-todo">sin asignar</span> }
                  </dd>
                </dl>
                @if (!c.responsible_warehouse_id) {
                  <p class="rc-hint">
                    El nombre de arriba es <strong>el que trae el documento</strong>, no una sucursal deducida: el
                    mismo código del ERP aparece con nombres distintos, así que traducirlo sería inventarlo.
                    @if (canMapOrigin()) { Elegí una vez a quién pertenece <code>{{ c.responsible_code }}</code> y se asignan todos sus reclamos. }
                    @else { Quien administra almacenes tiene que capturar a quién pertenece <code>{{ c.responsible_code }}</code>. }
                  </p>
                  @if (canMapOrigin()) {
                    @if (whError()) {
                      <p class="rc-err" role="alert">No se pudo cargar la lista de almacenes ({{ whError() }}).
                        <button pButton type="button" class="p-button-sm p-button-text" (click)="loadWarehouses()"><span class="p-button-label">Reintentar</span></button>
                      </p>
                    } @else {
                      <div class="rc-map">
                        <p-select [options]="whOpts()" [(ngModel)]="originWh" optionLabel="label" optionValue="value"
                                  placeholder="Almacén que embarcó" appendTo="body" styleClass="rc-sel"
                                  ariaLabel="Almacén que embarcó el traspaso"></p-select>
                        <button pButton type="button" class="p-button-sm" [disabled]="busy() || !originWh"
                                (click)="saveOrigin(c)"><span class="p-button-label">Asignar dueño</span></button>
                      </div>
                    }
                  }
                }
                <p class="rc-hint rc-none">Un traspaso no le pega a ningún proveedor: la merma es de la casa.</p>
              }
            </section>

            <section class="rc-blk">
              <h3>Cuánto</h3>
              @if (c.amount === null) {
                <p class="rc-hint">
                  <strong>Sin monto.</strong> El renglón no tiene costo en el documento del ERP
                  {{ c.qty_claimed === null ? '(y todavía falta la cantidad)' : '' }} — se deja
                  vacío a propósito: un <code>$0</code> se leería como “no cuesta nada”.
                </p>
              } @else {
                <dl class="rc-dl">
                  <dt>Costo unitario</dt><dd class="rc-num">{{ money(c.unit_cost) }} / {{ c.qty_unit || 'pz' }}</dd>
                  <dt>Estimado</dt><dd class="rc-num rc-strong">{{ money(c.amount) }}</dd>
                </dl>
                @if (c.qty_unit === 'ambigua') {
                  <p class="rc-hint rc-warn-txt">El documento trae más de una unidad para este SKU: el monto es orientativo.</p>
                }
              }
            </section>

            <section class="rc-blk">
              <h3>Seguimiento</h3>
              <ol class="rc-tl">
                <li><span class="rc-tl-d">{{ c.opened_at | date:'dd/MM/yy HH:mm' }}</span> Levantado al cerrar el vale</li>
                @if (c.claimed_at) {
                  <li><span class="rc-tl-d">{{ c.claimed_at | date:'dd/MM/yy HH:mm' }}</span>
                    Reclamado por {{ c.claimed_by_username }}@if (c.claim_channel) { <span class="rc-none"> · {{ c.claim_channel }}</span> }</li>
                }
                @if (c.resolved_at) {
                  <li><span class="rc-tl-d">{{ c.resolved_at | date:'dd/MM/yy HH:mm' }}</span>
                    {{ statusLabel(c.status) }} por {{ c.resolved_by_username }}
                    @if (c.resolution_note) { <p class="rc-tl-note">“{{ c.resolution_note }}”</p> }</li>
                }
              </ol>

              @if (esAbierto(c) && canManage()) {
                <div class="rc-acts">
                  @if (c.status === 'open') {
                    <div class="rc-act-row">
                      <p-select [options]="channelOpts" [(ngModel)]="channel" optionLabel="label" optionValue="value"
                                placeholder="Cómo se avisó" appendTo="body" styleClass="rc-sel"
                                ariaLabel="Canal del reclamo"></p-select>
                      <button pButton type="button" class="p-button-sm" [disabled]="busy()" (click)="act(c, 'claim')">
                        <span class="p-button-icon p-button-icon-left pi pi-send" aria-hidden="true"></span>
                        <span class="p-button-label">Reclamado</span>
                      </button>
                    </div>
                  }
                  <textarea pTextarea [(ngModel)]="note" rows="2" class="rc-note-in"
                            placeholder="Qué dijo el responsable (obligatorio para descartar)"
                            aria-label="Nota de resolución"></textarea>
                  <div class="rc-act-row">
                    <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="busy()"
                            (click)="act(c, 'accepted')" title="El responsable reconoció el faltante">
                      <span class="p-button-label">Lo reconoció</span>
                    </button>
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" [disabled]="busy()"
                            (click)="act(c, 'written_off')" title="Se da por perdido: sigue contando en su cumplimiento">
                      <span class="p-button-label">No se recupera</span>
                    </button>
                    <button pButton type="button" class="p-button-sm p-button-text p-button-danger" [disabled]="busy()"
                            (click)="act(c, 'discarded')" title="Era error nuestro de conteo: deja de penalizar al responsable">
                      <span class="p-button-label">Era error de conteo</span>
                    </button>
                  </div>
                </div>
              }
            </section>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    /* Tokens: SOLO los que el bloque dark redefine (--text-main/-muted, --border-color,
       --card-bg, --ink-rgb, --bad-fg/--warn-fg/--ok-fg, --action). Los alias del shim
       (--border, --divider, --surface-card, --c-text-*) están declarados en :root y el
       tema oscuro vive en body.theme-monochrome, así que se congelan en su valor CLARO
       y pintan blanco/negro en dark. Medido en runtime, ver docs/GOTCHAS.md. */
    :host { display: block; }
    .rc-note {
      display: flex; gap: .6rem; align-items: flex-start; margin: .35rem 0 .75rem;
      padding: .6rem .8rem; font-size: .82rem; line-height: 1.45;
      border: 1px solid var(--border-color); border-radius: var(--radius-md, 8px);
      background: rgba(var(--ink-rgb), .025); color: var(--text-main);
    }
    .rc-note .pi { color: var(--text-muted); margin-top: .15rem; }
    .rc-note-btn { margin-left: .35rem; }
    .rc-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .5rem 0 .6rem; }
    .rc-sel { min-width: 11rem; }
    .rc-search { position: relative; display: inline-flex; align-items: center; }
    .rc-search .pi { position: absolute; left: .55rem; color: var(--text-muted); font-size: .8rem; }
    .rc-search input { padding-left: 1.9rem; min-width: 16rem; }
    .rc-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; font-variant-numeric: tabular-nums; }
    .rc-chip { font-size: .74rem; }

    .rc-table { font-size: .82rem; }
    .rc-row { cursor: pointer; }
    .rc-row:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .rc-row-sel > td { background: rgba(var(--ink-rgb), .04); }
    .rc-sticky { position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
    .rc-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rc-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; font-variant-numeric: tabular-nums; }
    .rc-name { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rc-muted, .rc-none { color: var(--text-muted); }
    .rc-none { font-weight: 400; }
    .rc-strong { font-weight: 700; }
    .rc-warn { color: var(--warn-fg); font-weight: 600; }
    .rc-bad { color: var(--bad-fg); font-weight: 700; }
    .rc-warn-txt { color: var(--warn-fg); }
    .rc-todo { color: var(--warn-fg); font-weight: 600; }
    .rc-unit { color: var(--text-muted); font-weight: 400; font-size: .72rem; margin-left: .15rem; }
    .rc-kind { display: inline-flex; gap: .3rem; align-items: center; white-space: nowrap; }
    .rc-kind .pi { font-size: .72rem; color: var(--text-muted); }
    .rc-resp { display: inline-flex; gap: .4rem; align-items: center; }
    .rc-resp-name { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rc-foot { margin: .8rem 0 0; font-size: .76rem; line-height: 1.5; color: var(--text-muted); max-width: 62rem; }
    .rc-foot code, .rc-note code, .rc-hint code { font-family: var(--font-mono, ui-monospace, monospace); font-size: .72rem; }

    .rc-peek { display: flex; flex-direction: column; gap: 1.1rem; }
    .rc-blk h3 { margin: 0 0 .5rem; font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); font-weight: 700; }
    .rc-dl { display: grid; grid-template-columns: 9.5rem 1fr; gap: .3rem .75rem; margin: 0; font-size: .84rem; }
    .rc-dl dt { color: var(--text-muted); }
    .rc-dl dd { margin: 0; }
    .rc-num { font-variant-numeric: tabular-nums; font-family: var(--font-mono, ui-monospace, monospace); font-size: .82rem; }
    .rc-hint { margin: .55rem 0 0; font-size: .79rem; line-height: 1.5; color: var(--text-main); }
    .rc-err { margin: .5rem 0 0; font-size: .79rem; color: var(--bad-fg); }
    .rc-qty, .rc-map, .rc-acts { margin-top: .6rem; display: flex; flex-direction: column; gap: .45rem; }
    .rc-map, .rc-qty-row, .rc-act-row { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; }
    .rc-qty-in { width: 7rem; text-align: right; font-variant-numeric: tabular-nums; }
    .rc-note-in { width: 100%; font-size: .82rem; }
    .rc-tl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; font-size: .82rem; }
    .rc-tl li { padding-left: .75rem; border-left: 2px solid var(--border-color); }
    .rc-tl-d { color: var(--text-muted); font-variant-numeric: tabular-nums; margin-right: .4rem; font-size: .76rem; }
    .rc-tl-note { margin: .2rem 0 0; color: var(--text-muted); font-style: italic; }

    @media (max-width: 48rem) {
      .rc-filters { gap: .4rem; }
      .rc-sel, .rc-search input { min-width: 100%; }
      .rc-count { margin-left: 0; }
      .rc-dl { grid-template-columns: 1fr; gap: .1rem; }
      .rc-dl dd { margin-bottom: .35rem; }
    }
    @media (pointer: coarse) {
      .rc-row > td { min-height: var(--tap-min, 44px); }
    }
  `],
})
export class ComprasReclamosComponent implements OnInit {
  private readonly api = inject(ReceivingClaimsService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionsService);

  rows = signal<ReceivingClaim[]>([]);
  total = signal(0);
  kpis = signal<ReceivingClaimKpis | null>(null);
  pendingOrigins = signal<TransferOriginPending[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);
  busy = signal(false);
  peek = signal(false);
  sel = signal<ReceivingClaim | null>(null);
  whOpts = signal<Array<{ label: string; value: string }>>([]);
  whError = signal<string | null>(null);

  fStatus = 'abiertos';
  fResp = '';
  fKind = '';
  fWh = '';
  fSearch = '';
  /** Llega desde /compras/proveedores ("ver los reclamos de este proveedor"). */
  fSupplier = '';
  qtyInput: number | null = null;
  note = '';
  channel = '';
  originWh: string | null = null;

  readonly search$ = new Subject<string>();

  statusOpts = [
    { label: 'Abiertos', value: 'abiertos' },
    { label: 'Todos', value: '' },
    { label: 'Sin reclamar', value: 'open' },
    { label: 'Reclamados', value: 'claimed' },
    { label: 'Reconocidos', value: 'accepted' },
    { label: 'No recuperados', value: 'written_off' },
    { label: 'Error de conteo', value: 'discarded' },
  ];
  respOpts = [
    { label: 'Todo responsable', value: '' },
    { label: 'Proveedor', value: 'supplier' },
    { label: 'Traspaso', value: 'branch' },
  ];
  kindOpts = [
    { label: 'Todo tipo', value: '' },
    { label: 'Faltante', value: 'faltante' },
    { label: 'Dañado', value: 'dañado' },
    { label: 'Producto incorrecto', value: 'producto_incorrecto' },
  ];
  channelOpts = [
    { label: 'WhatsApp', value: 'whatsapp' },
    { label: 'Teléfono', value: 'telefono' },
    { label: 'Correo', value: 'correo' },
    { label: 'En persona', value: 'en_persona' },
  ];

  /** Almacenes que ya aparecen en la bandeja: filtro sin lookup extra (ni permiso extra). */
  warehouseOpts = computed(() => {
    const seen = new Map<string, string>();
    for (const r of this.rows()) if (r.warehouse_code) seen.set(r.warehouse_code, r.warehouse_name || r.warehouse_code);
    return [{ label: 'Todos los almacenes', value: '' },
      ...Array.from(seen.entries()).map(([code, name]) => ({ label: `${code} · ${name}`, value: code }))];
  });

  filtered = computed(() => !!(this.fResp || this.fKind || this.fWh || this.fSearch || this.fSupplier || this.fStatus !== 'abiertos'));

  kpiItems = computed<MetricStripItem[]>(() => {
    const k = this.kpis();
    return [
      { label: 'Reclamos abiertos', value: k?.open_count ?? 0, format: 'number', tone: (k?.open_count ?? 0) > 0 ? 'warn' : 'ok' },
      {
        label: 'Monto reclamado', value: k?.open_amount ?? 0, format: 'currency-short',
        tone: (k?.open_amount ?? 0) > 0 ? 'bad' : 'default',
        sub: k?.open_without_amount ? `${k.open_without_amount} sin costo del documento` : undefined,
      },
      {
        label: 'El más viejo', value: k?.oldest_days ?? 0, format: 'number', sub: 'días sin cerrar',
        tone: (k?.oldest_days ?? 0) >= 15 ? 'bad' : (k?.oldest_days ?? 0) >= 7 ? 'warn' : 'default',
      },
      { label: 'Proveedores', value: k?.suppliers_open ?? 0, format: 'number', sub: 'con reclamo abierto' },
      {
        label: 'Traspasos', value: k?.transfer_open ?? 0, format: 'number',
        sub: k?.transfer_without_owner ? `${k.transfer_without_owner} sin dueño` : 'merma de la casa',
        tone: k?.transfer_without_owner ? 'warn' : 'default',
      },
    ];
  });

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    this.fStatus = q.get('status') ?? 'abiertos';
    this.fResp = q.get('responsible_kind') ?? '';
    this.fKind = q.get('kind') ?? '';
    this.fWh = q.get('wh') ?? '';
    this.fSearch = q.get('search') ?? '';
    this.fSupplier = q.get('supplier_id') ?? '';
    this.search$.pipe(debounceTime(280), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.onFilter());
    this.reload();
    if (this.canMapOrigin()) this.loadWarehouses();
  }

  // `has()` ya pasa a los roles de plataforma (isAdmin): sin eso un admin pierde el
  // botón, porque su JSONB no enumera las claves nuevas (GOTCHAS §4).
  canManage(): boolean { return this.perms.has(Permission.COMPRAS_HALLAZGOS_GESTIONAR); }
  canMapOrigin(): boolean { return this.perms.has(Permission.COMMERCIAL_WAREHOUSES_GESTIONAR); }

  loadWarehouses(): void {
    this.whError.set(null);
    this.comercial.listWarehouses(true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws) => this.whOpts.set((ws || []).map((w: any) => ({ label: `${w.code} · ${w.name}`, value: w.id }))),
      // Nunca tragar el error: "sin almacenes" y "sin permiso" no son lo mismo (GOTCHAS §4).
      error: (e) => this.whError.set(e?.status === 403 ? 'sin permiso' : (e?.error?.message || 'error de red')),
    });
  }

  onFilter(): void {
    this.router.navigate([], {
      relativeTo: this.route, replaceUrl: true,
      queryParams: {
        status: this.fStatus || null, responsible_kind: this.fResp || null,
        kind: this.fKind || null, wh: this.fWh || null, search: this.fSearch || null,
        supplier_id: this.fSupplier || null,
      },
      queryParamsHandling: 'merge',
    });
    this.reload();
  }

  clearFilters(): void {
    this.fStatus = 'abiertos'; this.fResp = ''; this.fKind = ''; this.fWh = ''; this.fSearch = ''; this.fSupplier = '';
    this.onFilter();
  }
  clearSupplier(): void { this.fSupplier = ''; this.onFilter(); }

  /** Nombre del proveedor filtrado, tomado de las propias filas (sin lookup extra). */
  supplierName = computed(() => this.rows().find((r) => r.supplier_id === this.fSupplier)?.supplier_name || null);

  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list({
      status: this.fStatus || undefined,
      responsible_kind: (this.fResp || undefined) as any,
      kind: (this.fKind || undefined) as any,
      search: this.fSearch || undefined,
      supplier_id: this.fSupplier || undefined,
      pageSize: 200,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        // El filtro por almacén se aplica sobre lo devuelto (sale de las propias filas).
        const data = this.fWh ? r.data.filter((c) => c.warehouse_code === this.fWh) : r.data;
        this.rows.set(data);
        this.total.set(this.fWh ? data.length : r.total);
        this.kpis.set(r.kpis);
        this.loading.set(false);
        if (r.kpis?.transfer_without_owner) this.loadPending();
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(e?.status === 403 ? 'No tenés permiso para ver la bandeja de reclamos.' : (e?.error?.message || 'Error de red'));
      },
    });
  }

  private loadPending(): void {
    this.api.transferOrigins().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.pendingOrigins.set(r.pending || []), error: () => this.pendingOrigins.set([]) });
  }

  openFirstPending(): void {
    const code = this.pendingOrigins()[0]?.code;
    const row = this.rows().find((c) => c.responsible_code === code && !c.responsible_warehouse_id);
    if (row) this.openPeek(row);
  }

  openPeek(c: ReceivingClaim): void {
    this.sel.set(c);
    this.qtyInput = c.qty_claimed;
    this.note = '';
    this.channel = '';
    this.originWh = null;
    this.peek.set(true);
  }
  onPeekChange(open: boolean): void {
    this.peek.set(open);
    if (!open) this.sel.set(null);
  }

  esAbierto(c: ReceivingClaim): boolean { return c.status === 'open' || c.status === 'claimed'; }
  maxQty(c: ReceivingClaim): number { return Math.max(c.expected_qty, c.received_qty) || 999999; }
  unidad(c: ReceivingClaim): string {
    return c.qty_unit && c.qty_unit !== 'ambigua' ? ` ${c.qty_unit}` : '';
  }

  saveQty(c: ReceivingClaim): void {
    const q = Number(this.qtyInput);
    if (!(q > 0)) return;
    this.busy.set(true);
    this.api.setQty(c.id, q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => { this.busy.set(false); this.applyUpdate(upd); this.toast.add({ severity: 'success', summary: 'Cantidad capturada', detail: `Se reclaman ${q}${this.unidad(upd)}.` }); },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Error' }); },
    });
  }

  saveOrigin(c: ReceivingClaim): void {
    if (!this.originWh || !c.responsible_code) return;
    this.busy.set(true);
    this.api.setTransferOrigin(c.responsible_code, this.originWh, this.note || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.busy.set(false);
          this.toast.add({
            severity: 'success', summary: 'Dueño asignado',
            detail: `${r.claims_reassigned} reclamo(s) de ${r.code} quedaron con responsable.`,
          });
          this.peek.set(false); this.sel.set(null); this.reload();
        },
        error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo asignar', detail: e?.error?.message || 'Error' }); },
      });
  }

  act(c: ReceivingClaim, action: 'claim' | 'accepted' | 'discarded' | 'written_off'): void {
    if (action === 'discarded' && !this.note.trim()) {
      this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'Para descartar hay que decir por qué era error de conteo: es lo único que saca al responsable de su cumplimiento.' });
      return;
    }
    this.busy.set(true);
    const call = action === 'claim'
      ? this.api.markClaimed(c.id, { channel: this.channel || undefined, note: this.note || undefined })
      : this.api.resolve(c.id, { resolution: action, note: this.note || undefined });
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => {
        this.busy.set(false);
        this.applyUpdate(upd);
        this.toast.add({ severity: 'success', summary: this.statusLabel(upd.status), detail: `Vale ${upd.folio}.` });
        if (!this.esAbierto(upd)) { this.peek.set(false); this.sel.set(null); }
        this.reload();
      },
      error: (e) => { this.busy.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo actualizar', detail: e?.error?.message || 'Error' }); },
    });
  }

  /** Optimista local: la fila y el panel reflejan el cambio sin esperar el reload. */
  private applyUpdate(upd: ReceivingClaim): void {
    this.rows.update((rs) => rs.map((r) => (r.id === upd.id ? { ...r, ...upd } : r)));
    if (this.sel()?.id === upd.id) this.sel.set({ ...this.sel()!, ...upd });
  }

  statusLabel(s: string): string {
    return ({ open: 'Sin reclamar', claimed: 'Reclamado', accepted: 'Lo reconoció', discarded: 'Error de conteo', written_off: 'No se recupera' } as Record<string, string>)[s] || s;
  }
  statusSev(s: string): Sev {
    return ({ open: 'warn', claimed: 'info', accepted: 'success', discarded: 'secondary', written_off: 'danger' } as Record<string, Sev>)[s] || 'secondary';
  }
  kindLabel(k: string): string {
    return ({ faltante: 'Faltante', 'dañado': 'Dañado', producto_incorrecto: 'Producto incorrecto' } as Record<string, string>)[k] || k;
  }
  kindIcon(k: string): string {
    return ({ faltante: 'pi-minus-circle', 'dañado': 'pi-exclamation-triangle', producto_incorrecto: 'pi-replay' } as Record<string, string>)[k] || 'pi-circle';
  }
  /** GOTCHAS §6 — los numeric llegan como string: coercionar antes de formatear. */
  money(v: unknown): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }
}
