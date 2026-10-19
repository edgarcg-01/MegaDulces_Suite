import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { ProntoPagoService, ProntoPagoResponse, ProntoPagoRow, EstadoPronto } from '../pronto-pago.service';

/**
 * `[PP.1]` — **Pronto pago: lo que todavia se puede ganar, y hasta cuando.**
 *
 * Pedido de Edgar (2026-10-10): que Pagos lo vea para no perder el privilegio. El descuento por
 * pronto pago se pierde por FECHA y en silencio -- nadie emite un aviso, la factura se paga igual.
 *
 * Medido en prod antes de disenarla: $93.4 M de mercancia pendiente, $2.33 M todavia capturables
 * y $370 k que vencen en 5 dias o menos.
 *
 * ## Las decisiones de diseno, y por que
 *
 * - **Answer-first (DESIGN regla 15).** Arriba va la cifra que decide el dia -- cuanto se puede
 *   ganar y cuanto esta por vencerse -- no el grid. El detalle es el drill.
 * - **El orden ES la mitad del valor.** La lista sale por urgencia y despues por dinero: ordenarla
 *   por importe esconderia los $200 que vencen manana debajo de los $2 M que vencen en tres semanas.
 * - **El estado nunca viaja solo en el color** (DESIGN regla 14): cada fila lleva texto e icono.
 *   Quien no distingue rojo de ambar tiene que poder trabajar igual.
 * - **La jerga lleva su about** (regla P): "ventana observada" no se entiende sin explicacion, y
 *   confundirla con una condicion pactada es el error caro de esta pantalla.
 * - ⛔ **"Fuera de ventana" NO dice "perdido".** Se paso la mediana de lo que historicamente
 *   funciono; todavia podria cobrarse. Llamarlo perdido haria que Tesoreria dejara de intentarlo.
 * - ⛔ **"Sin medir" se declara, no se dibuja en cero** (ADR-056). Son 807 documentos y $30.6 M de
 *   proveedores sin observaciones suficientes: no sabemos si dan descuento, y eso no es lo mismo
 *   que saber que no dan.
 */
