import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { coincideBusqueda } from '@megadulces/ui-web';
import type {
  LoadGuideOrderRow,
  PresaleCandidate,
  PresaleFieldOrderDetail,
  PresaleFieldResponse,
  PresaleOrderRow,
  PresaleStage,
} from '@megadulces/contracts';
import { PresaleLoadService } from './presale-load.service';

const ETAPA: Partial<Record<PresaleStage, string>> = {
  por_surtir: 'Por surtir',
  en_surtido: 'En surtido',
  en_caja: 'En caja',
  cobrado: 'Cobrado',
};

const money = (n: number | null | undefined): string =>
  '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dm = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [, m, d] = v.slice(0, 10).split('-');
  return d + '/' + m;
};

/**
 * `[MCP.5]` Llevar pedidos (Fase MCP, ADR-089): el repartidor o el vendedor elige en su celular los
 * pedidos de preventa que se lleva. Quedan en su guía de carga de hoy (una por ruta), y la cajera la
 * imprime para que la firme (D8).
 *
 * Pescar NO entrega ni cobra: sólo dice quién se lleva qué.
 *
 * `[MCP.6]` En una guía ya impresa, cada pedido se entrega aquí: el repartidor elige el documento
 * de Kepler que entrega (el más parecido al pedido arriba), dice si fue completo o con diferencia y
 * cuánto cobró en efectivo y en transferencia. Si no se pudo, registra el motivo y el pedido queda
 * libre para otro día. Nada de esto factura ni mueve inventario: el cobro ya ocurrió en Kepler.
 */
