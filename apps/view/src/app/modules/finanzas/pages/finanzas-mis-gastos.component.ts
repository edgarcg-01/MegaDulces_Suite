import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpenseProof, type ValeGasto,
} from '../comprobaciones.service';
import { ValeGastoPeekComponent } from '../components/vale-gasto-peek.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
// `[GX.39]` La etapa la decide el SERVIDOR con `etapaDeEjercicio()`; acá sólo se lee el tipo.
import type { EtapaEjercicio, ValeAsignado } from '@megadulces/contracts';

/**
 * `[GX.46]` `asignado` es una etapa **de esta pantalla**, no del contrato: el contrato decide
 * el ciclo de un expediente NUESTRO, y un vale asignado todavia no lo es. Meterla alla habria
 * obligado a `etapaDeEjercicio()` a contemplar un caso que nunca va a recibir.
 */
type EtapaLista = EtapaEjercicio | 'asignado';

/**
 * `[GX.47]` **Cuatro pestañas, no siete.** Pedido del usuario: «solo todos, en tramite,
 * rechazados y por ejercer».
 *
 * Las etapas finas no desaparecen — siguen en el CHIP de cada renglón, que es donde importan
 * («Autorizado en Kepler», «Sin medir», «Ejercido»). Lo que se agrupa es el FILTRO, porque
 * siete pestañas para 26 renglones parten la lista en pedazos de dos y tres.
 *
 * El criterio del agrupado es **de qué lado está parado el vale**:
 *   · `en_tramite` — todavía depende de nosotros (o de que suba la evidencia).
 *   · `por_ejercer` — ya lo firmamos; espera a Kepler.
 *   · `rechazada`  — se lo devolvieron.
 *
 * ⚠️ **Lo que se pierde, dicho:** `ejercido` y `cancelado_kepler` se quedan **sin pestaña
 * propia** — se ven en «Todos», con su chip verde y su frase, pero no se pueden filtrar. Se
 * decidió así porque «por ejercer» conteniendo lo ya ejercido sería un nombre que miente.
 */
type GrupoSeccion = 'todos' | 'en_tramite' | 'rechazada' | 'por_ejercer';

const GRUPOS: readonly { id: GrupoSeccion; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'en_tramite', label: 'En trámite' },
  { id: 'rechazada', label: 'Rechazados' },
  { id: 'por_ejercer', label: 'Por ejercer' },
];

/**
 * A qué pestaña cae cada etapa. `null` para las que no tienen pestaña: caen sólo en «Todos».
 *
 * ⛔ Devolver un grupo por defecto sería peor que devolver `null`: una etapa nueva se metería
 * callada en una pestaña que no le corresponde, y el contador diría otra cosa que la lista.
 */
function grupoDe(e: EtapaLista | null): GrupoSeccion | null {
  switch (e) {
    case 'asignado': case 'en_captura': return 'en_tramite';
    case 'rechazada': return 'rechazada';
    case 'por_ejercer': case 'autorizado': case 'sin_medir': return 'por_ejercer';
    default: return null;   // ejercido, cancelado_kepler, o sin etapa
  }
}

/** Una fila de la lista, venga de Kepler o de un expediente nuestro. */
interface FilaLista {
  key: string;
  folio: string;
  sucursal: string | null;
  fecha: string | null;
  importe: number;
  titulo: string | null;
  detalle: string | null;
  etapa: EtapaLista | null;
  etapa_label: string;
  etapa_explicacion: string;
  status: string | null;
  motivo_rechazo: string | null;
  /** `[GX.54]` Aprobado pero debiendo el comprobante (entró con cotización o prefactura). */
  debeFactura?: boolean;
  /**
   * `[GX.55]` Si esta fila ofrece el camino para subir un archivo. Son DOS casos: el vale que
   * Kepler asignó y todavía no tiene expediente, y el ya aprobado que debe su comprobante.
   */
  puedeSubir?: boolean;
  /** Sólo los asignados: si Kepler ya genero su gasto. */
  aplicada: boolean | null;
  /** `null` = viene de Kepler y no tiene expediente: no se puede abrir. */
  proof: ExpenseProof | null;
}
import { RouterLink } from '@angular/router';
import { parseLocalDate } from '../../../core/utils/mx-date';

