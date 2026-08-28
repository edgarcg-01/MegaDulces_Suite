import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, of, switchMap, catchError, debounceTime, firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import {
  EntradasService, EntradaRow, EntradasReport, EntradasQuery, ProofFile, RemisionOcr, AttachReceipt,
} from '../entradas.service';
import { branchName, STORE_BRANCHES } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { motivoLabel } from '../receipt-verdict';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** En qué punto va una hoja de la bandeja. `enlazada` = ya sabe a qué entrada pertenece. */
type EstadoHoja = 'leyendo' | 'enlazada' | 'ambigua' | 'sin_match' | 'duplicada' | 'guardada' | 'error';

/** Un PDF en la bandeja, con su lectura y la entrada a la que va. */
interface Hoja {
  id: number;
  name: string;
  dataUri: string;
  bytes: number;
  estado: EstadoHoja;
  sha256?: string;
  folioOcr?: string | null;
  total?: number | null;
  subtotal?: number | null;
  fecha?: string | null;
  rfc?: string | null;
  ocr?: Partial<RemisionOcr>;
  /** A qué orden de entrada va. Se preselecciona si el PDF se soltó sobre una fila. */
  entrada?: EntradaRow | null;
  /** Se enlazó por importe y no por folio: vale decirlo, es un enlace más débil. */
  porMonto?: boolean;
  candidatas?: EntradaRow[];
  dupDe?: string | null;
  motivo?: string;
  busqueda?: string;
  buscando?: boolean;
}

/**
 * `[RE.16.4]` — **Pendientes de subir**: la worklist del que tiene las facturas.
 *
 * Rediseñada sobre dos hechos que corrigieron el diseño anterior:
 *
 *  1. **Todos capturan en lap o escritorio**, no en el celular junto a la mercancía. La lista
 *     apilada de 56 px por renglón mostraba 8 órdenes donde caben 25, y el diálogo modal tapaba
 *     justo la tabla que hay que seguir mirando. Ahora: tabla densa + panel lateral.
 *  2. **El PDF ya existe** en la carpeta del escáner. Adjuntarlo costaba cuatro interacciones
 *     (botón → diálogo → elegir archivo → guardar); ahora **se arrastra sobre su fila** y es una.
 *
 * Y con eso desaparece una pantalla: **soltar varios PDFs a la vez ES el lote de CEDIS**. La
 * bandeja es la misma lista de hojas, sólo cambia de dónde salió la entrada — de la fila donde
 * se soltó, o del folio que leyó el OCR. Guardar es un solo camino (`attach-bulk`, agrupando por
 * expediente), así que no hay dos lógicas de guardado que se puedan ir separando con el tiempo.
 *
 * Vocabulario único de la fase: **Sin factura → Por revisar → Validada**, con **Devuelta** como
 * el único camino de regreso. Antes cada pantalla les daba un nombre distinto.
 *
 * Lo que NO vive acá: la auditoría por línea, los ajustes del proveedor y la validación. Son el
 * trabajo del revisor (`/compras/entradas/revision`) y del Centro de control.
 */
