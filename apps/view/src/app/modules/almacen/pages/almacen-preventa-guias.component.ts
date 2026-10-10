import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { DENOMINACIONES_MXN, totalDenominaciones } from '@megadulces/contracts';
import type { LoadGuide, LoadGuideLiquidationPreview, LoadGuideLiquidationsResponse, LoadGuidesResponse } from '@megadulces/contracts';
import { money } from '../../../shared/util/money.util';
import { AlmacenPreventaService } from '../almacen-preventa.service';

const pad = (n: number): string => String(n).padStart(2, '0');
const hoyMx = (): string => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return d + '/' + m + '/' + y;
};

/**
 * `[MCP.5]` Guías de carga de preventa, para la CAJA (Fase MCP, ADR-089).
 *
 * El repartidor o el vendedor pesca en su celular los pedidos que se lleva; aquí la cajera ve las
 * guías del día de su sucursal (una por repartidor y ruta) y las imprime para que él las firme
 * (D8). La primera impresión congela la guía; después se reimprime la misma foto.
 *
 * `[MCP.7]` Al regresar quien entregó, aquí se LIQUIDA su vuelta (D9/D11): lo entregado, lo que
 * declaró en efectivo y transferencia, y el arqueo por denominación contra el efectivo. Si no cuadra,
 * la nota es obligatoria. Sale el comprobante en PDF, que sustituye la tira de ingresos reimpresa.
 */