/**
 * `[GX.33]` — **Mis gastos.** Lo que YO levanté, en qué quedó cada uno, y su expediente.
 *
 * ## Por qué existe, y qué reemplaza
 * Hasta acá, quien sólo levanta gastos entraba al **Historial** — una pantalla pensada para
 * revisar: calendario por mes, ámbitos «Míos/Todos», buscador de toda la empresa. Funcionaba
 * (el servidor ya le acotaba a lo suyo), pero **decía otra cosa de la que hacía**: se llama
 * «Historial», ofrece un selector de ámbito que él no puede usar, y lo que de verdad quiere
 * saber —«¿ya me lo aprobaron?»— había que deducirlo de un calendario.
 *
 * Acá la pregunta es una sola y la respuesta está arriba: **cuántos esperan firma, cuántos
 * se aprobaron, cuántos te devolvieron**. Y cada renglón abre su expediente completo.
 *
 * ## ⛔ No filtra del lado del cliente
 * Pide `GET /mine`, que el servidor acota por el token. Si el recorte viviera acá, un error
 * de esta pantalla mostraría el gasto ajeno — y peor, nadie se enteraría.
 *
 * ## ⚠️ Un rechazo se ve acá, pero no para siempre
 * A las 24 h el servidor deja de devolverlo (`[GX.29]`). No es un bug de esta pantalla: es
 * que un vale rechazado se vuelve a capturar, no se arrastra. Se dice en el vacío, para que
 * nadie crea que se perdió.
 */
