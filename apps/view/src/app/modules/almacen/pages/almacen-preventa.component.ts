import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { DrawerModule } from 'primeng/drawer';
import type {
  PresaleCandidate,
  PresaleCandidatesResponse,
  PresaleDetail,
  PresaleLineCompare,
  PresaleLinkBlock,
  PresaleListResponse,
  PresaleOrderRow,
  PresaleStage,
} from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { coincideBusqueda } from '@megadulces/ui-web';
import { money } from '../../../shared/util/money.util';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AlmacenPreventaService } from '../almacen-preventa.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

/** Etapas en el orden en que avanza el pedido; el color dice si espera algo de la sucursal. */
const ETAPAS: { key: PresaleStage; label: string; sev: Sev }[] = [
  { key: 'esperando_alta', label: 'Esperando alta', sev: 'warn' },
  { key: 'por_surtir', label: 'Por surtir', sev: 'secondary' },
  { key: 'en_surtido', label: 'En surtido', sev: 'info' },
  { key: 'en_caja', label: 'En caja', sev: 'info' },
  { key: 'cobrado', label: 'Cobrado', sev: 'info' },
  { key: 'en_ruta', label: 'En ruta', sev: 'info' },
  { key: 'entregado', label: 'Entregado', sev: 'success' },
  { key: 'cancelado', label: 'Cancelado', sev: 'secondary' },
];
const ETAPA = new Map(ETAPAS.map((e) => [e.key, e]));

/** Por qué no se pueden buscar documentos de Kepler, en palabras de la sucursal. */
const BLOQUEO: Record<PresaleLinkBlock, { corto: string; largo: string }> = {
  cliente_sin_clave: {
    corto: 'Cliente sin alta en Kepler',
    largo: 'El cliente no existe en Kepler (lo dio de alta el vendedor en campo). La caja no le puede emitir documento hasta que se dé de alta.',
  },
  cliente_de_otra_sucursal: {
    corto: 'Cliente de otra sucursal',
    largo: 'La clave del cliente en Kepler es de otra sucursal. Las claves son por sucursal: buscar con ella mostraría los tickets de otra persona.',
  },
  sucursal_sin_documentos: {
    corto: 'Sucursal sin tickets de Kepler',
    largo: 'Esta sucursal no publica tickets de Kepler (por ejemplo Morelia Madero, que corre Wincaja). Todavía no se puede ligar su cobro.',
  },
};

const MATCH: Record<PresaleLineCompare['match'], { label: string; mal: boolean }> = {
  igual: { label: 'Igual', mal: false },
  cantidad: { label: 'Cantidad distinta', mal: true },
  precio: { label: 'Precio distinto', mal: true },
  cantidad_y_precio: { label: 'Cantidad y precio', mal: true },
  solo_pedido: { label: 'No se cobró', mal: true },
  solo_documento: { label: 'No estaba en el pedido', mal: true },
};

const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return d + '/' + m + '/' + y;
};

/**
 * `[MCP.2]` Mesa de Control de Preventa (Fase MCP, ADR-089).
 *
 * Los pedidos que levantan los vendedores en vendedor.megadulcessuite.com, para el encargado de
 * cada sucursal: en qué etapa va cada uno contra la fecha que se le prometió al cliente, y con qué
 * documento de Kepler se cobró. La sucursal sólo ve la suya (alcance del servidor).
 *
 * Lo que la mesa hace aquí (MCP.4): ligar el documento de Kepler cuando la Suite no puede elegirlo
 * sola (sobre todo los pedidos de antes de la mesa) y corregir una liga equivocada con motivo.
 * Lo normal será que la liga la haga el repartidor al entregar (MCP.6).
 */