@Component({
  selector: 'app-almacen-preventa-guias',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TagModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head gc-head">
        <div class="gc-head-text">
          <h1>Guías de carga</h1>
          <span class="gc-meta">Pedidos de preventa que cada repartidor pescó · se imprime una guía por ruta y la firma quien se lleva la carga</span>
        </div>
        <div class="gc-actions">
          <label class="gc-fecha" for="gc-fecha"><span class="muted">Día</span>
            <input pInputText id="gc-fecha" type="date" [ngModel]="fecha()" (ngModelChange)="pickFecha($event)" />
          </label>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="gc-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gc-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }
      @if (msg(); as m) { <p class="gc-msg" [class.gc-bad]="m.mal" role="status">{{ m.texto }}</p> }

      @if (loading() && !data()) { <div class="gc-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="gc-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (d.scope === 'ninguno') {
          <div class="gc-empty"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay guías que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
        } @else if (!d.data.length) {
          <div class="gc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Nadie ha pescado pedidos de preventa el {{ dmy(d.date) }}. Las guías aparecen aquí cuando el repartidor carga pedidos en su celular.</span></div>
        } @else {
          <div class="gc-foot" aria-label="Resumen del día">
            <span><b class="num">{{ d.data.length }}</b> {{ d.data.length === 1 ? 'guía' : 'guías' }}</span>
            <span><b class="num">{{ porImprimir() }}</b> por imprimir</span>
            <span><b class="num">{{ totalPedidos() }}</b> pedidos</span>
            <span><b class="num">{{ money(totalDia()) }}</b> a liquidar</span>
          </div>

          @if (porLiquidar().length) {
            <section class="gc-sec" aria-labelledby="gc-liq-h">
              <h2 id="gc-liq-h" class="gc-sec-h">Por liquidar</h2>
              <p class="gc-hint gc-hint-top">Cuando regrese quien entregó: cuenta el efectivo contra lo que declaró al entregar. Se liquidan juntas las guías de su vuelta.</p>
              @for (r of porLiquidar(); track r.key) {
                <div class="gc-liq-row">
                  <div class="gc-liq-who">
                    <b>{{ r.rider_name || '—' }}</b>
                    <span class="muted"> · {{ r.branch }} · {{ r.guias.length }} {{ r.guias.length === 1 ? 'guía' : 'guías' }}: <span class="mono">{{ r.folios }}</span></span>
                    <span class="gc-cobro">{{ r.entregados }} {{ r.entregados === 1 ? 'entregado' : 'entregados' }} · {{ r.volvieron }} {{ r.volvieron === 1 ? 'volvió' : 'volvieron' }}@if (r.pendientes) { · <span class="gc-warn">{{ r.pendientes }} en camino</span> }</span>
                  </div>
                  @if (liqKey() !== r.key) {
                    <button pButton type="button" class="p-button-sm" [id]="'gc-liq-btn-' + r.key" (click)="abrirLiquidacion(r.key, r.ids)"><span class="p-button-icon pi pi-wallet" aria-hidden="true"></span><span class="p-button-label">Liquidar</span></button>
                  }
                </div>
                @if (liqKey() === r.key) {
                  <div class="gc-liq-panel" role="region" [attr.aria-label]="'Liquidación de ' + (r.rider_name || 'quien entregó')">
                    <h3 class="gc-sub-h" id="gc-liq-t" tabindex="-1">Liquidar la vuelta de {{ r.rider_name || '—' }}</h3>
                    @if (r.guias.length > 1) {
                      <fieldset class="gc-guias">
                        <legend>Guías que trae en esta vuelta</legend>
                        @for (g of r.guias; track g.id) {
                          <label class="gc-guia-op">
                            <input type="checkbox" [checked]="liqIds().includes(g.id)" [disabled]="liquidando()" (change)="toggleGuia(r.key, g.id)" />
                            <span class="mono">{{ g.folio }}</span> · {{ g.sales_route }} · {{ dmy(g.business_date) }}@if (enCamino(g)) { · <span class="gc-warn">{{ enCamino(g) }} en camino</span> }
                          </label>
                        }
                      </fieldset>
                    }
                    @if (liqErr(); as e) {
                      <p class="gc-bad" role="alert">{{ e }}</p>
                      @if (!preview()) {
                        <div class="gc-liq-acc">
                          <button pButton type="button" class="p-button-sm p-button-outlined" (click)="cargarPreview(r.key)"><span class="p-button-label">Reintentar</span></button>
                          <button pButton type="button" class="p-button-sm p-button-text" (click)="cerrarLiquidacion()"><span class="p-button-label">Cancelar</span></button>
                        </div>
                      }
                    }
                    @if (!liqIds().length) {
                      <p class="gc-hint">Elige al menos una guía.</p>
                      <div class="gc-liq-acc"><button pButton type="button" class="p-button-sm p-button-text" (click)="cerrarLiquidacion()"><span class="p-button-label">Cancelar</span></button></div>
                    } @else if (!preview()) {
                      @if (!liqErr()) { <div class="gc-skel-row" aria-busy="true"></div> }
                    } @else if (preview(); as p) {
                      @if (p.blocked_reason) { <p class="gc-bad" role="alert">{{ p.blocked_reason }}</p> }
                      <div class="gc-liq-grid">
                        <div>
                          <h4 class="gc-sub-h">Lo que se espera</h4>
                          <div class="gc-kv"><span>Documentos de Kepler entregados ({{ p.delivered }})</span><b class="num">{{ money(p.documents_total) }}</b></div>
                          @if (p.documents_without_total) { <p class="gc-hint">{{ p.documents_without_total }} documento(s) sin total en el sistema: no se suman.</p> }
                          <div class="gc-kv"><span>Transferencias declaradas</span><b class="num">{{ money(p.declared_transfer) }}</b></div>
                          @for (t of p.transfers; track t.order_code) {
                            <div class="gc-kv gc-kv-sub"><span><span class="mono">{{ t.order_code }}</span> · {{ t.customer_name || '—' }} · ref. <span class="mono">{{ t.ref || '—' }}</span></span><span class="num">{{ money(t.amount) }}</span></div>
                          }
                          <div class="gc-kv gc-kv-tot"><span>Efectivo declarado al entregar</span><b class="num">{{ money(p.declared_cash) }}</b></div>
                          <div class="gc-kv"><span>Documentos − lo declarado</span><span class="num">{{ money(p.pending_collection) }}</span></div>
                          @if (p.unexplained_difference !== 0) {
                            <p class="gc-bad">Hay {{ money(abs(p.unexplained_difference)) }} entre lo que cobró Kepler y lo que se declaró en pedidos entregados «completo»: explícalo en la nota.</p>
                          }
                          @if (p.not_delivered) { <p class="gc-hint">{{ p.not_delivered }} {{ p.not_delivered === 1 ? 'pedido volvió' : 'pedidos volvieron' }} sin entregarse: no se cobran.</p> }
                        </div>
                        <div>
                          <h4 class="gc-sub-h">Efectivo contado</h4>
                          <table class="gc-den">
                            <thead><tr><th>Denominación</th><th class="ta-r">Piezas</th><th class="ta-r">Importe</th></tr></thead>
                            <tbody>
                              @for (d of denoms; track d.key) {
                                <tr>
                                  <td><label [for]="'gc-den-' + d.key">{{ d.label }}@if (d.familia === 'moneda') { <span class="muted"> moneda</span> }</label></td>
                                  <td class="ta-r"><input pInputText class="gc-den-in num" type="number" inputmode="numeric" min="0" step="1" [id]="'gc-den-' + d.key" [disabled]="liquidando()" [ngModel]="piezas()[d.key] ?? null" (ngModelChange)="setPiezas(d.key, $event)" placeholder="0" /></td>
                                  <td class="ta-r num">{{ (piezas()[d.key] ?? 0) ? money((piezas()[d.key] ?? 0) * d.valor) : '—' }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                          @if (piezasMal(); as pm) { <p class="gc-bad" role="alert">{{ pm }}</p> }
                        </div>
                      </div>
                      <div class="gc-cuadre" [class.gc-cuadre-mal]="diferencia() !== 0">
                        <span>Contado <b class="num">{{ money(contado()) }}</b> · declarado <b class="num">{{ money(p.declared_cash) }}</b></span>
                        <b aria-live="polite">{{ diferencia() === 0 ? 'Cuadra' : (diferencia() < 0 ? 'Faltan ' : 'Sobran ') + money(abs(diferencia())) }}</b>
                      </div>
                      @if (requiereNota()) {
                        <label class="gc-nota-l" for="gc-liq-nota">¿Por qué no cuadra? (queda en el comprobante)</label>
                        <textarea pInputText id="gc-liq-nota" class="gc-nota" rows="2" maxlength="500" [disabled]="liquidando()" [ngModel]="notaLiq()" (ngModelChange)="notaLiq.set($event)" placeholder="Ej. faltaron $30, los repone mañana"></textarea>
                      }
                      <div class="gc-liq-acc">
                        <button pButton type="button" class="p-button-sm" [loading]="liquidando()" [disabled]="!!p.blocked_reason || liquidando() || !!piezasMal() || (requiereNota() && notaLiq().trim().length < 5)" (click)="liquidar()">
                          <span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">{{ requiereNota() && notaLiq().trim().length < 5 ? 'Escribe por qué no cuadra' : 'Liquidar e imprimir comprobante' }}</span>
                        </button>
                        <button pButton type="button" class="p-button-sm p-button-text" [disabled]="liquidando()" (click)="cerrarLiquidacion()"><span class="p-button-label">Cancelar</span></button>
                      </div>
                    }
                  </div>
                }
              }
            </section>
          }

          <div class="gc-list">
            @for (g of d.data; track g.id) {
              <section class="gc-card" [attr.aria-labelledby]="'gc-h-' + g.id">
                <div class="gc-card-h">
                  <div class="gc-card-t">
                    <h2 [id]="'gc-h-' + g.id"><span class="mono">{{ g.folio }}</span> · {{ g.sales_route }}</h2>
                    <span class="muted">{{ g.rider_name || '—' }} · {{ g.branch }} {{ g.branch_name || '' }}@if (g.business_date !== d.date) { · <span class="gc-warn">de {{ dmy(g.business_date) }}{{ g.status === 'abierta' ? ', sin imprimir' : g.status === 'impresa' ? ', sin liquidar' : '' }}</span> }</span>
                  </div>
                  <div class="gc-card-r">
                    <p-tag [value]="g.status === 'liquidada' ? 'Liquidada · ' + (g.liquidation?.folio ?? '') : g.status === 'impresa' ? 'Impresa' : 'Por imprimir'" [severity]="g.status === 'liquidada' ? 'info' : g.status === 'impresa' ? 'success' : 'warn'" class="gc-tag" />
                    <b class="num">{{ money(g.total) }}</b>
                    <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="g.status !== 'abierta'" [loading]="imprimiendo() === g.id" [disabled]="!!imprimiendo() || !g.orders.length" (click)="imprimir(g)">
                      <span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">{{ g.status !== 'abierta' ? 'Reimprimir guía' : 'Imprimir guía' }}</span>
                    </button>
                  </div>
                </div>
                @if (g.status !== 'abierta') {
                  <p class="gc-hint">Impresa {{ fechaHora(g.printed_at) }}@if (g.printed_by_name) { por {{ g.printed_by_name }}}@if (g.print_count > 1) { · {{ g.print_count - 1 }} {{ g.print_count === 2 ? 'reimpresión' : 'reimpresiones' }} }. Lo que el repartidor pesque después va en una guía nueva.</p>
                }
                <table class="gc-tbl">
                  <thead><tr><th>Pedido</th><th>Cliente</th><th>Entrega</th><th>Documento Kepler</th><th class="ta-r">Importe</th>@if (g.status !== 'abierta') { <th><span class="sr-only">Acciones</span></th> }</tr></thead>
                  <tbody>
                    @for (o of g.orders; track o.order_id) {
                      <tr>
                        <td class="mono">{{ o.code }}</td>
                        <td>{{ o.customer_name || '—' }}@if (o.customer_erp_code) { <span class="muted mono"> · {{ o.customer_erp_code }}</span> }@if (o.order_cancelled && o.status === 'cargado') { <span class="gc-cobro gc-bad">Pedido cancelado: registra su regreso</span> }</td>
                        <td class="mono">{{ dmy(o.requested_delivery_date) }}</td>
                        <td class="mono" [class.muted]="!o.folio_digital">{{ o.folio_digital || (o.status === 'cargado' ? 'se elige al entregar' : '—') }}</td>
                        <td class="ta-r num" [class.gc-tachado]="o.status === 'no_entregado' || o.status === 'regreso'">{{ money(o.document_total ?? o.total) }}</td>
                        @if (g.status !== 'abierta') {
                          <td class="ta-r">
                            @if (o.status === 'entregado') {
                              <span class="gc-ent" [class.dif]="o.delivery_outcome === 'con_diferencia'">{{ o.delivery_outcome === 'con_diferencia' ? 'Entregado con diferencia' : 'Entregado' }}</span>
                              <span class="gc-cobro num">{{ cobroTexto(o.cash_amount, o.transfer_amount) }}@if (o.transfer_ref) { · ref. {{ o.transfer_ref }} }</span>
                            } @else if (o.status !== 'cargado') {
                              <span class="gc-ent gc-no">{{ o.status === 'regreso' ? 'Regresó a caja' : 'No se entregó (lo dijo el repartidor)' }}</span>
                              @if (o.removed_reason) { <span class="gc-cobro">{{ o.removed_reason }}</span> }
                            } @else if (regresando() !== o.order_id) {
                              <button type="button" class="gc-link" (click)="abrirRegreso(o.order_id)">Regresó sin entregar</button>
                            }
                          </td>
                        }
                      </tr>
                      @if (regresando() === o.order_id) {
                        <tr class="gc-reg"><td [attr.colspan]="6">
                          <div class="gc-reg-form">
                            <label [for]="'gc-mot-' + o.order_id">¿Por qué no se entregó {{ o.code }}?</label>
                            <input pInputText [id]="'gc-mot-' + o.order_id" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Ej. local cerrado" />
                            <button pButton type="button" class="p-button-sm" [disabled]="motivo().trim().length < 5 || guardando()" [loading]="guardando()" (click)="registrarRegreso(g, o.order_id)"><span class="p-button-label">Registrar regreso</span></button>
                            <button pButton type="button" class="p-button-sm p-button-text" (click)="regresando.set(null)"><span class="p-button-label">Cancelar</span></button>
                          </div>
                          <p class="gc-hint">El pedido queda libre para salir otro día en otra guía. El papel firmado no cambia.</p>
                        </td></tr>
                      }
                    }
                  </tbody>
                </table>
              </section>
            }
          </div>
          <p class="gc-hint">El importe es el del documento de Kepler cuando ya está ligado; si no, el del pedido.</p>
        }
      }

      @if (liqs(); as l) {
        @if (l.data.length) {
          <section class="gc-sec dt-scope" aria-labelledby="gc-liqs-h">
            <h2 id="gc-liqs-h" class="gc-sec-h">Liquidaciones del {{ dmy(l.date) }}</h2>
            <table class="gc-tbl dt-stack">
              <thead><tr><th>Folio</th><th>Quién entregó</th><th>Guías</th><th class="ta-r">Documentos</th><th class="ta-r">Transferencias</th><th class="ta-r">Efectivo contado</th><th class="ta-r">Diferencia</th><th><span class="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                @for (x of l.data; track x.id) {
                  <tr>
                    <td role="cell" data-label="Folio" class="mono">{{ x.folio }}</td>
                    <td role="cell" data-label="Quién entregó">{{ x.rider_name || '—' }}<span class="gc-cobro">Recibió {{ x.liquidated_by_name || '—' }} · {{ fechaHora(x.liquidated_at) }}</span></td>
                    <td role="cell" data-label="Guías" class="mono">{{ x.guide_folios.join(', ') }}</td>
                    <td role="cell" data-label="Documentos" class="ta-r num">{{ money(x.documents_total) }}</td>
                    <td role="cell" data-label="Transferencias" class="ta-r num">{{ money(x.declared_transfer) }}</td>
                    <td role="cell" data-label="Efectivo contado" class="ta-r num">{{ money(x.counted_cash) }}</td>
                    <td role="cell" data-label="Diferencia" class="ta-r">
                      <span class="num" [class.gc-bad]="x.cash_difference < 0" [class.gc-warn]="x.cash_difference > 0">{{ x.cash_difference === 0 ? 'Cuadra' : (x.cash_difference < 0 ? 'Faltan ' : 'Sobran ') + money(abs(x.cash_difference)) }}</span>
                      @if (x.notes) { <span class="gc-cobro">{{ x.notes }}</span> }
                    </td>
                    <td role="cell" data-label="Comprobante" class="ta-r"><button pButton type="button" class="p-button-sm p-button-outlined" [loading]="reimprimiendo() === x.id" [disabled]="!!reimprimiendo()" (click)="reimprimirLiquidacion(x.id)" [attr.aria-label]="'Reimprimir ' + x.folio"><span class="p-button-icon pi pi-print" aria-hidden="true"></span></button></td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .gc-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .gc-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .gc-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .gc-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .gc-fecha { display:inline-flex; align-items:center; gap:.4rem; font-size:var(--fs-sm); }
    .gc-fecha input { height:2.25rem; }
    .gc-foot { display:flex; flex-wrap:wrap; gap:.25rem 1.1rem; padding:.45rem .85rem; margin-bottom:.6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-xs); color:var(--text-muted); }
    .gc-foot b { color:var(--text-main); font-weight:600; }
    .gc-list { display:flex; flex-direction:column; gap:.75rem; }
    .gc-card { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.7rem .85rem; min-width:0; }
    .gc-card-h { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; flex-wrap:wrap; }
    .gc-card-t { display:flex; flex-direction:column; gap:.15rem; min-width:0; }
    .gc-card-t h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .gc-card-t .muted { font-size:var(--fs-sm); }
    .gc-card-r { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
    .gc-tbl { width:100%; border-collapse:collapse; margin-top:.5rem; font-size:var(--fs-sm); }
    .gc-tbl th { text-align:left; font-size:var(--fs-xs); color:var(--text-muted); font-weight:600; padding:.3rem .4rem; border-bottom:1px solid var(--border-color); }
    .gc-tbl td { padding:.3rem .4rem; border-bottom:1px dashed var(--border-color); }
    .gc-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.4rem 0 0; }
    .gc-msg { font-size:var(--fs-sm); margin:.2rem 0 .6rem; }
    .gc-bad { color:var(--bad-fg); font-weight:600; }
    .gc-warn { color:var(--warn-soft-fg); font-weight:600; }
    .gc-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; font-size:var(--fs-xs); text-decoration:underline; }
    .gc-ent { display:inline-block; font-size:var(--fs-micro); font-weight:700; padding:.1rem .45rem; border-radius:999px; background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .gc-ent.dif { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .gc-tachado { text-decoration:line-through; color:var(--text-muted); }
    .gc-ent.gc-no { background:var(--hover-bg); color:var(--text-main); }
    .gc-cobro { display:block; font-size:var(--fs-xs); color:var(--text-muted); margin-top:.15rem; }
    .gc-link:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .gc-sec { margin:.4rem 0 1rem; }
    .gc-sec-h { margin:0 0 .3rem; font-size:var(--fs-h3); font-weight:700; }
    .gc-hint-top { margin:0 0 .5rem; }
    .gc-liq-row { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; padding:.55rem .85rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); margin-bottom:.4rem; }
    .gc-liq-who { min-width:0; font-size:var(--fs-sm); }
    .gc-liq-panel { border:1px solid var(--action); border-radius:var(--r-md); background:var(--card-bg); padding:.75rem .85rem; margin:-.2rem 0 .6rem; }
    .gc-liq-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(18rem, 1fr)); gap:1rem; }
    .gc-sub-h { margin:0 0 .35rem; font-size:var(--fs-body); font-weight:700; }
    .gc-kv { display:flex; justify-content:space-between; gap:.75rem; font-size:var(--fs-sm); padding:.25rem 0; border-bottom:1px dashed var(--border-color); }
    .gc-kv-sub { font-size:var(--fs-xs); color:var(--text-muted); padding-left:.75rem; }
    .gc-kv-tot { font-weight:700; border-bottom:0; border-top:2px solid var(--text-main); margin-top:.2rem; }
    .gc-den { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .gc-den th { text-align:left; font-size:var(--fs-xs); color:var(--text-muted); font-weight:600; padding:.2rem .3rem; border-bottom:1px solid var(--border-color); }
    .gc-den td { padding:.15rem .3rem; border-bottom:1px dashed var(--border-color); }
    .gc-den-in { width:5.5rem; height:2rem; text-align:right; }
    .gc-cuadre { display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; margin-top:.75rem; padding:.55rem .75rem; border-radius:var(--r-sm); background:var(--ok-soft-bg); color:var(--ok-soft-fg); font-size:var(--fs-sm); }
    .gc-cuadre-mal { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .gc-nota-l { display:block; margin-top:.6rem; font-size:var(--fs-sm); font-weight:600; }
    .gc-nota { width:100%; margin-top:.25rem; font:inherit; font-size:var(--fs-sm); }
    .gc-guias { border:1px solid var(--border-color); border-radius:var(--r-sm); padding:.4rem .6rem; margin:0 0 .6rem; display:flex; flex-direction:column; gap:.25rem; font-size:var(--fs-sm); }
    .gc-guias legend { font-size:var(--fs-xs); color:var(--text-muted); padding:0 .25rem; }
    .gc-guia-op { display:flex; align-items:center; gap:.4rem; min-height:2rem; cursor:pointer; }
    .gc-guia-op input { accent-color:var(--action); width:1rem; height:1rem; }
    .gc-liq-acc { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.75rem; }
    .gc-reg td { background:var(--hover-bg); }
    .gc-reg-form { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; font-size:var(--fs-sm); }
    .gc-reg-form input { min-width:14rem; height:2.25rem; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .gc-tag, :host ::ng-deep .gc-tag .p-tag { font-size:var(--fs-nano); }
    .gc-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .gc-errbox .pi { color:var(--bad-fg); } .gc-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .gc-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .gc-empty .pi { font-size:var(--fs-lg); }
    .gc-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .gc-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:gc-pulse 1.4s ease-in-out infinite; }
    @keyframes gc-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .gc-skel-row { animation:none; } }
  `],
})
export class AlmacenPreventaGuiasComponent implements OnInit {
  private readonly api = inject(AlmacenPreventaService);
  private readonly destroyRef = inject(DestroyRef);
  private listSub: Subscription | null = null;

  readonly skel = Array.from({ length: 4 });
  readonly money = money;

  /** `[MCP.6]` Lo que cobró el repartidor al entregar, para que la caja lo vea antes de liquidar. */
  cobroTexto(efectivo: number | null, transferencia: number | null): string {
    const partes: string[] = [];
    if (efectivo) partes.push(money(efectivo) + ' efectivo');
    if (transferencia) partes.push(money(transferencia) + ' transf.');
    return partes.length ? partes.join(' + ') : 'sin cobro';
  }
  readonly dmy = dmy;

  readonly fecha = signal(hoyMx());
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<LoadGuidesResponse | null>(null);
  readonly imprimiendo = signal<string | null>(null);
  readonly msg = signal<{ texto: string; mal: boolean } | null>(null);
  /** Pedido cuyo regreso se está capturando (formulario en línea). */
  readonly regresando = signal<string | null>(null);
  readonly motivo = signal('');
  readonly guardando = signal(false);

  readonly porImprimir = computed(() => (this.data()?.data ?? []).filter((g) => g.status === 'abierta').length);
  readonly totalPedidos = computed(() => (this.data()?.data ?? []).reduce((t, g) => t + g.orders.length, 0));
  /** Lo que falta liquidar: las guías ya liquidadas no cuentan. */
  readonly totalDia = computed(() =>
    (this.data()?.data ?? []).filter((g) => g.status !== 'liquidada').reduce((t, g) => t + g.total, 0));

  // ── [MCP.7] Liquidación ──────────────────────────────────────────────────────────────────────
  readonly denoms = DENOMINACIONES_MXN;
  readonly abs = Math.abs;
  readonly liqs = signal<LoadGuideLiquidationsResponse | null>(null);
  /** El regreso (persona + sucursal) que se está liquidando. */
  readonly liqKey = signal<string | null>(null);
  /** Las guías de ese regreso que se liquidan ahora (la caja puede dejar fuera una de otra vuelta). */
  readonly liqIds = signal<string[]>([]);
  readonly preview = signal<LoadGuideLiquidationPreview | null>(null);
  readonly liqErr = signal<string | null>(null);
  readonly piezas = signal<Record<string, number>>({});
  /** Una captura de piezas que no es un entero ≥ 0: se avisa, no se corrige en silencio. */
  readonly piezasMal = signal<string | null>(null);
  readonly notaLiq = signal('');
  readonly liquidando = signal(false);
  readonly reimprimiendo = signal<string | null>(null);
  private prevSub: Subscription | null = null;

  /** Las guías impresas sin liquidar, agrupadas por quien entregó y sucursal: un regreso. */
  readonly porLiquidar = computed(() => {
    const grupos = new Map<string, LoadGuide[]>();
    for (const g of this.data()?.data ?? []) {
      if (g.status !== 'impresa') continue;
      const k = g.rider_user_id + '|' + g.branch;
      grupos.set(k, [...(grupos.get(k) ?? []), g]);
    }
    return [...grupos.entries()].map(([key, guias]) => {
      const renglones = guias.flatMap((g) => g.orders);
      return {
        key,
        ids: guias.map((g) => g.id),
        guias,
        folios: guias.map((g) => g.folio).join(', '),
        rider_name: guias[0].rider_name,
        branch: guias[0].branch,
        entregados: renglones.filter((o) => o.status === 'entregado').length,
        volvieron: renglones.filter((o) => o.status === 'no_entregado' || o.status === 'regreso').length,
        pendientes: renglones.filter((o) => o.status === 'cargado').length,
      };
    });
  });
  readonly contado = computed(() => totalDenominaciones(this.piezas()).total);
  readonly diferencia = computed(() => {
    const p = this.preview();
    return p ? Math.round((this.contado() - p.declared_cash) * 100) / 100 : 0;
  });
  /** Nota obligatoria: el efectivo no cuadra, o Kepler cobró algo que nadie declaró ni explicó. */
  readonly requiereNota = computed(() => this.diferencia() !== 0 || (this.preview()?.unexplained_difference ?? 0) !== 0);

  enCamino(g: LoadGuide): number {
    return g.orders.filter((o) => o.status === 'cargado').length;
  }

  /**
   * Abre la liquidación de un regreso. De entrada se eligen las guías SIN pedidos en camino (las
   * listas para liquidar); si todas tienen pendientes, se eligen todas para que se vea por qué no.
   */
  abrirLiquidacion(key: string, ids: string[]): void {
    const grupo = this.porLiquidar().find((r) => r.key === key);
    const listas = (grupo?.guias ?? []).filter((g) => !this.enCamino(g)).map((g) => g.id);
    this.liqKey.set(key);
    this.liqIds.set(listas.length ? listas : ids);
    this.piezas.set({});
    this.piezasMal.set(null);
    this.notaLiq.set('');
    this.msg.set(null);
    this.cargarPreview(key);
    setTimeout(() => document.getElementById('gc-liq-t')?.focus());
  }

  cargarPreview(key: string): void {
    this.preview.set(null);
    this.liqErr.set(null);
    this.prevSub?.unsubscribe();
    const ids = this.liqIds();
    if (!ids.length) return;
    this.prevSub = this.api.previewLiquidation(ids).subscribe({
      next: (p) => { if (this.liqKey() === key) this.preview.set(p); },
      error: (e: HttpErrorResponse) => {
        const m = (e?.error as { message?: string } | null)?.message;
        this.liqErr.set(m || 'No se pudo preparar la liquidación. Intenta otra vez.');
      },
    });
  }

  toggleGuia(key: string, id: string): void {
    const s = new Set(this.liqIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.liqIds.set([...s]);
    this.cargarPreview(key);
  }

  cerrarLiquidacion(): void {
    if (this.liquidando()) return;
    const key = this.liqKey();
    this.prevSub?.unsubscribe();
    this.liqKey.set(null);
    this.liqIds.set([]);
    this.preview.set(null);
    this.liqErr.set(null);
    // El foco vuelve al botón "Liquidar" de esa fila (si sigue existiendo).
    if (key) setTimeout(() => document.getElementById('gc-liq-btn-' + key)?.focus());
  }

  setPiezas(key: string, v: number | string | null): void {
    const p = { ...this.piezas() };
    const vacio = v === null || v === '';
    const n = vacio ? 0 : Number(v);
    if (!vacio && (!Number.isInteger(n) || n < 0)) {
      this.piezasMal.set('Las piezas son números enteros, sin decimales ni negativos.');
      delete p[key];
    } else {
      this.piezasMal.set(null);
      if (n > 0) p[key] = n; else delete p[key];
    }
    this.piezas.set(p);
  }

  liquidar(): void {
    const p = this.preview();
    if (!p) return;
    // La ventana se abre YA, dentro del clic: abrirla al llegar el PDF la bloquearía el navegador.
    const win = window.open('', '_blank');
    this.liquidando.set(true);
    this.liqErr.set(null);
    const nota = this.notaLiq().trim();
    this.api.liquidate({
      guide_ids: this.liqIds(),
      cash_breakdown: this.piezas(),
      notes: nota || undefined,
      expected_declared_cash: p.declared_cash,
      expected_declared_transfer: p.declared_transfer,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.liquidando.set(false);
          const folio = res.headers.get('X-Liquidacion-Folio') || '';
          this.cerrarLiquidacion();
          const abierta = this.abrirPdf(win, res.body as Blob, folio);
          if (abierta) this.msg.set({ texto: 'Liquidación ' + folio + ' cerrada. Imprime el comprobante y fírmenlo los dos.', mal: false });
          this.reload();
        },
        error: (e: HttpErrorResponse) => {
          this.liquidando.set(false);
          win?.close();
          // Con responseType blob el mensaje llega como Blob: se lee aparte.
          const blob = e?.error instanceof Blob ? e.error : null;
          const conflicto = e?.status === 409;
          const fin = (m: string) => {
            this.liqErr.set(m || 'No se pudo liquidar.');
            // Si algo cambió (otra entrega, otra caja), se recarga lo esperado para revisarlo.
            if (conflicto && this.liqKey()) this.refrescarPreview(this.liqKey() as string);
          };
          if (!blob) { fin(''); return; }
          blob.text().then((t) => {
            let m = '';
            try { m = (JSON.parse(t) as { message?: string }).message ?? ''; } catch { m = ''; }
            fin(m);
          });
        },
      });
  }

  /** Recarga lo esperado sin borrar el mensaje de por qué se recargó. */
  private refrescarPreview(key: string): void {
    this.prevSub?.unsubscribe();
    this.prevSub = this.api.previewLiquidation(this.liqIds()).subscribe({
      next: (p) => { if (this.liqKey() === key) this.preview.set(p); },
      error: () => undefined,
    });
  }

  reimprimirLiquidacion(id: string): void {
    const win = window.open('', '_blank');
    this.reimprimiendo.set(id);
    this.msg.set(null);
    this.api.reprintLiquidation(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.reimprimiendo.set(null);
        this.abrirPdf(win, res.body as Blob, res.headers.get('X-Liquidacion-Folio') || 'comprobante');
        this.reload();
      },
      error: () => {
        this.reimprimiendo.set(null);
        win?.close();
        this.msg.set({ texto: 'No se pudo reimprimir el comprobante.', mal: true });
      },
    });
  }

  /**
   * Abre el PDF en la ventana que se abrió con el clic. Si el navegador la bloqueó, lo DESCARGA
   * (así el primer papel que se firma no tiene que salir de una reimpresión) y lo avisa.
   */
  private abrirPdf(win: Window | null, blob: Blob, folio: string): boolean {
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (win) {
      win.location.href = url;
      return true;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = folio + '.pdf';
    a.click();
    this.msg.set({ texto: 'El navegador bloqueó la ventana: el comprobante ' + folio + ' se descargó. Ábrelo desde tus descargas para imprimirlo.', mal: true });
    return false;
  }

  ngOnInit(): void {
    this.reload();
    this.destroyRef.onDestroy(() => { this.listSub?.unsubscribe(); this.prevSub?.unsubscribe(); });
  }

  pickFecha(v: string): void {
    if (!v) return;
    this.fecha.set(v);
    this.msg.set(null);
    this.reload();
  }

  /** La última consulta manda: una anterior que llegue tarde se cancela. */
  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.listSub?.unsubscribe();
    this.listSub = this.api.listGuides(this.fecha()).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar las guías de carga.'); },
    });
    this.api.listLiquidations(this.fecha()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => this.liqs.set(l),
      // Si la lista de liquidaciones falla, las guías siguen sirviendo: no se tapa la pantalla.
      error: () => this.liqs.set(null),
    });
  }

  imprimir(g: LoadGuide): void {
    // La ventana se abre YA, dentro del clic: abrirla al llegar el PDF la bloquearía el navegador.
    const win = window.open('', '_blank');
    this.imprimiendo.set(g.id);
    this.msg.set(null);
    this.api.printGuide(g.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.imprimiendo.set(null);
        const url = URL.createObjectURL(res.body as Blob);
        if (win) {
          win.location.href = url;
        } else {
          this.msg.set({ texto: 'El navegador bloqueó la ventana: permite las ventanas emergentes de este sitio para ver la guía.', mal: true });
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        const folio = res.headers.get('X-Guia-Folio') || g.folio;
        if (win) this.msg.set({ texto: (g.status === 'impresa' ? 'Reimpresión de ' : 'Guía ') + folio + ' lista para imprimir y firmar.', mal: false });
        this.reload();
      },
      error: (e: HttpErrorResponse) => {
        this.imprimiendo.set(null);
        win?.close();
        this.msg.set({ texto: this.errorTexto(e), mal: true });
      },
    });
  }

  /** Con responseType blob, el mensaje del servidor llega como Blob: no se puede leer de forma síncrona. */
  private errorTexto(e: HttpErrorResponse): string {
    if (e.status === 409) return 'La guía cambió o ya no se puede imprimir. Actualiza la lista.';
    if (e.status === 404) return 'Esa guía ya no está disponible para tu sucursal.';
    return 'No se pudo generar la guía.';
  }

  abrirRegreso(orderId: string): void {
    this.regresando.set(orderId);
    this.motivo.set('');
    setTimeout(() => document.getElementById('gc-mot-' + orderId)?.focus());
  }

  registrarRegreso(g: LoadGuide, orderId: string): void {
    this.guardando.set(true);
    this.msg.set(null);
    this.api.returnOrder(g.id, orderId, this.motivo().trim(), this.fecha()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.guardando.set(false);
        this.regresando.set(null);
        this.data.set(d);
        this.msg.set({ texto: 'Regreso registrado: el pedido puede salir otro día en otra guía.', mal: false });
      },
      error: (e: HttpErrorResponse) => {
        this.guardando.set(false);
        const m = (e?.error as { message?: string } | null)?.message;
        this.msg.set({ texto: m || 'No se pudo registrar el regreso.', mal: true });
      },
    });
  }

  fechaHora(isoTs: string | null): string {
    if (!isoTs) return '—';
    return new Date(isoTs).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
