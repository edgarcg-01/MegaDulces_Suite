import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ExpenseEvidencePeekComponent } from '../components/expense-evidence-peek.component';
import { ExpenseEvidenceDialogComponent } from '../components/expense-evidence-dialog.component';
import { ComercialService, ExpenseRequestRow, ExpenseRequestsReport } from '../../comercial/comercial.service';
import { ComprobacionesService, ProofByFolio } from '../comprobaciones.service';
import { ExpenseProofsSocketService } from '../expense-proofs-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComprobacionGastosService } from '../comprobacion-gastos.service';
import { datePresetRange, money, moneyShort } from '../../../shared/util';
import { dmy } from './finanzas-format';

/** Etapas que cuentan como «abierta»: todavía deben algo. Alimenta la lectura del periodo. */
const ABIERTAS = ['autorizar', 'ejercer', 'capturar', 'validar'];

/** Periodos que ofrece el head. `rango` revela el datepicker. */
type Periodo = 'hoy' | 'd7' | 'd30' | 'rango';

/**
 * Etapa del ciclo. Es UNA sola, excluyente. El expediente ya no distingue «comprobante»
 * de «solicitud» como etapas: la naturaleza del gasto (fiscal / comprobable / no
 * comprobable) decide qué documentos lleva, y eso vive DENTRO del expediente, no como
 * columna del embudo.
 */
type Etapa = 'autorizar' | 'ejercer' | 'capturar' | 'validar' | 'completo' | 'canceladas' | 'todas';

/**
 * GX.6 — "Solicitudes de gasto": lista de solicitudes (Kepler XA1501) con su estado
 * y si ya se aplicaron a un gasto (XA1001). Foco de control: las pendientes (pedidas/
 * aprobadas y no ejecutadas). Fuente analytics.expense_requests (hoy vista viva sobre ODS).
 *
 * Arranca en **hoy**. Antes abría con 90 días contra una vista viva y un tope de 2000
 * filas: el costo de la consulta y el scroll no los pedía nadie — la pregunta diaria es
 * "qué entró hoy y qué sigue sin aplicarse". Los periodos salen de `datePresetRange`
 * compartido para que "Hoy" signifique lo mismo en toda la app.
 */
