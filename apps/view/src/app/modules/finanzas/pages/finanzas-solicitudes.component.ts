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
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
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

/** Periodos que ofrece el head. `rango` revela el datepicker. */
type Periodo = 'hoy' | 'd7' | 'd30' | 'rango';

/**
 * Etapa del ciclo. Es UNA sola, excluyente, y reemplaza a los tres ejes que antes se
 * mostraban entrelazados (estatus del documento + aplicación + evidencia): dentro de una
 * etapa esos tres valen siempre lo mismo, así que como columna no informaban nada.
 */
type Etapa = 'autorizar' | 'ejercer' | 'comprobar' | 'validar' | 'cerradas' | 'canceladas' | 'todas';

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
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule, SelectModule, DatePickerModule, InputTextModule, InputNumberModule, SkeletonModule, ButtonModule, ToastModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent, ExpenseEvidencePeekComponent, ExpenseEvidenceDialogComponent],
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
          @if (liveConnected()) { <span class="so-live"><i class="pi pi-circle-fill" aria-hidden="true"></i> En vivo</span> }
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
        <p-skeleton height="4.4rem" styleClass="so-sk-head" />
      } @else if (report(); as r) {
        @if (r.kpis.total > 0) {
          <!-- Q.1 — la conclusión del periodo antes que el grid. Q.2 — con su lectura
               en llano. Q.4 — el número que evidencia el problema lleva a filtrarlo. -->
          <!-- Q.1 — la conclusión de la ETAPA que se está mirando, no del total. -->
          <div class="tw-verdict" [class.ok]="!hayPendiente()" [class.bad]="hayPendiente()">
            <i class="pi" [class.pi-check-circle]="!hayPendiente()" [class.pi-exclamation-circle]="hayPendiente()" aria-hidden="true"></i>
            <div>
              <h3>{{ tituloEtapa() }}</h3>
              <p class="so-read">{{ lecturaEtapa() }}</p>
            </div>
          </div>
          <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de solicitudes" />
        }
      }

      <!-- Una etapa a la vez. Antes el estatus del documento, la aplicación y la evidencia
           convivían como columnas y filtros sueltos: había que componerlos de cabeza para
           saber en qué punto estaba cada solicitud. -->
      <nav class="so-etapas" role="tablist" aria-label="Etapa del ciclo">
        @for (e of etapasDef; track e.value) {
          <button type="button" role="tab" [attr.aria-selected]="etapa() === e.value"
                  class="so-etapa" [class.on]="etapa() === e.value" (click)="setEtapa(e.value)">
            {{ e.label }}
            <span class="so-etapa-n">{{ conteos()[e.value].n }}</span>
            @if (conteos()[e.value].importe) { <span class="so-etapa-m">{{ moneyShort(conteos()[e.value].importe) }}</span> }
          </button>
        }
      </nav>

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
                <th class="ta-r" style="width:5rem" title="Días desde la fecha de la solicitud">Días</th>
                <th style="width:12rem">Acción</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td>
                  <span class="num strong">{{ r.folio }}</span>
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
                <td class="ta-r num" [class.is-viejo]="esViejo(r)">{{ edad(r) ?? '—' }}</td>

                <!-- Una acción, la de SU etapa. Antes había tres celdas de estado que dentro
                     de una etapa decían siempre lo mismo. -->
                <td>
                  @switch (etapaDeFila(r)) {
                    @case ('comprobar') {
                      <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="adjuntar(r)"
                              [attr.aria-label]="'Adjuntar la evidencia de ' + r.folio">
                        <span class="p-button-icon p-button-icon-left pi pi-upload" aria-hidden="true"></span>
                        <span class="p-button-label">Adjuntar evidencia</span>
                      </button>
                    }
                    @case ('validar') {
                      <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="verExpediente(r)"
                              [attr.aria-label]="'Revisar el comprobante de ' + r.folio">
                        <span class="p-button-icon p-button-icon-left pi pi-eye" aria-hidden="true"></span>
                        <span class="p-button-label">Revisar</span>
                      </button>
                    }
                    @case ('cerradas') {
                      <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="verExpediente(r)"
                              [attr.aria-label]="'Ver el expediente de ' + r.folio">
                        <span class="p-button-icon p-button-icon-left pi pi-file" aria-hidden="true"></span>
                        <span class="p-button-label num">{{ r.gasto_folio || 'Ver' }}</span>
                      </button>
                      @if (r.lead_days != null) { <span class="so-cell-meta tnum">{{ leadTexto(r.lead_days) }}</span> }
                    }
                    @default {
                      <!-- Autorizar y ejercer pasan en Kepler, no acá: no se inventa un botón. -->
                      @if (r.aplicada && r.gasto_folio) {
                        <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="verGasto(r)"
                                [attr.aria-label]="'Ver el gasto ' + r.gasto_folio">
                          <span class="p-button-icon p-button-icon-left pi pi-external-link" aria-hidden="true"></span>
                          <span class="p-button-label num">{{ r.gasto_folio }}</span>
                        </button>
                      } @else { <span class="faint">—</span> }
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

    /* ── Veredicto + KPIs ───────────────────────────────────────────────── */
    .tw-verdict p.so-read { font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45; }
    .so-drill { border: 0; background: none; padding: 0; font: inherit; font-weight: var(--fw-bold);
      color: var(--action); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .so-drill:hover { color: var(--action-hover); }
    .so-drill:active { color: var(--action-press); }
    .so-drill:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    app-metric-strip { display: block; margin-bottom: var(--sp-3); }
    /* Reserva el alto del veredicto mientras carga: sin esto la tabla salta (CLS). */
    p-skeleton { display: block; }
    .so-sk-head { margin-bottom: var(--sp-3); }

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

    /* ── Acciones de celda ──────────────────────────────────────────────
       El botón es de PrimeNG (.p-button-text): hover, active, disabled, foco y
       severity ya vienen tokenizados. Acá solo se ajusta la métrica para que
       entre en una fila densa — override de tamaño, no un botón nuevo. */
    .so-cellbtn { padding: 2px var(--sp-1); font-size: var(--fs-xs); }
    /* --tap-min vale 0px en puntero fino (densidad) y 44px en coarse: el fallback de
       var() NO aplica a un valor definido, así que el piso va con max(). */
    /* ── Barra de etapas: una a la vez ──────────────────────────────────
       Hairline, sin sombra, activo por superficie + ring (regla de elevación). */
    .so-etapas { display: flex; align-items: stretch; gap: 2px; margin: var(--sp-3) 0; padding: 3px;
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill);
      overflow-x: auto; scrollbar-width: none; }
    .so-etapas::-webkit-scrollbar { display: none; }
    .so-etapa { display: inline-flex; align-items: baseline; gap: var(--sp-1); white-space: nowrap;
      padding: var(--sp-1) var(--sp-3); border: 0; border-radius: var(--r-pill); background: none;
      font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-2); cursor: pointer;
      transition: color var(--dur-short) var(--ease-standard), background-color var(--dur-short) var(--ease-standard); }
    .so-etapa:hover:not(.on) { color: var(--fg-1); }
    .so-etapa.on { color: var(--fg-1); background: var(--card-bg); box-shadow: 0 0 0 1px var(--border-color); }
    .so-etapa:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .so-etapa-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .so-etapa-m { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-micro); color: var(--fg-3); }
    /* Añejo: el número se marca, con el texto del tooltip como portador extra. */
    .so-table td.is-viejo { color: var(--warn-fg); font-weight: var(--fw-bold); }

    /* El estado de evidencia ES el botón que abre el expediente. */
    .so-evbtn { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: max(1.5rem, var(--tap-min));
      padding: 0 2px; border: 0; background: transparent; font: inherit; cursor: pointer; }
    .so-evbtn:hover { background: var(--overlay-hover); border-radius: var(--r-sm); }
    .so-evbtn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; border-radius: var(--r-sm); }

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
    const e = this.evidenciaDe(r.folio);
    if (e === 'validada') return 'cerradas';
    if (e === 'recibida' || e === 'revision') return 'validar';
    return 'comprobar'; // sin evidencia, o rechazada (hay que volver a subirla)
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
    const rows = this.rows();
    return e === 'todas' ? rows : rows.filter((r) => this.etapaDe(r) === e);
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
    if (e === 'cerradas' || e === 'canceladas') return false;
    const d = this.edad(r);
    return d != null && d > 90;
  }
  /** Cuántas de la etapa actual llevan demasiado tiempo ahí. */
  readonly viejas = computed(() => {
    const r = this.visibles().filter((x) => this.esViejo(x));
    return { n: r.length, importe: r.reduce((a, b) => a + (Number(b.importe) || 0), 0) };
  });
  readonly hayPendiente = computed(() => {
    const e = this.etapa();
    return e !== 'cerradas' && e !== 'canceladas' && this.visibles().length > 0;
  });

  tituloEtapa(): string {
    const c = this.conteos()[this.etapa()];
    if (!c?.n) return `Nada en ${this.etapaLabel().toLowerCase()}`;
    const v = this.viejas();
    if (v.n) return `${v.n} ${v.n === 1 ? 'lleva' : 'llevan'} más de 90 días acá`;
    return `${c.n} ${c.n === 1 ? 'solicitud' : 'solicitudes'} · ${money(c.importe)}`;
  }
  lecturaEtapa(): string {
    const c = this.conteos()[this.etapa()];
    const per = this.periodoEn();
    const base: Record<string, string> = {
      autorizar: `Pedidas y todavía sin autorizar en Kepler. La autorización se hace allá; acá se ven para no perderlas.`,
      ejercer: `Ya autorizadas, pero todavía sin el gasto que las ejerza.`,
      comprobar: `El gasto ya se ejerció y falta subir el comprobante. Es la deuda de respaldo.`,
      validar: `Con comprobante subido, esperando que alguien lo revise contra el importe.`,
      cerradas: `Ejercidas y con el comprobante validado. No requieren nada.`,
      canceladas: `Canceladas en Kepler. El importe queda en cero al cancelar.`,
      todas: `Todas las etapas juntas.`,
    };
    const v = this.viejas();
    const cola = v.n ? ` ${v.n} ${v.n === 1 ? 'lleva' : 'llevan'} más de 90 días (${money(v.importe)}) — la antigüedad se mide desde la fecha del documento, que es lo único que Kepler guarda.` : '';
    return `${c?.n || 0} de ${per}, ${money(c?.importe || 0)}. ${base[this.etapa()]}${cola}`;
  }
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
  /** Orden = el recorrido del dinero. `todas` queda al final como salida, no como default. */
  readonly etapasDef: { value: Etapa; label: string }[] = [
    { value: 'autorizar', label: 'Por autorizar' },
    { value: 'ejercer', label: 'Por ejercer' },
    { value: 'comprobar', label: 'Por comprobar' },
    { value: 'validar', label: 'Por validar' },
    { value: 'cerradas', label: 'Cerradas' },
    { value: 'canceladas', label: 'Canceladas' },
    { value: 'todas', label: 'Todas' },
  ];

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

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge',
      queryParams: { periodo: this.periodo(), etapa: this.etapa(), mias: this.mias() ? '1' : null },
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
        next: (r) => { this.report.set(r); this.loading.set(false); },
        error: () => { this.error.set('No se pudieron cargar las solicitudes de gasto.'); this.loading.set(false); },
      });
  }

  /**
   * KPIs. `computed`, no método de template: recorre las filas, y llamarlo en cada ciclo
   * de detección devolvía un array nuevo que invalidaba el strip sin que cambiara nada.
   *
   * El 4º (días de proceso) aparece SOLO si hay solicitudes ya aplicadas en el periodo —
   * inventar una métrica que casi siempre sale en cero es peor que no tenerla.
   */
  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const r = this.report();
    if (!r) return [];
    const items: MetricStripItem[] = [
      { label: 'Solicitudes', value: r.kpis.total, sub: moneyShort(r.kpis.importe) },
      { label: 'Sin aplicar', value: r.kpis.pendientes, tone: r.kpis.pendientes ? 'bad' : 'default', sub: moneyShort(r.kpis.pendientes_importe) },
      { label: 'Aplicadas', value: r.kpis.aplicadas, tone: 'ok', sub: `${this.pct(r.kpis.aplicadas, r.kpis.total)}% del periodo` },
      { label: 'Añejas (+90d)', value: this.viejas().n, tone: this.viejas().n ? 'warn' : 'ok',
        sub: moneyShort(this.viejas().importe) },
    ];
    const leads = this.rows().map((x) => x.lead_days).filter((d): d is number => d != null);
    if (leads.length) {
      const avg = leads.reduce((a, b) => a + b, 0) / leads.length;
      items.push({ label: 'Días de proceso', value: avg, format: 'decimal1', sub: 'promedio solicitud → gasto' });
    }
    return items;
  });

  /** Validar y rechazar exigen el mismo permiso que el backend pide para esas rutas. */
  readonly puedeResolver = computed(() => this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.FINANCE_FINDINGS_GESTIONAR] === true);

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

  verExpediente(r: ExpenseRequestRow) { this.sel.set(r); this.peekOpen.set(true); }
  adjuntar(r: ExpenseRequestRow) { this.sel.set(r); this.peekOpen.set(false); this.dlgOpen.set(true); }

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

  pct(a: number, b: number): number { return b ? Math.round((a / b) * 100) : 0; }
}
