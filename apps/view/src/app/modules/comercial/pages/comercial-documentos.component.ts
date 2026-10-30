import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  SalesDocumentsService, SalesDocRow, SalesDocDetail, SalesDocsReport, SalesDocsFiltros,
} from '../sales-documents.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { mensajeDeErrorBlob } from '../../../core/http/blob-error';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { TELEMARKETING_TABS } from '../telemarketing-tabs';
import {
  TelemarketingFiltrosComponent, TmFiltros, tmFiltrosIniciales,
} from '../components/telemarketing-filtros.component';
import { RouteCreditComponent } from './comercial-route-credit.component';
import { EmbarquesSinFacturaComponent } from '../components/embarques-sin-factura.component';
import { abrirPestanaParaPdf, entregarPdf, cerrarPestanaDePdf } from '../../../shared/util/abrir-pdf';

/**
 * AX.2/AX.3 — Facturación de Telemarketing (el documento que se le entrega al cliente).
 *
 * Surface Operations: tabla densa + side-peek para el detalle (DESIGN.md §7/§14: documento
 * extenso NO va en modal). Los datos vienen de vistas en vivo sobre kepler_ods → lo que se ve
 * aquí tiene la frescura del CDC, sin esperar un feed.
 *
 * Imprimir: el PDF lo arma el backend (AX.4). Se descarga como blob —no se abre la URL— porque
 * el endpoint pide JWT y una pestaña nueva no manda el header; con el blob además se puede
 * mandar a la impresora sin salir de la pantalla.
 */
