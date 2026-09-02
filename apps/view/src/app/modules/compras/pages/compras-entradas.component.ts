import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of, map } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { MessageService, ConfirmationService } from 'primeng/api';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { EntradasService, EntradaRow, EntradasReport, EntradasQuery, RemisionOcr, ProofFile, EntradaDetail, EntradaLinea, DuplicateHit, DocPresence, RemisionLine, ReconcileResult, ReconciledLine, type OrdenEntradas, type MotivoDescarte } from '../entradas.service';
import { money, moneyShort, toggleSort, sortIcon, ariaSort, serverSortParams, type SortState, type SortDir } from '../../../shared/util';
import { EntityInspectorComponent } from '../../../shared/components/entity-inspector/entity-inspector.component';
import { entityRef } from '../../../shared/components/entity-inspector/entity-ref.service';
import { ComprasService, AdjustmentForEntradaRow, AdjustmentGrupo } from '../compras.service';
import { receiptVerdict, lineasTotal, plural, depForCuadre, EPS, MOTIVOS_DESCARTE, motivoDescarteLabel } from '../receipt-verdict';
import { GoodsReceiptsSocketService } from '../goods-receipts-socket.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ENTRADAS_CONTROL_TABS } from '../entradas-control-tabs';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { DocViewerComponent, DocViewerFile } from '../../../shared/components/doc-viewer/doc-viewer.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { branchName, NETWORK_BRANCHES } from '../../../core/constants/store-branches';
import { TableDensityComponent } from '../../../shared/components/table-density/table-density.component';
import { TableDensityService } from '../../../shared/components/table-density/table-density.service';

/** Una foto en el set de evidencia de la recepción (lo normal son 3–4). */
interface AttachFile {
  id: number; name: string; dataUri: string; kind: 'image' | 'pdf'; role: string;
  uploaded: ProofFile | null; uploading: boolean; failed: boolean;
  primary: boolean; // la ★ = la que además ENLAZA la entrada (folio/total). Ahora TODAS se leen con OCR.
  sha256?: string;           // hash de contenido (anti-hoja-duplicada)
  ocrLoading?: boolean;      // OCR de ESTA hoja en curso
  ocrDone?: boolean;
  ocrFolio?: string | null;  // OCR por-archivo (cada hoja se lee)
  ocrTotal?: number | null;
  ocrSubtotal?: number | null; // RE.pkt.2 — para que el cuadre use el total/subtotal de la hoja FISCAL
  ocrFecha?: string | null;
  ocrRfc?: string | null;
  ocrDocs?: string[];        // RE (#4) — tipos de documento detectados en la hoja (packet-aware)
  ocrDocsDetail?: DocPresence[]; // RE.pkt.1 — cada doc detectado con página + evidencia (auditable)
  dup?: DuplicateHit | null; // ya subida antes (misma hoja o folio ya capturado)
}

/**
 * CC (extensión) — "Comprobantes de Orden de Entrada" (proyecto Compras). Lista las
 * órdenes de entrada de Kepler (documento X-A-40) y le adjunta a cada una la
 * REMISIÓN/FACTURA del proveedor (imagen/PDF): el capturista elige la entrada, sube
 * la remisión, corre OCR (Claude vision), el sistema compara el total OCR vs el valor
 * de la entrada (chip de cuadre) y guarda la evidencia. Validación/rechazo a nivel
 * gestión. No escribe a Kepler.
 */