@Component({
  selector: 'app-finanzas-solicitudes',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule, SelectModule, DatePickerModule, InputTextModule, InputNumberModule, SkeletonModule, ButtonModule, ToastModule, PageTabsComponent, SegmentedComponent, FreshnessPillComponent, ContextHelpComponent, LoadStateComponent, ExpenseEvidencePeekComponent, ExpenseEvidenceDialogComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast />
      <app-page-tabs [tabs]="tabs" />

      <!-- El rango vive en el head del apartado (patrón Operations #6), no en una banda
           mid-page: es el control que gobierna TODA la pantalla, no un filtro más. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <div class="so-title"><h1>Solicitudes de gasto</h1><app-context-help topic="solicitudes" /></div>
          <p class="surf-page-sub">Solicitudes (XA1501) y su aplicación a gasto (XA1001) · estado, solicitante y días de proceso · fuente Kepler</p>
          @if (mias() && !sinAnclas()) { <p class="so-scope"><i class="pi pi-user" aria-hidden="true"></i> Mías = <strong>{{ miScopeTexto() }}</strong></p> }
          @if (mias() && sinAnclas()) { <p class="so-scope is-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No hay con qué saber cuáles son tuyas — pedí que te asignen tus áreas de gasto en Usuarios.</p> }
        </div>
        <div class="so-head-right">
          <!-- Estado del dato: esto es una vista VIVA sobre Kepler, así que hay que poder
               ver qué tan fresco es lo que se mira y volver a pedirlo (§9 / §13). -->
          <div class="so-freshness">
            @if (liveConnected()) { <span class="so-live"><i class="pi pi-circle-fill" aria-hidden="true"></i> En vivo</span> }
            <app-freshness-pill [since]="lastLoaded()" [staleAfterSec]="300" />
            <button pButton type="button" class="p-button-text p-button-sm so-refresh"
                    [loading]="loading()" (click)="load()" aria-label="Volver a consultar" title="Volver a consultar">
              <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
            </button>
          </div>
          <!-- Alcance: de quién es lo que estoy viendo. Va antes del periodo porque
               cambia el universo, no lo recorta. -->
          <app-segmented [options]="alcanceOpts" [value]="mias() ? 'mias' : 'todas'"
                         (valueChange)="setAlcance($event)" ariaLabel="Alcance" />
          <app-segmented [options]="periodoOpts" [value]="periodo()" (valueChange)="setPeriodo($event)" ariaLabel="Periodo" />
          @if (periodo() === 'rango') {
            <p-datepicker [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy"
                          [showIcon]="true" appendTo="body" (onClose)="load()" ariaLabel="Rango de fechas" />
          }
        </div>
      </header>

      @if (primeraCarga()) {
        <p-skeleton height="1.1rem" styleClass="so-sk-lead" />
        <p-skeleton height="5.5rem" styleClass="so-sk-funnel" />
      } @else {
        <!-- Q.1 — la lectura del PERIODO en una frase, antes de cualquier grid. No cambia
             al moverse de etapa: el embudo de abajo ya dice dónde estás parado. Q.4 — lo
             añejo es el número que duele, así que es un botón que lleva a verlo. -->
        <p class="so-lead">
          {{ lead() }}
          @if (viejasPeriodo().n) {
            <button type="button" class="so-drill" (click)="verAnejas()">{{ viejasPeriodo().n }} {{ viejasPeriodo().n === 1 ? 'lleva' : 'llevan' }} más de 90 días</button><span class="so-lead-m"> ({{ money(viejasPeriodo().importe) }}).</span>
          }
          @if (leadProceso()) { <span class="so-lead-m">{{ leadProceso() }}</span> }
        </p>
      }

      <!-- El embudo ES el encabezado de KPIs y ES la navegación: mismo dato, un organismo.
           Antes eran dos filas que contaban universos distintos sin avisarlo (el strip, el
           periodo entero; las pills, la etapa) y un tercer idioma de control segmentado.
           Va en tres bloques porque son tres cosas distintas —lo que pasa en Kepler, lo que
           nos toca, y lo cerrado— y nueve opciones planas no se leen (Miller). -->
      @if (report()) {
      <nav class="so-funnel" role="radiogroup" aria-label="Etapa del ciclo">
        @for (g of gruposEtapa; track g.label) {
          <div class="so-fgroup">
            <span class="so-fgroup-l">{{ g.label }}</span>
            <div class="so-fitems">
              @for (e of g.etapas; track e.value) {
                <button type="button" role="radio" [attr.aria-checked]="etapa() === e.value"
                        [attr.aria-label]="g.label + ' — ' + e.label + ': ' + conteos()[e.value].n + ' solicitudes, ' + money(conteos()[e.value].importe)"
                        class="so-fitem" [class.on]="etapa() === e.value"
                        [class.is-zero]="!conteos()[e.value].n" (click)="setEtapa(e.value)">
                  <span class="so-fn">{{ conteos()[e.value].n }}</span>
                  <span class="so-fl">{{ e.label }}</span>
                  <span class="so-fm">{{ conteos()[e.value].importe ? moneyShort(conteos()[e.value].importe) : '—' }}</span>
                </button>
              }
            </div>
          </div>
        }
      </nav>
      <p class="so-stage-note">{{ notaEtapa() }}</p>
      }

      <div class="card-premium card-flat so-card">
        <!-- Filtros secundarios pegados a la tabla que filtran, no flotando mid-page. -->
        <div class="so-tools">
          <div class="so-field"><label for="so-f-suc">Sucursales</label>
            <p-multiselect inputId="so-f-suc" [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code"
                           placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queue()" /></div>
          @if (grupoOpts().length) {
            <div class="so-field"><label for="so-f-grp">Grupo de gasto</label>
              <p-multiselect inputId="so-f-grp" [options]="grupoOpts()" [(ngModel)]="grupo" optionLabel="label" optionValue="code"
                             placeholder="Todos" [showClear]="true" [filter]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queue()" /></div>
          }
          <div class="so-field"><label for="so-f-min">Desde</label>
            <p-inputnumber inputId="so-f-min" [(ngModel)]="minImporte" mode="currency" currency="MXN" locale="es-MX"
                           [min]="0" placeholder="$0" styleClass="so-min" (onBlur)="queue()" /></div>
          <div class="so-field"><label for="so-f-sol">Solicitante</label>
            <p-select inputId="so-f-sol" [options]="solicitantes()" [(ngModel)]="solicitante" [showClear]="true" placeholder="Todos"
                      appendTo="body" (onChange)="queue()" styleClass="w-full" [filter]="true" /></div>
          <div class="so-field so-grow"><label for="so-f-q">Buscar</label>
            <input id="so-f-q" pInputText [(ngModel)]="search" placeholder="Folio, beneficiario, concepto…" (keyup.enter)="load()" (blur)="queue()" /></div>
          @if (soloAnejas()) {
            <button type="button" class="so-chip" (click)="quitarAnejas()">
              <i class="pi pi-clock" aria-hidden="true"></i> Sólo +90 días
              <i class="pi pi-times so-chip-x" aria-hidden="true"></i>
            </button>
          }
          @if (!loading() && visibles().length) {
            <span class="so-count">{{ visibles().length }} {{ visibles().length === 1 ? 'fila' : 'filas' }}@if (visibles().length !== rows().length) { <span class="so-count-of"> de {{ rows().length }}</span> }</span>
          }
        </div>

        <!-- §2 matriz de estados: cargando (filas skeleton) / vacío (con salida) / error
             son tres cosas distintas. Un periodo sin movimiento NO es una falla. -->
        <app-load-state [class.is-busy]="loading() && !primeraCarga()" [attr.aria-busy]="loading() || null"
                        [loading]="primeraCarga()" [error]="error()" [isEmpty]="!visibles().length"
                        [skeletonRows]="8" emptyIcon="pi-inbox"
                        [emptyTitle]="emptyTitle()"
                        [emptyHint]="emptyHint()" [emptyCta]="emptyCta()" emptyCtaIcon="pi pi-arrows-h"
                        (retry)="load()" (cta)="onEmptyCta()">
          <p-table [value]="visibles()" styleClass="p-datatable-sm so-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                   [paginator]="visibles().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                   sortField="fecha" [sortOrder]="-1">
            <ng-template #header>
              <tr>
                <th pSortableColumn="folio" style="width:9rem">Folio <p-sorticon field="folio" /></th>
                <th pSortableColumn="fecha" style="width:6rem">Fecha <p-sorticon field="fecha" /></th>
                <th pSortableColumn="solicitante" style="width:9rem">Solicitante <p-sorticon field="solicitante" /></th>
                <th style="width:11rem">Beneficiario</th>
                <th>Concepto</th>
                <th class="ta-r" pSortableColumn="importe" style="width:9rem">Importe <p-sorticon field="importe" /></th>
                <th class="ta-r" style="width:4.5rem" title="Días desde la fecha del documento en Kepler">Días</th>
                <th style="width:7.5rem">Gasto</th>
                <th class="ta-r" style="width:3.5rem"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <!-- La fila entera abre el expediente (atajo de mouse). El acceso real —el
                   que existe para teclado y lector— es el folio: es el identificador de la
                   entidad, que es donde el patrón de tabla espera el enlace. -->
              <tr class="so-row" (click)="verExpediente(r)">
                <td>
                  <button type="button" class="so-folio num strong" (click)="$event.stopPropagation(); verExpediente(r)"
                          [attr.aria-label]="'Abrir el expediente de la solicitud ' + r.folio">{{ r.folio }}</button>
                  <span class="so-cell-meta">{{ r.sucursal_nombre || r.sucursal }}</span>
                </td>
                <td class="num muted">{{ dmy(r.fecha) }}</td>
                <td>{{ r.solicitante || '—' }}</td>
                <td>
                  {{ r.acreedor || r.beneficiario || '—' }}
                  @if (r.cuenta_grupo) { <span class="so-grp" [title]="'Cuenta Kepler ' + r.cuenta_clave">{{ r.cuenta_grupo }}</span> }
                </td>
                <td class="muted"><span class="so-trunc" [title]="r.concepto || ''">{{ r.concepto || '—' }}</span></td>
                <td class="ta-r num strong">{{ money(r.importe) }}</td>
                <!-- Antigüedad. Es aproximada a propósito: Kepler no guarda cuándo cambió
                     de etapa, sólo la fecha del documento. Se marca lo añejo. -->
                <td class="ta-r num" [class.is-viejo]="esViejo(r)" [attr.title]="esViejo(r) ? 'Lleva ' + edad(r) + ' días — más de 90' : null">{{ edad(r) ?? '—' }}</td>

                <!-- El gasto que ejerció la solicitud es un DATO (y su liga al detalle de
                     egresos), no una acción. Antes se disfrazaba de botón en la columna de
                     acciones, que es donde va lo que hay que hacer, no lo que ya pasó. -->
                <td>
                  @if (r.gasto_folio) {
                    <button type="button" class="so-link num" (click)="$event.stopPropagation(); verGasto(r)"
                            [attr.aria-label]="'Abrir el gasto ' + r.gasto_folio">{{ r.gasto_folio }}</button>
                    @if (r.lead_days != null) { <span class="so-cell-meta tnum">{{ leadTexto(r.lead_days) }}</span> }
                  } @else { <span class="faint">—</span> }
                </td>

                <!-- Lo único que va acá es lo que HAY QUE HACER, en icono, revelado al pasar
                     por la fila (§datos densos 5). Ver el expediente ya lo hace la fila, así
                     que no se repite; y una etapa sin acción propia no inventa un botón. -->
                <td class="ta-r">
                  @switch (etapaDeFila(r)) {
                    @case ('capturar') {
                      <button type="button" class="so-act" (click)="$event.stopPropagation(); capturar(r)"
                              title="Capturar el expediente" [attr.aria-label]="'Capturar el expediente de ' + r.folio">
                        <i class="pi pi-upload" aria-hidden="true"></i>
                      </button>
                    }
                    @case ('validar') {
                      <button type="button" class="so-act is-on" (click)="$event.stopPropagation(); verExpediente(r)"
                              title="Revisar y resolver" [attr.aria-label]="'Revisar el expediente de ' + r.folio">
                        <i class="pi pi-check-square" aria-hidden="true"></i>
                      </button>
                    }
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </div>
    </div>

    <!-- Expediente: Kepler + evidencia + decisión, sin perder la lista. -->
    <app-expense-evidence-peek [open]="peekOpen()" (openChange)="peekOpen.set($event)"
                               [solicitud]="sel()" [proofId]="selProofId()" [puedeResolver]="puedeResolver()"
                               [comprobacionEnKepler]="selTieneComprobacion()"
                               (resolved)="trasResolver()" (attach)="adjuntar(sel()!)" />

    <!-- Captura: sólo los archivos. Todo lo demás lo pone Kepler. -->
    <app-expense-evidence-dialog [open]="dlgOpen()" (openChange)="dlgOpen.set($event)"
                                 [solicitud]="sel()" (saved)="trasAdjuntar($event)" />
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }

    /* ── Head ───────────────────────────────────────────────────────────── */
    .so-title { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .so-head-right { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); padding-bottom: var(--sp-1); }
    .so-scope { display: inline-flex; align-items: center; gap: var(--sp-1); margin: var(--sp-1) 0 0;
      font-size: var(--fs-xs); color: var(--fg-2); }
    .so-scope.is-warn { color: var(--warn-fg); }
    .so-live { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--ok-fg); }
    .so-live i { font-size: var(--fs-nano); }
    /* Estado del dato: en vivo, qué tan fresco, y recargar. Es un grupo, y se separa de
       las lentes con un hairline en vez de con más aire (Gestalt, y ahorra ancho). */
    .so-freshness { display: inline-flex; align-items: center; gap: var(--sp-2);
      padding-right: var(--sp-3); border-right: 1px solid var(--border-color); }
    :host ::ng-deep .so-refresh { width: 1.9rem; min-width: 1.9rem; height: 1.9rem; padding: 0; }
    @media (pointer: coarse) {
      :host ::ng-deep .so-refresh { width: var(--tap-min); min-width: var(--tap-min); height: var(--tap-min); }
    }
    /* Cuando el head se apila, el divisor separa de la nada. */
    @media (max-width: 760px) { .so-freshness { padding-right: 0; border-right: 0; } }

    /* ── Nivel 1: la lectura del periodo ────────────────────────────────
       Texto, no caja. La jerarquía la dan el tipo y el contraste, no un panel con
       borde (Q.5). El .tw-verdict con ícono se quedó en las pantallas de cuadre,
       donde el veredicto SÍ es binario; acá no lo es. */
    .so-lead { margin: var(--sp-3) 0 0; max-width: 80ch; font-size: var(--fs-body);
      color: var(--fg-1); line-height: 1.5; }
    .so-lead-m { color: var(--fg-2); }
    .so-drill { border: 0; background: none; padding: 0; font: inherit; font-weight: var(--fw-bold);
      color: var(--action); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .so-drill:hover { color: var(--action-hover); }
    .so-drill:active { color: var(--action-press); }
    .so-drill:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    /* Reserva el alto de lo que viene mientras carga: sin esto la tabla salta (CLS). */
    p-skeleton { display: block; }
    .so-sk-lead { margin: var(--sp-3) 0 var(--sp-2); max-width: 46rem; }
    .so-sk-funnel { margin-bottom: var(--sp-3); border-radius: var(--r-md); }

    /* ── Nivel 2: el embudo. Es el encabezado de KPIs Y la navegación ────
       Gramática de MetricStrip (ADR-033): cero caja por métrica, hairline entre
       bloques, cifra Geist mono tabular, etiqueta micro. La elevación es el borde
       1px del contenedor, sin sombra (datos densos 1). Lleva caja porque además de
       informar es un control: un radiogroup. */
    .so-funnel { display: flex; flex-wrap: wrap; margin: var(--sp-3) 0 var(--sp-2);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      background: var(--card-bg); overflow: hidden; }
    .so-fgroup { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0;
      border-right: 1px solid var(--border-color); }
    .so-fgroup:last-child { border-right: 0; }
    .so-fgroup-l { padding: var(--sp-2) var(--sp-3) 0; font-size: var(--fs-nano);
      font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .08em; color: var(--fg-3); }
    .so-fitems { display: flex; flex: 1; }
    .so-fitem { flex: 1 1 0; min-width: 6.75rem; display: flex; flex-direction: column; gap: 1px;
      padding: var(--sp-1) var(--sp-3) var(--sp-3); border: 0; border-bottom: 2px solid transparent;
      background: none; font: inherit; text-align: left; cursor: pointer;
      transition: background-color var(--dur-short) var(--ease-standard); }
    .so-fitem:hover:not(.on) { background: var(--overlay-hover); }
    .so-fitem.on { background: var(--overlay-selected); border-bottom-color: var(--action); }
    .so-fitem:focus-visible { outline: 2px solid var(--action-ring); outline-offset: -2px; }
    .so-fn { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--fg-1); line-height: 1.15; }
    /* Etapa vacía = terciaria: si no hay nada que hacer ahí, no compite (Q.5). */
    .so-fitem.is-zero .so-fn { color: var(--fg-3); font-weight: var(--fw-medium); }
    .so-fl { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); }
    .so-fitem.on .so-fl { color: var(--fg-1); font-weight: var(--fw-medium); }
    .so-fm { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-xs); color: var(--fg-3); }
    @media (max-width: 900px) {
      .so-fgroup { flex: 1 1 100%; border-right: 0; border-bottom: 1px solid var(--border-color); }
      .so-fgroup:last-child { border-bottom: 0; }
    }

    /* Nivel 3: qué significa la etapa seleccionada. Explica la tabla que sigue (Q.2). */
    .so-stage-note { margin: 0 0 var(--sp-3); max-width: 96ch;
      font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.45; }

    /* ── Barra de herramientas de la tabla ──────────────────────────────── */
    /* .card-premium global trae padding + box-shadow; in-page la elevación es SOLO
       el borde (datos densos 1). La clase card-flat no está definida globalmente,
       así que la sombra se apaga acá con la especificidad suficiente para ganarle. */
    .card-premium.so-card { padding: 0; overflow: hidden; box-shadow: none; }
    .card-premium.so-card:hover { box-shadow: none; }
    .so-tools { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3);
      padding: var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .so-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .so-field > label, .so-field > .so-lbl { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .so-field.so-grow { flex: 1 1 14rem; }
    /* Chip del grupo de gasto: neutro, no compite con los tags de estado. */
    .so-grp { display: inline-block; margin-left: var(--sp-1); padding: 0 4px; font-family: var(--font-mono);
      font-size: var(--fs-nano); color: var(--fg-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .so-count-of { color: var(--fg-3); }
    :host ::ng-deep .so-min input { width: 7rem; }
    .so-count { margin-left: auto; align-self: center; font-size: var(--fs-xs); color: var(--fg-3);
      font-variant-numeric: tabular-nums; }
    app-load-state { display: block; padding: var(--sp-2) var(--sp-3) var(--sp-3);
      transition: opacity var(--dur-short) var(--ease-standard); }
    app-load-state.is-busy { opacity: .55; }

    /* ── Tabla ──────────────────────────────────────────────────────────── */
    .so-row { cursor: pointer; }
    .so-table th { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .04em; color: var(--fg-3); white-space: nowrap; }
    .so-table td { font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.3; }
    /* tabular-nums en TODA celda de cifra/folio/fecha: si no, las columnas no se leen
       como columnas (§datos densos 10). */
    .so-table .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* Números embebidos en texto: tabular sí, mono no (§datos densos 10). */
    .so-table .tnum { font-variant-numeric: tabular-nums; }
    .so-table .ta-r { text-align: right; }
    .so-table .strong { font-weight: var(--fw-bold); color: var(--fg-1); }
    .so-table .muted { color: var(--fg-2); }
    .so-table .faint { color: var(--fg-3); }
    .so-cell-meta { display: block; margin-top: 1px; font-size: var(--fs-xs); color: var(--fg-3); }
    .so-trunc { display: block; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Añejo: color + peso + el title de la celda, nunca sólo color. */
    .so-table td.is-viejo { color: var(--warn-fg); font-weight: var(--fw-bold); }

    /* El folio es el acceso al expediente: el identificador de la entidad es donde el
       patrón de tabla pone el enlace, y es el camino de teclado de la fila. */
    .so-folio { display: block; padding: 0; border: 0; background: none; font: inherit;
      font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold);
      color: var(--fg-1); text-align: left; cursor: pointer; }
    .so-link { padding: 0; border: 0; background: none; font: inherit; cursor: pointer; color: var(--fg-1);
      font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .so-folio:hover, .so-link:hover { color: var(--action); text-decoration: underline; text-underline-offset: 2px; }
    .so-folio:focus-visible, .so-link:focus-visible { outline: 2px solid var(--action-ring);
      outline-offset: 2px; border-radius: var(--r-sm); }

    /* Acción de fila: icono fantasma a la derecha (datos densos 5). Atenuada en reposo y
       plena al pasar por la fila — visible siempre, porque en una bandeja de trabajo la
       acción ES el motivo de la fila; esconderla del todo sería esconder el trabajo. */
    .so-act { display: inline-flex; align-items: center; justify-content: center;
      width: max(1.75rem, var(--tap-min)); height: max(1.75rem, var(--tap-min));
      border: 0; border-radius: var(--r-sm); background: none; color: var(--fg-2); cursor: pointer;
      opacity: .5; transition: opacity var(--dur-short) var(--ease-standard),
        background-color var(--dur-short) var(--ease-standard); }
    .so-row:hover .so-act, .so-row:focus-within .so-act { opacity: 1; }
    .so-act:hover { background: var(--overlay-hover); color: var(--fg-1); }
    .so-act:focus-visible { opacity: 1; outline: 2px solid var(--action-ring); outline-offset: -1px; }
    @media (pointer: coarse) { .so-act { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .so-act { transition: none; } }

    /* Lente activa: se ve, y se quita desde donde se aplicó. */
    .so-chip { display: inline-flex; align-items: center; gap: var(--sp-1); align-self: center;
      min-height: max(1.6rem, var(--tap-min)); padding: 2px var(--sp-2);
      border: 1px solid var(--warn-border); border-radius: var(--r-pill); background: none;
      font: inherit; font-size: var(--fs-xs); color: var(--warn-fg); cursor: pointer; }
    .so-chip:hover { background: var(--overlay-hover); }
    .so-chip:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .so-chip-x { font-size: var(--fs-nano); }

  `],
})
export class FinanzasSolicitudesComponent {
  readonly tabs = FINANZAS_TABS;
  private readonly svc = inject(ComercialService);
  private readonly comprobaciones = inject(ComprobacionesService);
  private readonly compGastos = inject(ComprobacionGastosService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly report = signal<ExpenseRequestsReport | null>(null);
  readonly proofStatus = signal<Record<string, ProofByFolio>>({});
  readonly compStatus = signal<Record<string, string>>({});

  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  /** Primera carga = cargando y todavía sin nada en pantalla. Un refresh no vacía la vista. */
  readonly primeraCarga = computed(() => this.loading() && !this.report());

  /** Estado de la evidencia de una solicitud: comprobante propio, o comprobación del gasto. */
  private evidenciaDe(folio: string): string {
    return this.proofStatus()[folio]?.status || this.compStatus()[folio] || 'sin';
  }

  /**
   * En qué etapa está una solicitud. El orden de las reglas importa: cada fila cae en UNA
   * y sólo una. Cancelada gana sobre todo (es terminal, aunque Kepler tenga 102 canceladas
   * con gasto aplicado).
   */
  private etapaDe(r: ExpenseRequestRow): Exclude<Etapa, 'todas'> {
    if (r.estado === 'C') return 'canceladas';
    if (!r.aplicada) return r.estado === 'N' ? 'autorizar' : 'ejercer';

    const p = this.proofStatus()[r.folio];
    // Sin expediente todavía, o devuelto: el capturista debe (re)capturar la solicitud.
    if (!p || p.status === 'rechazada') return 'capturar';
    // Falta la solicitud firmada (obligatoria siempre): sin ella no se aprueba → sigue en
    // captura (evita el desacuerdo tablero-vs-peek en expedientes legacy).
    if (p.solicitud === false) return 'capturar';
    // Ya validada → cerrado.
    if (p.status === 'validada') return 'completo';
    // Aprobado y comprobable pero SIN evidencia todavía: le toca al capturista subirla
    // (segundo momento, en «Capturar gasto»).
    if (p.status === 'aprobada' && p.requiere_evidencia && p.comprobante === false) return 'capturar';
    // recibida (por aprobar) / revision (por validar): le toca al aprobador.
    return 'validar';
  }

  /** Cuántas y cuánto hay en cada etapa, sobre lo cargado. Es el embudo, y se ve siempre. */
  readonly conteos = computed(() => {
    const acc: Record<string, { n: number; importe: number }> = {};
    for (const d of this.etapasDef) acc[d.value] = { n: 0, importe: 0 };
    for (const r of this.rows()) {
      const k = this.etapaDe(r);
      acc[k].n++; acc[k].importe += Number(r.importe) || 0;
      acc['todas'].n++; acc['todas'].importe += Number(r.importe) || 0;
    }
    return acc;
  });

  /** Sólo la etapa elegida: separar es justamente no entrelazar. */
  readonly visibles = computed(() => {
    const e = this.etapa();
    let rows = this.rows();
    if (e !== 'todas') rows = rows.filter((r) => this.etapaDe(r) === e);
    if (this.soloAnejas()) rows = rows.filter((r) => this.esViejo(r));
    return rows;
  });

  /** Antigüedad de la solicitud en días. Aproximada: Kepler no guarda cuándo cambió de etapa. */
  edad(r: ExpenseRequestRow): number | null {
    if (!r.fecha) return null;
    const m = String(r.fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    return Math.round((hoy.getTime() - d.getTime()) / 86400000);
  }
  /** La etapa de una fila, para la plantilla. */
  etapaDeFila(r: ExpenseRequestRow): string { return this.etapaDe(r); }
  /** Añejo = más de 90 días en una etapa que debería haber avanzado. */
  esViejo(r: ExpenseRequestRow): boolean {
    const e = this.etapaDe(r);
    if (e === 'completo' || e === 'canceladas') return false;
    const d = this.edad(r);
    return d != null && d > 90;
  }
  /** Añejas del PERIODO, no de la etapa: es deuda que hay que ver estés donde estés. */
  readonly viejasPeriodo = computed(() => {
    const r = this.rows().filter((x) => this.esViejo(x));
    return { n: r.length, importe: r.reduce((a, b) => a + (Number(b.importe) || 0), 0) };
  });

  /**
   * Nivel 1 de la jerarquía (Q.5): la lectura del periodo, en una frase. Es `computed` y no
   * método de template a propósito — el mismo error que ya estaba documentado en `kpiItems`.
   */
  readonly lead = computed(() => {
    const c = this.conteos();
    const tot = c['todas'];
    if (!tot?.n) return `Sin solicitudes ${this.periodoEn()}.`;
    const abiertas = ABIERTAS.reduce((a, k) => ({ n: a.n + (c[k]?.n || 0), m: a.m + (c[k]?.importe || 0) }), { n: 0, m: 0 });
    if (!abiertas.n) return `Las ${tot.n} solicitudes ${this.periodoDe()} (${money(tot.importe)}) están cerradas: no hay nada pendiente.`;
    return `De ${tot.n} solicitudes ${this.periodoDe()} (${money(tot.importe)}), ${abiertas.n} siguen abiertas por ${money(abiertas.m)}.`;
  });
  /** Cola de la lectura: sólo si hay algo ya ejercido de qué promediar. */
  readonly leadProceso = computed(() => {
    const leads = this.rows().map((x) => x.lead_days).filter((d): d is number => d != null);
    if (!leads.length) return '';
    const avg = leads.reduce((a, b) => a + b, 0) / leads.length;
    return ` Las ya ejercidas tardaron ${avg.toFixed(1)} días en promedio desde que se pidieron.`;
  });
  /** Nivel 3: qué significa la etapa que está seleccionada — explica la tabla de abajo. */
  readonly notaEtapa = computed(() => {
    const base: Record<string, string> = {
      autorizar: `Pedidas y todavía sin autorizar en Kepler. La autorización se hace allá; acá se ven para no perderlas.`,
      ejercer: `Ya autorizadas, pero todavía sin el gasto que las ejerza.`,
      capturar: `Le toca al capturista, en «Capturar gasto»: registrar la solicitud (subir la firmada + clasificarla), o —si ya se aprobó y es comprobable— subir la evidencia.`,
      validar: `Le toca al aprobador: aprobar la solicitud recién capturada, o validar la evidencia que quedó en revisión.`,
      completo: `Expediente cerrado: validado con su evidencia — o declarado no comprobable con motivo.`,
      canceladas: `Canceladas en Kepler. El importe queda en cero al cancelar.`,
      todas: `Todas las etapas juntas, en orden de fecha.`,
    };
    const cola = this.soloAnejas() ? ' Mostrando sólo lo que lleva más de 90 días — la antigüedad se cuenta desde la fecha del documento, que es lo único que Kepler guarda.' : '';
    return base[this.etapa()] + cola;
  });
  /**
   * Opciones de grupo derivadas de lo cargado, etiquetadas con el acreedor más común del
   * grupo: la etiqueta sale del dato, no de una taxonomía inventada.
   */
  readonly grupoOpts = computed(() => {
    const by = new Map<string, Map<string, number>>();
    for (const r of this.rows()) {
      const g = r.cuenta_grupo;
      if (!g) continue;
      if (!by.has(g)) by.set(g, new Map());
      const m = by.get(g)!;
      const k = r.acreedor || r.beneficiario || '';
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
    return Array.from(by.entries()).map(([g, m]) => {
      const top = Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
      const n = Array.from(m.values()).reduce((a, b) => a + b, 0);
      return { code: g, label: top ? `${g} · ${top[0].slice(0, 28)} (${n})` : `${g} (${n})` };
    }).sort((a, b) => a.code.localeCompare(b.code));
  });
  readonly error = signal<string | null>(null);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly solicitantes = signal<string[]>([]);
  /** Eje de EVIDENCIA: lo único que la plataforma agrega sobre Kepler. Se filtra en el
   *  cliente porque el mapa folio→estado ya viene completo, no por página. */
  readonly etapa = signal<Etapa>('autorizar');
  /** Grupo de gasto (prefijo de la cuenta Kepler) y piso de importe: van al servidor. */
  grupo: string[] = [];
  minImporte: number | null = null;
  readonly periodo = signal<Periodo>('hoy');
  /** Alcance: mías o de toda la empresa. Es una lente, no un filtro más. */
  readonly mias = signal(false);
  /** Lente sobre lo cargado: sólo lo añejo. Es el destino del número del encabezado (Q.4). */
  readonly soloAnejas = signal(false);
  /** Cuándo se trajo esto de Kepler. La vista es viva; hay que poder ver si está fresca. */
  readonly lastLoaded = signal<Date | null>(null);
  /** Contra qué resuelve "mío" este usuario, según el backend. */
  readonly miScope = computed(() => this.report()?.mi_scope ?? { keys: [], areas: 0, nombre: null });
  /** Sin anclas no hay "mío" posible: el control se apaga y se dice por qué. */
  readonly sinAnclas = computed(() => !this.miScope().keys.length);
  /** Qué está tomando como "mío", en llano — para que nadie adivine qué está viendo. */
  miScopeTexto(): string {
    const m = this.miScope();
    const partes: string[] = [];
    if (m.nombre) partes.push(m.nombre);
    if (m.areas) partes.push(`${m.areas} ${m.areas === 1 ? 'área asignada' : 'áreas asignadas'}`);
    return partes.join(' + ');
  }

  readonly alcanceOpts = [{ label: 'Mías', value: 'mias' }, { label: 'Todas', value: 'todas' }];
  readonly periodoOpts = [
    { label: 'Hoy', value: 'hoy' }, { label: '7 días', value: 'd7' },
    { label: '30 días', value: 'd30' }, { label: 'Rango', value: 'rango' },
  ];
  /**
   * Orden = el recorrido del dinero, en tres bloques: lo que se resuelve en Kepler, lo que
   * nos toca a nosotros, y lo cerrado. `todas` va al final como salida, no como default.
   */
  readonly gruposEtapa: { label: string; etapas: { value: Etapa; label: string }[] }[] = [
    { label: 'En Kepler', etapas: [
      { value: 'autorizar', label: 'Por autorizar' },
      { value: 'ejercer', label: 'Por ejercer' },
    ] },
    { label: 'Expediente', etapas: [
      { value: 'capturar', label: 'Por capturar' },
      { value: 'validar', label: 'Por validar' },
    ] },
    { label: 'Cerradas', etapas: [
      { value: 'completo', label: 'Completo' },
      { value: 'canceladas', label: 'Canceladas' },
      { value: 'todas', label: 'Todas' },
    ] },
  ];
  /** Plano, derivado del agrupado: las etapas se declaran UNA vez. */
  readonly etapasDef: { value: Etapa; label: string }[] = this.gruposEtapa.flatMap((g) => g.etapas);

  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly socket = inject(ExpenseProofsSocketService);
  readonly liveConnected = this.socket.connected;

  sucursal: string[] = [];
  solicitante: string | null = null;
  search = '';
  /** Solo se usa cuando el periodo es `rango`. Arranca en 30 días: entrar al modo
   *  manual no debería costar más que el preset del que venís. */
  rangeDates: Date[] = [(() => { const d = new Date(); d.setDate(d.getDate() - 29); return d; })(), new Date()];
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly money = money;
  readonly moneyShort = moneyShort;
  readonly dmy = dmy;

  constructor() {
    // Estado en la URL (§Ing.UI 9): recargar o compartir el link conserva lo que se veía.
    const qp = this.route.snapshot.queryParamMap;
    const p = qp.get('periodo');
    if (p === 'hoy' || p === 'd7' || p === 'd30' || p === 'rango') this.periodo.set(p);
    const et = qp.get('etapa');
    if (et && this.etapasDef.some((x) => x.value === et)) this.etapa.set(et as Etapa);
    if (qp.get('mias') === '1') this.mias.set(true);
    if (qp.get('anejas') === '1') this.soloAnejas.set(true);

    this.svc.expensesSucursales().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((rows) => this.sucursales.set(rows.map((s) => ({ code: s.code, label: s.name ? `${s.code} · ${s.name}` : s.code }))));
    this.svc.expensesFilters().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((f) => this.solicitantes.set(f.areas || []));
    this.refreshProofs();
    this.compGastos.statusBySolicitud().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((m) => this.compStatus.set(m || {}));
    this.load();
    // Realtime: si otro sube o resuelve un comprobante, esta lista se entera sola.
    this.socket.connect();
    this.socket.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.refreshProofs());
    this.destroyRef.onDestroy(() => this.socket.disconnect());
  }

  private refreshProofs(): void {
    this.comprobaciones.statusByFolio().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((m) => this.proofStatus.set(m || {}));
  }

  // ── Periodo ────────────────────────────────────────────────────────────
  setAlcance(v: string) { this.mias.set(v === 'mias'); this.syncUrl(); this.load(); }
  setPeriodo(v: string) { this.periodo.set(v as Periodo); this.syncUrl(); this.load(); }
  setEtapa(v: Etapa) { this.etapa.set(v); this.syncUrl(); }
  /** Q.4 — el número añejo del encabezado lleva a verlo, con el filtro ya puesto. */
  verAnejas() { this.soloAnejas.set(true); this.etapa.set('todas'); this.syncUrl(); }
  quitarAnejas() { this.soloAnejas.set(false); this.syncUrl(); }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge',
      queryParams: { periodo: this.periodo(), etapa: this.etapa(), mias: this.mias() ? '1' : null,
        anejas: this.soloAnejas() ? '1' : null },
    });
  }

  /** Rango efectivo: preset compartido, o lo que diga el datepicker en modo `rango`. */
  private rango(): { from?: string; to?: string } {
    const fmt = (d?: Date) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
    if (this.periodo() === 'rango') {
      const [a, b] = this.rangeDates || [];
      return { from: fmt(a), to: fmt(b) };
    }
    const r = datePresetRange(this.periodo());
    return { from: fmt(r?.from), to: fmt(r?.to) };
  }

  /** "de <periodo>" — para "las 5 solicitudes DE hoy". */
  periodoDe(): string {
    const { from, to } = this.rango();
    switch (this.periodo()) {
      case 'hoy': return `de hoy (${dmy(from)})`;
      case 'd7': return 'de los últimos 7 días';
      case 'd30': return 'de los últimos 30 días';
      default: return from && to ? `del ${dmy(from)} al ${dmy(to)}` : 'del rango elegido';
    }
  }
  /** "en <periodo>" — para "ninguna solicitud registrada EN los últimos 7 días". */
  periodoEn(): string {
    const { from, to } = this.rango();
    switch (this.periodo()) {
      case 'hoy': return `hoy (${dmy(from)})`;
      case 'd7': return 'en los últimos 7 días';
      case 'd30': return 'en los últimos 30 días';
      default: return from && to ? `del ${dmy(from)} al ${dmy(to)}` : 'en el rango elegido';
    }
  }

  /** ¿Lo vació el filtro de evidencia y no el periodo? La salida es distinta. */
  private vacioPorEtapa(): boolean { return !!this.rows().length && !this.visibles().length; }
  etapaLabel(): string { return this.etapasDef.find((e) => e.value === this.etapa())?.label || ''; }
  emptyTitle(): string {
    if (this.mias() && this.sinAnclas()) return 'No sabemos cuáles son tuyas';
    return this.vacioPorEtapa() ? `Nada en "${this.etapaLabel()}"` : `Sin solicitudes ${this.periodoEn()}`;
  }
  emptyCta(): string | null {
    if (this.mias() && this.sinAnclas()) return 'Ver todas';
    return this.vacioPorEtapa() ? 'Ver todas las etapas' : this.ampliarLabel();
  }
  onEmptyCta(): void {
    if (this.mias() && this.sinAnclas()) { this.setAlcance('todas'); return; }
    if (this.vacioPorEtapa()) this.setEtapa('todas'); else this.ampliar();
  }

  /** Empty ≠ error: el periodo puede estar limpio. La salida es ampliar, no reintentar. */
  emptyHint(): string {
    if (this.mias() && this.sinAnclas()) {
      return 'Nadie te asignó áreas de gasto y tu nombre no aparece como solicitante en Kepler. ' +
        'Un administrador puede configurarlo en Usuarios → áreas de gasto visibles.';
    }
    if (this.vacioPorEtapa()) {
      return `Las ${this.rows().length} solicitudes ${this.periodoEn()} están en otra etapa.`;
    }
    const base = `Ninguna solicitud registrada ${this.periodoEn()}`;
    const filtros = this.solicitante || this.search.trim() || this.sucursal.length || this.grupo.length || this.minImporte;
    return filtros ? `${base} con los filtros puestos.` : `${base}. El feed de Kepler las carga conforme se capturan.`;
  }
  /** Escalera de salida del vacío: hoy → 7 → 30 → 90 días. */
  ampliarLabel(): string | null {
    return ({ hoy: 'Ampliar a 7 días', d7: 'Ampliar a 30 días', d30: 'Ampliar a 90 días' } as Record<string, string>)[this.periodo()] || null;
  }
  ampliar(): void {
    if (this.periodo() === 'd30') {
      const d = new Date(); const from = new Date(); from.setDate(d.getDate() - 89);
      this.rangeDates = [from, d];
      this.setPeriodo('rango');
      return;
    }
    this.setPeriodo(this.periodo() === 'hoy' ? 'd7' : 'd30');
  }

  queue() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 300); }

  load() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const { from, to } = this.rango();
    this.loading.set(true);
    this.error.set(null);
    this.svc.expenseRequests({
      from, to,
      sucursal: this.sucursal,
      solicitante: this.solicitante || undefined, search: this.search || undefined,
      mias: this.mias() || undefined,
      grupo: this.grupo.length ? this.grupo : undefined,
      min_importe: this.minImporte || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.report.set(r); this.lastLoaded.set(new Date()); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las solicitudes de gasto.'); this.loading.set(false); },
      });
  }


  /** Validar y rechazar exigen el mismo permiso que el backend pide para esas rutas:
   *  FINANCE_EXPENSES_COMPROBAR, que hoy tiene una sola persona (Tesorería). */
  readonly puedeResolver = computed(() => this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.FINANCE_EXPENSES_COMPROBAR] === true);

  // ── Expediente y captura, en la misma pantalla ───────────────────────────
  // Antes esto vivía en /finanzas/comprobaciones: una bandeja aparte que volvía a pedir
  // lo que Kepler ya tiene. Acá la fila ES la bandeja; el detalle y la captura son
  // organismos que se abren encima.
  readonly sel = signal<ExpenseRequestRow | null>(null);
  readonly peekOpen = signal(false);
  readonly dlgOpen = signal(false);
  readonly selProofId = computed(() => {
    const f = this.sel()?.folio;
    return f ? (this.proofStatus()[f]?.id ?? null) : null;
  });
  readonly selTieneComprobacion = computed(() => {
    const f = this.sel()?.folio;
    return !!f && !!this.compStatus()[f];
  });

  verExpediente(r: ExpenseRequestRow) { this.sel.set(r); this.peekOpen.set(true); }
  adjuntar(r: ExpenseRequestRow) { this.sel.set(r); this.peekOpen.set(false); this.dlgOpen.set(true); }
  /**
   * Acción de la etapa "capturar". Sin expediente (o devuelto) → abre el diálogo para
   * capturar la solicitud (crea 'recibida'). Si ya hay expediente vivo (p.ej. aprobado y
   * esperando evidencia), NO se dialoga —crearía una fila duplicada—: se abre el peek, y
   * la evidencia la sube el capturista en «Capturar gasto».
   */
  capturar(r: ExpenseRequestRow) {
    const p = this.proofStatus()[r.folio];
    if (p && p.status !== 'rechazada') { this.verExpediente(r); return; }
    this.adjuntar(r);
  }

  trasResolver() {
    this.toast.add({ severity: 'success', summary: 'Resuelto', detail: `Solicitud ${this.sel()?.folio ?? ''}` });
    this.refreshProofs();
  }
  trasAdjuntar(folio: string) {
    this.toast.add({ severity: 'success', summary: 'Evidencia adjuntada', detail: `Solicitud ${folio}` });
    this.refreshProofs();
  }

  leadTexto(d: number): string { return d === 0 ? 'el mismo día' : `en ${d} ${d === 1 ? 'día' : 'días'}`; }

  /** Abre el gasto ligado en el detalle de egresos. */
  verGasto(r: ExpenseRequestRow) {
    if (!r.gasto_folio) return;
    this.router.navigate(['/finanzas/egresos/detalle'], {
      queryParams: { type: 'beneficiario', key: r.beneficiario || '', label: r.beneficiario || '',
        doc_sucursal: r.sucursal, doc_tipo: 'XA1001', doc_folio: r.gasto_folio },
    });
  }

}