@Component({
  selector: 'app-comercial-documentos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, InputTextModule, TableModule, TagModule, ButtonModule, TooltipModule, ToastModule,
    MetricStripComponent, LoadStateComponent, SidePeekComponent, PageTabsComponent,
    TelemarketingFiltrosComponent,
    RouteCreditComponent,
    EmbarquesSinFacturaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
  <div class="surf-page">
    <p-toast position="bottom-right" />

    <div class="surf-page-head">
      <div>
        <h1>Facturación de Telemarketing</h1>
        <p class="surf-page-sub">
          Facturas emitidas · imprime el detalle desglosado para el cliente
          <span class="live" title="Se leen en vivo del ERP; no dependen de un proceso nocturno.">· en vivo</span>
        </p>
      </div>
      <!-- [AX.18] Lo secundario de esta pantalla: un boton que ya dice cuanto falta y abre una
           ventana encima, sin empujar la tabla de facturas. Sigue la sucursal elegida abajo. -->
      <app-embarques-sin-factura [sucursal]="filtros().sucursal" />
    </div>

    <app-page-tabs [tabs]="tabs" />

    <!-- KPIs de LA MISMA selección que la tabla -->
    @if (report(); as r) {
      <app-metric-strip [items]="kpis(r)" />
    }

    <!-- [VEC.21] Esta pantalla ya LISTA las facturas de telemarketing; lo que le faltaba era
         que son venta a CREDITO y nadie veia si se cobraron. El panel trae la cadena:
         factura -> cobro -> cuenta de tesoreria donde entro el dinero. Sin ruta fija: aca se
         mira el universo completo, no una ruta. -->
    <app-route-credit />

    <app-telemarketing-filtros [value]="filtros()" [vendedores]="vendedorOpts()"
                               [sucursales]="sucursales()" [sucursalDeclarada]="alcanceLeido()"
                               (cambio)="aplicar($event)" />

    <!-- GT.14 — la guía se arma ACÁ: se palomean facturas y se genera. Lo seleccionado está
         siempre a la vista porque es lo que va a salir impreso. -->
    <div class="barra card-premium card-flat" [class.vacia]="!sel().length">
      <div class="cuenta">
        <span class="n">{{ sel().length }}</span>
        <span class="l">factura{{ sel().length === 1 ? '' : 's' }} seleccionada{{ sel().length === 1 ? '' : 's' }}</span>
        @if (sel().length) {
          <span class="det">· {{ clientesSel() }} cliente{{ clientesSel() === 1 ? '' : 's' }}
            · <b class="mono">{{ importeSel() | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</b> a cobrar</span>
        }
      </div>

      <input pInputText type="text" class="resp" [(ngModel)]="responsable"
             placeholder="Responsable (opcional)" aria-label="Nombre del responsable"
             pTooltip="Se imprime sobre la línea de firma del responsable." />

      <p-button label="Limpiar" [text]="true" size="small" [disabled]="!sel().length"
                (onClick)="limpiar()" />
      <p-button icon="pi pi-print" label="Generar e imprimir" size="small"
                [disabled]="!listo()" [loading]="busy() === 'guia'" (onClick)="generarGuia()" />
    </div>

    @if (mezcla(); as m) {
      <p class="alerta"><i class="pi pi-exclamation-triangle"></i>
        La guía es de un solo vendedor y la selección tiene {{ m }}. Filtrá por vendedor
        arriba y armá una guía por cada uno.</p>
    }

    <!-- Lo que no se pudo medir se declara, no se dibuja (ADR-056) -->
    @if (vencNota(); as nota) {
      <p class="nota-proc"><i class="pi pi-info-circle"></i> {{ nota }}</p>
    }

    <!-- Tabla -->
    <!-- [UIM.2] Apilado por campos: las 8 columnas son campos de UN documento. -->
    <div class="card-premium card-flat tabla-wrap dt-scope">
      <app-load-state
        [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && rows().length === 0"
        emptyIcon="pi-file" emptyTitle="Sin documentos en el periodo"
        [emptyHint]="pista()"
        (retry)="load()">

        <!--
          [AX.12] Paginacion DEL SERVIDOR (lazy). Antes la tabla recibia lo que viniera y no
          habia paginador: el backend mandaba 50 y las otras 862 no existian para nadie, aunque
          el KPI de arriba las contara. Las opciones llegan a 200 porque esta medido que no le
          cuesta nada a la base -- el costo es armar la seleccion, no devolver las filas.
          NO PONER ACENTOS GRAVES ACA: este template es un template literal de TS y un acento
          grave lo cierra. Es la 6a vez que pasa en este repo (GOTCHAS).
        -->
        <p-table [value]="rows()" dataKey="folio_digital" [scrollable]="true" scrollHeight="calc(100vh - 25rem)"
                 [lazy]="true" (onLazyLoad)="paginar($event)" [paginator]="true"
                 [totalRecords]="totalDocs()" [rows]="tam()" [first]="primerRenglon()"
                 [rowsPerPageOptions]="[50, 100, 200]" [showCurrentPageReport]="true"
                 currentPageReportTemplate="{first} a {last} de {totalRecords} documentos"
                 [rowHover]="true" size="small"
                 class="surf-table surf-table--sticky surf-table--frozen-first tabla-docs dt-stack"
                 [tableStyle]="{ 'min-width': '62rem' }"
                 [selection]="sel()" (selectionChange)="sel.set($event)" selectionMode="multiple">
          <ng-template #header>
            <tr>
              <th scope="col" style="width:12.5rem"><p-tableheadercheckbox /> <span>Folio</span></th>
              <!-- Piso propio: es la unica columna flexible, y con el min-width de la tabla
                   repartido entre las fijas se quedaba con 80 px en tablet — el nombre del
                   cliente salia partido en una palabra por renglon. -->
              <th scope="col" style="min-width:17rem">Cliente</th>
              <th scope="col" style="width:6.5rem">Fecha</th>
              <th scope="col" style="width:8.5rem">Vence</th>
              <th scope="col" style="width:9rem" class="r">Total</th>
              <th scope="col" style="width:8.5rem" class="r">Saldo</th>
              <th scope="col" style="width:8rem">Cobro</th>
              <th scope="col" style="width:6.5rem" class="c">Anexo</th>
            </tr>
          </ng-template>

          <ng-template #body let-d>
            <!-- La fila abre el detalle; el checkbox NO (su celda corta la propagación), o
                 palomear una factura abriría el side-peek encima de la tabla cada vez. -->
            <tr class="fila-click" (click)="abrir(d)">
              <td class="c-folio dt-id" role="cell" (click)="$event.stopPropagation()">
                <p-tablecheckbox [value]="d" />
                <span>
                  <span class="mono folio">{{ d.sucursal }} {{ d.doc_prefix }}-{{ d.folio }}</span>
                  <!-- [AX.17] El embarque del que salio la factura, en lugar del tipo de documento:
                       el tipo era el mismo en las 5,929 facturas (no distinguia nada). Va sin JOIN:
                       es el back-pointer de Kepler; unidad y chofer viven en el detalle. -->
                  @if (d.doc_origen) {
                    <span class="sub mono">Embarque {{ d.doc_origen }}</span>
                  } @else {
                    <span class="sub">sin embarque en Kepler</span>
                  }
                </span>
              </td>
              <td role="cell" data-label="Cliente">
                <span class="nom">{{ d.cliente_nombre }}</span>
                <span class="sub mono">{{ d.cliente_code }}@if (d.vendedor_nombre) { · {{ d.vendedor_nombre }} }</span>
              </td>
              <td class="mono" role="cell" data-label="Fecha">{{ d.fecha | date: 'dd/MM/yy' }}</td>
              <td role="cell" data-label="Vence">
                <span class="mono" [class.derivada]="d.vencimiento_source !== 'erp'"
                      [pTooltip]="d.vencimiento_source === 'erp'
                        ? 'Fecha registrada en la cartera del ERP.'
                        : 'El ERP no tiene una fecha válida para este documento: se deriva de los días de crédito actuales del cliente.'">
                  {{ d.vencimiento | date: 'dd/MM/yy' }}{{ d.vencimiento_source === 'erp' ? '' : ' ~' }}
                </span>
                @if (d.vencida) {
                  <p-tag severity="danger" [value]="d.dias_vencida + 'd vencida'" styleClass="tg" />
                } @else if (d.dias_credito) {
                  <span class="sub">{{ d.dias_credito }} días</span>
                }
              </td>
              <td class="r mono strong dt-num" role="cell" data-label="Total">{{ d.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
              <td class="r mono dt-num" role="cell" data-label="Saldo">
                @if (d.saldo === null) { <span class="sub">—</span> }
                @else if (+d.saldo > 0.005) {
                  <span class="debe">{{ d.saldo | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
                } @else { <span class="sub">$0.00</span> }
              </td>
              <td role="cell" data-label="Cobro">
                <p-tag [severity]="COBRO_TONE[d.estatus_cobro]" [value]="COBRO_LABEL[d.estatus_cobro]" styleClass="tg" />
                @if (d.estatus_cobro === 'pagada' && d.dias_pago !== null) {
                  <span class="sub">en {{ d.dias_pago }}d</span>
                }
              </td>
              <td class="c acciones dt-actions" role="cell">
                @if (d.cancelada) {
                  <p-tag severity="secondary" value="Cancelada" styleClass="tg" />
                } @else {
                  <!--
                    [AX.14] UN botón, no dos. Hasta el 2026-10-26 había dos iconos —impresora y
                    PDF— que pedían el MISMO blob (anexoBlob del folio, con pagaré) y abrían la
                    MISMA pestaña: verPdf hacía window.open, e imprimir hacía lo mismo y además
                    llamaba a print(). Para quien mira la tabla eran dos caminos al mismo PDF, y
                    el de la izquierda no hacía nada que el otro no hiciera.

                    Queda el que cubre los dos trabajos: abre el PDF en su pestaña —donde se ve— y
                    ofrece el diálogo de impresión, que es a lo que viene esta pantalla («imprime el
                    detalle desglosado para el cliente»). Quien sólo quería verlo cierra el diálogo
                    y el PDF sigue ahí.
                  -->
                  <p-button icon="pi pi-print" [text]="true" size="small"
                            ariaLabel="Abrir el anexo en PDF e imprimirlo"
                            pTooltip="Abrir el PDF e imprimir" [loading]="busy() === d.folio_digital"
                            (onClick)="imprimir(d, $event)" />
                }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <!-- Detalle: side-peek, no modal (documento extenso) -->
    <app-side-peek [open]="peek()" (openChange)="peek.set($event)"
                   [title]="det()?.cliente_nombre || 'Documento'"
                   [subtitle]="det() ? det()!.sucursal + ' ' + det()!.doc_prefix + '-' + det()!.folio : null">
      @if (detLoading()) {
        <p class="peek-msg">Cargando detalle…</p>
      } @else if (det(); as x) {
        <div class="peek">
          <div class="peek-acc">
            @if (x.cancelada) {
              <p-tag severity="secondary" value="Cancelada en Kepler" />
              <span class="peek-hint">Sin anexo: el documento fue cancelado (estatus {{ x.doc_estatus }}).</span>
            } @else if (x.detalle_ausente) {
              <!-- [OBS.15.7] Sólo se afirma lo medido: la cabecera llegó y el ODS no tiene NINGÚN
                   renglón del documento (no es que se hayan filtrado por ser de servicio). El texto
                   anterior decía «Kepler tiene los renglones», y eso nadie lo había mirado. Con la
                   cola de cambios los renglones viajan con su cabecera en menos de 1 s, así que se
                   vuelve a consultar UNA vez; si siguen sin llegar, ya no es una carrera. -->
              @if (detReintento() === 'pendiente') {
                <p-tag severity="warn" value="Renglones sin llegar" />
                <span class="peek-hint">La cabecera llegó sin sus renglones. Volviendo a consultar…</span>
              } @else {
                <p-tag severity="danger" value="Renglones sin llegar" />
                <span class="peek-hint">Volvimos a consultar y la cabecera sigue sin sus renglones (no es una
                  factura de servicio). Si no aparecen en unos minutos, avisa a Sistemas con este folio.</span>
              }
            } @else if (x.sin_detalle) {
              <p-tag severity="warn" value="Sin detalle de producto" />
              <span class="peek-hint">Su único renglón es de servicio, no hay mercancía que desglosar.</span>
            } @else if (x.detalle_explica_total === false) {
              <p-tag severity="warn" value="Detalle incompleto" />
              <span class="peek-hint">Los renglones suman {{ x.importe_bruto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                y el CFDI dice {{ x.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}: falta detalle en Kepler.</span>
            } @else {
              <p-button icon="pi pi-print" label="Imprimir" size="small" (onClick)="imprimirDet(x)" />
              <span class="peek-hint">Incluye la sección de pagaré</span>
            }
          </div>

          <dl class="peek-kv">
            <dt>Fecha</dt><dd class="mono">{{ x.fecha | date: 'dd/MM/yyyy' }}</dd>
            <dt>Vence</dt>
            <dd class="mono">{{ x.vencimiento | date: 'dd/MM/yyyy' }}@if (x.dias_credito) { ({{ x.dias_credito }} días) }
              @if (x.vencimiento_source !== 'erp') {
                <span class="sub">derivada — el ERP no registró vencimiento válido</span>
              }
            </dd>
            <dt>Cobro</dt>
            <dd>
              <p-tag [severity]="COBRO_TONE[x.estatus_cobro]" [value]="COBRO_LABEL[x.estatus_cobro]" styleClass="tg" />
              @if (x.saldo !== null && +x.saldo > 0.005) {
                <span class="sub">saldo {{ x.saldo | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</span>
              } @else if (x.estatus_cobro === 'pagada' && x.dias_pago !== null) {
                <span class="sub">liquidada en {{ x.dias_pago }} días</span>
              } @else if (x.estatus_cobro === 'sin_cartera') {
                <span class="sub">no aparece en la cartera del ERP</span>
              }
            </dd>
            <dt>RFC</dt><dd class="mono">{{ x.cliente_rfc || '—' }}</dd>
            @if (x.vendedor_nombre) { <dt>Vendedor</dt><dd>{{ x.vendedor_nombre }}</dd> }
            <!-- [AX.17] Decia «Pedido», y el 100 % de esos folios son el EMBARQUE (UD4101), no el
                 pedido (UD40). Lo que no resuelve se declara; nunca se dibuja un embarque vacio. -->
            @if (x.embarque.status === 'resuelto') {
              <dt>Embarque</dt>
              <dd class="mono">{{ x.embarque.origen }}<span class="sub">{{ x.embarque.fecha | date: 'dd/MM/yyyy' }}</span></dd>
              @if (x.embarque.guia) { <dt>Viaje</dt><dd class="mono">guía {{ x.embarque.guia }}</dd> }
              <dt>Unidad</dt>
              <dd>
                @if (x.embarque.transporte) {
                  {{ x.embarque.transporte }}{{ x.embarque.transporte_metodo === 'normalizado' ? ' ~' : '' }}
                  @if (x.embarque.placas) { <span class="sub mono">{{ x.embarque.placas }}</span> }
                  @if (x.embarque.transporte_metodo === 'normalizado') {
                    <span class="sub">clave de la unidad resuelta sin ceros a la izquierda</span>
                  }
                } @else { <span class="sub">Kepler no registra la unidad</span> }
              </dd>
              <dt>Chofer</dt>
              <dd>
                @if (x.embarque.chofer && !x.embarque.chofer_sin_capturar) { {{ x.embarque.chofer }} }
                @else {
                  <span class="sub">no capturado en Kepler</span>
                  @if (x.embarque.chofer_asignado) {
                    <span class="sub">asignado a la unidad: {{ x.embarque.chofer_asignado }}</span>
                  }
                }
              </dd>
            } @else if (x.embarque.status === 'no_en_ods') {
              <dt>Embarque</dt>
              <dd class="mono">{{ x.embarque.origen }}<span class="sub">Kepler lo registra, pero no llegó a la réplica</span></dd>
            } @else {
              <dt>Embarque</dt><dd><span class="sub">Kepler no registra de qué embarque salió</span></dd>
            }
          </dl>

          <!-- [AX.17] Sólo lo que no cuadra: un embarque con más de una factura, a nombre de otro
               cliente, o cuyo importe difiere de lo facturado por más de $1 (hasta $1 es redondeo,
               87.3 % de los pares medidos). -->
          @if (x.embarque.status === 'resuelto') {
            @if (x.embarque.facturas.length > 1) {
              <p class="nota-emb"><i class="pi pi-info-circle" aria-hidden="true"></i>
                El embarque tiene {{ x.embarque.facturas.length }} facturas: {{ x.embarque.facturas.join(', ') }}.</p>
            }
            @if (x.embarque.cliente_distinto) {
              <p class="nota-emb"><i class="pi pi-info-circle" aria-hidden="true"></i>
                El embarque está a nombre de otro cliente: {{ x.embarque.destino || 'sin nombre en Kepler' }}.</p>
            }
            @if (x.embarque.diferencia !== null && (x.embarque.diferencia > 1 || x.embarque.diferencia < -1)) {
              <p class="nota-emb nota-emb--ojo"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                {{ x.embarque.facturas.length > 1 ? 'Las facturas suman' : 'La factura es por' }}
                {{ x.embarque.total_facturas | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }} y el embarque
                fue por {{ x.embarque.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}:
                {{ (x.embarque.diferencia > 0 ? x.embarque.diferencia : -x.embarque.diferencia) | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                {{ x.embarque.diferencia > 0 ? 'más' : 'menos' }} de lo embarcado.</p>
            }
          }

          <!-- Los abonos que explican el saldo: sin esto, "pagada" es una palabra sin respaldo -->
          @if (x.aplicaciones?.length) {
            <table class="peek-lin">
              <thead><tr><th>Abonos aplicados</th><th class="r">Fecha</th><th class="r">Monto</th></tr></thead>
              <tbody>
                @for (a of x.aplicaciones; track a.folio + a.tipo) {
                  <tr>
                    <td><span class="nom">{{ a.label }}</span><span class="sub mono">{{ a.folio }}</span></td>
                    <td class="r mono">{{ a.fecha || '—' }}</td>
                    <td class="r mono">{{ a.monto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }

          <table class="peek-lin">
            <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Neto</th></tr></thead>
            <tbody>
              @for (l of x.lineas; track l.linea) {
                <tr>
                  <td><span class="nom">{{ l.descripcion }}</span><span class="sub mono">SKU {{ l.sku }}</span></td>
                  <td class="r mono">{{ l.cantidad }} {{ l.unidad }}
                    @if (l.cajas_equivalentes && l.unidad_bulto) { <span class="sub">= {{ l.cajas_equivalentes }} {{ l.unidad_bulto }}</span> }
                  </td>
                  <td class="r mono">{{ l.neto | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr><td>Total</td><td></td>
                <td class="r mono strong">{{ x.total | currency: 'MXN':'symbol-narrow':'1.2-2':'es-MX' }}</td></tr>
            </tfoot>
          </table>
        </div>
      }
    </app-side-peek>
  </div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .live { color: var(--ok, var(--text-soft)); font-weight: 600; }

    .barra {
      display: flex; align-items: center; gap: .5rem;
      padding: .5rem .75rem; margin-bottom: .5rem;
      border-left: 3px solid var(--action);
      transition: opacity .15s ease; flex-wrap: wrap;
    }
    .barra.vacia { border-left-color: var(--border-color); opacity: .75; }
    .barra .cuenta { display: flex; align-items: baseline; gap: .4rem; flex: 1 1 14rem; min-width: 0; }
    .barra .n { font-family: var(--font-mono, ui-monospace, monospace); font-size: 1.05rem; font-weight: 700; }
    .barra .l { font-size: var(--fs-sm); color: var(--text-main); }
    .barra .det { font-size: var(--fs-sm); color: var(--text-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .barra .resp { width: 13rem; min-width: 8rem; font-size: var(--fs-sm); }
    .alerta {
      display: flex; align-items: center; gap: .45rem; margin: 0 0 .5rem;
      font-size: var(--fs-sm); font-weight: 600; color: var(--danger, var(--text-main));
    }
    @media (max-width: 62.5rem) {
      .barra .cuenta { flex: 1 1 100%; }
      .barra .resp { flex: 1 1 10rem; width: auto; }
    }
    @media (max-width: 30rem) {
      .barra { gap: .45rem; }
      .barra .resp { flex: 1 1 100%; }
      .barra > p-button { flex: 1 1 auto; }
      .barra ::ng-deep .p-button { width: 100%; min-height: var(--tap-min, 44px); }
    }

    /* La 1a columna es la congelada: lleva el identificador y el checkbox, para que al correr
       la tabla en horizontal se siga viendo QUE se esta palomeando. */
    .c-folio { display: flex; align-items: flex-start; gap: .5rem; }
    .fila-click { cursor: pointer; }
    .tabla-docs th:first-child { white-space: nowrap; }
    .tabla-wrap { padding: 0; overflow: hidden; min-width: 0; }

    /* Estas dos tablas se salen de la regla global vieja de styles.css (<=60rem esconde de la
       4a columna en adelante y pega la ultima a la derecha). Ese patron de "columnas
       prioritarias" pelea con el canon de DESIGN_TABLES -- scroll horizontal + 1a columna
       congelada -- que es el que aplica aca: en la guia de cobranza el Saldo y el Total son
       justo lo que no se puede esconder, y la ultima columna pegada a la derecha se encimaba
       encima de Cliente en 390 px. */
    @media (max-width: 60rem) {
      :host ::ng-deep .tabla-docs .p-datatable-thead > tr > th,
      :host ::ng-deep .tabla-docs .p-datatable-tbody > tr > td { display: table-cell !important; }
      :host ::ng-deep .tabla-docs .p-datatable-thead > tr > th:last-child,
      :host ::ng-deep .tabla-docs .p-datatable-tbody > tr > td:last-child {
        position: static !important; right: auto !important;
        box-shadow: none !important; min-width: 0 !important;
      }
    }


    /* Telefono: la tabla deja de tener scroll vertical PROPIO y crece; el que scrollea es la
       pagina. Con un scrollHeight fijo quedaban ~4 renglones dentro de una ventanita de 6 cm
       con la bottom-nav encima. El scroll horizontal (y la 1a columna congelada) siguen. */
    @media (max-width: 48rem) {
      .tabla-docs .p-datatable-table-container,
      :host ::ng-deep .tabla-docs .p-datatable-table-container { max-height: none !important; }
    }

    .tabla-docs th.r, .tabla-docs td.r { text-align: right; }
    .tabla-docs th.c, .tabla-docs td.c { text-align: center; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-variant-numeric: tabular-nums; }
    .folio { font-weight: 650; display: block; }
    .nom { display: block; font-weight: 600; line-height: 1.25; }
    .sub { display: block; font-size: var(--fs-xs, .75rem); color: var(--text-soft); margin-top: 1px; }
    td .sub { display: inline-block; margin-left: .25rem; }
    .strong { font-weight: 700; }
    .save { color: var(--ok, var(--text-main)); }
    .debe { font-weight: 650; color: var(--danger, var(--text-main)); }
    /* fecha derivada: se distingue de la que el ERP sí registró, sin gritar */
    .derivada { color: var(--text-soft); font-style: italic; }
    .nota-proc {
      display: flex; align-items: center; gap: .4rem; margin: -.25rem 0 .5rem;
      font-size: var(--fs-xs, .75rem); color: var(--text-soft);
    }
    .tg { margin-left: .35rem; }
    .acciones { white-space: nowrap; }

    .peek { display: flex; flex-direction: column; gap: .875rem; }
    .peek-msg { color: var(--text-soft); font-size: var(--fs-sm); }
    .peek-acc { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    .peek-hint { font-size: var(--fs-xs, .75rem); color: var(--text-soft); }
    /* [AX.17] lo que no cuadra entre la factura y su embarque: sólo aparece cuando pasa */
    .nota-emb { display: flex; align-items: flex-start; gap: .4rem; margin: 0; font-size: var(--fs-xs, .75rem); color: var(--text-soft); }
    .nota-emb--ojo { color: var(--text-main); }
    .peek-kv { display: grid; grid-template-columns: auto 1fr; gap: .25rem .75rem; margin: 0; font-size: var(--fs-sm); }
    .peek-kv dt { color: var(--text-soft); font-weight: 600; }
    .peek-kv dd { margin: 0; text-align: right; font-weight: 600; }
    .peek-lin { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .peek-lin th { text-align: left; font-size: var(--fs-xs, .75rem); text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-soft); font-weight: 700; padding: .35rem .25rem;
      border-bottom: 1px solid var(--border); }
    .peek-lin td { padding: .4rem .25rem; border-bottom: 1px solid var(--border-soft, var(--border)); vertical-align: top; }
    .peek-lin th.r, .peek-lin td.r { text-align: right; }
    .peek-lin tfoot td { border-bottom: 0; border-top: 1px solid var(--border); font-weight: 700; padding-top: .5rem; }
  `],
})
export class ComercialDocumentosComponent {
  private readonly svc = inject(SalesDocumentsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  readonly report = signal<SalesDocsReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  /** Lo palomeado para la guía. La fila NO se "selecciona" al abrir el detalle (GT.14). */
  readonly sel = signal<SalesDocRow[]>([]);
  responsable = '';
  /** Lo último que se autocompletó desde el vendedor: lo escrito a mano no se pisa. */
  private respAuto = '';
  readonly peek = signal(false);
  readonly det = signal<SalesDocDetail | null>(null);
  readonly detLoading = signal(false);
  /** [OBS.15.7] El documento llegó sin renglones: 'pendiente' mientras se vuelve a consultar. */
  readonly detReintento = signal<'pendiente' | 'hecho' | null>(null);
  private reintentoTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelarReintento(): void {
    if (this.reintentoTimer) { clearTimeout(this.reintentoTimer); this.reintentoTimer = null; }
  }
  private readonly catalogos = signal<SalesDocsFiltros | null>(null);
  private readonly scope = inject(DataScopeService);
  /**
   * GT.11 — sucursales que este usuario alcanza (`/users/me/scope`). Alimenta el selector;
   * NO es el control de acceso: el backend recorta igual (ADR-050). Si el usuario tiene una
   * sola, se fija como filtro desde el arranque para que la primera consulta ya sea la suya.
   */
  readonly sucursales = signal<{ label: string; value: string }[]>([]);
  readonly alcanceLeido = signal(false);

  readonly filtros = signal<TmFiltros>(tmFiltrosIniciales());

  readonly tabs = TELEMARKETING_TABS;
  /** Ver el comentario gemelo en Reportes: las respuestas del ERP vuelven fuera de orden. */
  private peticion = 0;
  readonly vendedorOpts = computed(() =>
    (this.catalogos()?.vendedores || []).map((v) => ({ label: v.vendedor_nombre, value: v.vendedor_code })));

  constructor() {
    // [OBS.15.7] Un reintento que dispara con la vista ya destruida pediría `takeUntilDestroyed`
    // sobre un DestroyRef muerto, que tira. Se cancela al salir (y al abrir otro documento).
    this.destroyRef.onDestroy(() => this.cancelarReintento());
    this.scope.warehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ops) => {
        this.sucursales.set(ops);
        this.alcanceLeido.set(true);
        // Una sola sucursal ⇒ va fija en el filtro. Sin esto la primera consulta sale sin
        // sucursal y el backend igual la recorta, pero la pantalla no diría cuál está viendo.
        if (ops.length === 1 && !this.filtros().sucursal) {
          this.filtros.update((f) => ({ ...f, sucursal: ops[0].value }));
          this.load();
        }
      },
      error: () => this.alcanceLeido.set(true),
    });
    this.load();
    // Deep-link `?doc=01UD0801-0000875`: se llega desde otra pantalla (p.ej. el auxiliar de
    // /finanzas/cartera) con un documento concreto en la mano. Abre el side-peek directo, sin
    // depender de que ese folio caiga en la ventana de fechas de la tabla.
    const doc = this.route.snapshot.queryParamMap.get('doc');
    if (doc) this.abrirPorFolio(doc);
  }

  /**
   * AX.9 — el KPI de vencido dejó de contar fechas y pasó a contar deuda.
   * Antes marcaba 355 documentos "vencidos" por $3.32M en 30 días; 91 de ellos ($567,504) ya
   * estaban cobrados. Lo que se publica ahora es el **saldo** de las que vencieron y aún deben.
   */
  kpis(r: SalesDocsReport): MetricStripItem[] {
    const k = r.kpis;
    const porCobrar = Number(k.saldo_vencido) || 0;
    const items: MetricStripItem[] = [
      { label: 'Documentos', value: k.documentos, format: 'number' },
      { label: 'Importe', value: Number(k.importe), format: 'currency' },
      { label: 'Cobrado', value: Number(k.importe) - (Number(k.saldo) || 0), format: 'currency', tone: 'ok' },
      { label: 'Vencido por cobrar', value: porCobrar, format: 'currency', tone: porCobrar > 0 ? 'bad' : undefined },
      { label: 'Facturas vencidas', value: k.vencidas, format: 'number', tone: k.vencidas > 0 ? 'bad' : undefined },
    ];
    // Lo que no se pudo medir NO se dibuja como cero: si hay documentos fuera de la cartera,
    // su cobranza es desconocida y ocupa su propio lugar en el strip (ADR-056).
    if (k.sin_cartera > 0) {
      items.push({ label: 'Cobro desconocido', value: k.sin_cartera, format: 'number', tone: 'warn' });
    }
    return items;
  }

  /**
   * Declara lo que no se sabe: cuántos vencimientos son una reconstrucción y no el hecho del
   * ERP, y cuántos documentos ni siquiera están en la cartera (ADR-056: `unknown` es un estado,
   * no un cero). Medido en prod: 69 de 816 vencimientos derivados y 9 documentos sin cartera.
   */
  readonly vencNota = computed(() => {
    const k = this.report()?.kpis;
    if (!k || !k.documentos) return null;
    const partes: string[] = [];
    const derivadas = k.documentos - (k.venc_erp ?? 0);
    if (derivadas > 0) {
      partes.push(`${derivadas} de ${k.documentos} vencimientos no vienen de la cartera del ERP: se derivan de los días de crédito actuales del cliente (marcados con ~).`);
    }
    if (k.sin_cartera > 0) {
      partes.push(`${k.sin_cartera} ${k.sin_cartera === 1 ? 'documento no aparece' : 'documentos no aparecen'} en la cartera: no se puede saber si ya ${k.sin_cartera === 1 ? 'se cobró' : 'se cobraron'}, y quedan fuera del vencido.`);
    }
    return partes.length ? partes.join(' ') : null;
  });


  /**
   * Qué decir cuando la ventana no trajo nada. Un "ajusta el rango" a secas deja al usuario
   * adivinando: si sabemos cuándo fue la última factura del canal, se dice. Sin eso, la
   * pantalla de 8 dias arranca en blanco cada vez que el feed viene atrasado y se lee como
   * que la app esta rota.
   */
  readonly pista = computed(() => {
    const u = this.report()?.ultima_factura;
    if (!u) return 'Ajusta el rango de fechas o quita filtros para ver facturas.';
    const [a, m, d] = [u.slice(2, 4), u.slice(5, 7), u.slice(8, 10)];
    return `La última factura de esta selección es del ${d}/${m}/${a}. Ajusta el rango de fechas.`;
  });

  readonly COBRO_LABEL: Record<string, string> = {
    pagada: 'Pagada', parcial: 'Abono parcial', pendiente: 'Pendiente',
    sin_cartera: 'Sin cartera', cancelada: 'Cancelada',
  };
  readonly COBRO_TONE: Record<string, 'success' | 'warn' | 'danger' | 'secondary' | 'info'> = {
    pagada: 'success', parcial: 'warn', pendiente: 'info',
    sin_cartera: 'secondary', cancelada: 'secondary',
  };

  aplicar(f: TmFiltros): void {
    const antes = this.filtros().vendedor;
    this.filtros.set(f);
    if (f.vendedor !== antes) this.autoResponsable(f.vendedor);
    /*
     * `[AX.12]` Cambiar un filtro vuelve a la página 1. Sin esto, alguien parado en la página 9
     * que escribe una búsqueda que deja 3 resultados se queda mirando una tabla vacía —y esa
     * tabla vacía dice "Sin documentos en el periodo", que sería falso.
     */
    this.pagina.set(1);
    // Cambiar el filtro cambia la selección de documentos: lo palomeado deja de tener sentido.
    // Ver el comentario de `load()` — con paginación de servidor no se puede podar sin traerse
    // la selección entera, y palomeado-que-ya-no-aplica se imprimiría sin que nadie lo viera.
    this.sel.set([]);
    this.load();
  }

  /**
   * Al elegir vendedor, su nombre entra como Responsable de la guía: en el 99% de los casos
   * el que sale a cobrar es el mismo que vendió. Editable, y lo escrito a mano no se pisa.
   */
  private autoResponsable(vendedor: string | null): void {
    if (this.responsable.trim() && this.responsable !== this.respAuto) return;
    const nombre = vendedor
      ? (this.catalogos()?.vendedores || []).find((v) => v.vendedor_code === vendedor)?.vendedor_nombre || ''
      : '';
    this.responsable = nombre;
    this.respAuto = nombre;
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    const mia = ++this.peticion;
    const f = this.filtros();
    const q = {
      from: f.desde, to: f.hasta, search: f.search || undefined,
      vendedor_code: f.vendedor || undefined,
      cobro: f.cobro.length ? f.cobro.join(',') : undefined,
      vencidas: f.soloVencidas ? 'true' : undefined,
      warehouse_codes: f.sucursal || undefined,
      sort: f.orden || undefined,
      // `[AX.12]` La página viaja al servidor. Antes no se mandaba nada, el backend caía en su
      // default y la tabla mostraba las primeras 50 **sin decirlo y sin manera de pasar a la
      // siguiente**: medido en prod, 912 documentos en la ventana por defecto → 862 (94.5%)
      // inalcanzables, mientras el KPI del encabezado sí decía 912.
      page: this.pagina(),
      pageSize: this.tam(),
    };
    this.svc.list(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (mia !== this.peticion) return; // llegó tarde: manda la consulta nueva
        this.report.set(r);
        /*
         * `[AX.12]` La selección **sobrevive al cambio de página** y se limpia al cambiar de
         * filtro.
         *
         * Acá antes se podaba contra `r.rows` — "dejar palomeada una factura que ya no está en
         * la lista imprimiría algo que nadie vio". Con paginación de servidor eso se vuelve
         * falso: `r.rows` es SÓLO la página, así que palomear 10 en la página 1 y avanzar a la 2
         * habría borrado las 10. Y podar contra la página nueva tampoco sirve: lo seleccionado
         * puede estar legítimamente en la página 5.
         *
         * Por eso la limpieza vive en `aplicar()` —el único lugar donde de verdad cambia la
         * selección de documentos— y esta respuesta ya no toca `sel`.
         */
        this.loading.set(false);
      },
      error: (e) => {
        if (mia !== this.peticion) return;
        this.error.set(e?.error?.message || 'No se pudieron cargar los documentos.');
        this.loading.set(false);
      },
    });
    /*
     * `[AX.12]` Los catálogos dependen SÓLO de la ventana (fechas + sucursal): son "los
     * vendedores que facturaron en este periodo", y a propósito no se recortan por el vendedor
     * ya elegido ni por la búsqueda — si se recortaran, el selector se quedaría con la única
     * opción que ya está puesta y no se podría cambiar.
     *
     * Por eso no tiene por qué volver a pedirse al cambiar de página, de orden o de texto. Cuesta
     * **~350 ms** medidos contra prod, y se estaba pagando en cada tecleo.
     */
    const ventana = `${q.from}|${q.to}|${q.warehouse_codes ?? ''}`;
    if (ventana !== this.ventanaCatalogos) {
      this.ventanaCatalogos = ventana;
      // si fallan, los filtros quedan vacíos sin romper la tabla
      this.svc.filtros(q).pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (c) => this.catalogos.set(c), error: () => (this.ventanaCatalogos = '') });
    }
  }

  // ── `[AX.12]` Paginación del servidor ────────────────────────────────────────

  readonly pagina = signal(1);
  readonly tam = signal(100);
  /** Total de la SELECCIÓN, no de la página: sale del mismo KPI que ya se calculaba. */
  readonly totalDocs = computed(() => this.report()?.kpis?.documentos ?? 0);
  /** Primer renglón de la página actual, que es lo que el paginador de PrimeNG entiende. */
  readonly primerRenglon = computed(() => (this.pagina() - 1) * this.tam());
  /** Ventana de la que ya se pidieron catálogos; `''` fuerza a volver a pedirlos. */
  private ventanaCatalogos = '';

  /**
   * `[AX.12]` Cambio de página / de tamaño. Es el `(onLazyLoad)` de la tabla: el servidor manda
   * el renglón, no el navegador. `first` viene en renglones y la API pagina en páginas.
   */
  paginar(ev: TableLazyLoadEvent): void {
    const tam = ev.rows || this.tam();
    const pag = Math.floor((ev.first || 0) / tam) + 1;
    if (pag === this.pagina() && tam === this.tam()) return;
    this.tam.set(tam);
    this.pagina.set(pag);
    this.load();
  }

  abrir(row: SalesDocRow | null): void {
    if (!row) return;
    this.abrirPorFolio(row.folio_digital);
  }

  limpiar(): void { this.sel.set([]); }

  readonly clientesSel = computed(() => new Set(this.sel().map((d) => d.cliente_code)).size);
  /** Lo que se va a cobrar: el saldo; sin cartera no hay saldo medido y se cobra el total. */
  readonly importeSel = computed(() =>
    this.sel().reduce((a, d) => a + (d.saldo === null ? Number(d.total) || 0 : Number(d.saldo) || 0), 0));
  /** Cuántos vendedores distintos hay en la selección — `0` cuando no hay mezcla. */
  readonly mezcla = computed(() => {
    const n = new Set(this.sel().map((d) => d.vendedor_code || '(sin vendedor)')).size;
    return n > 1 ? n : 0;
  });
  readonly listo = computed(() => this.sel().length > 0 && !this.mezcla());

  /**
   * GT.14 — generar la guía: se archiva el expediente y se manda a imprimir de una. El
   * cobrador sale con el papel; el expediente queda en el historial del vendedor.
   */
  generarGuia(): void {
    if (!this.listo()) return;
    const folios = this.sel().map((d) => d.folio_digital);
    // La pestaña se abre YA, dentro del clic: abrirla al llegar el PDF la bloquea el navegador.
    const win = abrirPestanaParaPdf('Preparando la guía de cobranza…');
    this.busy.set('guia');
    this.svc.guiaCobranzaBlob(folios, { responsable: this.responsable || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (res) => {
          this.busy.set(null);
          const folio = res.headers.get('X-Expediente-Folio');
          const donde = entregarPdf(win, res.body as Blob, 'guia-' + (folio || 'cobranza'), { imprimir: true });
          this.sel.set([]);
          // El expediente SIEMPRE se archivó; lo que cambia es dónde quedó el papel. Decirlo
          // al revés es afirmar una impresión que no ocurrió.
          this.toast.add({
            severity: 'success', summary: `Expediente ${folio || 'archivado'}`,
            detail: donde === 'pestana'
              ? 'La guía se archivó en Expedientes y se mandó a imprimir.'
              : 'La guía se archivó en Expedientes y se descargó: el navegador bloqueó la ventana, ábrela desde tus descargas para imprimirla.',
            life: donde === 'pestana' ? 6000 : 9000,
          });
        },
        error: (e) => {
          this.busy.set(null);
          cerrarPestanaDePdf(win);
          // El endpoint responde blob: el mensaje del backend viene DENTRO del blob.
          mensajeDeErrorBlob(e).then((detail) => this.toast.add({
            severity: 'error', summary: 'No se pudo generar la guía', detail, life: 8000,
          }));
        },
      });
  }

  /**
   * Abre el detalle por folio digital, venga de la tabla o de un deep-link.
   *
   * `[OBS.15.7]` Si llega sin renglones (`detalle_ausente`), vuelve a consultar UNA vez a los 3 s
   * sin vaciar el panel. Con la cola de cambios la cabecera y sus renglones viajan juntos en menos
   * de 1 s, así que sólo una carrera muy corta lo explica; si al segundo intento siguen sin llegar,
   * el panel lo dice. El reintento se descarta si mientras tanto se cerró el panel o se abrió otro
   * documento: su respuesta ya no le corresponde a lo que se está viendo.
   */
  private abrirPorFolio(folioDigital: string, reintento = false): void {
    if (!reintento) {
      this.cancelarReintento();
      this.det.set(null);
      this.detLoading.set(true);
      this.detReintento.set(null);
      this.peek.set(true);
    }
    const sigueAbierto = () => this.peek() && this.det()?.folio_digital === folioDigital;
    this.svc.detail(folioDigital).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        if (reintento && !sigueAbierto()) return;
        this.det.set(d);
        this.detLoading.set(false);
        if (reintento) { this.detReintento.set('hecho'); return; }
        if (d.detalle_ausente) {
          this.detReintento.set('pendiente');
          this.reintentoTimer = setTimeout(() => {
            this.reintentoTimer = null;
            if (sigueAbierto()) this.abrirPorFolio(folioDigital, true);
          }, 3000);
        }
      },
      error: () => {
        if (reintento) { if (sigueAbierto()) this.detReintento.set('hecho'); return; }
        this.detLoading.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo abrir el documento', life: 4000 });
      },
    });
  }

  // ── PDF ────────────────────────────────────────────────────────────────
  // El endpoint exige JWT: hay que traer el blob (el interceptor pone el header). Abrir la URL
  // en una pestaña mandaría la petición sin token y devolvería 401.
  /**
   * ⛔ `win` se abre en el CLIC y llega hasta acá. Abrirla al llegar el blob es lo que el
   * bloqueador de ventanas emergentes rechaza (ver `abrir-pdf.ts`): el gesto ya terminó.
   */
  private conBlob(folio: string, pagare: boolean, win: Window | null): void {
    this.busy.set(folio);
    this.svc.anexoBlob(folio, pagare).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        this.busy.set(null);
        const donde = entregarPdf(win, b, 'anexo-' + folio, { imprimir: true });
        if (donde === 'descarga') {
          this.toast.add({
            severity: 'warn', summary: 'El navegador bloqueó la ventana',
            detail: 'El anexo ' + folio + ' se descargó: ábrelo desde tus descargas para imprimirlo.',
            life: 7000,
          });
        }
      },
      error: () => {
        this.busy.set(null);
        cerrarPestanaDePdf(win);
        this.toast.add({ severity: 'error', summary: 'No se pudo generar el anexo', life: 4000 });
      },
    });
  }

  // `[AX.14]` Acá vivía `verPdf`, que pedía el MISMO blob y abría la MISMA pestaña que
  // `imprimir` — sólo que sin llamar a `print()`. Se retira con su botón: un método muerto
  // detrás de una pantalla es el que la próxima persona vuelve a cablear sin saber por qué.
  imprimir(d: SalesDocRow, ev?: Event): void {
    ev?.stopPropagation();
    this.conBlob(d.folio_digital, true, abrirPestanaParaPdf('Preparando el anexo…'));
  }

  imprimirDet(d: SalesDocDetail): void {
    this.conBlob(d.folio_digital, true, abrirPestanaParaPdf('Preparando el anexo…'));
  }
}
