import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpedienteDelDia, type GastosDelDia, type PestanaGasto,
} from '../comprobaciones.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { ValeGastoPeekComponent, type AccionVale } from '../components/vale-gasto-peek.component';
import { parseLocalDate } from '../../../core/utils/mx-date';

const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};

/** Cómo se llama cada estado en voz alta. La clave cruda es cómo se guarda, no cómo se dice. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma',
  aprobada: 'Aprobado · falta ejercer',
  revision: 'El cuadre no dio',
  validada: 'Comprobado',
  rechazada: 'Rechazado',
};

/**
 * `[GX.20]` — **Aprobación de gastos.** El día del gasto, en tres pestañas.
 *
 * La pantalla de GX.17 era una bandeja: «todo lo que espera firma, de cualquier fecha».
 * Ahora es **el día**: lo que se levantó ese día, partido por lo que hay que hacer con ello.
 *
 * El corte es **la decisión**, no el avance del trámite:
 *
 * | Pestaña | Estados | Qué es |
 * |---|---|---|
 * | **Bandeja de entrada** | `recibida` | Llegó y nadie decidió todavía. |
 * | **Aprobados** | `aprobada`, `revision`, `validada` | Se dijo que sí. |
 * | **Rechazados** | `rechazada` | Se dijo que no, con su motivo. |
 *
 * Las tres **particionan el día**: cada expediente se ve en una y sólo una. El reparto lo
 * hace el servidor (`etapas-del-dia.ts`, función pura con sus pruebas), no esta pantalla.
 *
 * ⚠️ Los tres estados de *Aprobados* son el mismo hecho en tres momentos del cierre: falta
 * ejercerlo, volvió con evidencia que no cuadró, o ya cerró. **El renglón dice en cuál está
 * y qué botón ofrece**; la pestaña dice que la decisión fue que sí. Separarlos en pestañas
 * distintas partiría en tres una sola respuesta.
 *
 * ⛔ `sin_etapa` —un estado que el servidor no reconoce— entra por la **bandeja de entrada**,
 * que es la que significa «alguien tiene que mirar esto», y sale marcado. Sin eso no saldría
 * en ninguna de las tres, o sea que el expediente no existiría en la aplicación.
 *
 * ## ⛔ Acotar por día NO esconde lo que espera firma
 * Un expediente que nadie aprobó anteayer no puede dejar de existir porque hoy miramos hoy.
 * Por eso, cuando queda algo afuera del día, la pestaña *Aprobar* **lo dice con su monto**.
 * El día filtra lo que se LEE, nunca lo que existe.
 *
 * ⚠️ La barra de navegación de días **se retiró por pedido del usuario** (2026-09-25). La
 * pantalla muestra siempre HOY. El aviso de lo que quedó afuera se conserva justamente
 * porque ya no hay cómo ir a buscarlo: si además se callara, ese trabajo no existiría en
 * ninguna pantalla. `delDia()` sigue aceptando `fecha` — lo que se fue es el control, no la
 * capacidad.
 *
 * ## ⚠️ El día es el de CAPTURA
 * «Los levantamientos que se hicieron al día» es cuándo se **levantó** el expediente. El
 * gasto puede ser de la semana pasada: cada renglón muestra las dos fechas, justo porque no
 * siempre coinciden.
 *
 * ## ⛔ Aprobar sigue siendo de a uno
 * No hay «aprobar el grupo entero». Agrupar y filtrar es para **leer**, no para firmar en
 * bloque: un botón que autoriza 40 gastos de un clic convierte la revisión en un trámite.
 *
 * ## ⛔ No se firma desde la lista: se firma mirando el vale
 * El renglón **no trae botones**. Se abre, se ve el expediente completo —sus papeles
 * incluidos— y recién ahí se decide. Un «Aprobar» al pie de una tarjeta deja autorizar
 * dinero sin haber abierto el comprobante, que es justo lo que esta pantalla existe para
 * que no pase.
 *
 * ⚠️ El detalle **no vuelve a pedir el expediente**: usa la fila que la lista ya trajo, con
 * sus archivos ya firmados (30 min). Un segundo viaje agregaría una fuente que puede
 * contradecir a la primera, y `GET /:id` pide `FINANCE_EXPENSES_VER` — que quien firma no
 * necesariamente tiene (esta pantalla se gatea con `_COMPROBAR`).
 */
