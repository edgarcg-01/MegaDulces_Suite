import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import { TabsModule } from 'primeng/tabs';
import { ToastModule } from 'primeng/toast';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { MessageService } from 'primeng/api';
import { ComprasService, RequisitionRow, RequisitionEstado, RequisitionResumen, RequisitionBatchRow } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PermissionsService } from '../../../core/services/permissions.service';
// ⛔ `[ID.28]` POR SUBRUTA, NO DESDE EL BARREL. `@megadulces/contracts` NO re-exporta el catálogo
// de autorización a propósito: colgarlo de ese barrel fue el primer intento y metió **+225 kB
// medidos** en el arranque de las TRES apps Angular, porque lo importa el chunk inicial y los
// ~80 kB del catálogo sólo los necesita una pantalla lazy.
import { Permission } from '@megadulces/contracts/authz/permissions';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/** Fase RA (ADR-030) — bandeja de requisiciones de compra y traspasos entre sucursales. */
@Component({
  selector: 'app-compras-requisiciones',
  standalone: true,
  imports: [RouterLink, CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, TagModule, TabsModule, ToastModule, MetricStripComponent, SegmentedComponent, InputTextModule, IconFieldModule, InputIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in rq-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Requisiciones y Traspasos</h1>
          <p class="surf-page-sub">Gestión de abastecimiento interno entre sucursales y compras a proveedores.</p>
        </div>
      </header>

      <!-- [RQ.2] Antes de esto la pantalla devolvía una lista plana: ni un conteo, ni la
           antigüedad, con el filtro en "todos los estados" y 50 por página ordenadas por fecha.
           Medido en prod el 2026-10-06: 610 pendientes por $42.7 M, 24 días de promedio y 77 la
           más vieja — todo invisible desde acá, porque las viejas caen en la página 12. -->
      <app-metric-strip [items]="kpis()" ariaLabel="Requisiciones por estado" />

      <!-- [RQ.8] POR LOTE o POR DOCUMENTO. Un «Armar» genera 8.2 documentos en promedio y 117 en
           el peor (82 generaciones medidas en prod), así que la lista plana obliga a leer 117
           renglones para entender UN clic. La vista por lote es la que contesta «¿qué pedí?». -->
      @if (atascadas(); as a) {
        <div class="rq-alerta" role="status">
          <i class="pi pi-clock" aria-hidden="true"></i>
          <span><strong>{{ a.n | number }}</strong> requisición(es) llevan más de 30 días sin resolverse ({{ money(a.monto) }}).
            A esa edad el costo capturado ya no es el de hoy en la mayoría de los renglones: hay que <strong>recalcular</strong> antes de aprobar, o rechazarlas.</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="verPendientes()"><span class="p-button-label">Ver pendientes</span></button>
        </div>
      }

      <div class="rq-vista">
        <app-segmented [options]="vistaOpts" [value]="vista()" ariaLabel="Agrupación"
                       (valueChange)="setVista($any($event))"></app-segmented>
        @if (lotesNoDisponible()) {
          <span class="rq-vista-warn"><i class="pi pi-info-circle" aria-hidden="true"></i>
            El agrupado por lote necesita la migración <code>20261006190000</code>. Mientras tanto, cada requisición sale como lote de uno — no se inventa uno hacia atrás.</span>
        } @else if (lotesReales() === 0) {
          <!-- [RQ.11] Se DICE por qué agrupar todavía no muestra nada, en vez de abrir en una
               vista donde cada requisición es su propio lote. Medido: 619 lotes de un documento. -->
          <span class="rq-vista-warn"><i class="pi pi-info-circle" aria-hidden="true"></i>
            Todavía no hay lotes: las requisiciones de antes se crearon sueltas y cada una sale como lote de uno.
            El agrupado empieza a servir con lo que se arme desde ahora en <strong>Pedido</strong>.</span>
        } @else {
          <span class="rq-vista-warn"><i class="pi pi-objects-column" aria-hidden="true"></i>
            <strong>{{ lotesReales() }}</strong> lote(s) armado(s) desde Pedido.</span>
        }
      </div>

      @if (loteAbierto(); as g) {
        <!-- [RQ.8] La migaja del lote: desde acá se ve de qué pedido son estos documentos y se
             vuelve. Sin esto, abrir un lote dejaba una lista filtrada que no decía por qué. -->
        <div class="rq-lote-cab" role="status">
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cerrarLote()"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Todos los lotes</span></button>
          <span><strong>{{ g.batch_folio || 'Lote sin folio' }}</strong> · {{ g.documentos }} documento(s)
            · {{ g.compras }} compra(s) + {{ g.traspasos }} traspaso(s) · {{ money(g.monto) }}</span>
        </div>
      }

      @if (vista() === 'lote') {
        <p-table [value]="lotes()" [loading]="loadingLotes()" styleClass="p-datatable-sm rq-table"
                 [paginator]="true" [rows]="25" [totalRecords]="totalLotes()" [lazy]="true" (onLazyLoad)="onPageLotes($event)">
          <ng-template #header>
            <tr>
              <th>Lote</th><th>Qué se pidió</th>
              <th class="rq-r">Docs</th><th class="rq-r">Renglones</th><th class="rq-r">Monto</th>
              <th>Estado</th><th class="rq-r">Días</th><th>Quién</th><th><span class="sr-only">Acciones</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-g>
            <tr class="rq-row" (click)="abrirLote(g)">
              <td class="rq-mono">{{ g.batch_folio || '—' }}
                <div class="rq-muted rq-sub">{{ g.created_at | date:'dd/MM/yy HH:mm' }}</div></td>
              <td>
                <div class="rq-lote-que">
                  @if (g.compras > 0) { <span class="rq-pill rq-pill-buy">{{ g.compras }} compra{{ g.compras === 1 ? '' : 's' }}</span> }
                  @if (g.traspasos > 0) { <span class="rq-pill rq-pill-tr">{{ g.traspasos }} traspaso{{ g.traspasos === 1 ? '' : 's' }}</span> }
                </div>
                <div class="rq-muted rq-sub">
                  @if (g.proveedores > 0) { {{ g.proveedores }} proveedor{{ g.proveedores === 1 ? '' : 'es' }}@if (g.proveedor_muestra?.length) { ({{ g.proveedor_muestra.join(', ') }}@if (g.proveedores > g.proveedor_muestra.length) { …}) } · }
                  {{ g.almacenes }} sucursal{{ g.almacenes === 1 ? '' : 'es' }}@if (g.almacen_muestra?.length) { : {{ g.almacen_muestra.join(', ') }}@if (g.almacenes > g.almacen_muestra.length) { …} }
                </div>
              </td>
              <td class="rq-r rq-strong">{{ g.documentos }}</td>
              <td class="rq-r">{{ g.renglones | number }}</td>
              <td class="rq-r">{{ money(g.monto) }}</td>
              <td>
                <p-tag [value]="loteEstadoLabel(g)" [severity]="loteEstadoSev(g)"></p-tag>
              </td>
              <td class="rq-r" [class.rq-viejo]="g.dias > 30">{{ g.dias }}</td>
              <td class="rq-muted">{{ g.autor || '—' }}</td>
              <td><i class="pi pi-angle-right rq-muted"></i></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="9" class="rq-empty">
              @if (error()) {
                <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los lotes.
                <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
              } @else { Sin lotes con este filtro. }
            </td></tr>
          </ng-template>
        </p-table>
      } @else if (loteAbierto()) {
        <!-- [RQ.11] LOS DOCUMENTOS DE UN LOTE, SIN PESTAÑAS Y CON SU TIPO A LA VISTA.
             Las pestañas separan «Proveedor» de «Traspaso» y eso parte justo lo que el lote
             junta: medido en prod, **65 de 83 lotes (78 %) mezclan los dos**. Acá van en una
             sola tabla con la columna Tipo, que es lo que contesta «qué compré y qué se
             traspasa» — la pregunta por la que existe esta vista. -->
        <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                 [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
          <ng-template #header>
            <tr>
              <th style="width:7rem">Tipo</th><th>Folio</th><th>De dónde · a dónde</th>
              <th class="rq-r">Líneas</th><th class="rq-r">Costo</th>
              <th>Estado</th><th class="rq-r">Días</th><th>Vigencia</th><th><span class="sr-only">Acciones</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="rq-row" (click)="open(r)">
              <td>
                @if (r.source_type === 'branch') { <span class="rq-pill rq-pill-tr">TRASPASO</span> }
                @else { <span class="rq-pill rq-pill-buy">COMPRA</span> }
              </td>
              <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
              <td>
                @if (r.source_type === 'branch') {
                  <span class="rq-wh-cell"><i class="pi pi-building rq-origin-icon" aria-hidden="true"></i> {{ r.source_warehouse_code || 'CEDIS' }}</span>
                  <i class="pi pi-arrow-right rq-muted rq-flecha" aria-hidden="true"></i>
                  <span class="rq-wh-cell"><i class="pi pi-map-marker rq-dest-icon" aria-hidden="true"></i> {{ r.warehouse_code || '—' }}</span>
                } @else {
                  <span>{{ r.supplier_name || 'Varios' }}</span>
                  <div class="rq-sub rq-muted">entrega en <strong>{{ r.warehouse_code || '—' }}</strong></div>
                }
              </td>
              <td class="rq-r">{{ r.total_lines | number }}</td>
              <td class="rq-r">{{ money(r.total_cost) }}</td>
              <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
              <td class="rq-r" [class.rq-viejo]="(r.dias ?? 0) > 30">{{ r.dias ?? '—' }}</td>
              <td><p-tag [value]="vigLabel(r)" [severity]="vigSev(r)" [attr.title]="vigTitle(r)"></p-tag></td>
              <td><i class="pi pi-angle-right rq-muted"></i></td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="9" class="rq-empty">
              @if (error()) {
                <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los documentos del lote.
                <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
              } @else { Este lote no tiene documentos con el filtro de estado puesto. }
            </td></tr>
          </ng-template>
        </p-table>
      } @else {


      <p-tabs [value]="tab()" (valueChange)="onTabChange($any($event))" styleClass="rq-tabs">
        <p-tablist>
          <p-tab value="supplier">
            <span class="rq-tab-title"><i class="pi pi-truck" aria-hidden="true"></i> Requerimientos a Proveedor</span>
          </p-tab>
          <p-tab value="branch">
            <span class="rq-tab-title"><i class="pi pi-arrow-right-arrow-left" aria-hidden="true"></i> Traspaso entre Sucursales</span>
          </p-tab>
        </p-tablist>

        <p-tabpanels>
          <!-- ── Pestaña 1: Requerimientos a Proveedor ── -->
          <p-tabpanel value="supplier">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
              <!-- [RQ.9] Hasta acá el UNICO filtro era el estado, y el backend ya aceptaba
                   warehouse_id sin que nadie lo usara. Con 670 requisiciones y 50 por pagina,
                   encontrar un folio eran 14 paginas. -->
              <p-select [options]="almacenOpts()" [(ngModel)]="fAlmacen" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                        [filter]="true" filterBy="label" styleClass="rq-sel" appendTo="body" ariaLabel="Filtrar por sucursal"></p-select>
              <p-iconfield styleClass="rq-search">
                <p-inputicon styleClass="pi pi-search" />
                <input pInputText type="text" [(ngModel)]="fBuscar" (keyup.enter)="reload()"
                       placeholder="Folio, proveedor o lote…" aria-label="Buscar requisición" />
              </p-iconfield>
              <!-- [RQ.4] Mover las 610 pendientes exigia abrir 610 fichas: el costo de la bandeja
                   ERA el tramite. La barra solo existe cuando hay algo marcado -- un boton de lote
                   permanentemente apagado es ruido, no informacion. -->
              @if (sel().size > 0) {
                <div class="rq-lote" role="group" aria-label="Acciones en lote">
                  <span class="rq-lote-n">{{ sel().size }} marcada(s)</span>
                  <button pButton type="button" class="p-button-sm" [disabled]="!canManage || busy()" (click)="lote('approve')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [disabled]="!canManage || busy()" (click)="lote('reject')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarMarcas()"><span class="p-button-label">Quitar marcas</span></button>
                </div>
              }
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th class="rq-chk"><input type="checkbox" [checked]="todasMarcadas()" (change)="marcarTodas($any($event.target).checked)" aria-label="Marcar todas las de la página" /></th>
                  <th>Folio</th><th>Almacén</th><th>Proveedor</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo</th>
                  <th>Estado</th><th class="rq-r" title="Días desde que se creó. Lo calcula el servidor, no el reloj de esta máquina.">Días</th><th title="¿El costo capturado sigue siendo el de hoy? Se mide renglón por renglón contra el plan vigente.">Vigencia</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-chk" (click)="$event.stopPropagation()"><input type="checkbox" [checked]="sel().has(r.id)" (change)="marcar(r.id, $any($event.target).checked)" [attr.aria-label]="'Marcar ' + r.folio" /></td>
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>{{ r.warehouse_code || '—' }}</td>
                  <td class="rq-muted">{{ r.supplier_name || 'Varios' }}</td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-r" [class.rq-viejo]="(r.dias ?? 0) > 30">{{ r.dias ?? '—' }}</td>
                  <td><p-tag [value]="vigLabel(r)" [severity]="vigSev(r)" [attr.title]="vigTitle(r)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="12" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar las requisiciones.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin requerimientos a proveedor todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>

          <!-- ── Pestaña 2: Traspaso entre Sucursales ── -->
          <p-tabpanel value="branch">
            <div class="rq-filters">
              <p-select [options]="estadoOpts" [(ngModel)]="fEstado" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todos los estados" [showClear]="true" styleClass="rq-sel" appendTo="body"></p-select>
              <!-- [RQ.9] Hasta acá el UNICO filtro era el estado, y el backend ya aceptaba
                   warehouse_id sin que nadie lo usara. Con 670 requisiciones y 50 por pagina,
                   encontrar un folio eran 14 paginas. -->
              <p-select [options]="almacenOpts()" [(ngModel)]="fAlmacen" (onChange)="reload()"
                        optionLabel="label" optionValue="value" placeholder="Todas las sucursales" [showClear]="true"
                        [filter]="true" filterBy="label" styleClass="rq-sel" appendTo="body" ariaLabel="Filtrar por sucursal"></p-select>
              <p-iconfield styleClass="rq-search">
                <p-inputicon styleClass="pi pi-search" />
                <input pInputText type="text" [(ngModel)]="fBuscar" (keyup.enter)="reload()"
                       placeholder="Folio, proveedor o lote…" aria-label="Buscar requisición" />
              </p-iconfield>
              <!-- [RQ.4] Mover las 610 pendientes exigia abrir 610 fichas: el costo de la bandeja
                   ERA el tramite. La barra solo existe cuando hay algo marcado -- un boton de lote
                   permanentemente apagado es ruido, no informacion. -->
              @if (sel().size > 0) {
                <div class="rq-lote" role="group" aria-label="Acciones en lote">
                  <span class="rq-lote-n">{{ sel().size }} marcada(s)</span>
                  <button pButton type="button" class="p-button-sm" [disabled]="!canManage || busy()" (click)="lote('approve')"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Aprobar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-outlined p-button-danger" [disabled]="!canManage || busy()" (click)="lote('reject')"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarMarcas()"><span class="p-button-label">Quitar marcas</span></button>
                </div>
              }
            </div>

            <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm rq-table"
                     [paginator]="true" [rows]="50" [totalRecords]="total()" [lazy]="true" (onLazyLoad)="onPage($event)">
              <ng-template #header>
                <tr>
                  <th class="rq-chk"><input type="checkbox" [checked]="todasMarcadas()" (change)="marcarTodas($any($event.target).checked)" aria-label="Marcar todas las de la página" /></th>
                  <th>Folio</th><th>Origen</th><th>Destino</th>
                  <th class="rq-r">Líneas</th><th class="rq-r">Unidades</th><th class="rq-r">Costo est.</th>
                  <th>Estado</th><th class="rq-r" title="Días desde que se creó. Lo calcula el servidor, no el reloj de esta máquina.">Días</th><th title="¿El costo capturado sigue siendo el de hoy? Se mide renglón por renglón contra el plan vigente.">Vigencia</th><th>Fecha</th><th><span class="sr-only">Acciones</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr class="rq-row" (click)="open(r)">
                  <td class="rq-chk" (click)="$event.stopPropagation()"><input type="checkbox" [checked]="sel().has(r.id)" (change)="marcar(r.id, $any($event.target).checked)" [attr.aria-label]="'Marcar ' + r.folio" /></td>
                  <td class="rq-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/compras/requisiciones', r.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ r.folio }}</a></td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-building rq-origin-icon" aria-hidden="true"></i> {{ r.source_warehouse_code || 'CEDIS' }}</span>
                  </td>
                  <td>
                    <span class="rq-wh-cell"><i class="pi pi-map-marker rq-dest-icon" aria-hidden="true"></i> {{ r.warehouse_code || '—' }}</span>
                  </td>
                  <td class="rq-r">{{ r.total_lines | number }}</td>
                  <td class="rq-r">{{ r.total_units | number:'1.0-0' }}</td>
                  <td class="rq-r">{{ money(r.total_cost) }}</td>
                  <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)"></p-tag></td>
                  <td class="rq-r" [class.rq-viejo]="(r.dias ?? 0) > 30">{{ r.dias ?? '—' }}</td>
                  <td><p-tag [value]="vigLabel(r)" [severity]="vigSev(r)" [attr.title]="vigTitle(r)"></p-tag></td>
                  <td class="rq-muted">{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                  <td><i class="pi pi-angle-right rq-muted"></i></td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="12" class="rq-empty">
                  @if (error()) {
                    <i class="pi pi-exclamation-triangle"></i> No se pudieron cargar los traspasos.
                    <button pButton type="button" class="p-button-text p-button-sm" (click)="reload()"><span class="p-button-label">Reintentar</span></button>
                  } @else { Sin traspasos entre sucursales todavía. Genera uno desde Existencia crítica. }
                </td></tr>
              </ng-template>
            </p-table>
          </p-tabpanel>
        </p-tabpanels>
      </p-tabs>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rq-tab-title { display: inline-flex; align-items: center; gap: .5rem; font-weight: 600; }
    .rq-filters { margin-bottom: .75rem; display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; } .rq-sel { min-width: 14rem; }
    .rq-lote { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .5rem;
               border: 1px solid var(--surface-border); border-radius: var(--radius-md);
               background: var(--surface-card); }
    .rq-lote-n { font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); margin-right: .25rem; }
    /* [RQ.8] Vista por lote */
    .rq-search input { min-width: 15rem; }
    .rq-vista { display: flex; align-items: center; gap: .75rem; margin: .5rem 0 .75rem; flex-wrap: wrap; }
    .rq-vista-warn { color: var(--text-muted); font-size: var(--fs-xs); display: inline-flex; align-items: center; gap: .35rem; }
    .rq-lote-cab { display: flex; align-items: center; gap: .6rem; margin-bottom: .6rem;
                   padding: .4rem .6rem; border-radius: var(--radius-md);
                   border: 1px solid var(--surface-border); background: var(--surface-card); font-size: var(--fs-sm); }
    .rq-sub { font-size: var(--fs-xs); }
    .rq-strong { font-weight: 700; }
    .rq-lote-que { display: flex; gap: .3rem; flex-wrap: wrap; }
    .rq-pill { font-size: var(--fs-micro); font-weight: 700; padding: .1rem .4rem; border-radius: 999px;
               border: 1px solid var(--surface-border); }
    .rq-pill-buy { color: var(--action); border-color: var(--action); }
    .rq-pill-tr  { color: var(--text-muted); }
    .rq-flecha { margin: 0 .3rem; font-size: var(--fs-xs); }
    .rq-chk { width: 2.25rem; text-align: center; }
    .rq-chk input { cursor: pointer; }
    /* El rojo es del renglón que ya pasó los 30 días: a esa edad el costo capturado dejó de ser
       el de hoy en la mayoría de los renglones (83.5 % medido en prod en el tramo 31-60 d). */
    .rq-viejo { color: var(--bad-fg); font-weight: 700; }
    .rq-alerta { display: flex; align-items: center; gap: .6rem; margin: .5rem 0 .9rem;
                 padding: .6rem .8rem; border-radius: var(--radius-md);
                 border: 1px solid var(--warn-border);
                 background: var(--warn-soft-bg); font-size: var(--fs-body); }
    .rq-alerta i { color: var(--warn-soft-fg); }
    .rq-table { font-size: .84rem; }
    .rq-row { cursor: pointer; } .rq-row:hover { background: var(--surface-hover-bg); }
    .rq-r { text-align: right; font-variant-numeric: tabular-nums; }
    .rq-mono { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; }
    .rq-muted { color: var(--text-muted); }
    .rq-empty { color: var(--text-muted); padding: 1.5rem; text-align: center; }
    .rq-wh-cell { display: inline-flex; align-items: center; gap: .35rem; }
    .rq-origin-icon { color: var(--action); font-size: var(--fs-sm); }
    .rq-dest-icon { color: var(--text); font-size: var(--fs-sm); }
  `],
})
export class ComprasRequisicionesComponent implements OnInit {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  tab = signal<'supplier' | 'branch'>('supplier');
  rows = signal<RequisitionRow[]>([]);
  total = signal(0);
  loading = signal(false);
  error = signal(false); // §6: falla de carga ≠ "sin requisiciones"
  page = signal(1);
  /**
   * `[RQ.2]` ARRANCA EN "PENDIENTE DE APROBAR", no en "todos".
   *
   * Medido en prod el 2026-10-06: de 670 requisiciones, **610 están pendientes** y la bandeja
   * abría con el filtro vacío, 50 por página, ordenadas por fecha descendente — o sea que lo que
   * hay que resolver quedaba mezclado con lo cancelado y lo recibido, y las más viejas (hasta 77
   * días) caían en la página 12. Abrir en la cola que SÍ tiene trabajo es la diferencia entre una
   * bandeja y un archivo histórico.
   */
  fEstado: string = 'pending_approval';
  /** `[RQ.9]` Sucursal y buscador: el backend ya los aceptaba, la pantalla nunca los ofreció. */
  fAlmacen: string | null = null;
  fBuscar = '';
  private readonly almacenes = signal<Array<{ id: string; code: string; name: string }>>([]);
  almacenOpts = computed(() => this.almacenes().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  resumen = signal<RequisitionResumen[]>([]);
  busy = signal(false);

  // ── `[RQ.8]` La vista por lote ─────────────────────────────────────────────────────────────
  /**
   * Arranca en **lote** porque es la unidad en que se trabaja: un «Armar» genera 8.2 documentos
   * de promedio y 117 en el peor (82 generaciones medidas en prod el 2026-10-06). La lista plana
   * sigue estando a un clic — es la que sirve para buscar UN folio, no para entender un pedido.
   */
  /**
   * `[RQ.11]` Arranca por DOCUMENTO y se pasa a LOTE sola **cuando hay lotes de verdad**.
   * Medido en prod: hoy hay 0 lotes y 619 requisiciones viejas, así que abrir agrupado mostraría
   * 619 «lotes» de un documento sin folio — la misma lista con una columna de más. El agrupado
   * empieza a servir con lo que se arme desde ahora; mientras tanto se DICE, no se simula.
   */
  vista = signal<'lote' | 'documento'>('documento');
  /** Cuántos lotes reales reportó el servidor. 0 = agrupar no aporta todavía. */
  lotesReales = signal(0);
  readonly vistaOpts: SegOption[] = [
    { label: 'Por lote', value: 'lote' },
    { label: 'Por documento', value: 'documento' },
  ];
  lotes = signal<RequisitionBatchRow[]>([]);
  totalLotes = signal(0);
  loadingLotes = signal(false);
  pageLotes = signal(1);
  /** `true` = falta la migración. Se DECLARA en pantalla; no se simula el lote con el reloj. */
  lotesNoDisponible = signal(false);
  /** `[RQ.4]` Lo marcado para el lote. Se limpia en cada recarga: otra consulta, otro universo. */
  sel = signal<Set<string>>(new Set());

  private readonly toast = inject(MessageService);
  /**
   * `[RQ.4]` El gate sale de `PermissionsService` y NO de `AuthService`, a propósito.
   *
   * Los dos saben lo mismo, pero `AuthService` arrastra HttpClient + DataScope + Uso + Injector y
   * llama a `restoreSession()` en su constructor: meterlo acá habría roto el spec de esta pantalla
   * (que monta con `provideRouter` y un solo doble) y, peor, habría hecho que una lista de
   * requisiciones dependa del arranque de la sesión. `PermissionsService` no inyecta nada.
   * El permiso igual lo exige el servidor; esto sólo decide si el botón se puede apretar.
   */
  private readonly perms = inject(PermissionsService);
  canManage = this.perms.isAdmin() || this.perms.has(Permission.COMPRAS_REQUISICIONES_GESTIONAR);

  estadoOpts = [
    { label: 'Pendiente de aprobar', value: 'pending_approval' },
    { label: 'Aprobada', value: 'approved' },
    { label: 'Ordenada', value: 'ordered' },
    { label: 'Recibida', value: 'received' },
    { label: 'Cancelada', value: 'cancelled' },
  ];

  ngOnInit(): void {
    const qTab = this.route.snapshot.queryParamMap.get('tab') || this.route.snapshot.queryParamMap.get('tipo');
    if (qTab === 'branch' || qTab === 'traspaso' || qTab === 'traspasos') {
      this.tab.set('branch');
    }
    // `[RQ.9]` El catálogo de sucursales sale del MISMO /filters que usa Pedido. No se traga el
    // error: sin lista, el selector queda mudo y nadie sabe por qué (DESIGN §Ing.UI 6).
    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (fl) => this.almacenes.set(fl.warehouses ?? []),
      error: () => this.toast.add({ severity: 'warn', summary: 'Sin catálogo de sucursales',
        detail: 'El filtro por sucursal queda vacío; el resto de la bandeja funciona.' }),
    });
    // `[RQ.11]` Se pregunta por los lotes al abrir —aunque la vista arranque por documento—
    // para poder decidir si agrupar aporta. Cuesta 7 ms medidos contra prod.
    this.loadLotes();
    this.reload();
  }
  private vistaDecidida = false;

  onTabChange(newTab: 'supplier' | 'branch'): void {
    if (this.tab() === newTab) return;
    this.tab.set(newTab);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: newTab }, queryParamsHandling: 'merge' });
    this.reload();
  }

  reload(): void { this.page.set(1); this.pageLotes.set(1); this.load(); if (this.vista() === 'lote') this.loadLotes(); }

  setVista(v: 'lote' | 'documento'): void {
    if (this.vista() === v) return;
    this.vista.set(v);
    if (v === 'lote') this.loadLotes();
  }
  onPageLotes(e: TableLazyLoadEvent): void {
    this.pageLotes.set(Math.floor((e.first || 0) / (e.rows || 25)) + 1);
    this.loadLotes();
  }
  private loadLotes(): void {
    this.loadingLotes.set(true);
    // `[RQ.11]` ⛔ ACÁ IBA `source_type: this.tab()` Y ERA EL DEFECTO.
    // El filtro corta las filas ANTES del GROUP BY, así que un lote de 6 compras + 15 traspasos
    // se publicaba como "6 documentos" en una pestaña y "15" en la otra — nunca 21. Medido
    // contra prod: **65 de 83 lotes (78 %) mezclan los dos tipos**, 632 documentos y $38,992,900;
    // en ésos el lote real tiene 9.7 documentos y la pestaña mostraba 5.0 o 4.7, con $28.7M o
    // $10.3M en vez de $39.0M. Y las dos píldoras "N compras / M traspasos" —que existen justo
    // para distinguir lo comprado de lo traspasado— quedaban con una SIEMPRE en cero.
    // Peor: en la vista por lote las pestañas **ni se dibujan**, o sea que filtraba por un
    // control invisible. El lote es la unidad del «Armar» y abarca los dos tipos: no se filtra.
    this.api.listRequisitionBatches({
      estado: this.fEstado || undefined,
      page: this.pageLotes(), pageSize: 25,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.lotes.set(r.rows ?? []); this.totalLotes.set(r.total ?? 0);
        this.lotesNoDisponible.set(r.disponible === false);
        this.lotesReales.set(r.con_lote ?? 0);
        // La primera vez que HAY lotes, la pantalla se pasa sola a la vista que los muestra.
        // Después respeta lo que el usuario eligió: no se le cambia la vista bajo el mouse.
        if (!this.vistaDecidida && (r.con_lote ?? 0) > 0) { this.vistaDecidida = true; this.vista.set('lote'); }
        else if (!this.vistaDecidida) { this.vistaDecidida = true; }
        this.loadingLotes.set(false); this.error.set(false);
      },
      error: () => { this.loadingLotes.set(false); this.error.set(true); },
    });
  }
  /**
   * Abrir un lote = ver sus documentos. Se cambia a la lista plana filtrada por ese lote, en vez
   * de inventar una tercera pantalla: son las mismas filas con las mismas acciones.
   */
  abrirLote(g: RequisitionBatchRow): void {
    this.vista.set('documento');
    this.loteAbierto.set(g);
    this.page.set(1);
    this.load();
  }
  loteAbierto = signal<RequisitionBatchRow | null>(null);
  cerrarLote(): void { this.loteAbierto.set(null); this.page.set(1); this.load(); }
  /** `mixto` no es un estado: es la DECLARACIÓN de que el lote no está todo en el mismo. */
  loteEstadoLabel(g: RequisitionBatchRow): string {
    return g.estado === 'mixto' ? `mixto · ${g.pendientes} pendiente(s)` : this.estadoLabel(g.estado as RequisitionEstado);
  }
  loteEstadoSev(g: RequisitionBatchRow): Sev {
    return g.estado === 'mixto' ? 'contrast' : this.estadoSev(g.estado as RequisitionEstado);
  }

  private load(): void {
    this.loading.set(true);
    this.api.listRequisitions({
      estado: this.fEstado || undefined,
      // `[RQ.11]` Misma razón: los documentos DE UN LOTE son de los dos tipos, y el resumen que
      // alimenta el tablero de arriba tiene que contar el universo entero, no media pestaña.
      source_type: (this.vista() === 'lote' || this.loteAbierto()) ? undefined : this.tab(),
      warehouse_id: this.fAlmacen || undefined,
      search: this.fBuscar.trim() || undefined,
      // `[RQ.8]` Abrir un lote = la misma lista, acotada a sus documentos.
      batch_id: this.loteAbierto()?.lote || undefined,
      page: this.page(),
      pageSize: 50,
    })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows); this.total.set(r.total); this.resumen.set(r.resumen ?? []);
          this.sel.set(new Set());   // otra consulta: lo marcado ya no aplica
          this.loading.set(false); this.error.set(false);
        },
        error: () => { this.loading.set(false); this.error.set(true); },
      });
  }

  onPage(e: TableLazyLoadEvent): void {
    this.page.set(Math.floor((e.first || 0) / (e.rows || 50)) + 1);
    this.load();
  }

  open(r: RequisitionRow): void { this.router.navigate(['/compras/requisiciones', r.id]); }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  estadoLabel(e: RequisitionEstado) { return ({ draft: 'Borrador', pending_approval: 'Pendiente', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as Record<RequisitionEstado, string>)[e]; }
  estadoSev(e: RequisitionEstado): Sev { return ({ draft: 'secondary', pending_approval: 'warn', approved: 'success', ordered: 'info', received: 'success', cancelled: 'danger' } as Record<RequisitionEstado, Sev>)[e]; }

  // ── `[RQ.2]` Lo que la bandeja no decía ────────────────────────────────────────────────────
  private deResumen(e: RequisitionEstado): RequisitionResumen | undefined {
    return this.resumen().find((x) => x.estado === e);
  }
  /**
   * El tablero de la bandeja. Las dos primeras casillas son la cola REAL de trabajo (pendientes y
   * aprobadas sin OC); las otras dos son el resultado.
   *
   * ⚠️ `format: 'text'` en las que pueden no existir: sin eso el strip toma la rama numérica y
   * `Number('—') || 0` pinta un **0**, que acá se leería "no hay nada pendiente" — justo el cero
   * dibujado que ADR-056 prohíbe.
   */
  kpis(): MetricStripItem[] {
    const p = this.deResumen('pending_approval');
    const a = this.deResumen('approved');
    const o = this.deResumen('ordered');
    const rc = this.deResumen('received');
    return [
      { label: 'Esperando aprobación', value: p?.n ?? 0, tone: (p?.n ?? 0) > 0 ? 'warn' : undefined,
        sub: p ? `${this.money(p.monto)} · ${p.dias_prom} d de promedio` : 'sin requisiciones' },
      { label: 'Aprobadas sin OC', value: a?.n ?? 0,
        sub: a ? `${this.money(a.monto)} · hasta ${a.dias_max} d parada(s)` : 'ninguna' },
      { label: 'Ordenadas', value: o?.n ?? 0, sub: o ? this.money(o.monto) : 'ninguna' },
      { label: 'Recibidas', value: rc?.n ?? 0, sub: rc ? this.money(rc.monto) : 'ninguna' },
    ];
  }
  /** Las pendientes que pasaron los 30 días — el escalón donde el costo deja de ser el de hoy. */
  atascadas(): { n: number; monto: number } | null {
    const p = this.deResumen('pending_approval');
    return p && p.n_mas_30 > 0 ? { n: p.n_mas_30, monto: p.monto_mas_30 } : null;
  }
  verPendientes(): void { this.fEstado = 'pending_approval'; this.reload(); }

  // ── `[RQ.1]` Vigencia en la fila ───────────────────────────────────────────────────────────
  /** TRES etiquetas, no dos: "sin medir" no es "al día" (ADR-056). */
  vigLabel(r: RequisitionRow): string {
    const v = r.vigencia;
    if (!v || v.vigente == null) return 'sin medir';
    return v.vigente ? 'al día' : `${v.movidos} movido(s)`;
  }
  vigSev(r: RequisitionRow): Sev {
    const v = r.vigencia;
    if (!v || v.vigente == null) return 'secondary';
    return v.vigente ? 'success' : 'warn';
  }
  vigTitle(r: RequisitionRow): string {
    const v = r.vigencia;
    if (!v) return 'No se pudo medir la vigencia de esta requisición.';
    if (v.vigente == null) return `Ninguno de sus ${v.renglones} renglones tiene costo comparable hoy: no se puede decir si sigue vigente.`;
    const cola = v.sin_medir > 0 ? ` · ${v.sin_medir} renglón(es) sin medir` : '';
    if (v.vigente) return `Los ${v.medibles} renglones medibles conservan el costo con el que se capturaron${cola}.`;
    return `${v.movidos} de ${v.medibles} renglones ya no tienen el costo de hoy: ${this.money(v.monto_capturado)} capturados contra ${this.money(v.monto_hoy)} actuales (${v.delta >= 0 ? '+' : ''}${this.money(v.delta)})${cola}. Recalculá antes de aprobar.`;
  }

  // ── `[RQ.4]` Lote ──────────────────────────────────────────────────────────────────────────
  marcar(id: string, on: boolean): void {
    this.sel.update((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }
  marcarTodas(on: boolean): void {
    this.sel.set(on ? new Set(this.rows().map((r) => r.id)) : new Set());
  }
  todasMarcadas(): boolean {
    const rs = this.rows();
    return rs.length > 0 && rs.every((r) => this.sel().has(r.id));
  }
  limpiarMarcas(): void { this.sel.set(new Set()); }
  /**
   * Manda el lote y **dice qué NO pasó, con su motivo**. El caso típico no es un error de sistema
   * sino el freno de `[RQ.3]`: la requisición ya no tiene el costo de hoy. Tragarlo dejaría al
   * usuario creyendo que aprobó 50 cuando aprobó 21.
   */
  lote(accion: 'approve' | 'reject'): void {
    const ids = [...this.sel()];
    if (!ids.length) return;
    this.busy.set(true);
    this.api.bulkRequisiciones(ids, accion).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.busy.set(false);
        const verbo = accion === 'approve' ? 'aprobada(s)' : 'rechazada(s)';
        if (r.hechas) this.toast.add({ severity: 'success', summary: `${r.hechas} ${verbo}`, life: 5000 });
        if (r.fallas.length) {
          const folios = new Map(this.rows().map((x) => [x.id, x.folio]));
          const det = r.fallas.slice(0, 3).map((f) => `${folios.get(f.id) || f.id.slice(0, 8)}: ${f.motivo}`).join(' · ');
          this.toast.add({
            severity: 'warn', summary: `${r.fallas.length} no se pudo(ieron)`, life: 15000,
            detail: det + (r.fallas.length > 3 ? ` · y ${r.fallas.length - 3} más` : ''),
          });
        }
        this.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo aplicar el lote', detail: e?.error?.message || 'Intentá de nuevo.' });
      },
    });
  }
}
