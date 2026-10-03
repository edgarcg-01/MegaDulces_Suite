import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { Subscription } from 'rxjs';
import {
  CLASES_OC, CLASE_OC_ACCION, CLASE_OC_LABEL, ClaseOc, clasificarOc,
  OC_NOTA_MAX, OC_SEGUIMIENTO_ESTATUS, OC_SEGUIMIENTO_LABEL, OC_SIN_REVISAR, OcSeguimientoEstatus,
  notaObligatoria, validarSeguimiento,
} from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasService, OpenOcRow, OpenOcResponse } from '../compras.service';
import { generarOcPdf, OcDetalle } from '../oc-kepler-pdf';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * `[RA-PRO.69]` La fila con su clase ya resuelta.
 *
 * `clasificarOc()` es una funcion, y una columna ordenable necesita un CAMPO: `pSortableColumn`
 * ordena por propiedad del objeto, no por el resultado de llamar algo. Por eso la clase se
 * materializa al armar la fila en vez de calcularse en el template.
 */
type FilaOc = OpenOcRow & { _clase: ClaseOc; _claseLabel: string };

/**
 * RA-PRO.45 — Órdenes de compra abiertas en Kepler (X-A-35 sin X-A-40), por antigüedad.
 *
 * La vista INVERSA de la columna "En camino" del pedido. En Kepler la OC se captura al recibir
 * (81% del CEDIS cierra el mismo día), así que una que sigue abierta no es pipeline: es un
 * documento estancado que hay que cerrar o cancelar. El motor ya dejó de creerles —esta pantalla
 * es para que alguien las barra del ERP—.
 *
 * Superficie Operations (PrimeNG denso, quiet-luxury).
 */
