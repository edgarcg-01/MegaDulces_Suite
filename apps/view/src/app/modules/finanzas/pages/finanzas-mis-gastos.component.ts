import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpenseProof, type ValeGasto,
} from '../comprobaciones.service';
import { ValeGastoPeekComponent } from '../components/vale-gasto-peek.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { parseLocalDate } from '../../../core/utils/mx-date';
// `[GX.39]` La etapa la decide el SERVIDOR con `etapaDeEjercicio()`; acá sólo se lee el tipo.
import type { EtapaEjercicio, ValeAsignado } from '@megadulces/contracts';
import {
  DIAS_ATORADO, agruparPorProveedor, diasDesde, textoAntiguedad, ubicacionDe,
  type ColumnaId, type GrupoProveedor, type ZonaId,
} from '../mis-gastos-columnas';

/**
 * `[GX.46]` `asignado` es una etapa **de esta pantalla**, no del contrato: el contrato decide
 * el ciclo de un expediente NUESTRO, y un vale asignado todavia no lo es.
 */
type EtapaLista = EtapaEjercicio | 'asignado';

/** Una fila del tablero, venga de Kepler o de un expediente nuestro. */
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
  /** `[GX.55]` Si esta fila ofrece el camino para subir un archivo. */
  puedeSubir?: boolean;
  /** Sólo los asignados: si Kepler ya genero su gasto. */
  aplicada: boolean | null;
  /** `[GX.65.3]` El proveedor por su CLAVE de Kepler, y los gastos XA1001 ligados. */
  proveedor_clave: string | null;
  proveedor_nombre: string | null;
  gasto_folios: string[];
  /** `null` = viene de Kepler y no tiene expediente: no se puede abrir. */
  proof: ExpenseProof | null;
}

interface Columna {
  id: ColumnaId;
  n: number;
  titulo: string;
  doc: string;
  ayuda: string;
  pendLabel: string;
  esperaLabel: string;
  esperaAyuda: string;
  pendientes: FilaLista[];
  espera: FilaLista[];
  grupos: GrupoProveedor<FilaLista>[];
}