@Component({
  selector: 'app-finanzas-aprobacion-gastos',
  standalone: true,
  imports: [CommonModule, ButtonModule, TagModule, InputTextModule, ToastModule, ValeGastoPeekComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ap">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Aprobación de gastos</h1>
          <!-- Sin barra de días, el subtítulo es lo único que ancla la cifra a una fecha.
               Una pantalla que dice «del día» sin decir cuál no se puede auditar. -->
          <p class="surf-page-sub">
            Los levantamientos del
            <strong class="ap-dia-txt">{{ diaLocal(fechaActiva()) | date: "EEEE d 'de' MMMM" }}</strong>,
            partidos por lo que falta hacer con ellos.
          </p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      @if (cargando()) { <div class="ap-muted">Cargando…</div> }
      @else if (error()) { <div class="ap-err">{{ error() }}</div> }
      @else if (datos(); as d) {

        <!-- Un parámetro roto NO se ve igual que un día sin movimiento: se dice. -->
        @if (d.fecha_pedida) {
          <div class="ap-aviso warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>«{{ d.fecha_pedida }}» no es una fecha. Se está mostrando hoy.</span>
          </div>
        }

        <!-- ── Las tres pestañas ────────────────────────────────────────────────── -->
        <div class="ap-tabs" role="tablist">
          @for (t of tabs; track t.id) {
            <button type="button" role="tab" class="ap-tab" [class.on]="pestana() === t.id"
                    [attr.aria-selected]="pestana() === t.id" (click)="verPestana(t.id)">
              <span class="ap-tab-t">{{ t.label }}</span>
              <span class="ap-tab-n">{{ conteo(t.id).n }}</span>
              <span class="ap-tab-m">{{ money(conteo(t.id).monto) }}</span>
            </button>
          }
        </div>

        <!-- Lo que espera firma y NO es de este día. Sin esto, el día escondería trabajo. -->
        @if (pestana() === 'entrada' && d.pendientes_fuera_del_dia.n) {
          <div class="ap-aviso">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>
              Otros días tienen <strong>{{ d.pendientes_fuera_del_dia.n }}</strong> esperando firma
              ({{ money(d.pendientes_fuera_del_dia.monto) }}). Esta pantalla muestra sólo hoy.
            </span>
          </div>
        }

        @if (!d.total) {
          <div class="ap-vacio">
            <i class="pi pi-calendar" aria-hidden="true"></i>
            <div><strong>Hoy todavía no se levantó ningún gasto.</strong>
              <div class="ap-muted">En cuanto alguien capture uno, aparece acá.</div>
            </div>
          </div>
        } @else {
          <div class="ap-cols">
            <!-- El rail de departamentos sólo aplica a lo que se firma: quien autoriza no
                 revisa renglones sueltos, revisa «lo de Logística». -->
            @if (pestana() === 'entrada' && d.entrada.por_departamento.length > 1) {
              <aside class="ap-grupos">
                <div class="ap-grupos-t">Por departamento</div>
                <button type="button" class="ap-grupo" [class.on]="!grupo()" (click)="grupo.set(null)">
                  <span class="ap-g-t">Todos</span>
                  <span class="ap-g-n">{{ d.entrada.total }}</span>
                </button>
                @for (g of d.entrada.por_departamento; track g.clave) {
                  <button type="button" class="ap-grupo" [class.on]="grupo() === g.clave" (click)="grupo.set(g.clave)">
                    <span class="ap-g-t">
                      {{ g.etiqueta }}
                      @if (g.origen === 'solicitud') { <em class="ap-org" title="La etiqueta sale del área de la solicitud de Kepler, no de lo capturado">área</em> }
                      @if (g.origen === 'sin_clasificar') { <em class="ap-org warn">sin clasificar</em> }
                    </span>
                    <span class="ap-g-m">{{ money(g.monto) }}</span>
                    <span class="ap-g-n">{{ g.n }}</span>
                  </button>
                }
              </aside>
            }

            <section class="ap-lista">
              @for (p of visibles(); track p.id) {
                <article class="ap-item" [class.cerrado]="sinAcciones(p)" [class.abierto]="abierto()?.id === p.id"
                         role="button" tabindex="0" [attr.aria-label]="'Ver el vale ' + p.folio_solicitud"
                         (click)="abrir(p)" (keydown.enter)="abrir(p)" (keydown.space)="abrir(p); $event.preventDefault()">
                  <div class="ap-it-head">
                    <span class="ap-folio">{{ p.folio_solicitud || 'sin folio' }}</span>
                    @if (p.sucursal) { <span class="ap-suc">suc {{ p.sucursal }}</span> }
                    <span class="ap-hora">{{ p.created_hora }}</span>
                    <span class="ap-grow"></span>
                    <span class="ap-imp">{{ money(p.importe) }}</span>
                  </div>

                  <div class="ap-it-con">{{ p.concepto || p.proveedor || '—' }}</div>

                  <div class="ap-it-meta">
                    <span>{{ p.departamento || p.solicitante || 'sin departamento' }}</span>
                    <span>·</span>
                    <span>levantado por {{ p.created_by || '—' }}</span>
                    @if (p.fecha_gasto && p.fecha_gasto !== p.created_at) {
                      <span>·</span>
                      <!-- Las dos fechas, porque no son la misma cosa y a veces no coinciden. -->
                      <span class="ap-faint">gasto del {{ diaLocal(p.fecha_gasto) | date: 'dd/MM/yy' }}</span>
                    }
                  </div>

                  <div class="ap-it-chips">
                    <span class="ap-chip" [class.ok]="p.status === 'validada'"
                          [class.warn]="p.status === 'revision'" [class.bad]="p.status === 'rechazada'">
                      {{ estado(p.status) }}
                    </span>
                    @if (p.etapa === 'sin_etapa') {
                      <!-- Un estado que el servidor no reconoce se DECLARA, no se archiva. -->
                      <span class="ap-chip bad" title="El servidor no reconoce este estado">estado desconocido</span>
                    }
                    @if (p.forma_pago) {
                      <span class="ap-chip ok">{{ formaPago(p.forma_pago) }}@if (p.forma_pago_detalle) { · {{ p.forma_pago_detalle }} }</span>
                    } @else {
                      <span class="ap-chip bad">sin forma de pago</span>
                    }
                    @if (p.evidencia_en_vivo) { <span class="ap-chip ok">foto en vivo</span> }
                    @else { <span class="ap-chip warn">foto sin sello de cámara</span> }
                    @if (p.clasificacion) { <span class="ap-chip">{{ tipoGasto(p.clasificacion) }}</span> }
                    @if (p.status === 'aprobada' && p.requiere_evidencia && !p.tiene_evidencia) {
                      <span class="ap-chip warn">falta la evidencia</span>
                    }
                  </div>

                  @if (p.comentarios) { <div class="ap-it-nota">“{{ p.comentarios }}”</div> }
                  @if (p.revision_nota) { <div class="ap-it-nota warn">{{ p.revision_nota }}</div> }
                  @if (p.motivo_rechazo) { <div class="ap-it-nota bad">Rechazado: {{ p.motivo_rechazo }}</div> }
                  @if (p.validated_by) { <div class="ap-it-nota faint">Cerrado por {{ p.validated_by }}</div> }

                  <div class="ap-it-pie">
                    @if (p.files.length) {
                      <span class="ap-faint">{{ p.files.length }} {{ p.files.length === 1 ? 'archivo' : 'archivos' }}</span>
                    } @else {
                      <span class="ap-chip bad">sin archivos</span>
                    }
                    <span class="ap-grow"></span>
                    <span class="ap-abrir">{{ accionesDe(p).length ? 'Abrir y decidir' : 'Ver el vale' }}
                      <i class="pi pi-angle-right" aria-hidden="true"></i></span>
                  </div>
                </article>
              }
              @if (!visibles().length) { <div class="ap-muted">{{ vacioDe(pestana()) }}</div> }
            </section>
          </div>
        }
      }

      <!-- El vale completo vive en un componente compartido: el Historial usa el mismo.
           Dos visores serian dos lugares donde arreglar el mismo error. -->
      <app-vale-gasto-peek [open]="peekAbierto()" (openChange)="cerrarSiHaceFalta($event)"
                           [vale]="abierto()" [acciones]="accionesDe(abierto())"
                           [ocupado]="actuando() !== null"
                           (aprobar)="aprobar($any($event))" (comprobar)="darPorComprobado($any($event))"
                           (rechazar)="rechazar($any($event))" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .ap { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ap-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .ap-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-grow { flex-grow: 1; }
    .ap-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }

    .ap-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ap-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    .ap-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      color: var(--fg-2); background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .ap-aviso.warn { color: var(--warn-fg); border-color: var(--warn-border); }

    /* Sin capitalizar: el dia va EN MEDIO de la frase («Los levantamientos del viernes 25
       de septiembre»). Ponerle mayuscula ahi es tan incorrecto como el «De Septiembre» que
       daba "capitalize" a secas cuando esto era el titulo de una barra. */
    .ap-dia-txt { font-weight: var(--fw-bold); }

    /* ── Pestañas ───────────────────────────────────────────────────────────── */
    .ap-tabs { display: flex; gap: 2px; background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-2); }
    .ap-tab { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      border: 0; border-radius: var(--r-sm); background: transparent; padding: 6px var(--sp-3);
      font: inherit; color: var(--fg-2); cursor: pointer; text-align: left; }
    .ap-tab:hover { background: var(--hover-bg); }
    .ap-tab.on { background: rgba(var(--ink-rgb), .06); box-shadow: inset 2px 0 0 var(--action); color: var(--fg-1); }
    .ap-tab-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .ap-tab.on .ap-tab-t { color: var(--fg-2); }
    .ap-tab-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h2); font-weight: var(--fw-bold); line-height: 1.1; }
    .ap-tab-m { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }

    /* ── Lista ──────────────────────────────────────────────────────────────── */
    .ap-cols { display: flex; gap: var(--sp-3); align-items: flex-start; }
    .ap-grupos { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2); position: sticky; top: var(--sp-3); }
    .ap-grupos-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em;
      color: var(--fg-3); padding: 2px 8px var(--sp-2); }
    .ap-grupo { display: flex; align-items: center; gap: var(--sp-2); width: 100%; border: 0;
      background: transparent; border-radius: var(--r-sm); padding: 6px 8px; font: inherit;
      font-size: var(--fs-sm); color: var(--fg-1); cursor: pointer; text-align: left; }
    .ap-grupo:hover { background: var(--hover-bg); }
    .ap-grupo.on { background: rgba(var(--ink-rgb), .06); box-shadow: inset 2px 0 0 var(--action); }
    .ap-g-t { flex-grow: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ap-g-m { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .ap-g-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2);
      background: var(--layout-bg); border-radius: var(--r-sm); padding: 0 6px; }
    .ap-org { font-size: var(--fs-nano); font-style: normal; color: var(--fg-3);
      border: 1px solid var(--border-color); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    .ap-org.warn { color: var(--warn-fg); border-color: var(--warn-border); }

    .ap-lista { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ap-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 4px; }
    .ap-item.cerrado { opacity: .72; }
    .ap-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .ap-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .ap-suc, .ap-hora { font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-hora { font-family: var(--font-mono); }
    .ap-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); }
    .ap-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .ap-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .ap-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .ap-chip.ok { color: var(--ok-fg); border-color: var(--ok-border); }
    .ap-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .ap-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .ap-it-nota { font-size: var(--fs-xs); color: var(--fg-2); font-style: italic; }
    .ap-it-nota.warn { color: var(--warn-fg); font-style: normal; }
    .ap-it-nota.bad { color: var(--bad-fg); font-style: normal; }
    .ap-it-nota.faint { color: var(--fg-3); font-style: normal; }
    .ap-it-pie { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2);
      padding-top: var(--sp-2); border-top: 1px solid var(--c-divider); }
    .ap-abrir { font-size: var(--fs-xs); color: var(--action); display: inline-flex; align-items: center; gap: 2px; }

    /* El renglón entero es el botón: se firma mirando el vale, no desde la lista. */
    .ap-item[role='button'] { cursor: pointer; transition: border-color .12s ease, background .12s ease; }
    .ap-item[role='button']:hover { border-color: var(--action); background: var(--hover-bg); }
    .ap-item[role='button']:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .ap-item.abierto { border-color: var(--action); box-shadow: inset 2px 0 0 var(--action); }


    @media (max-width: 60rem) {
      .ap-cols { flex-direction: column; }
      .ap-grupos { width: 100%; position: static; }
      .ap-tabs { flex-direction: column; }
      .ap-tab { flex-direction: row; align-items: baseline; gap: var(--sp-2); }
    }
  `],
})
export class FinanzasAprobacionGastosComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<GastosDelDia | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly pestana = signal<PestanaGasto>('entrada');
  readonly grupo = signal<string | null>(null);
  readonly actuando = signal<string | null>(null);
  /** El vale que se está mirando. `null` = el panel está cerrado. */
  readonly abierto = signal<ExpedienteDelDia | null>(null);
  /** El día que muestra la pantalla: siempre hoy, y quién es hoy lo decide el SERVIDOR
   *  (hora de México). Se retiró la barra que dejaba elegir otro — ver el doc de la clase. */
  private readonly fecha = signal<string>('');

  readonly tabs: { id: PestanaGasto; label: string }[] = [
    { id: 'entrada', label: 'Bandeja de entrada' },
    { id: 'aprobados', label: 'Aprobados' },
    { id: 'rechazados', label: 'Rechazados' },
  ];

  constructor() { this.cargar(); }

  /** El día que se está mirando. Mientras no haya respuesta, lo que se pidió. */
  readonly fechaActiva = computed(() => this.datos()?.fecha || this.fecha());

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.svc.delDia(this.fecha() || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.datos.set(d); this.grupo.set(null); this.cargando.set(false); },
        // Un error NO se pinta como «ese día no se levantó nada»: es otra afirmación, y la
        // equivocada deja dinero esperando sin que nadie lo sepa.
        error: () => { this.error.set('No se pudo cargar el día. Reintentá.'); this.cargando.set(false); },
      });
  }

  verPestana(p: PestanaGasto): void {
    this.pestana.set(p);
    // El filtro por departamento es de la bandeja de entrada: arrastrarlo a otra dejaría la
    // lista recortada sin que se vea por qué.
    if (p !== 'entrada') this.grupo.set(null);
  }

  /**
   * Lo que se ve, según la pestaña y el grupo elegido.
   *
   * ⚠️ `todos` no filtra **nada**, ni siquiera un estado que el servidor no reconoció: si
   * también lo escondiera, ese expediente no existiría en ninguna pantalla.
   */
  readonly visibles = computed<ExpedienteDelDia[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const p = this.pestana();
    // ⛔ `sin_etapa` entra por la bandeja de entrada: sin esto, un estado que el servidor no
    // reconoce no saldría en NINGUNA pestaña. Ver `visibleEn()` en `etapas-del-dia.ts`.
    const filas = d.filas.filter((f) => (p === 'entrada' ? f.etapa === 'entrada' || f.etapa === 'sin_etapa' : f.etapa === p));
    const g = this.grupo();
    if (p !== 'entrada' || !g) return filas;
    const sel = d.entrada.por_departamento.find((x) => x.clave === g);
    if (!sel) return filas;
    const ids = new Set(sel.ids);
    return filas.filter((f) => ids.has(f.id));
  });

  /**
   * El contador de cada pestaña. La bandeja de entrada suma **lo que espera decisión más lo
   * que no se reconoce**, y por eso los tres contadores suman el día completo — si no, la
   * pantalla tendría expedientes que no aparecen en ninguna cuenta.
   */
  conteo(p: PestanaGasto): { n: number; monto: number } {
    const d = this.datos();
    if (!d) return { n: 0, monto: 0 };
    const e = d.etapas[p] ?? { n: 0, monto: 0 };
    if (p !== 'entrada') return e;
    const raro = d.etapas.sin_etapa ?? { n: 0, monto: 0 };
    return { n: e.n + raro.n, monto: Math.round((e.monto + raro.monto) * 100) / 100 };
  }

  vacioDe(p: PestanaGasto): string {
    if (p === 'entrada') return this.grupo() ? 'Ese departamento ya no tiene nada esperando firma.' : 'Nada de este día espera tu visto bueno.';
    if (p === 'aprobados') return 'Todavía no se aprobó nada de este día.';
    return 'No se rechazó nada de este día.';
  }

  /** `[GX.27]` El helper COMPARTIDO del repo (`core/utils/mx-date`). Yo habia escrito uno
   *  identico acá — un duplicado es un segundo lugar donde se puede corregir mal. */
  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  readonly peekAbierto = computed(() => this.abierto() !== null);

  /** Abre el vale. Los archivos ya vienen firmados en la fila — no se vuelve a pedir nada. */
  abrir(p: ExpedienteDelDia): void {
    this.abierto.set(p);
  }

  /** El `model` del panel avisa cuando se cierra (Escape, backdrop o la X). */
  cerrarSiHaceFalta(v: boolean): void {
    if (!v) this.abierto.set(null);
  }

  /**
   * Qué se puede hacer con este vale, **según su estado** — no según la pestaña: dentro de
   * «Aprobados» conviven tres momentos del cierre y cada uno ofrece otra cosa.
   */
  accionesDe(p: ExpedienteDelDia | null): readonly AccionVale[] {
    if (!p) return [];
    if (p.status === 'recibida') return ['aprobar', 'rechazar'];
    if (p.status === 'aprobada' || p.status === 'revision') return ['comprobar', 'rechazar'];
    return [];
  }

  /**
   * ¿Este expediente ya no ofrece nada que hacer? Se atenúa el renglón.
   *
   * Sale del ESTADO, igual que los botones — no de la pestaña: dentro de «Aprobados» hay
   * renglones que sí piden acción (`aprobada`, `revision`) y otros que ya cerraron
   * (`validada`). Atenuar por pestaña los pintaría a todos iguales.
   */
  sinAcciones(p: ExpedienteDelDia): boolean {
    return this.accionesDe(p).length === 0;
  }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  formaPago(id: string): string { return FORMA_PAGO_LABEL[id] ?? id; }
  estado(s: string): string { return ESTADO_LABEL[s] ?? s; }
  /** El tipo de gasto en palabras. Sin la clave cruda: `no_fiscal_comprobable` es cómo
   *  se guarda, no cómo se dice. */
  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }

  aprobar(p: ExpedienteDelDia): void {
    this.actuando.set(p.id);
    this.svc.approve(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'success', summary: 'Aprobado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar();
      },
      error: (e) => this.falla('No se pudo aprobar', e),
    });
  }

  /**
   * Cerrar un gasto que ya tiene luz verde. Es `validate()`, el mismo que resuelve lo que
   * quedó en revisión porque el cuadre por visión no dio.
   */
  darPorComprobado(p: ExpedienteDelDia): void {
    this.actuando.set(p.id);
    this.svc.validate(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'success', summary: 'Comprobado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar();
      },
      error: (e) => this.falla('No se pudo cerrar', e),
    });
  }

  /**
   * Rechazar **exige motivo**. Sin él, quien capturó recibe un «no» sin saber qué corregir
   * y vuelve a subir lo mismo — que es como se hace eterna una bandeja.
   */
  rechazar(p: ExpedienteDelDia): void {
    const motivo = (globalThis.prompt?.(`¿Por qué se rechaza la solicitud ${p.folio_solicitud}?`) ?? '').trim();
    if (!motivo) return;
    this.actuando.set(p.id);
    this.svc.reject(p.id, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.abierto.set(null);
        this.toast.add({ severity: 'info', summary: 'Rechazado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar();
      },
      error: (e) => this.falla('No se pudo rechazar', e),
    });
  }

  private falla(summary: string, e: unknown): void {
    this.actuando.set(null);
    const detail = (e as { error?: { message?: string } })?.error?.message || 'Reintentá';
    this.toast.add({ severity: 'error', summary, detail });
  }
}