@Component({
  selector: 'app-compras-oc-abiertas',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, DialogModule, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in oa-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes abiertas en Kepler</h1>
          <p class="surf-page-sub">Órdenes de compra sin orden de entrada. En Kepler la orden se captura al recibir, así que una que lleva semanas abierta casi nunca se surte: hay que cerrarla o cancelarla.</p>
        </div>
      </header>

      <!-- [RA-PRO.70] Aca habia una tira de CINCO mosaicos. Medido sobre esta misma pantalla:
             · "Ordenes abiertas" repetia un numero que ya estaba en otros CINCO lugares
               (el contador, los dos chips "Todas", el aviso de truncado y el estado vacio).
             · "Valor en papel" y "Se espera que llegue" los da ahora el pie de la tabla, que
               ademas sigue al filtro y queda fijo al hacer scroll: el mosaico decia otra cosa.
             · "Para barrer (+30 d)" publicaba un umbral REFUTADO: la mediana real de entrega
               es 0 dias y el p90 son 4 (5,784 ordenes ya recibidas). Marcar a los 30 avisa
               cuando ya solo llega el 19.7%. No se reemplaza por un numero nuevo hasta tener
               el ritmo por proveedor (bloqueado por mv_supplier_fill_rate).
           Queda lo unico que no vive en ningun otro lado y es la razon de la pantalla, en una
           linea sobria: DESIGN.md SS518 pide cards solo para KPIs minimal, y un mosaico que
           repite no es minimal, es ruido con borde. -->
      <p class="oa-lede">
        @if (clasifOk()) {
          @if (muertas()) {
            De las {{ total() | number }} abiertas,
            <b class="oa-bad">{{ muertas() | number }} por {{ money(valorMuertas()) }} no van a salir solas</b>
            <span class="oa-muted">— el ERP ya las cerró o su vale está cancelado. Hay que ir a Kepler.</span>
          } @else {
            Las {{ total() | number }} órdenes abiertas siguen vivas:
            <span class="oa-muted">ninguna quedó de papel.</span>
          }
        } @else {
          {{ total() | number }} órdenes abiertas.
          <span class="oa-muted" title="La vista analytics.erp_purchase_orders todavía no trae estado_cadena.">Cuáles ya no van a moverse: <b>sin medir</b> (falta la migración de la cadena).</span>
        }
      </p>

      <div class="oa-filters">
        <p-select [options]="edadOpts" [(ngModel)]="fMinDays" (onChange)="reload(); syncUrl()"
                  optionLabel="label" optionValue="value" styleClass="oa-sel" appendTo="body"></p-select>
        <p-select [options]="sucOpts()" [(ngModel)]="fSuc" (onChange)="reload(); syncUrl()"
                  optionLabel="label" optionValue="value" placeholder="Todas las sucursales"
                  [showClear]="true" styleClass="oa-sel" appendTo="body"></p-select>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
        <!-- [RA-PRO.69] Con un chip puesto decia "296 de 296" mientras la tabla mostraba 10. -->
        <span class="oa-count">
          @if (filtrado()) {
            {{ filas().length | number }} filtradas de {{ mostradas() | number }}
          } @else {
            {{ mostradas() | number }} de {{ total() | number }}@if (totalMinimo()) {+}
          }
        </span>
      </div>

      <!-- [RA-PRO.67] Por qué sigue abierta. Cada clase la resuelve gente distinta, así que el
           chip lleva la acción en el title: el nombre solo no dice a quién le toca. -->
      @if (clasifOk()) {
        <div class="oa-seg-bar" role="group" aria-label="Filtrar por motivo">
          <span class="oa-seg-lbl">Por qué sigue abierta</span>
          <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fClase() === ''"
                  [attr.aria-pressed]="fClase() === ''" (click)="fClase.set(''); syncUrl()">
            Todas <b>{{ total() | number }}</b>
          </button>
          @for (c of claseOpts; track c.value) {
            <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fClase() === c.value"
                    [attr.aria-pressed]="fClase() === c.value" (click)="fClase.set(c.value); syncUrl()"
                    [attr.data-clase]="c.value" [title]="c.accion">
              {{ c.label }} <b>{{ (porClase()[c.value] ?? 0) | number }}</b>
            </button>
          }
        </div>
      }

      <!-- [RA-PRO.62] Conteo por estatus de seguimiento (sobre TODAS las órdenes) que además filtra la tabla. -->
      <div class="oa-seg-bar" role="group" aria-label="Filtrar por estatus de seguimiento">
        <span class="oa-seg-lbl">Seguimiento</span>
        <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fSeg() === ''" [attr.aria-pressed]="fSeg() === ''" (click)="fSeg.set(''); syncUrl()">
          Todas <b>{{ total() | number }}</b>
        </button>
        @for (s of segOpts; track s.value) {
          <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fSeg() === s.value" [attr.aria-pressed]="fSeg() === s.value" (click)="fSeg.set(s.value); syncUrl()"
                  [attr.data-seg]="s.value">
            {{ s.label }} <b>{{ (porSeguimiento()[s.value] ?? 0) | number }}</b>
          </button>
        }
      </div>

      <!-- [RA-PRO.60] El recorte se DECLARA: antes la tabla cortaba en 500 y los indicadores se
           calculaban sobre esos 500, sin decir nada. Ahora los indicadores cuentan todas. -->
      @if (truncado()) {
        <p class="oa-aviso" role="status">
          <span class="pi pi-info-circle" aria-hidden="true"></span>
          La tabla muestra las {{ mostradas() | number }} órdenes más antiguas de {{ total() | number }}@if (totalMinimo()) {+}.
          Los indicadores de arriba cuentan todas. Filtra por sucursal o antigüedad para ver el resto.
          @if (fSeg()) { El filtro de seguimiento sólo recorre las órdenes mostradas: puede haber más con ese estatus fuera de la tabla (el número del botón sí cuenta todas). }
        </p>
      }
      @if (pdfError()) {
        <p class="oa-aviso oa-aviso-err" role="alert">
          <span class="pi pi-exclamation-triangle" aria-hidden="true"></span> {{ pdfError() }}
        </p>
      }

      <!-- [RA-PRO.69] DESIGN_TABLES SS6: las columnas son CAMPOS de un registro (no un pivote),
           asi que en estrecho la tabla APILA. El .dt-scope del contenedor no es decorativo:
           sin el, el CSS de apilado es inerte y la pantalla se rompe con el build en verde.
           sortField/sortOrder arrancan en el MISMO orden que manda el servidor (dias DESC). -->
      <div class="dt-scope">
      <p-table [value]="filas()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               sortField="dias" [sortOrder]="-1"
               [tableStyle]="{ 'min-width': '68rem' }"
               styleClass="p-datatable-sm oa-table dt-stack"
               [attr.aria-label]="'Órdenes de compra abiertas en Kepler'">
        <ng-template #header>
          <tr>
            <th scope="col" pFrozenColumn style="min-width:6.5rem" pSortableColumn="folio">Folio <p-sorticon field="folio" /></th>
            <th scope="col" pSortableColumn="almacen">Suc. <p-sorticon field="almacen" /></th>
            <th scope="col" pSortableColumn="proveedor">Proveedor <p-sorticon field="proveedor" /></th>
            <th scope="col" pSortableColumn="fecha_oc">Fecha <p-sorticon field="fecha_oc" /></th>
            <th scope="col" class="comm-num" pSortableColumn="dias">Abierta <p-sorticon field="dias" /></th>
            <th scope="col" class="surf-def" pSortableColumn="estatus" title="Estatus del documento en Kepler">Kepler <p-sorticon field="estatus" /></th>
            <th scope="col" class="surf-def" pSortableColumn="_claseLabel" title="Lo que la cadena de documentos demuestra: si hay vale, y si sigue vivo">Motivo <p-sorticon field="_claseLabel" /></th>
            <th scope="col" class="comm-num" pSortableColumn="lineas">Líneas <p-sorticon field="lineas" /></th>
            <th scope="col" class="comm-num" pSortableColumn="valor">Valor <p-sorticon field="valor" /></th>
            <th scope="col" class="comm-num surf-def" pSortableColumn="prob" title="% histórico de que una orden de esa edad termine llegando (curva de supervivencia)">Llega <p-sorticon field="prob" /></th>
            <th scope="col" class="surf-def" title="Registro de Compras: por qué sigue abierta. No cambia nada en Kepler.">Seguimiento</th>
            <th scope="col" class="surf-def" title="PDF de la orden: para el proveedor (sin notas internas) o interno (con el seguimiento)">PDF</th>
          </tr>
        </ng-template>
        <!-- [RA-PRO.69] DESIGN_TABLES 2.3/4.5: la fila abre el detalle en side-peek. Operable por
             teclado (Enter/Espacio) y con foco visible, no sólo por mouse (SS5.5/5.6). -->
        <ng-template #body let-o>
          <tr class="comm-row-clickable" tabindex="0" role="button"
              [attr.aria-label]="'Ver el detalle de la orden ' + o.almacen + '-' + o.folio"
              (click)="abrirDetalle(o)"
              (keydown.enter)="abrirDetalle(o)" (keydown.space)="$event.preventDefault(); abrirDetalle(o)">
            <td pFrozenColumn class="dt-id" role="cell"><span class="comm-code">{{ o.folio }}</span></td>
            <td class="oa-mono oa-muted" role="cell" data-label="Sucursal">{{ o.almacen }}</td>
            <td role="cell" data-label="Proveedor">{{ o.proveedor || '—' }}</td>
            <td class="oa-muted" role="cell" data-label="Fecha">{{ o.fecha_oc | date:'dd/MM/yy' }}</td>
            <td class="comm-num dt-num" role="cell" data-label="Abierta"><span [class]="edadCls(o)">{{ o.dias }} d</span></td>
            <td role="cell" data-label="Kepler"><p-tag [value]="estLabel(o.estatus)" [severity]="estSev(o.estatus)" styleClass="oa-tag"></p-tag></td>
            <td role="cell" data-label="Motivo">
              @if (clasifOk()) {
                <span class="oa-clase" [attr.data-clase]="o._clase" [title]="claseAccion(o._clase)">{{ o._claseLabel }}</span>
              } @else { <span class="oa-muted">—</span> }
            </td>
            <td class="comm-num dt-num oa-muted" role="cell" data-label="Líneas">{{ o.lineas | number }}</td>
            <td class="comm-num dt-num is-strong" role="cell" data-label="Valor">{{ money(o.valor) }}</td>
            <td class="comm-num dt-num" role="cell" data-label="Llega">
              @if (o.prob === null) { <span class="oa-muted">—</span> }
              @else { <span [class]="probCls(o)" [title]="probTitle(o)">{{ o.prob }}%</span> }
            </td>
            <td role="cell" data-label="Seguimiento">
              <!-- Sin permiso (o sin migración) se ve, pero no es botón: un botón deshabilitado no
                   recibe foco y su nota quedaba sólo en el title, invisible para teclado y lector. -->
              @if (puedeEditar()) {
                <button type="button" class="oa-seg-pill" [attr.data-seg]="o.seguimiento?.estatus ?? 'sin_revisar'"
                        (click)="$event.stopPropagation(); abrirSeguimiento(o)" [title]="segTitle(o)"
                        [attr.aria-label]="'Cambiar seguimiento de la orden ' + o.almacen + '-' + o.folio + ': ' + segLabel(o)">
                  {{ segLabel(o) }} <span class="pi pi-pencil" aria-hidden="true"></span>
                </button>
              } @else {
                <span class="oa-seg-pill oa-seg-ro" [attr.data-seg]="o.seguimiento?.estatus ?? 'sin_revisar'" [title]="segTitle(o)">
                  {{ segLabel(o) }}@if (o.seguimiento?.nota) {<span class="sr-only"> — {{ o.seguimiento.nota }}</span>}
                </span>
              }
            </td>
            <td class="oa-pdf-cell dt-actions" role="cell" data-label="PDF">
              <button type="button" class="oa-pdf" [disabled]="pdfFolio() !== null" (click)="$event.stopPropagation(); imprimir(o, false)"
                      title="PDF para enviar al proveedor: la orden, sus renglones y lo que ya llegó (sin notas internas)"
                      [attr.aria-label]="'PDF para el proveedor de la orden ' + o.almacen + '-' + o.folio">
                @if (pdfFolio() === o.almacen + '-' + o.folio && !pdfInterno()) { <span class="pi pi-spin pi-spinner" aria-hidden="true"></span> }
                @else { <span class="pi pi-file-pdf" aria-hidden="true"></span> } Prov.
              </button>
              <button type="button" class="oa-pdf" [disabled]="pdfFolio() !== null" (click)="$event.stopPropagation(); imprimir(o, true)"
                      title="PDF interno: además, el estatus de seguimiento y su historia"
                      [attr.aria-label]="'PDF interno de la orden ' + o.almacen + '-' + o.folio">
                @if (pdfFolio() === o.almacen + '-' + o.folio && pdfInterno()) { <span class="pi pi-spin pi-spinner" aria-hidden="true"></span> }
                @else { <span class="pi pi-lock" aria-hidden="true"></span> } Int.
              </button>
            </td>
          </tr>
        </ng-template>
        <!-- [RA-PRO.69] DESIGN.md SS14 (Almacen/Compras = totales congelados). Suma lo que esta
             FILTRADO y dice cual filtro: sin esto, en el renglon 300 no habia ningun total a la
             vista y la tira de arriba contaba otra cosa. -->
        <ng-template #footer>
          <tr class="oa-tfoot">
            <td pFrozenColumn colspan="4">
              {{ filtrado() ? 'Filtrado' : 'Todo lo que trajo la tabla' }}
              <span class="oa-muted">· {{ filas().length | number }} {{ filas().length === 1 ? 'orden' : 'órdenes' }}</span>
            </td>
            <td></td><td></td><td></td>
            <td class="comm-num">{{ filtroLineas() | number }}</td>
            <td class="comm-num is-strong">{{ money(filtroValor()) }}</td>
            <td class="comm-num oa-muted" title="El valor pesado por la probabilidad de llegar de cada orden.">{{ money(filtroEsperado()) }}</td>
            <td></td><td></td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="12" class="comm-empty-cell">
            <div class="comm-empty">
              @if (cargaError()) {
                <i class="pi pi-exclamation-triangle comm-empty-icon" aria-hidden="true"></i>
                <p class="oa-empty-t">No se pudo cargar la bandeja</p>
                <p class="oa-empty-s">La consulta no respondió. <b>No quiere decir que no haya órdenes abiertas</b>: quiere decir que no se sabe.</p>
                <button pButton type="button" class="p-button-sm" (click)="reload()">
                  <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
                  <span class="p-button-label">Reintentar</span>
                </button>
              } @else if (filtrado()) {
                <i class="pi pi-filter-slash comm-empty-icon" aria-hidden="true"></i>
                <p class="oa-empty-t">Sin resultados para este filtro</p>
                <p class="oa-empty-s">Hay {{ total() | number }} órdenes abiertas en total.</p>
                <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarFiltros()">
                  <span class="p-button-label">Quitar los filtros</span>
                </button>
              } @else {
                <i class="pi pi-inbox comm-empty-icon" aria-hidden="true"></i>
                <p class="oa-empty-t">No hay órdenes de compra abiertas</p>
                <p class="oa-empty-s">Con la sucursal y la antigüedad elegidas, Kepler no tiene ninguna orden sin su entrada.</p>
              }
            </div>
          </td></tr>
        </ng-template>
      </p-table>
      </div>

      <!-- ═══ [RA-PRO.69] Detalle de la orden ═══════════════════════════════════════════════
           DESIGN_TABLES SS4.5: el drill-down de una fila es el side-peek, no un modal (se lee
           SIN perder la lista). Todo esto ya lo devolvia el endpoint desde [RA-PRO.61]; su unico
           consumidor era generarOcPdf(). -->
      <app-side-peek [open]="peekOpen()" (openChange)="peekOpen.set($event)" [width]="620"
                     [title]="peekOrden() ? 'Orden ' + peekOrden()!.almacen + '-' + peekOrden()!.folio : 'Orden'"
                     [subtitle]="peekOrden()?.proveedor || null">
        @if (peekLoading()) {
          <p class="oa-pk-msg"><span class="pi pi-spin pi-spinner" aria-hidden="true"></span> Trayendo la orden…</p>
        } @else if (peekError()) {
          <p class="oa-pk-msg oa-pk-err" role="alert">
            <span class="pi pi-exclamation-triangle" aria-hidden="true"></span> {{ peekError() }}
            <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirDetalle(peekOrden()!)">
              <span class="p-button-label">Reintentar</span>
            </button>
          </p>
        } @else if (peekData(); as d) {

          <!-- Lo primero: cuanto llego. Es la pregunta del comprador. -->
          <div class="oa-pk-surtido">
            <div class="oa-pk-surtido-k">Surtido</div>
            @if (peekPct() !== null) {
              <div class="oa-pk-surtido-v comm-num">{{ peekPct() | number:'1.0-1' }}%</div>
              <div class="oa-pk-bar"><i [style.width.%]="barPct()"></i></div>
              <div class="oa-pk-surtido-s">{{ money(d.recibido) }} de {{ money(peekOrden()!.valor) }}</div>
            } @else {
              <!-- Sin importe no se puede dividir: se DECLARA, no se dibuja 0%. -->
              <div class="oa-pk-surtido-v oa-muted">sin medir</div>
              <div class="oa-pk-surtido-s">La orden no tiene importe contra el cual comparar.</div>
            }
          </div>

          @if (d.recepciones_descartadas.n) {
            <p class="oa-pk-warn">
              <span class="pi pi-info-circle" aria-hidden="true"></span>
              {{ d.recepciones_descartadas.n }} recepción(es) por {{ money(d.recepciones_descartadas.monto) }}
              citan este folio pero <b>no cuentan</b>: son de otro proveedor o anteriores a la orden.
            </p>
          }

          <!-- La cabecera que la tabla no tiene espacio para mostrar. -->
          <dl class="oa-pk-dl">
            <div><dt>Fecha</dt><dd>{{ d.orden.fecha || '—' }}</dd></div>
            <div><dt>Vence</dt><dd>{{ d.orden.vence || '—' }}</dd></div>
            <div><dt>Abierta</dt><dd class="comm-num">{{ d.orden.dias | number }} d</dd></div>
            <div><dt>Kepler</dt><dd>{{ estLabel(d.orden.estatus_kepler) }}</dd></div>
            <div class="oa-pk-wide"><dt>Motivo</dt>
              <dd>{{ peekOrden()!._claseLabel }}
                <span class="oa-muted">— {{ claseAccion(peekOrden()!._clase) }}</span>
              </dd>
            </div>
            <div><dt>Condición de pago</dt><dd>{{ d.orden.condicion_pago || '—' }}</dd></div>
            <div><dt>RFC</dt><dd class="oa-mono">{{ d.orden.proveedor_rfc || '—' }}</dd></div>
            <div><dt>Referencia</dt><dd>{{ d.orden.referencia || '—' }}</dd></div>
            @if (d.orden.concepto) { <div class="oa-pk-wide"><dt>Concepto</dt><dd>{{ d.orden.concepto }}</dd></div> }
          </dl>

          <!-- Los renglones. La tabla solo mostraba cuantos eran. -->
          <h3 class="oa-pk-h">Renglones <span class="oa-muted">({{ d.lineas.length | number }})</span></h3>
          @if (d.lineas.length) {
            <div class="oa-pk-scroll">
              <table class="oa-pk-tbl" aria-label="Renglones de la orden de compra">
                <thead><tr>
                  <th scope="col">SKU</th><th scope="col">Producto</th>
                  <th scope="col" class="comm-num">Cant.</th><th scope="col">Unidad</th>
                  <th scope="col" class="comm-num">Costo</th><th scope="col" class="comm-num">Importe</th>
                </tr></thead>
                <tbody>
                  @for (l of d.lineas; track l.linea) {
                    <tr>
                      <td><span class="comm-code">{{ l.sku || '—' }}</span></td>
                      <td>{{ l.nombre || '—' }}</td>
                      <td class="comm-num">{{ l.cantidad | number:'1.0-2' }}</td>
                      <td class="oa-muted">{{ l.unidad || '—' }}</td>
                      <td class="comm-num">{{ money(l.costo_unitario) }}</td>
                      <td class="comm-num is-strong">{{ money(l.importe) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else { <p class="oa-pk-msg oa-muted">La orden no trae renglones.</p> }

          <!-- Lo que ya llego contra esta orden. -->
          <h3 class="oa-pk-h">Recepciones <span class="oa-muted">({{ d.recepciones.length | number }})</span></h3>
          @if (d.recepciones.length) {
            <ul class="oa-pk-list">
              @for (r of d.recepciones; track r.folio) {
                <li>
                  <span class="comm-code">{{ r.folio }}</span>
                  <span class="oa-muted">{{ r.fecha || 'sin fecha' }}</span>
                  <b class="comm-num">{{ money(r.monto) }}</b>
                </li>
              }
            </ul>
          } @else { <p class="oa-pk-msg oa-muted">Todavía no llegó nada contra esta orden.</p> }

          <!-- La historia del seguimiento: quien la toco y cuando. -->
          @if (d.historia.length) {
            <h3 class="oa-pk-h">Historia del seguimiento</h3>
            <ul class="oa-pk-hist">
              @for (h of d.historia; track h.en) {
                <li>
                  <b>{{ segEstatusLabel(h.estatus) }}</b>
                  <span class="oa-muted">{{ h.en | date:'dd/MM/yy HH:mm' }} · {{ h.por || 'sistema' }}</span>
                  @if (h.nota) { <p class="oa-pk-nota">{{ h.nota }}</p> }
                </li>
              }
            </ul>
          }

          <div class="oa-pk-actions">
            @if (puedeEditar()) {
              <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirSeguimiento(peekOrden()!)">
                <span class="p-button-icon p-button-icon-left pi pi-pencil" aria-hidden="true"></span>
                <span class="p-button-label">Cambiar seguimiento</span>
              </button>
            }
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="pdfFolio() !== null"
                    (click)="imprimir(peekOrden()!, true)">
              <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span>
              <span class="p-button-label">PDF interno</span>
            </button>
          </div>
        }
      </app-side-peek>

      <!-- [RA-PRO.62] Cambiar el estatus de seguimiento. La nota es obligatoria salvo "Vigente"
           (misma regla que valida el servidor, de @megadulces/contracts). -->
      <p-dialog [visible]="!!segOrden()" (visibleChange)="$event ? null : cerrarSeguimiento()" [modal]="true"
                [style]="{ width: '30rem' }" [breakpoints]="{ '640px': '95vw' }"
                [dismissableMask]="!segGuardando()" [closable]="!segGuardando()" [closeOnEscape]="!segGuardando()"
                [header]="segOrden() ? 'Seguimiento · OC ' + segOrden()!.almacen + '-' + segOrden()!.folio : ''">
        @if (segOrden(); as o) {
          <div class="oa-dlg">
            <p class="oa-dlg-sub">{{ o.proveedor || 'Sin proveedor' }} · {{ money(o.valor) }} · {{ o.dias }} días abierta</p>
            <label class="oa-dlg-lbl" for="oa-seg-estatus">Estatus</label>
            <p-select inputId="oa-seg-estatus" [options]="segEditOpts" [ngModel]="segEstatus()" (ngModelChange)="segEstatus.set($event)" optionLabel="label" optionValue="value"
                      appendTo="body" [fluid]="true"></p-select>
            <label class="oa-dlg-lbl" for="oa-seg-nota">
              Nota @if (notaRequerida()) { <span class="oa-req">(obligatoria)</span> } @else { <span class="oa-muted">(opcional)</span> }
            </label>
            <textarea id="oa-seg-nota" class="oa-dlg-nota" rows="3" [maxlength]="notaMax" [ngModel]="segNota()" (ngModelChange)="segNota.set($event)"
                      placeholder="Por ejemplo: falta pagar la factura 1234; el proveedor surte el lunes."></textarea>
            <p class="oa-dlg-hint">No cambia nada en Kepler: es el registro de Compras. Queda quién y cuándo.</p>
            @if (segError()) { <p class="oa-dlg-err" role="alert">{{ segError() }}</p> }
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [disabled]="segGuardando()" (click)="cerrarSeguimiento()">Cancelar</button>
          <button pButton type="button" class="p-button-sm" [disabled]="segGuardando()" (click)="guardarSeguimiento()">
            {{ segGuardando() ? 'Guardando…' : 'Guardar' }}
          </button>
        </ng-template>
      </p-dialog>

      <!-- La curva es el criterio con el que el motor pesa cada orden: mostrarla evita que la
           columna "Prob." parezca un número inventado. -->
      @if (curva().length) {
        <p class="oa-foot">
          Probabilidad medida sobre las órdenes de hace 180–400 días, ya resueltas:
          @for (c of curva(); track c.edad) {<span class="oa-cv">{{ c.edad }} d → <strong>{{ c.pct }}%</strong></span>}
          Es la misma curva con la que el pedido descuenta lo que viene en camino.
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* [RA-PRO.70] Una LINEA, no un objeto: sin borde ni fondo ni radio. Lo que marca
       jerarquia es el peso del dato, no una caja alrededor. */
    .oa-lede { margin: 0 0 .85rem; font-size: .9rem; line-height: 1.5; }
    .oa-lede b { font-weight: 700; }
    .oa-bad { color: var(--bad-fg); }
    .oa-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .oa-sel { min-width: 12rem; }
    .oa-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .oa-table { font-size: .82rem; }
    .oa-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .oa-muted { color: var(--text-muted); }
    .oa-edad-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-edad-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-min { font-size: .9rem; margin-left: .1rem; color: var(--warn-fg); }
    .oa-aviso { display: flex; align-items: flex-start; gap: .45rem; margin: 0 0 .75rem; padding: .5rem .7rem;
      font-size: .8rem; line-height: 1.45; color: var(--text-main);
      border: 1px solid var(--border-color); border-left: 3px solid var(--warn-fg); border-radius: var(--r-sm, 8px); }
    .oa-aviso-err { border-left-color: var(--bad-fg); }
    /* [RA-PRO.69] Una cabecera con title hereda cursor:help de la regla global de .surf-def
       (styles.css: .p-datatable thead th[title]). Si ademas es ORDENABLE el cursor miente:
       ahi SI se puede clicar. La nota global ya preveia esto para el boton hecho a mano
       (.surf-sort) pero no para el th de PrimeNG. Deuda del DS: deberia vivir alla.
       Clase verificada en primeng-table.mjs. (Sin acentos graves aca: cierran el literal.) */
    .oa-table thead th.p-datatable-sortable-column { cursor: pointer; }

    /* ── [RA-PRO.69] Pie de totales y estados vacios ─────────────────────────────────── */
    .oa-tfoot td { border-top: 2px solid var(--border-color); font-weight: 600;
                   background: var(--surface-100); }
    .oa-empty-t { font-weight: 600; margin: .5rem 0 .25rem; }
    .oa-empty-s { color: var(--text-muted); font-size: .8rem; margin: 0 0 .75rem; }

    /* ── [RA-PRO.69] Detalle en side-peek ────────────────────────────────────────────── */
    .oa-pk-msg { display: flex; align-items: center; gap: .5rem; font-size: .85rem; margin: .5rem 0; }
    .oa-pk-err { color: var(--bad-fg); }
    .oa-pk-surtido { border: 1px solid var(--border-color); border-radius: var(--radius-md, 8px);
                     padding: .85rem 1rem; margin-bottom: .9rem; }
    .oa-pk-surtido-k { font-size: .65rem; font-weight: 700; letter-spacing: .07em;
                       text-transform: uppercase; color: var(--text-muted); }
    .oa-pk-surtido-v { font-size: 1.75rem; font-weight: 600; line-height: 1.15; margin-top: .15rem; }
    .oa-pk-surtido-s { font-size: .78rem; color: var(--text-muted); margin-top: .3rem; }
    .oa-pk-bar { height: 6px; border-radius: 999px; background: var(--surface-100);
                 overflow: hidden; margin-top: .45rem; }
    .oa-pk-bar i { display: block; height: 100%; background: var(--ok-fg); }
    .oa-pk-warn { display: flex; gap: .5rem; align-items: flex-start; font-size: .78rem;
                  color: var(--warn-fg); border-left: 3px solid var(--warn-fg);
                  padding: .5rem .7rem; margin: 0 0 .9rem; line-height: 1.45; }
    .oa-pk-dl { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem .9rem; margin: 0 0 1rem; }
    .oa-pk-dl > div { min-width: 0; }
    .oa-pk-wide { grid-column: 1 / -1; }
    .oa-pk-dl dt { font-size: .65rem; font-weight: 700; letter-spacing: .06em;
                   text-transform: uppercase; color: var(--text-muted); }
    .oa-pk-dl dd { margin: .1rem 0 0; font-size: .85rem; }
    .oa-pk-h { font-size: .8rem; font-weight: 700; margin: 1.1rem 0 .4rem;
               padding-bottom: .3rem; border-bottom: 1px solid var(--border-color); }
    .oa-pk-scroll { overflow-x: auto; }
    .oa-pk-tbl { width: 100%; border-collapse: collapse; font-size: .78rem; }
    .oa-pk-tbl th { text-align: left; font-size: .62rem; font-weight: 700; letter-spacing: .06em;
                    text-transform: uppercase; color: var(--text-muted);
                    padding: .3rem .4rem; border-bottom: 1px solid var(--border-color); }
    .oa-pk-tbl th.comm-num { text-align: right; }
    .oa-pk-tbl td { padding: .3rem .4rem; border-bottom: 1px solid var(--border-color); }
    .oa-pk-list, .oa-pk-hist { list-style: none; margin: 0; padding: 0; }
    .oa-pk-list li { display: flex; align-items: center; gap: .6rem; font-size: .8rem;
                     padding: .35rem 0; border-bottom: 1px solid var(--border-color); }
    .oa-pk-list li b { margin-left: auto; }
    .oa-pk-hist li { font-size: .8rem; padding: .4rem 0; border-bottom: 1px solid var(--border-color);
                     display: flex; flex-wrap: wrap; gap: .45rem; align-items: baseline; }
    .oa-pk-nota { flex-basis: 100%; margin: .2rem 0 0; color: var(--text-muted); line-height: 1.45; }
    .oa-pk-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: 1.2rem;
                     padding-top: .8rem; border-top: 1px solid var(--border-color); }
    @media (max-width: 30rem) { .oa-pk-dl { grid-template-columns: 1fr; } }

    .oa-foot { margin-top: .75rem; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }

    /* [RA-PRO.62] Seguimiento: filtro por estatus + pastilla por renglón. Colores por estado con los
       tokens de severidad (warn/bad/ok), no hex sueltos. */
    .oa-seg-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin: -.25rem 0 .75rem; }
    .oa-seg-lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; margin-right: .2rem; }
    .oa-seg-chip { display: inline-flex; align-items: center; gap: .3rem; padding: .2rem .55rem; min-height: 28px;
      border: 1px solid var(--border-color); border-radius: 999px; background: transparent; color: var(--text-main);
      font: inherit; font-size: .76rem; cursor: pointer; }
    .oa-seg-chip b { font-variant-numeric: tabular-nums; }
    .oa-seg-chip:hover { background: var(--hover-bg, var(--overlay-hover)); }
    .oa-seg-on { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .oa-seg-chip:focus-visible, .oa-seg-pill:focus-visible, .oa-pdf:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .oa-seg-pill { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .5rem; border-radius: 999px;
      border: 1px solid var(--border-color); background: transparent; color: var(--text-main); font: inherit; font-size: .74rem;
      white-space: nowrap; cursor: pointer; }
    .oa-seg-ro { cursor: default; }
    .oa-seg-pill .pi { font-size: .65rem; color: var(--text-muted); }
    [data-seg='sin_revisar'] { color: var(--text-muted); border-style: dashed; }
    .oa-seg-pill[data-seg='vigente'] { color: var(--ok-fg); border-color: var(--ok-fg); }
    .oa-seg-pill[data-seg='detenida_pago'], .oa-seg-pill[data-seg='detenida_logistica'] { color: var(--warn-fg); border-color: var(--warn-fg); }
    .oa-seg-pill[data-seg='backorder'] { color: var(--action); border-color: var(--action); }
    .oa-seg-pill[data-seg='no_surtida_cancelada'] { color: var(--bad-fg); border-color: var(--bad-fg); }

    /* [RA-PRO.67] El motivo por el que la orden sigue abierta. Tokens semanticos, nunca hex:
       el color NO es el unico portador -- la etiqueta dice lo mismo en palabras. */
    .oa-clase { display: inline-flex; align-items: center; white-space: nowrap;
                padding: .1rem .45rem; border-radius: var(--radius-sm, 4px);
                border: 1px solid var(--border-color); font-size: .74rem; font-weight: 600;
                color: var(--text-muted); }
    .oa-clase[data-clase='falta_entrada'] { color: var(--warn-fg); border-color: var(--warn-fg); }
    .oa-clase[data-clase='abortada'],
    .oa-clase[data-clase='cerrada_sin_rastro'] { color: var(--bad-fg); border-color: var(--bad-fg); }
    .oa-seg-chip[data-clase='falta_entrada'] b { color: var(--warn-fg); }
    .oa-seg-chip[data-clase='abortada'] b,
    .oa-seg-chip[data-clase='cerrada_sin_rastro'] b { color: var(--bad-fg); }
    .oa-pdf-cell { white-space: nowrap; }
    .oa-pdf { display: inline-flex; align-items: center; gap: .2rem; padding: .15rem .4rem; margin-right: .2rem; min-height: 26px;
      border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: transparent; color: var(--text-main);
      font: inherit; font-size: .72rem; cursor: pointer; }
    .oa-pdf:disabled { opacity: .5; cursor: default; }
    .oa-pdf .pi { font-size: var(--fs-xs); }

    .oa-dlg { display: flex; flex-direction: column; gap: .35rem; }
    .oa-dlg-sub { margin: 0 0 .4rem; font-size: .8rem; color: var(--text-muted); }
    .oa-dlg-lbl { font-size: .72rem; font-weight: 600; color: var(--text-main); margin-top: .35rem; }
    .oa-dlg-nota { width: 100%; resize: vertical; padding: .45rem .55rem; font: inherit; font-size: .85rem; color: var(--text-main);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); }
    .oa-dlg-nota:focus { outline: none; border-color: var(--action); box-shadow: 0 0 0 2px var(--action-ring); }
    .oa-req { color: var(--bad-fg); font-weight: 600; }
    .oa-dlg-hint { margin: .25rem 0 0; font-size: .72rem; color: var(--text-muted); }
    .oa-dlg-err { margin: .25rem 0 0; font-size: .78rem; color: var(--bad-fg); }
    .oa-cv { margin: 0 .45rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  `],
})
export class ComprasOcAbiertasComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<OpenOcRow[]>([]);
  readonly total = signal(0);
  readonly curva = signal<OpenOcResponse['curva']>([]);
  readonly loading = signal(false);

  fMinDays = 0;
  fSuc = '';
  edadOpts = [
    { label: 'Todas', value: 0 },
    { label: 'Abiertas +8 días', value: 8 },
    { label: 'Abiertas +30 días', value: 31 },
    { label: 'Abiertas +60 días', value: 61 },
  ];
  /**
   * [RA-PRO.60] Sucursales desde la base, no escritas a mano: la lista vieja no tenía 07 ni 08
   * (que sí tienen órdenes abiertas) y dejaba 02/04/05 sin nombre. Sale del mismo lookup que usa
   * el pedido, que YA viene recortado al alcance de la persona. Sólo códigos numéricos: son las
   * sucursales Kepler, que es donde viven las órdenes de compra (`MD-*` es historia Wincaja).
   */
  readonly sucOpts = signal<{ label: string; value: string }[]>([]);

  // [RA-PRO.60] Del servidor, sobre TODAS las órdenes: antes se contaban sobre la tabla, que
  // corta en 500.
  readonly mostradas = signal(0);
  readonly truncado = signal(false);
  readonly totalMinimo = signal(false);

  // ── [RA-PRO.62] Seguimiento de Compras ───────────────────────────────────────────────────
  // Registro propio (no toca Kepler). Se ve con COMPRAS_PEDIDO_VER; se cambia con _GESTIONAR.
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  readonly canManage = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.COMPRAS_PEDIDO_GESTIONAR] === true);

  /** `false` mientras la migración del seguimiento no esté aplicada (lo dice el servidor). */
  readonly seguimientoHabilitado = signal(false);
  /** Editar = tener el permiso Y que la tabla exista. */
  readonly puedeEditar = computed(() => this.canManage() && this.seguimientoHabilitado());

  /** Conteo por estatus sobre TODAS las órdenes (lo calcula el servidor). */
  readonly porSeguimiento = signal<Record<string, number>>({});
  /** Filtro de la tabla por estatus ('' = todas, 'sin_revisar' = sin registro). */
  readonly fSeg = signal<string>('');

  // ── [RA-PRO.67] Por qué sigue abierta ──────────────────────────────────────────────────
  /** Conteo y dinero por clase sobre TODAS las órdenes (lo calcula el servidor). */
  readonly porClase = signal<Record<string, number>>({});
  readonly muertas = signal(0);
  readonly valorMuertas = signal(0);
  /** `false` mientras la vista no traiga `estado_cadena`: la pantalla lo DECLARA, no pinta ceros. */
  readonly clasifOk = signal(false);
  /** Filtro de la tabla por clase ('' = todas). */
  readonly fClase = signal<string>('');
  readonly claseOpts = CLASES_OC.map((c) => ({
    value: c as string, label: CLASE_OC_LABEL[c], accion: CLASE_OC_ACCION[c],
  }));
  /**
   * Qué hacer con esta clase, para el `title` de la pastilla.
   *
   * ⚠️ Es un MÉTODO y no el mapa expuesto al template a propósito: `let-o` de `p-table` llega
   * como `any`, y con `strictTemplates` indexar un `Record<ClaseOc, string>` con `any` es
   * TS7053. Acá el tipo se conoce, y el `?? ''` cubre una clase que el servidor mande y el
   * front todavía no tenga — sin reventar la fila.
   */
  claseAccion(c: ClaseOc | string | null | undefined): string {
    return CLASE_OC_ACCION[c as ClaseOc] ?? '';
  }

  /** Quita los dos filtros de cliente (chips). La sucursal y la antigüedad son del servidor. */
  limpiarFiltros(): void { this.fSeg.set(''); this.fClase.set(''); this.syncUrl(); }

  /**
   * `[RA-PRO.69]` DESIGN.md §800 (binding): en Operations el filtro activo vive en la URL.
   * Sin esto, F5 borraba sucursal, antigüedad y los dos chips, y no se podía mandar
   * "mirá estas diez" por chat — la otra persona abría la pantalla entera.
   */
  syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        suc: this.fSuc || null,
        dias: this.fMinDays || null,
        clase: this.fClase() || null,
        seg: this.fSeg() || null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  readonly segOpts = [
    { value: 'sin_revisar', label: OC_SIN_REVISAR },
    ...OC_SEGUIMIENTO_ESTATUS.map((v) => ({ value: v as string, label: OC_SEGUIMIENTO_LABEL[v] })),
  ];
  readonly segEditOpts = OC_SEGUIMIENTO_ESTATUS.map((v) => ({ value: v, label: OC_SEGUIMIENTO_LABEL[v] }));
  readonly filas = computed<FilaOc[]>(() => {
    const f = this.fSeg();
    const c = this.fClase();
    // [RA-PRO.69] La clase se materializa UNA vez por fila: la necesitan el filtro, la columna
    // ordenable y el chip, y recalcularla en cada uno daba tres lecturas del mismo hecho.
    let r: FilaOc[] = this.rows().map((o) => {
      const k = clasificarOc(o.estado_cadena, o.pendiente_en_erp);
      return { ...o, _clase: k, _claseLabel: CLASE_OC_LABEL[k] };
    });
    if (f) r = r.filter((o) => (o.seguimiento?.estatus ?? 'sin_revisar') === f);
    // [RA-PRO.67] Mismo límite que el filtro de seguimiento: recorre sólo lo que la tabla trajo
    // (el número del chip sí cuenta todas). Ya lo declara el aviso de `truncado`.
    if (c) r = r.filter((o) => o._clase === c);
    return r;
  });

  // ── [RA-PRO.69] Los totales siguen al filtro ────────────────────────────────────────────
  // Antes la tira de arriba salia del servidor sobre TODAS las ordenes y los chips filtraban
  // solo la tabla: tocabas "Compra abortada - 10", veias 10 filas y el contador seguia diciendo
  // "296 de 296". El numero contradecia lo que tenias enfrente.
  /** `true` cuando hay algun filtro de cliente puesto (chip de clase o de seguimiento). */
  readonly filtrado = computed(() => !!this.fSeg() || !!this.fClase());
  readonly filtroValor = computed(() => this.filas().reduce((a, o) => a + (Number(o.valor) || 0), 0));
  readonly filtroLineas = computed(() => this.filas().reduce((a, o) => a + (Number(o.lineas) || 0), 0));
  /** El valor pesado por la curva, con la MISMA regla del servidor: sin curva cuenta completo. */
  readonly filtroEsperado = computed(() =>
    this.filas().reduce((a, o) => a + (Number(o.valor) || 0) * ((o.prob ?? 100) / 100), 0));

  // ── [RA-PRO.69] Detalle en side-peek (DESIGN_TABLES SS4.5: row-click -> side-peek) ───────
  // El endpoint de detalle existia desde [RA-PRO.61] y su UNICO consumidor era el PDF: se pedia
  // el % surtido, los renglones, las recepciones y la historia, se renderizaban a un PDF y se
  // tiraban. Para saber cuanto habia llegado de una orden habia que descargar un archivo.
  readonly peekOpen = signal(false);
  readonly peekOrden = signal<FilaOc | null>(null);
  readonly peekData = signal<OcDetalle | null>(null);
  readonly peekLoading = signal(false);
  readonly peekError = signal<string | null>(null);
  private peekSub: Subscription | null = null;

  abrirDetalle(o: FilaOc): void {
    this.peekOrden.set(o);
    this.peekData.set(null);
    this.peekError.set(null);
    this.peekLoading.set(true);
    this.peekOpen.set(true);
    this.peekSub?.unsubscribe();
    this.peekSub = this.api.openPurchaseOrderDetail(o.almacen, o.folio)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.peekData.set(d); this.peekLoading.set(false); },
        error: () => {
          this.peekError.set('No se pudo traer el detalle de la orden. Reintentá.');
          this.peekLoading.set(false);
        },
      });
  }

  /** El % que ya llegó. `null` = la orden no tiene importe: se DECLARA, no se dibuja 0%. */
  readonly peekPct = computed(() => this.peekData()?.pct_surtido ?? null);

  // Diálogo de cambio de estatus. Señales (no campos planos): `notaRequerida` es un computed.
  readonly segOrden = signal<OpenOcRow | null>(null);
  readonly segEstatus = signal<OcSeguimientoEstatus>('vigente');
  readonly segNota = signal('');
  readonly segError = signal<string | null>(null);
  readonly segGuardando = signal(false);
  readonly notaRequerida = computed(() => notaObligatoria(this.segEstatus()));
  readonly notaMax = OC_NOTA_MAX;

  segLabel(o: OpenOcRow): string { return o.seguimiento ? OC_SEGUIMIENTO_LABEL[o.seguimiento.estatus] : OC_SIN_REVISAR; }
  /** `[RA-PRO.69]` El rótulo de un estatus suelto (la historia trae el valor, no la orden). */
  segEstatusLabel(e: OcSeguimientoEstatus): string { return OC_SEGUIMIENTO_LABEL[e] ?? String(e); }
  /** Ancho de la barra de surtido, acotado a 100: una orden sobre-surtida no se sale de la caja. */
  readonly barPct = computed(() => Math.max(0, Math.min(100, this.peekPct() ?? 0)));
  segTitle(o: OpenOcRow): string {
    if (!this.seguimientoHabilitado()) {
      return 'El registro de seguimiento todavía no está habilitado: falta aplicar la migración en la base.';
    }
    const s = o.seguimiento;
    if (!s) return this.puedeEditar() ? 'Nadie la ha revisado. Clic para registrar el estatus.' : 'Nadie la ha revisado.';
    const cuando = new Date(s.actualizado_en).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
    return `${OC_SEGUIMIENTO_LABEL[s.estatus]}${s.nota ? ` — ${s.nota}` : ''}\n${s.actualizado_por ?? '—'} · ${cuando}`;
  }
  abrirSeguimiento(o: OpenOcRow): void {
    if (!this.puedeEditar()) return;
    this.segOrden.set(o);
    this.segEstatus.set(o.seguimiento?.estatus ?? 'vigente');
    this.segNota.set(o.seguimiento?.nota ?? '');
    this.segError.set(null);
  }
  /** Mientras se guarda no se cierra: si se cerrara, la respuesta tardía no tendría a quién avisarle. */
  cerrarSeguimiento(): void {
    if (this.segGuardando()) return;
    this.segOrden.set(null);
  }
  /** Ficha de la última petición de guardado: una respuesta vieja no pisa el diálogo actual. */
  private segReq = 0;
  guardarSeguimiento(): void {
    const o = this.segOrden();
    if (!o || this.segGuardando()) return;
    // La misma regla que aplica el servidor: el aviso sale aquí sin ir y volver.
    const v = validarSeguimiento(this.segEstatus(), this.segNota());
    if (!v.ok) { this.segError.set(v.error); return; }
    this.segGuardando.set(true);
    const req = ++this.segReq;
    this.api.setPurchaseOrderFollowup(o.almacen, o.folio, { estatus: v.estatus, nota: v.nota })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        // Se recarga en vez de parchar el renglón: los conteos por estatus son sobre TODAS las
        // órdenes y sólo el servidor los sabe.
        next: () => {
          if (req !== this.segReq) return;
          this.segGuardando.set(false);
          this.cerrarSeguimiento();
          this.reload();
        },
        error: (e) => {
          if (req !== this.segReq) return;
          this.segGuardando.set(false);
          this.segError.set(e?.error?.message || 'No se pudo guardar el estatus. Intenta de nuevo.');
        },
      });
  }

  // ── [RA-PRO.61] PDF de la orden ──────────────────────────────────────────────────────────
  private readonly sucNombre = signal(new Map<string, string>());
  /** 'SUC-FOLIO' de la orden cuyo PDF se está armando (uno a la vez). */
  readonly pdfFolio = signal<string | null>(null);
  /** Qué versión se está armando: el spinner sale sólo en el botón que se tocó. */
  readonly pdfInterno = signal(false);
  readonly pdfError = signal<string | null>(null);
  /**
   * `[RA-PRO.69]` Si la carga falla, la pantalla ponia TODO en cero y caia al estado vacio:
   * "No hay órdenes de compra abiertas · Kepler no tiene ninguna orden sin su entrada".
   * Eso es afirmar un hecho del ERP a partir de una petición que no llegó. Ahora se declara
   * el error y se ofrece reintentar (DESIGN_TABLES §3: nunca en blanco silencioso).
   */
  readonly cargaError = signal(false);

  imprimir(o: OpenOcRow, interno: boolean): void {
    if (this.pdfFolio()) return;
    this.pdfFolio.set(`${o.almacen}-${o.folio}`);
    this.pdfInterno.set(interno);
    this.pdfError.set(null);
    this.api.openPurchaseOrderDetail(o.almacen, o.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: async (d) => {
        try {
          await generarOcPdf(d, {
            emitido: new Date(), elaboro: this.auth.user()?.username || 'Compras',
            sucursalNombre: this.sucNombre().get(o.almacen) ?? null, interno,
          });
        } catch {
          this.pdfError.set(`No se pudo generar el PDF de la orden ${o.almacen}-${o.folio}.`);
        } finally {
          this.pdfFolio.set(null);
        }
      },
      error: () => {
        this.pdfError.set(`No se pudo traer la orden ${o.almacen}-${o.folio} para el PDF.`);
        this.pdfFolio.set(null);
      },
    });
  }

  ngOnInit(): void {
    // [RA-PRO.69] Estado en URL: rehidratar antes del primer reload (F5 y deep-link).
    const q = this.route.snapshot.queryParamMap;
    const suc = q.get('suc');
    if (suc && /^\d{2}$/.test(suc)) this.fSuc = suc;
    const dias = Number(q.get('dias'));
    if (Number.isFinite(dias) && this.edadOpts.some((o) => o.value === dias)) this.fMinDays = dias;
    const clase = q.get('clase');
    if (clase && (CLASES_OC as readonly string[]).includes(clase)) this.fClase.set(clase);
    const seg = q.get('seg');
    if (seg && this.segOpts.some((o) => o.value === seg)) this.fSeg.set(seg);

    this.api.filters().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (f) => {
        const ws = (f.warehouses ?? []).filter((w) => /^\d{2}$/.test(String(w.code)));
        this.sucOpts.set(ws.map((w) => ({ label: `${w.code} · ${w.name}`, value: String(w.code) })));
        this.sucNombre.set(new Map(ws.map((w) => [String(w.code), w.name])));
      },
      // Sin la lista el filtro queda vacío, pero la tabla (que no depende de ella) sigue cargando.
      error: () => this.sucOpts.set([]),
    });
    this.reload();
  }

  /** La carga en curso: si se cambia el filtro antes de que responda, la vieja se cancela y no pisa a la nueva. */
  private reloadSub?: Subscription;

  reload(): void {
    this.loading.set(true);
    this.reloadSub?.unsubscribe();
    this.reloadSub = this.api.openPurchaseOrders({ sucursal: this.fSuc || undefined, min_days: this.fMinDays || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.cargaError.set(false);
          this.rows.set(r.rows ?? []);
          this.total.set(r.total ?? 0);
          this.mostradas.set(r.mostradas ?? (r.rows ?? []).length);
          this.truncado.set(!!r.truncado);
          this.totalMinimo.set(!!r.total_minimo);
          this.porSeguimiento.set(r.por_seguimiento ?? {});
          this.porClase.set(r.por_clase ?? {});
          this.muertas.set(r.muertas ?? 0);
          this.valorMuertas.set(r.valor_muertas ?? 0);
          this.clasifOk.set(!!r.clasificacion_disponible);
          this.seguimientoHabilitado.set(!!r.seguimiento_habilitado);
          this.curva.set(r.curva ?? []);
          this.loading.set(false);
        },
        // No se traga el error: la tabla queda vacía pero el contador dice 0 y el usuario ve
        // que algo falló al recargar (DESIGN §Ing.UI 6).
        // [RA-PRO.60] Y los indicadores también se limpian: antes quedaban con los números de la
        // carga anterior junto a una tabla vacía, que se lee como dato.
        error: () => {
          this.cargaError.set(true);
          this.rows.set([]); this.total.set(0); this.mostradas.set(0);
          this.truncado.set(false); this.totalMinimo.set(false); this.porSeguimiento.set({});
          this.porClase.set({}); this.muertas.set(0); this.valorMuertas.set(0); this.clasifOk.set(false);
          // Sin respuesta no se sabe si la tabla de seguimiento existe: no se ofrece editar.
          this.seguimientoHabilitado.set(false); this.curva.set([]);
          this.loading.set(false);
        },
      });
  }

  edadCls(o: OpenOcRow): string { return o.dias > 30 ? 'oa-edad-bad' : o.dias > 14 ? 'oa-edad-warn' : ''; }
  probCls(o: OpenOcRow): string {
    const p = Number(o.prob ?? 0);
    return p < 25 ? 'oa-prob-bad' : p < 60 ? 'oa-prob-warn' : '';
  }
  probTitle(o: OpenOcRow): string {
    if (o.estatus === 'F' || o.estatus === 'R') return 'Kepler ya la marcó como terminada: la cadena de documentos quedó rota, pero no viene nada.';
    if (o.estatus === 'C') return 'Cancelada en Kepler.';
    return `Históricamente, ${o.prob}% de las órdenes que seguían abiertas a los ${o.dias} días terminaron recibiéndose.`;
  }
  estLabel(s: string): string {
    return ({ N: 'Pendiente', F: 'Finalizada', C: 'Cancelada', R: 'Recibida', A: 'Otro' } as Record<string, string>)[s] || s;
  }
  estSev(s: string): Sev {
    return ({ N: 'secondary', F: 'danger', C: 'danger', R: 'danger', A: 'secondary' } as Record<string, Sev>)[s] || 'secondary';
  }
  money(v: number | string | null | undefined) {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