@Component({
  selector: 'app-almacen-preventa',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, InputTextModule, TagModule, DrawerModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head mc-head">
        <div class="mc-head-text">
          <h1>Preventa</h1>
          @if (data(); as d) {
            <span class="mc-meta">Pedidos de los vendedores · hoy {{ dmy(d.today) }} · consultado a las {{ hora(cargado()) }}</span>
          }
        </div>
        <div class="mc-actions">
          <div class="mc-seg" role="group" aria-label="Cerrados que se muestran">
            @for (c of cerradosOpts; track c.dias) {
              <button type="button" class="mc-seg-b" [class.on]="cerrados() === c.dias" [attr.aria-pressed]="cerrados() === c.dias" (click)="pickCerrados(c.dias)">{{ c.label }}</button>
            }
          </div>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="mc-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="mc-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="mc-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="mc-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (d.scope === 'ninguno') {
          <div class="mc-note mc-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay pedidos que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
        }
        @if (vencidos() > 0) {
          <div class="mc-note mc-note-warn" role="note"><i class="pi pi-clock" aria-hidden="true"></i><span><b class="num">{{ vencidos() }}</b> {{ vencidos() === 1 ? 'pedido ya pasó' : 'pedidos ya pasaron' }} su fecha de entrega sin entregarse. Si ya se cobraron en Kepler, liga su documento.</span></div>
        }

        <section class="mc-block dt-scope" aria-labelledby="mc-h-lista">
          <div class="mc-bh">
            <h2 id="mc-h-lista" class="sr-only">Pedidos de preventa</h2>
            <div class="mc-chips" role="group" aria-label="Etapa">
              <button type="button" class="mc-chip" [class.on]="!etapa() && !soloVencidos()" [attr.aria-pressed]="!etapa() && !soloVencidos()" (click)="pickEtapa(null)">Todos <span class="num">{{ base().length }}</span></button>
              <button type="button" class="mc-chip mc-chip-bad" [class.on]="soloVencidos()" [attr.aria-pressed]="soloVencidos()" (click)="toggleVencidos()">Vencidos <span class="num">{{ vencidos() }}</span></button>
              @for (e of etapas; track e.key) {
                @if (conteo()[e.key]) {
                  <button type="button" class="mc-chip" [class.on]="etapa() === e.key" [attr.aria-pressed]="etapa() === e.key" (click)="pickEtapa(e.key)">{{ e.label }} <span class="num">{{ conteo()[e.key] }}</span></button>
                }
              }
            </div>
            <div class="mc-filters">
              @if (sucursalOpts().length > 2) {
                <p-select [options]="sucursalOpts()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (onChange)="sucursal.set($event.value)" ariaLabel="Sucursal" appendTo="body" class="mc-sel" />
              }
              <input pInputText type="search" class="mc-q" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Folio, cliente, vendedor o ruta" aria-label="Buscar folio, cliente, vendedor o ruta" />
            </div>
          </div>
          @if (d.truncated) { <p class="mc-hint mc-pad">Se muestran los primeros {{ d.count }} pedidos: hay más. Reduce los cerrados que se muestran.</p> }
          <p-table [value]="filas()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="calc(100vh - 25rem)" selectionMode="single" [selection]="sel()" (selectionChange)="pick($event)" dataKey="id">
            <ng-template #header>
              <tr>
                <th>Pedido</th>@if (multiSucursal()) { <th>Suc</th> }<th>Cliente</th><th>Etapa</th>
                <th title="Fecha de entrega que se le prometió al cliente">Entrega</th>
                <th title="Documento de Kepler con que se cobró">Documento Kepler</th>
                <th class="ta-r">Total pedido</th><th class="ta-r" title="Total del documento de Kepler ligado">Cobrado</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr [pSelectableRow]="r">
                <td role="cell" data-label="Pedido"><span class="mono">{{ r.code }}</span><span class="muted mc-sub">{{ r.seller_name || '—' }}</span></td>
                @if (multiSucursal()) { <td class="mono muted" role="cell" data-label="Suc">{{ r.branch || '—' }}</td> }
                <td role="cell" data-label="Cliente"><span class="mc-trunc">{{ r.customer_name || '—' }}</span><span class="muted mc-sub">{{ r.sales_route || 'sin ruta' }}@if (r.customer_erp_code) { · <span class="mono">{{ r.customer_erp_code }}</span> }</span></td>
                <td role="cell" data-label="Etapa"><p-tag [value]="etapaLabel(r.stage)" [severity]="etapaSev(r.stage)" class="mc-tag" />@if (r.load_guide; as g) { <span class="muted mc-sub">{{ g.status === 'impresa' ? 'Lleva' : 'Pescado por' }} {{ g.rider_name || '—' }} · <span class="mono">{{ g.folio }}</span></span> }</td>
                <td role="cell" data-label="Entrega"><span class="mono">{{ dm(r.requested_delivery_date) }}</span><span class="mc-sub" [class.mc-bad]="r.due === 'vencido'" [class.mc-warn]="r.due === 'hoy'" [class.muted]="r.due !== 'vencido' && r.due !== 'hoy'">{{ dueTexto(r) }}</span></td>
                <td role="cell" data-label="Documento Kepler">
                  @if (r.link) { <span class="mono">{{ r.link.folio_digital }}</span><span class="muted mc-sub">{{ r.link.link_source === 'celular' ? 'lo ligó quien entregó' : 'ligado en la mesa' }}</span> }
                  @else if (r.link_block) { <span class="muted">{{ bloqueoCorto(r.link_block) }}</span> }
                  @else if (r.possible_documents) { <span class="mc-warn">{{ r.possible_documents }} {{ r.possible_documents === 1 ? 'posible' : 'posibles' }}</span><span class="muted mc-sub">elige cuál es</span> }
                  @else if (r.possible_documents === 0) { <span class="muted">Sin documento en Kepler</span> }
                  @else { <span class="muted">—</span> }
                </td>
                <td class="ta-r num" role="cell" data-label="Total pedido">{{ money(r.total) }}</td>
                <td class="ta-r num" role="cell" data-label="Cobrado">
                  @if (r.link && r.link.total !== null) { {{ money(r.link.total) }}@if (dif(r); as x) { <span class="mc-sub mc-bad">{{ x }}</span> } }
                  @else { <span class="muted">—</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="multiSucursal() ? 8 : 7"><div class="mc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>{{ base().length ? 'Ningún pedido con estos filtros.' : 'No hay pedidos de preventa abiertos.' }}</span>@if (hayFiltros()) { <button type="button" class="mc-link" (click)="limpiar()">Quitar filtros</button> }</div></td></tr>
            </ng-template>
          </p-table>
          <div class="mc-foot" aria-label="Totales de lo filtrado">
            <span><b class="num">{{ filas().length }}</b> pedidos</span>
            <span><b class="num">{{ money(totalPedido()) }}</b> pedido</span>
            <span><b class="num">{{ money(totalCobrado()) }}</b> cobrado en Kepler@if (sinTotal()) { <span class="mc-warn"> · {{ sinTotal() }} sin total en Kepler</span> }</span>
          </div>
        </section>

        <p-drawer [visible]="!!sel()" (visibleChange)="!$event && pick(null)" position="right" styleClass="mc-drawer"
                  [style]="{ width: 'min(600px, 100vw)' }" [header]="sel()?.code || 'Pedido'">
          <section class="mc-detail" aria-labelledby="mc-h-det">
            <h2 id="mc-h-det" class="sr-only">Detalle del pedido {{ sel()?.code }}</h2>
            @if (detLoading()) {
              <div class="mc-skeleton mc-pad" aria-busy="true">@for (i of skelDet; track i) { <div class="mc-skel-row"></div> }</div>
            } @else if (det(); as x) {
              <div class="mc-det-head">
                <p-tag [value]="etapaLabel(x.order.stage)" [severity]="etapaSev(x.order.stage)" class="mc-tag" />
                <span [class.mc-bad]="x.order.due === 'vencido'" [class.muted]="x.order.due !== 'vencido'">Entrega {{ dmy(x.order.requested_delivery_date) }} · {{ dueTexto(x.order) }}</span>
              </div>
              <div class="mc-step">
                <div class="mc-row"><span>Cliente</span><span>{{ x.order.customer_name || '—' }}@if (x.order.customer_erp_code) { <span class="muted mono"> · {{ x.order.customer_erp_code }}</span> }</span></div>
                <div class="mc-row"><span>Vendedor · ruta</span><span>{{ x.order.seller_name || '—' }} · {{ x.order.sales_route || 'sin ruta' }}</span></div>
                <div class="mc-row"><span>Sucursal</span><span>{{ x.order.branch || '' }} {{ x.order.warehouse_name || '—' }}</span></div>
                <div class="mc-row"><span>Pedido</span><span class="num">{{ x.order.lines }} renglones · {{ money(x.order.total) }}</span></div>
                @if (x.order.load_guide; as g) { <div class="mc-row"><span>Guía de carga</span><span><span class="mono">{{ g.folio }}</span> · {{ g.rider_name || '—' }} · {{ g.status === 'impresa' ? 'impresa' : 'sin imprimir' }}</span></div> }
                @if (x.order.delivery; as e) {
                  <div class="mc-row"><span>Entrega</span><span>{{ e.outcome === 'con_diferencia' ? 'Con diferencia' : 'Completa' }} · {{ fechaHora(e.delivered_at) }}@if (e.delivered_by_name) { · {{ e.delivered_by_name }} } · <span class="mono">{{ e.guide_folio }}</span>@if (e.note) { <span class="muted mc-sub">{{ e.note }}</span> }</span></div>
                  <div class="mc-row"><span>Cobró</span><span class="num"><span class="mono">{{ e.folio_digital }}</span> · {{ money(e.cash_amount) }} efectivo · {{ money(e.transfer_amount) }} transferencia@if (e.transfer_ref) { <span class="muted mono"> · ref. {{ e.transfer_ref }}</span> }</span></div>
                }
              </div>

              <div class="mc-step">
                <h3>Documento de Kepler</h3>
                @if (x.order.link; as l) {
                  <div class="mc-doc mc-doc-on">
                    <div><span class="mono">{{ l.folio_digital }}</span><span class="muted mc-sub">Caja {{ l.caja ?? '—' }} · {{ dmy(l.fecha) }} · {{ l.link_source === 'celular' ? 'lo ligó quien entregó' : 'ligado en la mesa' }}@if (l.linked_by_name) { por {{ l.linked_by_name }} }</span></div>
                    <b class="num">{{ l.total === null ? '—' : money(l.total) }}</b>
                  </div>
                  @if (puedeLigar() && (x.order.status === 'confirmed' || x.order.status === 'cancelled')) {
                    @if (!desligando()) {
                      <button type="button" class="mc-link mc-mt" (click)="abrirCorregir()">Este no es el documento: corregir</button>
                    } @else {
                      <div class="mc-form">
                        <label for="mc-motivo">¿Por qué no es este documento?</label>
                        <input pInputText id="mc-motivo" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Ej. era el ticket de otra compra del cliente" />
                        <div class="mc-form-acts">
                          <button pButton type="button" class="p-button-sm" [disabled]="motivo().trim().length < 5" [loading]="guardando()" (click)="desligar(x.order.id)"><span class="p-button-label">Quitar documento</span></button>
                          <button pButton type="button" class="p-button-sm p-button-text" (click)="desligando.set(false)"><span class="p-button-label">Cancelar</span></button>
                        </div>
                      </div>
                    }
                  }
                } @else if (x.order.link_block) {
                  <p class="mc-note mc-note-warn mc-note-in"><i class="pi pi-info-circle" aria-hidden="true"></i><span>{{ bloqueoLargo(x.order.link_block) }}</span></p>
                } @else if (candLoading()) {
                  <div class="mc-skeleton" aria-busy="true"><div class="mc-skel-row"></div><div class="mc-skel-row"></div></div>
                } @else if (cand(); as c) {
                  @if (c.data.length) {
                    <p class="mc-hint">Documentos del cliente en Kepler desde el {{ dmy(c.from) }}. El que trae los mismos productos del pedido va primero; confirma tú cuál es.</p>
                    @for (k of c.data; track k.folio_digital) {
                      <div class="mc-doc" [class.mc-doc-off]="!!k.linked_to_order_code">
                        <div>
                          <span class="mono">{{ k.folio_digital }}</span>
                          <span class="muted mc-sub">Caja {{ k.caja ?? '—' }} · {{ dmy(k.fecha) }}@if (k.cashier_name) { · {{ k.cashier_name }} }</span>
                          <span class="mc-sub" [class.mc-ok]="k.shared_products > 0" [class.muted]="k.shared_products === 0">{{ k.shared_products }} de {{ k.order_products }} productos del pedido</span>
                        </div>
                        <div class="mc-doc-r">
                          <b class="num">{{ k.total === null ? '—' : money(k.total) }}</b>
                          @if (k.linked_to_order_code) { <span class="muted mc-sub">ya es de {{ k.linked_to_order_code }}</span> }
                          @else if (puedeLigar() && x.order.status === 'confirmed') {
                            <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="guardando() === k.folio_digital" [disabled]="!!guardando()" (click)="ligar(x.order.id, k)"><span class="p-button-label">Es este</span></button>
                          }
                        </div>
                      </div>
                    }
                  } @else {
                    <p class="mc-hint">El cliente no tiene documentos en Kepler desde el {{ dmy(c.from) }}. Si ya se cobró, la caja todavía no lo emite o se emitió a otra clave.</p>
                  }
                }
                @if (msg(); as m) { <p class="mc-msg" [class.mc-bad]="m.mal" role="status">{{ m.texto }}</p> }
              </div>

              @if (x.compare.length) {
                <div class="mc-step">
                  <h3>Pedido contra lo cobrado · {{ x.compare.length }} productos</h3>
                  <p-table [value]="x.compare" size="small" class="surf-table mc-lines" [scrollable]="true" scrollHeight="20rem">
                    <ng-template #header>
                      <tr><th>Producto</th><th class="ta-r">Pedido</th><th class="ta-r">Cobrado</th><th></th></tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr>
                        <td role="cell" data-label="Producto"><span class="mc-trunc">{{ l.description || l.sku || '—' }}</span><span class="muted mc-sub mono">{{ l.sku || '' }}</span></td>
                        <td class="ta-r num" role="cell" data-label="Pedido">{{ cant(l.ordered_qty) }}<span class="mc-sub muted">{{ l.ordered_price === null ? '' : money(l.ordered_price) }}</span></td>
                        <td class="ta-r num" role="cell" data-label="Cobrado">{{ cant(l.charged_qty) }} {{ l.charged_unit || '' }}<span class="mc-sub muted">{{ l.charged_price === null ? '' : money(l.charged_price) }}</span></td>
                        <td role="cell" data-label="Diferencia"><span [class.mc-bad]="matchMal(l.match)" [class.muted]="!matchMal(l.match)">{{ matchLabel(l.match) }}</span></td>
                      </tr>
                    </ng-template>
                  </p-table>
                  <p class="mc-hint">Cantidades en unidad base; precios por unidad, sin impuestos y ya con el descuento del renglón.</p>
                </div>
              }

              <div class="mc-step">
                <h3>Recorrido</h3>
                @for (h of x.history; track $index) {
                  <div class="mc-row"><span class="mono">{{ fechaHora(h.changed_at) }}</span><span>{{ estadoLabel(h.to_status) }}@if (h.changed_by_username) { <span class="muted"> · {{ h.changed_by_username }}</span> }@if (h.reason) { <span class="muted mc-sub">{{ h.reason }}</span> }</span></div>
                }
                @for (l of x.links; track l.linked_at) {
                  <div class="mc-row"><span class="mono">{{ fechaHora(l.linked_at) }}</span><span>Documento {{ l.folio_digital }} ligado@if (l.linked_by_name) { <span class="muted"> · {{ l.linked_by_name }}</span> }@if (l.unlinked_at) { <span class="mc-sub mc-bad">quitado {{ fechaHora(l.unlinked_at) }}: {{ l.unlink_reason }}</span> }</span></div>
                }
              </div>
            } @else if (detErr(); as e) {
              <div class="mc-empty mc-pad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ e }}</span></div>
            }
          </section>
        </p-drawer>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .mc-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .mc-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .mc-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .mc-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .mc-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:var(--r-sm); overflow:hidden; background:var(--card-bg); }
    .mc-seg-b { height:2.25rem; padding:0 .75rem; border:0; border-left:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .mc-seg-b:first-child { border-left:0; }
    .mc-seg-b.on { background:var(--text-main); color:var(--card-bg); }
    .mc-seg-b:focus-visible, .mc-chip:focus-visible, .mc-link:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .mc-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .mc-note .pi { color:var(--text-muted); margin-top:.15rem; }
    .mc-note-bad { border-left:3px solid var(--bad-fg); }
    .mc-note-bad .pi { color:var(--bad-fg); }
    .mc-note-warn { border-left:3px solid var(--warn-fg); }
    .mc-note-warn .pi { color:var(--warn-soft-fg); }
    .mc-note-in { margin:0; }
    .mc-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .mc-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .mc-chips { display:flex; flex-wrap:wrap; gap:.3rem; }
    .mc-chip { height:2rem; padding:0 .65rem; border:1px solid var(--border-color); border-radius:999px; background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-xs); display:inline-flex; align-items:center; gap:.35rem; cursor:pointer; }
    .mc-chip.on { background:var(--text-main); border-color:var(--text-main); color:var(--card-bg); }
    .mc-chip-bad:not(.on) .num { color:var(--bad-fg); font-weight:700; }
    .mc-filters { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
    :host ::ng-deep .mc-sel { min-width:10rem; }
    .mc-q { min-width:14rem; height:2.25rem; }
    .mc-foot { display:flex; flex-wrap:wrap; gap:.25rem 1.1rem; padding:.45rem .85rem; border-top:1px solid var(--border-color); font-size:var(--fs-xs); color:var(--text-muted); }
    .mc-foot b { color:var(--text-main); font-weight:600; }
    .mc-det-head { display:flex; align-items:center; gap:.6rem; padding:0 0 .5rem; font-size:var(--fs-sm); flex-wrap:wrap; }
    .mc-step { padding:.7rem 0; border-top:1px solid var(--border-color); }
    .mc-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .mc-row { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .mc-row > span:first-child { color:var(--text-muted); flex:none; }
    .mc-row > span:last-child { text-align:right; min-width:0; }
    .mc-doc { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; padding:.55rem .65rem; margin:.35rem 0; border:1px solid var(--border-color); border-radius:var(--r-sm); font-size:var(--fs-sm); }
    .mc-doc-on { border-left:3px solid var(--ok-fg); }
    .mc-doc-off { opacity:.6; }
    .mc-doc-r { display:flex; flex-direction:column; align-items:flex-end; gap:.3rem; flex:none; }
    .mc-form { display:flex; flex-direction:column; gap:.4rem; margin-top:.5rem; font-size:var(--fs-sm); }
    .mc-form-acts { display:flex; gap:.4rem; }
    .mc-msg { font-size:var(--fs-sm); margin:.5rem 0 0; }
    .mc-mt { margin-top:.4rem; }
    :host ::ng-deep .mc-lines .p-datatable-tbody > tr > td, :host ::ng-deep .mc-lines .p-datatable-thead > tr > th { padding:.3rem .4rem; font-size:var(--fs-xs); }
    .mc-trunc { display:block; max-width:20rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .mc-sub { display:block; font-size:var(--fs-xs); }
    .mc-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.35rem 0; }
    .mc-pad { padding:.5rem .85rem; }
    .mc-bad { color:var(--bad-fg); font-weight:600; }
    .mc-warn { color:var(--warn-soft-fg); font-weight:600; }
    .mc-ok { color:var(--ok-fg); }
    .mc-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; font-size:var(--fs-sm); text-decoration:underline; }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .mc-tag, :host ::ng-deep .mc-tag .p-tag { font-size:var(--fs-nano); }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .mc-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .mc-errbox .pi { color:var(--bad-fg); } .mc-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .mc-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .mc-empty .pi { font-size:var(--fs-lg); }
    .mc-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .mc-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:mc-pulse 1.4s ease-in-out infinite; }
    @keyframes mc-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .mc-skel-row { animation:none; } }
  `],
})
export class AlmacenPreventaComponent implements OnInit {
  private readonly api = inject(AlmacenPreventaService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly skel = Array.from({ length: 8 });
  readonly skelDet = Array.from({ length: 6 });
  readonly money = money;
  readonly dmy = dmy;
  readonly etapas = ETAPAS;
  readonly cerradosOpts = [
    { dias: 0, label: 'Sólo abiertos' },
    { dias: 7, label: 'Cerrados 7 días' },
    { dias: 30, label: '30 días' },
  ];

  readonly cerrados = signal(7);
  readonly etapa = signal<PresaleStage | null>(null);
  readonly soloVencidos = signal(false);
  readonly sucursal = signal<string | null>(null);
  readonly q = signal('');

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<PresaleListResponse | null>(null);
  readonly cargado = signal<string>(new Date().toISOString());
  readonly sel = signal<PresaleOrderRow | null>(null);
  readonly det = signal<PresaleDetail | null>(null);
  readonly detLoading = signal(false);
  readonly detErr = signal<string | null>(null);
  readonly cand = signal<PresaleCandidatesResponse | null>(null);
  readonly candLoading = signal(false);
  /** Folio que se está ligando, o `true` mientras se quita una liga. */
  readonly guardando = signal<string | boolean>(false);
  readonly desligando = signal(false);
  readonly motivo = signal('');
  readonly msg = signal<{ texto: string; mal: boolean } | null>(null);

  /** Ligar o corregir exige el permiso de surtido (lo tiene el encargado); el modo god pasa siempre. */
  readonly puedeLigar = computed(() => this.perms.has(Permission.COMMERCIAL_PICKING_GESTIONAR));

  /** Lo que queda tras sucursal y búsqueda: sobre esto se cuentan los chips, para que cuadren con la tabla. */
  readonly base = computed<PresaleOrderRow[]>(() => {
    const d = this.data();
    if (!d) return [];
    const suc = this.sucursal();
    const q = this.q();
    // Buscador compartido: sin acentos, varias palabras en cualquier orden, sobre todos los campos.
    return d.data.filter((r) =>
      (!suc || r.branch === suc) &&
      coincideBusqueda(q, r.code, r.customer_name, r.seller_name, r.sales_route, r.customer_erp_code, r.link?.folio_digital));
  });
  readonly conteo = computed(() => {
    const out: Partial<Record<PresaleStage, number>> = {};
    for (const r of this.base()) out[r.stage] = (out[r.stage] ?? 0) + 1;
    return out;
  });
  readonly vencidos = computed(() => this.base().filter((r) => r.due === 'vencido').length);
  readonly filas = computed(() => {
    const e = this.etapa();
    const v = this.soloVencidos();
    return this.base().filter((r) => (!e || r.stage === e) && (!v || r.due === 'vencido'));
  });
  readonly totalPedido = computed(() => this.filas().reduce((t, r) => t + r.total, 0));
  readonly totalCobrado = computed(() => this.filas().reduce((t, r) => t + (r.link?.total ?? 0), 0));
  /** Pedidos con documento ligado cuyo total no aparece en Kepler: se DECLARAN, no se suman como 0. */
  readonly sinTotal = computed(() => this.filas().filter((r) => r.link && r.link.total === null).length);

  readonly sucursalOpts = computed(() => {
    const out: { label: string; value: string | null }[] = [{ label: 'Todas las sucursales', value: null }];
    const vistas = new Map<string, string>();
    for (const r of this.data()?.data ?? []) if (r.branch) vistas.set(r.branch, r.warehouse_name ?? r.branch);
    for (const [codigo, nombre] of [...vistas.entries()].sort()) out.push({ label: codigo + ' ' + nombre, value: codigo });
    return out;
  });
  readonly multiSucursal = computed(() => !this.sucursal() && this.sucursalOpts().length > 2);

  /** Peticiones del panel: se cancelan al elegir otro pedido, así una respuesta vieja no pisa a la nueva. */
  private detSub: Subscription | null = null;
  private candSub: Subscription | null = null;
  private listSub: Subscription | null = null;

  ngOnInit(): void {
    this.reload();
    this.destroyRef.onDestroy(() => { this.cancelarPanel(); this.listSub?.unsubscribe(); });
  }

  pickCerrados(d: number): void { this.cerrados.set(d); this.reload(); }
  pickEtapa(e: PresaleStage | null): void { this.etapa.set(this.etapa() === e ? null : e); this.soloVencidos.set(false); }
  toggleVencidos(): void { this.soloVencidos.set(!this.soloVencidos()); this.etapa.set(null); }
  hayFiltros(): boolean { return !!(this.etapa() || this.soloVencidos() || this.sucursal() || this.q()); }
  limpiar(): void { this.etapa.set(null); this.soloVencidos.set(false); this.sucursal.set(null); this.q.set(''); }

  /** La última petición manda: una anterior que llegue tarde se cancela, no pinta encima. */
  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.listSub?.unsubscribe();
    this.listSub = this.api.list(this.cerrados()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.cargado.set(new Date().toISOString());
        // Un filtro cuyo valor ya no está en los datos quedaría aplicado sin un control visible
        // que lo diga (el selector o el chip se esconden): se quita.
        const suc = this.sucursal();
        if (suc && !d.data.some((r) => r.branch === suc)) this.sucursal.set(null);
        const et = this.etapa();
        if (et && !d.data.some((r) => r.stage === et)) this.etapa.set(null);

        const s = this.sel();
        if (s) {
          const nuevo = d.data.find((x) => x.id === s.id) ?? null;
          if (!nuevo) {
            this.pick(null);
          } else {
            this.sel.set(nuevo);
            // Si el pedido cambió por fuera (p. ej. lo ligaron desde el celular), el panel se
            // vuelve a leer; si no, ofrecería candidatos de un pedido que ya tiene documento.
            const cambio = nuevo.stage !== s.stage || nuevo.status !== s.status ||
              (nuevo.link?.folio_digital ?? null) !== (s.link?.folio_digital ?? null);
            if (cambio) this.cargarDetalle(nuevo.id);
          }
        }
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los pedidos de preventa.'); },
    });
  }

  private cancelarPanel(): void {
    this.detSub?.unsubscribe();
    this.candSub?.unsubscribe();
    this.detSub = this.candSub = null;
  }

  pick(r: PresaleOrderRow | null): void {
    this.cancelarPanel();
    this.sel.set(r);
    this.det.set(null);
    this.detErr.set(null);
    this.detLoading.set(false);
    this.cand.set(null);
    this.candLoading.set(false);
    this.guardando.set(false);
    this.msg.set(null);
    this.desligando.set(false);
    this.motivo.set('');
    if (!r) return;
    this.cargarDetalle(r.id);
  }

  private cargarDetalle(id: string): void {
    this.detSub?.unsubscribe();
    this.candSub?.unsubscribe();
    this.detLoading.set(true);
    this.detErr.set(null);
    this.detSub = this.api.detail(id).subscribe({
      next: (x) => {
        if (this.sel()?.id !== id) return;
        this.det.set(x);
        this.detLoading.set(false);
        this.cand.set(null);
        // Los candidatos sólo hacen falta si el pedido no tiene documento y se puede buscar.
        if (!x.order.link && !x.order.link_block && x.order.status === 'confirmed') this.cargarCandidatos(id);
      },
      error: () => {
        if (this.sel()?.id !== id) return;
        this.detLoading.set(false);
        this.detErr.set('No se pudo cargar el detalle del pedido.');
      },
    });
  }

  private cargarCandidatos(id: string): void {
    this.candSub?.unsubscribe();
    this.candLoading.set(true);
    this.candSub = this.api.candidates(id).subscribe({
      next: (c) => {
        if (this.sel()?.id !== id) return;
        this.cand.set(c);
        this.candLoading.set(false);
      },
      error: () => {
        if (this.sel()?.id !== id) return;
        this.candLoading.set(false);
        this.msg.set({ texto: 'No se pudieron leer los documentos de Kepler del cliente.', mal: true });
      },
    });
  }

  ligar(id: string, k: PresaleCandidate): void {
    this.guardando.set(k.folio_digital);
    this.msg.set(null);
    // La acción NO se cancela al cambiar de pedido: cortarla dejaría sin saber si se guardó.
    this.api.link(id, k.folio_digital).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.reload();
        if (this.sel()?.id !== id) return;
        this.guardando.set(false);
        this.msg.set({ texto: 'Documento ' + k.folio_digital + ' ligado al pedido.', mal: false });
        this.cargarDetalle(id);
      },
      error: (e: HttpErrorResponse) => {
        if (this.sel()?.id !== id) return;
        this.guardando.set(false);
        this.msg.set({ texto: this.errorTexto(e, 'No se pudo ligar el documento.'), mal: true });
      },
    });
  }

  abrirCorregir(): void {
    this.desligando.set(true);
    // El foco va al motivo, que es lo único que hay que escribir.
    setTimeout(() => document.getElementById('mc-motivo')?.focus());
  }

  desligar(id: string): void {
    const cancelado = this.det()?.order.status === 'cancelled';
    this.guardando.set(true);
    this.msg.set(null);
    this.api.unlink(id, this.motivo().trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.reload();
        if (this.sel()?.id !== id) return;
        this.guardando.set(false);
        this.desligando.set(false);
        this.motivo.set('');
        this.msg.set({
          texto: cancelado
            ? 'Se quitó el documento del pedido cancelado: queda libre para ligarse a otro pedido.'
            : 'Se quitó el documento. Elige el correcto.',
          mal: false,
        });
        this.cargarDetalle(id);
      },
      error: (e: HttpErrorResponse) => {
        if (this.sel()?.id !== id) return;
        this.guardando.set(false);
        this.msg.set({ texto: this.errorTexto(e, 'No se pudo quitar el documento.'), mal: true });
      },
    });
  }

  /** El servidor ya explica el motivo (409/400/404); se muestra tal cual. */
  private errorTexto(e: HttpErrorResponse, defecto: string): string {
    const m = (e?.error as { message?: string | string[] } | null)?.message;
    return Array.isArray(m) ? m.join(' ') : m || defecto;
  }

  etapaLabel(s: PresaleStage): string { return ETAPA.get(s)?.label ?? s; }
  etapaSev(s: PresaleStage): Sev { return ETAPA.get(s)?.sev ?? 'secondary'; }
  bloqueoCorto(b: PresaleLinkBlock): string { return BLOQUEO[b]?.corto ?? b; }
  bloqueoLargo(b: PresaleLinkBlock): string { return BLOQUEO[b]?.largo ?? b; }
  matchLabel(m: PresaleLineCompare['match']): string { return MATCH[m]?.label ?? m; }
  matchMal(m: PresaleLineCompare['match']): boolean { return MATCH[m]?.mal ?? false; }
  estadoLabel(s: string): string {
    const m: Record<string, string> = { draft: 'Borrador', pending_approval: 'Por aprobar', confirmed: 'Confirmado', fulfilled: 'Entregado', cancelled: 'Cancelado' };
    return m[s] ?? s;
  }
  dm(v: string | null): string { return v ? dmy(v).slice(0, 5) : '—'; }

  dueTexto(r: PresaleOrderRow): string {
    if (r.due === null) return r.stage === 'cancelado' ? 'cancelado' : 'entregado';
    if (r.due === 'vencido') return 'vencido ' + r.days_late + ' d';
    if (r.due === 'hoy') return 'hoy';
    const d = -(r.days_late ?? 0);
    return d === 1 ? 'mañana' : 'en ' + d + ' d';
  }

  /** Diferencia cobrado − pedido; `null` si cuadra al centavo o no hay total del documento. */
  dif(r: PresaleOrderRow): string | null {
    if (!r.link || r.link.total === null) return null;
    const x = Math.round((r.link.total - r.total) * 100) / 100;
    if (Math.abs(x) < 0.01) return null;
    return (x < 0 ? '−' : '+') + money(Math.abs(x));
  }

  cant(v: number | null): string { return v == null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 3 }); }
  hora(isoTs: string): string {
    return new Date(isoTs).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
  fechaHora(isoTs: string | null): string {
    if (!isoTs) return '—';
    return new Date(isoTs).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
