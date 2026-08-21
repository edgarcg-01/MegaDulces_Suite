import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SkeletonModule } from 'primeng/skeleton';
import { ButtonModule } from 'primeng/button';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FINANZAS_TABS } from '../finanzas-tabs';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ComercialService, ExpenseRequestRow, ExpenseRequestsReport } from '../../comercial/comercial.service';
import { ComprobacionesService, ProofByFolio } from '../comprobaciones.service';
import { ExpenseProofsSocketService } from '../expense-proofs-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import { ComprobacionGastosService } from '../comprobacion-gastos.service';
import { datePresetRange, money, moneyShort } from '../../../shared/util';
import { dmy } from './finanzas-format';

/** Periodos que ofrece el head. `rango` revela el datepicker. */
type Periodo = 'hoy' | 'd7' | 'd30' | 'rango';

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
  imports: [CommonModule, FormsModule, TableModule, MultiSelectModule, SelectModule, DatePickerModule, TagModule, InputTextModule, TextareaModule, SkeletonModule, ButtonModule, ToastModule, DialogModule, PageTabsComponent, SegmentedComponent, MetricStripComponent, ContextHelpComponent, LoadStateComponent],
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
        </div>
        <div class="so-head-right">
          @if (liveConnected()) { <span class="so-live"><i class="pi pi-circle-fill" aria-hidden="true"></i> En vivo</span> }
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
          <div class="tw-verdict" [class.ok]="r.kpis.pendientes === 0" [class.bad]="r.kpis.pendientes > 0">
            <i class="pi" [class.pi-check-circle]="r.kpis.pendientes === 0" [class.pi-exclamation-circle]="r.kpis.pendientes > 0" aria-hidden="true"></i>
            <div>
              <h3>{{ r.kpis.pendientes === 0 ? 'Todo aplicado' : (moneyShort(r.kpis.pendientes_importe) + ' sin aplicar') }}</h3>
              <p class="so-read">
                @if (r.kpis.pendientes === 0) {
                  Las {{ r.kpis.total }} {{ r.kpis.total === 1 ? 'solicitud' : 'solicitudes' }} {{ periodoDe() }}
                  ({{ money(r.kpis.importe) }}) ya se aplicaron a un gasto en Kepler.
                } @else {
                  De {{ r.kpis.total }} {{ r.kpis.total === 1 ? 'solicitud' : 'solicitudes' }} por {{ money(r.kpis.importe) }} {{ periodoEn() }},
                  @if (aplicadaSel() !== 'pend') {
                    <button type="button" class="so-drill" (click)="setAplicada('pend')">
                      {{ r.kpis.pendientes }} {{ r.kpis.pendientes === 1 ? 'sigue' : 'siguen' }} sin aplicarse</button>
                  } @else {
                    <strong>{{ r.kpis.pendientes }} {{ r.kpis.pendientes === 1 ? 'sigue' : 'siguen' }} sin aplicarse</strong>
                  }
                  ({{ money(r.kpis.pendientes_importe) }}). Las canceladas no cuentan.
                }
              </p>
            </div>
          </div>
          <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de solicitudes" />
        }
      }

      <div class="card-premium card-flat so-card">
        <!-- Filtros secundarios pegados a la tabla que filtran, no flotando mid-page. -->
        <div class="so-tools">
          <div class="so-field"><label for="so-f-suc">Sucursales</label>
            <p-multiselect inputId="so-f-suc" [options]="sucursales()" [(ngModel)]="sucursal" optionLabel="label" optionValue="code"
                           placeholder="Todas" [showClear]="true" appendTo="body" styleClass="w-full" (onPanelHide)="queue()" /></div>
          <div class="so-field"><span class="so-lbl" aria-hidden="true">Aplicación</span>
            <app-segmented [options]="aplicadaOpts" [value]="aplicadaSel()" (valueChange)="setAplicada($event)" ariaLabel="Aplicación" /></div>
          <div class="so-field"><label for="so-f-est">Estatus doc</label>
            <p-select inputId="so-f-est" [options]="estadoOpts" [(ngModel)]="estado" optionLabel="label" optionValue="value" [showClear]="true"
                      placeholder="Todos" appendTo="body" (onChange)="queue()" styleClass="w-full" /></div>
          <div class="so-field"><label for="so-f-sol">Solicitante</label>
            <p-select inputId="so-f-sol" [options]="solicitantes()" [(ngModel)]="solicitante" [showClear]="true" placeholder="Todos"
                      appendTo="body" (onChange)="queue()" styleClass="w-full" [filter]="true" /></div>
          <div class="so-field so-grow"><label for="so-f-q">Buscar</label>
            <input id="so-f-q" pInputText [(ngModel)]="search" placeholder="Folio, beneficiario, concepto…" (keyup.enter)="load()" (blur)="queue()" /></div>
          @if (!loading() && rows().length) {
            <span class="so-count">{{ rows().length }} {{ rows().length === 1 ? 'fila' : 'filas' }}</span>
          }
        </div>

        <!-- §2 matriz de estados: cargando (filas skeleton) / vacío (con salida) / error
             son tres cosas distintas. Un periodo sin movimiento NO es una falla. -->
        <app-load-state [class.is-busy]="loading() && !primeraCarga()" [attr.aria-busy]="loading() || null"
                        [loading]="primeraCarga()" [error]="error()" [isEmpty]="!rows().length"
                        [skeletonRows]="8" emptyIcon="pi-inbox"
                        [emptyTitle]="'Sin solicitudes ' + periodoEn()"
                        [emptyHint]="emptyHint()" [emptyCta]="ampliarLabel()" emptyCtaIcon="pi pi-arrows-h"
                        (retry)="load()" (cta)="ampliar()">
          <p-table [value]="rows()" styleClass="p-datatable-sm so-table" [rowHover]="true" [scrollable]="true" scrollHeight="60vh"
                   [paginator]="rows().length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                   sortField="fecha" [sortOrder]="-1">
            <ng-template #header>
              <tr>
                <th pSortableColumn="folio" style="width:9rem">Folio <p-sorticon field="folio" /></th>
                <th pSortableColumn="fecha" style="width:6rem">Fecha <p-sorticon field="fecha" /></th>
                <th pSortableColumn="solicitante" style="width:9rem">Solicitante <p-sorticon field="solicitante" /></th>
                <th style="width:11rem">Beneficiario</th>
                <th>Concepto</th>
                <th class="ta-r" pSortableColumn="importe" style="width:9rem">Importe <p-sorticon field="importe" /></th>
                <th style="width:7rem">Estatus</th>
                <th pSortableColumn="lead_days" style="width:10rem" title="Gasto XA1001 al que se aplicó, y en cuántos días">Aplicación <p-sorticon field="lead_days" /></th>
                <th style="width:12rem">Evidencia</th>
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
                <td>{{ r.beneficiario || '—' }}</td>
                <td class="muted"><span class="so-trunc" [title]="r.concepto || ''">{{ r.concepto || '—' }}</span></td>
                <td class="ta-r num strong">{{ money(r.importe) }}</td>
                <td><p-tag [value]="estadoLabel(r.estado)" [severity]="estadoSev(r.estado)" /></td>

                <!-- Lo que dice Kepler. El lead time va como meta del folio, no como
                     columna aparte: es la lectura de ESE número, no otro dato. -->
                <td>
                  @if (r.aplicada) {
                    <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="verGasto(r)"
                            [attr.aria-label]="'Ver el gasto ' + r.gasto_folio">
                      <span class="p-button-icon p-button-icon-left pi pi-check-circle" aria-hidden="true"></span>
                      <span class="p-button-label num">{{ r.gasto_folio || 'Aplicada' }}</span>
                    </button>
                    @if (r.lead_days != null) {
                      <span class="so-cell-meta tnum">{{ leadTexto(r.lead_days) }}</span>
                    }
                  } @else {
                    <span class="faint">Sin aplicar</span>
                  }
                </td>

                <!-- Lo que tenemos nosotros. Se resuelve donde se ve: antes el estado era
                     solo texto y para validarlo había que irse a otra pantalla y buscar
                     el folio de nuevo. -->
                <td>
                  @if (proofStatus()[r.folio]; as ps) {
                    <div class="so-ev">
                      <span class="so-ev-k">Comprobante</span>
                      <p-tag [value]="proofLabel(ps.status)" [severity]="proofSev(ps.status)" [icon]="'pi ' + proofIcon(ps.status)" styleClass="so-tag" />
                      <!-- Validar/Rechazar de fila: icon-button ghost, igual que la
                           bandeja de capturas de bancos, que resuelve lo mismo. -->
                      @if (puedeResolver() && (ps.status === 'recibida' || ps.status === 'revision')) {
                        <button pButton type="button" class="p-button-sm p-button-text so-rowbtn" [disabled]="actingId() === ps.id"
                                (click)="validar(r, ps.id)" title="Validar el comprobante"
                                [attr.aria-label]="'Validar el comprobante de ' + r.folio">
                          <span class="p-button-icon pi pi-check" aria-hidden="true"></span>
                        </button>
                        <button pButton type="button" severity="danger" class="p-button-sm p-button-text so-rowbtn" [disabled]="actingId() === ps.id"
                                (click)="rechazar(r, ps.id)" title="Rechazar el comprobante"
                                [attr.aria-label]="'Rechazar el comprobante de ' + r.folio">
                          <span class="p-button-icon pi pi-times" aria-hidden="true"></span>
                        </button>
                      }
                    </div>
                  } @else if (!r.aplicada) {
                    <button pButton type="button" class="p-button-sm p-button-text so-cellbtn" (click)="comprobar(r)"
                            [attr.aria-label]="'Subir la evidencia de ' + r.folio">
                      <span class="p-button-icon p-button-icon-left pi pi-upload" aria-hidden="true"></span>
                      <span class="p-button-label">Adjuntar evidencia</span>
                    </button>
                  } @else {
                    <span class="faint">—</span>
                  }
                  @if (compStatus()[r.folio]; as cs) {
                    <div class="so-ev">
                      <span class="so-ev-k">Comprobación</span>
                      <p-tag [value]="proofLabel(cs)" [severity]="proofSev(cs)" [icon]="'pi ' + proofIcon(cs)" styleClass="so-tag" />
                    </div>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </div>
    </div>

    <p-dialog [visible]="showReject()" (visibleChange)="showReject.set($event)" [modal]="true"
              [style]="{ width: '26rem' }" [draggable]="false" header="Rechazar comprobante">
      <p class="so-dlg-hint">
        Solicitud <strong>{{ rejectTarget?.r?.folio }}</strong>. El motivo lo lee quien capturó, así que decí qué corregir.
      </p>
      <textarea pTextarea [(ngModel)]="rejectMotivo" rows="3" class="so-dlg-txt"
                placeholder="Ej. comprobante ilegible, no corresponde a la solicitud…"></textarea>
      <ng-template #footer>
        <button pButton type="button" text (click)="showReject.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" severity="danger" [disabled]="!rejectMotivo.trim()" (click)="confirmarRechazo()">
          <span class="p-button-label">Rechazar</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }

    /* ── Head ───────────────────────────────────────────────────────────── */
    .so-title { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .so-head-right { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); padding-bottom: var(--sp-1); }
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
    .so-rowbtn { min-width: max(1.75rem, var(--tap-min)); min-height: max(1.75rem, var(--tap-min)); padding: 0; }
    .so-rowbtn .p-button-icon { font-size: var(--fs-xs); }

    /* ── Estado de la evidencia ─────────────────────────────────────────
       El estado es un p-tag con severity, no un texto coloreado a mano: así lo
       mapea el tema en claro y en oscuro, y el color deja de ser el portador. */
    .so-ev { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); margin-top: 1px; }
    .so-ev-k { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--fg-3); }
    /* styleClass aterriza dentro del template de p-tag, fuera del scope del
       componente: ::ng-deep es como lo hace el resto de Finanzas. */
    :host ::ng-deep .so-tag { font-size: var(--fs-micro); }

    /* ── Diálogo ────────────────────────────────────────────────────────── */
    .so-dlg-hint { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.45; }
    .so-dlg-txt { width: 100%; font-size: var(--fs-sm); }
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
  /** Fila en curso: el botón se apaga en el 1er clic, síncrono, para que no se dispare dos veces. */
  readonly actingId = signal<string | null>(null);
  readonly compStatus = signal<Record<string, string>>({});

  readonly rows = computed(() => this.report()?.rows || []);
  readonly loading = signal(false);
  /** Primera carga = cargando y todavía sin nada en pantalla. Un refresh no vacía la vista. */
  readonly primeraCarga = computed(() => this.loading() && !this.report());
  readonly error = signal<string | null>(null);
  readonly sucursales = signal<{ code: string; label: string }[]>([]);
  readonly solicitantes = signal<string[]>([]);
  readonly aplicadaSel = signal<string>('');
  readonly periodo = signal<Periodo>('hoy');

  readonly periodoOpts = [
    { label: 'Hoy', value: 'hoy' }, { label: '7 días', value: 'd7' },
    { label: '30 días', value: 'd30' }, { label: 'Rango', value: 'rango' },
  ];
  readonly aplicadaOpts = [{ label: 'Todas', value: '' }, { label: 'Sin aplicar', value: 'pend' }, { label: 'Aplicadas', value: 'apl' }];
  readonly estadoOpts = [
    { label: 'Finalizada', value: 'F' }, { label: 'Autorizada', value: 'A' },
    { label: 'Cancelada', value: 'C' }, { label: 'Nueva', value: 'N' },
  ];

  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly socket = inject(ExpenseProofsSocketService);
  readonly liveConnected = this.socket.connected;

  sucursal: string[] = [];
  estado: string | null = null;
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
    const ap = qp.get('aplicada');
    if (ap === 'pend' || ap === 'apl') this.aplicadaSel.set(ap);

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
  setPeriodo(v: string) { this.periodo.set(v as Periodo); this.syncUrl(); this.load(); }
  setAplicada(v: string) { this.aplicadaSel.set(v); this.syncUrl(); this.load(); }

  private syncUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge',
      queryParams: { periodo: this.periodo(), aplicada: this.aplicadaSel() || null },
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

  /** Empty ≠ error: el periodo puede estar limpio. La salida es ampliar, no reintentar. */
  emptyHint(): string {
    const base = `Ninguna solicitud registrada ${this.periodoEn()}`;
    const filtros = this.aplicadaSel() || this.estado || this.solicitante || this.search.trim() || this.sucursal.length;
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
    const ap = this.aplicadaSel();
    this.loading.set(true);
    this.error.set(null);
    this.svc.expenseRequests({
      from, to,
      sucursal: this.sucursal, estado: this.estado || undefined,
      solicitante: this.solicitante || undefined, search: this.search || undefined,
      aplicada: ap === 'pend' ? false : ap === 'apl' ? true : undefined,
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

  validar(r: ExpenseRequestRow, id: string) { this.resolver(r, id, 'validar'); }
  /** El motivo se pide en un diálogo, igual que en comprobación de gastos: `prompt()`
   *  bloquea el hilo, no se puede estilar y se ve como un error del navegador. */
  readonly showReject = signal(false);
  rejectTarget: { r: ExpenseRequestRow; id: string } | null = null;
  rejectMotivo = '';

  rechazar(r: ExpenseRequestRow, id: string) {
    this.rejectTarget = { r, id }; this.rejectMotivo = ''; this.showReject.set(true);
  }
  confirmarRechazo() {
    const t = this.rejectTarget;
    const motivo = (this.rejectMotivo || '').trim();
    // Sin motivo no se rechaza: quien capturó tiene que saber qué corregir.
    if (!t || !motivo) return;
    this.showReject.set(false);
    this.resolver(t.r, t.id, 'rechazar', motivo);
  }

  private resolver(r: ExpenseRequestRow, id: string, accion: 'validar' | 'rechazar', motivo?: string) {
    if (this.actingId()) return;
    this.actingId.set(id);
    const req = accion === 'validar' ? this.comprobaciones.validate(id) : this.comprobaciones.reject(id, motivo);
    req.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        // Optimista: la fila cambia ya y el WS confirma. Sin esperar una recarga completa.
        this.proofStatus.update((m) => ({ ...m, [r.folio]: { id, status: accion === 'validar' ? 'validada' : 'rechazada' } }));
        this.actingId.set(null);
        this.toast.add({ severity: 'success', summary: accion === 'validar' ? 'Validado' : 'Rechazado', detail: `Solicitud ${r.folio}` });
      },
      error: (e) => {
        this.actingId.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo aplicar',
          detail: e?.error?.message || 'Reintentá; si sigue, revisá permisos.' });
      },
    });
  }

  /**
   * Adjuntar la evidencia de esta solicitud.
   *
   * Viaja TODO lo que la solicitud ya tiene en Kepler (solicitante, beneficiario,
   * sucursal, fecha, importe, concepto): del otro lado eso colapsa el formulario a una
   * sola tarea —subir los archivos— en vez de pedir de nuevo lo que el sistema ya sabe.
   */
  comprobar(r: ExpenseRequestRow) {
    this.router.navigate(['/finanzas/comprobaciones'], {
      queryParams: {
        open: '1',
        folio_solicitud: r.folio || '',
        proveedor: r.beneficiario || '',
        solicitante: r.solicitante || '',
        sucursal: r.sucursal || '',
        fecha: r.fecha ? String(r.fecha).slice(0, 10) : '',
        importe: r.importe || '',
        concepto: r.concepto || '',
      },
    });
  }

  proofLabel(s: string): string { return ({ recibida: 'recibido', revision: 'en revisión', validada: 'validado', rechazada: 'rechazado' } as Record<string, string>)[s] || s; }
  proofIcon(s: string): string { return ({ recibida: 'pi-clock', revision: 'pi-eye', validada: 'pi-check-circle', rechazada: 'pi-times-circle' } as Record<string, string>)[s] || 'pi-file'; }
  proofSev(s: string): 'success' | 'warn' | 'danger' | 'secondary' {
    return ({ recibida: 'warn', revision: 'warn', validada: 'success', rechazada: 'danger' } as Record<string, 'success' | 'warn' | 'danger'>)[s] || 'secondary';
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

  estadoLabel(e: string | null): string {
    return ({ F: 'Finalizada', A: 'Autorizada', C: 'Cancelada', N: 'Nueva' } as Record<string, string>)[e || ''] || (e || '—');
  }
  estadoSev(e: string | null): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return ({ F: 'success', A: 'info', C: 'danger', N: 'warn' } as Record<string, 'success' | 'info' | 'warn' | 'danger'>)[e || ''] || 'secondary';
  }
  pct(a: number, b: number): number { return b ? Math.round((a / b) * 100) : 0; }
}