/**
 * `[GX.33]` — **Mis gastos.** Lo que YO levanté, en qué quedó cada uno, y su expediente.
 *
 * ## `[GX.65.5]` Tres columnas en vez de cuatro pestañas
 * Rediseño acordado con maqueta y simulación (2026-10-03): **Solicitudes → Pendientes de
 * comprobación → Expedientes**. En cada columna, arriba en ROJO lo que te toca; abajo lo que ya
 * pasó esa etapa, agrupado por la clave de proveedor de Kepler. La regla de qué va en cada
 * columna vive en `mis-gastos-columnas.ts` y se prueba aparte. Un vale vive en UN solo lugar.
 *
 * ## ⛔ No filtra del lado del cliente
 * Pide `GET /mine`, que el servidor acota por el token. Si el recorte viviera acá, un error
 * de esta pantalla mostraría el gasto ajeno — y peor, nadie se enteraría.
 *
 * ## ⚠️ Un rechazo se ve acá, pero no para siempre
 * A las 24 h el servidor deja de devolverlo (`[GX.29]`). Se dice en el vacío, para que nadie
 * crea que se perdió.
 *
 * ## Lo que esta entrega NO trae todavía
 * Los filtros avanzados de la maqueta (accesos rápidos, «Más filtros», periodo de pagados) son
 * `[GX.65.6]`. El selector por niveles de la pirámide es `[GX.65.4b]`.
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
          <p class="surf-page-sub">Tus vales, desde que los levantas hasta que el expediente queda completo.</p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      @if (cargando()) { <div class="mg-muted">Cargando…</div> }
      @else if (error()) { <div class="mg-err">{{ error() }}</div> }
      @else {
        <!--
          Los totales de arriba. «Te tocan» y «Esperan a otro» cuentan TODOS los abiertos (desde
          GX.65.1 llegan completos, sin el corte del limit). «Validados» sale del SERVIDOR: la
          lista de cerrados viene recortada y contarla mentiria.
        -->
        <div class="mg-kpis">
          <div class="mg-kpi bad">
            <span class="mg-kpi-t">Sin completar · te tocan</span>
            <strong class="mg-kpi-v">{{ teTocan() }}</strong>
          </div>
          <div class="mg-kpi">
            <span class="mg-kpi-t">Esperan a otra persona</span>
            <strong class="mg-kpi-v">{{ esperanAOtro() }}</strong>
          </div>
          <div class="mg-kpi ok">
            <span class="mg-kpi-t">Expedientes validados</span>
            <strong class="mg-kpi-v">{{ kpis().validadas }}</strong>
          </div>
          <div class="mg-kpi">
            <span class="mg-kpi-t">En juego (abiertos)</span>
            <strong class="mg-kpi-v mg-kpi-money">{{ money(enJuego()) }}</strong>
          </div>
        </div>

        <div class="mg-barra">
          <span class="p-input-icon-left mg-buscar">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input pInputText [(ngModel)]="q" (keyup.enter)="cargar()"
                   placeholder="Folio, proveedor o concepto…" />
          </span>
          @if (q) { <button type="button" class="mg-link" (click)="q = ''; cargar()">limpiar</button> }
        </div>

        @if (!unificadas().length) {
          <div class="mg-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <div>
              @if (q) {
                <strong>Ninguno de tus gastos coincide con «{{ q }}».</strong>
              } @else {
                <strong>Todavía no levantaste ningún gasto.</strong>
                <div class="mg-muted">Cuando levantes uno en Kepler a tu nombre, aparece acá con su estado.</div>
              }
              <div class="mg-muted">Un gasto que te devolvieron deja de verse a las 24 h: ése se vuelve a capturar.</div>
            </div>
          </div>
        } @else {
          @if (fueraDeColumnas() > 0) {
            <!-- Un estado que la regla no conoce se DICE, no se mete callado en una columna. -->
            <div class="mg-err">{{ fueraDeColumnas() }} vale(s) con un estado que esta pantalla no sabe ubicar. Avisa a Sistemas.</div>
          }

          <div class="mg-board">
            @for (col of columnas(); track col.id) {
              <section class="mg-col" [attr.data-col]="col.id" [attr.aria-label]="col.titulo">
                <header class="mg-col-h">
                  <div class="mg-col-t">
                    <span class="mg-col-n">{{ col.n }}</span>
                    <h2>{{ col.titulo }}</h2>
                    <span class="mg-col-doc">{{ col.doc }}</span>
                  </div>
                  <p>{{ col.ayuda }}</p>
                </header>

                <div class="mg-zona">
                  <div class="mg-zona-h rojo">{{ col.pendLabel }} <span class="mg-n">{{ col.pendientes.length }}</span></div>
                  @for (p of col.pendientes; track p.key) {
                    <ng-container [ngTemplateOutlet]="tarjeta" [ngTemplateOutletContext]="{ $implicit: p, pendiente: col.id !== 'expedientes' }" />
                  }
                  @if (!col.pendientes.length) { <div class="mg-zona-vacia">Nada por aquí.</div> }
                </div>

                <div class="mg-zona">
                  <div class="mg-zona-h verde">{{ col.esperaLabel }} <span class="mg-n">{{ col.espera.length }}</span></div>
                  @if (col.esperaAyuda) { <div class="mg-faint mg-zona-ayuda">{{ col.esperaAyuda }}</div> }
                  @for (g of col.grupos; track g.clave ?? 'sin-clave') {
                    <details class="mg-grupo" open>
                      <summary>
                        @if (g.clave) { <span class="mg-clave">{{ g.clave }}</span> }
                        <span class="mg-grupo-n">{{ g.etiqueta }}</span>
                        <span class="mg-n">{{ g.filas.length }}</span>
                        <span class="mg-grupo-t">{{ money(g.total) }}</span>
                      </summary>
                      @for (p of g.filas; track p.key) {
                        <ng-container [ngTemplateOutlet]="tarjeta" [ngTemplateOutletContext]="{ $implicit: p, pendiente: false }" />
                      }
                    </details>
                  }
                  @if (!col.espera.length) {
                    <div class="mg-zona-vacia">
                      @if (col.id === 'expedientes') {
                        Todavía ninguno. El pago XD2601 aún no se puede ligar a su gasto en Kepler: hasta entonces nada se marca como pagado.
                      } @else { Nada por aquí. }
                    </div>
                  }
                </div>
              </section>
            }
          </div>
        }
      }

      <ng-template #tarjeta let-p let-pendiente="pendiente">
        <article class="mg-item" [class.rojo]="pendiente"
                 [attr.role]="p.proof ? 'button' : null" [attr.tabindex]="p.proof ? 0 : null"
                 [attr.aria-label]="p.proof ? ('Ver el vale ' + p.folio) : null"
                 (click)="p.proof && abrir(p.proof)"
                 (keydown.enter)="p.proof && abrir(p.proof)"
                 (keydown.space)="p.proof && abrir(p.proof); p.proof && $event.preventDefault()">
          <div class="mg-it-head">
            <span class="mg-folio">{{ p.folio || 'sin folio' }}</span>
            @if (p.sucursal) { <span class="mg-faint">suc {{ p.sucursal }}</span> }
            @if (pendiente && antiguedad(p); as a) {
              <span class="mg-faint" [class.mg-atorado]="atorado(p)">{{ a }}</span>
            }
            <span class="mg-grow"></span>
            <span class="mg-imp">{{ money(p.importe) }}</span>
          </div>
          <div class="mg-it-con">{{ p.titulo || '—' }}</div>
          <!-- Los separadores van como borde CSS: un vale sin fecha no arranca con un «·» suelto. -->
          <div class="mg-it-meta">
            @if (diaLocal(p.fecha); as d) { <span>{{ d | date: 'dd/MM/yy' }}</span> }
            @if (p.detalle) { <span>{{ p.detalle }}</span> }
            @if (p.proveedor_clave) {
              <span class="mg-clave">{{ p.proveedor_clave }}</span>
              @if (p.proveedor_nombre) { <span>{{ p.proveedor_nombre }}</span> }
            }
          </div>
          <div class="mg-it-chips">
            @if (p.etapa === 'asignado') {
              <span class="mg-chip bad">{{ p.etapa_label }}</span>
              @if (p.aplicada) { <span class="mg-chip ok">Ya ejercido en Kepler</span> }
            } @else {
              <span class="mg-chip" [class.ok]="p.status === 'validada'"
                    [class.warn]="p.status === 'revision'"
                    [class.bad]="p.status === 'rechazada' || p.status === 'aprobada'">{{ estado(p.status) }}</span>
              @if (p.status === 'aprobada') {
                <span class="mg-chip bad">{{ p.debeFactura ? 'te toca subir la factura del pago' : 'te toca subir la evidencia' }}</span>
              }
            }
            <!-- [GX.65.3] El gasto de Kepler es DATO: se muestra, no mueve el vale de columna. -->
            @for (g of p.gasto_folios; track g) { <span class="mg-chip">Kepler: XA1001-{{ g }}</span> }
          </div>
          @if (p.puedeSubir) {
            <a class="mg-asig-b" [routerLink]="['/finanzas/gastos']"
               [queryParams]="{ folio: p.folio, sucursal: p.sucursal }" (click)="$event.stopPropagation()">
              <i class="pi pi-camera" aria-hidden="true"></i>&nbsp;{{ p.etapa === 'asignado' ? 'Subir evidencia' : (p.debeFactura ? 'Subir la factura' : 'Subir evidencia') }}
            </a>
          }
          @if (p.motivo_rechazo) { <div class="mg-it-nota bad">Te lo devolvieron: {{ p.motivo_rechazo }}</div> }
          @if (p.etapa === 'ejercido') { <div class="mg-it-nota ok">{{ p.etapa_explicacion }}</div> }
        </article>
      </ng-template>

      <!-- El mismo visor que usan Aprobación y el Historial. Acá sin acciones: es lo tuyo,
           pero quien decide sobre el dinero es otra persona. -->
      <app-vale-gasto-peek [open]="abierto() !== null" (openChange)="cerrar($event)" [vale]="abierto()" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .mg { display: flex; flex-direction: column; gap: var(--sp-3); }
    .mg-muted { font-size: var(--fs-sm); color: var(--fg-2); }
    .mg-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-grow { flex-grow: 1; }
    .mg-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }
    .mg-link { border: 0; background: transparent; color: var(--action); font: inherit;
      font-size: var(--fs-xs); cursor: pointer; }

    .mg-kpis { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
    .mg-kpi { flex: 1 1 10rem; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); }
    .mg-kpi.ok { border-color: var(--ok-fg); }
    .mg-kpi.bad { border-color: var(--bad-border); }
    .mg-kpi.bad .mg-kpi-v { color: var(--bad-fg); }
    .mg-kpi-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .mg-kpi-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h1); font-weight: var(--fw-bold); line-height: 1.1; }
    .mg-kpi-money { font-size: var(--fs-lg); }

    .mg-barra { display: flex; align-items: center; gap: var(--sp-2); }
    .mg-buscar input { width: 20rem; max-width: 100%; }

    .mg-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .mg-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    /* [GX.65.5] Las tres columnas. En pantalla angosta se apilan, en el mismo orden. */
    .mg-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); align-items: start; }
    @media (max-width: 68.75rem) { .mg-board { grid-template-columns: 1fr; } }
    .mg-col { background: var(--surface-ground); border: 1px solid var(--border-color);
      border-radius: var(--r-md); display: flex; flex-direction: column; min-width: 0; }
    .mg-col-h { padding: var(--sp-3); background: var(--card-bg); border-bottom: 1px solid var(--border-color);
      border-radius: var(--r-md) var(--r-md) 0 0; }
    .mg-col-h p { margin: 4px 0 0; font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-col-t { display: flex; align-items: center; gap: var(--sp-2); }
    .mg-col-t h2 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .mg-col-n { width: 1.4rem; height: 1.4rem; border-radius: 50%; display: grid; place-items: center;
      background: var(--fg-1); color: var(--card-bg); font-size: var(--fs-xs); font-weight: var(--fw-bold); flex: none; }
    .mg-col-doc { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-zona { padding: var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2); }
    .mg-zona + .mg-zona { border-top: 1px solid var(--border-color); }
    .mg-zona-h { font-size: var(--fs-micro); font-weight: var(--fw-bold); text-transform: uppercase;
      letter-spacing: .05em; padding: 0 var(--sp-1); display: flex; align-items: center; gap: var(--sp-1); }
    .mg-zona-h.rojo { color: var(--bad-fg); }
    .mg-zona-h.verde { color: var(--ok-fg); }
    .mg-zona-ayuda { padding: 0 var(--sp-1); }
    .mg-zona-vacia { font-size: var(--fs-xs); color: var(--fg-3); padding: var(--sp-2); text-align: center; }
    .mg-n { font-variant-numeric: tabular-nums; border: 1px solid currentColor; border-radius: 999px;
      padding: 0 6px; font-size: var(--fs-micro); letter-spacing: 0; }

    .mg-grupo { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .mg-grupo > summary { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2);
      cursor: pointer; font-size: var(--fs-sm); list-style: none; }
    .mg-grupo > summary::-webkit-details-marker { display: none; }
    .mg-grupo > summary:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .mg-grupo-n { font-weight: var(--fw-bold); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mg-grupo-t { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); }
    .mg-grupo .mg-item { border-width: 0; border-top: 1px solid var(--border-color); border-radius: 0; }
    .mg-clave { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }

    .mg-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-sm); padding: var(--sp-3); display: flex; flex-direction: column;
      gap: 4px; cursor: pointer; }
    .mg-item.rojo { border-left: 3px solid var(--bad-fg); }
    .mg-item:hover { border-color: var(--action); }
    .mg-item:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .mg-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .mg-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .mg-atorado { color: var(--warn-fg); font-weight: var(--fw-bold); }
    .mg-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); }
    .mg-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .mg-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-it-meta > span + span::before { content: '·'; margin-right: 6px; }
    .mg-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .mg-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .mg-chip.ok { color: var(--ok-fg); border-color: var(--ok-fg); }
    .mg-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .mg-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .mg-it-nota { font-size: var(--fs-xs); margin-top: 2px; }
    .mg-it-nota.bad { color: var(--bad-fg); }
    .mg-it-nota.ok { color: var(--ok-fg); }
    .mg-asig-b { align-self: flex-start; display: inline-flex; align-items: center;
      border: 1px solid var(--bad-fg); background: var(--bad-fg); color: var(--action-fg, #fff); border-radius: var(--r-sm);
      padding: 0.3rem 0.7rem; font-size: var(--fs-xs); text-decoration: none; margin-top: var(--sp-1); }
    .mg-asig-b:hover { filter: brightness(0.92); }
    .mg-asig-b:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
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
   * ⚠️ Los KPI del estado salen de `kpis` del SERVIDOR, no de contar `filas()`: la lista de
   * cerrados viene recortada, así que contarla diría «tenés 200» al que tiene 340.
   */
  private readonly reporte = signal<{ recibidas: number; validadas: number; rechazadas: number } | null>(null);
  readonly kpis = computed(() => this.reporte() ?? { recibidas: 0, validadas: 0, rechazadas: 0 });

  /**
   * `[GX.41]` Los vales que Kepler le asigno. Salen del SERVIDOR ya recortados por su
   * username — acá no se filtra nada.
   */
  readonly asignados = signal<ValeAsignado[]>([]);

  /**
   * `[GX.46]` **UNA sola lista** de entrada: el vale que Kepler asigno y el expediente nuestro.
   * ⚠️ `proof` en `null` marca al que **no tiene expediente**: no se puede abrir y en su lugar
   * ofrece el botón para crearlo.
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
      proveedor_clave: null, proveedor_nombre: null, gasto_folios: [],
    })),
    ...this.filas().map((p): FilaLista => ({
      key: `p:${p.id}`,
      folio: p.folio_solicitud, sucursal: p.sucursal, fecha: p.fecha_gasto, importe: p.importe,
      titulo: p.proveedor, detalle: p.clasificacion ? this.tipoGasto(p.clasificacion) : null,
      debeFactura: p.provisional === true,
      // `[GX.55]` Aprobado = le falta algo por subir. Es el estado que la captura abre en modo
      // evidencia; ofrecer el botón en cualquier otro llevaría a una pantalla cerrada.
      puedeSubir: p.status === 'aprobada',
      etapa: p.etapa ?? null, etapa_label: p.etapa_label ?? '',
      etapa_explicacion: p.etapa_explicacion ?? '',
      status: p.status, motivo_rechazo: p.motivo_rechazo, aplicada: null, proof: p,
      proveedor_clave: p.proveedor_clave ?? null, proveedor_nombre: p.proveedor_nombre ?? null,
      gasto_folios: p.gasto_folios ?? [],
    })),
  ]);

  /** `[GX.65.5]` Las tres columnas, armadas con la regla de `mis-gastos-columnas.ts`. */
  readonly columnas = computed<Columna[]>(() => {
    const cajon: Record<ColumnaId, Record<ZonaId, FilaLista[]>> = {
      solicitudes: { pendiente: [], espera: [] },
      comprobacion: { pendiente: [], espera: [] },
      expedientes: { pendiente: [], espera: [] },
    };
    for (const f of this.unificadas()) {
      const u = ubicacionDe(f);
      if (u) cajon[u.columna][u.zona].push(f);
    }
    // Los pendientes, el más viejo primero: lo que más urge arriba.
    const porAntiguedad = (a: FilaLista, b: FilaLista) => String(a.fecha ?? '').localeCompare(String(b.fecha ?? ''));
    for (const c of Object.values(cajon)) c.pendiente.sort(porAntiguedad);
    const armar = (id: ColumnaId, n: number, titulo: string, doc: string, ayuda: string,
                   pendLabel: string, esperaLabel: string, esperaAyuda: string): Columna => ({
      id, n, titulo, doc, ayuda, pendLabel, esperaLabel, esperaAyuda,
      pendientes: cajon[id].pendiente, espera: cajon[id].espera,
      grupos: agruparPorProveedor(cajon[id].espera),
    });
    return [
      armar('solicitudes', 1, 'Solicitudes', 'XA1501', 'Lo que levantaste en Kepler: le subes la evidencia y la revisan.',
        'Pendientes', 'Enviadas · esperan «Revisado»', ''),
      armar('comprobacion', 2, 'Pendientes de comprobación', 'factura', 'Aprobados como prefactura o cotización, o que todavía deben su evidencia.',
        'Te toca subirla', 'Enviada · en revisión', ''),
      // ⚠️ En Expedientes la zona de arriba es «sin pago» y NO va en rojo: espera a Finanzas.
      armar('expedientes', 3, 'Expedientes', 'XD2601', 'Revisados. Se cierran cuando Finanzas registra el pago.',
        'Sin pago', 'Pagados', 'Por proveedor y fecha de pago.'),
    ];
  });

  /** Lo que la regla no sabe ubicar: se cuenta para DECIRLO. */
  readonly fueraDeColumnas = computed(() => this.unificadas().filter((f) => ubicacionDe(f) === null).length);

  /** Lo que te pide algo a ti: los rojos de Solicitudes y de Pendientes de comprobación. */
  readonly teTocan = computed(() => this.columnas()
    .filter((c) => c.id !== 'expedientes').reduce((n, c) => n + c.pendientes.length, 0));

  /** Lo que espera a otra persona: revisión, o el pago de Finanzas. */
  readonly esperanAOtro = computed(() => {
    const col = (id: ColumnaId) => this.columnas().find((c) => c.id === id);
    return (col('solicitudes')?.espera.length ?? 0)
      + (col('comprobacion')?.espera.length ?? 0)
      + (col('expedientes')?.pendientes.length ?? 0);
  });

  /** Dinero de lo que todavía no está cerrado de nuestro lado (todo menos lo validado). */
  readonly enJuego = computed(() => this.unificadas()
    .filter((f) => { const u = ubicacionDe(f); return !!u && u.columna !== 'expedientes'; })
    .reduce((s, f) => s + (Number(f.importe) || 0), 0));

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

  antiguedad(p: FilaLista): string { return textoAntiguedad(diasDesde(p.fecha)); }
  atorado(p: FilaLista): boolean { const d = diasDesde(p.fecha); return d !== null && d > DIAS_ATORADO; }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  /**
   * Cómo se lee cada estado **desde el lado de quien levantó el gasto**: a quien aprueba
   * «aprobada» le dice que ya firmó; a quien capturó, que todavía le toca hacer algo.
   */
  estado(s: string | null): string {
    if (!s) return '';
    return ({
      recibida: 'Esperando «Revisado»',
      aprobada: 'Aprobado',
      revision: 'En revisión',
      validada: 'Revisado',
      rechazada: 'Te lo devolvieron',
    } as Record<string, string>)[s] ?? s;
  }

  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}
