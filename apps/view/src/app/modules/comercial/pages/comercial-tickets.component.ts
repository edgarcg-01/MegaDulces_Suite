import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { InputTextModule } from 'primeng/inputtext';
import { Subject, catchError, map, of, switchMap, tap, timer } from 'rxjs';
import { TicketsService, TicketCandidato, BandejaFila, BandejaTickets, ClienteCandidato } from '../tickets.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { desgloseDe, desgloseTotalDe, imprimirTicketVenta, TicketVenta } from '../ticket-venta';

/**
 * Fase TK.2 — Tickets de venta. Buscar un folio y reimprimirlo.
 *
 * Superficie **Operations** (`DESIGN.md`): sin Fraunces, sin ilustraciones, densidad compacta,
 * master-detail. Se busca arriba, los candidatos a la izquierda y el documento a la derecha.
 *
 * ⚠️ **Los candidatos NO se resuelven solos, ni siquiera cuando hay uno.** Bueno: cuando hay
 * exactamente uno sí se abre, porque ahí no hay ambigüedad que resolver. Con dos o más, elige
 * la persona — el folio no identifica un documento (cada sucursal y cada caja tienen su propio
 * contador; medido: `0018665` existe 7 veces) y "el primero de la lista" sería el dinero de
 * otra tienda.
 */
