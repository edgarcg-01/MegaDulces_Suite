import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { SelectModule } from 'primeng/select';
import {
  ESTADOS_LEVANTAMIENTO, FILTRO_HISTORIAL_VACIO, filtroHistorialActivo, pasaFiltroHistorial,
  type FacetaHistorial, type FiltroHistorial,
} from '@megadulces/contracts';
import { branchLabel } from '../../../core/constants/store-branches';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { parseLocalDate, todayMx } from '../../../core/utils/mx-date';
import {
  ComprobacionesService, type CalendarioDelMes, type ExpenseProof, type ExpenseProofsReport, type ValeGasto,
} from '../comprobaciones.service';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ValeGastoPeekComponent, type AccionVale } from '../components/vale-gasto-peek.component';
import { DIAS_SEMANA, mesDe, semanasDelMes, sumarMeses, type CeldaCalendario } from '../calendario-mes.util';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { REFRESCO_VALES_MS } from '../vales-refresco';

/** Cómo se llama cada estado en voz alta, para el renglón del día. */
const ESTADO_LABEL: Record<string, string> = {
  recibida: 'Espera firma',
  aprobada: 'Aprobado · falta ejercer',
  revision: 'Falta revisarla',
  validada: 'Comprobado',
  rechazada: 'Rechazado',
};

/** `[GX.78]` Dos filtros iguales piden lo mismo. */
function mismoFiltro(a: FiltroHistorial, b: FiltroHistorial): boolean {
  return a.sucursal === b.sucursal && a.persona === b.persona
    && a.estados.length === b.estados.length && a.estados.every((e, i) => e === b.estados[i]);
}

/**
 * `[GX.78]` Las opciones de un selector: lo que el servidor contó, más lo elegido aunque este
 * mes no tenga nada (con 0) — si desapareciera, el selector se vería vacío con un filtro puesto.
 */
function opcionesDeFaceta(
  facetas: readonly FacetaHistorial[] | null | undefined,
  elegido: string | null,
  rotulo: (v: string) => string,
): { label: string; value: string }[] {
  const ops = (facetas ?? []).map((f) => ({ label: `${rotulo(f.valor)} · ${f.n}`, value: f.valor }));
  if (elegido && !ops.some((o) => o.value === elegido)) ops.unshift({ label: `${rotulo(elegido)} · 0`, value: elegido });
  return ops;
}

/**
 * `[GX.27]` — **Historial de levantamientos, como calendario.**
 *
 * Quien toma la foto la manda y no la vuelve a ver: el levantamiento desaparece de su
 * pantalla en cuanto se envía. Acá queda — y ahora **por día**, que es como la gente recuerda
 * un gasto («fue el martes pasado»), no por número de folio.
 *
 * Cada casilla dice **cuántos** levantamientos hubo ese día y **cuánto** sumaron. Al abrir un
 * día salen sus vales; al abrir un vale, el expediente completo con su evidencia.
 *
 * ## Dos ámbitos, una pantalla
 * · **Míos** — lo que levantó ESTA persona. Sale de `/mine`, que el servidor acota por el
 *   token: no hay forma de pedir los de otro por más que se cambie un parámetro.
 * · **Todos** — el de toda la empresa. `[GX.26]` lo dejó en **god-mode**. Quien no lo tiene no
 *   ve la pestaña **y tampoco la podría pedir**: el servidor comprueba el rol igual, así que
 *   esconderla es la cortesía, no el candado.
 *
 * ## ⚠️ El mes y el día son los de México
 * Un gasto levantado a las 20:00 de acá ya es el día siguiente en UTC. Si el corte se hiciera
 * en UTC, ese gasto caería en la casilla de mañana — y el último día de cada mes se mudaría
 * al siguiente. El servidor agrupa en hora de México y la rejilla es aritmética de casilleros.
 *
 * ## ⚠️ Lo que este historial NO puede mostrar
 * `finance.expense_proofs` sólo tiene lo que pasó por ESTA app. Un gasto que Kepler autorizó y
 * que nadie levantó acá no aparece — y no es un hueco de la consulta, es que no existe de este
 * lado. Por eso la pantalla dice «levantamientos», no «gastos».
 */