@Component({
  selector: 'app-presale-load',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="pl">
      <div class="pl-head">
        <div>
          <h1>Llevar pedidos</h1>
          <p class="sub">Elige los pedidos que te llevas. Quedan en tu guía de hoy y la caja la imprime para que la firmes.</p>
        </div>
        <button type="button" class="pl-refresh" [class.spinning]="loading()" [disabled]="loading()" (click)="actualizar()" aria-label="Actualizar"><i class="pi pi-refresh" aria-hidden="true"></i></button>
      </div>

      @if (err(); as e) { <div class="pl-msg bad" role="alert">{{ e }}</div> }
      @if (msg(); as m) { <div class="pl-msg" [class.bad]="m.mal" role="status">{{ m.texto }}</div> }

      <div [attr.inert]="entregaId() ? '' : null">
      @if (loading() && !data()) {
        <div class="pl-skel" aria-busy="true"><div></div><div></div><div></div></div>
      } @else if (data(); as d) {
        @if (d.mine.length) {
          <h2 class="pl-h2">Mis guías de hoy</h2>
          @for (g of d.mine; track g.id) {
            <section class="pl-guia" [class.impresa]="g.status !== 'abierta'">
              <div class="pl-guia-h">
                <div><b class="mono">{{ g.folio }}</b><span class="muted"> · {{ g.sales_route }} · {{ g.branch }}</span></div>
                <span class="pl-tag" [class.ok]="g.status !== 'abierta'">{{ g.status === 'liquidada' ? 'Liquidada' : g.status === 'impresa' ? 'Impresa' : 'Por imprimir' }}</span>
              </div>
              @for (o of ordenados(g.orders); track o.order_id) {
                <div class="pl-guia-o" [class.hecho]="o.status !== 'cargado'">
                  <div class="pl-o-main">
                    <div class="pl-o-id"><span class="pl-o-cli">{{ o.customer_name || '—' }}</span><span class="mono muted">{{ o.code }}</span></div>
                    @if (o.status === 'entregado') {
                      <div class="pl-o-cobro">
                        <span class="pl-chip ok" [class.dif]="o.delivery_outcome === 'con_diferencia'">{{ o.delivery_outcome === 'con_diferencia' ? 'Entregado con diferencia' : 'Entregado' }}</span>
                        <span class="num">{{ cobroTexto(o.cash_amount, o.transfer_amount) }}</span>
                      </div>
                    } @else if (o.status !== 'cargado') {
                      <div class="pl-o-cobro">
                        <span class="pl-chip">{{ o.status === 'regreso' ? 'Regresó a caja' : 'No se entregó' }}</span>
                        @if (o.removed_reason) { <span class="muted">{{ o.removed_reason }}</span> }
                      </div>
                    } @else if (o.order_cancelled) {
                      <div class="pl-o-cobro"><span class="pl-chip bad-chip">Pedido cancelado: no lo entregues, regrésalo a caja</span></div>
                    }
                  </div>
                  <span class="num" [class.tachado]="o.status === 'no_entregado' || o.status === 'regreso' || o.order_cancelled">{{ money(o.document_total ?? o.total) }}</span>
                  @if (g.status === 'abierta') {
                    <button type="button" class="pl-quitar" [disabled]="!!ocupado()" (click)="quitar(o.order_id)" [attr.aria-label]="'Quitar ' + o.code">Quitar</button>
                  } @else if (o.status === 'cargado' && !o.order_cancelled) {
                    <button type="button" class="pl-entregar" [disabled]="!!ocupado()" (click)="abrirEntrega(o.order_id)" [attr.aria-label]="'Entregar ' + o.code">Entregar</button>
                  }
                </div>
              }
              <div class="pl-guia-f">
                <span>{{ enCarga(g.orders) }} {{ enCarga(g.orders) === 1 ? 'pedido' : 'pedidos' }} · <b class="num">{{ money(g.total) }}</b></span>
                <span class="muted">{{ g.status === 'liquidada' ? 'Liquidada en caja (' + (g.liquidation?.folio ?? '') + ').' : g.status === 'impresa' ? pendientesTexto(g.orders) : 'Pide en caja que la impriman para firmarla.' }}</span>
              </div>
            </section>
          }
        }

        <h2 class="pl-h2">Para llevar</h2>
        <p class="pl-src muted">{{ d.source === 'propios' ? 'Pedidos que tú levantaste.' : 'Pedidos de las sucursales que te tocan.' }}</p>
        @if (d.available.length > 6) {
          <input class="pl-q" type="search" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Buscar cliente, folio o ruta" aria-label="Buscar cliente, folio o ruta" />
        }
        @if (!visibles().length) {
          <div class="pl-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>{{ d.available.length ? 'Ningún pedido con esa búsqueda.' : 'No hay pedidos de preventa para llevar.' }}</span></div>
        }
        @for (grupo of grupos(); track grupo.ruta) {
          <div class="pl-ruta">{{ grupo.ruta }} <span class="muted">· {{ grupo.pedidos.length }}</span></div>
          @for (p of grupo.pedidos; track p.id) {
            <label class="pl-card" [class.on]="sel().has(p.id)">
              <input type="checkbox" [checked]="sel().has(p.id)" (change)="toggle(p.id)" [attr.aria-label]="'Llevar ' + p.code" />
              <div class="pl-card-b">
                <div class="pl-card-t"><span class="pl-o-cli">{{ p.customer_name || '—' }}</span><b class="num">{{ money(p.link?.total ?? p.total) }}</b></div>
                <div class="pl-card-s">
                  <span class="mono">{{ p.code }}</span>
                  <span [class.bad]="p.due === 'vencido'">entrega {{ dm(p.requested_delivery_date) }}{{ p.due === 'vencido' ? ' · vencido' : p.due === 'hoy' ? ' · hoy' : '' }}</span>
                  @if (etapa(p.stage); as e) { <span class="pl-chip">{{ e }}</span> }
                  @if (p.link) { <span class="pl-chip ok">Doc. {{ p.link.folio_digital }}</span> }
                </div>
              </div>
            </label>
          }
        }
      }

      </div>

      @if (entregaId()) {
        <div class="pl-sheet" role="dialog" aria-modal="true" aria-labelledby="pl-sheet-t">
          <div class="pl-sheet-h">
            <h2 id="pl-sheet-t" tabindex="-1" #sheetTitle>{{ modo() === 'no' ? 'No se pudo entregar' : 'Entregar pedido' }}</h2>
            <button type="button" class="pl-refresh" (click)="cerrarEntrega()" aria-label="Cerrar"><i class="pi pi-times" aria-hidden="true"></i></button>
          </div>
          @if (errEntrega(); as e) { <div class="pl-msg bad" role="alert">{{ e }}</div> }
          @if (!detalle()) {
            @if (!errEntrega()) { <div class="pl-skel" aria-busy="true"><div></div><div></div></div> }
          } @else if (detalle(); as d) {
            <div class="pl-det">
              <div class="pl-card-t"><span class="pl-o-cli">{{ d.order.customer_name || '—' }}</span><span class="mono">{{ d.order.code }}</span></div>
              <div class="pl-card-s"><span>Guía <span class="mono">{{ d.guide.folio }}</span></span><span>{{ d.order.sales_route || 'Sin ruta' }}</span></div>
              <details class="pl-lines">
                <summary>{{ d.lines.length }} {{ d.lines.length === 1 ? 'producto' : 'productos' }} del pedido</summary>
                @for (l of d.lines; track $index) {
                  <div class="pl-line"><span class="pl-o-main">{{ l.description || l.sku || '—' }}</span><span class="num">{{ l.quantity }} {{ l.unit || '' }}</span></div>
                }
              </details>
            </div>

            @if (modo() === 'entregar') {
              <h3 class="pl-h3">Documento de Kepler que entregas</h3>
              @if (!opciones().length) {
                <div class="pl-msg bad">{{ sinDocumentoTexto(d) }}</div>
              } @else if (d.order.link) {
                <p class="pl-src">La caja ya ligó este documento. Si no es el que entregas, pide en caja que lo corrijan antes de confirmar.</p>
              } @else if (!folio()) {
                <p class="pl-src">Elige el documento que le entregas al cliente.</p>
              }
              @for (c of opciones(); track c.folio_digital) {
                <label class="pl-card" [class.on]="folio() === c.folio_digital" [class.off]="!!c.linked_to_order_code">
                  <input type="radio" name="pl-doc" [checked]="folio() === c.folio_digital" [disabled]="!!c.linked_to_order_code" (change)="elegirDocumento(c.folio_digital)" [attr.aria-label]="'Documento ' + c.folio_digital" />
                  <div class="pl-card-b">
                    <div class="pl-card-t"><span class="mono">{{ c.folio_digital }}</span><b class="num">{{ c.total === null ? '—' : money(c.total) }}</b></div>
                    <div class="pl-card-s">
                      <span>{{ dm(c.fecha) }}{{ c.caja !== null ? ' · caja ' + c.caja : '' }}</span>
                      @if (c.order_products) { <span>{{ c.shared_products }} de {{ c.order_products }} productos del pedido</span> }
                      @if (c.linked_to_order_code) { <span class="bad">Ya es del pedido {{ c.linked_to_order_code }}</span> }
                      @else if (d.order.link?.folio_digital === c.folio_digital) { <span class="pl-chip ok">Ligado en caja</span> }
                    </div>
                  </div>
                </label>
              }

              <h3 class="pl-h3">¿Cómo se entregó?</h3>
              <div class="pl-seg" role="group" aria-label="Resultado de la entrega">
                <button type="button" [attr.aria-pressed]="outcome() === 'completo'" [class.on]="outcome() === 'completo'" (click)="outcome.set('completo')">Completo</button>
                <button type="button" [attr.aria-pressed]="outcome() === 'con_diferencia'" [class.on]="outcome() === 'con_diferencia'" (click)="outcome.set('con_diferencia')">Con diferencia</button>
              </div>
              @if (outcome() === 'con_diferencia') {
                <textarea class="pl-q pl-ta" rows="2" maxlength="500" [ngModel]="nota()" (ngModelChange)="nota.set($event)" placeholder="Qué fue diferente (faltó, sobró, se rechazó…)" aria-label="Qué fue diferente"></textarea>
              }

              <h3 class="pl-h3">Lo que cobraste</h3>
              @if (totalDoc(); as t) {
                <button type="button" class="pl-total" (click)="cobrarTotal(t)">Cobré el total en efectivo · {{ money(t) }}</button>
              }
              <div class="pl-pago">
                <label>Efectivo<input class="pl-q num" type="number" inputmode="decimal" min="0" max="9999999.99" step="0.01" placeholder="0.00" [ngModel]="efectivo()" (ngModelChange)="efectivo.set($event)" /></label>
                <label>Transferencia<input class="pl-q num" type="number" inputmode="decimal" min="0" max="9999999.99" step="0.01" placeholder="0.00" [ngModel]="transf()" (ngModelChange)="transf.set($event)" /></label>
              </div>
              @if (num(transf()) > 0) {
                <input class="pl-q" type="text" maxlength="60" [ngModel]="ref()" (ngModelChange)="ref.set($event)" placeholder="Referencia de la transferencia" aria-label="Referencia de la transferencia" />
              }
              @if (cuadreTexto(); as t) { <p class="pl-src" [class.bad]="t.mal">{{ t.texto }}</p> }

              <button type="button" class="pl-go" [disabled]="!!faltaEntrega() || !!ocupado()" (click)="confirmarEntrega()">
                {{ ocupado() === 'entregar' ? 'Guardando…' : faltaEntrega() || 'Confirmar entrega' }}
              </button>
              <button type="button" class="pl-link" (click)="modo.set('no')">No se pudo entregar</button>
            } @else {
              <p class="pl-src">El pedido sale de tu guía y queda libre para salir otro día.</p>
              <textarea class="pl-q pl-ta" rows="3" maxlength="500" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Por qué no se entregó (cerrado, no estaba, no lo quiso…)" aria-label="Por qué no se entregó"></textarea>
              <button type="button" class="pl-go bad-bg" [disabled]="motivo().trim().length < 5 || !!ocupado()" (click)="confirmarNoEntregado()">
                {{ ocupado() === 'no' ? 'Guardando…' : motivo().trim().length < 5 ? 'Escribe el motivo' : 'Registrar que no se entregó' }}
              </button>
              <button type="button" class="pl-link" (click)="modo.set('entregar')">Volver a entregar</button>
            }
          }
        </div>
      }

      @if (sel().size && !entregaId()) {
        <div class="pl-bar">
          <button type="button" class="pl-go" [disabled]="!!ocupado()" (click)="llevar()">
            {{ ocupado() === 'cargar' ? 'Cargando…' : 'Llevar ' + sel().size + (sel().size === 1 ? ' pedido' : ' pedidos') + ' · ' + money(totalSel()) }}
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .pl { padding:.9rem 1rem 7rem; max-width:720px; margin:0 auto; }
    .pl-head { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; }
    .pl-head h1 { margin:0; font-size:var(--fs-h2); font-weight:700; }
    .sub { margin:.2rem 0 0; font-size:var(--fs-sm); color:var(--text-muted); }
    .pl-refresh { width:2.5rem; height:2.5rem; border-radius:999px; border:1px solid var(--border-color); background:var(--card-bg); color:var(--text-main); flex:none; }
    .pl-refresh.spinning i { animation:pl-spin .9s linear infinite; }
    @keyframes pl-spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .pl-refresh.spinning i { animation:none; } }
    .pl-h2 { font-size:var(--fs-h3); font-weight:700; margin:1.1rem 0 .45rem; }
    .pl-src { font-size:var(--fs-xs); margin:-.25rem 0 .5rem; }
    .pl-msg { margin:.6rem 0; padding:.6rem .75rem; border-radius:10px; background:var(--card-bg); border:1px solid var(--border-color); font-size:var(--fs-sm); }
    .pl-msg.bad, .bad { color:var(--bad-fg); }
    .pl-msg.bad { border-left:3px solid var(--bad-fg); }
    .pl-guia { border:1px solid var(--border-color); border-left:3px solid var(--warn-fg); border-radius:12px; background:var(--card-bg); padding:.6rem .75rem; margin-bottom:.6rem; }
    .pl-guia.impresa { border-left-color:var(--ok-fg); }
    .pl-guia-h { display:flex; justify-content:space-between; align-items:center; gap:.5rem; font-size:var(--fs-body); }
    .pl-tag { font-size:var(--fs-micro); font-weight:700; padding:.15rem .5rem; border-radius:999px; background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .pl-tag.ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .pl-guia-o { display:flex; align-items:center; gap:.5rem; padding:.4rem 0; border-bottom:1px dashed var(--border-color); font-size:var(--fs-sm); }
    .pl-o-main { flex:1; min-width:0; }
    .pl-o-id { display:flex; flex-direction:column; min-width:0; }
    .pl-o-id .pl-o-cli { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pl-o-id .mono { font-size:var(--fs-xs); }
    .pl-o-cli { font-weight:600; }
    .pl-quitar { border:1px solid var(--border-color); background:transparent; color:var(--text-main); border-radius:8px; padding:.35rem .6rem; font-size:var(--fs-xs); min-height:2.25rem; }
    .pl-guia-f { display:flex; justify-content:space-between; gap:.5rem; flex-wrap:wrap; font-size:var(--fs-xs); padding-top:.45rem; }
    .pl-q { width:100%; height:2.75rem; border:1px solid var(--border-color); border-radius:10px; padding:0 .75rem; background:var(--card-bg); color:var(--text-main); font-size:var(--fs-body); margin-bottom:.5rem; }
    .pl-ruta { font-size:var(--fs-xs); font-weight:700; text-transform:uppercase; letter-spacing:.04em; margin:.8rem 0 .35rem; }
    .pl-card { display:flex; gap:.65rem; align-items:flex-start; border:1px solid var(--border-color); border-radius:12px; background:var(--card-bg); padding:.7rem .75rem; margin-bottom:.45rem; cursor:pointer; }
    .pl-card.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pl-card input { width:1.3rem; height:1.3rem; margin-top:.1rem; accent-color:var(--action); flex:none; }
    .pl-card-b { flex:1; min-width:0; display:flex; flex-direction:column; gap:.25rem; }
    .pl-card-t { display:flex; justify-content:space-between; gap:.5rem; font-size:var(--fs-body); }
    .pl-card-t .pl-o-cli { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pl-card-s { display:flex; flex-wrap:wrap; gap:.25rem .6rem; font-size:var(--fs-xs); color:var(--text-muted); align-items:center; }
    .pl-chip { padding:.05rem .45rem; border-radius:999px; background:var(--hover-bg); color:var(--text-main); }
    .pl-chip.ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .pl-chip.ok.dif { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .pl-chip.bad-chip { background:var(--bad-soft-bg); color:var(--bad-fg); }
    .pl-empty { display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:1.5rem; color:var(--text-muted); text-align:center; font-size:var(--fs-body); }
    .pl-skel { display:flex; flex-direction:column; gap:.5rem; margin-top:1rem; }
    .pl-skel div { height:4.5rem; border-radius:12px; background:var(--hover-bg); }
    .pl-bar { position:fixed; left:0; right:0; bottom:calc(3.6rem + env(safe-area-inset-bottom)); padding:.6rem 1rem; background:linear-gradient(transparent, var(--layout-bg) 30%); }
    .pl-go { width:100%; max-width:720px; display:block; margin:0 auto; min-height:3rem; border:0; border-radius:12px; background:var(--action); color:var(--action-ink); font-weight:700; font-size:var(--fs-h3); }
    .pl-go:disabled { opacity:.6; }
    .pl-card:focus-within, .pl-go:focus-visible, .pl-quitar:focus-visible, .pl-refresh:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .pl-guia-o.hecho { opacity:.8; }
    .tachado { text-decoration:line-through; color:var(--text-muted); }
    .pl-total { width:100%; min-height:2.75rem; margin-bottom:.5rem; border:1px dashed var(--action); border-radius:10px; background:transparent; color:var(--text-main); font-size:var(--fs-body); font-weight:600; }
    .pl-total:focus-visible, .pl-sheet-h h2:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .pl-o-cobro { display:flex; flex-wrap:wrap; gap:.2rem .4rem; align-items:center; margin-top:.15rem; font-size:var(--fs-xs); }
    .pl-entregar { border:0; background:var(--action); color:var(--action-ink); border-radius:8px; padding:.35rem .75rem; font-size:var(--fs-sm); font-weight:700; min-height:2.5rem; flex:none; }
    .pl-sheet { position:fixed; inset:0; z-index:40; overflow-y:auto; background:var(--layout-bg); padding:.9rem 1rem calc(6rem + env(safe-area-inset-bottom)); }
    .pl-sheet > * { max-width:720px; margin-left:auto; margin-right:auto; }
    .pl-sheet-h { display:flex; justify-content:space-between; align-items:center; gap:.75rem; }
    .pl-sheet-h h2 { margin:0; font-size:var(--fs-h2); font-weight:700; }
    .pl-det { border:1px solid var(--border-color); border-radius:12px; background:var(--card-bg); padding:.7rem .75rem; margin-top:.75rem; display:flex; flex-direction:column; gap:.3rem; }
    .pl-lines summary { font-size:var(--fs-sm); cursor:pointer; padding:.3rem 0; min-height:2.25rem; display:flex; align-items:center; }
    .pl-line { display:flex; gap:.5rem; font-size:var(--fs-xs); padding:.25rem 0; border-top:1px dashed var(--border-color); }
    .pl-h3 { font-size:var(--fs-body); font-weight:700; margin:1rem 0 .45rem; }
    .pl-card.off { opacity:.55; cursor:not-allowed; }
    .pl-seg { display:flex; gap:.4rem; }
    .pl-seg button { flex:1; min-height:2.75rem; border:1px solid var(--border-color); border-radius:10px; background:var(--card-bg); color:var(--text-main); font-size:var(--fs-body); font-weight:600; }
    .pl-seg button.on { border-color:var(--action); box-shadow:0 0 0 1px var(--action); }
    .pl-ta { height:auto; padding:.6rem .75rem; margin-top:.5rem; font-family:inherit; resize:vertical; }
    .pl-pago { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }
    .pl-pago label { display:flex; flex-direction:column; gap:.2rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .pl-pago .pl-q { margin-bottom:0; }
    .pl-sheet .pl-go { margin-top:1rem; }
    .pl-sheet .pl-src { margin:.6rem 0; }
    .pl-go.bad-bg { background:var(--bad-fg); }
    .pl-link { display:block; margin:.75rem auto 0; border:0; background:transparent; color:var(--text-muted); text-decoration:underline; font-size:var(--fs-sm); min-height:2.5rem; }
    .pl-entregar:focus-visible, .pl-seg button:focus-visible, .pl-link:focus-visible, .pl-q:focus-visible, .pl-lines summary:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
  `],
})
export class PresaleLoadComponent implements OnInit {
  private readonly api = inject(PresaleLoadService);
  private readonly destroyRef = inject(DestroyRef);
  private sub: Subscription | null = null;

  readonly money = money;
  readonly dm = dm;

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly msg = signal<{ texto: string; mal: boolean } | null>(null);
  readonly data = signal<PresaleFieldResponse | null>(null);
  readonly sel = signal<Set<string>>(new Set());
  readonly q = signal('');
  readonly ocupado = signal<'cargar' | 'quitar' | 'detalle' | 'entregar' | 'no' | null>(null);

  // [MCP.6] Hoja de entrega.
  readonly entregaId = signal<string | null>(null);
  readonly detalle = signal<PresaleFieldOrderDetail | null>(null);
  readonly errEntrega = signal<string | null>(null);
  readonly modo = signal<'entregar' | 'no'>('entregar');
  readonly folio = signal<string | null>(null);
  readonly outcome = signal<'completo' | 'con_diferencia'>('completo');
  readonly nota = signal('');
  /** Importes: empiezan VACÍOS a propósito. Lo cobrado lo escribe quien entrega (un 0 se escribe). */
  readonly efectivo = signal<number | string | null>(null);
  readonly transf = signal<number | string | null>(null);
  readonly ref = signal('');
  readonly motivo = signal('');
  private subDet: Subscription | null = null;
  private regresarFoco: HTMLElement | null = null;
  private readonly sheetTitle = viewChild<ElementRef<HTMLElement>>('sheetTitle');

  /**
   * Documentos para elegir. Si la caja ya ligó uno, SÓLO ése: cualquier otro lo rechazaría el
   * servidor (la liga se corrige en la mesa, no en la calle). Si no hay liga, los candidatos.
   */
  readonly opciones = computed<PresaleCandidate[]>(() => {
    const d = this.detalle();
    if (!d) return [];
    const link = d.order.link;
    if (!link) return d.candidates;
    const mismo = d.candidates.find((c) => c.folio_digital === link.folio_digital);
    return [mismo ?? { ...link, cashier_name: null, shared_products: 0, order_products: 0, linked_to_order_code: null }];
  });
  readonly totalDoc = computed(() => this.opciones().find((c) => c.folio_digital === this.folio())?.total ?? null);
  private readonly escribio = computed(() => this.vacio(this.efectivo()) === false || this.vacio(this.transf()) === false);
  /** Lo que falta para poder confirmar; `null` = listo. Es el texto del botón. */
  readonly faltaEntrega = computed<string | null>(() => {
    if (!this.folio()) return 'Elige el documento';
    if (this.outcome() === 'con_diferencia' && this.nota().trim().length < 5) return 'Escribe qué fue diferente';
    if (!this.escribio()) return 'Escribe lo que cobraste (0 si nada)';
    const e = this.num(this.efectivo());
    const t = this.num(this.transf());
    if (!Number.isFinite(e) || !Number.isFinite(t) || e < 0 || t < 0 || e > 9999999.99 || t > 9999999.99) return 'Revisa los importes';
    if (t > 0 && !this.ref().trim()) return 'Falta la referencia';
    return null;
  });
  /** Cuadre contra el documento: avisa, no bloquea (puede haber diferencia real o pago a cuenta). */
  readonly cuadreTexto = computed<{ texto: string; mal: boolean } | null>(() => {
    const doc = this.totalDoc();
    const e = this.num(this.efectivo());
    const t = this.num(this.transf());
    if (doc === null || !this.escribio() || !Number.isFinite(e) || !Number.isFinite(t)) return null;
    const dif = Math.round((e + t - doc) * 100) / 100;
    if (Math.abs(dif) < 0.01) return { texto: 'Cobrado completo: ' + money(e + t) + '.', mal: false };
    return { texto: 'Cobras ' + money(e + t) + ' de un documento de ' + money(doc) + (dif < 0 ? ' (faltan ' + money(-dif) + ').' : ' (sobran ' + money(dif) + ').'), mal: true };
  });

  readonly visibles = computed<PresaleOrderRow[]>(() =>
    (this.data()?.available ?? []).filter((p) =>
      coincideBusqueda(this.q(), p.customer_name, p.code, p.sales_route, p.customer_erp_code)),
  );
  readonly grupos = computed(() => {
    const m = new Map<string, PresaleOrderRow[]>();
    for (const p of this.visibles()) {
      const k = p.sales_route || 'Sin ruta';
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ruta, pedidos]) => ({ ruta, pedidos }));
  });
  readonly totalSel = computed(() =>
    (this.data()?.available ?? []).filter((p) => this.sel().has(p.id)).reduce((t, p) => t + (p.link?.total ?? p.total), 0),
  );

  ngOnInit(): void {
    this.reload();
    this.destroyRef.onDestroy(() => { this.sub?.unsubscribe(); this.subDet?.unsubscribe(); });
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.sub?.unsubscribe();
    this.sub = this.api.campo().subscribe({
      next: (d) => this.aplicar(d),
      error: (e: HttpErrorResponse) => {
        this.loading.set(false);
        this.err.set(e?.status === 0 ? 'Sin conexión: revisa tu señal y actualiza.' : e?.status === 403 ? 'Tu usuario no tiene permiso para llevar pedidos.' : 'No se pudieron cargar los pedidos. Actualiza en un momento.');
      },
    });
  }

  toggle(id: string): void {
    const s = new Set(this.sel());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.sel.set(s);
  }

  llevar(): void {
    const ids = [...this.sel()];
    if (!ids.length) return;
    this.ocupado.set('cargar');
    this.msg.set(null);
    this.api.cargar(ids).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.ocupado.set(null);
        this.aplicar(d);
        this.msg.set({ texto: ids.length + (ids.length === 1 ? ' pedido quedó' : ' pedidos quedaron') + ' en tu guía. Pide en caja que la impriman.', mal: false });
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.msg.set({ texto: this.errorTexto(e, 'No se pudieron cargar los pedidos.'), mal: true }); this.reload(); },
    });
  }

  quitar(orderId: string): void {
    this.ocupado.set('quitar');
    this.msg.set(null);
    this.api.quitar(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.ocupado.set(null); this.aplicar(d); },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.msg.set({ texto: this.errorTexto(e, 'No se pudo quitar el pedido.'), mal: true }); this.reload(); },
    });
  }

  etapa(s: PresaleStage): string | null { return ETAPA[s] ?? null; }

  // ─────────────────────────────────────────────── entrega (MCP.6) ──

  abrirEntrega(orderId: string): void {
    this.regresarFoco = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.entregaId.set(orderId);
    this.detalle.set(null);
    this.errEntrega.set(null);
    this.modo.set('entregar');
    this.folio.set(null);
    this.outcome.set('completo');
    this.nota.set('');
    this.efectivo.set(null);
    this.transf.set(null);
    this.ref.set('');
    this.motivo.set('');
    // El foco entra a la hoja: quien usa lector de pantalla o teclado sabe dónde quedó.
    setTimeout(() => this.sheetTitle()?.nativeElement.focus());
    this.subDet?.unsubscribe();
    this.subDet = this.api.detalle(orderId).subscribe({
      next: (d) => {
        if (this.entregaId() !== orderId) return;
        this.detalle.set(d);
        // Preselección PRUDENTE: el ligado en caja, el único candidato, o el primero si comparte
        // productos con el pedido. Uno que no comparte nada lo tiene que elegir el repartidor.
        const ops = this.opciones();
        const libres = ops.filter((c) => !c.linked_to_order_code);
        const elegido = d.order.link
          ? ops[0]
          : libres.length === 1 ? libres[0] : libres[0]?.shared_products > 0 ? libres[0] : undefined;
        if (elegido) this.elegirDocumento(elegido.folio_digital);
      },
      error: (e: HttpErrorResponse) => this.errEntrega.set(this.errorTexto(e, 'No se pudo abrir el pedido. Actualiza en un momento.')),
    });
  }

  @HostListener('document:keydown.escape')
  cerrarEntrega(): void {
    if (!this.entregaId() || this.ocupado() === 'entregar' || this.ocupado() === 'no') return;
    this.subDet?.unsubscribe();
    this.entregaId.set(null);
    this.detalle.set(null);
    const foco = this.regresarFoco;
    this.regresarFoco = null;
    if (foco?.isConnected) setTimeout(() => foco.focus());
  }

  /** Elegir el documento NO llena importes: lo cobrado lo declara quien entrega. */
  elegirDocumento(folio: string): void {
    this.folio.set(folio);
  }

  /** Atajo para el caso común: todo en efectivo, por el total del documento. */
  cobrarTotal(total: number): void {
    this.efectivo.set(total);
    this.transf.set(0);
    this.ref.set('');
  }

  confirmarEntrega(): void {
    const orderId = this.entregaId();
    const folio = this.folio();
    if (!orderId || !folio || this.faltaEntrega()) return;
    const t = this.num(this.transf());
    this.ocupado.set('entregar');
    this.errEntrega.set(null);
    this.api.entregar({
      order_id: orderId,
      folio_digital: folio,
      outcome: this.outcome(),
      note: this.nota().trim() || undefined,
      cash_amount: this.num(this.efectivo()),
      transfer_amount: t,
      transfer_ref: t > 0 ? this.ref().trim() : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.ocupado.set(null);
        this.aplicar(d);
        this.cerrarEntrega();
        this.msg.set({ texto: 'Entrega registrada con el documento ' + folio + '.', mal: false });
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.errEntrega.set(this.errorTexto(e, 'No se pudo registrar la entrega.')); },
    });
  }

  confirmarNoEntregado(): void {
    const orderId = this.entregaId();
    const reason = this.motivo().trim();
    if (!orderId || reason.length < 5) return;
    this.ocupado.set('no');
    this.errEntrega.set(null);
    this.api.noEntregado({ order_id: orderId, reason }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.ocupado.set(null);
        this.aplicar(d);
        this.cerrarEntrega();
        this.msg.set({ texto: 'Quedó registrado que no se entregó. El pedido queda libre para otro día.', mal: false });
      },
      error: (e: HttpErrorResponse) => { this.ocupado.set(null); this.errEntrega.set(this.errorTexto(e, 'No se pudo registrar.')); },
    });
  }

  sinDocumentoTexto(d: PresaleFieldOrderDetail): string {
    const ojo = ' Si sí lo entregaste, NO marques «No se pudo entregar»: avisa en caja.';
    if (d.order.link_block === 'cliente_sin_clave') return 'El cliente no tiene clave de Kepler: no hay documento con qué registrar la entrega.' + ojo;
    if (d.order.link_block) return 'No se pueden buscar documentos de Kepler para este cliente.' + ojo;
    return 'Todavía no aparece ningún documento de Kepler de este cliente (puede tardar unos minutos en llegar). Actualiza en un momento.' + ojo;
  }

  cobroTexto(efectivo: number | null, transferencia: number | null): string {
    const partes: string[] = [];
    if (efectivo) partes.push(money(efectivo) + ' efectivo');
    if (transferencia) partes.push(money(transferencia) + ' transf.');
    return partes.length ? partes.join(' + ') : 'sin cobro';
  }

  /** Lo que falta entregar primero; lo entregado y lo que volvió, al final. */
  ordenados(orders: LoadGuideOrderRow[]): LoadGuideOrderRow[] {
    const peso = (o: LoadGuideOrderRow) => (o.status === 'cargado' ? 0 : o.status === 'entregado' ? 1 : 2);
    return [...orders].sort((a, b) => peso(a) - peso(b));
  }

  /** Pedidos que siguen en la carga (en camino o entregados); lo que volvió no cuenta. */
  enCarga(orders: LoadGuideOrderRow[]): number {
    return orders.filter((o) => o.status === 'cargado' || o.status === 'entregado').length;
  }

  /** El botón de actualizar también borra el aviso anterior. */
  actualizar(): void {
    this.msg.set(null);
    this.reload();
  }

  pendientesTexto(orders: LoadGuideOrderRow[]): string {
    const faltan = orders.filter((o) => o.status === 'cargado').length;
    const volvieron = orders.filter((o) => o.status === 'no_entregado' || o.status === 'regreso').length;
    if (faltan) return (faltan === 1 ? 'Te falta 1' : 'Te faltan ' + faltan) + ' por entregar.';
    return volvieron ? 'Terminaste: ' + volvieron + (volvieron === 1 ? ' no se entregó.' : ' no se entregaron.') : 'Todo entregado.';
  }

  num(v: number | string | null | undefined): number {
    if (this.vacio(v)) return 0;
    return Number(v);
  }

  private vacio(v: number | string | null | undefined): boolean {
    return v === null || v === undefined || String(v).trim() === '';
  }

  private aplicar(d: PresaleFieldResponse): void {
    this.data.set(d);
    this.loading.set(false);
    // La selección sólo conserva lo que sigue disponible.
    const libres = new Set(d.available.map((p) => p.id));
    this.sel.set(new Set([...this.sel()].filter((id) => libres.has(id))));
  }

  private errorTexto(e: HttpErrorResponse, defecto: string): string {
    const m = (e?.error as { message?: string | string[] } | null)?.message;
    return Array.isArray(m) ? m.join(' ') : m || defecto;
  }

}
