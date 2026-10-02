import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
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
import { generarOcPdf } from '../oc-kepler-pdf';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

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
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in oa-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes abiertas en Kepler</h1>
          <p class="surf-page-sub">Órdenes de compra sin orden de entrada. En Kepler la orden se captura al recibir, así que una que lleva semanas abierta casi nunca se surte: hay que cerrarla o cancelarla.</p>
        </div>
      </header>

      <!-- Resumen: cuánto papel hay y cuánto de eso sigue realmente en juego. -->
      <div class="oa-kpis">
        <div class="oa-kpi">
          <span class="oa-k">Órdenes abiertas</span>
          <span class="oa-v">{{ total() | number }}@if (totalMinimo()) {<span class="oa-min" title="La consulta llegó a su tope: hay por lo menos estas órdenes, pueden ser más.">+</span>}</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Valor en papel</span>
          <span class="oa-v">{{ money(totalValor()) }}</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Se espera que llegue</span>
          <span class="oa-v oa-ok">{{ money(valorEsperado()) }}</span>
          <span class="oa-s">{{ pctEsperado() }}% del papel</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Para barrer (+30 d)</span>
          <span class="oa-v oa-bad">{{ viejas() | number }}</span>
          <span class="oa-s">{{ money(valorViejas()) }}</span>
        </div>
        <!-- [RA-PRO.67] Lo que no va a salir solo. Si la vista no trae estado_cadena, el
             mosaico DECLARA que no se midio, en vez de mostrar un cero que se lee como
             "no hay ninguna". (Sin acentos graves aca dentro: cierran el template.) -->
        <div class="oa-kpi">
          <span class="oa-k">No va a salir sola</span>
          @if (clasifOk()) {
            <span class="oa-v oa-bad">{{ muertas() | number }}</span>
            <span class="oa-s">{{ money(valorMuertas()) }} · el ERP ya las cerró o su vale está cancelado</span>
          } @else {
            <span class="oa-v oa-muted" title="La vista analytics.erp_purchase_orders todavía no trae estado_cadena (migración 20261002183000 sin aplicar).">sin medir</span>
            <span class="oa-s">falta la migración de la cadena</span>
          }
        </div>
      </div>

      <div class="oa-filters">
        <p-select [options]="edadOpts" [(ngModel)]="fMinDays" (onChange)="reload()"
                  optionLabel="label" optionValue="value" styleClass="oa-sel" appendTo="body"></p-select>
        <p-select [options]="sucOpts()" [(ngModel)]="fSuc" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todas las sucursales"
                  [showClear]="true" styleClass="oa-sel" appendTo="body"></p-select>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
        <span class="oa-count">{{ mostradas() | number }} de {{ total() | number }}@if (totalMinimo()) {+}</span>
      </div>

      <!-- [RA-PRO.67] Por qué sigue abierta. Cada clase la resuelve gente distinta, así que el
           chip lleva la acción en el title: el nombre solo no dice a quién le toca. -->
      @if (clasifOk()) {
        <div class="oa-seg-bar" role="group" aria-label="Filtrar por motivo">
          <span class="oa-seg-lbl">Por qué sigue abierta</span>
          <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fClase() === ''"
                  [attr.aria-pressed]="fClase() === ''" (click)="fClase.set('')">
            Todas <b>{{ total() | number }}</b>
          </button>
          @for (c of claseOpts; track c.value) {
            <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fClase() === c.value"
                    [attr.aria-pressed]="fClase() === c.value" (click)="fClase.set(c.value)"
                    [attr.data-clase]="c.value" [title]="c.accion">
              {{ c.label }} <b>{{ (porClase()[c.value] ?? 0) | number }}</b>
            </button>
          }
        </div>
      }

      <!-- [RA-PRO.62] Conteo por estatus de seguimiento (sobre TODAS las órdenes) que además filtra la tabla. -->
      <div class="oa-seg-bar" role="group" aria-label="Filtrar por estatus de seguimiento">
        <span class="oa-seg-lbl">Seguimiento</span>
        <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fSeg() === ''" [attr.aria-pressed]="fSeg() === ''" (click)="fSeg.set('')">
          Todas <b>{{ total() | number }}</b>
        </button>
        @for (s of segOpts; track s.value) {
          <button type="button" class="oa-seg-chip" [class.oa-seg-on]="fSeg() === s.value" [attr.aria-pressed]="fSeg() === s.value" (click)="fSeg.set(s.value)"
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

      <p-table [value]="filas()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               styleClass="p-datatable-sm oa-table">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Suc.</th><th>Proveedor</th><th>Fecha</th>
            <th class="oa-r">Abierta</th><th title="Estatus del documento en Kepler">Kepler</th>
            <th title="Lo que la cadena de documentos demuestra: si hay vale, y si sigue vivo">Motivo</th>
            <th class="oa-r">Líneas</th><th class="oa-r">Valor</th><th class="oa-r">Prob. de llegar</th>
            <th title="Registro de Compras: por qué sigue abierta. No cambia nada en Kepler.">Seguimiento</th>
            <th title="PDF de la orden: para el proveedor (sin notas internas) o interno (con el seguimiento)">PDF</th>
          </tr>
        </ng-template>
        <ng-template #body let-o>
          <tr>
            <td class="oa-mono">{{ o.folio }}</td>
            <td class="oa-mono oa-muted">{{ o.almacen }}</td>
            <td>{{ o.proveedor || '—' }}</td>
            <td class="oa-muted">{{ o.fecha_oc | date:'dd/MM/yy' }}</td>
            <td class="oa-r"><span [class]="edadCls(o)">{{ o.dias }} d</span></td>
            <td><p-tag [value]="estLabel(o.estatus)" [severity]="estSev(o.estatus)" styleClass="oa-tag"></p-tag></td>
            <td>
              @if (clasifOk()) {
                <span class="oa-clase" [attr.data-clase]="clase(o)" [title]="claseAccion(o)">{{ claseLabel(o) }}</span>
              } @else { <span class="oa-muted">—</span> }
            </td>
            <td class="oa-r oa-muted">{{ o.lineas | number }}</td>
            <td class="oa-r oa-strong">{{ money(o.valor) }}</td>
            <td class="oa-r">
              @if (o.prob === null) { <span class="oa-muted">—</span> }
              @else { <span [class]="probCls(o)" [title]="probTitle(o)">{{ o.prob }}%</span> }
            </td>
            <td>
              <!-- Sin permiso (o sin migración) se ve, pero no es botón: un botón deshabilitado no
                   recibe foco y su nota quedaba sólo en el title, invisible para teclado y lector. -->
              @if (puedeEditar()) {
                <button type="button" class="oa-seg-pill" [attr.data-seg]="o.seguimiento?.estatus ?? 'sin_revisar'"
                        (click)="abrirSeguimiento(o)" [title]="segTitle(o)"
                        [attr.aria-label]="'Cambiar seguimiento de la orden ' + o.almacen + '-' + o.folio + ': ' + segLabel(o)">
                  {{ segLabel(o) }} <span class="pi pi-pencil" aria-hidden="true"></span>
                </button>
              } @else {
                <span class="oa-seg-pill oa-seg-ro" [attr.data-seg]="o.seguimiento?.estatus ?? 'sin_revisar'" [title]="segTitle(o)">
                  {{ segLabel(o) }}@if (o.seguimiento?.nota) {<span class="sr-only"> — {{ o.seguimiento.nota }}</span>}
                </span>
              }
            </td>
            <td class="oa-pdf-cell">
              <button type="button" class="oa-pdf" [disabled]="pdfFolio() !== null" (click)="imprimir(o, false)"
                      title="PDF para enviar al proveedor: la orden, sus renglones y lo que ya llegó (sin notas internas)"
                      [attr.aria-label]="'PDF para el proveedor de la orden ' + o.almacen + '-' + o.folio">
                @if (pdfFolio() === o.almacen + '-' + o.folio && !pdfInterno()) { <span class="pi pi-spin pi-spinner" aria-hidden="true"></span> }
                @else { <span class="pi pi-file-pdf" aria-hidden="true"></span> } Prov.
              </button>
              <button type="button" class="oa-pdf" [disabled]="pdfFolio() !== null" (click)="imprimir(o, true)"
                      title="PDF interno: además, el estatus de seguimiento y su historia"
                      [attr.aria-label]="'PDF interno de la orden ' + o.almacen + '-' + o.folio">
                @if (pdfFolio() === o.almacen + '-' + o.folio && pdfInterno()) { <span class="pi pi-spin pi-spinner" aria-hidden="true"></span> }
                @else { <span class="pi pi-lock" aria-hidden="true"></span> } Int.
              </button>
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="12" class="oa-empty">No hay órdenes de compra abiertas con ese filtro.</td></tr>
        </ng-template>
      </p-table>

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
    .oa-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .5rem; margin-bottom: .85rem; }
    .oa-kpi { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .75rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--surface-1, transparent); }
    .oa-k { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; }
    .oa-v { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .oa-s { font-size: .72rem; color: var(--text-muted); }
    .oa-ok { color: var(--ok-fg); }
    .oa-bad { color: var(--bad-fg); }
    .oa-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .oa-sel { min-width: 12rem; }
    .oa-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .oa-table { font-size: .82rem; }
    .oa-r { text-align: right; font-variant-numeric: tabular-nums; }
    .oa-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .oa-muted { color: var(--text-muted); }
    .oa-strong { font-weight: 700; }
    .oa-edad-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-edad-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .oa-min { font-size: .9rem; margin-left: .1rem; color: var(--warn-fg); }
    .oa-aviso { display: flex; align-items: flex-start; gap: .45rem; margin: 0 0 .75rem; padding: .5rem .7rem;
      font-size: .8rem; line-height: 1.45; color: var(--text-main);
      border: 1px solid var(--border-color); border-left: 3px solid var(--warn-fg); border-radius: var(--r-sm, 8px); }
    .oa-aviso-err { border-left-color: var(--bad-fg); }
    .oa-foot { margin-top: .75rem; font-size: .75rem; color: var(--text-muted); line-height: 1.5; }

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
    .oa-clase[data-clase='pendiente'] { color: var(--text-2, var(--text-muted)); }
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
    .oa-pdf .pi { font-size: .75rem; }

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
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<OpenOcRow[]>([]);
  readonly total = signal(0);
  readonly totalValor = signal(0);
  readonly valorEsperado = signal(0);
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
  readonly viejas = signal(0);
  readonly valorViejas = signal(0);
  readonly mostradas = signal(0);
  readonly truncado = signal(false);
  readonly totalMinimo = signal(false);

  pctEsperado = computed(() => {
    const t = this.totalValor();
    return t > 0 ? Math.round((this.valorEsperado() / t) * 100) : 0;
  });

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
  /** La clase de un renglón sale de la MISMA función que usa el servidor (de `@megadulces/contracts`). */
  clase(o: OpenOcRow): ClaseOc { return clasificarOc(o.estado_cadena, o.pendiente_en_erp); }
  claseLabel(o: OpenOcRow): string { return CLASE_OC_LABEL[this.clase(o)]; }
  claseAccion(o: OpenOcRow): string { return CLASE_OC_ACCION[this.clase(o)]; }
  readonly segOpts = [
    { value: 'sin_revisar', label: OC_SIN_REVISAR },
    ...OC_SEGUIMIENTO_ESTATUS.map((v) => ({ value: v as string, label: OC_SEGUIMIENTO_LABEL[v] })),
  ];
  readonly segEditOpts = OC_SEGUIMIENTO_ESTATUS.map((v) => ({ value: v, label: OC_SEGUIMIENTO_LABEL[v] }));
  readonly filas = computed(() => {
    const f = this.fSeg();
    const c = this.fClase();
    let r = this.rows();
    if (f) r = r.filter((o) => (o.seguimiento?.estatus ?? 'sin_revisar') === f);
    // [RA-PRO.67] Mismo límite que el filtro de seguimiento: recorre sólo lo que la tabla trajo
    // (el número del chip sí cuenta todas). Ya lo declara el aviso de `truncado`.
    if (c) r = r.filter((o) => this.clase(o) === c);
    return r;
  });

  // Diálogo de cambio de estatus. Señales (no campos planos): `notaRequerida` es un computed.
  readonly segOrden = signal<OpenOcRow | null>(null);
  readonly segEstatus = signal<OcSeguimientoEstatus>('vigente');
  readonly segNota = signal('');
  readonly segError = signal<string | null>(null);
  readonly segGuardando = signal(false);
  readonly notaRequerida = computed(() => notaObligatoria(this.segEstatus()));
  readonly notaMax = OC_NOTA_MAX;

  segLabel(o: OpenOcRow): string { return o.seguimiento ? OC_SEGUIMIENTO_LABEL[o.seguimiento.estatus] : OC_SIN_REVISAR; }
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
          this.rows.set(r.rows ?? []);
          this.total.set(r.total ?? 0);
          this.totalValor.set(r.total_valor ?? 0);
          this.valorEsperado.set(r.valor_esperado ?? 0);
          this.viejas.set(r.viejas ?? 0);
          this.valorViejas.set(r.valor_viejas ?? 0);
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
          this.rows.set([]); this.total.set(0); this.totalValor.set(0); this.valorEsperado.set(0);
          this.viejas.set(0); this.valorViejas.set(0); this.mostradas.set(0);
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