@Component({
  selector: 'app-finanzas-mis-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, ValeGastoPeekComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in mg">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mis gastos</h1>
          <p class="surf-page-sub">Los que levantaste vos, y en qué quedó cada uno.</p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      @if (cargando()) { <div class="mg-muted">Cargando…</div> }
      @else if (error()) { <div class="mg-err">{{ error() }}</div> }
      @else {
        <!--
          [GX.46] Aca vivia el cuadro naranja con los vales asignados, y se retiro por pedido
          del usuario: «todo el cuadro naranja ya que abajo salen los vales».
          ⛔ NO se borraron los vales: se MUDARON a la lista de abajo, como una fila mas con
          su propia etapa. Borrarlos a secas los habria dejado sin ninguna pantalla -- con
          «Levantamiento de gasto» fuera del menu (GX.42), ese boton es el unico camino para
          subirle evidencia a un vale.
        -->
        <!-- La respuesta a «¿en qué quedaron?», arriba y sin tener que contar renglones. -->
        <div class="mg-kpis">
          <div class="mg-kpi">
            <span class="mg-kpi-t">Esperan firma</span>
            <strong class="mg-kpi-v">{{ kpis().recibidas }}</strong>
          </div>
          <div class="mg-kpi ok">
            <span class="mg-kpi-t">Aprobados</span>
            <strong class="mg-kpi-v">{{ kpis().validadas }}</strong>
          </div>
          <div class="mg-kpi" [class.bad]="kpis().rechazadas > 0">
            <span class="mg-kpi-t">Te los devolvieron</span>
            <strong class="mg-kpi-v">{{ kpis().rechazadas }}</strong>
          </div>
        </div>

        <!--
          [GX.39] Las secciones que pidio el usuario: «por ejercer» (firmado, esperando a
          Kepler) y «ejercido» (el dinero salio). Filtran lo YA CARGADO, sin otro viaje.
          La cuenta dice «de los N cargados» a proposito: son las filas que vinieron, no el
          universo -- leerlo como total es la trampa que GX.35 ya cobro una vez aca.
        -->
        @if (hayEtapas()) {
        <div class="mg-etapas" role="tablist" aria-label="Etapa del gasto">
          @for (s of secciones(); track s.id) {
            <button type="button" role="tab" class="mg-etapa"
                    [class.on]="seccion() === s.id" [attr.aria-selected]="seccion() === s.id"
                    (click)="seccion.set(s.id)">
              {{ s.label }} <span class="mg-etapa-n">{{ s.n }}</span>
            </button>
          }
        </div>
        @if (seccion() !== 'todos' && explicacionSeccion()) {
          <p class="mg-muted mg-etapa-ayuda">{{ explicacionSeccion() }}</p>
        }
        }

        <div class="mg-barra">
          <span class="p-input-icon-left mg-buscar">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input pInputText [(ngModel)]="q" (keyup.enter)="cargar()"
                   placeholder="Folio, proveedor o concepto…" />
          </span>
          @if (q) { <button type="button" class="mg-link" (click)="q = ''; cargar()">limpiar</button> }
        </div>

        @if (!visibles().length) {
          <div class="mg-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <div>
              @if (q) {
                <strong>Ninguno de tus gastos coincide con «{{ q }}».</strong>
              } @else if (seccion() !== 'todos' && filas().length) {
                <!-- ⚠️ Otra afirmacion: SI levanto gastos, sólo que ninguno esta en esta etapa. -->
                <strong>Ninguno de tus gastos está en «{{ etiquetaSeccion() }}».</strong>
                <div class="mg-muted">Tenés {{ filas().length }} en las otras etapas.</div>
              } @else {
                <strong>Todavía no levantaste ningún gasto.</strong>
                <!--
                  [GX.41] ⚠️ «No levantaste nada» y «no tenés expediente todavia» no son lo
                  mismo cuando arriba hay vales esperando: decirle que no hizo nada a quien
                  tiene tres pendientes lo manda a buscar donde no es.
                -->
                @if (asignados().length) {
                  <div class="mg-muted">Arriba tenés {{ asignados().length }} que te asignaron en Kepler: subiles la evidencia y aparecen acá.</div>
                } @else {
                  <div class="mg-muted">Cuando levantes uno, aparece acá con su estado.</div>
                }
              }
              <!-- Sin esto, quien busque un rechazo viejo va a creer que se perdió. -->
              <div class="mg-muted">Un gasto que te devolvieron deja de verse a las 24 h: ése se vuelve a capturar.</div>
            </div>
          </div>
        } @else {
          <section class="mg-lista">
            @for (p of visibles(); track p.key) {
              <!--
                [GX.46] UNA sola lista. El vale que Kepler asigno y el expediente nuestro se
                pintan igual; lo unico que cambia es que el primero todavia no se puede abrir
                (no hay expediente que mostrar) y en su lugar ofrece subir la evidencia.
              -->
              <article class="mg-item" [class.pend]="p.etapa === 'asignado'"
                       [attr.role]="p.proof ? 'button' : null" [attr.tabindex]="p.proof ? 0 : null"
                       [attr.aria-label]="p.proof ? ('Ver el vale ' + p.folio) : null"
                       (click)="p.proof && abrir(p.proof)"
                       (keydown.enter)="p.proof && abrir(p.proof)"
                       (keydown.space)="p.proof && abrir(p.proof); p.proof && $event.preventDefault()">
                <div class="mg-it-head">
                  <span class="mg-folio">{{ p.folio || 'sin folio' }}</span>
                  @if (p.sucursal) { <span class="mg-faint">suc {{ p.sucursal }}</span> }
                  <span class="mg-grow"></span>
                  <span class="mg-imp">{{ money(p.importe) }}</span>
                </div>
                <div class="mg-it-con">{{ p.titulo || '—' }}</div>
                <div class="mg-it-meta">
                  <span>{{ diaLocal(p.fecha) | date: 'dd/MM/yy' }}</span>
                  @if (p.detalle) { <span>·</span><span>{{ p.detalle }}</span> }
                </div>
                <div class="mg-it-chips">
                  @if (p.etapa === 'asignado') {
                    <span class="mg-chip warn">{{ p.etapa_label }}</span>
                    @if (p.aplicada) { <span class="mg-chip ok">Ya ejercido en Kepler</span> }
                  } @else {
                    <span class="mg-chip" [class.ok]="p.status === 'validada'"
                          [class.warn]="p.status === 'revision' || p.status === 'aprobada'"
                          [class.bad]="p.status === 'rechazada'">{{ estado(p.status) }}</span>
                    <!--
                      [GX.54] La tarea dice QUE falta. Un vale aprobado con una cotizacion
                      espera la FACTURA del pago, no «evidencia» a secas: la persona ya subio
                      algo y leer «subi la evidencia» se entiende como que no se recibio.
                    -->
                    @if (p.status === 'aprobada') {
                      <span class="mg-chip warn">{{ p.debeFactura ? 'te toca subir la factura del pago' : 'te toca subir la evidencia' }}</span>
                    }
                  }
                  <!--
                    [GX.39] La etapa de EJERCICIO. Sólo tiene algo que decir cuando nuestro
                    tramite ya cerro: antes de eso el chip de estado ya lo dice todo, y dos
                    chips diciendo lo mismo con distintas palabras confunden.
                  -->
                  @if (p.etapa && p.etapa !== 'en_captura' && p.etapa !== 'rechazada' && p.etapa !== 'asignado') {
                    <span class="mg-chip" [class.ok]="p.etapa === 'ejercido' || p.etapa === 'autorizado'"
                          [class.warn]="p.etapa === 'por_ejercer'"
                          [class.faint]="p.etapa === 'sin_medir'">{{ p.etapa_label }}</span>
                  }
                </div>
                <!--
                  [GX.46] El vale que Kepler asigno todavia no tiene expediente: en vez de
                  abrirse, ofrece el camino para crearlo. Va a /finanzas/gastos (la ruta REAL)
                  con el folio y la sucursal; el redirect /finanzas/capturar-gasto los perdia.
                -->
                <!--
                  [GX.55] El boton tambien para el vale APROBADO que todavia debe su
                  comprobante. Sin esto, el chip le decia «te toca subir la factura del pago» y
                  no habia por donde: el visor decia «ya se resolvio» y la lista no ofrecia nada.
                -->
                @if (p.puedeSubir) {
                  <a class="mg-asig-b" [routerLink]="['/finanzas/gastos']"
                     [queryParams]="{ folio: p.folio, sucursal: p.sucursal }">
                    <i class="pi pi-camera" aria-hidden="true"></i>&nbsp;{{ p.debeFactura ? 'Subir la factura' : 'Subir evidencia' }}
                  </a>
                }
                <!-- El motivo del rechazo va COMPLETO: es lo que hay que corregir. -->
                @if (p.motivo_rechazo) { <div class="mg-it-nota bad">Te lo devolvieron: {{ p.motivo_rechazo }}</div> }
                <!-- ⭐ La frase textual del pedido: «su gasto se aprobó y se ejerció». -->
                @if (p.etapa === 'ejercido') { <div class="mg-it-nota ok">{{ p.etapa_explicacion }}</div> }
              </article>
            }
          </section>
        }
      }

      <!-- El mismo visor que usan Aprobación y el Historial. Acá sin acciones: es lo tuyo,
           pero quien decide sobre el dinero es otro. -->
      <app-vale-gasto-peek [open]="abierto() !== null" (openChange)="cerrar($event)" [vale]="abierto()" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .mg { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 60rem; }
    .mg-muted { font-size: var(--fs-sm); color: var(--fg-2); }
    .mg-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-grow { flex-grow: 1; }
    .mg-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }
    .mg-link { border: 0; background: transparent; color: var(--action); font: inherit;
      font-size: var(--fs-xs); cursor: pointer; }

    .mg-kpis { display: flex; gap: var(--sp-3); flex-wrap: wrap; }

    /* [GX.41] «Te tocan a vos»: lo unico accionable de la pantalla, por eso se destaca. */
    .mg-asig { display: flex; flex-direction: column; gap: var(--sp-2);
      border: 1px solid var(--action); border-radius: var(--r-md); padding: var(--sp-3);
      background: var(--surface-card); }
    .mg-asig-h { display: flex; align-items: center; gap: var(--sp-2); color: var(--fg-1); }
    .mg-asig-n { font-size: var(--fs-xs); background: var(--action); color: var(--action-fg, #fff);
      border-radius: var(--r-full, 999px); padding: 0 0.5rem; font-variant-numeric: tabular-nums; }
    .mg-asig-sub { margin: 0; display: flex; align-items: center; gap: var(--sp-2);
      font-size: var(--fs-sm); color: var(--fg-2); }
    .mg-asig-sub strong { color: var(--fg-1); font-variant-numeric: tabular-nums; }
    .mg-asig-it { display: flex; flex-direction: column; gap: var(--sp-1);
      border-top: 1px solid var(--border); padding-top: var(--sp-2); }
    .mg-asig-b { align-self: flex-start; display: inline-flex; align-items: center;
      border: 1px solid var(--action); border-radius: var(--r-sm); padding: 0.3rem 0.7rem;
      font-size: var(--fs-xs); color: var(--action); text-decoration: none; margin-top: var(--sp-1); }
    .mg-asig-b:hover { background: var(--action); color: var(--action-fg, #fff); }

    /* [GX.39] Las secciones de ejercicio. Pildoras, no pestanas con linea: caben en movil. */
    .mg-etapas { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .mg-etapa { display: inline-flex; align-items: center; gap: var(--sp-1);
      border: 1px solid var(--border); background: var(--surface-card); color: var(--fg-2);
      border-radius: var(--r-full, 999px); padding: 0.25rem 0.7rem; font: inherit;
      font-size: var(--fs-xs); cursor: pointer; }
    .mg-etapa:hover { border-color: var(--action); }
    .mg-etapa.on { background: var(--action); border-color: var(--action); color: var(--action-fg, #fff); }
    .mg-etapa-n { font-variant-numeric: tabular-nums; opacity: 0.75; }
    .mg-etapa-ayuda { margin: 0; }
    .mg-kpi { flex: 1 1 10rem; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); }
    .mg-kpi.ok { border-color: var(--ok-fg); }
    .mg-kpi.bad { border-color: var(--bad-border); }
    .mg-kpi-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .mg-kpi-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h1); font-weight: var(--fw-bold); line-height: 1.1; }

    .mg-barra { display: flex; align-items: center; gap: var(--sp-2); }
    .mg-buscar input { width: 20rem; max-width: 100%; }

    .mg-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .mg-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    .mg-lista { display: flex; flex-direction: column; gap: var(--sp-2); }
    .mg-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column;
      gap: 4px; cursor: pointer; }
    .mg-item:hover { border-color: var(--action); }
    .mg-item:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .mg-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .mg-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .mg-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); }
    .mg-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .mg-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .mg-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .mg-chip.ok { color: var(--ok-fg); border-color: var(--ok-fg); }
    .mg-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .mg-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .mg-it-nota { font-size: var(--fs-xs); margin-top: 2px; }
    .mg-it-nota.bad { color: var(--bad-fg); }
  `],
})
export class FinanzasMisGastosComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly filas = signal<ExpenseProof[]>([]);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly abierto = signal<ValeGasto | null>(null);
  q = '';

  /**
   * ⚠️ Los KPI salen de `kpis` del SERVIDOR, no de contar `filas()`. La lista viene acotada
   * a un `limit`, así que contarla diría «tenés 200 gastos» al que tiene 340.
   */
  private readonly reporte = signal<{ recibidas: number; validadas: number; rechazadas: number } | null>(null);
  readonly kpis = computed(() => this.reporte() ?? { recibidas: 0, validadas: 0, rechazadas: 0 });

  /**
   * `[GX.39]` La seccion abierta. Filtra lo YA CARGADO — no dispara otro viaje: la etapa no
   * es un filtro del servidor (sale de cruzar con Kepler, no es una columna), asi que pedirla
   * como parametro obligaria a cruzar el universo entero para devolver 20 filas.
   */
  readonly seccion = signal<GrupoSeccion>('todos');

  /**
   * ⛔ **Sin una sola etapa resuelta, la barra NO se pinta.** Lo encontro su propia prueba:
   * con un servidor que no manda `etapa` (uno viejo, o un vale que el backend no pudo
   * resolver) las pestanas salian «En tramite 0 · Por ejercer 0 · Ejercido 0» — que AFIRMA
   * que medimos y dio cero, cuando no medimos nada. Es el mismo defecto que la fase existe
   * para arreglar, cometido en la pantalla que lo arregla (ADR-056).
   */
  readonly hayEtapas = computed(() => this.unificadas().some((p) => !!p.etapa));

  /**
   * `[GX.46]` **UNA sola lista.** El vale que Kepler asigno y el expediente nuestro se
   * muestran juntos, porque para la persona son la misma cosa en momentos distintos: uno
   * espera que le suba la evidencia, el otro ya la tiene.
   *
   * ⛔ Los asignados van PRIMERO y no es un capricho de orden: son los unicos de la pantalla
   * que piden hacer algo. El resto es consulta.
   *
   * ⚠️ `proof` en `null` marca al que **no tiene expediente**: no se puede abrir (no hay nada
   * que mostrar) y en su lugar ofrece el boton para crearlo. Sin esa distincion, el click
   * abriria un visor vacio.
   */
  readonly unificadas = computed<FilaLista[]>(() => [
    ...this.asignados().map((v): FilaLista => ({
      key: `k:${v.sucursal}:${v.folio}`,
      folio: v.folio, sucursal: v.sucursal, fecha: v.fecha, importe: v.importe,
      titulo: v.destinatario, detalle: v.concepto,
      etapa: 'asignado', etapa_label: 'Falta tu evidencia',
      etapa_explicacion: 'Lo levantaron a tu nombre en Kepler. Falta que le subas la evidencia.',
      status: null, motivo_rechazo: null, aplicada: v.aplicada, proof: null,
      debeFactura: false, puedeSubir: true,
    })),
    ...this.filas().map((p): FilaLista => ({
      key: `p:${p.id}`,
      folio: p.folio_solicitud, sucursal: p.sucursal, fecha: p.fecha_gasto, importe: p.importe,
      titulo: p.proveedor, detalle: p.clasificacion ? this.tipoGasto(p.clasificacion) : null,
      // `[GX.54]` El vale aprobado con cotización debe la factura, no «evidencia» genérica.
      debeFactura: p.provisional === true,
      // `[GX.55]` Aprobado = le falta algo por subir. Es el estado que la captura abre en
      // modo evidencia; ofrecer el botón en cualquier otro llevaría a una pantalla cerrada.
      puedeSubir: p.status === 'aprobada',
      etapa: p.etapa ?? null, etapa_label: p.etapa_label ?? '',
      etapa_explicacion: p.etapa_explicacion ?? '',
      status: p.status, motivo_rechazo: p.motivo_rechazo, aplicada: null, proof: p,
    })),
  ]);

  /**
   * `[GX.41]` Los vales que Kepler le asigno. Salen del SERVIDOR ya recortados por su
   * username — acá no se filtra nada: si el recorte viviera en el cliente, un error suyo le
   * mostraria a alguien el vale de otro y se veria igual de bien (GX.34).
   */
  readonly asignados = signal<ValeAsignado[]>([]);

  /** ⚠️ Las etapas de CIERRE se agrupan bajo «Por ejercer»/«Ejercido»; el resto es «en tramite». */
  readonly secciones = computed(() => {
    const f = this.unificadas();
    if (!this.hayEtapas()) return [];
    const n = (g: GrupoSeccion) => f.filter((p) => grupoDe(p.etapa) === g).length;
    return GRUPOS.map((g) => ({ id: g.id, label: g.label, n: g.id === 'todos' ? f.length : n(g.id) }));
  });

  readonly visibles = computed(() => {
    const s = this.seccion();
    return s === 'todos' ? this.unificadas() : this.unificadas().filter((p) => grupoDe(p.etapa) === s);
  });

  readonly etiquetaSeccion = computed(() =>
    this.secciones().find((s) => s.id === this.seccion())?.label ?? '');

  /** `[GX.47]` Lo que NO entra en ninguna pestaña, para poder decirlo en vez de esconderlo. */
  readonly fueraDePestanas = computed(() => this.unificadas().filter((p) => grupoDe(p.etapa) === null).length);

  /** La frase larga de la etapa abierta. Sale de la primera fila: el texto es el mismo para todas. */
  readonly explicacionSeccion = computed(() => this.visibles()[0]?.etapa_explicacion ?? '');

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.svc.mine(200, this.q || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.filas.set(r.rows ?? []);
        this.asignados.set(r.asignados ?? []);
        this.reporte.set({
          recibidas: r.kpis?.recibidas ?? 0,
          validadas: r.kpis?.validadas ?? 0,
          rechazadas: r.kpis?.rechazadas ?? 0,
        });
        this.cargando.set(false);
      },
      // Un error NO se pinta como «no levantaste nada»: es otra afirmación, y la equivocada
      // manda a alguien a capturar de nuevo un gasto que ya mandó.
      error: () => { this.error.set('No se pudieron cargar tus gastos. Reintentá.'); this.cargando.set(false); },
    });
  }

  abrir(p: ExpenseProof): void { this.abierto.set(p as ValeGasto); }
  cerrar(abierto: boolean): void { if (!abierto) this.abierto.set(null); }

  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  /**
   * Cómo se lee cada estado **desde el lado de quien levantó el gasto**. No son las mismas
   * palabras que ve quien aprueba: a él «aprobada» le dice que ya firmó; a quien capturó le
   * dice que todavía le toca hacer algo.
   */
  // `[GX.46]` Acepta `null`: en la lista unificada, el vale que Kepler asigno no tiene
  // `status` nuestro -- no existe de este lado todavia.
  estado(s: string | null): string {
    if (!s) return '';
    return ({
      recibida: 'Esperando firma',
      aprobada: 'Aprobado',
      revision: 'En revisión',
      validada: 'Listo',
      rechazada: 'Te lo devolvieron',
    } as Record<string, string>)[s] ?? s;
  }

  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}