@Component({
  selector: 'app-finanzas-gastos-historial',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, ToastModule, ValeGastoPeekComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in hist">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Historial de levantamientos</h1>
          <p class="surf-page-sub">Cada día, cuántos gastos se levantaron y cuánto sumaron. Abrí un día para ver sus vales.</p>
        </div>
      </header>

      <div class="hist-barra">
        @if (puedeVerTodos()) {
          <div class="hist-seg" role="radiogroup" aria-label="Qué historial">
            <button type="button" role="radio" [attr.aria-checked]="ambito() === 'mios'"
                    [class.on]="ambito() === 'mios'" (click)="cambiar('mios')">Míos</button>
            <button type="button" role="radio" [attr.aria-checked]="ambito() === 'todos'"
                    [class.on]="ambito() === 'todos'" (click)="cambiar('todos')">Todos</button>
          </div>
        }

        <nav class="hist-mes" aria-label="Mes que se está mirando">
          <button type="button" aria-label="Mes anterior" (click)="moverMes(-1)">
            <i class="pi pi-chevron-left" aria-hidden="true"></i>
          </button>
          <strong class="hist-mes-txt">{{ primerDia() | date: "LLLL 'de' y" }}</strong>
          <button type="button" aria-label="Mes siguiente" [disabled]="esMesActual()" (click)="moverMes(1)">
            <i class="pi pi-chevron-right" aria-hidden="true"></i>
          </button>
          @if (!esMesActual()) {
            <button type="button" class="hist-hoy" (click)="irAlMesActual()">ir a este mes</button>
          }
        </nav>

        <span class="hist-grow"></span>
        <button type="button" class="hist-refrescar" (click)="cargarMes()">
          <i class="pi pi-refresh" aria-hidden="true"></i> actualizar
        </button>
      </div>

      <!--
        [GX.78] Filtros. Viven FUERA del bloque de carga (mismo criterio que el Expediente, GX.72):
        si se escondieran mientras recarga, la barra saltaría bajo el cursor a cada clic.
        El SERVIDOR los aplica al calendario y la pantalla a la lista del día, con la misma regla
        (pasaFiltroHistorial): la casilla y la lista cuentan lo mismo.
      -->
      @if (facetas(); as fc) {
        <div class="hist-filtros" role="search" aria-label="Filtrar el historial">
          <div class="hist-f">
            <span class="hist-f-l" id="hist-f-estado">Estado</span>
            <div class="hist-chips" role="group" aria-labelledby="hist-f-estado">
              @for (e of opcionesEstado(); track e.valor) {
                <button type="button" class="hist-chip" [class.on]="estadoElegido(e.valor)"
                        [attr.aria-pressed]="estadoElegido(e.valor)" (click)="alternarEstado(e.valor)">
                  {{ etiqueta(e.valor) }} <span class="hist-chip-n">{{ e.n }}</span>
                </button>
              }
            </div>
          </div>
          <div class="hist-f">
            <span class="hist-f-l" id="hist-f-suc">Sucursal</span>
            <p-select [options]="opcionesSucursal()" [ngModel]="filtro().sucursal" (ngModelChange)="elegirSucursal($event)"
                      optionLabel="label" optionValue="value" placeholder="Todas" [showClear]="true"
                      class="hist-f-sel" ariaLabelledBy="hist-f-suc" />
          </div>
          @if (fc.personas) {
            <div class="hist-f">
              <span class="hist-f-l" id="hist-f-persona">Quién levantó</span>
              <p-select [options]="opcionesPersona()" [ngModel]="filtro().persona" (ngModelChange)="elegirPersona($event)"
                        optionLabel="label" optionValue="value" placeholder="Todas las personas" [showClear]="true"
                        [filter]="true" class="hist-f-sel" ariaLabelledBy="hist-f-persona" />
            </div>
          }
          @if (filtroActivo()) {
            <button type="button" class="hist-limpiar" (click)="limpiarFiltros()">Limpiar filtros</button>
          }
        </div>
      }

      @if (cargando()) {
        <div class="hist-vacio">Cargando…</div>
      } @else if (error()) {
        <!-- Un error NO se pinta como mes vacío: eso diría «no se levantó nada», que es otra cosa. -->
        <div class="hist-vacio bad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}</div>
      } @else if (mesDatos(); as m) {
        @if (m.mes_pedido) {
          <div class="hist-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            «{{ m.mes_pedido }}» no es un mes. Se está mostrando el actual.</div>
        }

        @if (filtroNoCoincide()) {
          <!-- [GX.78] La cifra es de otra pregunta: se dice, no se presenta como filtrada. -->
          <div class="hist-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            El servidor no aplicó este filtro: las cifras del calendario son del mes completo.</div>
        }

        <div class="hist-kpis">
          @if (filtroActivo() && m.total_sin_filtro) {
            <!-- [GX.78] Filtrado se dice «58 de 392»: el número solo no dice de qué universo es. -->
            <span><b>{{ m.total.n }}</b> de {{ m.total_sin_filtro.n }} levantamientos del mes</span>
            <span><b>{{ money(m.total.monto) }}</b> de {{ money(m.total_sin_filtro.monto) }}</span>
            @if (!m.total.n) { <span class="hist-faint">Ningún levantamiento del mes pasa el filtro.</span> }
          } @else {
            <span><b>{{ m.total.n }}</b> {{ m.total.n === 1 ? 'levantamiento' : 'levantamientos' }} en el mes</span>
            <span><b>{{ money(m.total.monto) }}</b> en total</span>
            @if (!m.total.n) { <span class="hist-faint">Este mes no tiene levantamientos.</span> }
          }
        </div>

        <!-- ── El calendario ─────────────────────────────────────────────────── -->
        <div class="cal" role="grid" aria-label="Calendario de levantamientos" [class.filtrando]="filtrando()" [attr.aria-busy]="filtrando()">
          <div class="cal-cab" role="row">
            @for (d of diasSemana; track $index) { <span role="columnheader">{{ d }}</span> }
          </div>
          @for (semana of semanas(); track semana[0].dia) {
            <div class="cal-fila" role="row">
              @for (c of semana; track c.dia) {
                <button type="button" role="gridcell" class="cal-dia"
                        [class.fuera]="!c.delMes" [class.hoy]="c.esHoy"
                        [class.con-gasto]="c.delMes && c.n > 0"
                        [class.on]="c.dia === diaSel()"
                        [attr.aria-label]="etiquetaDia(c)"
                        (click)="abrirDia(c)">
                  <span class="cal-num">{{ c.numero }}</span>
                  @if (c.delMes && c.n) {
                    <!-- El número es lo que se lee de un vistazo; el monto va abajo, chico. -->
                    <span class="cal-n">{{ c.n }}</span>
                    <span class="cal-monto">{{ moneyCorto(c.monto) }}</span>
                  }
                </button>
              }
            </div>
          }
        </div>

        <!-- ── El día abierto ───────────────────────────────────────────────── -->
        @if (diaSel(); as d) {
          <section class="hist-dia">
            <header>
              <h2>{{ diaLocal(d) | date: "EEEE d 'de' MMMM" }}</h2>
              <span class="hist-grow"></span>
              @if (!cargandoDia() && !errorDia()) {
                <span class="hist-faint">{{ filtroActivo() ? filasVisibles().length + ' de ' + filasDia().length : filasDia().length }} · {{ money(totalDia()) }}</span>
              }
              <button type="button" class="hist-cerrar" aria-label="Cerrar el día" (click)="cerrarDia()">
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </header>

            @if (cargandoDia()) { <div class="hist-vacio">Cargando…</div> }
            @else if (errorDia()) {
              <div class="hist-vacio bad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ errorDia() }}</div>
            }
            @else if (!filasDia().length) {
              <div class="hist-vacio">Ese día no se levantó ningún gasto.</div>
            } @else if (!filasVisibles().length) {
              <!-- [GX.78] No es «no hubo gasto»: hubo, y ninguno pasa el filtro. -->
              <div class="hist-vacio">Ninguno de los {{ filasDia().length }} vales de este día pasa el filtro.</div>
            } @else {
              @for (r of filasVisibles(); track r.id) {
                <article class="hist-vale" role="button" tabindex="0"
                         [attr.aria-label]="'Ver el vale ' + (r.folio_solicitud || 'sin folio')"
                         (click)="abrirVale(r)" (keydown.enter)="abrirVale(r)"
                         (keydown.space)="abrirVale(r); $event.preventDefault()">
                  <span class="hist-folio">{{ r.folio_solicitud || 'sin folio' }}</span>
                  <span class="hist-prov">{{ r.proveedor || '—' }}</span>
                  <span class="hist-est" [class]="'e-' + r.status">{{ etiqueta(r.status) }}</span>
                  <span class="hist-grow"></span>
                  <span class="hist-quien">{{ r.created_by || '—' }}</span>
                  <span class="hist-imp">{{ money(r.importe) }}</span>
                  <i class="pi pi-angle-right" aria-hidden="true"></i>
                </article>
              }
            }
          </section>
        }
      }

      <p-toast />
      <!-- El mismo visor que usa Aprobación. Acá la única acción posible es PEDIR que te
           reabran tu propio vale [GX.29]: no se firma nada desde el historial. -->
      <app-vale-gasto-peek [open]="valeAbierto() !== null" (openChange)="cerrarVale($event)"
                           [vale]="valeAbierto()" [acciones]="accionesDelVale()"
                           [ocupado]="pidiendo()" (pedirReapertura)="pedirReapertura($any($event))" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }
    .hist { max-width: 68rem; margin: 0 auto; display: flex; flex-direction: column; gap: var(--sp-3); }
    .hist-grow { flex-grow: 1; }
    .hist-faint { font-size: var(--fs-xs); color: var(--fg-3); }

    .hist-barra { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
    .hist-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-sm); overflow: hidden; }
    .hist-seg button { min-height: var(--tap-min); padding: 0 var(--sp-3); border: 0; background: transparent;
      font: inherit; font-size: var(--fs-sm); color: var(--fg-2); cursor: pointer; }
    .hist-seg button.on { background: var(--fg-1); color: var(--card-bg); font-weight: var(--fw-medium); }

    .hist-mes { display: flex; align-items: center; gap: var(--sp-2); }
    .hist-mes button { width: 30px; height: 30px; border: 1px solid var(--border-color);
      border-radius: var(--r-sm); background: var(--card-bg); color: var(--fg-2); cursor: pointer; }
    .hist-mes button:disabled { opacity: .4; cursor: default; }
    /* El mes va EN MEDIO de una barra, no como título: sólo la primera letra en mayúscula. */
    .hist-mes-txt { min-width: 11rem; text-align: center; font-size: var(--fs-sm); }
    .hist-mes-txt::first-letter { text-transform: uppercase; }
    .hist-hoy { width: auto !important; padding: 0 var(--sp-2); border: 0 !important;
      background: none !important; font-size: var(--fs-xs); color: var(--action) !important; }
    .hist-refrescar { min-height: var(--tap-min); padding: 0 var(--sp-2); border: 0; background: none;
      font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer; }

    .hist-kpis { display: flex; flex-wrap: wrap; gap: var(--sp-4); font-size: var(--fs-xs); color: var(--fg-2); }
    /* [GX.78] Barra de filtros: etiqueta arriba del control, en una fila que se parte en angosto. */
    .hist-filtros { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); }
    .hist-f { display: flex; flex-direction: column; gap: 2px; }
    .hist-f-l { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-2); font-weight: var(--fw-bold); }
    .hist-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .hist-chip { display: inline-flex; align-items: center; gap: 6px; min-height: var(--tap-min);
      padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm);
      background: transparent; font: inherit; font-size: var(--fs-sm); color: var(--fg-2); cursor: pointer; }
    .hist-chip:hover { border-color: var(--action); }
    .hist-chip:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .hist-chip.on { background: var(--fg-1); border-color: var(--fg-1); color: var(--card-bg); }
    .hist-chip-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }
    /* La clase va en el HOST de p-select (v22 retiró styleClass): la regla es propia, sin ng-deep. */
    .hist-f-sel { min-width: 13rem; }
    .hist-limpiar { min-height: var(--tap-min); padding: 0 var(--sp-2); border: 0; background: none;
      font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer; }
    .hist-vacio { padding: var(--sp-5); text-align: center; font-size: var(--fs-sm); color: var(--fg-3); }
    .hist-vacio.bad { color: var(--bad-fg); }
    .hist-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      color: var(--warn-fg); border: 1px solid var(--warn-border); border-radius: var(--r-md);
      padding: var(--sp-2) var(--sp-3); }

    /* ── Calendario ────────────────────────────────────────────────────────── */
    .cal { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2); }
    /* [GX.78] Mientras llega el mes del filtro nuevo, las cifras viejas se atenúan: no son de este filtro. */
    .cal.filtrando { opacity: .5; }
    .cal-cab, .cal-fila { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
    .cal-cab span { text-align: center; padding: 4px 0; font-size: var(--fs-micro);
      text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .cal-dia { display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
      gap: 1px; min-height: 62px; padding: 5px 2px; border: 1px solid transparent;
      border-radius: var(--r-sm); background: transparent; color: var(--fg-2);
      font: inherit; cursor: pointer; overflow: hidden; }
    .cal-dia:hover { border-color: var(--action); }
    .cal-dia:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    /* El relleno del mes vecino se atenúa: se puede abrir, pero no es de este mes. */
    .cal-dia.fuera { background: transparent; color: var(--fg-3); opacity: .45; }
    .cal-dia.hoy .cal-num { background: var(--fg-1); color: var(--card-bg); border-radius: 999px;
      width: 22px; height: 22px; display: grid; place-items: center; }
    /* El dia CON gasto es el que tiene que saltar; el vacio es fondo. */
    .cal-dia.con-gasto { background: var(--layout-bg); border-color: var(--border-color); color: var(--fg-1); }
    .cal-dia.on { border-color: var(--action); box-shadow: inset 0 0 0 1px var(--action); }
    .cal-num { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; line-height: 22px; }
    /* El mini número: es lo que se lee de un vistazo. */
    .cal-n { font-family: var(--font-mono); font-size: var(--fs-lg); font-weight: var(--fw-bold);
      line-height: 1.1; color: var(--action); }
    .cal-monto { font-family: var(--font-mono); font-size: var(--fs-nano); color: var(--fg-3);
      white-space: nowrap; }

    /* ── El día abierto ───────────────────────────────────────────────────── */
    .hist-dia { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 2px; }
    .hist-dia > header { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .hist-dia h2 { font-size: var(--fs-lg); margin: 0; }
    .hist-dia h2::first-letter { text-transform: uppercase; }
    .hist-cerrar { width: 28px; height: 28px; border: 0; border-radius: var(--r-sm);
      background: transparent; color: var(--fg-3); cursor: pointer; }
    .hist-cerrar:hover { background: var(--hover-bg); }

    .hist-vale { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2);
      border-radius: var(--r-sm); border: 1px solid transparent; cursor: pointer; font-size: var(--fs-sm); }
    .hist-vale:hover { background: var(--hover-bg); border-color: var(--border-color); }
    .hist-vale:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .hist-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .hist-prov { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
    .hist-quien { font-size: var(--fs-xs); color: var(--fg-3); }
    .hist-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    /* El estado se lee por color Y por palabra: el color solo no le sirve a quien no lo distingue. */
    .hist-est { font-size: var(--fs-nano); padding: 1px 7px; border-radius: var(--r-sm);
      border: 1px solid var(--border-color); color: var(--fg-2); white-space: nowrap; }
    .hist-est.e-validada { color: var(--ok-fg); border-color: var(--ok-border); }
    .hist-est.e-rechazada { color: var(--bad-fg); border-color: var(--bad-border); }
    .hist-est.e-revision { color: var(--warn-fg); border-color: var(--warn-border); }

    @media (max-width: 40rem) {
      .cal-dia { min-height: 54px; }
      .cal-monto { display: none; }
      .hist-prov { max-width: 8rem; }
    }
  `],
})
export class FinanzasGastosHistorialComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly toast = inject(MessageService);

  readonly diasSemana = DIAS_SEMANA;

  /**
   * `[GX.26]` «Todos» sólo para god-mode. No es sólo estética: el endpoint comprueba el rol
   * igual, así que mostrar la pestaña a quien no lo tiene sería ofrecer una puerta que
   * devuelve 403.
   *
   * ⚠️ Se mira el ROL, no una clave del mapa de permisos. `perms.isAdmin()` es el espejo de
   * `isPlatformAdminRole` del servidor — el mismo criterio de los dos lados.
   *
   * `[GX.71]` Ahora también la llave por persona `FINANCE_EXPENSES_HISTORIAL_TODOS`. `perms.has()`
   * da `true` al admin de plataforma y, si no, mira la clave exacta: es la misma regla que
   * `puedeVerHistorialDeTodos()` aplica en el servidor. `_VER` sigue sin alcanzar.
   */
  readonly puedeVerTodos = computed(() => this.perms.has(Permission.FINANCE_EXPENSES_HISTORIAL_TODOS));

  readonly ambito = signal<'mios' | 'todos'>('mios');
  /** El mes que se mira. Vacío = el actual, y quién es «el actual» lo decide el servidor. */
  private readonly mes = signal('');
  readonly mesDatos = signal<CalendarioDelMes | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');

  readonly diaSel = signal<string | null>(null);
  readonly filasDia = signal<ExpenseProof[]>([]);
  readonly cargandoDia = signal(false);
  readonly errorDia = signal('');

  readonly valeAbierto = signal<ValeGasto | null>(null);
  /** `[GX.29]` Hay una solicitud de reapertura en vuelo: el botón se bloquea. */
  readonly pidiendo = signal(false);

  /**
   * `[GX.78]` **El filtro vigente.** Sobrevive al cambio de mes (se sigue mirando lo mismo en
   * otro mes); la persona NO sobrevive al cambio a «Míos», donde la única persona es quien mira.
   *
   * Un filtro sólo ACHICA lo que se ve: el alcance lo sigue decidiendo el servidor por permiso.
   */
  readonly filtro = signal<FiltroHistorial>(FILTRO_HISTORIAL_VACIO);
  readonly filtroActivo = computed(() => filtroHistorialActivo(this.filtro()));
  /** Hay un mes pidiéndose por un cambio de filtro: el calendario se atenúa, no se esconde. */
  readonly filtrando = signal(false);
  /** Las opciones de cada filtro las cuenta el servidor. Sin ellas (servidor anterior), no hay barra. */
  readonly facetas = computed(() => this.mesDatos()?.facetas ?? null);
  /** La lista del día, acotada con la MISMA regla que el servidor usa en el calendario. */
  readonly filasVisibles = computed(() => this.filasDia().filter((r) => pasaFiltroHistorial(r, this.filtro())));

  /**
   * Los estados que se ofrecen: los que el servidor contó, más los elegidos que este mes no
   * tienen (con 0) — si desaparecieran, no habría cómo quitarlos. Sólo los estados que la regla
   * conoce: elegir uno desconocido devolvería 400.
   */
  readonly opcionesEstado = computed<FacetaHistorial[]>(() => {
    const ops = (this.facetas()?.estados ?? []).filter((e) => (ESTADOS_LEVANTAMIENTO as readonly string[]).includes(e.valor));
    for (const e of this.filtro().estados) if (!ops.some((o) => o.valor === e)) ops.push({ valor: e, n: 0, monto: 0 });
    const pos = (v: string) => (ESTADOS_LEVANTAMIENTO as readonly string[]).indexOf(v);
    return ops.sort((a, b) => pos(a.valor) - pos(b.valor));
  });
  readonly opcionesSucursal = computed(() =>
    opcionesDeFaceta(this.facetas()?.sucursales, this.filtro().sucursal, (v) => branchLabel(v)));
  readonly opcionesPersona = computed(() =>
    opcionesDeFaceta(this.facetas()?.personas, this.filtro().persona, (v) => v));

  /**
   * `[GX.78]` ¿El servidor aplicó OTRO filtro que el elegido? Mientras hay un pedido en vuelo
   * no se juzga (la respuesta todavía es la del filtro anterior). Un servidor que no devuelve el
   * filtro y con algo elegido es el mismo caso: las cifras son del mes completo.
   */
  readonly filtroNoCoincide = computed(() => {
    const m = this.mesDatos();
    if (!m || this.cargando() || this.filtrando()) return false;
    if (!m.filtro) return this.filtroActivo();
    return !mismoFiltro(m.filtro, this.filtro());
  });

  constructor() {
    this.cargarMes();
    // `[GX.73]` Se refresca sola mientras la pestaña se ve (el mes y, si hay uno abierto, el día).
    encuestarVisible(REFRESCO_VALES_MS, () => this.refrescar());
  }

  /** Hay un refresco en vuelo: el siguiente no se encima. */
  private refrescando = false;

  /**
   * `[GX.73]` **El refresco en segundo plano.** Sin aviso de carga y sin pisar con un error lo
   * que ya está en pantalla. Refresca el MES y, si hay un día abierto, la lista de ese día — es
   * donde se ve la etapa de cada vale.
   *
   * ⛔ No corre con un vale abierto, ni mientras el mes o el día se están cargando a mano: el
   * refresco no puede ganarle la carrera a lo que la persona acaba de pedir.
   */
  refrescar(): void {
    if (this.valeAbierto() || this.cargando() || this.filtrando() || this.cargandoDia() || this.refrescando) return;
    this.refrescando = true;
    const ambito = this.ambito();
    const mes = this.mes();
    const dia = this.diaSel();
    const filtro = this.filtro();
    this.svc.calendario(mes || undefined, ambito, filtro)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m: CalendarioDelMes) => {
          // Si mientras volaba cambió el ámbito o el mes, la respuesta es de otra vista: se descarta.
          if (this.ambito() === ambito && this.mes() === mes && this.filtro() === filtro) { this.mesDatos.set(m); this.cdr.markForCheck(); }
          this.refrescando = false;
        },
        error: () => { this.refrescando = false; },
      });
    if (!dia) return;
    this.svc.delDiaHistorial(dia, ambito)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r: ExpenseProofsReport) => {
          // Mismo criterio: sólo si sigue abierto ESE día, en ESE ámbito.
          if (this.diaSel() === dia && this.ambito() === ambito && !this.valeAbierto()) {
            this.filasDia.set(r?.rows || []); this.cdr.markForCheck();
          }
        },
        error: () => undefined,
      });
  }

  /** El mes activo. Mientras no haya respuesta, el que se pidió. */
  readonly mesActivo = computed(() => this.mesDatos()?.mes || this.mes() || todayMx().slice(0, 7));
  /** El día 1, para que el pipe de fecha rotule el mes sin correrse de huso. */
  readonly primerDia = computed(() => parseLocalDate(`${this.mesActivo()}-01`));
  readonly esMesActual = computed(() => this.mesActivo() >= todayMx().slice(0, 7));

  readonly semanas = computed<CeldaCalendario[][]>(() =>
    semanasDelMes(this.mesActivo(), this.mesDatos()?.dias ?? [], todayMx()));

  readonly totalDia = computed(() => this.filasVisibles().reduce((a, r) => a + (Number(r.importe) || 0), 0));

  /** `[GX.78]` El pedido del mes en curso: uno nuevo lo cancela, para que no gane la respuesta vieja. */
  private pedidoMes?: Subscription;

  /**
   * Pide el mes con el ámbito y el filtro vigentes.
   *
   * `[GX.78]` `suave` = cambio de filtro: el calendario se queda a la vista (atenuado) en vez de
   * desaparecer tras un «Cargando…» a cada clic. Un error se dice igual en los dos casos — dejar
   * a la vista el calendario del filtro anterior sería mostrar cifras de otra pregunta.
   */
  cargarMes(suave = false): void {
    if (suave && !this.cargando()) this.filtrando.set(true);
    else this.cargando.set(true);
    this.error.set('');
    this.pedidoMes?.unsubscribe();
    this.pedidoMes = this.svc.calendario(this.mes() || undefined, this.ambito(), this.filtro())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (m: CalendarioDelMes) => {
          this.mesDatos.set(m); this.cargando.set(false); this.filtrando.set(false); this.cdr.markForCheck();
        },
        // Un error NO se pinta como mes vacío: es otra afirmación, y la equivocada haría creer
        // que no hubo gasto.
        error: () => {
          this.error.set('No se pudo cargar el mes. Vuelve a intentar.');
          this.cargando.set(false); this.filtrando.set(false); this.cdr.markForCheck();
        },
      });
  }

  /** `[GX.78]` Prende o apaga un estado. Se pueden elegir varios. */
  alternarEstado(valor: string): void {
    const actuales = this.filtro().estados as readonly string[];
    const nuevos = actuales.includes(valor) ? actuales.filter((e) => e !== valor) : [...actuales, valor];
    // Orden fijo (el del trámite): dos selecciones iguales son el mismo filtro.
    this.aplicarFiltro({ ...this.filtro(), estados: ESTADOS_LEVANTAMIENTO.filter((e) => nuevos.includes(e)) });
  }

  estadoElegido(valor: string): boolean {
    return (this.filtro().estados as readonly string[]).includes(valor);
  }

  elegirSucursal(v: string | null): void { this.aplicarFiltro({ ...this.filtro(), sucursal: v || null }); }

  elegirPersona(v: string | null): void { this.aplicarFiltro({ ...this.filtro(), persona: v || null }); }

  limpiarFiltros(): void { this.aplicarFiltro(FILTRO_HISTORIAL_VACIO); }

  /**
   * El día abierto se QUEDA abierto: su lista se acota acá mismo con la regla compartida, sin
   * volver a pedirla. El mes sí se pide de nuevo — sus cifras las cuenta el servidor.
   */
  private aplicarFiltro(f: FiltroHistorial): void {
    if (mismoFiltro(f, this.filtro())) return;
    this.filtro.set(f);
    this.cargarMes(true);
  }

  cambiar(a: 'mios' | 'todos'): void {
    if (this.ambito() === a) return;
    this.ambito.set(a);
    // `[GX.78]` En «Míos» la única persona es quien mira: un filtro de otra persona lo vaciaría.
    if (a === 'mios' && this.filtro().persona) this.filtro.set({ ...this.filtro(), persona: null });
    // El día abierto es del otro ámbito: dejarlo mostraría vales que ya no corresponden.
    this.cerrarDia();
    this.cargarMes();
  }

  moverMes(delta: number): void {
    const destino = sumarMeses(this.mesActivo(), delta);
    // No se navega al futuro: no hay levantamientos de un mes que no llegó, y un calendario
    // vacío sin explicación se lee como «no hubo gasto».
    if (destino > todayMx().slice(0, 7)) return;
    this.mes.set(destino);
    this.cerrarDia();
    this.cargarMes();
  }

  irAlMesActual(): void {
    this.mes.set('');
    this.cerrarDia();
    this.cargarMes();
  }

  /**
   * Abre un día. Si la celda es del mes vecino, se cambia de mes además de abrirla — un clic
   * que no hace nada es peor que uno que lleva a otro lado.
   */
  abrirDia(c: CeldaCalendario): void {
    if (!c.delMes) {
      const otro = mesDe(c.dia);
      if (otro && otro <= todayMx().slice(0, 7)) { this.mes.set(otro); this.cargarMes(); }
      else return;
    }
    this.diaSel.set(c.dia);
    this.valeAbierto.set(null);
    this.cargandoDia.set(true);
    this.errorDia.set('');
    this.filasDia.set([]);
    this.svc.delDiaHistorial(c.dia, this.ambito())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r: ExpenseProofsReport) => { this.filasDia.set(r?.rows || []); this.cargandoDia.set(false); this.cdr.markForCheck(); },
        error: () => { this.errorDia.set('No se pudieron traer los vales de ese día. Vuelve a intentar.'); this.cargandoDia.set(false); this.cdr.markForCheck(); },
      });
  }

  cerrarDia(): void {
    this.diaSel.set(null);
    this.filasDia.set([]);
    this.errorDia.set('');
    this.valeAbierto.set(null);
  }

  /**
   * Abre el expediente. El listado ya trae los archivos firmados — no se vuelve a pedir.
   *
   * ⛔ Sin acciones: esto es consulta. Quien mira el historial no necesariamente puede firmar,
   * y el visor sólo ofrece lo que la página le pasa.
   */
  abrirVale(r: ExpenseProof): void { this.valeAbierto.set(r as ValeGasto); }
  cerrarVale(abierto: boolean): void { if (!abierto) this.valeAbierto.set(null); }

  /**
   * `[GX.29]` Qué ofrece el visor acá. **Sólo** pedir la reapertura, y sólo sobre lo
   * propio: en el ámbito «Todos» se están mirando vales ajenos.
   *
   * ⚠️ Esto es la puerta, no la cerradura. Quién puede reabrir qué lo decide el servidor
   * (`reapertura.ts`, con sus pruebas): acá sólo se evita ofrecer un botón que va a dar
   * 400. Un vale rechazado o ya aplicado en Kepler lo rebota el servidor igual.
   */
  accionesDelVale(): readonly AccionVale[] {
    const v = this.valeAbierto();
    if (!v || this.ambito() !== 'mios') return [];
    // Un vale que todavía espera firma no necesita reapertura: ya está abierto.
    return ['aprobada', 'validada', 'revision'].includes(String(v.status)) ? ['pedir_reapertura'] : [];
  }

  /**
   * `[GX.29]` Pedir que te reabran el vale para agregar la evidencia definitiva.
   *
   * El motivo es obligatorio **del lado del servidor** (mínimo una frase): quien decide
   * lo hace leyendo eso, y «reabrir» a secas no le dice si lo que falta es la factura o
   * si alguien se equivocó de vale.
   */
  pedirReapertura(v: ValeGasto): void {
    const motivo = (globalThis.prompt?.(`¿Qué le vas a agregar al vale ${v.folio_solicitud || ''}?`) ?? '').trim();
    if (!motivo) return;
    this.pidiendo.set(true);
    this.svc.pedirReapertura(v.id, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.pidiendo.set(false);
        this.valeAbierto.set(null);
        this.toast.add({ severity: 'success', summary: 'Pedido enviado', life: 6000,
          detail: 'Le llegó a quien aprobó el vale. Cuando te lo reabra, te avisamos.' });
        this.cdr.markForCheck();
      },
      error: (e) => {
        this.pidiendo.set(false);
        const detail = (e as { error?: { message?: string } })?.error?.message || 'Vuelve a intentar';
        this.toast.add({ severity: 'error', summary: 'No se pudo pedir', detail });
        this.cdr.markForCheck();
      },
    });
  }

  etiquetaDia(c: CeldaCalendario): string {
    if (!c.delMes) return `${c.numero}, de otro mes`;
    if (!c.n) return `${c.numero}: sin levantamientos`;
    return `${c.numero}: ${c.n} ${c.n === 1 ? 'levantamiento' : 'levantamientos'}, ${this.money(c.monto)}`;
  }

  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }
  etiqueta(s: string): string { return ESTADO_LABEL[s] ?? s; }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  /** El monto de la casilla: sin centavos, y en miles cuando es grande — no hay lugar. */
  moneyCorto(v: number): string {
    const n = Number(v) || 0;
    if (n >= 10000) return `$${Math.round(n / 1000)}k`;
    return `$${Math.round(n).toLocaleString('es-MX')}`;
  }
}