/** Hoy en México como AAAA-MM-DD. `toISOString()` daría mañana después de las 18:00. */
function hoyMx(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

/**
 * Suma días a una fecha AAAA-MM-DD sin pasar por la zona del navegador: a mediodía UTC ningún
 * huso de México mueve el día. `''` si la fecha viene rota (un `type=date` a medio teclear).
 */
export function sumarDias(iso: string, dias: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** El mismo tope que `BandejaTicketsService.MAX_DIAS`. El backend es el que manda. */
const MAX_DIAS_BANDEJA = 31;

@Component({
  selector: 'app-comercial-tickets',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, ToastModule, RouterLink,
    SelectModule, AutoCompleteModule, InputTextModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Tickets de venta</h1>
          <p class="surf-page-sub">Busca cualquier folio y reimprímelo con el descuento desglosado</p>
        </div>
        <!-- TK.8 — La otra pregunta ("todo lo de un cliente") vive en su propia sección: esta
             pantalla no cambia. -->
        <a class="tk-reporte" routerLink="/comercial/tickets/reporte">
          <i class="pi pi-users" aria-hidden="true"></i>Reporte por cliente
        </a>
      </header>

      <!-- TK.12 — Filtros de la bandeja. Todo lo que se lista sale de ESTOS filtros; el
           buscador de la bandeja afina dentro de ellos. -->
      <div class="tk-filtros card-premium card-flat">
        @if ((sucursales() ?? []).length > 1) {
          <p-select [ngModel]="fSucursal()" (ngModelChange)="fSucursal.set($event); recargar()"
                    [options]="sucursales() ?? []" optionLabel="label" optionValue="value"
                    placeholder="Todas las sucursales" [showClear]="true" [filter]="(sucursales() ?? []).length > 8"
                    class="tk-sel" appendTo="body" ariaLabel="Sucursal" />
        } @else if ((sucursales() ?? []).length === 1) {
          <!-- Una sola sucursal alcanzable: es un hecho de la sesión, no una opción. -->
          <span class="tk-fija"><i class="pi pi-building" aria-hidden="true"></i>{{ sucursales()![0].label }}</span>
        } @else if (sucursales() !== null) {
          <span class="tk-fija tk-sin"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>Sin sucursal asignada</span>
        }

        <div class="tk-fecha">
          <!-- El rango máximo (31 días) lo hace cumplir el backend; acá el calendario no deja
               elegir más, y si se TECLEA una fecha fuera de rango se recorre la otra punta. -->
          <input pInputText type="date" [ngModel]="fDesde()" [min]="masDias(fHasta(), -(MAX_DIAS - 1))" [max]="fHasta()"
                 (ngModelChange)="cambiarDesde($event)" aria-label="Desde" />
          <span aria-hidden="true">→</span>
          <input pInputText type="date" [ngModel]="fHasta()" [min]="fDesde()" [max]="masDias(fDesde(), MAX_DIAS - 1)"
                 (ngModelChange)="cambiarHasta($event)" aria-label="Hasta" />
        </div>

        <p-autocomplete [(ngModel)]="clienteSel" [suggestions]="clienteSugs()"
                        (completeMethod)="buscarClientes($event.query)"
                        (onSelect)="elegirCliente($event.value)" (onClear)="elegirCliente(null)"
                        optionLabel="nombre" [delay]="250" [minQueryLength]="2" [showClear]="true"
                        [forceSelection]="true" appendTo="body" class="tk-cli"
                        placeholder="Cliente (clave o nombre)" ariaLabel="Cliente">
          <ng-template let-c #item>
            <div class="tk-ac">
              <b>{{ c.nombre || 'Sin nombre' }}</b>
              <span class="tk-mono">{{ c.cliente_code }}@if (c.ciudad) { · {{ c.ciudad }} }</span>
            </div>
          </ng-template>
        </p-autocomplete>
      </div>

      <div class="tk-split">
          <aside class="tk-lista">
            <div class="tk-bsearch">
              <i class="pi pi-search" aria-hidden="true"></i>
              <input type="search" autocomplete="off" [ngModel]="qBandeja()"
                     (ngModelChange)="escribir($event)" (keyup.enter)="recargar()"
                     placeholder="Folio, número o nombre del cliente" aria-label="Buscar en la bandeja" />
            </div>

            @if (modoFolio(); as f) {
              <p class="tk-modo">
                <span>Folio <b class="tk-mono">{{ f }}</b> en todas las fechas</span>
                <button type="button" class="tk-link" (click)="volverBandeja()">Volver a la bandeja</button>
              </p>
            }

            <div class="tk-lista-head">
              @if (cargandoBandeja()) { <span>Cargando…</span> }
              @else {
                <span>{{ candidatos().length }} documento{{ candidatos().length === 1 ? '' : 's' }}</span>
                @if (!modoFolio() && candidatos().length) {
                  <span class="tk-mono">{{ importe() | currency:'MXN':'symbol-narrow' }}</span>
                }
              }
            </div>
            @if (aviso(); as a) { <p class="tk-aviso"><i class="pi pi-info-circle" aria-hidden="true"></i>{{ a }}</p> }
            @if (modoFolio() && candidatos().length > 1) {
              <p class="tk-aviso">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                El mismo folio existe en varias cajas o sucursales. Elige el correcto por fecha e importe.
              </p>
            }

            @if (!cargandoBandeja() && !buscando() && !candidatos().length && !modoFolio()) {
              <div class="tk-vacio-lista">
                <!-- Un vacío no es evidencia de que el humano se equivocó: se dice DÓNDE se buscó. -->
                <p>Nada en {{ fSucursal() ? 'esta sucursal' : 'tus sucursales' }} del {{ fDesde() | date:'dd/MM/yy' }}
                   al {{ fHasta() | date:'dd/MM/yy' }}{{ qBandeja().trim() ? ' con «' + qBandeja().trim() + '»' : '' }}.</p>
                @if (qBandeja().trim() && !modoFolio()) {
                  <button pButton size="small" [text]="true" [loading]="buscando()" (click)="buscarFolioGlobal()">
                    Buscar «{{ qBandeja().trim() }}» como folio en todas las fechas
                  </button>
                }
              </div>
            }

            <ul class="tk-cands">
              @for (c of candidatos(); track c.id) {
                <li>
                  <button type="button" class="tk-cand" [class.sel]="c.id === seleccionado()"
                          (click)="abrir(c)">
                    <span class="tk-cand-top">
                      <p-tag [value]="c.origen_label" [severity]="sev(c.origen)"></p-tag>
                      <b class="tk-mono">{{ c.total | currency:'MXN':'symbol-narrow' }}</b>
                    </span>
                    <span class="tk-cand-mid">{{ c.sucursal_nombre || c.sucursal || 'sin sucursal' }}
                      @if (c.caja != null) { <i>· caja {{ c.caja }}</i> }
                    </span>
                    <span class="tk-cand-bot">
                      <span class="tk-mono">{{ c.folio }}</span>
                      <span>{{ c.fecha ? (c.fecha + 'T12:00:00' | date:'dd/MM/yy') : 'sin fecha' }}</span>
                    </span>
                    <span class="tk-cand-cli">@if (clave(c); as k) { <span class="tk-mono">{{ k }}</span> · }{{ c.cliente_nombre || 'Público en general' }}</span>
                  </button>
                </li>
              }
            </ul>
          </aside>

          <section class="tk-doc">
            @if (cargando()) { <div class="tk-cargando">Cargando documento…</div> }
            @else if (doc(); as d) {
              <div class="tk-doc-head">
                <div>
                  <div class="tk-doc-sub">{{ d.doc_label || d.origen_label }}</div>
                  <h2 class="tk-mono">{{ d.id }}</h2>
                </div>
                <div class="tk-acciones">
                  <button pButton size="small" (click)="imprimir(d)">
                    <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>Ticket
                  </button>
                  <button pButton size="small" [text]="true" severity="secondary"
                          [loading]="generandoPdf()" (click)="carta(d)">
                    <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>Carta (PDF)
                  </button>
                </div>
              </div>

              @if (d.aviso) { <div class="tk-warn">{{ d.aviso }}</div> }

              <dl class="tk-meta">
                <div><dt>Sucursal</dt><dd>{{ d.sucursal_nombre || d.sucursal || '—' }}</dd></div>
                @if (d.caja != null) { <div><dt>Caja</dt><dd>{{ d.caja }}</dd></div> }
                <div><dt>Fecha</dt><dd>{{ d.fecha ? (d.fecha + 'T12:00:00' | date:'dd/MM/yyyy') : '—' }}</dd></div>
                <div><dt>Cliente</dt><dd>{{ d.cliente_nombre || 'Público en general' }}</dd></div>
                @if (d.atendio) { <div><dt>{{ d.atendio_rol || 'Atendió' }}</dt><dd>{{ d.atendio }}</dd></div> }
              </dl>
              <!-- Se declara por qué no hay hora, en vez de dejar el hueco mudo o inventarla. -->
              @if (d.hora_motivo) { <p class="tk-nota">{{ d.hora_motivo }}</p> }

              <!-- [TK.13] Cada partida: un renglon POR PIEZA y, si la cantidad no es 1, otro con el
                   TOTAL de la partida. Mismas columnas que la carta PDF, en el orden de la cuenta:
                   lista - descuento = c/desc -> sin impuestos + IVA/IEPS = neto. -->
              @if (vista(); as v) {
                <div class="tk-tabla">
                  <table class="surf-table tk-det">
                    <thead>
                      <tr>
                        <th scope="col">Producto</th>
                        <th scope="col" class="tk-num">Cant.</th>
                        @if (v.cols.lista) { <th scope="col" class="tk-num">Precio lista</th> }
                        @if (v.cols.desc) { <th scope="col" class="tk-num">Descuento</th> }
                        <th scope="col" class="tk-num">Precio c/desc</th>
                        @if (v.cols.imp) { <th scope="col" class="tk-num">Sin impuestos</th> }
                        @if (v.cols.iva) { <th scope="col" class="tk-num">IVA</th> }
                        @if (v.cols.ieps) { <th scope="col" class="tk-num">IEPS</th> }
                        <th scope="col" class="tk-num">Neto</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (f of v.filas; track f.l.linea) {
                        <tr class="tk-u" [class.tk-u-sola]="f.l.cantidad === 1">
                          <td>
                            <div class="tk-prod">{{ f.l.descripcion || f.l.sku }}</div>
                            <div class="tk-sku">Código {{ f.l.sku || 's/c' }}@if (f.l.equivalencia) { <span> · equivale a {{ f.l.equivalencia }}</span> }</div>
                          </td>
                          <!-- [TK.13] Mismo acomodo que la carta PDF: el renglón del producto trae los
                               valores POR PIEZA sin neto; el de la partida, «PZA × 4» y el neto. Con
                               una pieza, un solo renglón con «PZA × 1» y su neto. -->
                          @if (f.l.cantidad === 1) {
                            <td class="tk-num">{{ f.l.unidad }} × 1</td>
                            <ng-container *ngTemplateOutlet="celdas; context: { m: f.d.partida, c: v.cols, l: f.l, neto: true }" />
                          } @else {
                            <td class="tk-num tk-vu">Valor unitario</td>
                            <ng-container *ngTemplateOutlet="celdas; context: { m: f.d.unitario, c: v.cols, l: f.l, neto: false }" />
                          }
                        </tr>
                        @if (f.l.cantidad !== 1) {
                          <tr class="tk-pt">
                            <td class="tk-pt-l">Total partida</td>
                            <td class="tk-num">{{ f.l.unidad }} × {{ f.l.cantidad }}</td>
                            <ng-container *ngTemplateOutlet="celdas; context: { m: f.d.partida, c: v.cols, l: f.l, neto: true }" />
                          </tr>
                        }
                      }
                    </tbody>
                    <tfoot>
                      <tr class="tk-tot">
                        <td>Totales</td><td></td>
                        <ng-container *ngTemplateOutlet="celdas; context: { m: v.total, c: v.cols, l: null, neto: true }" />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                @if (!v.cols.imp) {
                  <p class="tk-nota">No se desglosan impuestos: la suma por producto no reproduce la que declara el documento en el ERP.</p>
                }
              }

              <!-- Las celdas de dinero de un juego de valores. Guion, no $0.00: un producto que no
                   causa IEPS no es uno al que se le cobro cero; "sin dato" = no se puede publicar. -->
              <ng-template #celdas let-m="m" let-c="c" let-l="l" let-neto="neto">
                @if (c.lista) {
                  <td class="tk-num" [class.tk-tachado]="m.descuento > 0">{{ m.lista != null ? (m.lista | currency:'MXN':'symbol-narrow') : '—' }}</td>
                }
                @if (c.desc) {
                  <td class="tk-num tk-ahorro">{{ m.descuento > 0 ? ('-' + (m.descuento | currency:'MXN':'symbol-narrow')) : '' }}</td>
                }
                <td class="tk-num tk-fuerte">{{ m.con_descuento | currency:'MXN':'symbol-narrow' }}</td>
                @if (c.imp) {
                  <td class="tk-num tk-sinimp">{{ m.sin_impuestos != null ? (m.sin_impuestos | currency:'MXN':'symbol-narrow') : 'sin dato' }}</td>
                }
                @if (c.iva) {
                  <td class="tk-num">@if (m.iva > 0) { {{ m.iva | currency:'MXN':'symbol-narrow' }}@if (l) { <i class="tk-uni">{{ l.iva_tasa * 100 | number:'1.0-0' }}%</i> } } @else { — }</td>
                }
                @if (c.ieps) {
                  <td class="tk-num">@if (m.ieps > 0) { {{ m.ieps | currency:'MXN':'symbol-narrow' }}@if (l) { <i class="tk-uni">{{ l.ieps_tasa * 100 | number:'1.0-0' }}%</i> } } @else { — }</td>
                }
                <td class="tk-num tk-fuerte">{{ neto ? (m.neto | currency:'MXN':'symbol-narrow') : '' }}</td>
              </ng-template>

              <div class="tk-cierre">
                @if (vista(); as v) {
                <table class="tk-res">
                  <tbody>
                    <!-- Sale del MISMO desglose que la fila de Totales: si saliera de la cabecera
                         del ERP, la pantalla podria decir dos IVA distintos por un centavo. -->
                    @if (v.total.descuento > 0 && v.total.lista != null) {
                      <tr><td>Precio de lista</td><td class="tk-num">{{ v.total.lista | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (d.cascada.descuento_precio > 0) {
                      <tr class="tk-desc"><td>Descuento en precio</td><td class="tk-num">-{{ d.cascada.descuento_precio | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    <!-- [TK.d2] El importe es el MEDIDO (suma de renglones menos total), no kdm1.c13 (TK.d3b). -->
                    @if (d.cascada.descuento_documento > 0) {
                      <tr class="tk-desc"><td>Descuento de cliente
                        @if (d.cascada.descuento_documento_pct_erp) { <i>({{ d.cascada.descuento_documento_pct_erp }}% declarado en Kepler)</i> }
                      </td><td class="tk-num">-{{ d.cascada.descuento_documento | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (d.cascada.descuento_documento < 0) {
                      <tr><td>Ajuste de redondeo</td><td class="tk-num">{{ -d.cascada.descuento_documento | currency:'MXN':'symbol-narrow' }}</td></tr>
                    }
                    @if (v.total.sin_impuestos != null) {
                      <tr><td>Subtotal sin impuestos</td><td class="tk-num">{{ v.total.sin_impuestos | currency:'MXN':'symbol-narrow' }}</td></tr>
                      @if (v.total.iva) { <tr><td>IVA</td><td class="tk-num">{{ v.total.iva | currency:'MXN':'symbol-narrow' }}</td></tr> }
                      @if (v.total.ieps) { <tr><td>IEPS</td><td class="tk-num">{{ v.total.ieps | currency:'MXN':'symbol-narrow' }}</td></tr> }
                    }
                    <tr class="tk-total"><td>Total pagado</td><td class="tk-num">{{ d.cascada.total | currency:'MXN':'symbol-narrow' }}</td></tr>
                  </tbody>
                </table>
                }
                @if (d.cascada.descuento_total > 0) {
                  <div class="tk-ahorraste">
                    <i>El cliente ahorró</i>
                    {{ d.cascada.descuento_total | currency:'MXN':'symbol-narrow' }} ({{ d.cascada.descuento_total_pct }}%)
                  </div>
                }
              </div>
            } @else {
              <div class="tk-vacio"><i class="pi pi-arrow-left" aria-hidden="true"></i> Elige un documento de la lista</div>
            }
          </section>
      </div>
    </div>
  `,
  styles: [`
    .surf-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .tk-reporte { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); font-weight: 600;
      padding: 9px 14px; border: 1px solid var(--border-color); border-radius: var(--radius-sm);
      background: var(--card-bg); color: var(--text); text-decoration: none; white-space: nowrap; }
    .tk-reporte:hover { background: var(--overlay-hover); }

    /* min-width:0 + wrap: en angosto los filtros bajan de renglón, no desbordan la página. */
    :host { display:block; min-width:0 }
    .tk-filtros { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; padding:.5rem .625rem; margin-top:.75rem }
    :host ::ng-deep .tk-sel { min-width:13rem }
    :host ::ng-deep .tk-cli { flex:1 1 16rem; min-width:12rem }
    :host ::ng-deep .tk-cli input { width:100% }
    .tk-fecha { display:flex; align-items:center; gap:.3rem; color:var(--text-muted,#78716c) }
    .tk-fecha input { width:9rem }
    .tk-fija { display:inline-flex; align-items:center; gap:.4rem; font-size:.85rem; font-weight:600;
      padding:.45rem .7rem; border:1px solid var(--surface-border,#e7e5e4); border-radius:var(--radius-md,6px) }
    .tk-sin { color:#5c4803; border-color:#d6b45a; background:#fdf6e3 }
    .tk-ac { display:flex; flex-direction:column; line-height:1.25 }
    .tk-ac span { font-size:.74rem; color:var(--text-muted,#78716c) }
    .tk-bsearch { position:relative; margin-bottom:.5rem }
    .tk-bsearch i { position:absolute; left:.6rem; top:50%; transform:translateY(-50%); color:var(--text-muted,#78716c); pointer-events:none }
    .tk-bsearch input { width:100%; padding:.5rem .6rem .5rem 1.9rem; border:1px solid var(--surface-border,#e7e5e4);
      border-radius:var(--radius-md,6px); background:var(--surface-card,#fff); color:inherit; font:inherit; font-size:.85rem }
    .tk-bsearch input:focus-visible { outline:2px solid var(--action,#c2410c); outline-offset:1px }
    .tk-modo { display:flex; justify-content:space-between; align-items:center; gap:.5rem; flex-wrap:wrap;
      margin:0 0 .5rem; font-size:.78rem }
    .tk-link { background:none; border:0; padding:0; color:var(--action,#c2410c); font:inherit; font-weight:600; cursor:pointer }
    .tk-link:focus-visible { outline:2px solid var(--action,#c2410c); outline-offset:2px }
    .tk-vacio-lista { padding:1rem .5rem; text-align:center; font-size:.82rem; color:var(--text-muted,#78716c) }
    .tk-vacio-lista p { margin:0 0 .5rem }
    /* La bandeja puede traer cientos: scroll propio, la página no crece sin fin. */
    .tk-cands { max-height:calc(100vh - 20rem); min-height:12rem; overflow-y:auto; padding-right:.15rem }
    .tk-split { display:grid; grid-template-columns:minmax(230px,300px) 1fr; gap:1rem; margin-top:1rem; align-items:start }
    @media (max-width:56.25rem) { .tk-split { grid-template-columns:1fr } }
    .tk-lista-head { display:flex; justify-content:space-between; gap:.5rem; font-size:.78rem;
      color:var(--text-muted,#78716c); font-weight:600; margin-bottom:.35rem }
    .tk-trunc { color:var(--action,#c2410c) }
    .tk-aviso { display:flex; gap:.4rem; font-size:var(--fs-xs); line-height:1.3; margin:0 0 .5rem;
      padding:.4rem .55rem; border:1px solid #d6b45a; background:#fdf6e3; color:#5c4803; border-radius:var(--radius-sm,4px) }
    .tk-cands { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.35rem }
    .tk-cand { width:100%; display:flex; flex-direction:column; gap:.15rem; text-align:left; cursor:pointer;
      padding:.5rem .6rem; border:1px solid var(--surface-border,#e7e5e4); border-radius:var(--radius-md,6px);
      background:var(--surface-card,#fff); color:inherit; font:inherit }
    .tk-cand:hover { border-color:var(--action,#c2410c) }
    .tk-cand.sel { border-color:var(--action,#c2410c); box-shadow:inset 3px 0 0 var(--action,#c2410c) }
    .tk-cand:focus-visible { outline:2px solid var(--action,#c2410c); outline-offset:1px }
    .tk-cand-top { display:flex; justify-content:space-between; align-items:center; gap:.5rem }
    .tk-cand-mid { font-size:.8rem; font-weight:600 }
    .tk-cand-mid i { font-style:normal; color:var(--text-muted,#78716c); font-weight:500 }
    .tk-cand-bot { display:flex; justify-content:space-between; font-size:.74rem; color:var(--text-muted,#78716c) }
    .tk-cand-cli { font-size:.74rem; color:var(--text-muted,#78716c); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    .tk-doc { border:1px solid var(--surface-border,#e7e5e4); border-radius:var(--radius-md,6px);
      background:var(--surface-card,#fff); padding:.85rem 1rem }
    .tk-doc-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap }
    .tk-doc-sub { font-size:.7rem; letter-spacing:.1em; text-transform:uppercase; color:var(--action,#c2410c); font-weight:700 }
    .tk-doc-head h2 { margin:.1rem 0 0; font-size:1.05rem }
    .tk-acciones { display:flex; gap:.4rem; flex-wrap:wrap }
    .tk-warn { margin-top:.6rem; padding:.45rem .6rem; border:1px solid #d6b45a; background:#fdf6e3;
      color:#5c4803; border-radius:var(--radius-sm,4px); font-size:.8rem; font-weight:600 }
    .tk-meta { display:flex; flex-wrap:wrap; gap:.15rem 1.4rem; margin:.7rem 0 .2rem }
    .tk-meta dt { font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted,#78716c); font-weight:700 }
    .tk-meta dd { margin:0; font-size:.85rem; font-weight:600 }
    .tk-nota { margin:.35rem 0 .7rem; font-size:.73rem; color:var(--text-muted,#78716c) }
    .tk-num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap }
    /* [TK.13] Tabla del desglose: scroll propio en angosto (9 columnas no caben en un celular). */
    .tk-tabla { overflow-x:auto; margin-top:.5rem }
    .tk-det { width:100%; border-collapse:collapse; font-size:.82rem }
    .tk-det th { font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted,#78716c);
      font-weight:700; text-align:left; padding:.4rem .5rem; border-bottom:1.5px solid currentColor; white-space:nowrap }
    .tk-det th.tk-num { text-align:right }
    .tk-det td { padding:.35rem .5rem; vertical-align:top }
    .tk-det tr.tk-u td { padding-bottom:.1rem }
    .tk-det tr.tk-u-sola td, .tk-det tr.tk-pt td { border-bottom:1px solid var(--surface-border,#e7e5e4) }
    /* El total de la partida se lee como el cierre del renglón de arriba: más chico y tenue. */
    .tk-det tr.tk-pt td { font-size:.76rem; color:var(--text-muted,#78716c); background:var(--overlay-hover,#f5f5f4); padding-top:.15rem }
    .tk-det tr.tk-pt td.tk-fuerte { color:var(--text,#1c1917) }
    .tk-pt-l { text-align:right; font-size:.66rem !important; letter-spacing:.08em; text-transform:uppercase; font-weight:700 }
    .tk-vu { font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; font-weight:700; color:var(--text-muted,#78716c) }
    .tk-det tfoot td { border-top:2px solid currentColor; font-weight:800; padding-top:.45rem; text-align:right }
    .tk-det tfoot td:first-child { text-align:left; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase }
    .tk-sinimp { color:var(--action,#c2410c) }
    /* La tasa va pegada a su monto pero no encimada: "$1.08 8%", no "$1.088%". */
    .tk-det .tk-uni { margin-left:.25rem }
    .tk-uni { font-style:normal; font-size:.7rem; color:var(--text-muted,#78716c) }
    .tk-prod { font-weight:600; font-size:.85rem; line-height:1.2 }
    .tk-sku { font-size:.7rem; color:var(--text-muted,#78716c) }
    .tk-mono { font-family:var(--font-mono,monospace) }
    /* El tachado es lo que hace legible "antes costaba X, pagaste Y" sin leer la columna. */
    .tk-tachado { text-decoration:line-through; color:var(--text-muted,#78716c) }
    .tk-fuerte { font-weight:700 }
    .tk-ahorro { color:#155e35; font-weight:700 }
    .tk-cierre { display:flex; justify-content:flex-end; margin-top:.8rem }
    .tk-res { border-collapse:collapse; min-width:19rem }
    .tk-res td { padding:.25rem .6rem; border-bottom:1px solid var(--surface-border,#e7e5e4); font-size:.88rem }
    .tk-res td i { font-style:normal; font-size:.72rem; color:var(--text-muted,#78716c) }
    .tk-res tr.tk-desc td { color:#155e35 }
    .tk-res tr.tk-total td { border-top:2px solid currentColor; border-bottom:none; font-size:1.05rem; font-weight:800; padding-top:.4rem }
    .tk-ahorraste { margin-left:1rem; align-self:flex-end; padding:.45rem .8rem; border:1.5px solid #155e35;
      background:#eaf5ee; color:#0f4527; border-radius:var(--radius-sm,4px); font-weight:800; text-align:center }
    .tk-ahorraste i { display:block; font-style:normal; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; font-weight:600 }
    .tk-vacio, .tk-cargando { padding:2rem 1rem; text-align:center; color:var(--text-muted,#78716c); font-size:.9rem }
  `],
})
export class ComercialTicketsComponent {
  private readonly svc = inject(TicketsService);
  private readonly toast = inject(MessageService);
  private readonly scope = inject(DataScopeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly buscando = signal(false);
  readonly cargando = signal(false);
  readonly generandoPdf = signal(false);
  readonly candidatos = signal<(TicketCandidato | BandejaFila)[]>([]);
  readonly seleccionado = signal<string | null>(null);
  readonly doc = signal<TicketVenta | null>(null);

  // ── TK.12 — Filtros de la bandeja ─────────────────────────────────────────────────────
  /**
   * Sucursales que el usuario alcanza. `null` = todavía no contestó `me/scope`; `[]` = no le
   * toca ninguna. Alimenta el selector, NO decide seguridad: sin sucursal elegida la consulta
   * viaja sin filtro y el backend la recorta a su alcance (ADR-050).
   */
  readonly sucursales = this.scope.misSucursales();
  /** `null` = todas las que alcanza. */
  readonly fSucursal = signal<string | null>(null);
  /** Arranca en HOY (día de México, no el UTC del navegador): la bandeja del turno. */
  readonly fDesde = signal(hoyMx());
  readonly fHasta = signal(hoyMx());
  readonly fCliente = signal<string | null>(null);
  clienteSel: ClienteCandidato | null = null;
  readonly clienteSugs = signal<ClienteCandidato[]>([]);
  readonly qBandeja = signal('');
  readonly cargandoBandeja = signal(false);
  readonly aviso = signal<string | null>(null);
  readonly importe = signal(0);
  /** Folio buscado en TODAS las fechas (el buscador de siempre). `null` = se ve la bandeja. */
  readonly modoFolio = signal<string | null>(null);

  /** 0 = ya (cambió un filtro); 300 = al teclear en el buscador de la bandeja. */
  private readonly pedir$ = new Subject<number>();

  constructor() {
    // `switchMap` en los dos niveles: un filtro nuevo cancela tanto la espera del tecleo como
    // la petición en vuelo. Sin esto, una respuesta lenta de "todas las sucursales" llegaba
    // DESPUÉS y pisaba la de la sucursal que se acababa de elegir.
    this.pedir$.pipe(
      switchMap((espera) => timer(espera).pipe(
        tap(() => { this.cargandoBandeja.set(true); this.modoFolio.set(null); }),
        switchMap(() => this.svc.bandeja({
          date_from: this.fDesde(), date_to: this.fHasta(),
          warehouse_codes: this.fSucursal(), cliente: this.fCliente(), q: this.qBandeja(),
        }).pipe(
          map((r): BandejaTickets | null => r),
          catchError((e) => {
            const msg = e?.error?.message;
            this.toast.add({ severity: 'error', summary: 'No se pudo cargar la bandeja',
              detail: typeof msg === 'string' ? msg : 'Reintenta en un momento.' });
            return of(null);
          }),
        )),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.cargandoBandeja.set(false);
      this.candidatos.set(r?.filas ?? []);
      this.aviso.set(r?.aviso ?? null);
      this.importe.set(r?.resumen.importe ?? 0);
      // Con UNO solo no hay nada que elegir; con varios elige la persona.
      if (r?.filas.length === 1) this.abrir(r.filas[0]);
    });
    this.recargar();
  }

  readonly MAX_DIAS = MAX_DIAS_BANDEJA;
  readonly masDias = sumarDias;

  /**
   * Al mover una punta del rango, si queda a más de 31 días de la otra, la otra se RECORRE en
   * vez de mandar un rango que el backend va a rechazar con 400. Y si se cruzan (desde > hasta),
   * la otra punta se iguala.
   */
  cambiarDesde(v: string): void {
    this.fDesde.set(v);
    if (v && this.fHasta()) {
      const tope = sumarDias(v, MAX_DIAS_BANDEJA - 1);
      if (this.fHasta() > tope) this.fHasta.set(tope);
      if (this.fHasta() < v) this.fHasta.set(v);
    }
    this.recargar();
  }

  cambiarHasta(v: string): void {
    this.fHasta.set(v);
    if (v && this.fDesde()) {
      const tope = sumarDias(v, -(MAX_DIAS_BANDEJA - 1));
      if (this.fDesde() < tope) this.fDesde.set(tope);
      if (this.fDesde() > v) this.fDesde.set(v);
    }
    this.recargar();
  }

  recargar(): void {
    // Un `input type=date` a medio teclear emite ''. No se consulta con una fecha rota.
    if (!this.fDesde() || !this.fHasta()) return;
    this.pedir$.next(0);
  }

  escribir(v: string): void {
    this.qBandeja.set(v ?? '');
    this.pedir$.next(300);
  }

  buscarClientes(q: string): void {
    this.svc.clientes(q).subscribe({
      next: (r) => this.clienteSugs.set(r.candidatos),
      error: () => this.clienteSugs.set([]),
    });
  }

  elegirCliente(c: ClienteCandidato | null): void {
    this.clienteSel = c;
    this.fCliente.set(c?.cliente_code ?? null);
    this.recargar();
  }

  /** La clave del cliente, cuando la fila la trae. `CONTADO` no es un cliente, es ninguno. */
  clave(c: TicketCandidato | BandejaFila): string | null {
    const k = (c as BandejaFila).cliente_code;
    return k && k !== 'CONTADO' ? k : null;
  }

  volverBandeja(): void {
    this.modoFolio.set(null);
    this.recargar();
  }

  /**
   * `[TK.13]` La tabla del documento, armada UNA vez por documento: columnas, partidas con su
   * desglose (unitario + partida) y la fila de totales. Las columnas opcionales se deciden por
   * DOCUMENTO, no por renglón, igual que en la carta PDF (una columna que aparece en unas filas
   * y en otras no desalinea la tabla):
   *   · lista y descuento — sólo si hay algún descuento (el 70% de los tickets no trae);
   *   · sin impuestos / IVA / IEPS — sólo si el impuesto de los renglones reproduce la cabecera
   *     del ERP, y cada impuesto sólo si el documento lo causa (ADR-056).
   */
  readonly vista = computed(() => {
    const d = this.doc();
    if (!d) return null;
    const desglosado = d.cascada.impuesto_desglosado;
    const total = desgloseTotalDe(d);
    const imp = desglosado && total.sin_impuestos != null;
    const cols = {
      lista: total.lista != null && total.descuento > 0,
      desc: total.descuento > 0,
      imp,
      iva: imp && (total.iva ?? 0) > 0,
      ieps: imp && (total.ieps ?? 0) > 0,
    };
    return {
      cols,
      total,
      filas: d.lineas.map((l) => ({ l, d: desgloseDe(l, desglosado) })),
    };
  });

  sev(origen: string): 'info' | 'success' | 'warn' | 'secondary' {
    return origen === 'mostrador' ? 'info'
      : origen === 'telemarketing' ? 'success'
      : origen === 'credito' ? 'warn' : 'secondary';
  }

  /**
   * El buscador de siempre: un folio en TODAS las fechas y los tres canales. Se ofrece cuando
   * la bandeja no lo encuentra en el rango elegido — un ticket de hace tres meses sigue siendo
   * reimprimible, y el rango de la bandeja no puede pasar de 31 días.
   */
  buscarFolioGlobal(): void {
    const q = this.qBandeja().trim();
    if (!q) return;
    this.buscando.set(true);
    this.doc.set(null);
    this.seleccionado.set(null);
    this.svc.buscar(q).subscribe({
      next: (r) => {
        this.candidatos.set(r.candidatos);
        this.modoFolio.set(q);
        this.importe.set(0);
        this.aviso.set(r.truncado ? 'Hay más coincidencias: afina el folio.'
          : r.candidatos.length ? null
          : 'Tampoco está en otras fechas. Si el ticket es de una sucursal que no alcanzas, no aparece acá.');
        this.buscando.set(false);
        // Con UN solo candidato no hay ambigüedad que resolver, así que se abre. Con dos o más
        // elige la persona: "el primero" sería el dinero de otra tienda.
        if (r.candidatos.length === 1) {
          /*
           * `[TK.perf]` Si el servidor ya mandó el documento, se usa y **no se pide de nuevo**.
           * Era una segunda petición HTTP entera —con su latencia— para ~5 ms de consulta que el
           * backend ya podía resolver en la misma respuesta.
           *
           * ⛔ El `else` no es defensivo por las dudas: `documento` viene `null` cuando el
           * servidor no pudo resolverlo (y ahí pedirlo aparte es justo lo que hay que hacer), y
           * también mientras la API desplegada sea anterior a este cambio. Quitar esta rama
           * dejaría la pantalla en blanco contra una API vieja.
           */
          if (r.documento) {
            this.seleccionado.set(r.candidatos[0].id);
            this.doc.set(r.documento);
          } else {
            this.abrir(r.candidatos[0]);
          }
        }
      },
      error: () => {
        this.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo buscar', detail: 'Reintenta en un momento.' });
      },
    });
  }

  abrir(c: TicketCandidato): void {
    this.seleccionado.set(c.id);
    this.cargando.set(true);
    this.svc.detalle(c.id).subscribe({
      next: (d) => { this.doc.set(d); this.cargando.set(false); },
      error: () => {
        this.cargando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo abrir el documento' });
      },
    });
  }

  imprimir(d: TicketVenta): void {
    if (!imprimirTicketVenta(d)) {
      this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la impresión', detail: 'Permite las ventanas de impresión para este sitio.' });
    }
  }

  /**
   * Abre la carta en PDF.
   *
   * ── ⚠️ POR QUÉ LA PESTAÑA SE ABRE **ANTES** DE PEDIR EL PDF ─────────────────────────────
   * La versión anterior llamaba `window.open(url)` DENTRO del callback del HTTP, o sea segundos
   * después del clic. Para entonces la **activación transitoria** del gesto ya caducó (Chrome y
   * Edge la dan por ~5 s; Firefox y Safari son más estrictos) y el bloqueador de emergentes
   * rechaza la ventana. No era "según el navegador" ni intermitente: era determinista, y
   * dependía de cuánto tardara el PDF — que lo arma Chromium del lado del servidor, o sea justo
   * lo que más tarda. Y el aviso que salía ("el navegador bloqueó la pestaña, permite las
   * emergentes") culpaba al usuario de un bug nuestro y le pedía un permiso que no hacía falta.
   *
   * La pestaña se abre **sincrónicamente en el manejador del clic**, que es cuando el gesto
   * todavía vale, con un cartel de "generando" para que no se quede en `about:blank`. Cuando
   * llega el blob se la navega. Si el usuario tiene las emergentes bloqueadas a mano, se cae a
   * una **descarga**, que no necesita ese permiso — así el papel sale igual.
   *
   * ⚠️ Si la petición falla hay que CERRAR la pestaña que ya abrimos: si no, queda una en
   * blanco y no se sabe si el PDF viene o no.
   */
  carta(d: TicketVenta): void {
    // El gesto del usuario vive acá y sólo acá.
    const tab = window.open('', '_blank');
    if (tab) {
      tab.document.write(
        '<!doctype html><meta charset="utf-8"><title>Generando…</title>'
        + '<body style="font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#57534e">'
        + `Generando la carta de ${d.id}…</body>`);
      tab.document.close();
    }

    this.generandoPdf.set(true);
    this.svc.cartaPdf(d.id).subscribe({
      next: (blob) => {
        this.generandoPdf.set(false);
        // Blob URL y no la ruta directa: el endpoint va con Bearer y una pestaña nueva no
        // lleva el token.
        const url = URL.createObjectURL(blob);
        if (tab && !tab.closed) tab.location.href = url;
        else this.descargar(url, `ticket-${d.id}.pdf`);
        // Se revoca tarde: revocarlo antes de que la pestaña termine de pintar deja la hoja
        // en blanco.
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
      },
      error: () => {
        this.generandoPdf.set(false);
        if (tab && !tab.closed) tab.close();
        this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF' });
      },
    });
  }

  /** Salida sin emergentes: un ancla con `download` no necesita permiso de ventanas. */
  private descargar(url: string, nombre: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.toast.add({
      severity: 'info', summary: 'PDF descargado',
      detail: 'Este navegador tiene bloqueadas las pestañas nuevas, así que se descargó.',
    });
  }
}