@Component({
  selector: 'app-compras-entradas',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, InputTextModule, ButtonModule, SelectModule,
    DialogModule, ToastModule, ConfirmDialogModule, TooltipModule, SegmentedComponent, MetricStripComponent,
    LoadStateComponent, EntityInspectorComponent, PageTabsComponent, SidePeekComponent, DocViewerComponent,
    FreshnessPillComponent, ContextHelpComponent, TableDensityComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page in">
      <p-toast />
      <p-confirmdialog />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>{{ dinero() ? 'Costo por compra' : 'Control de entradas · Listado' }}</h1>
          <!-- RE.19 — la ventana se dice, no se deduce. La lista arranca en el inicio del
               proceso y lo anterior vive en "Ver rezago"; sin decirlo, una orden de julio que
               no aparece se lee como dato faltante.
               RE.20.1 — la bajada cambia con el lente porque la pregunta cambia. -->
          <p class="surf-page-sub">
            @if (dinero()) {
              Una fila por compra: lo que facturó el proveedor, los ajustes ligados que lo
              bajaron (devoluciones y notas de crédito) y el <strong>neto que realmente
              pagamos</strong>
              @if (report()?.settings; as cfg) { , <strong>desde el {{ cfg.reception_start }}</strong> }.
              La misma cifra agregada por proveedor está en
              <a routerLink="/compras/costo-neto">Costo por proveedor</a>.
            } @else {
              Las órdenes de entrada de la red
              @if (report()?.settings; as cfg) { <strong>desde el {{ cfg.reception_start }}</strong> }
              , lo más reciente primero. Buscá por los <strong>últimos 4 dígitos</strong> del folio,
              o por proveedor / RFC / OC / vale. Para el trabajo diario están las pantallas por
              oficio: <strong>Captura de facturas</strong> y <strong>Revisión de facturas</strong>.
            }
          </p>
        </div>
        <div class="cb-head-actions">
          <app-table-density />
          <app-freshness-pill [since]="cargadoAt()" [staleAfterSec]="600" />
          <app-context-help topic="compras-entradas" />
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <div class="cb-filters card-premium card-flat">
        <!-- RE.20.1 — EL LENTE. Las mismas filas contestando dos preguntas. Era una pantalla
             aparte ("Compras 360") con su propio endpoint, su propio detalle y su propia
             paginación sobre exactamente la misma entidad; nadie sabía cuál de las dos abrir. -->
        <div class="cb-field"><label>Ver</label>
          <app-segmented [options]="lenteOpts" [value]="lente()" (valueChange)="setLente($event)" ariaLabel="Lente de la vista" /></div>
        <div class="cb-field"><label>Estado</label>
          <app-segmented [options]="estadoOpts" [value]="estadoSel()" (valueChange)="setEstado($event)" ariaLabel="Estado del comprobante" /></div>
        @if (dinero()) {
          <div class="cb-field"><label>Ajuste</label>
            <p-select [options]="ajusteOpts" [ngModel]="ajusteSel()" (onChange)="setAjuste($event.value)"
                      optionLabel="label" optionValue="value" appendTo="body" ariaLabel="Filtrar por ajuste" /></div>
          <div class="cb-field"><label>Orden de compra</label>
            <p-select [options]="ocOpts" [ngModel]="ocSel()" (onChange)="setOc($event.value)"
                      optionLabel="label" optionValue="value" appendTo="body" ariaLabel="Filtrar por orden de compra" /></div>
        }
        @if (variasSucursales()) {
          <div class="cb-field"><label>Sucursal</label>
            <p-select [options]="sucursalOpts()" [ngModel]="sucursalSel()" (onChange)="setSucursal($event.value)"
                      optionLabel="label" optionValue="value" placeholder="Todas las mías" [showClear]="true"
                      appendTo="body" ariaLabel="Sucursal" /></div>
        }
        <div class="cb-field cb-grow"><label>Buscar</label>
          <input pInputText [(ngModel)]="search" placeholder="Últimos 4 del folio (ej. 0397), o proveedor / RFC / OC…" (keyup.enter)="load()" (blur)="queue()" /></div>
        <div class="cb-field"><label>&nbsp;</label>
          @if (rezago()) {
            <button pButton type="button" class="p-button-text" (click)="setRezago(false)"
                    pTooltip="Volver al periodo del proceso" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span>
              <span class="p-button-label">Salir del rezago</span>
            </button>
          } @else if (report()?.settings; as cfg) {
            <button pButton type="button" class="p-button-text" (click)="setRezago(true)"
                    [pTooltip]="'Entradas anteriores al ' + cfg.reception_start + ' — fuera del proceso vivo'" tooltipPosition="bottom">
              <span class="p-button-icon p-button-icon-left pi pi-history" aria-hidden="true"></span>
              <span class="p-button-label">Ver rezago</span>
            </button>
          }
        </div>
        <div class="cb-field"><label>&nbsp;</label>
          <button pButton type="button" (click)="openAttachPhotoFirst()" title="Identificá la entrada por folio y subí la factura"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Subir factura</span></button></div>
        @if (newCount() > 0) {
          <div class="cb-field cb-field-pill"><label>&nbsp;</label>
            <button pButton type="button" class="cb-newpill" (click)="applyNew()" [title]="newCount() + ' orden(es) de entrada nueva(s) en el ERP'"><span class="p-button-icon p-button-icon-left pi pi-arrow-down" aria-hidden="true"></span><span class="p-button-label">{{ newCount() }} nueva(s) — actualizar</span></button></div>
        }
      </div>

      @if (report(); as r) { <app-metric-strip [items]="kpiItems(r)" ariaLabel="Resumen" /> }

      <!-- Frescura por fuente: la lista mezcla Kepler (al segundo) con Wincaja (copia de los .mdb).
           Sin esto, "esta sucursal no recibió nada" y "su feed dejó de traer datos" se ven igual. -->
      @if (frescura().length) {
        <div class="fresh-bar" role="status">
          <span class="fresh-lbl">Datos al día</span>
          @for (f of frescura(); track f.source_branch) {
            <span class="fresh-chip" [class.late]="f.atrasada"
                  [title]="f.origen === 'kepler' ? 'Kepler — réplica continua' : 'Wincaja — copia periódica del .mdb'">
              <b>{{ etiquetaFuente(f.source_branch) }}</b>
              {{ f.dias === 0 ? 'hoy' : f.dias === 1 ? 'ayer' : 'hace ' + f.dias + ' d' }}
              @if (f.atrasada) { <i class="pi pi-exclamation-triangle"></i> }
            </span>
          }
          @if (algunaAtrasada()) {
            <span class="fresh-note">Su cadencia normal es menor: revisá el feed de esa fuente.</span>
          }
        </div>
      }

      @if (error()) {
        <app-load-state [error]="error()" (retry)="load()"></app-load-state>
      } @else {
      <div class="card-premium card-flat">
        <!-- RE.17.5 — surf-table como sus hermanas de /compras (compras-360, costo-neto,
             cuadre-proveedor). Era la única tabla del proyecto sin la clase compartida: fila más
             alta, otro header y otro hover para la MISMA entidad que la lista de pendientes. -->
        <!-- La densidad la lleva surf-table--compact y no is-dense: el primero es el modificador
             de la tabla PrimeNG, el segundo el de la variante plain (tabla cruda). -->
        <p-table [value]="rows()" styleClass="p-datatable-sm surf-table surf-table--sticky cb-table"
                 [class.surf-table--compact]="density.dense()"
                 [rowHover]="true" [scrollable]="true" scrollHeight="62vh" [loading]="loading()">
          <!-- RE.20.2 — encabezados ordenables. Sólo Fecha, Proveedor y Monto: son las tres que
               contestan una pregunta de trabajo. Entrada y OC son identificadores (para eso está
               el buscador), y Remisión/Acciones son estado y controles, no datos que ordenen. -->
          <ng-template #header>
            <tr>
              <th style="width:6rem" [attr.aria-sort]="ariaSort(sort(), 'fecha')">
                <button type="button" class="surf-sort" (click)="ordenarPor('fecha', 'desc')" aria-label="Ordenar por fecha">
                  Fecha <i [class]="sortIcon(sort(), 'fecha')" aria-hidden="true"></i>
                </button>
              </th>
              <th style="width:7rem">Entrada</th>
              <th [attr.aria-sort]="ariaSort(sort(), 'proveedor')">
                <button type="button" class="surf-sort" (click)="ordenarPor('proveedor', 'asc')" aria-label="Ordenar por proveedor">
                  Proveedor <i [class]="sortIcon(sort(), 'proveedor')" aria-hidden="true"></i>
                </button>
              </th>
              <th style="width:7rem">OC</th>
              <!-- RE.20.1 — en el lente del dinero la columna del importe se llama FACTURA: es
                   el mismo número, pero acá la pregunta es contable y "monto" no dice de qué
                   lado está. Y aparecen las dos que explican el neto. -->
              <th class="ta-r" style="width:9rem" [attr.aria-sort]="ariaSort(sort(), 'monto')">
                <button type="button" class="surf-sort" (click)="ordenarPor('monto', 'desc')"
                        [attr.aria-label]="dinero() ? 'Ordenar por factura' : 'Ordenar por monto'">
                  {{ dinero() ? 'Factura' : 'Monto' }} <i [class]="sortIcon(sort(), 'monto')" aria-hidden="true"></i>
                </button>
              </th>
              @if (dinero()) {
                <th class="ta-r" style="width:8.5rem">Ajuste</th>
                <th class="ta-r" style="width:9.5rem">Neto</th>
              }
              <th style="width:11rem">Remisión</th>
              <th style="width:12rem">Acciones</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <!-- RE.22.2 — la fila se despliega: hasta ahora, para saber QUÉ traía una recepción
                 había que abrir el expediente completo en un diálogo y cerrarlo. Auditar varias
                 seguidas era abrir y cerrar. El clic en la fila (no en sus controles) muestra los
                 renglones ahí mismo; el folio sigue abriendo el expediente. -->
            <tr [class.cb-row-open]="filaAbierta() === claveFila(c)" (click)="filaClick(c, $event)">
              <td>
                {{ c.receipt_date | date:'dd/MM/yy' }}
                @if (c.fecha_futura) {
                  <i class="pi pi-exclamation-triangle fecha-mala"
                     title="Fecha capturada adelante de hoy en el ERP"></i>
                }
              </td>
              <td><button type="button" class="cb-caret" (click)="toggleFila(c)"
                          [attr.aria-expanded]="filaAbierta() === claveFila(c)"
                          [attr.aria-label]="'Ver los renglones de la entrada ' + c.folio">
                    <i class="pi" [ngClass]="filaAbierta() === claveFila(c) ? 'pi-chevron-down' : 'pi-chevron-right'" aria-hidden="true"></i>
                  </button><button type="button" class="cb-foliolink" (click)="openDetail(c)" title="Ver el expediente completo (remisión + historial)">{{ c.folio }}</button>
                <!-- RE.14 — la misma recepción capturada dos veces. Se muestra el otro folio acá
                     porque esta pantalla es donde alguien llega con "tengo este número": el par
                     tiene que ser visible sin abrir el detalle. -->
                @if (c.gemela_folio) {
                  <em class="cb-gem" [title]="'Oficinas capturó la misma recepción como 00/' + c.gemela_folio + (c.gemela_monto != null ? ' por ' + money(c.gemela_monto) : '')">
                    <i class="pi pi-link" aria-hidden="true"></i> 00/{{ c.gemela_folio }}
                  </em>
                }
              </td>
              <td>
                @if (c.proveedor_code) {
                  <button type="button" class="cb-reflink" (click)="inspect.set(refProv(c.proveedor_code))"
                          [attr.aria-label]="'Ver ficha de ' + (c.proveedor_nombre || c.proveedor_code)">{{ c.proveedor_nombre || c.proveedor_code }}</button>
                } @else { {{ c.proveedor_nombre || '—' }} }
                <div class="cb-sub">{{ c.proveedor_rfc || c.proveedor_code }}</div>
              </td>
              <td class="mono muted">
                @if (c.oc_folio) {
                  <button type="button" class="cb-reflink mono" (click)="inspect.set(refOc(c.sucursal, c.oc_folio))"
                          [attr.aria-label]="'Abrir la orden de compra ' + c.oc_folio">{{ c.oc_folio }}</button>
                } @else { — }
              </td>
              <td class="ta-r strong">{{ money(c.monto) }}</td>
              @if (dinero()) {
                <!-- El ajuste NO es de suyo un problema: 3 de cada 4 son beneficio negociado
                     (descuento, pronto pago, apoyo de marca). Por eso el ámbar es sólo para el
                     operativo —faltante, mal estado, no solicitado—, que sí es algo que salió
                     mal. Pintar de rojo un apoyo de marca es entrenar a ignorar el color. -->
                <td class="ta-r cb-ajuste" [class.is-op]="(c.ajuste_operativo || 0) !== 0">
                  @if (c.n_ajuste) {
                    <span [pTooltip]="ajusteTip(c)" tooltipPosition="left">−{{ money(c.ajuste) }}</span>
                  } @else { <span class="muted">—</span> }
                </td>
                <td class="ta-r strong">{{ money(c.neto) }}</td>
              }
              <td class="cb-comp-cell" (click)="openDetail(c)" [title]="c.deposits > 0 ? 'Ver remisión adjunta + detalle por línea' : 'Ver detalle por línea'">
                @if (c.deposits > 0) {
                  <div class="cb-comp">
                    <p-tag [value]="depLabel(c.deposit_status)" [severity]="depSev(c.deposit_status)" />
                    <span class="cb-match" [class.ok]="c.monto_match" [class.bad]="!c.monto_match" [title]="c.monto_match ? 'El total de la remisión cuadra con la entrada' : 'El total de la remisión NO cuadra'">
                      <i class="pi" [ngClass]="c.monto_match ? 'pi-check-circle' : 'pi-exclamation-triangle'"></i>
                    </span>
                    <i class="pi pi-eye cb-eye" aria-hidden="true"></i>
                  </div>
                } @else if (verDescartadas()) {
                  <!-- RE.20.3 — en la vista de descartadas la columna dice POR QUÉ salió del
                       proceso. Sin el motivo a la vista, "descartada" es una fila que
                       desapareció y nadie puede auditar la decisión. -->
                  <span class="cb-descartada" [pTooltip]="descarteTip(c)" tooltipPosition="top">
                    <i class="pi pi-ban" aria-hidden="true"></i> {{ motivoDescarteLabel(c.descarte_motivo) || 'Descartada' }}
                  </span>
                } @else { <span class="muted cb-comp-empty"><i class="pi pi-paperclip" aria-hidden="true"></i> Sin remisión</span> }
              </td>
              <td>
                @if (verDescartadas()) {
                  @if (canValidate()) {
                    <button pButton type="button" size="small" text severity="secondary"
                            [loading]="descartando() === clave(c)" [disabled]="!!descartando()"
                            (click)="reactivar(c)" title="Vuelve al proceso: apareció la factura">
                      <span class="p-button-icon p-button-icon-left pi pi-replay" aria-hidden="true"></span><span class="p-button-label">Reactivar</span>
                    </button>
                  }
                } @else {
                  <button pButton type="button" size="small" text (click)="openAttach(c)" [title]="c.deposits > 0 ? 'Agregar otra remisión' : 'Adjuntar remisión'"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">{{ c.deposits > 0 ? 'Otra' : 'Adjuntar' }}</span></button>
                  @if (c.deposit_id && canValidate()) {
                    @if (c.deposit_status !== 'validado') { <button pButton type="button" size="small" text severity="success" [loading]="actingId() === c.deposit_id" [disabled]="!!actingId()" (click)="doValidate(c)" title="Validar"><span class="p-button-icon pi pi-check" aria-hidden="true"></span></button> }
                    @if (c.deposit_status !== 'rechazado') { <button pButton type="button" size="small" text severity="danger" (click)="openReject(c)" title="Rechazar"><span class="p-button-icon pi pi-times" aria-hidden="true"></span></button> }
                  }
                  <!-- RE.20.3 — sólo sin evidencia: si la factura ya está subida la respuesta es
                       validarla o devolverla. El server lo vuelve a comprobar. -->
                  @if (!c.deposits && canValidate()) {
                    <button pButton type="button" size="small" text severity="secondary"
                            (click)="openDescartar(c)" title="Nunca va a tener factura (traspaso, $0, cancelada)">
                      <span class="p-button-icon pi pi-ban" aria-hidden="true"></span>
                    </button>
                  }
                }
              </td>
            </tr>
            @if (filaAbierta() === claveFila(c)) {
              <tr class="cb-exp">
                <td [attr.colspan]="dinero() ? 9 : 7">
                  @if (filaLoading()) {
                    <p class="cb-exp-nota"><i class="pi pi-spin pi-spinner"></i> Abriendo el movimiento…</p>
                  } @else if (filaError()) {
                    <p class="cb-exp-nota">No se pudo abrir el movimiento. <button type="button" class="cb-exp-retry" (click)="reintentarFila(c)">Reintentar</button></p>
                  } @else if (filaDetalle(); as fd) {
                    @if (fd.lineas.length) {
                      <!-- surf-table--plain es la BASE compartida para tablas crudas: existe
                           justamente para que cada pantalla no reinvente th/padding/tamaño.
                           comm-num ya trae mono + tabular-nums y, de paso, evita que la regla
                           descendente .cb-table td.ta-r se filtre acá adentro. -->
                      <div class="cb-exp-scroll">
                        <table class="surf-table surf-table--plain is-dense">
                          <thead><tr><th>SKU</th><th>Producto</th><th class="comm-num">Cant.</th><th>Unidad</th><th class="comm-num">Costo</th><th class="comm-num">Importe</th></tr></thead>
                          <tbody>
                            @for (l of fd.lineas; track l.linea) {
                              <tr>
                                <td class="mono">{{ l.sku || '—' }}</td>
                                <td>{{ l.nombre || '—' }}</td>
                                <td class="comm-num">{{ l.cantidad }}</td>
                                <td>{{ l.unidad || '—' }}</td>
                                <td class="comm-num">{{ money(l.costo_unitario) }}</td>
                                <td class="comm-num">{{ money(l.importe) }}</td>
                              </tr>
                            }
                          </tbody>
                          <tfoot>
                            <tr>
                              <!-- lineasMeta explica de una vez por qué Σ renglones ≠ total del
                                   documento: son el SUBTOTAL y c16 va con impuestos. No se afirma
                                   "es el IVA" salvo que el número lo confirme — en dulcería hay IEPS. -->
                              <td colspan="5">{{ filaLineasMeta(fd) }}</td>
                              <td class="comm-num">{{ money(lineasTotal(fd.lineas)) }}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    } @else {
                      <!-- Wincaja (sucursales 30/32/50) manda la recepción SIN renglones: es
                           header-only en el origen, no un fallo de carga. Decirlo evita que
                           alguien lo reporte como bug. -->
                      <p class="cb-exp-nota">Esta recepción no trae renglones en el ERP. Se capturó sólo con el total.</p>
                    }
                  }
                </td>
              </tr>
            }
          </ng-template>
          <!-- RE.20.1 — los totales del lente son de TODO lo filtrado, no de la página: la
               pregunta "¿cuánto pagamos?" no se contesta con las 100 filas de enfrente. Por eso
               los manda el server y no se suman acá. -->
          @if (dinero() && report()?.totales; as t) {
            <ng-template #footer>
              <tr class="cb-tot">
                <td colspan="4">Todo lo filtrado · <strong>{{ report()?.total }}</strong> compras</td>
                <td class="ta-r">{{ money(t.factura) }}</td>
                <td class="ta-r cb-ajuste">{{ t.ajuste ? '−' + money(t.ajuste) : '—' }}</td>
                <td class="ta-r strong">{{ money(t.neto) }}</td>
                <td colspan="2"></td>
              </tr>
            </ng-template>
          }
          <ng-template #emptymessage><tr><td [attr.colspan]="dinero() ? 9 : 7" class="cb-empty">Sin entradas para el filtro.</td></tr></ng-template>
        </p-table>

        <!-- RE.17.5 — paginación de servidor. El p-table paginaba las 150 filas que ya tenía en
             memoria mientras el server mandaba 300 y el KPI contaba miles: el corte era mudo
             y no había forma de llegar a la fila 301. Regla de datos densos 7: lo auditable se
             pagina, y se dice cuánto hay. -->
        @if (report(); as r) {
          <div class="cb-pager">
            <!-- RE.20.2 — el orden, dicho. Se leía en el segmentado del filtro; ahora que vive
                 en el encabezado hace falta escribirlo en algún lado, y el contador es la misma
                 frase: "qué estás viendo y en qué orden". -->
            <span>{{ desde() }}–{{ hasta() }} de <strong>{{ r.total }}</strong><em class="cb-orden">{{ ordenTexto() }}</em></span>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="page() === 1 || loading()" (click)="irPagina(page() - 1)">
              <span class="p-button-icon pi pi-angle-left" aria-hidden="true"></span><span class="p-button-label">Anterior</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="hasta() >= r.total || loading()" (click)="irPagina(page() + 1)">
              <span class="p-button-label">Siguiente</span><span class="p-button-icon pi pi-angle-right" aria-hidden="true"></span>
            </button>
          </div>
        }
      </div>
      }
    </div>

    <!-- Diálogo: adjuntar remisión + OCR -->
    <p-dialog [visible]="showAttach()" (visibleChange)="onAttachVisible($event)" [modal]="true" [style]="{ width: '40rem' }" [draggable]="false" [header]="photoFirst() ? 'Adjuntar comprobantes (PDF)' : 'Adjuntar comprobantes de la entrada'">
      <div class="cb-form">
        @if (photoFirst() && attachStep() === 1) {
          <!-- PASO 1 — identificar la entrada por los últimos 4 dígitos del folio (OE opcional) -->
          <div class="cb-step-head"><span class="cb-step-n">1</span><span>Identificá la orden de entrada por los <strong>últimos 4 dígitos</strong> de su folio (buscala abajo). En el paso 2 subís la <strong>factura</strong>.</span></div>
          @if (!ordenFile() && !attachTarget()) {
            <div class="cb-drop cb-drop-opt" [class.drag]="dragging()"
                 (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
              <i class="pi pi-file-pdf cb-drop-ico" aria-hidden="true"></i>
              <div class="cb-drop-main"><span class="cb-opt-tag">opcional</span> Arrastrá el <strong>PDF de la orden de entrada</strong> para enlazarla sola</div>
              <div class="cb-drop-or">o</div>
              <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir PDF
                <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden />
              </label>
              <div class="cb-drop-hint">Si prefieres, mejor identifícala por el folio abajo — es más rápido.</div>
            </div>
          }
          @if (ordenFile(); as f) {
            <div class="cb-files">
              <div class="cb-file-card primary" [class.dup]="!!f.dup">
                <div class="cb-file-thumb">
                  @if (f.kind === 'image') { <img [src]="f.uploaded?.url || f.dataUri" [alt]="f.name" /> }
                  @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                </div>
                <div class="cb-file-body">
                  <div class="cb-file-name" [title]="f.name">{{ f.name }}</div>
                  <div class="cb-file-controls">
                    <span class="cb-role-fixed"><i class="pi pi-star-fill" aria-hidden="true"></i> Aplica Orden Entrada</span>
                    @if (f.uploading) { <span class="cb-file-stat" title="Almacenando…"><i class="pi pi-spin pi-spinner"></i></span> }
                    @else if (f.uploaded) { <span class="cb-file-stat ok" title="Almacenada — ya no vive en el teléfono"><i class="pi pi-check-circle"></i></span> }
                    @else if (f.failed) { <button type="button" class="cb-file-retry" (click)="retryUpload(f)" title="Reintentar subida"><i class="pi pi-refresh"></i></button> }
                  </div>
                  @if (f.dup) { <div class="cb-file-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupText(f) }}</div> }
                </div>
                <button type="button" class="cb-file-x" (click)="removeFile(f)" [attr.aria-label]="'Quitar ' + f.name"><i class="pi pi-times" aria-hidden="true"></i></button>
              </div>
            </div>
            <div class="cb-ocr-actions">
              @if (ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> Leyendo la orden…</span>
              } @else if (ocrRun()) {
                @if (ocrForm.ocr_status === 'sin_key') { <span class="cb-hint">OCR no disponible — enlazá la entrada abajo.</span> }
                @else if (ocrForm.ocr_status === 'ilegible') { <span class="cb-hint">No se pudo leer — enlazá la entrada abajo.</span> }
                <button pButton type="button" size="small" text (click)="runOcr()" title="Volver a leer la orden"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Releer</span></button>
              }
            </div>
          }
          @if (attachTarget(); as t) {
            <div class="cb-cobro cb-cobro-ok">
              <div><span class="cb-lbl">Entrada enlazada</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
              <div><span class="cb-lbl">Proveedor</span><strong>{{ t.proveedor_nombre || t.proveedor_code }}</strong></div>
              <div class="ta-r"><span class="cb-lbl">Valor</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
              <button pButton type="button" size="small" text (click)="unlinkEntrada()" title="Cambiar la entrada enlazada"><span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span><span class="p-button-label">Cambiar</span></button>
            </div>
          } @else {
            <div class="cb-link">
              @if (matching()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando la entrada…</span>
              } @else if (matchCandidates() === null) {
                <p class="cb-link-hint"><i class="pi pi-search" aria-hidden="true"></i> Escribí los <strong>últimos 4 dígitos</strong> del folio de la orden de entrada (o proveedor):</p>
                <div class="cb-link-search">
                  <input pInputText [(ngModel)]="manualSearch" placeholder="Últimos 4 del folio (ej. 0397), o proveedor…" (keyup.enter)="runManualSearch()" aria-label="Buscar entrada" />
                  <button pButton type="button" size="small" (click)="runManualSearch()" ariaLabel="Buscar entrada"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                </div>
              } @else {
                <div class="cb-link-head">
                  @if (matchCandidates()!.length) { {{ matchCandidates()!.length }} entrada(s) posible(s) — elegí la correcta: }
                  @else { No la reconocí automáticamente — buscala por folio o proveedor: }
                </div>
                <div class="cb-link-search">
                  <input pInputText [(ngModel)]="manualSearch" placeholder="Últimos 4 del folio (ej. 0397), o proveedor…" (keyup.enter)="runManualSearch()" aria-label="Buscar entrada" />
                  <button pButton type="button" size="small" (click)="runManualSearch()" ariaLabel="Buscar entrada"><span class="p-button-icon pi pi-search" aria-hidden="true"></span></button>
                </div>
                @for (e of matchCandidates()!; track e.sucursal + '/' + e.folio) {
                  <button type="button" class="cb-link-cand" (click)="pickEntrada(e)">
                    <span class="mono">{{ e.sucursal }}/{{ e.folio }}</span>
                    <span class="cb-link-prov">{{ e.proveedor_nombre || e.proveedor_code || '—' }}</span>
                    <span class="cb-link-monto">{{ money(e.monto) }}</span>
                    @if (e.deposits > 0) { <span class="cb-link-has" title="Ya tiene comprobante">ya tiene</span> }
                  </button>
                }
              }
            </div>
          }
        } @else {
          <!-- PASO 2 — entrada enlazada + demás documentos (remisión/factura, vale, ticket) -->
          @if (attachTarget(); as t) {
            <div class="cb-cobro">
              <div><span class="cb-lbl">Entrada</span><strong class="mono">{{ t.sucursal }}/{{ t.folio }}</strong></div>
              <div><span class="cb-lbl">Proveedor</span><strong>{{ t.proveedor_nombre || t.proveedor_code }}</strong></div>
              <div class="ta-r"><span class="cb-lbl">Valor de la entrada</span><strong class="cb-monto">{{ money(t.monto) }}</strong></div>
            </div>
          }
          <div class="cb-step-head">@if (photoFirst()) { <span class="cb-step-n">2</span> }<span>Subí la <strong>factura del proveedor</strong> — es lo único obligatorio; la comparo contra el total de Kepler. Puedes agregar la orden de entrada u otra evidencia (opcional).</span></div>
          @if (!attachFiles().length) {
            <div class="cb-drop" [class.drag]="dragging()"
                 (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
              <i class="pi pi-file-pdf cb-drop-ico" aria-hidden="true"></i>
              <div class="cb-drop-main">Arrastrá aquí la <strong>factura del proveedor</strong> (PDF)</div>
              <div class="cb-drop-or">o</div>
              <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir PDF
                <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden multiple />
              </label>
            </div>
          }
          @if (attachFiles().length) {
            <div class="cb-files">
              @for (f of attachFiles(); track f.id) {
                <div class="cb-file-card" [class.primary]="f.primary" [class.dup]="!!f.dup">
                  <div class="cb-file-thumb">
                    @if (f.kind === 'image') { <img [src]="f.uploaded?.url || f.dataUri" [alt]="f.name" /> }
                    @else { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                  </div>
                  <div class="cb-file-body">
                    <div class="cb-file-name" [title]="f.name">{{ f.name }}</div>
                    <div class="cb-file-controls">
                      <!-- RE.17.5 — p-select y no un select crudo (checklist 3): era el único
                           control de esta pantalla fuera del sistema, y el nativo no toma el
                           tema (en oscuro salía con la lista blanca del sistema operativo). -->
                      <p-select class="cb-role" [options]="roleOpts()" [ngModel]="f.role"
                                (ngModelChange)="setRole(f, $event)" optionLabel="label" optionValue="value"
                                appendTo="body" styleClass="cb-role-sel" [ariaLabel]="'Tipo de ' + f.name" />
                      <button type="button" class="cb-star" [class.on]="f.primary" (click)="setPrimary(f)" [title]="f.primary ? 'Enlaza la entrada' : 'Usar esta para enlazar'"><i class="pi" [ngClass]="f.primary ? 'pi-star-fill' : 'pi-star'" aria-hidden="true"></i></button>
                      @if (f.ocrLoading) { <span class="cb-file-stat" title="Leyendo con OCR…"><i class="pi pi-spin pi-spinner"></i></span> }
                      @else if (f.ocrFolio && !f.dup) { <span class="cb-file-folio" title="Folio leído por OCR">#{{ f.ocrFolio }}</span> }
                      @if (f.uploading) { <span class="cb-file-stat" title="Almacenando…"><i class="pi pi-spin pi-spinner"></i></span> }
                      @else if (f.uploaded) { <span class="cb-file-stat ok" title="Almacenada — ya no vive en el teléfono"><i class="pi pi-check-circle"></i></span> }
                      @else if (f.failed) { <button type="button" class="cb-file-retry" (click)="retryUpload(f)" title="Reintentar subida"><i class="pi pi-refresh"></i></button> }
                    </div>
                    @if (f.dup) { <div class="cb-file-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupText(f) }}</div> }
                  </div>
                  <button type="button" class="cb-file-x" (click)="removeFile(f)" [attr.aria-label]="'Quitar ' + f.name"><i class="pi pi-times" aria-hidden="true"></i></button>
                </div>
              }
              <div class="cb-addmore" [class.drag]="dragging()"
                   (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
                <label class="cb-pickbtn"><i class="pi pi-upload"></i> Elegir más PDF
                  <input type="file" accept="application/pdf" (change)="onFiles($event)" hidden multiple />
                </label>
                <span class="cb-addmore-drop"><i class="pi pi-arrow-down" aria-hidden="true"></i> o arrastrá aquí</span>
                <span class="cb-addmore-n">{{ attachFiles().length }} adjunta(s)</span>
              </div>
            </div>

            <div class="cb-ocr-actions">
              @if (ocrLoading()) {
                <span class="cb-proc"><i class="pi pi-spin pi-spinner"></i> Leyendo la orden…</span>
              } @else if (ocrRun()) {
                @if (matchState() === true) { <p-tag value="La remisión cuadra con la entrada" severity="success" /> }
                @else if (matchState() === false) { <p-tag [value]="'Difiere ' + money(diff())" severity="danger" /> }
              }
            </div>

            <!-- Lo que leyó Claude Vision de la factura del proveedor es EVIDENCIA, no un
                 formulario: de estos números salen el cuadre contra Kepler y el descuadre
                 que se persiste. Editables, cualquiera podía teclear el importe de Kepler y
                 dejar la entrada "cuadrada" sin que la factura lo dijera. ¿Leyó mal? Releer,
                 mejor foto, o que se rechace — no escribirle encima. -->
            <div class="cb-fields-head">Lo que leyó Claude Vision
              <em class="cb-auto">de la factura del proveedor · es la evidencia, no se edita</em></div>
            <dl class="cb-read">
              <div><dt>Total</dt><dd class="cb-num">{{ ocrForm.total != null ? money(ocrForm.total) : '—' }}</dd></div>
              <div><dt>Subtotal</dt><dd class="cb-num">{{ ocrForm.subtotal != null ? money(ocrForm.subtotal) : '—' }}</dd></div>
              <div><dt>IVA</dt><dd class="cb-num">{{ ocrForm.iva != null ? money(ocrForm.iva) : '—' }}</dd></div>
              <div><dt>Folio</dt><dd class="cb-num">{{ ocrForm.folio || '—' }}</dd></div>
              <div><dt>Fecha</dt><dd class="cb-num">{{ ocrForm.fecha || '—' }}</dd></div>
              <div><dt>RFC</dt><dd class="cb-num">{{ ocrForm.rfc || '—' }}</dd></div>
              <div class="cb-read-wide"><dt>Proveedor (emisor)</dt><dd>{{ ocrForm.proveedor || '—' }}</dd></div>
            </dl>
            <!-- Salida honesta cuando leyó mal: no hay dónde escribir el número correcto, y
                 la entrada se identifica aparte (abajo), que es identidad y no importe. -->
            <p class="cb-read-out">Si algo quedó mal leído: <button type="button" class="cb-linkbtn" (click)="runOcr()">releer</button>, subí una foto mejor, o guardá así y que se resuelva al validar.</p>
          }
          @if (dupFiles().length) { <div class="cb-dup"><i class="pi pi-ban" aria-hidden="true"></i> {{ dupFiles().length }} hoja(s) duplicada(s) (misma imagen o folio ya subido) — quitala(s) para guardar.</div> }
          @if (attachFiles().length) {
            <div class="cb-checklist">
              <div class="cb-checklist-head">
                <span>Documentos requeridos · <strong>{{ srcKind() === 'kepler' ? 'Kepler (CEDIS)' : 'Wincaja (sucursal)' }}</strong></span>
                @if (!missingGroups().length) { <span class="cb-chk-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Completo</span> }
                @else { <span class="cb-chk-miss">{{ missingGroups().length }} faltante(s)</span> }
              </div>
              <ul class="cb-chk-list">
                @for (c of checklist(); track c.label) {
                  <li [class.ok]="c.ok" [class.opt]="c.optional"><i class="pi" [ngClass]="c.ok ? 'pi-check-circle' : (c.optional ? 'pi-minus-circle' : 'pi-circle')" aria-hidden="true"></i>
                    <span class="cb-chk-lbl">{{ c.label }}</span>
                    @if (c.optional && !c.ok) { <span class="cb-chk-opt">opcional</span> }
                    @if (c.ok && c.via === 'auto') {
                      <span class="cb-chk-via" title="Detectado por el lector">detectado{{ c.page ? ' · pág. ' + c.page : '' }}</span>
                      @if (c.evidence) { <span class="cb-chk-ev" [title]="c.evidence">{{ c.evidence }}</span> }
                    } @else if (c.ok && c.via === 'manual') {
                      <span class="cb-chk-via cb-chk-via-manual" title="Asignado a mano">manual</span>
                    }
                  </li>
                }
              </ul>
              @if (detectedDocs().length) {
                <div class="cb-detected">
                  <span class="cb-detected-h"><i class="pi pi-file-check" aria-hidden="true"></i> Detectado en el archivo</span>
                  <ul>
                    @for (d of detectedDocs(); track d.type + '|' + d.page) {
                      <li><strong>{{ d.label }}</strong>@if (d.page) { <span class="cb-detected-pg">pág. {{ d.page }}</span> }@if (d.evidence) { <span class="cb-detected-ev">{{ d.evidence }}</span> }</li>
                    }
                  </ul>
                </div>
              }
              <p class="cb-chk-hint">Los tipos se detectan leyendo cada hoja — si subiste todo en un solo PDF, cuenta igual (mostramos la página y la prueba de cada uno).</p>
            </div>
          }
        }
        @if (attachError()) { <div class="cb-err">{{ attachError() }}</div> }
      </div>
      <ng-template #footer>
        @if (photoFirst() && attachStep() === 1) {
          <button pButton type="button" text (click)="closeAttach()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" [disabled]="!attachTarget()" (click)="continuar()"><span class="p-button-label">Continuar</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span></button>
        } @else {
          @if (photoFirst()) {
            <button pButton type="button" text (click)="backToStep1()"><span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span><span class="p-button-label">Atrás</span></button>
          } @else {
            <button pButton type="button" text (click)="closeAttach()"><span class="p-button-label">Cancelar</span></button>
          }
          <button pButton type="button" [loading]="saving()" [disabled]="!attachFiles().length || uploadingAny() || ocrBusy() || dupFiles().length > 0 || !attachTarget() || missingGroups().length > 0" (click)="saveAttach()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar {{ attachFiles().length > 1 ? attachFiles().length + ' fotos' : 'comprobante' }}</span></button>
        }
      </ng-template>
    </p-dialog>

    <!-- Diálogo: rechazo -->
    <p-dialog [visible]="showReject()" (visibleChange)="onRejectVisible($event)" [modal]="true" [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar remisión">
      <div class="cb-form">
        <p class="muted">Entrada <strong>{{ rejectTarget()?.folio }}</strong> · {{ rejectTarget()?.proveedor_nombre }}</p>
        <label class="cb-f"><span>Motivo del rechazo *</span>
          <textarea pInputText [(ngModel)]="rejectMotivo" rows="3" placeholder="Ej. remisión ilegible, total no cuadra, no corresponde…"></textarea></label>
      </div>
      <ng-template #footer>
        <button pButton type="button" text (click)="closeReject()"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [loading]="saving()" (click)="doReject()"><span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span><span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>

    <!--
      RE.20.3 — Descartar. Le faltaba al proceso la salida para lo que NUNCA va a tener factura:
      hasta acá el único camino era "Devuelta", que rebota a la sucursal pidiéndole que suba algo
      que no existe. La entrada se queda Sin factura para siempre e infla el atraso de esa
      sucursal. El motivo es obligatorio y tipificado porque el descarte RESTA del denominador de
      cobertura: sin motivo medible, descartar es el camino corto al 100%.
    -->
    <p-dialog [visible]="showDescartar()" (visibleChange)="showDescartar.set($event)" [modal]="true"
              [style]="{ width: '30rem' }" [draggable]="false" header="Sacar del proceso">
      @if (descartarFila(); as c) {
        <div class="cb-form">
          <p class="muted">
            Entrada <strong>{{ c.folio }}</strong> · {{ c.proveedor_nombre || c.proveedor_code }} · {{ money(c.monto) }}
          </p>
          <p class="cb-desc-lead">
            Esta entrada deja de pedir factura y <strong>sale del atraso</strong> de {{ suc(c.sucursal) }}.
            Se sigue contando aparte, en el tablero de Control.
          </p>
          <div class="cb-desc-motivos" role="radiogroup" aria-label="Motivo del descarte">
            @for (m of MOTIVOS_DESCARTE; track m.code) {
              <label class="cb-desc-m" [class.is-sel]="descarteMotivo() === m.code">
                <input type="radio" name="motivoDescarte" [value]="m.code"
                       [checked]="descarteMotivo() === m.code" (change)="descarteMotivo.set(m.code)" />
                <span><b>{{ m.label }}</b><em>{{ m.pista }}</em></span>
              </label>
            }
          </div>
          <label class="cb-f"><span>Nota {{ descarteMotivo() === 'otro' ? '*' : '(opcional)' }}</span>
            <textarea pInputText [ngModel]="descarteNota()" (ngModelChange)="descarteNota.set($event)" rows="2"
                      placeholder="Qué pasó con esta entrada"></textarea></label>
        </div>
        <ng-template #footer>
          <button pButton type="button" text (click)="showDescartar.set(false)"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" severity="secondary" [loading]="!!descartando()" (click)="confirmarDescarte()">
            <span class="p-button-icon p-button-icon-left pi pi-ban" aria-hidden="true"></span><span class="p-button-label">Descartar</span>
          </button>
        </ng-template>
      }
    </p-dialog>

    <!-- Diálogo: detalle por línea (auditoría) + comparación documento vs OCR (RE.8) -->
    <!--
      RE.17.5 — el expediente sale del modal. Era un p-dialog de 72rem maximizable con la
      auditoría renglón por renglón adentro, y encima abría un CUARTO diálogo para ver la hoja:
      DESIGN §O.1 prohíbe leer un documento financiero extenso en un overlay superpuesto. Ahora
      es el organismo canónico de detalle (SidePeek, regla #8 de datos densos) — la lista se
      sigue viendo detrás, que es lo que permite ir de una orden a la siguiente.
    -->
    <app-side-peek [(open)]="showDetail" [width]="1060" title="Orden de entrada"
                   [subtitle]="detailSubtitulo()">
      @if (detailLoading()) {
        <!-- Esqueleto con la FORMA del contenido (veredicto + 3 cifras + ficha + renglones):
             sin salto de layout al llegar los datos. Regla de datos densos: skeleton de
             filas, no spinner de bloque. -->
        <div class="cb-detail-skel" aria-busy="true" aria-label="Cargando detalle">
          <span class="cb-sk cb-sk-verdict"></span>
          <span class="cb-sk cb-sk-tri"></span>
          <span class="cb-sk cb-sk-head"></span>
          @for (i of [1,2,3,4,5,6]; track i) { <span class="cb-sk cb-sk-row"></span> }
        </div>
      } @else if (detailData(); as d) {
        <div class="cb-review"><div class="cb-review-main">

        <!-- Q.1 answer-first: la pregunta de esta pantalla es si el papel del proveedor
             cuadra con lo que Kepler registró. Va primero y en llano; la ficha y el grid
             de renglones son la evidencia, y van después. -->
        @if (cuadre(d); as q) {
          <div class="cb-verdict" [class]="'cb-verdict is-' + q.tone" role="status">
            <i class="pi" [ngClass]="q.icon" aria-hidden="true"></i>
            <div class="cb-verdict-txt">
              <p class="cb-verdict-t">{{ q.titulo }}</p>
              <p class="cb-verdict-s">{{ q.lectura }}</p>
            </div>
          </div>

          <!-- Las tres cifras comparables, juntas y alineadas a la misma columna.
               Vivían en tres bloques distintos del diálogo, que es exactamente lo que
               impedía compararlas de un vistazo. -->
          <dl class="cb-tri">
            <div class="cb-tri-c">
              <dt>Kepler</dt>
              <dd>{{ money(q.kepler) }}</dd>
              <p>total registrado, con IVA</p>
            </div>
            <div class="cb-tri-c">
              <dt>Σ renglones</dt>
              <dd>{{ money(q.lineas) }}</dd>
              <p>{{ q.lineasMeta }}</p>
            </div>
            <div class="cb-tri-c" [class.is-off]="q.tone === 'bad'">
              <dt>Documento (OCR)</dt>
              <dd>{{ q.ocr != null ? money(q.ocr) : '—' }}</dd>
              <p>{{ q.ocrMeta }}</p>
            </div>
          </dl>
        }

        <div class="cb-cobro">
          <div><span class="cb-lbl">Entrada</span>
            <button type="button" class="cb-reflink mono strong" (click)="inspect.set(refEnt(d.entrada.sucursal, d.entrada.folio))"
                    title="Ficha completa: renglones, ajustes, pagos candidatos y copia CEDIS">{{ d.entrada.sucursal }}/{{ d.entrada.folio }}</button></div>
          <div><span class="cb-lbl">Proveedor</span>
            @if (d.entrada.proveedor_code) {
              <button type="button" class="cb-reflink strong" (click)="inspect.set(refProv(d.entrada.proveedor_code))"
                      title="Ficha del proveedor: compras, ajustes, pagos y listas del SAT">{{ d.entrada.proveedor_nombre || d.entrada.proveedor_code }}</button>
            } @else { <strong>{{ d.entrada.proveedor_nombre || '—' }}</strong> }
            <div class="cb-sub">{{ d.entrada.proveedor_rfc }}</div></div>
          <div><span class="cb-lbl">Fecha</span><strong>{{ d.entrada.receipt_date | date:'dd/MM/yy' }}</strong></div>
          <div><span class="cb-lbl">OC / Vale</span><strong class="mono">
            @if (d.entrada.oc_folio) {
              <button type="button" class="cb-reflink mono" (click)="inspect.set(refOc(d.entrada.sucursal, d.entrada.oc_folio))"
                      title="Abrir la orden de compra: lo pedido, sus vales y qué tanto se surtió">{{ d.entrada.oc_folio }}</button>
            } @else { — }
            /
            @if (d.entrada.vale_folio) {
              <button type="button" class="cb-reflink mono" (click)="inspect.set(refVale(d.entrada.sucursal, d.entrada.vale_folio))"
                      title="Abrir el vale de entrada y su orden de compra">{{ d.entrada.vale_folio }}</button>
            } @else { — }
          </strong></div>
          <div class="ta-r"><span class="cb-lbl">Total Kepler</span><strong class="cb-monto">{{ money(d.entrada.monto) }}</strong></div>
        </div>
        @if (d.redirigido_de) {
          <div class="cb-twin"><i class="pi pi-directions" aria-hidden="true"></i>
            <span>Buscaste <strong class="mono">{{ d.redirigido_de.sucursal }}/{{ d.redirigido_de.folio }}</strong>,
              el folio con el que <strong>oficinas</strong> capturó esta recepción. Lo que ves es el documento de la
              sucursal, que es el que trae los productos y el que lleva la evidencia.</span>
          </div>
        }
        @if (d.cedis_twins?.length) {
          <div class="cb-twin"><i class="pi pi-clone" aria-hidden="true"></i>
            <span>La misma recepción está capturada también en <strong>oficinas</strong> (servidor 9.95) —
              no requiere evidencia aparte:</span>
            @for (t of d.cedis_twins; track t.sucursal + '/' + t.folio) {
              <button type="button" class="cb-twin-folio cb-reflink mono" (click)="inspect.set(refEnt(t.sucursal, t.folio))"
                      [attr.aria-label]="'Abrir la copia de oficinas ' + t.sucursal + '/' + t.folio">{{ t.sucursal }}/{{ t.folio }}</button>
              <span class="cb-twin-meta">
                {{ t.monto == null ? '' : money(t.monto) }}<!--
                --><!-- El delta entre nuestras dos capturas: pequeño pero hay que poder verlo,
                        porque es lo que explica un "no cuadra" que no es del proveedor. -->
                @if (t.delta_monto) { · Δ {{ money(t.delta_monto) }} }
                @if (t.status === 'propuesto') { · <strong>sin dictaminar</strong> }
              </span>
            }
          </div>
        }
        <p-table [value]="d.lineas" styleClass="p-datatable-sm cb-table" [scrollable]="true" scrollHeight="44vh"
                 [paginator]="d.lineas.length > 200" [rows]="200">
          <ng-template #header>
            <tr>
              <th style="width:3rem">#</th>
              <th style="width:6rem">SKU</th>
              <th>Producto</th>
              <th class="ta-r" style="width:6rem">Cant.</th>
              <th style="width:4rem">U</th>
              <th class="ta-r" style="width:8rem">Costo u.</th>
              <th class="ta-r" style="width:9rem">Importe</th>
            </tr>
          </ng-template>
          <ng-template #body let-l>
            <tr>
              <td class="muted">
                <button type="button" class="cb-reflink" (click)="inspect.set(refLin(d.entrada.sucursal, d.entrada.folio, l.linea))"
                        [attr.aria-label]="'Abrir el renglón ' + l.linea">{{ l.linea }}</button>
              </td>
              <td class="mono">
                @if (l.sku) {
                  <button type="button" class="cb-reflink mono" (click)="inspect.set(refSku(l.sku))"
                          [attr.aria-label]="'Abrir el producto ' + l.sku">{{ l.sku }}</button>
                } @else { <span class="muted">—</span> }
              </td>
              <td>{{ l.nombre || '—' }}</td>
              <td class="ta-r">{{ l.cantidad | number:'1.0-2' }}</td>
              <td class="muted">{{ l.unidad || '' }}</td>
              <td class="ta-r">{{ money(l.costo_unitario) }}</td>
              <td class="ta-r strong">{{ money(l.importe) }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="7" class="cb-empty">Sin líneas de detalle para esta entrada.</td></tr></ng-template>
        </p-table>
        <!-- Los totales ya se leyeron arriba, en el bloque de tres cifras. Repetirlos acá
             obligaba a comparar de memoria entre dos puntos de la misma pantalla. -->
        <div class="cb-detail-total">
          <span class="muted">{{ plural(d.lineas.length, 'renglón', 'renglones') }} · Σ {{ money(lineasTotal(d.lineas)) }}</span>
        </div>

        <!-- RE.11 — Conciliación por línea: remisión del proveedor ↔ líneas Kepler ↔ SKU resuelto. -->
        @if (reconLoading()) {
          <div class="cb-recon-load"><i class="pi pi-spin pi-spinner"></i> Conciliando renglones de la remisión…</div>
        } @else if (recon(); as r) {
          <div class="cb-recon">
            <div class="cb-recon-head">
              <h4>Conciliación por línea <span class="muted">· remisión vs Kepler</span></h4>
              <div class="cb-recon-kpis">
                <span class="cb-rk ok">{{ r.totals.cuadran }} cuadran</span>
                <span class="cb-rk warn">{{ r.totals.difieren }} difieren</span>
                <span class="cb-rk bad">{{ r.totals.sin_match }} sin match</span>
                @if (r.totals.revisar) { <span class="cb-rk sec">{{ r.totals.revisar }} revisar</span> }
                @if (r.totals.kepler_orphans) { <span class="cb-rk sec">{{ r.totals.kepler_orphans }} solo en Kepler</span> }
              </div>
            </div>
            <p-table [value]="r.lines" styleClass="p-datatable-sm cb-table" [scrollable]="true" scrollHeight="40vh">
              <ng-template #header>
                <tr>
                  <th>Remisión (proveedor)</th>
                  <th class="ta-r" style="width:5.5rem">Cant.</th>
                  <th style="width:6rem">SKU</th>
                  <th>Producto (Kepler)</th>
                  <th class="ta-r" style="width:5.5rem">Cant. Kepler</th>
                  <th style="width:8rem">Origen</th>
                  <th style="width:8rem">Estado</th>
                  <th style="width:8rem">Acción</th>
                </tr>
              </ng-template>
              <ng-template #body let-l>
                <tr>
                  <td>
                    <span class="strong">{{ l.remision.descripcion || '—' }}</span>
                    @if (l.remision.sku_proveedor) { <span class="muted mono"> · {{ l.remision.sku_proveedor }}</span> }
                  </td>
                  <td class="ta-r">
                    {{ (l.remision.cantidad ?? 0) | number:'1.0-2' }}<span class="muted"> {{ l.remision.unidad || '' }}</span>
                    @if (l.qty_remision_pz != null && l.box_factor > 1) { <div class="muted xs">= {{ l.qty_remision_pz | number:'1.0-0' }} pz</div> }
                  </td>
                  <td class="mono">
                    @if (l.resolved_sku) {
                      <button type="button" class="cb-reflink mono" (click)="inspect.set(refSku(l.resolved_sku))">{{ l.resolved_sku }}</button>
                    } @else { <span class="muted">—</span> }
                  </td>
                  <td>{{ l.resolved_nombre || (l.kepler?.nombre) || '—' }}</td>
                  <td class="ta-r">
                    @if (l.qty_kepler != null) {
                      <span [class.cb-qty-bad]="l.qty_match === false">{{ l.qty_kepler | number:'1.0-2' }}</span>
                    } @else { <span class="muted">—</span> }
                  </td>
                  <td>
                    @if (l.method !== 'sin_match') {
                      <span class="cb-method" [class.alias]="l.alias_hit">{{ reconMethodLabel(l.method) }}</span>
                      @if (!l.alias_hit && l.method === 'descripcion') { <span class="muted xs"> {{ (l.score * 100) | number:'1.0-0' }}%</span> }
                    } @else { <span class="muted">—</span> }
                  </td>
                  <td><p-tag [value]="reconStatusLabel(l.status)" [severity]="reconStatusSev(l.status)" /></td>
                  <td>
                    @if (l.resolved_sku && !l.alias_hit) {
                      <button pButton type="button" size="small" [loading]="reconConfirming() === l.idx" (click)="confirmMatch(l)"
                              title="Aprender: este proveedor llama a este SKU así">
                        <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                        <span class="p-button-label">Aprender</span>
                      </button>
                    } @else if (l.alias_hit) {
                      <span class="cb-learned"><i class="pi pi-bookmark-fill"></i> Aprendido</span>
                    } @else { <span class="muted">—</span> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage><tr><td colspan="8" class="cb-empty">La remisión no trae renglones legibles.</td></tr></ng-template>
            </p-table>
            @if (r.kepler_orphans.length) {
              <div class="cb-recon-orphans">
                <span class="muted">En Kepler sin renglón en la remisión:</span>
                @for (o of r.kepler_orphans; track o.linea) {
                  <span class="cb-orphan">{{ o.sku || '—' }} · {{ o.nombre || '—' }} <span class="muted">({{ o.cantidad | number:'1.0-2' }} {{ o.unidad || '' }})</span></span>
                }
              </div>
            }
          </div>
        }

        <!-- RE.2 — ajustes que EXPLICAN el descuadre (devoluciones / notas de crédito / descuentos del proveedor) -->
        <div class="cb-explains">
          <div class="cb-explains-head">
            <span><i class="pi pi-search-plus" aria-hidden="true"></i> ¿Por qué no cuadra? — ajustes del proveedor</span>
            @if (explains().length) { <span class="cb-explains-sum">{{ explains().length }} · {{ money(explainsTotal()) }}</span> }
          </div>
          @if (explainsLoading()) {
            <p class="muted cb-explains-none"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Buscando ajustes…</p>
          } @else if (!explains().length) {
            <p class="muted cb-explains-none">Sin devoluciones ni notas de crédito (X-D-40/55) de este proveedor cerca de la fecha. Si la factura no cuadra, la diferencia suele ser IVA o captura.</p>
          } @else {
            <p class="cb-explains-hint muted">Devoluciones y notas de crédito de <strong>{{ d.entrada.proveedor_nombre || d.entrada.proveedor_code }}</strong> ±15 días — explican por qué la factura difiere de lo recibido.</p>
            <ul class="cb-explains-list">
              @for (a of explains(); track a.doctype + a.folio) {
                <li class="cb-explains-item">
                  <p-tag [value]="adjDoctypeLabel(a.doctype)" [severity]="a.doctype === 'XD40' ? 'warn' : 'info'" />
                  <button type="button" class="cb-explains-folio cb-reflink mono" (click)="inspect.set(refAdj(a))"
                          [attr.aria-label]="'Abrir el ajuste ' + a.doctype + ' ' + a.folio">{{ a.folio }}</button>
                  <span class="cb-explains-fecha muted">{{ a.adjustment_date | date:'dd/MM/yy' }}</span>
                  <span class="cb-explains-motivo" [title]="a.motivo || ''">{{ a.motivo || '—' }}</span>
                  <p-tag [value]="adjGrupoLabel(a.grupo)" [severity]="adjGrupoSev(a.grupo)" />
                  @if (a.match === 'exacto') { <span class="cb-explains-exact" title="Ligado por folio de entrada"><i class="pi pi-link" aria-hidden="true"></i> exacto</span> }
                  @else { <span class="cb-explains-heur" title="Coincidencia por proveedor + fecha (Kepler no liga la nota a la entrada)">≈ prov+fecha</span> }
                  <span class="cb-explains-monto strong">{{ money(a.monto) }}</span>
                </li>
              }
            </ul>
          }
        </div>

        <div class="cb-view-attachments">
          <div class="cb-view-att-head">Remisión / factura adjunta</div>
          @if (!d.deposits.length) { <p class="muted cb-view-none">Aún sin remisión adjunta.</p> }
          @for (dep of d.deposits; track dep.id) {
            <div class="cb-view-dep">
              <div class="cb-view-head">
                <p-tag [value]="depLabel(dep.status)" [severity]="depSev(dep.status)" />
                @if (dep.monto_match === true) { <p-tag value="Cuadra" severity="success" /> }
                @else if (dep.monto_match === false) { <p-tag value="No cuadra" severity="danger" /> }
                @if (dep.discrepancy_kind && dep.discrepancy_kind !== 'cuadra') {
                  <p-tag [value]="discLabel(dep.discrepancy_kind) + (dep.discrepancy_amount ? ' · ' + money(dep.discrepancy_amount) : '')" [severity]="discSev(dep.discrepancy_kind)" />
                }
                <span class="cb-view-meta">{{ dep.created_by || '—' }} · {{ dep.created_at | date:'dd/MM/yy HH:mm' }}</span>
              </div>
              <div class="cb-view-files">
                @for (f of dep.files; track f.url) {
                  <button type="button" class="cb-view-filebtn" [class.on]="hojaIdx() === indiceHoja(f)"
                          (click)="verHoja(f)" [title]="'Ver ' + (f.name || 'documento') + ' a la derecha'">
                    <i class="pi" [ngClass]="isImageUrl(f) ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
                    <span class="cb-filebtn-name">{{ f.name || (isImageUrl(f) ? 'imagen' : 'remisión (PDF)') }}</span>
                  </button>
                }
                @if (!dep.files.length) { <span class="muted">Sin archivo.</span> }
              </div>
              <div class="cb-view-ocr">
                <span><em>Folio</em> {{ dep.ocr_folio || '—' }}</span>
                <span><em>Fecha</em> {{ dep.ocr_fecha || '—' }}</span>
                <span><em>Proveedor</em> {{ dep.ocr_proveedor || '—' }}</span>
                <span><em>Total</em> {{ dep.ocr_monto != null ? money(dep.ocr_monto) : '—' }}</span>
                @if (dep.ocr_subtotal != null) { <span><em>Subtotal</em> {{ money(dep.ocr_subtotal) }}</span> }
                @if (dep.ocr_iva != null) { <span><em>IVA</em> {{ money(dep.ocr_iva) }}</span> }
              </div>
              @if (dep.status === 'rechazado' && dep.motivo_rechazo) { <div class="cb-err">Rechazado: {{ dep.motivo_rechazo }}</div> }
              @if (dep.comentarios) { <div class="cb-view-coment">{{ dep.comentarios }}</div> }
            </div>
          }
        </div>
        </div><!-- /.cb-review-main -->

        <!-- Panel derecho: el documento, con el visor compartido. Antes era un iframe fijo y la
             hoja sólo se podía agrandar abriendo OTRO diálogo encima. -->
        <aside class="cb-review-doc">
          <app-doc-viewer [files]="hojas()" [(idx)]="hojaIdx"
                          emptyTitle="Sin remisión adjunta"
                          emptyHint="Adjuntá la factura del proveedor para poder compararla contra lo que registró Kepler." />
        </aside>
        </div><!-- /.cb-review -->

        <!-- El SidePeek no tiene pie: las acciones van al final del contenido, que además es
             donde quedan después de leer el expediente. -->
        <div class="cb-review-acts">
          <button pButton type="button" text (click)="showDetail.set(false)"><span class="p-button-label">Cerrar</span></button>
          <button pButton type="button" (click)="fromDetailToAttach()"><span class="p-button-icon p-button-icon-left pi pi-paperclip" aria-hidden="true"></span><span class="p-button-label">Adjuntar remisión</span></button>
        </div>
      }
    </app-side-peek>

    <!-- Panel de ficha: proveedor, entrada, renglón, producto y ajuste se abren acá y
         se navegan entre sí sin salir de la pantalla ni apilar diálogos. -->
    <app-entity-inspector [(ref)]="inspect" />
  `,
  styles: [`
    :host { display: block; }

    /* RE.17.5 */
    .cb-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .cb-pager {
      display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-xs); color: var(--text-muted);
    }
    .cb-pager strong { color: var(--text-main); font-variant-numeric: tabular-nums; }

    /* ── RE.20.3: descartar ────────────────────────────────────────────────
       Gris y no rojo: descartar no es un error ni un castigo, es reconocer que esa entrada
       nunca iba a tener factura. El rojo está reservado para "no cuadra". */
    .cb-descartada {
      display: inline-flex; align-items: center; gap: var(--sp-1);
      color: var(--text-muted); font-size: var(--fs-xs);
    }
    .cb-descartada i { font-size: .75rem; }
    .cb-desc-lead {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--surface-ground); border-radius: var(--r-md);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45;
    }
    .cb-desc-lead strong { color: var(--text-main); }
    .cb-desc-motivos { display: grid; gap: var(--sp-1); }
    /* Cada motivo con su pista debajo: el revisor tiene que reconocer el caso en la fila que
       está mirando, no traducir una etiqueta de catálogo. */
    .cb-desc-m {
      display: flex; align-items: flex-start; gap: var(--sp-2);
      padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md);
      cursor: pointer;
    }
    .cb-desc-m:hover { background: var(--surface-ground); }
    .cb-desc-m.is-sel { border-color: var(--action); background: var(--surface-ground); }
    .cb-desc-m input { margin-top: 2px; accent-color: var(--action); }
    .cb-desc-m span { display: grid; gap: 1px; min-width: 0; }
    .cb-desc-m b { font-size: var(--fs-xs); font-weight: 600; color: var(--text-main); }
    .cb-desc-m em { font-style: normal; font-size: var(--fs-micro); color: var(--text-muted); line-height: 1.4; }
    /* El orden en palabras, pegado al contador: es la misma frase. Punto medio y no guion,
       para que no se lea como continuación del rango "1–100". */
    /* ── RE.20.1: lente del dinero ─────────────────────────────────────────
       El ajuste en gris por default y ámbar SÓLO cuando tiene parte operativa (faltante, mal
       estado, no solicitado). 3 de cada 4 ajustes son beneficio negociado —descuento, pronto
       pago, apoyo de marca— y pintar de rojo un apoyo de marca entrena a ignorar el color. */
    .cb-ajuste { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .cb-ajuste.is-op { color: var(--warn-fg); font-weight: 600; }
    /* Totales de TODO lo filtrado, no de la página: se separan del cuerpo por peso y fondo. */
    .cb-tot > td {
      background: var(--surface-2); font-weight: 600;
      border-top: 1px solid var(--border-color);
    }
    .cb-orden { font-style: normal; }
    .cb-orden::before { content: ' · '; opacity: .55; }
    /* En rem y no en px (regla 9): con px el breakpoint ignora el zoom del navegador y a 200%
       la columna sigue escondida cuando ya había lugar de sobra. */
    @media (max-width: 35rem) { .cb-orden { display: none; } }
    .cb-role-sel { min-width: 9rem; font-size: var(--fs-xs); }
    /* Cualquier dato que lleva a una ficha. Discreto en reposo: la tabla ya tiene
       suficiente color y esto aparece en muchas celdas a la vez. */
    .cb-reflink { border:0; background:transparent; color:inherit; cursor:pointer; padding:0; font:inherit; text-align:left; }
    .cb-reflink:hover { color:var(--action); text-decoration:underline; }
    .cb-reflink:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; border-radius:var(--r-sm); }
    .cb-filters { display: flex; flex-wrap: wrap; gap: .9rem; align-items: flex-end; margin-bottom: 1rem; padding: 1rem; }
    .cb-field { display: flex; flex-direction: column; gap: .3rem; }
    .cb-field > label { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-field.cb-grow { flex: 1 1 16rem; }
    /* RE.10 — pill de órdenes nuevas (WS) */
    .cb-newpill { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .cb-newpill:hover { filter: brightness(1.06); }
    app-metric-strip { display: block; margin-bottom: 1rem; }
    /* Tira de frescura por fuente. Discreta cuando todo está al día; la fuente atrasada
       es la única que toma color, para que se lea de un vistazo. */
    .fresh-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .5rem; margin: -.4rem 0 1rem; }
    .fresh-lbl { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-right: .15rem; }
    .fresh-chip { display: inline-flex; align-items: center; gap: .3rem; padding: .12rem .45rem;
      font-size: var(--fs-xs, .75rem); color: var(--text-muted);
      border: 1px solid var(--border-color); border-radius: var(--r-sm, .35rem); }
    .fresh-chip b { color: var(--text-main); font-weight: 600; font-family: var(--font-mono); font-size: .95em; }
    .fresh-chip.late { color: var(--warn-fg, var(--bad-fg)); border-color: currentColor; }
    .fresh-chip.late b { color: inherit; }
    .fresh-note { font-size: var(--fs-xs, .75rem); color: var(--warn-fg, var(--bad-fg)); }
    .fecha-mala { color: var(--warn-fg, var(--bad-fg)); font-size: .8em; margin-left: .25rem; }
    .cb-table .ta-r { text-align: right; font-variant-numeric: tabular-nums; }
    .cb-table td.ta-r { font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-table .strong { font-weight: 600; color: var(--text-main); }
    .cb-table .muted { color: var(--text-muted); }
    .cb-sub { font-size: .7rem; color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-size: .85em; }
    .cb-comp { display: inline-flex; align-items: center; gap: .45rem; }
    .cb-match.ok { color: var(--ok-fg); }
    .cb-match.bad { color: var(--bad-fg); }
    .cb-empty { text-align: center; color: var(--text-muted); padding: 2rem; }
    .cb-form { display: flex; flex-direction: column; gap: .85rem; padding: .25rem 0; }
    .cb-cobro { display: flex; gap: 1.2rem; flex-wrap: wrap; align-items: flex-end; padding: .7rem .9rem; background: var(--surface-2); border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); }
    .cb-cobro > div { display: flex; flex-direction: column; gap: .15rem; }
    .cb-lbl { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-monto { color: var(--action); font-size: 1.05rem; font-family: var(--font-mono); }
    .cb-f { display: flex; flex-direction: column; gap: .3rem; }
    .cb-f > span { font-size: var(--fs-micro, .72rem); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .cb-pick { display: flex; gap: .5rem; flex-wrap: wrap; }
    .cb-pickbtn { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); font-size: .85rem; color: var(--text-main); cursor: pointer; background: var(--card-bg); transition: border-color .15s, color .15s; }
    .cb-pickbtn:hover { border-color: var(--action); color: var(--action); }
    .cb-pickbtn i { font-size: .95rem; }
    .cb-filepick { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-ocr-actions { display: flex; align-items: center; gap: .7rem; flex-wrap: wrap; }
    .cb-hint { font-size: .74rem; color: var(--text-muted); }
    .cb-proc { font-size: .8rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .4rem; }
    .cb-stored { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-auto { font-style: normal; font-size: .68rem; color: var(--text-muted); text-transform: none; letter-spacing: 0; opacity: .8; }
    .cb-fields-head { font-size: .8rem; font-weight: 600; color: var(--text-main); margin-top: .3rem; }
    /* Lectura del modelo: se ve como dato leído, no como campos deshabilitados. Un input
       gris dice "ahorita no se puede"; lo que hay que decir es "esto no se toca". */
    .cb-read { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
      gap: var(--sp-3); margin: var(--sp-2) 0 0; padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-ground); }
    .cb-read > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cb-read-wide { grid-column: 1 / -1; }
    .cb-read dt { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cb-read dd { margin: 0; font-size: var(--fs-sm); color: var(--fg-1);
      overflow: hidden; text-overflow: ellipsis; }
    .cb-read .cb-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cb-read-out { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.45; }
    .cb-linkbtn { padding: 0; border: 0; background: none; font: inherit; color: var(--action);
      cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .cb-linkbtn:hover { color: var(--action-hover); }
    .cb-linkbtn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .cb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; border-top: 1px solid var(--border-color); padding-top: .8rem; }
    .cb-err { color: var(--bad-fg); font-size: .82rem; }
    .w-full { width: 100%; }
    .cb-foliolink { border: none; background: transparent; color: var(--action); cursor: pointer; padding: 0; font-family: var(--font-mono); font-size: .85em; }
    /* El folio de oficinas es contexto, no la identidad de la fila: se lee en segundo plano. */
    .cb-gem { display: block; font-style: normal; font-size: .68rem; color: var(--text-muted); font-family: var(--font-mono); }
    .cb-foliolink:hover { text-decoration: underline; }
    .cb-detail-loading { padding: 2rem; text-align: center; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: .5rem; }

    /* ── RE.22.2 desglose en línea ────────────────────────────────────────
       La fila abierta se ancla con un borde izquierdo: el desglose queda visualmente colgado de
       ella y no flotando entre dos recepciones. Sin zebra (DESIGN Operations). */
    .cb-caret {
      border: none; background: transparent; color: var(--text-faint); cursor: pointer;
      padding: 0 var(--sp-1) 0 0; font-size: var(--fs-micro); vertical-align: middle;
      border-radius: var(--r-sm);
    }
    .cb-caret:hover { color: var(--text-main); }
    .cb-caret:active { color: var(--action); }
    .cb-caret:focus-visible { outline: var(--focus-ring); outline-offset: 1px; }
    /* El caret es el objetivo táctil más chico de la fila: las celdas ya crecen solas por los
       tokens de altura, el botón no. En touch tiene que llegar al mínimo (Fitts). */
    @media (pointer: coarse) {
      .cb-caret { min-width: var(--tap-min); min-height: var(--tap-min); }
    }
    /* Datos densos: elevación por BORDE o sombra, nunca las dos. La fila abierta se ancla con
       la barra de acento a la izquierda + el fondo de selección tokenizado. */
    .cb-row-open > td { background: var(--table-row-selected-bg); }
    .cb-row-open > td:first-child { box-shadow: inset 2px 0 0 var(--action); }
    .cb-exp > td { padding: var(--sp-2) var(--sp-3) var(--sp-3) var(--sp-6); background: var(--surface-ground); }
    .cb-exp-nota { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
    .cb-exp-nota b { color: var(--text-main); }
    .cb-exp-retry {
      background: none; border: 0; padding: 0; font: inherit; cursor: pointer;
      color: var(--action); text-decoration: underline;
    }
    .cb-exp-retry:focus-visible { outline: var(--focus-ring); outline-offset: 2px; }
    /* Lo único que la base compartida no cubre: el nombre del producto puede envolver, y la
       tabla anidada scrollea sola para no empujar la página en móvil. */
    .cb-exp-scroll { overflow-x: auto; }
    .cb-exp .surf-table--plain > tbody > tr > td:nth-child(2) { white-space: normal; min-width: 12rem; }

    /* ── Detalle: veredicto + tres cifras ────────────────────────────────
       Jerarquia explicita en tres niveles y por TIPO+CONTRASTE, no por color
       (regla Q.5): primario = el veredicto y las tres cifras; secundario = las
       etiquetas y la ficha; terciario = el pie de cada cifra. El color solo
       refuerza el estado, nunca lo porta solo — siempre hay icono y texto. */
    .cb-verdict { display: flex; align-items: flex-start; gap: .6rem; padding: .7rem .9rem;
      border: 1px solid var(--border-color); border-left: 3px solid var(--border-color);
      border-radius: var(--r-md); background: var(--card-bg); }
    .cb-verdict > .pi { font-size: 1rem; margin-top: .1rem; color: var(--text-muted); }
    .cb-verdict.is-ok { border-left-color: var(--ok-fg); }
    .cb-verdict.is-ok > .pi { color: var(--ok-fg); }
    .cb-verdict.is-warn { border-left-color: var(--warn-fg); }
    .cb-verdict.is-warn > .pi { color: var(--warn-fg); }
    .cb-verdict.is-bad { border-left-color: var(--bad-fg); }
    .cb-verdict.is-bad > .pi { color: var(--bad-fg); }
    .cb-verdict-txt { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .cb-verdict-t { margin: 0; font-size: var(--fs-h3); font-weight: 700; color: var(--text-main);
      font-variant-numeric: tabular-nums; }
    .cb-verdict-s { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5;
      font-variant-numeric: tabular-nums; }

    .cb-tri { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: .6rem 0 0;
      border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    /* Separacion por hairline, sin caja por cifra: mismo criterio que MetricStrip. */
    .cb-tri-c + .cb-tri-c { border-left: 1px solid var(--border-color); }
    .cb-tri-c { padding: .6rem .8rem; display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
    .cb-tri-c dt { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em;
      color: var(--text-faint); }
    .cb-tri-c dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); }
    .cb-tri-c p { margin: 0; font-size: var(--fs-micro); color: var(--text-faint); line-height: 1.4; }
    /* La cifra que NO cuadra se marca en el borde, no tiñendo el numero. */
    .cb-tri-c.is-off { box-shadow: inset 0 -2px 0 var(--bad-fg); }
    .cb-tri-c.is-off dd { color: var(--bad-fg); }
    @media (max-width: 46rem) {
      .cb-tri { grid-template-columns: 1fr; }
      .cb-tri-c + .cb-tri-c { border-left: 0; border-top: 1px solid var(--border-color); }
    }

    /* Esqueleto con la forma del contenido (sin salto de layout al llegar los datos). */
    .cb-detail-skel { display: flex; flex-direction: column; gap: .5rem; padding: .2rem 0 1rem; }
    .cb-sk { display: block; border-radius: var(--r-sm); background: var(--surface-ground);
      border: 1px solid var(--border-color); }
    .cb-sk-verdict { height: 3.4rem; }
    .cb-sk-tri { height: 4rem; }
    .cb-sk-head { height: 2.2rem; margin-top: .4rem; }
    .cb-sk-row { height: 1.9rem; border-style: dashed; }
    @media (prefers-reduced-motion: no-preference) {
      .cb-sk { animation: cb-sk-pulse 1.4s ease-in-out infinite; }
      @keyframes cb-sk-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
    }
    .cb-detail-total { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: .7rem; padding-top: .7rem; border-top: 1px solid var(--border-color); font-size: .85rem; }
    .cb-detail-total strong { font-family: var(--font-mono); color: var(--text-main); }
    .cb-detail-total > span:last-child { display: inline-flex; align-items: center; gap: .5rem; }
    /* RE.12 — copia CEDIS (espejo) adjunta a la vista de la canónica */
    .cb-twin { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem; margin: .6rem 0 0; padding: .45rem .7rem; font-size: .8rem; color: var(--text-muted); background: var(--surface-2); border: 1px dashed var(--border-color); border-radius: var(--r-sm, .4rem); }
    .cb-twin .pi-clone, .cb-twin .pi-directions { color: var(--action); }
    .cb-twin-meta { font-variant-numeric: tabular-nums; }
    .cb-twin-folio { color: var(--text-main); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .05rem .35rem; }
    /* columna Remisión clickable */
    .cb-comp-cell { cursor: pointer; }
    .cb-comp-cell:hover { background: var(--surface-hover, rgba(0,0,0,.03)); }
    .cb-eye { color: var(--text-muted); font-size: .8rem; opacity: 0; transition: opacity .15s; }
    .cb-comp-cell:hover .cb-eye { opacity: .8; }
    .cb-comp-empty { display: inline-flex; align-items: center; gap: .35rem; }
    .cb-comp-empty i { font-size: .75rem; opacity: .7; }
    /* preview antes de subir */
    .cb-preview { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); overflow: hidden; background: var(--surface-2); }
    /* Fondo del papel: token, no un negro con alpha. En tema oscuro un #00000008 no existe y
       la hoja quedaba flotando sin marco. */
    .cb-preview img { display: block; width: 100%; max-height: 15rem; object-fit: contain; background: var(--surface-ground); }
    .cb-preview-pdf { display: flex; align-items: center; gap: .7rem; padding: .8rem 1rem; }
    .cb-preview-pdf > i { font-size: 1.8rem; color: var(--bad-fg); }
    .cb-preview-pdf-txt { display: flex; flex-direction: column; gap: .1rem; }
    .cb-preview-pdf-txt strong { font-size: .9rem; color: var(--text-main); }
    .cb-preview-pdf-txt span { font-size: .74rem; color: var(--text-muted); }
    /* multi-archivo: set de 3–4 fotos de la recepción */
    .cb-files { display: flex; flex-direction: column; gap: .5rem; }
    .cb-file-card { display: flex; align-items: center; gap: .7rem; padding: .5rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-2); }
    .cb-file-card.primary { border-color: var(--action); box-shadow: inset 3px 0 0 var(--action); }
    .cb-file-thumb { flex: 0 0 auto; width: 3rem; height: 3rem; border-radius: var(--r-sm, .4rem); overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--surface-ground); }
    .cb-file-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .cb-file-thumb .pi-file-pdf { font-size: 1.4rem; color: var(--bad-fg); }
    .cb-file-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
    .cb-file-name { font-size: .8rem; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-file-controls { display: flex; align-items: center; gap: .5rem; }
    .cb-role { font-size: .76rem; padding: .2rem .4rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--card-bg); color: var(--text-main); max-width: 12rem; }
    .cb-star { border: none; background: transparent; cursor: pointer; color: var(--text-faint); padding: .1rem .2rem; font-size: .95rem; }
    .cb-star.on { color: var(--warn-soft-fg); }
    .cb-file-stat { display: inline-flex; align-items: center; font-size: .85rem; color: var(--text-muted); }
    .cb-file-stat.ok { color: var(--ok-fg); }
    .cb-file-retry { border: none; background: transparent; cursor: pointer; color: var(--bad-fg); padding: .1rem .2rem; }
    .cb-file-x { flex: 0 0 auto; border: none; background: transparent; cursor: pointer; color: var(--text-muted); padding: .2rem .3rem; border-radius: var(--r-sm, .4rem); }
    .cb-file-x:hover { color: var(--bad-fg); background: var(--surface-hover, rgba(0,0,0,.04)); }
    /* foto-primero: enlace de la entrada por OCR / búsqueda manual */
    .cb-link { display: flex; flex-direction: column; gap: .5rem; padding: .7rem .9rem; border: 1px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-2); }
    .cb-link-hint { margin: 0; font-size: .82rem; color: var(--text-muted); display: flex; align-items: center; gap: .4rem; }
    .cb-link-head { font-size: .82rem; font-weight: 600; color: var(--text-main); }
    .cb-link-search { display: flex; gap: .4rem; }
    .cb-link-search input { flex: 1 1 auto; }
    .cb-link-cand { display: flex; align-items: center; gap: .7rem; width: 100%; text-align: left; padding: .45rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--card-bg); cursor: pointer; font-size: .82rem; }
    .cb-link-cand:hover { border-color: var(--action); }
    .cb-link-prov { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-main); }
    .cb-link-monto { font-family: var(--font-mono); color: var(--text-main); }
    .cb-link-has { font-size: .7rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: .05rem .35rem; border-radius: var(--r-sm, .4rem); }
    .cb-missing { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--warn-soft-fg); background: var(--warn-soft-bg); border: 1px solid var(--warn-border); border-radius: var(--r-sm, .4rem); padding: .4rem .6rem; }
    /* RE (#4) — checklist de completitud por fuente (Kepler/Wincaja), packet-aware */
    .cb-checklist { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .6rem .8rem; background: var(--surface-2); display: flex; flex-direction: column; gap: .45rem; }
    .cb-checklist-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; font-size: .8rem; color: var(--text-main); }
    .cb-chk-ok { display: inline-flex; align-items: center; gap: .3rem; color: var(--ok-fg); font-weight: 600; }
    .cb-chk-miss { color: var(--warn-soft-fg); font-weight: 600; }
    .cb-chk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .3rem .9rem; }
    .cb-chk-list li { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--text-muted); }
    .cb-chk-list li.ok { color: var(--text-main); }
    .cb-chk-list li.ok .pi { color: var(--ok-fg); }
    .cb-chk-list li .pi-circle { color: var(--text-faint); }
    /* RE.pkt.1 — cómo se cumplió cada requerido (auto=OCR con página / manual) + evidencia */
    .cb-chk-via { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: var(--ok-fg); background: color-mix(in srgb, var(--ok-fg) 12%, transparent); border-radius: var(--r-sm, .25rem); padding: .05rem .3rem; }
    .cb-chk-via-manual { color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 12%, transparent); }
    .cb-chk-list li.opt { color: var(--text-faint); }
    .cb-chk-list li.opt .pi-minus-circle { color: var(--text-faint); }
    .cb-chk-opt { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: var(--text-muted); background: color-mix(in srgb, var(--text-muted) 10%, transparent); border-radius: var(--r-sm, .25rem); padding: .05rem .3rem; }
    .cb-chk-ev { font-size: .72rem; color: var(--text-faint); font-family: var(--font-mono, ui-monospace, monospace); max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-detected { border-top: 1px dashed var(--border-color); padding-top: .45rem; display: flex; flex-direction: column; gap: .25rem; }
    .cb-detected-h { font-size: .72rem; font-weight: 600; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-detected ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; }
    .cb-detected li { font-size: .78rem; color: var(--text-main); display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
    .cb-detected-pg { font-size: .68rem; color: var(--text-muted); background: var(--surface-raised, var(--card-bg)); border: 1px solid var(--border-color); border-radius: var(--r-sm, .25rem); padding: 0 .3rem; }
    .cb-detected-ev { font-size: .72rem; color: var(--text-faint); font-family: var(--font-mono, ui-monospace, monospace); }
    .cb-chk-hint { margin: 0; font-size: .72rem; color: var(--text-faint); }
    /* wizard foto-primero: paso 1 (orden) → continuar → paso 2 (demás docs) */
    .cb-step-head { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: var(--text-main); line-height: 1.35; }
    .cb-step-n { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 1.4rem; height: 1.4rem; border-radius: 50%; background: var(--action); color: var(--action-ink); font-size: .74rem; font-weight: 700; }
    .cb-cobro-ok { border: 1px solid var(--ok-fg); }
    .cb-role-fixed { display: inline-flex; align-items: center; gap: .3rem; font-size: .78rem; font-weight: 600; color: var(--action); }
    .cb-role-fixed .pi { font-size: .8rem; }
    .cb-addmore { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; padding-top: .1rem; border-radius: var(--r-sm, .4rem); transition: outline-color .15s; }
    .cb-addmore.drag { outline: 2px dashed var(--action); outline-offset: 3px; }
    .cb-addmore-drop { font-size: .74rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .3rem; }
    .cb-addmore-n { font-size: .76rem; color: var(--text-muted); margin-left: auto; }
    /* RE.7 — dropzone de arrastre del PDF (dispara el OCR solo) */
    .cb-drop { display: flex; flex-direction: column; align-items: center; gap: .5rem; padding: 1.6rem 1rem; border: 2px dashed var(--border-color); border-radius: var(--r-md, .5rem); background: var(--surface-2); text-align: center; transition: border-color .15s, background .15s; }
    .cb-drop.drag { border-color: var(--action); background: var(--action-soft-bg, rgba(0,0,0,.03)); }
    .cb-drop-ico { font-size: 2rem; color: var(--bad-fg); }
    .cb-drop-main { font-size: .88rem; color: var(--text-main); }
    .cb-drop-or { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
    .cb-drop-hint { font-size: .74rem; color: var(--text-muted); }
    .cb-drop-opt { border-style: dotted; opacity: .82; }
    .cb-opt-tag { display: inline-block; font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-sm, .3rem); padding: 0 .3rem; margin-right: .35rem; vertical-align: middle; }
    /* OCR por-archivo + duplicados */
    .cb-file-folio { font-size: .72rem; font-family: var(--font-mono); color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); padding: .05rem .3rem; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cb-file-card.dup { border-color: var(--bad-fg); box-shadow: inset 3px 0 0 var(--bad-fg); }
    .cb-file-dup { display: flex; align-items: center; gap: .3rem; margin-top: .25rem; font-size: .74rem; color: var(--bad-fg); }
    .cb-dup { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--bad-fg); background: var(--bad-soft-bg); border: 1px solid var(--bad-border); border-radius: var(--r-sm, .4rem); padding: .4rem .6rem; }
    /* RE.2 — ajustes que explican el descuadre */
    .cb-explains { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .5rem; }
    .cb-explains-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .cb-explains-head > span:first-child { display: inline-flex; align-items: center; gap: .4rem; }
    .cb-explains-sum { font-family: var(--font-mono); color: var(--action); font-weight: 600; }
    .cb-explains-none { font-size: .82rem; margin: 0; display: inline-flex; align-items: center; gap: .4rem; }
    .cb-explains-hint { font-size: .76rem; margin: 0; }
    .cb-explains-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .cb-explains-item { display: flex; align-items: center; gap: .55rem; padding: .4rem .55rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); background: var(--surface-2); font-size: .82rem; }
    .cb-explains-folio { color: var(--text-main); }
    .cb-explains-fecha { font-size: .76rem; white-space: nowrap; }
    .cb-explains-motivo { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-main); }
    .cb-explains-exact { font-size: .72rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .25rem; white-space: nowrap; }
    .cb-explains-heur { font-size: .72rem; color: var(--text-muted); white-space: nowrap; }
    .cb-explains-monto { font-family: var(--font-mono); white-space: nowrap; }
    /* RE.11 — conciliación por línea */
    .cb-recon-load { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); font-size: .82rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: .5rem; }
    .cb-recon { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .6rem; }
    .cb-recon-head { display: flex; align-items: baseline; justify-content: space-between; gap: .8rem; flex-wrap: wrap; }
    .cb-recon-head h4 { margin: 0; font-size: .9rem; font-weight: 700; color: var(--text-main); }
    .cb-recon-kpis { display: inline-flex; gap: .4rem; flex-wrap: wrap; }
    .cb-rk { font-size: .74rem; padding: .1rem .45rem; border-radius: var(--r-sm, .4rem); border: 1px solid var(--border-color); white-space: nowrap; }
    .cb-rk.ok { color: var(--ok-fg); border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); }
    .cb-rk.warn { color: var(--warn-fg); border-color: color-mix(in srgb, var(--warn-fg) 40%, transparent); }
    .cb-rk.bad { color: var(--bad-fg); border-color: color-mix(in srgb, var(--bad-fg) 40%, transparent); }
    .cb-rk.sec { color: var(--text-muted); }
    .cb-qty-bad { color: var(--bad-fg); font-weight: 600; }
    .cb-method { font-size: .76rem; color: var(--text-muted); }
    .cb-method.alias { color: var(--action); font-weight: 600; }
    .cb-learned { font-size: .78rem; color: var(--ok-fg); display: inline-flex; align-items: center; gap: .3rem; }
    .xs { font-size: .7rem; }
    .cb-recon-orphans { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .78rem; padding-top: .3rem; }
    .cb-orphan { padding: .1rem .45rem; border: 1px dashed var(--border-color); border-radius: var(--r-sm, .4rem); color: var(--text-main); }
    /* remisión adjunta en el detalle */
    .cb-view-attachments { margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: .6rem; }
    .cb-view-att-head { font-size: .8rem; font-weight: 600; color: var(--text-main); }
    .cb-view-none { padding: .3rem 0; }
    .cb-view-dep { border: 1px solid var(--border-color); border-radius: var(--r-md, .5rem); padding: .8rem .9rem; display: flex; flex-direction: column; gap: .6rem; }
    .cb-view-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .cb-view-meta { font-size: .74rem; color: var(--text-muted); margin-left: auto; }
    .cb-view-files { display: flex; flex-wrap: wrap; gap: .6rem; }
    .cb-view-filebtn { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, .4rem); color: var(--action); background: var(--card-bg); font-size: .85rem; cursor: pointer; transition: border-color .15s, color .15s; }
    .cb-view-filebtn:hover { border-color: var(--action); }
    .cb-filebtn-name { color: var(--text-muted); font-size: .78rem; }
    .cb-view-ocr { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; font-size: .78rem; color: var(--text-main); }
    .cb-view-ocr em { font-style: normal; color: var(--text-muted); margin-right: .3rem; }
    .cb-view-coment { font-size: .8rem; color: var(--text-muted); font-style: italic; }
    /* RE.8/RE.17.5 — el expediente en dos paneles: contenido/OCR (izq) + documento (der).
       Consulta de CONTENEDOR: el mismo bloque vive en el cajón de ~1060px y, en pantalla
       chica, en el ancho completo — el @media miraba la ventana, que acá no dice nada. */
    .cb-review { container-type: inline-size; display: grid; grid-template-columns: 1fr; gap: 1.1rem; }
    @container (min-width: 62rem) { .cb-review { grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); align-items: start; } }
    .cb-review-main { min-width: 0; }
    /* El visor trae su propio marco: acá sólo el alto y quedar pegado mientras se baja por
       los renglones, que es la comparación que hace el trabajo. */
    .cb-review-doc { min-width: 0; height: 64vh; min-height: 24rem; }
    @container (min-width: 62rem) { .cb-review-doc { position: sticky; top: 0; align-self: start; } }
    .cb-review-acts { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-4);
      padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .cb-view-filebtn.on { border-color: var(--action); color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
  `],
})
export class ComprasEntradasComponent {
  private readonly svc = inject(EntradasService);
  private readonly compras = inject(ComprasService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly grSocket = inject(GoodsReceiptsSocketService);
  private readonly destroyRef = inject(DestroyRef);
  readonly density = inject(TableDensityService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly tabs = ENTRADAS_CONTROL_TABS;
  /** Momento de la última carga — lo lee la píldora de frescura del header. */
  readonly cargadoAt = signal<number | null>(null);
  // RE.10 — órdenes de entrada nuevas detectadas por WS (pill "N nuevas — actualizar").
  readonly newCount = signal(0);

  readonly report = signal<EntradasReport | null>(null);
  readonly rows = computed(() => this.report()?.rows || []);
  readonly frescura = computed(() => this.report()?.frescura || []);
  readonly algunaAtrasada = computed(() => this.frescura().some((f) => f.atrasada));

  /** 'md_03' → '03' · 'wincaja_30' → 'WCJ 30' — la tira tiene que caber en una línea. */
  etiquetaFuente(sb: string): string {
    const s = String(sb || '');
    return s.startsWith('wincaja_') ? `WCJ ${s.slice(8)}` : s.replace(/^md_/, '');
  }
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly actingId = signal<string | null>(null);
  // RE.13.0 — el estado del listado ahora es un tipo cerrado (`EntradasQuery`), no un string
  // cualquiera: un filtro mal escrito era un `where` que nunca aplicaba y nadie notaba.
  readonly estadoSel = signal<Exclude<EntradasQuery['estado'], undefined>>('pendiente');
  // Captura de evidencia (subir/OCR/adjuntar) requiere gestionar entradas.
  readonly canManage = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);
  // Validación restringida: permiso especial COMPRAS_ENTRADAS_VALIDAR (o god-mode admin).
  // GESTIONAR NO alcanza — que no todos puedan validar la evidencia.
  readonly canValidate = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  /**
   * `[RE.20.1]` — **el lente.** Las MISMAS filas contestando dos preguntas distintas:
   *   `proceso` → *¿tengo el papel?* — evidencia, días, gemela, descarte.
   *   `dinero`  → *¿cuánto pagamos?* — factura, ajuste ligado y neto.
   *
   * Era una pantalla aparte (*Compras 360*) con su propio endpoint, su propio detalle y su
   * propia paginación **sobre exactamente la misma entidad**. No era un solape de datos: era la
   * misma fila con dos lentes, y el usuario no tenía cómo saber cuál de las dos abrir. La otra
   * ya traía un lente de "cumplimiento" adentro — la fusión iba a pasar, sólo que del lado
   * equivocado.
   *
   * El lente lo fija la puerta por la que se entra (`/compras/costo-por-compra` abre en dinero)
   * y viaja en la URL, así que un link pegado en un chat llega con el lente que se compartió.
   */
  readonly lente = signal<'proceso' | 'dinero'>('proceso');
  readonly dinero = computed(() => this.lente() === 'dinero');
  readonly lenteOpts = [
    { label: 'El proceso', value: 'proceso' },
    { label: 'El dinero', value: 'dinero' },
  ];
  /** Filtros que sólo existen en el lente del dinero (venían de Compras 360). */
  readonly ajusteSel = signal<'' | 'con' | 'sin' | 'operativo' | 'comercial'>('');
  readonly ajusteOpts = [
    { label: 'Todas', value: '' },
    { label: 'Con ajuste', value: 'con' },
    { label: 'Sin ajuste', value: 'sin' },
    // El orden no es alfabético: primero el que es un problema. Operativo = faltante, mal
    // estado, no solicitado. Comercial = descuento, pronto pago, apoyo de marca.
    { label: 'Sólo ajuste operativo', value: 'operativo' },
    { label: 'Sólo ajuste comercial', value: 'comercial' },
  ];
  readonly ocSel = signal<'' | 'con' | 'sin'>('');
  readonly ocOpts = [
    { label: 'Todas', value: '' },
    { label: 'Con orden de compra', value: 'con' },
    { label: 'Sin orden de compra', value: 'sin' },
  ];

  setLente(v: string): void {
    this.lente.set(v === 'dinero' ? 'dinero' : 'proceso');
    // Los filtros de dinero no aplican en proceso: dejarlos puestos filtraría la lista sin que
    // se vea el control que lo está haciendo.
    if (!this.dinero()) { this.ajusteSel.set(''); this.ocSel.set(''); }
    this.page.set(1); this.syncUrl(); this.load();
  }
  setAjuste(v: string): void { this.ajusteSel.set((v || '') as any); this.page.set(1); this.load(); }
  setOc(v: string): void { this.ocSel.set((v || '') as any); this.page.set(1); this.load(); }

  /** Qué compone el ajuste de esta fila, para el tooltip: el total solo no dice si preocupa. */
  ajusteTip(c: EntradaRow): string {
    const op = Number(c.ajuste_operativo || 0), com = Number(c.ajuste_comercial || 0);
    const partes: string[] = [];
    if (com) partes.push(`${money(com)} negociado (descuento · pronto pago · apoyo)`);
    if (op) partes.push(`${money(op)} operativo (faltante · mal estado · no solicitado)`);
    const n = Number(c.n_ajuste || 0);
    return `${n} ${n === 1 ? 'ajuste ligado' : 'ajustes ligados'}${partes.length ? ' — ' + partes.join(' · ') : ''}`;
  }

  // RE.20.3 — "Descartadas" al final y separada: no es una etapa del proceso, es la salida.
  // Está para TODOS los que ven (no sólo `_VALIDAR`) porque el descarte resta del denominador
  // de cobertura y quien mira el número tiene que poder ver qué se le restó.
  readonly estadoOpts = [{ label: 'Pendientes', value: 'pendiente' }, { label: 'Con remisión', value: 'con_comprobante' }, { label: 'Validadas', value: 'validado' }, { label: 'Todas', value: '' }, { label: 'Descartadas', value: 'descartada' }];

  // ── RE.20.3: descartar / reactivar ────────────────────────────────────────
  readonly verDescartadas = computed(() => this.estadoSel() === 'descartada');
  readonly descartando = signal<string | null>(null);
  readonly showDescartar = signal(false);
  readonly descartarFila = signal<EntradaRow | null>(null);
  readonly descarteMotivo = signal<MotivoDescarte>('traspaso');
  readonly descarteNota = signal('');
  readonly MOTIVOS_DESCARTE = MOTIVOS_DESCARTE;
  motivoDescarteLabel = motivoDescarteLabel;

  clave(c: EntradaRow): string { return `${c.sucursal}/${c.folio}`; }

  /** El descarte completo en una línea, para el tooltip de la fila. */
  descarteTip(c: EntradaRow): string {
    const quien = c.descarte_por ? ` — ${c.descarte_por}` : '';
    const nota = c.descarte_nota ? `: ${c.descarte_nota}` : '';
    return `${motivoDescarteLabel(c.descarte_motivo) || 'Descartada'}${nota}${quien}`;
  }

  openDescartar(c: EntradaRow): void {
    this.descartarFila.set(c);
    // Pre-elige el motivo por lo que dice la fila: un traspaso se reconoce por el código de
    // proveedor (TI*) y una entrada en $0 por el monto. El revisor confirma, no adivina.
    const pre: MotivoDescarte = (c.proveedor_code || '').toUpperCase().startsWith('TI')
      ? 'traspaso'
      : Number(c.monto) === 0 ? 'sin_costo' : 'cancelada_erp';
    this.descarteMotivo.set(pre);
    this.descarteNota.set('');
    this.showDescartar.set(true);
  }

  confirmarDescarte(): void {
    const c = this.descartarFila();
    if (!c) return;
    const motivo = this.descarteMotivo();
    if (motivo === 'otro' && !this.descarteNota().trim()) {
      this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'Con "Otro" hay que escribir por qué.' });
      return;
    }
    this.descartando.set(this.clave(c));
    this.svc.descartar(c.sucursal, c.folio, motivo, this.descarteNota().trim() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.descartando.set(null); this.showDescartar.set(false);
          this.toast.add({ severity: 'success', summary: 'Fuera del proceso', detail: `${c.folio} ya no cuenta como atraso de la sucursal.` });
          this.load();
        },
        error: (e) => {
          this.descartando.set(null);
          this.toast.add({ severity: 'error', summary: 'No se pudo descartar', detail: e?.error?.message || 'Intentá de nuevo.' });
        },
      });
  }

  reactivar(c: EntradaRow): void {
    this.descartando.set(this.clave(c));
    this.svc.reactivar(c.sucursal, c.folio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.descartando.set(null);
          this.toast.add({ severity: 'success', summary: 'De vuelta al proceso', detail: `${c.folio} vuelve a pedir factura.` });
          this.load();
        },
        error: (e) => {
          this.descartando.set(null);
          this.toast.add({ severity: 'error', summary: 'No se pudo reactivar', detail: e?.error?.message || 'Intentá de nuevo.' });
        },
      });
  }
  search = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  // attach dialog
  readonly showAttach = signal(false);
  readonly attachTarget = signal<EntradaRow | null>(null);
  // foto-primero (como Cobranza): sin entrada preseleccionada; se enlaza por OCR de la Aplica Orden Entrada.
  readonly photoFirst = signal(false);
  // Wizard foto-primero: 1 = solo la Aplica Orden Entrada (se lee y enlaza), 2 = demás documentos.
  readonly attachStep = signal<1 | 2>(1);
  readonly matching = signal(false);
  readonly matchCandidates = signal<EntradaRow[] | null>(null); // null = aún no buscado; [] = buscado, sin match
  manualSearch = '';
  readonly ocrLoading = signal(false);
  readonly ocrRun = signal(false);
  readonly attachError = signal<string>('');
  readonly attachFiles = signal<AttachFile[]>([]);
  readonly uploadingAny = computed(() => this.attachFiles().some((f) => f.uploading));
  // La ★ del paso 1 (la que se lee y enlaza). Habilita "Continuar".
  readonly ordenFile = computed(() => this.attachFiles().find((f) => f.role === 'orden_entrada') || null);
  // Set obligatorio de la recepción: Aplica Orden Entrada + Remisión/Factura + Vale (Ticket opcional).
  // RE (#4) — completitud CONSCIENTE DE FUENTE + packet-aware. La fuente (Kepler CEDIS /
  // Wincaja sucursal) define qué documentos exige la recepción; los tipos se detectan por OCR
  // (documents_present) ∪ el rol asignado → si subís TODO en un solo PDF también cumple.
  // El ENFOQUE es la FACTURA del proveedor: es lo único obligatorio (se compara contra
  // lo que ya trae Kepler). La orden de entrada queda OPCIONAL (solo para identificar).
  readonly REQUIRED_BY_SOURCE: Record<'kepler' | 'wincaja', { keys: string[]; label: string; optional?: boolean }[]> = {
    kepler: [
      { keys: ['factura', 'remision'], label: 'Factura' },
      { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
    ],
    wincaja: [
      { keys: ['factura', 'remision'], label: 'Factura' },
      { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
      { keys: ['ticket'], label: 'Ticket', optional: true },
    ],
  };
  private readonly ROLE_TO_TYPE: Record<string, string> = {
    orden_entrada: 'aplica_orden_entrada', remision: 'remision', factura: 'factura',
    vale: 'vale', ticket: 'ticket', orden_recepcion: 'orden_recepcion',
  };
  /** El origen (source_branch) define el set de docs. CEDIS (md_00) y las plazas `wincaja_*`
   *  reciben por WINCAJA (ticket + orden recepción + aplica OE); las sucursales Kepler
   *  (md_01–05) por KEPLER (aplica OE + factura). */
  receptionSource(e: EntradaRow | null): 'kepler' | 'wincaja' {
    const sb = (e?.source_branch || '').toLowerCase();
    return (sb.startsWith('wincaja') || sb === 'md_00') ? 'wincaja' : 'kepler';
  }
  readonly srcKind = computed<'kepler' | 'wincaja'>(() => this.receptionSource(this.attachTarget()));
  /** Tipos de documento cubiertos: rol asignado + lo que el OCR detectó en cada hoja (packet-aware). */
  readonly coveredTypes = computed(() => {
    const s = new Set<string>();
    for (const f of this.attachFiles()) {
      const t = this.ROLE_TO_TYPE[f.role]; if (t) s.add(t);
      for (const d of (f.ocrDocs || [])) s.add(d);
    }
    return s;
  });
  readonly requiredGroups = computed(() => this.REQUIRED_BY_SOURCE[this.srcKind()]);
  // Etiqueta legible por tipo de documento (para el resumen "Detectado en el PDF" y el checklist).
  private readonly DOC_LABEL: Record<string, string> = {
    aplica_orden_entrada: 'Aplica Orden Entrada', factura: 'Factura', remision: 'Remisión',
    ticket: 'Ticket', orden_recepcion: 'Orden de recepción', vale: 'Vale', otro: 'Otra hoja',
  };
  /** RE.pkt.1 — checklist auditable: cada requerido dice CÓMO se cumplió (auto=OCR con página+
   *  evidencia, o manual=rol asignado) para que no sea caja negra. */
  readonly checklist = computed(() => {
    const cov = this.coveredTypes();
    const files = this.attachFiles();
    const ocrByType = new Map<string, DocPresence>();
    for (const f of files) for (const d of (f.ocrDocsDetail || [])) if (!ocrByType.has(d.type)) ocrByType.set(d.type, d);
    const manualTypes = new Set<string>();
    for (const f of files) { const t = this.ROLE_TO_TYPE[f.role]; if (t) manualTypes.add(t); }
    return this.requiredGroups().map((g) => {
      const auto = g.keys.map((k) => ocrByType.get(k)).find((d): d is DocPresence => !!d) || null;
      const manual = g.keys.some((k) => manualTypes.has(k));
      return {
        label: g.label,
        ok: g.keys.some((k) => cov.has(k)),
        optional: !!g.optional,
        via: (auto ? 'auto' : manual ? 'manual' : null) as 'auto' | 'manual' | null,
        page: auto?.page ?? null,
        evidence: auto?.evidence ?? null,
      };
    });
  });
  // Solo los REQUERIDOS faltantes bloquean Guardar; los opcionales (ej. ticket de compra) no.
  readonly missingGroups = computed(() => this.checklist().filter((c) => !c.ok && !c.optional));
  /** RE.pkt.1 — todos los documentos que el OCR detectó en el/los archivo(s), con página+prueba;
   *  dedup por (tipo,página). Es el "recibo" de que un PDF combinado trae todo lo requerido. */
  readonly detectedDocs = computed(() => {
    const seen = new Set<string>();
    const out: { type: string; label: string; page: number | null; evidence: string | null }[] = [];
    for (const f of this.attachFiles()) for (const d of (f.ocrDocsDetail || [])) {
      const key = `${d.type}|${d.page}`;
      if (seen.has(key)) continue; seen.add(key);
      out.push({ type: d.type, label: this.DOC_LABEL[d.type] || d.type, page: d.page, evidence: d.evidence });
    }
    return out.sort((a, b) => (a.page ?? 99) - (b.page ?? 99));
  });
  // Hojas duplicadas (misma imagen/PDF, o folio de remisión ya subido) → bloquean Guardar.
  readonly dupFiles = computed(() => this.attachFiles().filter((f) => f.dup));
  readonly ocrBusy = computed(() => this.attachFiles().some((f) => f.ocrLoading));
  private fileSeq = 0;
  ocrForm: Partial<RemisionOcr> = {};
  // Opciones del <select> de rol POR FUENTE — deben cubrir TODO tipo del checklist
  // (si no, un requerido queda imposible de marcar a mano y Guardar se traba).
  // Wincaja pide ticket + orden_recepcion + aplica_orden_entrada; Kepler, aplica_orden_entrada + factura/remisión.
  private readonly ROLE_OPTS_KEPLER = [
    { label: 'Aplica orden entrada', value: 'orden_entrada' },
    { label: 'Factura', value: 'factura' },
    { label: 'Otra evidencia', value: 'evidencia' },
  ];
  private readonly ROLE_OPTS_WINCAJA = [
    { label: 'Ticket de compra', value: 'ticket' },
    { label: 'Orden de recepción', value: 'orden_recepcion' },
    { label: 'Aplica orden entrada', value: 'orden_entrada' },
    { label: 'Remisión/Factura', value: 'remision' },
    { label: 'Otra evidencia', value: 'evidencia' },
  ];
  readonly roleOpts = computed(() => this.srcKind() === 'wincaja' ? this.ROLE_OPTS_WINCAJA : this.ROLE_OPTS_KEPLER);

  // reject dialog
  readonly showReject = signal(false);
  readonly rejectTarget = signal<EntradaRow | null>(null);
  rejectMotivo = '';

  // ── `[RE.22.2]` desglose en línea (clic en la fila) ──
  /** Acordeón: una sola fila abierta. Clave = sucursal/folio. */
  readonly filaAbierta = signal<string | null>(null);
  /**
   * Se guarda el `EntradaDetail` completo y no sólo `lineas` para poder usar `receiptVerdict`:
   * su `lineasMeta` ya explica bien por qué Σ renglones ≠ total del documento (los renglones son
   * el SUBTOTAL y `c16` va con impuestos, y en dulcería no es sólo IVA — hay IEPS). Escribir acá
   * una comparación propia era repetir peor lo que ese código ya afina.
   */
  readonly filaDetalle = signal<EntradaDetail | null>(null);
  readonly filaLoading = signal(false);
  readonly filaError = signal(false);
  /** Caché por clave: reabrir no vuelve a pedir. `null` = se pidió y falló. */
  private readonly filaCache = new Map<string, EntradaDetail | null>();

  claveFila(c: EntradaRow): string { return c.sucursal + '/' + c.folio; }

  /**
   * Clic en cualquier parte de la fila. Se ignora si salió de un control: la fila está llena de
   * botones (adjuntar, validar, rechazar, descartar, el folio, las fichas de proveedor/OC) y sin
   * este corte cada uno de ellos abriría además el desglose.
   */
  filaClick(c: EntradaRow, ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (t?.closest('button, a, input, .cb-comp-cell, .p-checkbox')) return;
    this.toggleFila(c);
  }

  toggleFila(c: EntradaRow): void {
    const clave = this.claveFila(c);
    if (this.filaAbierta() === clave) { this.filaAbierta.set(null); return; }
    this.abrirFila(c, clave);
  }

  /** Reintento: hay que OLVIDAR el fallo cacheado o se repite la misma respuesta. */
  reintentarFila(c: EntradaRow): void {
    this.filaCache.delete(this.claveFila(c));
    this.abrirFila(c, this.claveFila(c));
  }

  /**
   * Reusa `detail()` en vez de un endpoint nuevo: ya devuelve `lineas` y es la misma lectura que
   * hace el expediente. La respuesta se descarta si mientras viajaba se abrió otra fila — sin ese
   * corte se pintarían los renglones de una recepción bajo otra, que se ve correcto y no lo es.
   */
  private abrirFila(c: EntradaRow, clave: string): void {
    this.filaAbierta.set(clave);
    this.filaError.set(false);
    if (this.filaCache.has(clave)) {
      const hit = this.filaCache.get(clave) ?? null;
      this.filaDetalle.set(hit); this.filaError.set(hit === null); this.filaLoading.set(false);
      return;
    }
    this.filaDetalle.set(null);
    this.filaLoading.set(true);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.filaCache.set(clave, d);
        if (this.filaAbierta() !== clave) return;
        this.filaDetalle.set(d); this.filaLoading.set(false);
      },
      error: () => {
        this.filaCache.set(clave, null);
        if (this.filaAbierta() !== clave) return;
        this.filaLoading.set(false); this.filaError.set(true);
      },
    });
  }

  /** Cómo se compone el total, con las palabras que ya afinó `receiptVerdict` (IVA/IEPS incluidos). */
  filaLineasMeta(d: EntradaDetail): string { return receiptVerdict(d).lineasMeta; }

  // detail dialog (auditoría por línea + remisión adjunta)
  /** Ficha abierta en el panel lateral (`null` = cerrado). Hace clickeable la vista entera. */
  readonly inspect = signal<string | null>(null);

  refProv(code: string | null): string { return entityRef('prov', code); }
  refEnt(sucursal: string, folio: string): string { return entityRef('ent', sucursal, 'XA2001', folio); }
  refLin(sucursal: string, folio: string, linea: string): string { return entityRef('lin', sucursal, folio, linea); }
  refSku(sku: string): string { return entityRef('sku', sku); }
  refAdj(a: AdjustmentForEntradaRow): string { return entityRef('adj', a.doctype, a.sucursal, a.folio); }
  refOc(sucursal: string, folio: string): string { return entityRef('pdoc', 'XA3501', sucursal, folio); }
  refVale(sucursal: string, folio: string): string { return entityRef('pdoc', 'XA3701', sucursal, folio); }

  readonly showDetail = signal(false);
  readonly detailLoading = signal(false);
  readonly detailData = signal<EntradaDetail | null>(null);
  readonly detailTarget = signal<EntradaRow | null>(null);

  // RE.11 — conciliación por línea (remisión ↔ Kepler ↔ SKU resuelto).
  readonly recon = signal<ReconcileResult | null>(null);
  readonly reconLoading = signal(false);
  readonly reconConfirming = signal<number | null>(null); // idx del renglón que se está aprendiendo

  /**
   * `[RE.17.5]` — las hojas del expediente para el visor compartido. Reemplaza a `selectedDoc`
   * (que resolvía el sanitizado a mano) y al diálogo de imagen que se abría ENCIMA del detalle:
   * el visor ya trae pestañas de hoja y pantalla completa.
   */
  readonly hojas = computed<DocViewerFile[]>(() =>
    (this.detailData()?.deposits || []).flatMap((dep) =>
      (dep.files || []).map((f) => ({ url: f.url, name: f.name, role: f.role, kind: f.kind }))));
  readonly hojaIdx = signal(0);
  /** La lista de hojas es plana; el botón de cada archivo apunta a su posición en ella. */
  indiceHoja(f: ProofFile): number { return this.hojas().findIndex((h) => h.url === f.url); }
  verHoja(f: ProofFile): void { const i = this.indiceHoja(f); if (i >= 0) this.hojaIdx.set(i); }

  /** Subtítulo del cajón: la entrada y el proveedor, que es como se la nombra. */
  detailSubtitulo(): string {
    const d = this.detailData(); const t = this.detailTarget();
    const suc = d?.entrada.sucursal ?? t?.sucursal ?? '';
    const folio = d?.entrada.folio ?? t?.folio ?? '';
    const prov = d?.entrada.proveedor_nombre ?? t?.proveedor_nombre ?? '';
    return [`${suc}/${folio}`, prov].filter(Boolean).join(' · ');
  }

  // RE.2 — ajustes (X-D-40/55) que explican el descuadre de esta entrada
  readonly explains = signal<AdjustmentForEntradaRow[]>([]);
  readonly explainsLoading = signal(false);
  readonly explainsTotal = signal(0);

  constructor() {
    // RE.17.5 — deep-link desde el Centro de control ("ver todo" de una sucursal). Se lee ANTES
    // de la primera carga, o el primer viaje sale sin el filtro que el link promete.
    const qp = this.route.snapshot.queryParamMap;
    const suc = qp.get('suc');
    if (suc) this.sucursalSel.set(suc);
    // RE.20.1 — el lente lo fija la puerta. `data.lente` viene de la ruta (Costo por compra
    // abre en dinero); `?lente=` lo pisa, para que un link pegado en un chat llegue con el que
    // se compartió. Antes de la primera carga: si no, el primer viaje va con el lente que no es
    // y la tabla parpadea de un juego de columnas al otro.
    const deRuta = this.route.snapshot.data?.['lente'];
    const deUrl = qp.get('lente');
    if (deUrl === 'dinero' || deUrl === 'proceso') this.lente.set(deUrl);
    else if (deRuta === 'dinero') this.lente.set('dinero');
    const est = qp.get('estado');
    if (est && this.estadoOpts.some((o) => o.value === est)) this.estadoSel.set(est as any);
    this.load();
    // RE.10 — WS near-real-time: el watcher del backend avisa cuando llegan órdenes nuevas.
    this.grSocket.connect();
    this.grSocket.newReceipts$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      this.newCount.update((c) => c + e.count);
      const first = e.sample?.[0];
      this.toast.add({ severity: 'info', summary: `${e.count} orden(es) de entrada nueva(s)`, detail: first ? (first.proveedor || `${first.sucursal}/${first.folio}`) : 'Actualizá para verlas' });
    });
    this.destroyRef.onDestroy(() => this.grSocket.disconnect());
  }

  /**
   * Aplica las nuevas: recarga la lista y limpia el contador del pill.
   *
   * `[RE.19]` — **vuelve a la página 1**. El pill lo dispara el watcher del ERP: las órdenes
   * que anuncia son las más nuevas, y con el orden por reciente entran arriba. Recargar sin
   * volver al principio dejaba al usuario en la página 4 mirando lo de la semana pasada
   * después de haber hecho clic en "3 nuevas".
   */
  applyNew(): void { this.newCount.set(0); this.page.set(1); this.load(); }

  kpiItems(r: EntradasReport): MetricStripItem[] {
    return [
      { label: 'Entradas', value: r.kpis.entradas },
      { label: 'Con remisión', value: r.kpis.con_comprobante, tone: 'ok' },
      { label: 'Validadas', value: r.kpis.validados, tone: 'ok' },
      { label: '$ por comprobar', value: this.moneyShort(r.kpis.monto_pendiente), tone: 'warn' },
    ];
  }

  setEstado(v: string) { this.estadoSel.set((v || '') as Exclude<EntradasQuery['estado'], undefined>); this.page.set(1); this.load(); }
  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { this.page.set(1); this.load(); }, 300); }

  // ── RE.17.5: filtros que la pantalla decía tener y no mandaba ────────────────
  /**
   * `?suc=03` llega desde el "ver todo" del Centro de control y esta pantalla lo **ignoraba**:
   * el link prometía la sucursal filtrada y caías en las primeras 300 de la red entera. Ahora
   * viaja como `warehouse_codes` (el server igual lo intersecta con el alcance).
   */
  readonly sucursalSel = signal<string | null>(null);
  readonly rezago = signal(false);
  readonly page = signal(1);
  readonly pageSize = 100;
  /**
   * `[RE.19]` — **lo más reciente primero**, igual que Pendientes. Esta lista no mandaba `orden`
   * y se comía el default del servidor (antigüedad), así que una pantalla alimentada por el
   * watcher del ERP —que anuncia órdenes NUEVAS— abría mostrando lo más viejo. Con el orden por
   * reciente, lo que el pill anuncia entra arriba.
   *
   * El backend acota las fechas futuras al ordenar (`LEAST(receipt_date, current_date)` + los
   * futuros al final), así que la captura de CEDIS con fecha 29/12/2026 no se queda clavada
   * en el primer renglón para siempre.
   *
   * `[RE.20.2]` — el orden salió del filtro y se fue al **encabezado de la tabla**, que es donde
   * se ordena una lista de 875 filas y donde además alcanza proveedor y monto. El default no
   * cambia: sigue abriendo por lo más reciente.
   */
  readonly sort = signal<SortState<OrdenEntradas>>({ field: 'fecha', dir: 'desc' });
  readonly sortIcon = sortIcon;
  readonly ariaSort = ariaSort;

  /** El orden dicho en palabras, para el contador del pager (ver Captura de facturas). */
  readonly ordenTexto = computed(() => {
    const s = this.sort();
    if (s.field === 'proveedor') return s.dir === 'asc' ? 'por proveedor, A→Z' : 'por proveedor, Z→A';
    if (s.field === 'monto') return s.dir === 'asc' ? 'por monto, del más chico al más grande' : 'por monto, del más grande al más chico';
    return s.dir === 'asc' ? 'de la más vieja a la más reciente' : 'de la más reciente a la más vieja';
  });

  /** `inicial` por columna: en un monto el primer clic útil es lo más grande, en un nombre la A. */
  ordenarPor(field: OrdenEntradas, inicial: SortDir = 'desc'): void {
    this.sort.set(toggleSort(this.sort(), field, inicial));
    this.page.set(1); this.load();
  }

  private readonly alcance = computed(() => this.report()?.alcance?.sucursales ?? null);
  readonly variasSucursales = computed(() => { const a = this.alcance(); return a === null || a.length > 1; });
  /**
   * `[RE.23]` El fallback es `NETWORK_BRANCHES` (9), no `STORE_BRANCHES` (7): con
   * alcance `all` el server no manda lista y el desplegable se armaba con las
   * sucursales Kepler nada más, así que Morelia —que sí entra en la lista, 331
   * recepciones en el carril al día— no se podía aislar. Quien es de Morelia
   * abría 1,493 renglones de la red entera y sus 410 quedaban enterrados.
   */
  readonly sucursalOpts = computed(() => {
    const a = this.alcance() ?? NETWORK_BRANCHES.map((b) => b.code);
    return a.map((c) => ({ label: branchName(c) || c, value: c }));
  });
  suc(code: string): string { return branchName(code) || code; }

  setSucursal(v: string | null) { this.sucursalSel.set(v || null); this.page.set(1); this.syncUrl(); this.load(); }
  setRezago(v: boolean) { this.rezago.set(v); this.page.set(1); this.load(); }
  irPagina(n: number) { this.page.set(Math.max(1, n)); this.load(); }
  desde(): number { const r = this.report(); return !r || r.total === 0 ? 0 : (this.page() - 1) * this.pageSize + 1; }
  hasta(): number { const r = this.report(); return !r ? 0 : Math.min(r.total, this.page() * this.pageSize); }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      // RE.20.1 — el lente viaja en la URL para que el link se pueda pegar. `proceso` es el
      // default, así que se omite y la URL no se ensucia con lo que ya es implícito.
      queryParams: { suc: this.sucursalSel() || null, lente: this.dinero() ? 'dinero' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.loading.set(true);
    this.error.set(null);
    this.svc.list({
      estado: this.estadoSel() || undefined,
      search: this.search || undefined,
      warehouse_codes: this.sucursalSel() ? [this.sucursalSel() as string] : undefined,
      carril: this.rezago() ? 'rezago' : 'al_dia',
      // RE.20.2 — server-paginada: el orden viaja y la lista se recarga. Ordenar las 100 filas
      // de enfrente no ordena las 875.
      ...serverSortParams(this.sort()),
      // RE.20.1 — el lente. En `proceso` el server no paga el join de ajustes.
      lente: this.lente(),
      ajuste: this.dinero() ? (this.ajusteSel() || undefined) : undefined,
      con_oc: this.dinero() ? (this.ocSel() || undefined) : undefined,
      page: this.page(),
      pageSize: this.pageSize,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.cargadoAt.set(Date.now()); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las entradas.'); this.loading.set(false); },
      });
  }

  // ── Descarte de captura (DESIGN §Leyes 8) ────────────────────────────────────
  // Un modal de captura ACTIVA nunca descarta en silencio: ni por el botón Cancelar,
  // ni por la ✕, ni por Escape. La fricción es PROPORCIONAL — si no hay nada
  // capturado, cierra directo (preguntar de gratis también es mal diseño).

  /** Hay trabajo real que se perdería: hojas subidas, OCR corrido, tipos asignados a mano. */
  readonly attachDirty = computed(() => this.attachFiles().length > 0);
  /** Motivo tecleado que se perdería. */
  private rejectDirty(): boolean { return !!this.rejectMotivo.trim(); }

  private askDiscard(detail: string, onDiscard: () => void) {
    this.confirm.confirm({
      header: '¿Descartar la captura?',
      message: detail,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Sí, descartar',
      rejectLabel: 'Seguir capturando',
      acceptButtonStyleClass: 'p-button-danger',
      accept: onDiscard,
    });
  }

  /** Cancelar / ✕ / Escape del diálogo de adjuntar. */
  closeAttach() {
    if (!this.attachDirty()) { this.showAttach.set(false); return; }
    const n = this.attachFiles().length;
    this.askDiscard(
      `Se perderán ${n === 1 ? 'la hoja adjunta' : 'las ' + n + ' hojas adjuntas'} y su lectura de OCR. Los archivos ya subidos no quedan ligados a ninguna entrada.`,
      () => this.showAttach.set(false),
    );
  }

  /** Cancelar / ✕ / Escape del diálogo de rechazo. */
  closeReject() {
    if (!this.rejectDirty()) { this.showReject.set(false); return; }
    this.askDiscard('Se perderá el motivo del rechazo que escribiste.', () => this.showReject.set(false));
  }

  /** PrimeNG no trae un evento cancelable de cierre → interceptamos el cambio de
   *  visibilidad: si el cierre viene de la ✕ o de Escape con captura sucia, lo
   *  revertimos y pedimos confirmación. */
  onAttachVisible(v: boolean) { if (v) this.showAttach.set(true); else if (this.attachDirty()) this.closeAttach(); else this.showAttach.set(false); }
  onRejectVisible(v: boolean) { if (v) this.showReject.set(true); else if (this.rejectDirty()) this.closeReject(); else this.showReject.set(false); }

  openAttach(c: EntradaRow) {
    this.photoFirst.set(false);
    this.attachTarget.set(c);
    this.resetAttach();
    this.attachStep.set(2); // ya hay entrada: directo a los documentos
    this.showAttach.set(true);
  }

  /** Foto-primero: sin entrada; se enlaza por el OCR de la Aplica Orden Entrada (o manual). */
  openAttachPhotoFirst() {
    this.photoFirst.set(true);
    this.attachTarget.set(null);
    this.resetAttach();
    this.attachStep.set(1); // paso 1: solo la Aplica Orden Entrada
    this.showAttach.set(true);
  }

  /** Paso 1 → 2: basta con la entrada IDENTIFICADA (por folio). La orden de entrada es opcional. */
  continuar() { if (this.attachTarget()) this.attachStep.set(2); }
  backToStep1() { this.attachStep.set(1); }

  private resetAttach() {
    this.attachFiles.set([]);
    this.ocrForm = {};
    this.ocrRun.set(false);
    this.ocrLoading.set(false);
    this.matching.set(false);
    this.matchCandidates.set(null);
    this.manualSearch = '';
    this.attachError.set('');
  }

  /** Multi-archivo: acumula todas las hojas elegidas (lo normal son 3–4).
   *  Secuencial: garantiza que la 1ª elegida quede como ★ (Aplica Orden Entrada). */
  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const picked = input.files ? Array.from(input.files) : [];
    input.value = ''; // permite volver a elegir el mismo archivo
    for (const file of picked) await this.addOne(file);
  }

  // RE.7 — arrastrar el PDF y que corra el OCR solo (reusa el mismo pipeline que onFiles).
  readonly dragging = signal(false);
  onDragOver(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); if (!this.dragging()) this.dragging.set(true); }
  onDragLeave(ev: DragEvent) { ev.preventDefault(); ev.stopPropagation(); this.dragging.set(false); }
  async onDrop(ev: DragEvent) {
    ev.preventDefault(); ev.stopPropagation();
    this.dragging.set(false);
    const files = ev.dataTransfer?.files ? Array.from(ev.dataTransfer.files) : [];
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { this.attachError.set('Solo se aceptan archivos PDF — arrastrá un PDF.'); return; }
    const rejected = files.length - pdfs.length;
    if (rejected > 0) this.attachError.set(`Se ignoraron ${rejected} archivo(s) que no son PDF.`);
    for (const f of pdfs) await this.addOne(f); // 1º = ★ Aplica Orden Entrada → OCR + enlace automático
  }

  private async addOne(file: File) {
    if (file.size > 20 * 1024 * 1024) { this.attachError.set(`"${file.name}" supera 20 MB.`); return; }
    this.attachError.set('');
    let dataUri: string;
    try { dataUri = await this.fileToDataUri(file); }
    catch { this.attachError.set(`No se pudo leer "${file.name}".`); return; }
    // Anti-hoja-duplicada (misma sesión): hash del contenido; si ya está en la lista, no la agrega.
    const hash = await this.sha256Hex(dataUri.replace(/^data:[^,]*,/, ''));
    if (hash && this.attachFiles().some((f) => f.sha256 === hash)) {
      this.attachError.set(`"${file.name}" ya está en la lista (misma hoja).`);
      return;
    }
    const kind: 'image' | 'pdf' = dataUri.startsWith('data:application/pdf') ? 'pdf' : 'image';
    const id = ++this.fileSeq;
    // El ENFOQUE es la FACTURA: el 1er archivo default = factura/remisión (★, la que cuadra
    // contra Kepler). La orden de entrada queda como slot opcional posterior. EXCEPCIÓN: el drop
    // del PASO 1 (foto-primero) es específicamente la orden de entrada → rol orden_entrada + auto-enlace.
    const step1Oe = this.photoFirst() && this.attachStep() === 1;
    const roleSeq = this.srcKind() === 'wincaja'
      ? ['remision', 'orden_entrada', 'ticket']
      : ['factura', 'orden_entrada'];
    this.attachFiles.update((l) => {
      const primary = !l.some((f) => f.primary);
      const af: AttachFile = {
        id, name: file.name, dataUri, kind,
        role: step1Oe ? 'orden_entrada' : (roleSeq[l.length] || 'evidencia'),
        uploaded: null, uploading: false, failed: false, primary,
        sha256: hash || undefined, ocrLoading: true,
      };
      return l.concat(af);
    });
    this.uploadOne(id);
    this.runFileOcr(id); // TODAS las hojas se leen con OCR (la ★ además enlaza la entrada)
  }

  /** SHA-256 hex del contenido (para el anti-duplicado del lado cliente). */
  private async sha256Hex(text: string): Promise<string> {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { return ''; } // sin secure context: el dedup por hash lo cubre el server
  }

  /** Suelta el base64 solo cuando la hoja ya se subió Y se leyó (no la ★). Así no se retiene en el teléfono. */
  private maybeDropBase64(id: number) {
    const f = this.attachFiles().find((x) => x.id === id);
    if (f && f.uploaded && f.ocrDone && !f.primary && f.dataUri) this.patch(id, { dataUri: '' });
  }

  /** Imagen → JPEG reducido (lado mayor ≤1920px, ~0.82) como data URI; el PDF se lee
   *  tal cual. Recorta el payload de fotos de cámara (evita 413) y acelera el OCR.
   *  Si la reducción falla, cae a leer el original (el backend acepta hasta 32mb). */
  private async fileToDataUri(file: File): Promise<string> {
    const readRaw = () => new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error || new Error('read'));
      r.readAsDataURL(file);
    });
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) return readRaw();
    try {
      const bmp = await createImageBitmap(file);
      const maxDim = 1920, quality = 0.82;
      const ratio = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * ratio), h = Math.round(bmp.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('sin contexto 2D');
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return canvas.toDataURL('image/jpeg', quality);
    } catch {
      return readRaw();
    }
  }

  private patch(id: number, p: Partial<AttachFile>) {
    this.attachFiles.update((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)));
  }

  private uploadOne(id: number) {
    const af = this.attachFiles().find((f) => f.id === id);
    if (!af) return;
    this.patch(id, { uploading: true, failed: false });
    this.svc.uploadFile(af.dataUri, af.role).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (up) => { this.patch(id, { uploaded: up, uploading: false }); this.maybeDropBase64(id); },
        error: () => this.patch(id, { uploading: false, failed: true }),
      });
  }
  retryUpload(f: AttachFile) { this.uploadOne(f.id); }
  setRole(f: AttachFile, role: string) { this.patch(f.id, { role }); }

  setPrimary(f: AttachFile) {
    this.attachFiles.update((l) => l.map((x) => ({ ...x, primary: x.id === f.id })));
    const cur = this.attachFiles().find((x) => x.id === f.id);
    if (cur?.dataUri) { this.runFileOcr(f.id); }
    else {
      // base64 ya soltado: reusa el OCR por-archivo ya leído para el cuadre/enlace.
      this.ocrForm = { folio: f.ocrFolio ?? null, total: f.ocrTotal ?? null, fecha: f.ocrFecha ?? null, rfc: f.ocrRfc ?? null, ocr_status: f.ocrDone ? 'ok' : 'ilegible' };
      this.ocrRun.set(true); this.afterOcrMatch();
    }
  }

  removeFile(f: AttachFile) {
    this.attachError.set('');
    const wasPrimary = f.primary;
    this.attachFiles.update((l) => l.filter((x) => x.id !== f.id));
    if (wasPrimary) {
      const next = this.attachFiles()[0];
      if (next) this.setPrimary(next);
      else { this.ocrRun.set(false); this.ocrForm = {}; }
    }
  }

  /** OCR de UNA hoja: guarda su folio/total propio + detecta duplicado (misma hoja o folio ya
   *  subido). Si es la ★, además alimenta el cuadre y enlaza la entrada (foto-primero). */
  private runFileOcr(id: number) {
    const f = this.attachFiles().find((x) => x.id === id);
    if (!f) return;
    if (!f.dataUri) { this.patch(id, { ocrLoading: false, ocrDone: true }); return; }
    this.patch(id, { ocrLoading: true });
    if (f.primary) this.ocrLoading.set(true);
    this.svc.ocr(f.dataUri, f.role).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.patch(id, {
            ocrLoading: false, ocrDone: true,
            ocrFolio: r.folio ?? null, ocrTotal: r.total ?? null, ocrSubtotal: r.subtotal ?? null, ocrFecha: r.fecha ?? null, ocrRfc: r.rfc ?? null,
            ocrDocs: (r.documents_present ?? []).map((d) => d.type), ocrDocsDetail: r.documents_present ?? [],
            sha256: r.sha256 || f.sha256, dup: r.duplicate ?? null,
          });
          if (r.duplicate) this.attachError.set(this.dupMsg(f.name, r.duplicate));
          const cur = this.attachFiles().find((x) => x.id === id);
          if (cur?.primary) { this.ocrForm = { ...r }; this.ocrRun.set(true); this.ocrLoading.set(false); this.afterOcrMatch(); }
          this.maybeDropBase64(id);
        },
        error: () => {
          this.patch(id, { ocrLoading: false, ocrDone: true });
          const cur = this.attachFiles().find((x) => x.id === id);
          if (cur?.primary) { this.ocrLoading.set(false); this.ocrForm = { ocr_status: 'ilegible' }; this.ocrRun.set(true); }
        },
      });
  }
  private dupMsg(name: string, d: DuplicateHit): string {
    const where = `entrada ${d.sucursal}/${d.folio}${d.proveedor ? ' · ' + d.proveedor : ''}`;
    return d.reason === 'file' ? `"${name}" ya se había subido (${where}). Quitala.` : `El folio de "${name}" ya se subió (${where}). Quitala.`;
  }
  dupText(f: AttachFile): string {
    const d = f.dup; if (!d) return '';
    return (d.reason === 'file' ? 'Misma hoja ya subida' : 'Folio ya subido') + ` · ${d.sucursal}/${d.folio}`;
  }
  runOcr() { const p = this.attachFiles().find((f) => f.primary); if (p && p.dataUri) this.runFileOcr(p.id); }

  /** Tras leer la Aplica Orden Entrada (★), enlaza la entrada por folio/total (solo foto-primero). */
  private afterOcrMatch() {
    if (!this.photoFirst() || this.attachTarget()) return;
    this.matching.set(true);
    this.svc.matchByOcr({ folio: this.ocrForm.folio || undefined, total: this.ocrForm.total ?? undefined, fecha: this.ocrForm.fecha || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.matching.set(false);
          const e = res.entradas || [];
          if (e.length === 1) { this.attachTarget.set(e[0]); this.matchCandidates.set(null); }
          else this.matchCandidates.set(e); // 0 o varias → el usuario elige/busca
        },
        error: () => { this.matching.set(false); this.matchCandidates.set([]); },
      });
  }
  runManualSearch() {
    const s = (this.manualSearch || '').trim();
    if (!s) return;
    this.matching.set(true);
    this.svc.matchByOcr({ search: s }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => { this.matching.set(false); this.matchCandidates.set(res.entradas || []); },
        error: () => { this.matching.set(false); this.matchCandidates.set([]); },
      });
  }
  pickEntrada(e: EntradaRow) { this.attachTarget.set(e); this.matchCandidates.set(null); }
  unlinkEntrada() { this.attachTarget.set(null); if (this.ocrRun()) this.afterOcrMatch(); else this.matchCandidates.set(null); }

  /** Cuadra si el total O el subtotal de la remisión ≈ el valor de la entrada. */
  matchState(): boolean | null {
    const t = this.attachTarget();
    if (!t) return null;
    const near = (v: number | null | undefined) => v != null && !isNaN(Number(v)) && Math.abs(Number(v) - t.monto) <= 1;
    const total = this.ocrForm.total, sub = this.ocrForm.subtotal;
    if ((total == null || isNaN(Number(total))) && (sub == null || isNaN(Number(sub)))) return null;
    return near(total) || near(sub);
  }
  diff(): number {
    const t = this.attachTarget();
    if (!t) return 0;
    const cands = [this.ocrForm.total, this.ocrForm.subtotal]
      .filter((v) => v != null && !isNaN(Number(v)))
      .map((v) => Math.abs(Number(v) - t.monto));
    return cands.length ? Math.min(...cands) : 0;
  }

  saveAttach() {
    const t = this.attachTarget();
    const files = this.attachFiles();
    if (!t || !files.length) { this.attachError.set('Agregá al menos una foto.'); return; }
    if (this.dupFiles().length) { this.attachError.set('Hay hojas duplicadas (misma imagen o folio ya subido). Quitalas para guardar.'); return; }
    if (this.missingGroups().length) { this.attachError.set('Faltan documentos: ' + this.missingGroups().map((g) => g.label).join(', ') + '.'); return; }
    this.attachError.set('');
    this.saving.set(true);
    // Sube las que falten (o fallaron), conserva las ya almacenadas → UNA evidencia con TODAS las fotos.
    const uploads = files.map((f) => f.uploaded
      ? of({ f, up: f.uploaded })
      : this.svc.uploadFile(f.dataUri, f.role).pipe(map((up) => ({ f, up }))));
    forkJoin(uploads).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (results) => {
        const proofFiles: ProofFile[] = results.map(({ f, up }) => ({
          ...up, role: f.role, name: f.name,
          // Por-archivo: hash (anti-dup) + su OCR propio (cada hoja se lee).
          sha256: f.sha256, ocr_folio: f.ocrFolio ?? null, ocr_total: f.ocrTotal ?? null, ocr_fecha: f.ocrFecha ?? null, ocr_rfc: f.ocrRfc ?? null,
        }));
        // RE.pkt.2 — el CUADRE (monto_match) debe usar el total de la FACTURA/REMISIÓN, sin importar
        // cuál hoja es la ★. Elegimos la hoja fiscal por tipo DETECTADO (o rol). Si la fiscal es la ★,
        // usamos el form (respeta ediciones del capturista); si viene APARTE, usamos su OCR propio.
        // Fallback: el form (PDF combinado, o captura manual sin hoja fiscal distinguible).
        const isFiscal = (f: AttachFile) => (f.ocrDocs || []).some((d) => d === 'factura' || d === 'remision') || f.role === 'factura' || f.role === 'remision';
        const fiscalFile = files.find((f) => f.primary && isFiscal(f)) || files.find(isFiscal) || null;
        // RE.11.0 — los renglones (lines) solo se extraen en el OCR completo del form (ocrForm),
        // no en el OCR por-hoja. Los persistimos siempre que existan para la conciliación por línea.
        const ocrLines = this.ocrForm.lines ?? [];
        const ocr: Partial<RemisionOcr> | undefined =
          fiscalFile && !fiscalFile.primary
            ? { folio: fiscalFile.ocrFolio ?? null, total: fiscalFile.ocrTotal ?? null, subtotal: fiscalFile.ocrSubtotal ?? null, fecha: fiscalFile.ocrFecha ?? null, rfc: fiscalFile.ocrRfc ?? null, ocr_status: 'ok', lines: ocrLines }
            : (this.ocrRun() ? this.ocrForm : undefined);
        this.svc.attach({ sucursal: t.sucursal, folio: t.folio, files: proofFiles, ocr })
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: (res) => { this.saving.set(false); this.resetAttach(); this.showAttach.set(false); this.toast.add({ severity: 'success', summary: `${proofFiles.length} foto(s) adjuntada(s)`, detail: res.monto_match ? 'El total cuadra ✓' : 'Guardado (revisa el total)' }); this.load(); },
            error: (e) => { this.saving.set(false); this.attachError.set(e?.error?.message || 'No se pudo adjuntar.'); },
          });
      },
      error: () => { this.saving.set(false); this.attachError.set('No se pudieron subir algunas fotos. Reintentá.'); },
    });
  }

  doValidate(c: EntradaRow) {
    if (!c.deposit_id || this.actingId()) return;
    this.actingId.set(c.deposit_id);
    this.svc.validate(c.deposit_id).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.actingId.set(null); this.toast.add({ severity: 'success', summary: 'Validada', detail: `Entrada ${c.folio}` }); this.load(); },
        error: () => { this.actingId.set(null); this.toast.add({ severity: 'error', summary: 'Error al validar' }); },
      });
  }

  openReject(c: EntradaRow) { this.rejectTarget.set(c); this.rejectMotivo = ''; this.showReject.set(true); }
  doReject() {
    const c = this.rejectTarget();
    if (!c?.deposit_id) return;
    this.saving.set(true);
    this.svc.reject(c.deposit_id, this.rejectMotivo || undefined).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: () => { this.saving.set(false); this.rejectMotivo = ''; this.showReject.set(false); this.toast.add({ severity: 'info', summary: 'Rechazada', detail: `Entrada ${c.folio}` }); this.load(); }, error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error al rechazar' }); } });
  }

  openDetail(c: EntradaRow) {
    this.detailTarget.set(c);
    this.detailData.set(null);
    this.recon.set(null);
    this.hojaIdx.set(0);
    this.detailLoading.set(true);
    this.showDetail.set(true);
    this.loadExplains(c);
    this.svc.detail(c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => {
          this.detailData.set(d);
          this.detailLoading.set(false);
          // La 1ª hoja se muestra sola: el trabajo es comparar, no hacer clics.
          this.hojaIdx.set(0);
          // RE.11 — si alguna remisión trae renglones OCR, concilia automáticamente por línea.
          const withLines = (d.deposits || []).find((dep) => (dep.ocr_lines || []).length > 0);
          if (withLines) this.runReconcile(withLines.ocr_lines || []);
        },
        error: () => { this.detailLoading.set(false); this.showDetail.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el detalle' }); },
      });
  }

  /** RE.11.2 — concilia los renglones de la remisión contra las líneas Kepler de la entrada. */
  runReconcile(lines: RemisionLine[]) {
    const c = this.detailTarget();
    if (!c || !lines.length) { this.recon.set(null); return; }
    this.reconLoading.set(true);
    this.svc.reconcile(c.sucursal, c.folio, lines).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.recon.set(r); this.reconLoading.set(false); },
        error: () => { this.reconLoading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo conciliar por línea' }); },
      });
  }

  /** RE.11.4 — aprende el match del renglón (descripción del proveedor → SKU interno). */
  confirmMatch(line: ReconciledLine) {
    const r = this.recon();
    if (!r || !r.proveedor_rfc || !line.resolved_sku || !line.remision.descripcion) {
      this.toast.add({ severity: 'warn', summary: 'Falta RFC o SKU para aprender este renglón' });
      return;
    }
    this.reconConfirming.set(line.idx);
    this.svc.confirmLine({
      proveedor_rfc: r.proveedor_rfc, descripcion: line.remision.descripcion, sku: line.resolved_sku,
      nombre_interno: line.resolved_nombre || undefined, unidad_proveedor: line.remision.unidad || undefined,
      box_factor: line.box_factor,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.reconConfirming.set(null);
        this.recon.update((cur) => cur ? { ...cur, lines: cur.lines.map((l) => l.idx === line.idx ? { ...l, alias_hit: true, method: 'alias', score: 1 } : l) } : cur);
        this.toast.add({ severity: 'success', summary: 'Aprendido', detail: `"${line.remision.descripcion}" → ${res.sku} (confianza ${Math.round(res.confianza * 100)}%)` });
      },
      error: (e) => { this.reconConfirming.set(null); this.toast.add({ severity: 'error', summary: 'No se pudo aprender', detail: e?.error?.message }); },
    });
  }

  reconStatusLabel(s: ReconciledLine['status']): string {
    return ({ cuadra: 'Cuadra', difiere_cantidad: 'Difiere cantidad', difiere_precio: 'Difiere precio', revisar: 'Revisar', sin_match: 'Sin match' } as Record<string, string>)[s] || s;
  }
  reconStatusSev(s: ReconciledLine['status']): 'success' | 'warn' | 'danger' | 'secondary' {
    return ({ cuadra: 'success', difiere_cantidad: 'warn', difiere_precio: 'warn', revisar: 'secondary', sin_match: 'danger' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[s] || 'secondary';
  }
  reconMethodLabel(m: ReconciledLine['method']): string {
    return ({ alias: 'Aprendido', barcode: 'Código barras', descripcion: 'Descripción', sin_match: '—' } as Record<string, string>)[m] || m;
  }

  /**
   * RE.2 — busca los ajustes X-D-40/55 (devoluciones / notas de crédito / descuentos)
   * del proveedor que pueden EXPLICAR por qué la factura no cuadra con la entrada.
   * Link exacto por folio de entrada cuando existe; si no, proveedor + ventana ±15d.
   */
  private loadExplains(c: EntradaRow) {
    this.explains.set([]);
    this.explainsTotal.set(0);
    if (!c.proveedor_code && !c.folio) return;
    this.explainsLoading.set(true);
    this.compras.adjustmentsForEntrada({ proveedor_code: c.proveedor_code, entrada_folio: c.folio, date: c.receipt_date, window_days: 15 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.explains.set(r.rows || []); this.explainsTotal.set(r.total_monto || 0); this.explainsLoading.set(false); },
        error: () => { this.explainsLoading.set(false); },
      });
  }
  adjDoctypeLabel(dt: string): string { return dt === 'XD40' ? 'Devolución' : 'Nota de crédito'; }
  adjGrupoLabel(g: AdjustmentGrupo): string { return ({ comercial: 'Descuento/apoyo', operacional: 'Operativo', error: 'Error de captura', sin_clasificar: 'Sin clasificar' } as Record<string, string>)[g] || g; }
  adjGrupoSev(g: AdjustmentGrupo): 'success' | 'warn' | 'danger' | 'secondary' { return ({ comercial: 'success', operacional: 'warn', error: 'danger', sin_clasificar: 'secondary' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[g] || 'secondary'; }

  fromDetailToAttach() { const c = this.detailTarget(); this.showDetail.set(false); if (c) this.openAttach(c); }
  lineasTotal(lineas: EntradaLinea[]): number { return lineasTotal(lineas); }
  lineasDiff(d: EntradaDetail): number { return Math.abs(this.lineasTotal(d.lineas) - (Number(d.entrada.monto) || 0)); }
  lineasCuadra(d: EntradaDetail): boolean { return this.lineasDiff(d) <= ComprasEntradasComponent.EPS; }

  /** Los umbrales viven en `receipt-verdict.ts`: son los mismos que usa la bandeja. */
  private static readonly EPS = EPS;

  plural(n: number, sing: string, plur: string): string { return plural(n, sing, plur); }

  /** El comprobante que manda para el cuadre: el validado si lo hay, si no el más reciente. */
  private depForCuadre(d: EntradaDetail) { return depForCuadre(d); }

  /**
   * La respuesta de esta pantalla, en llano. La lógica vive en `receipt-verdict.ts` porque la
   * **bandeja de revisión** (RE.13.2) muestra el mismo veredicto: dos copias garantizaban que
   * las dos pantallas terminaran diciendo cosas distintas del mismo expediente.
   */
  cuadre(d: EntradaDetail) { return receiptVerdict(d, this.explains().length > 0); }

  /** El archivo ELEGIDO (data URI, aún sin subir) es imagen / PDF. */
  /** Un archivo YA subido (Cloudinary) es imagen (por kind o extensión) — si no, se trata como PDF/archivo. */
  isImageUrl(f: ProofFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  // `gemela` (RE.14) no es un descuadre con el proveedor: la factura cuadra con la captura de
  // oficinas y la diferencia es contra la de la sucursal. Etiquetarla como "Descuadre" mandaría
  // a reclamarle a quien no se equivocó.
  discLabel(k: string): string { return ({ iva: 'Diferencia = IVA', typo: 'Posible error de captura', otro: 'Descuadre', cuadra: 'Cuadra', gemela: 'Cuadra con oficinas' } as Record<string, string>)[k] || k; }
  discSev(k: string): 'success' | 'warn' | 'danger' | 'secondary' { return ({ cuadra: 'success', iva: 'secondary', typo: 'danger', otro: 'warn', gemela: 'secondary' } as Record<string, 'success' | 'warn' | 'danger' | 'secondary'>)[k] || 'secondary'; }
  depLabel(s: string | null): string { return ({ recibido: 'Recibido', validado: 'Validado', rechazado: 'Rechazado' } as Record<string, string>)[s || ''] || '—'; }
  depSev(s: string | null): 'success' | 'warn' | 'danger' | 'secondary' { return ({ recibido: 'warn', validado: 'success', rechazado: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s || ''] || 'secondary'; }
  /**
   * Dinero CON centavos, del formateador compartido.
   *
   * Antes esta pantalla tenía el suyo con `maximumFractionDigits: 0`. En una vista de
   * cuadre eso es grave: la tolerancia es de $1, así que una diferencia de $0.40 se
   * pintaba como dos cifras idénticas al lado de un tag que dice "No cuadra". El
   * semáforo mira centavos; la pantalla los escondía.
   */
  readonly money = money;
  /** Redondeado a pesos: SOLO para KPIs de cabecera, donde el centavo es ruido. */
  readonly moneyShort = moneyShort;
}