@Component({
  selector: 'app-compras-entradas-pendientes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, FormsModule, ButtonModule, DialogModule, InputTextModule, SelectModule,
    TagModule, ToastModule, TooltipModule, SegmentedComponent, LoadStateComponent,
    FreshnessPillComponent, ContextHelpComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page in ep">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pendientes de subir</h1>
          <p class="surf-page-sub">
            Arrastrá el <strong>PDF de la factura</strong> sobre su orden. Leo el total, lo comparo
            contra Kepler y te digo si cuadra antes de guardar. Lo más atrasado va primero.
          </p>
        </div>
        <div class="ep-head-actions">
          @if (variasSucursales()) {
            <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                      optionLabel="label" optionValue="value" placeholder="Todas las mías" [showClear]="true"
                      styleClass="ep-sel" ariaLabel="Sucursal" appendTo="body" />
          } @else if (unaSucursal(); as s) {
            <span class="ep-suc-fija" pTooltip="Tu alcance es esta sucursal" tooltipPosition="bottom">
              <i class="pi pi-building" aria-hidden="true"></i> {{ s }}
            </span>
          }
          <app-freshness-pill [since]="cargadoAt()" [staleAfterSec]="600" />
          <app-context-help topic="compras-entradas" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="reload()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (sinAlcance()) {
        <!-- Fail-closed explicado: sin sucursal en la ficha no hay filas, y una tabla vacía se
             lee como "el sistema no funciona". -->
        <div class="ep-block" role="status">
          <i class="pi pi-lock" aria-hidden="true"></i>
          <div>
            <p class="ep-block-t">Tu usuario no tiene sucursal asignada</p>
            <p class="ep-block-s">Sin sucursal no hay entradas que mostrarte. Pedile a Sistemas que te
              configure el alcance de sucursal y volvé a entrar.</p>
          </div>
        </div>
      } @else {

        @if (report(); as r) {
          <!-- Answer-first (DESIGN Q.1): una oración con lo que falta, antes de la tabla. -->
          <p class="ep-verdict" [class.is-done]="faltan(r) === 0" [class.is-late]="r.kpis.atrasadas > 0">
            @if (faltan(r) === 0) {
              <i class="pi pi-check-circle" aria-hidden="true"></i> Todo al día — no te falta subir nada.
            } @else {
              Te faltan <b>{{ faltan(r) }}</b> facturas de {{ r.kpis.entradas }}
              @if (r.kpis.atrasadas > 0) {
                · <button type="button" class="ep-late-btn" (click)="soloAtrasadas()"
                          [pTooltip]="'Más de ' + r.settings.sla_capture_days + ' días sin factura'" tooltipPosition="bottom">
                  {{ r.kpis.atrasadas }} ya pasaron los {{ r.settings.sla_capture_days }} días
                </button>
              }
              <span class="ep-bar" [attr.aria-label]="avance(r) + '% subido'">
                <span [style.width.%]="avance(r)"></span>
              </span>
              <em>{{ avance(r) }}% subido</em>
            }
          </p>

          @if (r.kpis.rechazados > 0 && estado() !== 'rechazado') {
            <!-- Una factura devuelta se quedaba muerta: el que la subió nunca se enteraba. -->
            <button type="button" class="ep-returned" (click)="setEstado('rechazado')">
              <i class="pi pi-undo" aria-hidden="true"></i>
              <span><strong>{{ r.kpis.rechazados }}</strong> te {{ r.kpis.rechazados === 1 ? 'la devolvieron' : 'las devolvieron' }} — hay que volver a subirlas</span>
              <i class="pi pi-angle-right" aria-hidden="true"></i>
            </button>
          }
        }

        <div class="ep-filters">
          <app-segmented [options]="estadoOpts" [value]="estado()" (valueChange)="setEstado($event)" ariaLabel="Qué mostrar" />
          <!--
            Buscador con sugerencias. Antes había que teclear y adivinar: se filtraba recién al
            salir del campo o al dar Enter, y si no aparecía nada no se sabía si el folio estaba
            mal escrito o simplemente no había entrada. Ahora el resultado se ve mientras se
            escribe, con proveedor e importe, que es lo que permite reconocer la orden correcta.
          -->
          <div class="ep-ac" role="combobox" [attr.aria-expanded]="sugOpen()" aria-haspopup="listbox">
            <input pInputText [ngModel]="search()" (ngModelChange)="onSearch($event)"
                   (keydown)="onSearchKey($event)" (focus)="abrirSug()" (blur)="cerrarSug()"
                   placeholder="Últimos 4 del folio (ej. 0397) o proveedor…" class="ep-search"
                   aria-label="Buscar entrada" autocomplete="off"
                   [attr.aria-activedescendant]="sugIdx() >= 0 ? 'sug-' + sugIdx() : null" />
            @if (search()) {
              <button type="button" class="ep-ac-x" (click)="limpiarBusqueda()" aria-label="Limpiar la búsqueda">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            }
            @if (sugOpen()) {
              <ul class="ep-ac-list" role="listbox" aria-label="Entradas que coinciden">
                @if (sugLoading()) {
                  <li class="ep-ac-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando…</li>
                } @else if (!sug().length) {
                  <!-- Decir POR QUÉ no hay nada: el filtro de estado es la causa más común. -->
                  <li class="ep-ac-msg">
                    Nada con «{{ search() }}» entre las <b>{{ etiquetaEstado() }}</b>.
                    <button type="button" class="ep-link" (mousedown)="$event.preventDefault()" (click)="buscarEnTodas()">
                      Buscar en todas
                    </button>
                  </li>
                } @else {
                  @for (e of sug(); track e.sucursal + '/' + e.folio; let i = $index) {
                    <li [id]="'sug-' + i" role="option" [attr.aria-selected]="sugIdx() === i"
                        class="ep-ac-op" [class.on]="sugIdx() === i"
                        (mousedown)="$event.preventDefault()" (click)="elegirSug(e)" (mouseenter)="sugIdx.set(i)">
                      <b class="mono">{{ ultimos4(e.folio) }}</b>
                      <span>{{ e.proveedor_nombre || e.proveedor_code || '—' }}</span>
                      <em class="mono">{{ money(e.monto) }}</em>
                      <i class="ep-ac-d" [class.late]="e.atrasada">{{ e.dias }}d</i>
                    </li>
                  }
                }
              </ul>
            }
          </div>
          @if (rezago()) {
            <button pButton type="button" class="p-button-sm p-button-text" (click)="setRezago(false)"
                    pTooltip="Volver al periodo del proceso" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
              <span class="p-button-label">Salir del rezago</span>
            </button>
          } @else if (report()?.settings; as cfg) {
            <button pButton type="button" class="p-button-sm p-button-text ep-rezago" (click)="setRezago(true)"
                    [pTooltip]="'Entradas anteriores al ' + cfg.reception_start + ' — fuera del proceso vivo'" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span>
              <span class="p-button-label">Ver rezago</span>
            </button>
          }
          <span class="ep-sp"></span>
          @if (canManage()) {
            <label class="ep-pick small">
              <i class="pi pi-file-pdf" aria-hidden="true"></i> Elegir PDFs…
              <input type="file" accept="application/pdf" multiple (change)="onFiles($event)" hidden />
            </label>
          }
        </div>

        <div class="ep-body">
          <!-- Zona de soltado de TODA la tabla: si el PDF no cae sobre una fila, se enlaza por
               el folio que lea el OCR. Es el camino "tengo el papel y no sé de qué orden es". -->
          <div class="ep-tablewrap" [class.dragging]="dragTabla()"
               (dragover)="onDragOverTabla($event)" (dragleave)="onDragLeaveTabla($event)" (drop)="onDropTabla($event)">
            @if (error()) {
              <app-load-state [error]="error()" (retry)="reload()" />
            } @else if (loading() && !report()) {
              <app-load-state [loading]="true" [skeletonRows]="10" />
            } @else if (rows().length === 0) {
              <app-load-state [isEmpty]="true" emptyIcon="pi-check-circle"
                              [emptyTitle]="estado() === 'pendiente' ? 'No te falta ninguna factura' : 'Sin entradas en este filtro'"
                              [emptyHint]="estado() === 'pendiente' ? 'Cuando el ERP registre una orden nueva, aparece acá sola.' : 'Probá con otro estado o quitá el buscador.'"
                              [emptyCta]="estado() === 'pendiente' ? null : 'Ver lo que falta subir'"
                              emptyCtaIcon="pi pi-list" (cta)="setEstado('pendiente')" />
            } @else {
              <table class="surf-table surf-table--sticky surf-table--frozen-first surf-table--compact ep-table"
                     [class.loading]="loading()">
                <thead>
                  <tr>
                    <th scope="col" class="ta-r" pTooltip="Días desde la recepción" tooltipPosition="top">Días</th>
                    <th scope="col">Folio</th>
                    <th scope="col">Proveedor</th>
                    <th scope="col" class="ta-r">Recepción</th>
                    <th scope="col" class="ta-r">Total Kepler</th>
                    <th scope="col">Factura</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of rows(); track c.sucursal + '/' + c.folio) {
                    <tr [class.is-drop]="dragFila() === clave(c)"
                        [class.is-open]="abierta() && clave(abierta()!) === clave(c)"
                        (dragover)="onDragOverFila($event, c)" (dragleave)="onDragLeaveFila($event)"
                        (drop)="onDropFila($event, c)">
                      <td class="ta-r ep-dias" [class]="'is-' + tono(c)">{{ c.dias }}<em>d</em></td>
                      <td class="ep-folio">
                        <b class="mono" [pTooltip]="'Folio ' + c.folio" tooltipPosition="top">{{ ultimos4(c.folio) }}</b>
                        @if (variasSucursales()) { <em>{{ suc(c.sucursal) }}</em> }
                      </td>
                      <td class="ep-prov">
                        <span [pTooltip]="c.proveedor_nombre || ''" tooltipPosition="top">{{ c.proveedor_nombre || c.proveedor_code || '—' }}</span>
                        @if (c.deposit_status === 'rechazado') {
                          <!-- El motivo va EN la fila: el catálogo tipificado sólo sirve si el que
                               tiene que corregir lo ve sin abrir nada. -->
                          <p-tag [value]="'Devuelta: ' + porQue(c)" severity="danger" styleClass="ep-tag" />
                        }
                      </td>
                      <td class="ta-r mono">
                        {{ c.receipt_date | date:'dd/MM' }}
                        @if (c.fecha_futura) {
                          <i class="pi pi-exclamation-triangle ep-warn" pTooltip="Fecha capturada adelantada en el ERP" tooltipPosition="top"></i>
                        }
                      </td>
                      <td class="ta-r mono ep-monto">{{ money(c.monto) }}</td>
                      <td class="ep-cta">
                        @if (dragFila() === clave(c)) {
                          <b class="ep-drophere"><i class="pi pi-download" aria-hidden="true"></i> Soltá acá el PDF</b>
                        } @else if (c.deposit_status === 'validado') {
                          <span class="ep-ok"><i class="pi pi-check" aria-hidden="true"></i> Validada</span>
                        } @else if (c.deposit_status === 'recibido') {
                          <span class="ep-wait">Por revisar
                            @if (!c.monto_match) {
                              <i class="pi pi-exclamation-triangle ep-warn" pTooltip="El total de la factura no cuadra con Kepler" tooltipPosition="top"></i>
                            }
                          </span>
                        } @else if (canManage()) {
                          <label class="ep-rowpick">
                            <span>{{ c.deposit_status === 'rechazado' ? 'Soltar el PDF corregido' : 'Soltar PDF' }} · <b>elegir</b></span>
                            <input type="file" accept="application/pdf" multiple hidden (change)="onFilesFila($event, c)" />
                          </label>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>

              @if (report(); as r) {
                <div class="ep-pager">
                  <span>{{ desde() }}–{{ hasta() }} de <strong>{{ r.total }}</strong></span>
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="page() === 1 || loading()" (click)="irPagina(page() - 1)">
                    <span class="p-button-icon pi pi-angle-left" aria-hidden="true"></span><span class="p-button-label">Anterior</span>
                  </button>
                  <button pButton type="button" class="p-button-sm p-button-text" [disabled]="hasta() >= r.total || loading()" (click)="irPagina(page() + 1)">
                    <span class="p-button-label">Siguiente</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
                  </button>
                </div>
              }
            }

            @if (dragTabla() && !dragFila()) {
              <div class="ep-dropveil" aria-hidden="true">
                <div>
                  <i class="pi pi-download" aria-hidden="true"></i>
                  <b>Soltá los PDFs</b>
                  <em>los enlazo por el folio que traigan</em>
                </div>
              </div>
            }
          </div>

        </div>

        @if (canManage()) {
          <!-- El lote dejó de ser una pantalla: soltar N archivos ES el lote. Se dice acá porque
               nadie descubre solo una interacción que no está escrita. -->
          <p class="ep-lote-hint">
            <b>¿Muchas de una vez?</b> Soltá <b>varios PDFs</b> en cualquier parte de la tabla: los
            enlazo por folio y sólo confirmás. Hasta {{ tope() }} por vez.
          </p>
        }
      }
    </div>

    <!--
      Ventana de confirmación. Antes esto era un panel lateral, con el argumento de "que la
      tabla se siga viendo"; en uso real **la persona no se enteraba de que había pasado algo**
      al soltar el PDF. Soltar un archivo es el acto que dispara un envío: pide una ventana
      modal que muestre el análisis y pregunte, no una zona que aparece al costado.

      Se abre sola al soltar y se va sola al enviar: soltar → leer → confirmar → listo.
    -->
    <p-dialog [visible]="hojas().length > 0" (visibleChange)="onCerrarDialogo($event)" [modal]="true"
              [draggable]="false" [closable]="!guardando()" [closeOnEscape]="!guardando()"
              [style]="{ width: '44rem', maxWidth: '95vw' }" [breakpoints]="{ '720px': '96vw' }"
              [header]="tituloDialogo()">
      <div class="ep-dlg">
        @for (h of hojas(); track h.id) {
          <article class="ep-an" [class.bad]="h.estado === 'duplicada' || h.estado === 'error'">
            @if (hojas().length > 1) {
              <header class="ep-an-h">
                <i class="pi pi-file-pdf" aria-hidden="true"></i>
                <b [pTooltip]="h.name" tooltipPosition="top">{{ h.name }}</b>
                <span class="ep-sp"></span>
                <button type="button" class="ep-x" (click)="quitar(h)" [attr.aria-label]="'Quitar ' + h.name">
                  <i class="pi pi-times" aria-hidden="true"></i>
                </button>
              </header>
            }

            @switch (h.estado) {
              @case ('leyendo') {
                <p class="ep-an-msg"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Leyendo <b>{{ h.name }}</b>…</p>
              }
              @case ('duplicada') {
                <p class="ep-an-msg is-bad">
                  <i class="pi pi-ban" aria-hidden="true"></i>
                  Este PDF ya está subido en la entrada <b class="mono">{{ h.dupDe }}</b>. No se vuelve a guardar.
                </p>
              }
              @case ('error') {
                <p class="ep-an-msg is-bad"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ h.motivo || 'No se pudo procesar' }}</p>
              }
              @case ('guardada') {
                <!-- Instante entre que el server confirma y la hoja sale de la bandeja. Sin esta
                     rama caería en el @default y mostraría el buscador de entrada por un frame. -->
                <p class="ep-an-msg"><i class="pi pi-check" aria-hidden="true"></i> Enviada.</p>
              }
              @case ('enlazada') {
                <!-- El veredicto primero, en una oración. Lo que sigue es el respaldo. -->
                <p class="ep-veredicto" [class.ok]="cuadre(h)" [class.warn]="cuadre(h) === false" role="status">
                  @if (cuadre(h) && porGemela(h)) {
                    <i class="pi pi-check-circle" aria-hidden="true"></i>
                    <span><b>Cuadra</b> con la captura de <b>oficinas</b>. Con la de la sucursal difiere {{ money(dif(h)) }}, y eso es normal: es la misma compra capturada dos veces.</span>
                  } @else if (cuadre(h)) {
                    <i class="pi pi-check-circle" aria-hidden="true"></i>
                    <span>La factura <b>cuadra</b> con el total de Kepler.</span>
                  } @else if (cuadre(h) === false) {
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    <span>La factura difiere <b>{{ money(dif(h)) }}</b> del total de Kepler. Se puede enviar igual: el revisor decide.</span>
                  } @else {
                    <i class="pi pi-info-circle" aria-hidden="true"></i>
                    <span>No pude leer el importe de la factura, así que no puedo comparar. Se puede enviar igual.</span>
                  }
                </p>

                <!-- El análisis: qué dice Kepler contra qué dice el papel, renglón por renglón. -->
                <table class="ep-cmp">
                  <thead>
                    <tr><th scope="col"></th><th scope="col">En Kepler</th><th scope="col">En la factura</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Entrada</th>
                      <td class="mono">{{ h.entrada!.sucursal }}/{{ h.entrada!.folio }}</td>
                      <td class="mono">{{ h.folioOcr || '—' }}</td>
                    </tr>
                    <tr>
                      <th scope="row">Proveedor</th>
                      <td>{{ h.entrada!.proveedor_nombre || h.entrada!.proveedor_code || '—' }}</td>
                      <td>{{ h.ocr?.proveedor || '—' }}</td>
                    </tr>
                    <tr>
                      <th scope="row">Fecha</th>
                      <td class="mono">{{ h.entrada!.receipt_date | date:'dd/MM/yy' }}</td>
                      <td class="mono">{{ h.fecha || '—' }}</td>
                    </tr>
                    <tr class="ep-cmp-total">
                      <th scope="row">Total</th>
                      <td class="mono">{{ money(h.entrada!.monto) }}</td>
                      <td class="mono" [class.is-ok]="cuadre(h)" [class.is-warn]="cuadre(h) === false">
                        {{ h.total != null ? money(h.total) : (h.subtotal != null ? money(h.subtotal) + ' (subtotal)' : '—') }}
                      </td>
                    </tr>
                  </tbody>
                </table>

                @if (h.porMonto) {
                  <p class="ep-an-msg">
                    <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
                    La enlacé por <b>importe</b>, no por folio (la factura no traía uno legible). Verificá que la entrada sea la correcta.
                  </p>
                }
                @if (h.entrada!.gemela_monto != null && h.entrada!.gemela_delta) {
                  <p class="ep-an-msg">
                    <i class="pi pi-clone" aria-hidden="true"></i>
                    Oficinas capturó esta misma recepción como <b class="mono">00/{{ h.entrada!.gemela_folio }}</b>
                    por <b>{{ money(h.entrada!.gemela_monto!) }}</b>.
                  </p>
                }
                <button type="button" class="ep-link" (click)="desenlazar(h)">No es esta entrada — cambiarla</button>
              }
              @default {
                <!-- ambigua / sin_match: la decisión es del humano, con los candidatos a la
                     vista y un buscador por folio. -->
                <p class="ep-an-msg">
                  @if (h.estado === 'ambigua') { Hay más de una orden que le queda a <b>{{ h.name }}</b>. Elegí cuál: }
                  @else { No encontré la orden de <b>{{ h.name }}</b>. Buscala por folio o proveedor: }
                  @if (h.total != null) { <em>(leí {{ money(h.total) }}@if (h.folioOcr) { · folio {{ h.folioOcr }} })</em> }
                </p>
                <div class="ep-find">
                  <input pInputText [ngModel]="h.busqueda" (ngModelChange)="setBusqueda(h, $event)"
                         (keyup.enter)="buscar(h)" placeholder="Folio o proveedor" class="ep-find-in"
                         [attr.aria-label]="'Buscar la entrada de ' + h.name" />
                  <button pButton type="button" class="p-button-sm" [loading]="!!h.buscando" (click)="buscar(h)">
                    <span class="p-button-label">Buscar</span>
                  </button>
                </div>
                @for (e of h.candidatas || []; track e.sucursal + '/' + e.folio) {
                  <button type="button" class="ep-cand" (click)="elegir(h, e)">
                    <b class="mono">{{ e.sucursal }}/{{ ultimos4(e.folio) }}</b>
                    <span>{{ e.proveedor_nombre || e.proveedor_code || '—' }}</span>
                    <em class="mono">{{ money(e.monto) }}</em>
                  </button>
                }
              }
            }
          </article>
        }

        @if (capError()) { <p class="ep-err">{{ capError() }}</p> }
      </div>

      <ng-template #footer>
        <span class="ep-dlg-n">
          @if (leyendo()) { Leyendo… }
          @else if (nBloqueadas()) { {{ nBloqueadas() }} sin resolver }
        </span>
        <button pButton type="button" text [disabled]="guardando()" (click)="limpiar()">
          <span class="p-button-label">Cancelar</span>
        </button>
        <button pButton type="button" [loading]="guardando()" [disabled]="!nExpedientes() || guardando() || leyendo()"
                (click)="guardar()">
          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
          <span class="p-button-label">{{ nExpedientes() > 1 ? 'Enviar ' + nExpedientes() + ' facturas' : 'Sí, enviar la factura' }}</span>
        </button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }

    .ep-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .ep-suc-fija {
      display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs);
      color: var(--text-muted); border: 1px solid var(--border-color);
      border-radius: var(--r-sm, .35rem); padding: .18rem .5rem;
    }

    /* Answer-first: una oración, no una caja de KPIs. */
    .ep-verdict {
      display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      margin: var(--sp-4) 0 var(--sp-3); font-size: var(--fs-h3); color: var(--text-main);
    }
    .ep-verdict b { font-variant-numeric: tabular-nums; }
    .ep-verdict.is-done { color: var(--ok-fg); font-weight: 600; }
    .ep-verdict.is-late b { color: var(--bad-fg); }
    .ep-verdict em { font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-late-btn {
      font: inherit; font-size: var(--fs-sm); color: var(--bad-fg); background: none; border: 0;
      border-bottom: 1px solid currentColor; padding: 0; cursor: pointer;
    }
    .ep-bar { flex: 0 1 10rem; height: 4px; border-radius: var(--r-pill, 999px); background: var(--border-color); overflow: hidden; }
    .ep-bar > span { display: block; height: 100%; background: var(--ok-fg); }

    .ep-returned {
      display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left;
      padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3); cursor: pointer; font: inherit;
      font-size: var(--fs-sm); color: var(--bad-fg);
      background: color-mix(in oklab, var(--bad-fg) 7%, transparent);
      border: 1px solid color-mix(in oklab, var(--bad-fg) 35%, var(--border-color));
      border-radius: var(--r-md, .5rem);
    }
    .ep-returned > span { flex: 1; }

    .ep-block {
      display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-4) var(--sp-5);
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-2);
    }
    .ep-block .pi { font-size: 1.2rem; color: var(--text-muted); }
    .ep-block-t { margin: 0 0 var(--sp-1); font-weight: 600; }
    .ep-block-s { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 46ch; }

    .ep-filters { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-3); }
    .ep-search { width: 100%; }
    .ep-sp { flex: 1 1 auto; }

    /* Buscador con sugerencias */
    .ep-ac { position: relative; flex: 0 1 24rem; min-width: 14rem; }
    .ep-ac-x {
      position: absolute; right: .4rem; top: 50%; transform: translateY(-50%);
      background: none; border: 0; padding: .25rem; cursor: pointer; color: var(--text-faint);
    }
    .ep-ac-x:hover { color: var(--text-main); }
    .ep-ac-list {
      position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0;
      margin: 0; padding: var(--sp-1); list-style: none;
      max-height: 19rem; overflow-y: auto;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md, .5rem); box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
    }
    .ep-ac-msg { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-ac-op {
      display: flex; align-items: baseline; gap: var(--sp-2); cursor: pointer;
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm, .4rem); font-size: var(--fs-sm);
    }
    .ep-ac-op.on { background: var(--table-hover); }
    .ep-ac-op b { font-size: var(--fs-body); }
    .ep-ac-op > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--text-muted); }
    .ep-ac-op em { font-style: normal; color: var(--text-main); }
    .ep-ac-d { font-style: normal; font-size: var(--fs-micro); color: var(--text-faint); min-width: 2.2rem; text-align: right; }
    .ep-ac-d.late { color: var(--bad-fg); font-weight: 600; }

    /* Tabla + panel: el panel sólo ocupa lugar cuando hay algo en preparación. */
    .ep-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); align-items: start; }

    .ep-tablewrap {
      position: relative; overflow-x: auto;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--card-bg);
    }
    .ep-tablewrap.dragging { border-color: var(--action); }

    .ep-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ep-table.loading { opacity: .6; }
    .ep-table th {
      text-align: left; font-weight: 600; font-size: var(--fs-micro); letter-spacing: .03em;
      text-transform: uppercase; color: var(--text-muted); white-space: nowrap;
      padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
    }
    .ep-table td {
      padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
      height: var(--row-h-md); vertical-align: middle;
    }
    .ep-table tbody tr:last-child td { border-bottom: 0; }
    .ep-table .mono, .ep-folio b { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }
    /* Calificado a propósito: la regla base .ep-table th (0,1,1) le gana a un .ta-r suelto
       (0,1,0), y el encabezado se iba a la izquierda mientras su columna quedaba a la derecha. */
    .ep-table th.ta-r, .ep-table td.ta-r, .ta-r { text-align: right; }

    /* Fila objetivo del arrastre: anillo interno + fondo de acción. Es la única cosa naranja
       de la pantalla, y por eso se ve. */
    .ep-table tbody tr.is-drop > td {
      background: color-mix(in oklab, var(--action) 10%, transparent);
      box-shadow: inset 0 1.5px 0 var(--action), inset 0 -1.5px 0 var(--action);
    }
    .ep-table tbody tr.is-open > td { background: var(--table-hover); }

    .ep-dias { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ep-dias em { font-style: normal; font-size: .7em; opacity: .7; }
    .ep-dias.is-ok { color: var(--text-muted); }
    .ep-dias.is-warn { color: var(--warn-fg); }
    .ep-dias.is-bad { color: var(--bad-fg); }

    .ep-folio b { font-size: var(--fs-body); }
    .ep-folio em { display: block; font-style: normal; font-size: var(--fs-micro); color: var(--text-faint); }
    .ep-prov { max-width: 22rem; }
    .ep-prov > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ep-monto { font-weight: 600; }
    .ep-warn { color: var(--warn-fg); margin-left: .25rem; }

    .ep-cta { white-space: nowrap; font-size: var(--fs-xs); }
    .ep-drophere { color: var(--action); font-weight: 600; }
    .ep-ok { color: var(--ok-fg); }
    .ep-wait { color: var(--text-muted); }
    .ep-rowpick { color: var(--text-faint); cursor: pointer; }
    .ep-rowpick b { color: var(--text-muted); font-weight: 600; border-bottom: 1px solid currentColor; }
    .ep-rowpick:hover b { color: var(--action); }
    .ep-rowpick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }

    .ep-dropveil {
      position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
      background: color-mix(in oklab, var(--card-bg) 82%, transparent);
    }
    .ep-dropveil > div { display: grid; justify-items: center; gap: var(--sp-1); color: var(--action); }
    .ep-dropveil .pi { font-size: 1.6rem; }
    .ep-dropveil em { font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); }

    .ep-pager {
      display: flex; align-items: center; gap: var(--sp-2); justify-content: flex-end;
      padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-xs); color: var(--text-muted);
    }

    /* Ventana de confirmación */
    .ep-dlg { display: grid; gap: var(--sp-4); }
    .ep-an { display: grid; gap: var(--sp-3); }
    .ep-an + .ep-an { padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .ep-an-h { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); }
    .ep-an-h b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ep-an-h .pi-file-pdf { color: var(--text-faint); }
    .ep-an-msg { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0;
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
    .ep-an-msg.is-bad { color: var(--bad-fg); }
    .ep-an-msg em { font-style: normal; color: var(--text-faint); }

    /* El veredicto en una oración, antes de la tabla del análisis (DESIGN Q.1). */
    .ep-veredicto {
      display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0;
      padding: var(--sp-3); border-radius: var(--r-sm, .4rem);
      font-size: var(--fs-body); line-height: 1.45;
      border: 1px solid var(--border-color); background: var(--surface-2); color: var(--text-main);
    }
    .ep-veredicto .pi { font-size: 1.05rem; margin-top: .1rem; }
    .ep-veredicto.ok { color: var(--ok-fg); border-color: color-mix(in oklab, var(--ok-fg) 35%, var(--border-color)); }
    .ep-veredicto.warn { color: var(--warn-fg); border-color: color-mix(in oklab, var(--warn-fg) 35%, var(--border-color)); }
    .ep-veredicto b { font-weight: 700; }

    /* Kepler contra el papel, renglón por renglón. */
    .ep-cmp { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ep-cmp th, .ep-cmp td { padding: var(--sp-2) var(--sp-3); text-align: left; border-bottom: 1px solid var(--border-color); }
    .ep-cmp thead th { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); font-weight: 600; }
    .ep-cmp tbody th { font-weight: 400; color: var(--text-muted); width: 8rem; }
    .ep-cmp tbody td { color: var(--text-main); }
    .ep-cmp tr:last-child th, .ep-cmp tr:last-child td { border-bottom: 0; }
    .ep-cmp-total th, .ep-cmp-total td { font-weight: 700; font-size: var(--fs-body); }
    .ep-cmp td.is-ok { color: var(--ok-fg); }
    .ep-cmp td.is-warn { color: var(--warn-fg); }
    .mono { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }

    .ep-dlg-n { margin-right: auto; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-err { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); }

    .ep-link {
      justify-self: start; font: inherit; font-size: var(--fs-micro); color: var(--text-faint);
      background: none; border: 0; padding: 0; cursor: pointer; border-bottom: 1px solid currentColor;
    }
    .ep-link:hover { color: var(--action); }

    .ep-find { display: flex; gap: var(--sp-2); }
    .ep-find-in { flex: 1 1 auto; min-width: 0; }
    .ep-cand {
      display: flex; align-items: baseline; gap: var(--sp-2); width: 100%; text-align: left;
      font: inherit; font-size: var(--fs-xs); cursor: pointer;
      padding: var(--sp-1) var(--sp-2); background: none;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem);
    }
    .ep-cand:hover { border-color: var(--action); }
    .ep-cand > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }

    .ep-x { background: none; border: 0; color: var(--text-faint); cursor: pointer; padding: .2rem; }
    .ep-x:hover { color: var(--bad-fg); }

    .ep-pick {
      display: inline-flex; align-items: center; gap: var(--sp-1); cursor: pointer;
      padding: .35rem .7rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem);
      font-size: var(--fs-sm); color: var(--text-muted);
    }
    .ep-pick:hover { border-color: var(--action); color: var(--action); }
    .ep-pick:focus-within { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 2px; }

    .ep-lote-hint { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ep-lote-hint b { color: var(--text-main); }

    :host ::ng-deep .ep-tag { margin-left: var(--sp-2); }
  `],
})
export class ComprasEntradasPendientesComponent {
  private readonly svc = inject(EntradasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly report = signal<EntradasReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<number | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);

  /** Sin `undefined`: `''` ya significa "todas" y el segmented necesita un string siempre. */
  readonly estado = signal<Exclude<EntradasQuery['estado'], undefined>>('pendiente');
  readonly sucursalSel = signal<string | null>(null);
  readonly rezago = signal(false);
  readonly diasMin = signal<number | undefined>(undefined);
  readonly page = signal(1);
  /** Señal, no propiedad suelta: el buscador con sugerencias reacciona a cada tecla. */
  readonly search = signal('');
  private readonly pageSize = 50;

  /**
   * Vocabulario único de la fase. Antes cada pantalla nombraba distinto lo mismo
   * ("Pendientes/Enviadas/Devueltas" acá, "Con remisión" allá): cuatro personas hablando del
   * mismo expediente con cuatro palabras es una discusión garantizada.
   */
  readonly estadoOpts = [
    { label: 'Sin factura', value: 'pendiente' },
    { label: 'Devueltas', value: 'rechazado' },
    { label: 'Por revisar', value: 'por_validar' },
    { label: 'Validadas', value: 'validado' },
    { label: 'Todas', value: '' },
  ];

  readonly canManage = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);

  // ── alcance: decide si hay selector, chip fijo, o bloqueo explicado ──
  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly sinAlcance = computed(() => { const a = this.alcance(); return !!a && a.length === 0; });
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  readonly unaSucursal = computed(() => { const a = this.alcance(); return a && a.length === 1 ? this.suc(a[0]) : null; });
  /**
   * Con alcance `all` las opciones salen del CATÁLOGO, no de las filas de la página: con
   * pageSize 50 sobre 1,096 entradas, derivarlas de `rows()` ofrecía sólo las sucursales que
   * cayeron en la primera página — el resto era invisible aunque el usuario pudiera verlas.
   */
  readonly sucursalOpts = computed(() => {
    const a = this.alcance();
    const codes = a ?? STORE_BRANCHES.map((b) => b.code);
    return codes.map((c) => ({ label: this.suc(c), value: c }));
  });

  suc(code: string): string { return branchName(code) || code; }
  clave(c: EntradaRow): string { return `${c.sucursal}/${c.folio}`; }
  /** Por qué la devolvieron, en llano: el código del catálogo y, si no hay, el texto libre. */
  porQue(c: EntradaRow): string {
    return motivoLabel(c.motivo_codigo) || (c.motivo_rechazo || '').trim() || 'sin motivo registrado';
  }
  money = money;
  ultimos4(folio: string): string { const d = String(folio || '').replace(/\D/g, ''); return d.slice(-4) || folio; }
  tope(): number { return this.report()?.settings?.bulk_max_files ?? 50; }

  faltan(r: EntradasReport): number { return Math.max(0, r.kpis.entradas - r.kpis.con_comprobante); }
  avance(r: EntradasReport): number {
    return r.kpis.entradas === 0 ? 100 : Math.round((r.kpis.con_comprobante / r.kpis.entradas) * 100);
  }
  desde(): number { const r = this.report(); return !r || r.total === 0 ? 0 : (this.page() - 1) * this.pageSize + 1; }
  hasta(): number { const r = this.report(); return !r ? 0 : Math.min(r.total, this.page() * this.pageSize); }

  /** Tres niveles sobre el SLA del tenant: al día · pasado · muy pasado (2×). */
  tono(c: EntradaRow): 'ok' | 'warn' | 'bad' {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    if (c.dias > sla * 2) return 'bad';
    if (c.dias > sla) return 'warn';
    return 'ok';
  }

  // ── carga (un solo pipeline: el último pedido gana, no hay carreras) ──
  private readonly pedir = new Subject<void>();

  constructor() {
    this.pedir.pipe(
      switchMap(() => {
        this.loading.set(true);
        this.error.set(null);
        const q: EntradasQuery = {
          estado: this.estado(),
          search: this.search().trim() || undefined,
          warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
          carril: this.rezago() ? 'rezago' : 'al_dia',
          dias_min: this.diasMin(),
          orden: 'antiguedad',
          page: this.page(),
          pageSize: this.pageSize,
        };
        return this.svc.list(q).pipe(catchError((e) => {
          this.error.set(e?.error?.message || 'No se pudo cargar la lista de pendientes.');
          this.loading.set(false);
          return of(null);
        }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      if (r) { this.report.set(r); this.cargadoAt.set(Date.now()); }
      this.loading.set(false);
    });
    // Estado en la URL: el link "las pendientes de la 03" se puede pegar en un chat, y el
    // deep-link desde el Centro de control aterriza donde dice.
    const qp = this.route.snapshot.queryParamMap;
    const suc = qp.get('suc');
    if (suc) this.sucursalSel.set(suc);
    const est = qp.get('estado');
    if (est && this.estadoOpts.some((o) => o.value === est)) {
      this.estado.set(est as Exclude<EntradasQuery['estado'], undefined>);
    }
    this.escucharTeclas();
    this.reload();
  }

  reload(): void { this.pedir.next(); }
  private volverAlInicio(): void { this.page.set(1); this.diasMin.set(undefined); }
  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        suc: this.sucursalSel() || null,
        estado: this.estado() === 'pendiente' ? null : this.estado() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  setEstado(v: string): void {
    this.estado.set((v || '') as Exclude<EntradasQuery['estado'], undefined>);
    this.volverAlInicio(); this.syncUrl(); this.reload();
  }
  setSucursal(v: string | null): void { this.sucursalSel.set(v || null); this.volverAlInicio(); this.syncUrl(); this.reload(); }
  setRezago(v: boolean): void { this.rezago.set(v); this.volverAlInicio(); this.reload(); }
  soloAtrasadas(): void {
    const sla = this.report()?.settings?.sla_capture_days ?? 3;
    this.estado.set('pendiente'); this.diasMin.set(sla + 1); this.page.set(1); this.reload();
  }
  irPagina(n: number): void { this.page.set(Math.max(1, n)); this.reload(); }

  // ─────────────────── buscador con sugerencias ───────────────────
  readonly sug = signal<EntradaRow[]>([]);
  readonly sugOpen = signal(false);
  readonly sugLoading = signal(false);
  /** Fila resaltada del desplegable. −1 = ninguna (Enter aplica el texto crudo). */
  readonly sugIdx = signal(-1);
  private readonly teclas = new Subject<string>();

  /**
   * Sugerencias contra el MISMO filtro que la tabla (estado, sucursal, carril): si el
   * desplegable ofreciera entradas que la lista no muestra, elegir una dejaría la tabla vacía
   * y sin explicación. Cuando no hay coincidencias se ofrece explícitamente buscar en todas.
   */
  private escucharTeclas(): void {
    this.teclas.pipe(
      debounceTime(220),
      switchMap((q) => {
        const t = q.trim();
        if (t.length < 2) { this.sug.set([]); this.sugLoading.set(false); return of(null); }
        this.sugLoading.set(true);
        return this.svc.list({
          estado: this.estado(),
          search: t,
          warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
          carril: this.rezago() ? 'rezago' : 'al_dia',
          orden: 'antiguedad',
          page: 1,
          pageSize: 8,
        }).pipe(catchError(() => of(null)));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.sugLoading.set(false);
      this.sug.set(r?.rows ?? []);
      this.sugIdx.set(-1);
    });
  }

  onSearch(v: string): void {
    this.search.set(v ?? '');
    this.sugOpen.set(true);
    this.teclas.next(this.search());
  }
  abrirSug(): void { if (this.search().trim().length >= 2) this.sugOpen.set(true); }
  /** El cierre va con un respiro: un click sobre una opción dispara el blur del input primero. */
  cerrarSug(): void { setTimeout(() => this.sugOpen.set(false), 120); }

  onSearchKey(e: KeyboardEvent): void {
    const n = this.sug().length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.sugOpen.set(true); this.sugIdx.set((this.sugIdx() + 1) % n); return; }
    if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.sugIdx.set((this.sugIdx() - 1 + n) % n); return; }
    if (e.key === 'Escape') { this.sugOpen.set(false); this.sugIdx.set(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = this.sug()[this.sugIdx()];
      // Con una fila resaltada gana ella; sin resaltar, se aplica lo tecleado tal cual.
      if (sel) this.elegirSug(sel);
      else { this.sugOpen.set(false); this.volverAlInicio(); this.reload(); }
    }
  }

  /** Elegir una sugerencia deja la tabla con ESA entrada: lista para soltarle el PDF. */
  elegirSug(e: EntradaRow): void {
    this.search.set(this.ultimos4(e.folio));
    this.sugOpen.set(false);
    this.sugIdx.set(-1);
    this.volverAlInicio();
    this.reload();
  }

  limpiarBusqueda(): void {
    this.search.set('');
    this.sug.set([]);
    this.sugOpen.set(false);
    this.volverAlInicio();
    this.reload();
  }

  /** Salida del vacío: el filtro de estado es la causa más común de "no aparece". */
  buscarEnTodas(): void {
    this.estado.set('');
    this.syncUrl();
    this.volverAlInicio();
    this.reload();
    this.teclas.next(this.search());
  }

  /** Para el mensaje de "no hay nada": nombrar el filtro que está tapando el resultado. */
  etiquetaEstado(): string {
    return (this.estadoOpts.find((o) => o.value === this.estado())?.label || 'todas').toLowerCase();
  }

  // ═════════════════════════ bandeja de PDFs ═════════════════════════
  readonly hojas = signal<Hoja[]>([]);
  readonly guardando = signal(false);
  readonly capError = signal('');
  /** La fila abierta en el panel (la última sobre la que se soltó algo). */
  readonly abierta = signal<EntradaRow | null>(null);
  readonly dragTabla = signal(false);
  readonly dragFila = signal<string | null>(null);
  private seq = 0;
  /** De 3 en 3: cada hoja es una llamada de visión y un lote son 30. */
  private static readonly EN_VUELO = 3;

  /** Cuántos EXPEDIENTES se van a crear — no cuántos archivos. Dos hojas de una factura son uno. */
  readonly listas = computed(() => this.hojas().filter((h) => h.estado === 'enlazada' && h.entrada && !h.dupDe));
  readonly nExpedientes = computed(() =>
    new Set(this.listas().map((h) => `${h.entrada!.sucursal}|${h.entrada!.folio}`)).size);
  readonly nBloqueadas = computed(() =>
    this.hojas().filter((h) => h.estado === 'ambigua' || h.estado === 'sin_match' || h.estado === 'duplicada' || h.estado === 'error').length);
  /** El OCR todavía corre: el botón de enviar espera, o se manda sin saber si cuadra. */
  readonly leyendo = computed(() => this.hojas().some((h) => h.estado === 'leyendo'));

  /** Título de la ventana: dice de qué entrada se trata, no "Adjuntar archivo". */
  tituloDialogo(): string {
    const l = this.hojas();
    if (l.length > 1) return `Revisar ${l.length} facturas antes de enviar`;
    const e = l[0]?.entrada;
    return e ? `Factura de la entrada ${e.sucursal}/${this.ultimos4(e.folio)}` : 'Revisar la factura antes de enviar';
  }

  /**
   * Cerrar la ventana descarta lo que había en la bandeja. No se pierde nada del lado del
   * servidor —todavía no se subió nada—, pero sí la lectura del OCR, así que la única puerta
   * es explícita: el botón Cancelar o la ✕. Mientras se está enviando no se puede cerrar.
   */
  onCerrarDialogo(visible: boolean): void {
    if (!visible && !this.guardando()) this.limpiar();
  }

  // ── arrastre ──
  onDragOverTabla(e: DragEvent): void {
    if (!this.canManage()) return;
    e.preventDefault();
    this.dragTabla.set(true);
  }
  onDragLeaveTabla(e: DragEvent): void {
    // `relatedTarget` fuera del contenedor: sin esto, pasar sobre una fila apaga el resaltado
    // del contenedor y el velo titila.
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    this.dragTabla.set(false);
    this.dragFila.set(null);
  }
  onDropTabla(e: DragEvent): void {
    e.preventDefault();
    const fila = this.dragFila();
    this.dragTabla.set(false);
    this.dragFila.set(null);
    // Si cayó sobre una fila, ya lo manejó `onDropFila` (el evento burbujea).
    if (fila) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) void this.agregar(files, null);
  }
  onDragOverFila(e: DragEvent, c: EntradaRow): void {
    if (!this.canManage()) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragFila.set(this.clave(c));
    this.dragTabla.set(true);
  }
  onDragLeaveFila(e: DragEvent): void {
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    this.dragFila.set(null);
  }
  onDropFila(e: DragEvent, c: EntradaRow): void {
    e.preventDefault();
    e.stopPropagation();
    this.dragFila.set(null);
    this.dragTabla.set(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) void this.agregar(files, c);
  }
  onFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) void this.agregar(files, null);
  }
  onFilesFila(ev: Event, c: EntradaRow): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) void this.agregar(files, c);
  }

  /**
   * `destino` = la entrada sobre la que se soltó. Si viene, no hace falta adivinar nada: el
   * usuario ya dijo de qué orden es y el enlace por folio sólo podría contradecirlo.
   */
  private async agregar(files: File[], destino: EntradaRow | null): Promise<void> {
    if (!this.canManage()) return;
    this.capError.set('');
    if (destino) this.abierta.set(destino);

    const espacio = this.tope() - this.hojas().length;
    if (espacio <= 0) {
      this.toast.add({
        severity: 'warn',
        summary: `La bandeja llegó al tope de ${this.tope()}`,
        detail: 'Enviá lo que hay y seguí con el resto.',
      });
      return;
    }
    const lote = files.slice(0, espacio);
    if (lote.length < files.length) {
      this.toast.add({
        severity: 'warn',
        summary: `Se tomaron ${lote.length} de ${files.length}`,
        detail: `El tope es ${this.tope()} archivos por vez (se cambia en el Centro de control).`,
      });
    }

    const nuevas: Hoja[] = [];
    for (const f of lote) {
      // Sólo PDF. El `accept` del input es una sugerencia (se puede elegir "todos los archivos")
      // y el arrastre no lo respeta en absoluto, así que el filtro real va acá y en el server.
      // El mensaje dice la SALIDA, no sólo el "no".
      const esPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      if (!esPdf) {
        this.capError.set(`${f.name} no es PDF. Escaneá la factura a PDF y volvé a soltarla.`);
        continue;
      }
      let dataUri: string;
      try { dataUri = await this.leer(f); } catch { this.capError.set(`No se pudo leer ${f.name}.`); continue; }
      nuevas.push({
        id: ++this.seq,
        name: f.name || 'factura.pdf',
        dataUri,
        bytes: Math.round((dataUri.length - (dataUri.indexOf(',') + 1)) * 0.75),
        estado: 'leyendo',
        entrada: destino,
        busqueda: '',
      });
    }
    if (!nuevas.length) return;
    this.hojas.update((l) => [...l, ...nuevas]);
    await this.procesar(nuevas);
  }

  /**
   * Lee y enlaza con concurrencia acotada. El pool es a mano y no con `forkJoin` porque 30
   * llamadas de visión en paralelo es exactamente cómo se choca con el rate-limit del proveedor.
   */
  private async procesar(lote: Hoja[]): Promise<void> {
    const cola = [...lote];
    const obreros = Array.from(
      { length: Math.min(ComprasEntradasPendientesComponent.EN_VUELO, cola.length) },
      async () => { for (;;) { const h = cola.shift(); if (!h) return; await this.leerYEnlazar(h); } },
    );
    await Promise.all(obreros);
  }

  private async leerYEnlazar(h: Hoja): Promise<void> {
    try {
      const o = await firstValueFrom(this.svc.ocr(h.dataUri, 'factura'));
      this.parchar(h.id, {
        sha256: o.sha256, folioOcr: o.folio, total: o.total, subtotal: o.subtotal,
        fecha: o.fecha, rfc: o.rfc, ocr: o,
      });
      if (o.duplicate) {
        this.parchar(h.id, { estado: 'duplicada', dupDe: `${o.duplicate.sucursal}/${o.duplicate.folio}` });
        return;
      }
      // Soltada sobre una fila: la entrada ya la eligió el usuario, no se busca nada.
      if (h.entrada) { this.parchar(h.id, { estado: 'enlazada' }); return; }
      // FOLIO primero (preciso), MONTO como respaldo — la misma prioridad del server.
      const r = await firstValueFrom(this.svc.matchByOcr({
        folio: o.folio || undefined,
        total: o.total ?? o.subtotal ?? undefined,
        fecha: o.fecha || undefined,
      }));
      const cands = r?.entradas || [];
      if (cands.length === 1) {
        this.parchar(h.id, { estado: 'enlazada', entrada: cands[0], porMonto: !o.folio, candidatas: [] });
      } else if (cands.length > 1) {
        this.parchar(h.id, { estado: 'ambigua', candidatas: cands.slice(0, 5) });
      } else {
        this.parchar(h.id, { estado: 'sin_match', candidatas: [] });
      }
    } catch (e: any) {
      this.parchar(h.id, { estado: 'error', motivo: e?.error?.message || 'No se pudo leer el PDF' });
    }
  }

  private parchar(id: number, p: Partial<Hoja>): void {
    this.hojas.update((l) => l.map((h) => (h.id === id ? { ...h, ...p } : h)));
  }

  elegir(h: Hoja, e: EntradaRow): void {
    this.parchar(h.id, { entrada: e, estado: 'enlazada', candidatas: [], porMonto: !h.folioOcr });
  }
  desenlazar(h: Hoja): void {
    this.parchar(h.id, { entrada: null, estado: 'sin_match', candidatas: [], porMonto: false });
  }
  quitar(h: Hoja): void { this.hojas.update((l) => l.filter((x) => x.id !== h.id)); }
  limpiar(): void { this.hojas.set([]); this.capError.set(''); this.abierta.set(null); }
  setBusqueda(h: Hoja, v: string): void { this.parchar(h.id, { busqueda: v }); }

  buscar(h: Hoja): void {
    const q = (h.busqueda || '').trim();
    if (!q) return;
    this.parchar(h.id, { buscando: true });
    this.svc.matchByOcr({ search: q }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        const cands = r?.entradas || [];
        this.parchar(h.id, { buscando: false, candidatas: cands.slice(0, 8), estado: cands.length ? 'ambigua' : 'sin_match' });
      },
      error: () => this.parchar(h.id, { buscando: false }),
    });
  }

  // ── cuadre (por hoja: en un lote cada una tiene su entrada) ──
  private cfgTol(): number { return this.report()?.settings?.match_tolerance ?? 1; }
  private cerca(v: number | null | undefined, ref: number | null | undefined): boolean {
    return v != null && ref != null && Math.abs(Number(v) - Number(ref)) <= this.cfgTol();
  }
  /**
   * `null` = todavía no se puede opinar. Cuadra contra **las dos capturas** de la misma
   * recepción (sucursal y oficinas), igual que el servidor: si acá se compara sólo contra una,
   * la pantalla dice "no cuadra" sobre una factura que el server guarda como cuadrada y el
   * capturista se queda sin saber a quién creerle.
   */
  cuadre(h: Hoja): boolean | null {
    if (!h.entrada || (h.total == null && h.subtotal == null)) return null;
    return this.cerca(h.total, h.entrada.monto) || this.cerca(h.subtotal, h.entrada.monto)
      || this.cerca(h.total, h.entrada.gemela_monto) || this.cerca(h.subtotal, h.entrada.gemela_monto);
  }
  /** Cuadró con la de oficinas y NO con la de la sucursal: hay que poder decirlo. */
  porGemela(h: Hoja): boolean {
    if (!h.entrada || h.entrada.gemela_monto == null) return false;
    const conSuc = this.cerca(h.total, h.entrada.monto) || this.cerca(h.subtotal, h.entrada.monto);
    return !conSuc && (this.cerca(h.total, h.entrada.gemela_monto) || this.cerca(h.subtotal, h.entrada.gemela_monto));
  }
  dif(h: Hoja): number {
    if (!h.entrada) return 0;
    const cands = [h.total, h.subtotal].filter((v): v is number => v != null);
    if (!cands.length) return 0;
    return Math.min(...cands.map((v) => Math.abs(v - h.entrada!.monto)));
  }

  // ── guardar (UN camino: agrupa por expediente y manda el lote) ──
  /**
   * `attach-bulk` también para un solo expediente. Tener dos caminos de guardado —uno para la
   * captura de una y otro para el lote— fue exactamente cómo el lote terminó creando dos
   * evidencias para la misma entrada cuando la factura traía dos hojas.
   */
  guardar(): void {
    const listas = this.listas();
    if (!listas.length || this.guardando()) return;
    this.capError.set('');
    this.guardando.set(true);

    void (async () => {
      const subidas: { h: Hoja; file: ProofFile }[] = [];
      for (const h of listas) {
        try {
          const up = await firstValueFrom(this.svc.uploadFile(h.dataUri, 'factura'));
          subidas.push({
            h,
            file: {
              ...up, role: 'factura', name: h.name, sha256: h.sha256,
              ocr_folio: h.folioOcr ?? null, ocr_total: h.total ?? null,
              ocr_fecha: h.fecha ?? null, ocr_rfc: h.rfc ?? null,
            },
          });
        } catch (e: any) {
          this.parchar(h.id, { estado: 'error', motivo: e?.error?.message || 'No se pudo subir el archivo' });
        }
      }
      if (!subidas.length) {
        this.guardando.set(false);
        this.capError.set('No se pudo subir ningún archivo. Reintentá.');
        return;
      }

      // AGRUPAR por entrada antes de mandar: una factura de 2 hojas son 2 archivos pero UN
      // expediente. Un item por archivo crea dos evidencias de la misma entrada (el dedup por
      // hash no las cruza, son hojas distintas) y el revisor ve la misma factura dos veces.
      const porEntrada = new Map<string, { h: Hoja; file: ProofFile }[]>();
      for (const s of subidas) {
        const k = `${s.h.entrada!.sucursal}|${s.h.entrada!.folio}`;
        porEntrada.set(k, [...(porEntrada.get(k) || []), s]);
      }
      const items: AttachReceipt[] = [...porEntrada.values()].map((grupo) => ({
        sucursal: grupo[0].h.entrada!.sucursal,
        folio: grupo[0].h.entrada!.folio,
        files: grupo.map((g) => g.file),
        // La lectura que manda para el cuadre es la de la hoja que trae importe.
        ocr: (grupo.find((g) => g.h.total != null || g.h.subtotal != null) || grupo[0]).h.ocr,
      }));

      try {
        const r = await firstValueFrom(this.svc.attachBulk(items));
        // Cada hoja sabe qué le pasó: el server contesta por expediente y todas las hojas de un
        // expediente comparten su resultado.
        for (const { h } of subidas) {
          const d = r.detalle.find((x) => x.sucursal === h.entrada!.sucursal && x.folio === h.entrada!.folio);
          if (d?.ok) this.parchar(h.id, { estado: 'guardada' });
          else this.parchar(h.id, { estado: 'error', motivo: d?.motivo || 'No se pudo adjuntar' });
        }
        this.guardando.set(false);
        this.toast.add({
          severity: r.omitidas ? 'warn' : 'success',
          summary: `${r.guardadas} ${r.guardadas === 1 ? 'factura enviada' : 'facturas enviadas'}`,
          detail: r.omitidas
            ? `${r.omitidas} quedaron afuera — el motivo está en su renglón.`
            : `${r.cuadran} cuadran al peso; el resto lo mira el revisor.`,
        });
        // Las guardadas salen de la bandeja; lo que falló se queda con su motivo a la vista.
        this.hojas.update((l) => l.filter((h) => h.estado !== 'guardada'));
        if (!this.hojas().length) this.abierta.set(null);
        this.reload();
      } catch (e: any) {
        this.guardando.set(false);
        this.capError.set(e?.error?.message || 'No se pudo enviar. Reintentá.');
      }
    })();
  }

  private leer(file: File): Promise<string> {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(file);
    });
  }
}