@Component({
  selector: 'app-finanzas-pronto-pago',
  standalone: true,
  imports: [PagosTabsComponent, CommonModule, FormsModule, TableModule, ButtonModule, InputTextModule, SkeletonModule,
            ToastModule, DialogModule, DatePickerModule, InputNumberModule,
            MetricStripComponent, ContextHelpComponent, SegmentedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <!-- [TP.20.3] Las cuatro pantallas de Pagos son un ciclo, no cuatro reportes sueltos. -->
    <app-pagos-tabs />
    <div class="surf-page in pp-page">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 style="display:inline-flex;align-items:center;gap:.4rem">
            Pronto pago <app-context-help topic="finanzas-pronto-pago" />
          </h1>
          <p class="surf-page-sub">
            Facturas de mercancia pendientes de pago cuyo proveedor historicamente nos dio descuento
            al pagar pronto. La fecha limite es <strong>estimada</strong>.
          </p>
        </div>
      </header>

      @if (data(); as d) {
        <!-- ANSWER-FIRST: la frase que decide el dia, antes de cualquier tabla. -->
        <p class="pp-verdict" [class.pp-verdict-urge]="d.kpis.por_vencer.docs > 0">
          @if (d.kpis.beneficio_en_juego > 0) {
            Hoy hay <strong>{{ money(d.kpis.beneficio_en_juego) }}</strong> que todavia se pueden ganar.
            @if (d.kpis.por_vencer.docs > 0) {
              De eso, <strong>{{ money(d.kpis.por_vencer.beneficio) }}</strong> en
              {{ d.kpis.por_vencer.docs }} factura{{ d.kpis.por_vencer.docs === 1 ? '' : 's' }}
              se vence en {{ d.procedencia.dias_aviso }} dias o menos.
            } @else {
              Nada se vence en los proximos {{ d.procedencia.dias_aviso }} dias.
            }
          } @else {
            No hay facturas pendientes dentro de una ventana de pronto pago medible.
          }
        </p>

        <app-metric-strip [items]="kpiItems(d)" ariaLabel="Resumen de pronto pago" />

        <!-- La procedencia va DONDE ESTA EL NUMERO, no en un pie que nadie lee (ADR-056). -->
        <p class="pp-proc">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          La ventana es <strong>observada</strong>, no pactada: sale de los pagos que de hecho
          obtuvieron descuento, con al menos {{ d.procedencia.min_observaciones }} casos por proveedor.
          No es una promesa del proveedor.
        </p>

        @if (d.perdido.hallazgos > 0) {
          <p class="pp-perdido">
            <i class="pi pi-history" aria-hidden="true"></i>
            Aparte, hay <strong>{{ d.perdido.hallazgos }}</strong> hallazgos de descuento no
            capturado por <strong>{{ money(d.perdido.monto) }}</strong>.
            @if (d.perdido.sin_triage === d.perdido.hallazgos) {
              <strong>Ninguno</strong> ha sido revisado.
            } @else if (d.perdido.sin_triage > 0) {
              {{ d.perdido.sin_triage }} sin revisar.
            }
            @if (d.perdido.ultimo) {
              <span class="pp-muted">El detector dejo de producir el {{ d.perdido.ultimo | date:'dd/MM/yy' }}.</span>
            }
          </p>
        }

        <div class="pp-controls">
          <app-segmented [options]="estadoOpts" [value]="estado()" (valueChange)="setEstado($event)"
                         ariaLabel="Filtrar por estado de la ventana" />
          <span class="pp-sp"></span>
          <label class="pp-search">
            <span class="sr-only">Buscar proveedor o folio</span>
            <input pInputText type="search" [ngModel]="search()" (ngModelChange)="onSearch($event)"
                   placeholder="Proveedor o folio" autocomplete="off" />
          </label>
          <p-button type="button" styleClass="p-button-sm p-button-text" (click)="load()"
                    [disabled]="loading()" ariaLabel="Volver a consultar">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </p-button>
        </div>

        <!-- [TP.18.3.1] dt-scope + dt-stack: 8 columnas no caben en angosto y sin esto la tabla
             no dice que hace. El <p-table> pasa de styleClass (que v22 IGNORA) a size+class. -->
        <div class="dt-scope">
        <p-table [value]="d.rows" size="small" class="pp-tbl dt-stack" [rowHover]="true"
                 [scrollable]="true" scrollHeight="52vh"
                 [paginator]="d.rows.length > 50" [rows]="50">
          <ng-template #header>
            <tr>
              <th scope="col">Proveedor</th>
              <th scope="col">Factura</th>
              <th scope="col" class="pp-r">Pendiente</th>
              <th scope="col" class="pp-r" title="Tasa que historicamente nos dieron, no la pactada">Tasa obs.</th>
              <th scope="col" class="pp-r">Se gana</th>
              <th scope="col">Limite estimado</th>
              <th scope="col">Estado</th>
              @if (puedeProgramar()) { <th scope="col" class="pp-r">Acción</th> }
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr>
              <td role="cell" data-label="Proveedor">
                <div class="pp-strong">{{ r.proveedor_nombre || r.proveedor_code }}</div>
                <div class="pp-sub pp-mono">{{ r.proveedor_code }} · suc. {{ r.sucursal }}</div>
              </td>
              <td role="cell" data-label="Factura">
                <div class="pp-mono">{{ r.folio }}</div>
                <div class="pp-sub">{{ r.fecha ? (r.fecha | date:'dd/MM/yy') : 'sin fecha' }}</div>
              </td>
              <td role="cell" data-label="Pendiente" class="pp-r pp-strong pp-mono">{{ money(r.pendiente) }}</td>
              <td role="cell" data-label="Tasa obs." class="pp-r pp-mono">
                @if (r.tasa_observada != null) { {{ (r.tasa_observada * 100) | number:'1.1-1' }}% }
                @else { <span class="pp-muted" title="Sin observaciones suficientes">—</span> }
              </td>
              <td role="cell" data-label="Se gana" class="pp-r pp-mono">
                @if (r.beneficio != null) { <strong>{{ money(r.beneficio) }}</strong> }
                @else { <span class="pp-muted">—</span> }
              </td>
              <td role="cell" data-label="Limite estimado">
                @if (r.fecha_limite) {
                  <div>{{ r.fecha_limite | date:'dd/MM/yy' }}</div>
                  <div class="pp-sub">{{ diasTexto(r) }}</div>
                } @else {
                  <span class="pp-muted">no medible</span>
                }
              </td>
              <td role="cell" data-label="Estado">
                <!-- Texto + icono: el color NO es el unico portador (DESIGN regla 14). -->
                <span class="pp-estado" [class]="'pp-e-' + r.estado">
                  <i class="pi" [ngClass]="iconoDe(r.estado)" aria-hidden="true"></i>
                  {{ etiquetaDe(r.estado) }}
                </span>
                <!-- [PP.2] El POR QUE, visible. No en un title: la razon por la que creemos que
                     este proveedor da descuento es justo lo que decide si pagarle hoy. -->
                <div class="pp-porque" [class.pp-porque-nd]="r.motivo !== 'historial'">{{ r.porque }}</div>
              </td>
              <!-- [TP.18.3] La accion que faltaba: hasta hoy esta pantalla veia vencer el
                   descuento y no tenia donde hacer nada. El pago nace como PROPUESTA; el
                   compromiso lo crea Gerencia al autorizar el dia (ADR-094). -->
              @if (puedeProgramar()) {
                <td role="cell" data-label="Acción" class="pp-r">
                  @if (r.programable > 0) {
                    <p-button size="small" [outlined]="true" (onClick)="abrirProgramar(r)"
                              [attr.aria-label]="'Programar pago de la factura ' + r.folio">
                      <span class="p-button-icon p-button-icon-left pi pi-calendar-plus" aria-hidden="true"></span>
                      <span class="p-button-label">Programar</span>
                    </p-button>
                  } @else {
                    <!-- Ya tiene fecha en el Calendario: se DICE, no se deja un hueco. -->
                    <span class="pp-muted pp-ya">
                      <i class="pi pi-check" aria-hidden="true"></i>
                      {{ r.pagado > 0 ? 'pagada' : 'ya programada' }}
                    </span>
                  }
                </td>
              }
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td [attr.colspan]="puedeProgramar() ? 8 : 7" class="pp-empty">
              <i class="pi pi-inbox" aria-hidden="true"></i>
              Ninguna factura con este filtro.
              @if (estado() || search()) { <button type="button" class="pp-link" (click)="limpiar()">Quitar filtros</button> }
            </td></tr>
          </ng-template>
        </p-table>
        </div>

        @if (d.truncado) {
          <p class="pp-trunc" role="status">
            La lista esta recortada. Acota con el buscador o el filtro de estado para verla completa.
          </p>
        }
      } @else if (loading()) {
        <div class="pp-skel" aria-busy="true" aria-live="polite">
          <span class="sr-only">Cargando pronto pago</span>
          @for (i of [1,2,3,4,5,6]; track i) { <p-skeleton height="2.2rem" styleClass="pp-skel-row" /> }
        </div>
      } @else if (error()) {
        <div class="pp-error" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <p>No se pudo consultar el pronto pago.</p>
          <p-button type="button" styleClass="p-button-sm" (click)="load()">
            <span class="p-button-label">Reintentar</span>
          </p-button>
        </div>
      }

      <!-- [TP.18.3] Programar: manda la factura al Calendario de Pagos, al dia que todavia
           conserva el descuento. NO es un pago: nace como propuesta del dia. -->
      <p-dialog [(visible)]="programarAbierto" [modal]="true" [style]="{ width: '30rem' }"
                header="Programar pago" [draggable]="false">
        @if (programando(); as r) {
          <div class="pp-dlg">
            <p class="pp-dlg-prov"><strong>{{ r.proveedor_nombre || r.proveedor_code }}</strong></p>
            <p class="pp-dlg-sub pp-mono">{{ r.folio }} · suc. {{ r.sucursal }}</p>

            @if (r.fecha_limite) {
              <p class="pp-dlg-nota">
                <i class="pi pi-info-circle" aria-hidden="true"></i>
                Para conservar el descuento habria que pagarla a mas tardar el
                <strong>{{ r.fecha_limite | date:'dd/MM/yy' }}</strong>. La fecha es
                <strong>estimada</strong>, no pactada.
              </p>
            }

            <label class="pp-dlg-lbl" for="pp-fecha">Dia de pago</label>
            <p-datepicker inputId="pp-fecha" [(ngModel)]="fechaPago" dateFormat="dd/mm/yy"
                          [showIcon]="true" appendTo="body" styleClass="pp-dlg-campo" />

            <label class="pp-dlg-lbl" for="pp-monto">Monto</label>
            <p-inputnumber inputId="pp-monto" [(ngModel)]="montoPago" mode="currency" currency="MXN"
                           locale="es-MX" [min]="0" [max]="r.programable" inputStyleClass="pp-dlg-campo" />
            <p class="pp-dlg-sub">Disponible para programar: <strong>{{ money(r.programable) }}</strong></p>

            <p class="pp-dlg-nota pp-dlg-firma">
              <i class="pi pi-shield" aria-hidden="true"></i>
              Queda como <strong>propuesta</strong> del dia. El compromiso nace cuando Gerencia o
              Direccion autoriza el dia en el Calendario de pagos.
            </p>
          </div>
        }
        <ng-template #footer>
          <p-button type="button" [text]="true" (onClick)="programarAbierto = false">
            <span class="p-button-label">Cancelar</span>
          </p-button>
          <p-button type="button" [loading]="guardando()" (onClick)="confirmarProgramar()">
            <span class="p-button-label">Programar</span>
          </p-button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .pp-page { display: flex; flex-direction: column; gap: .75rem; }
    /* Answer-first: la frase del dia, mas grande que todo lo demas. */
    .pp-verdict { margin: 0; font-size: var(--fs-md); color: var(--text-main); line-height: 1.45; }
    .pp-verdict-urge { color: var(--warn-soft-fg); }
    .pp-proc, .pp-perdido { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
    .pp-proc i, .pp-perdido i { margin-right: .3rem; }
    .pp-perdido { padding: .5rem .65rem; border: 1px solid var(--border);
      border-radius: var(--r-sm, 8px); background: var(--surface-2, transparent); }
    .pp-controls { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .pp-sp { flex: 1 1 auto; }
    .pp-search input { min-width: 14rem; }
    .pp-r { text-align: right; }
    .pp-mono { font-variant-numeric: tabular-nums; }
    .pp-strong { font-weight: 600; color: var(--text-main); }
    .pp-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .pp-muted { color: var(--text-muted); }
    .pp-estado { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs);
      padding: .15rem .45rem; border-radius: var(--r-sm, 8px); border: 1px solid var(--border);
      white-space: nowrap; }
    /* El color acompana al texto; nunca lo sustituye. */
    .pp-e-por_vencer { color: var(--warn-soft-fg); border-color: var(--warn-border); }
    .pp-e-capturable { color: var(--ok-fg); border-color: var(--ok-border, var(--border)); }
    .pp-e-fuera_de_ventana { color: var(--text-muted); }
    .pp-e-sin_medir { color: var(--text-muted); border-style: dashed; }
    /* [PP.2] La razon, bajo su estado. Angosta a proposito: es una frase, no un parrafo. */
    .pp-porque { margin-top: .25rem; max-width: 24rem; font-size: var(--fs-xs);
      color: var(--text-muted); line-height: 1.35; text-wrap: pretty; }
    .pp-porque-nd { font-style: italic; }
    .pp-empty, .pp-trunc { text-align: center; color: var(--text-muted); font-size: var(--fs-sm); padding: 1rem; }
    .pp-link { border: 0; background: transparent; color: var(--action); cursor: pointer;
      font: inherit; text-decoration: underline; padding: .2rem .35rem; }
    .pp-link:focus-visible { outline: 2px solid var(--action); outline-offset: 1px; }
    .pp-error { display: flex; flex-direction: column; align-items: center; gap: .5rem;
      padding: 1.5rem; color: var(--bad-fg); }
    .pp-skel { display: flex; flex-direction: column; gap: .4rem; }
    /* [TP.18.3] Programar: la columna de accion y su dialogo. */
    .pp-ya { display: inline-flex; align-items: center; gap: .3rem; font-size: var(--fs-xs); }
    .pp-dlg { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pp-dlg-prov { margin: 0; font-size: var(--fs-body); }
    .pp-dlg-sub { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .pp-dlg-lbl { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--sp-2); }
    .pp-dlg-campo { width: 100%; }
    /* El borde lleva la profundidad: en oscuro la sombra casi desaparece (DESIGN, dark first-class). */
    .pp-dlg-nota { display: flex; gap: .4rem; margin: 0; padding: var(--sp-2);
      border: 1px solid var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.35; text-wrap: pretty; }
    .pp-dlg-firma { background: var(--overlay-hover); }
    /* Objetivos tactiles >= 44px donde el puntero es grueso (DESIGN regla 11). */
    @media (pointer: coarse) {
      .pp-link, .pp-search input { min-height: 44px; }
    }
  `],
})
export class FinanzasProntoPagoComponent {
  private readonly svc = inject(ProntoPagoService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = signal<ProntoPagoResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly estado = signal<EstadoPronto | ''>('');
  readonly search = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * ⚠️ `app-segmented` y NO `role="tablist"`: esto selecciona UNA opcion de filtro, no cambia de
   * panel. La compuerta D.4(c) ya corrigio 36 archivos por confundir las dos cosas.
   */
  readonly estadoOpts: SegOption[] = [
    { label: 'Todo', value: '' },
    { label: 'Por vencer', value: 'por_vencer' },
    { label: 'Capturable', value: 'capturable' },
    { label: 'Fuera de ventana', value: 'fuera_de_ventana' },
    { label: 'Sin medir', value: 'sin_medir' },
  ];

  constructor() { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.svc.overview({ estado: this.estado(), search: this.search() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.data.set(d); this.loading.set(false); },
        error: () => {
          this.loading.set(false);
          // `error` sin borrar `data`: perder lo que ya se veia por un fallo de red deja a la
          // persona sin nada, y lo anterior seguia siendo cierto hace un minuto.
          this.error.set(this.data() === null);
          this.toast.add({ severity: 'error', summary: 'No se pudo consultar', detail: 'Intenta de nuevo.' });
        },
      });
  }

  setEstado(v: string): void { this.estado.set(v as EstadoPronto | ''); this.load(); }

  /** Debounce 250 ms: el buscador pega al SERVIDOR, no filtra una lista ya paginada (D.8). */
  onSearch(v: string): void {
    this.search.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(), 250);
  }

  limpiar(): void { this.estado.set(''); this.search.set(''); this.load(); }

  // ── `[TP.18.3]` Programar: la acción que esta pantalla no tenía (O2) ──────────────────────
  private readonly http = inject(HttpClient);
  private readonly perms = inject(PermissionsService);
  private readonly calendarBase = `${environment.apiUrl}/finance/payment-calendar`;

  /**
   * ⚠️ El permiso es el de **preparar** el pago, no el de verlo: quien sólo consulta el pronto
   * pago no programa. Autorizar el día es otro permiso todavía (`FINANCE_PAYMENT_CALENDAR_AUTORIZAR`)
   * y vive en el Calendario — acá sólo se propone (ADR-094 §2).
   */
  readonly puedeProgramar = computed(() => this.perms.has(Permission.FINANCE_PAYMENTS_GESTIONAR));

  readonly programando = signal<ProntoPagoRow | null>(null);
  readonly guardando = signal(false);
  programarAbierto = false;
  fechaPago: Date | null = null;
  montoPago = 0;

  abrirProgramar(r: ProntoPagoRow): void {
    this.programando.set(r);
    this.montoPago = Number(r.programable) || 0;
    // La fecha que se propone es la que CONSERVA el descuento; si ya pasó (o no hay ventana
    // medible), mañana — nunca hoy: un pago se prepara antes de ejecutarse.
    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    const limite = r.fecha_limite ? new Date(`${String(r.fecha_limite).slice(0, 10)}T12:00:00`) : null;
    this.fechaPago = limite && limite > manana ? limite : manana;
    this.programarAbierto = true;
  }

  async confirmarProgramar(): Promise<void> {
    const r = this.programando();
    if (!r || !this.fechaPago) return;
    const monto = Number(this.montoPago);
    if (!(monto > 0)) { this.toast.add({ severity: 'warn', summary: 'Monto', detail: 'El monto debe ser mayor a cero.' }); return; }
    if (monto > Number(r.programable) + 0.005) {
      this.toast.add({ severity: 'warn', summary: 'Monto', detail: `No se puede programar más de ${this.money(r.programable)}.` });
      return;
    }
    this.guardando.set(true);
    try {
      const d = this.fechaPago;
      const fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      await firstValueFrom(this.http.post(`${this.calendarBase}/allocations`, {
        date: fecha,
        items: [{ obligation_source: r.obligation_source, obligation_id: r.obligation_id, applied_amount: monto }],
      }));
      this.programarAbierto = false;
      this.toast.add({ severity: 'success', summary: 'Programado', detail: `${r.folio} quedó propuesto para el ${fecha}. Falta que Gerencia autorice el día.`, life: 7000 });
      this.load();   // relee: la factura pasa a "ya programada"
    } catch (e: unknown) {
      // El servidor es quien hace cumplir el saldo y las reglas de agrupación: su mensaje dice
      // POR QUÉ no se pudo, y es más útil que un "error" genérico.
      const detail = (e as { error?: { message?: string } })?.error?.message ?? 'No se pudo programar el pago.';
      this.toast.add({ severity: 'error', summary: 'No se programó', detail, life: 9000 });
    } finally {
      this.guardando.set(false);
    }
  }

  kpiItems(d: ProntoPagoResponse): MetricStripItem[] {
    return [
      { label: 'Se puede ganar', value: d.kpis.beneficio_en_juego, format: 'currency',
        tone: d.kpis.beneficio_en_juego > 0 ? 'ok' : 'default' },
      { label: 'Vence pronto', value: d.kpis.por_vencer.beneficio, format: 'currency',
        tone: d.kpis.por_vencer.docs > 0 ? 'warn' : 'default' },
      { label: 'Fuera de ventana', value: d.kpis.fuera_de_ventana.beneficio, format: 'currency' },
      { label: 'Pendiente total', value: d.kpis.total_pendiente, format: 'currency' },
      // ⛔ Sin medir va en DOCUMENTOS, no en pesos: su beneficio no es cero, es desconocido, y
      // publicarlo como $0 diria que esos proveedores no dan descuento. No lo sabemos.
      { label: 'Sin ventana medible', value: d.kpis.sin_medir.docs },
    ];
  }

  etiquetaDe(e: EstadoPronto): string {
    return e === 'por_vencer' ? 'Vence pronto'
      : e === 'capturable' ? 'A tiempo'
      : e === 'fuera_de_ventana' ? 'Fuera de ventana'
      : 'Sin medir';
  }

  iconoDe(e: EstadoPronto): string {
    return e === 'por_vencer' ? 'pi-clock'
      : e === 'capturable' ? 'pi-check-circle'
      : e === 'fuera_de_ventana' ? 'pi-minus-circle'
      : 'pi-question-circle';
  }

  diasTexto(r: ProntoPagoRow): string {
    const d = r.dias_restantes;
    if (d == null) return 'no medible';
    if (d < 0) return `hace ${Math.abs(d)} d`;
    if (d === 0) return 'hoy';
    return `en ${d} d`;
  }

  money(n: number | null | undefined): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
  }
}
