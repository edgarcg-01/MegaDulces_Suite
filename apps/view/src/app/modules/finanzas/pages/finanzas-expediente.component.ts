import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { branchLabel } from '../../../core/constants/store-branches';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import {
  DEPARTAMENTO_SIN, ETAPA_PROTOCOLO_LABEL, ORDEN_ETAPA_PROTOCOLO,
  type EtapaProtocolo, type PersonaExpediente, type RespuestaExpediente, type ValeExpediente,
} from '@megadulces/contracts';
import { ComprobacionesService } from '../comprobaciones.service';
import { mensajeDeErrorBlob } from '../../../core/http/blob-error';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { REFRESCO_VALES_MS } from '../vales-refresco';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';

/**
 * `[GX.59]` — **Expediente**: el trámite de gasto de TODAS las personas, por persona.
 *
 * Pedido del usuario (2026-10-01): *«en lugar de historial será expediente, todos aquellos que
 * tengan el poder de autorizar gastos podrán ver los vales de todos, vas a tenerlos acomodados
 * por usuarios, con su nombre completo además de su username»*.
 *
 * ## Qué reemplaza, y qué NO
 * Reemplaza a **Historial** (`/finanzas/gastos-historial`), que era un calendario de lo propio.
 * ⚠️ **No** reemplaza al expediente de UN vale (`[GX.15]`, los cuatro eslabones en PDF): ése
 * sigue existiendo y es a donde lleva el folio. Son dos cosas con el mismo nombre y conviene
 * saberlo antes de buscar el archivo equivocado.
 *
 * ## El protocolo
 * `[GX.65.2]` Un vale cierra el protocolo con la **firma** y —si se aprobó como prefactura o
 * cotización— la **factura del gasto**. La comprobación de Kepler **dejó de ser forzosa**
 * (decisión del 2026-10-03), y con ella se fueron su botón y su banda de «sin medir».
 * La regla vive en `@megadulces/contracts` y la calcula el SERVIDOR; esta pantalla la muestra.
 *
 * ---- Historia (GX.59): por qué casi todo salía incompleto el primer día ----
 *
 * ⛔ **Medido el 2026-10-01: `finance.expense_comprobaciones` está prácticamente vacía.** El
 * módulo que la llena (GX.8) existe desde hace meses y no se usa. O sea que con la comprobación
 * forzosa, casi los 155 expedientes salen incompletos. No es un defecto de la regla: es el
 * estado real del trámite, y es justo lo que esta pantalla existe para mostrar.
 *
 * ## Lo que NO se dibuja
 * Cuando el servidor no pudo medir la comprobación, el vale sale `sin_medir` y la pantalla lo
 * DICE, con su banda arriba. Pintarlo de rojo acusaría a 19 personas de no comprobar por una
 * consulta que no corrió (ADR-056).
 */
@Component({
  selector: 'app-finanzas-expediente',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ToastModule, InputTextModule, SelectModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in exp">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Expediente</h1>
          <p>El trámite de gasto de cada persona, y qué le falta para cerrar.</p>
        </div>
      </header>

      <!--
        [GX.72] Filtros. Viven FUERA del bloque de carga a proposito: si se escondieran mientras
        recarga, cada cambio de fecha haria saltar la barra bajo el cursor. Los aplica el SERVIDOR
        (los KPIs salen de lo filtrado). La fecha es la del LEVANTAMIENTO, la misma que muestra
        cada vale; se dice en la etiqueta para que nadie la lea como la fecha del gasto.
      -->
      <div class="exp-filtros" role="search" aria-label="Filtrar el expediente">
        <label class="exp-f">
          <span class="exp-f-l">Levantado desde</span>
          <input type="date" class="exp-f-in" [ngModel]="fDesde()" (ngModelChange)="cambiarFecha('desde', $event)"
                 [attr.max]="fHasta() || null" aria-label="Levantado desde" />
        </label>
        <label class="exp-f">
          <span class="exp-f-l">Hasta</span>
          <input type="date" class="exp-f-in" [ngModel]="fHasta()" (ngModelChange)="cambiarFecha('hasta', $event)"
                 [attr.min]="fDesde() || null" aria-label="Levantado hasta" />
        </label>
        <div class="exp-f">
          <span class="exp-f-l" id="exp-f-depto">Departamento</span>
          <p-select [options]="opcionesDepartamento()" [ngModel]="fDepto()" (ngModelChange)="cambiarDepartamento($event)"
                    optionLabel="label" optionValue="value" placeholder="Todos" [showClear]="true" [filter]="true"
                    class="exp-f-sel" ariaLabelledBy="exp-f-depto" />
        </div>
        @if (hayFiltro()) {
          <button type="button" class="exp-btn ghost exp-f-limpiar" (click)="limpiarFiltros()">Limpiar filtros</button>
        }
      </div>
      @if (rangoAlReves()) {
        <p class="exp-f-aviso" role="alert">La fecha «desde» es posterior a «hasta»: corrígela para filtrar.</p>
      }

      @if (cargando()) {
        <div class="exp-msg">Cargando el expediente…</div>
      } @else if (error()) {
        <div class="exp-msg bad">{{ error() }}</div>
      } @else if (datos(); as d) {

        <!--
          [GX.65.2] Aca vivia la banda «Sin medir la comprobacion de Kepler: ningun vale puede
          salir completo». Se retiro con la regla: la comprobacion ya no decide si un vale
          cierra, asi que esa frase seria FALSA (si pueden salir completos sin la tabla).
        -->

        <div class="exp-kpis">
          <div class="exp-kpi"><span class="k">Personas</span><b>{{ d.total.personas }}</b></div>
          <div class="exp-kpi"><span class="k">Vales</span><b>{{ d.total.vales }}</b></div>
          <div class="exp-kpi ok"><span class="k">Protocolo completo</span><b>{{ d.total.completos }}</b></div>
          <div class="exp-kpi bad"><span class="k">Firmados sin cerrar</span><b>{{ d.total.incompletos }}</b></div>
          <div class="exp-kpi"><span class="k">Esperan firma</span><b>{{ d.total.en_captura }}</b></div>
          @if (d.total.sin_medir > 0) {
            <div class="exp-kpi warn"><span class="k">Sin medir</span><b>{{ d.total.sin_medir }}</b></div>
          }
          <div class="exp-kpi"><span class="k">Monto</span><b>{{ money(d.total.monto) }}</b></div>
        </div>
        <!-- [GX.72] Lo que se conto, dicho con el filtro que DEVOLVIO el servidor, no con el
             que la pantalla cree haber mandado: asi el rotulo y los numeros no se separan. -->
        @if (resumenFiltro(); as r) {
          <p class="exp-f-resumen">Mostrando {{ r }}.</p>
        }

        @if (d.truncado) {
          <p class="exp-trunc">Se llegó al tope de filas: hay más vales de los que se muestran.</p>
        }
        <!--
          Se DICE cuantas personas no estan ligadas a un usuario. Mostrar 12 huecos y dejar
          que cada quien suponga por que es peor que nombrar la causa: lo que el expediente
          guarda es quien capturo, y no siempre es un username del padron.
        -->
        @if (d.personas_sin_usuario > 0) {
          <p class="exp-trunc">
            {{ d.personas_sin_usuario }} de {{ d.total.personas }} personas no están ligadas a un
            usuario del padrón: el expediente guarda quién capturó, y ahí no siempre va el username.
          </p>
        }

        @if (d.total.vales === 0 && resumenFiltro()) {
          <!-- [GX.72] Cero con filtro no es «no hay vales»: es «no hay vales EN ESTO». -->
          <p class="exp-msg">Ningún vale con estos filtros. Prueba otro periodo u otro departamento.</p>
        } @else {
        <div class="exp-split">
          <!-- Rail de personas. -->
          <aside class="exp-rail">
            <div class="exp-busca">
              <input pInputText [ngModel]="filtro()" (ngModelChange)="filtro.set($event)"
                     placeholder="Buscar persona…" aria-label="Buscar persona" />
            </div>
            @for (p of personasFiltradas(); track p.username) {
              <button type="button" class="exp-persona" [class.sel]="p.clave === seleccion()"
                      (click)="seleccion.set(p.clave)">
                <span class="exp-nom">{{ p.nombre || p.clave }}</span>
                @if (p.username) {
                  <span class="exp-user">{{ p.username }}</span>
                } @else {
                  <em class="exp-sinnom">sin usuario en el padrón</em>
                }
                <span class="exp-chips">
                  @if (p.incompletos > 0) { <span class="exp-pill bad">{{ p.incompletos }} sin cerrar</span> }
                  @if (p.en_captura > 0) { <span class="exp-pill">{{ p.en_captura }} esperan firma</span> }
                  @if (p.sin_medir > 0) { <span class="exp-pill warn">{{ p.sin_medir }} sin medir</span> }
                  <span class="exp-pill">{{ p.total }} vales</span>
                </span>
              </button>
            } @empty {
              <p class="exp-msg">Ninguna persona coincide con la búsqueda.</p>
            }
          </aside>

          <!-- Los vales de la persona elegida. -->
          <section class="exp-detalle">
            @if (persona(); as p) {
              <div class="exp-det-h">
                <div>
                  <h2>{{ p.nombre || p.clave }}</h2>
                  <p class="exp-det-sub">
                    @if (p.username) { <code>{{ p.username }}</code> }
                    @else { <em>no está ligado a un usuario del padrón — el expediente guarda «{{ p.clave }}»</em> }
                    @if (p.areas.length) { <span> · área {{ p.areas.join(', ') }}</span> }
                  </p>
                </div>
                <div class="exp-det-n">
                  <b>{{ p.total }}</b> vales · <b>{{ money(p.monto) }}</b>
                </div>
              </div>

              @for (v of valesOrdenados(); track v.id) {
                <article class="exp-vale" [attr.data-etapa]="v.protocolo.etapa">
                  <!--
                    [GX.62] Los numeros del soporte documental, en el orden del tramite:
                    solicitud XA1501 -> gasto XA1001 -> (pago XD2601, todavia no).
                    Se escriben con su prefijo porque es lo que alguien teclea en Kepler, y
                    porque el folio pelado NO identifica nada: vive por sucursal y colisiona
                    entre doctypes.
                  -->
                  <header class="exp-vale-h">
                    <span class="exp-folio">XA1501-{{ v.folio_solicitud || '?' }}</span>
                    @for (g of v.gasto_folios; track g) {
                      <span class="exp-folio gasto">XA1001-{{ g }}</span>
                    } @empty {
                      <span class="exp-sin-gasto">sin gasto aplicado</span>
                    }
                    <span class="exp-suc">{{ branchLabel(v.sucursal) || '—' }}</span>
                    <span class="exp-prov">{{ v.proveedor || 'sin proveedor' }}</span>
                    <span class="exp-monto">{{ money(v.importe) }}</span>
                    <span class="exp-etapa" [attr.data-e]="v.protocolo.etapa">{{ etapaLabel(v.protocolo.etapa) }}</span>
                  </header>

                  <div class="exp-vale-b">
                    <span class="exp-meta">{{ v.created_dia }}</span>
                    @if (v.departamento) { <span class="exp-meta">{{ v.departamento }}</span> }
                    @if (v.provisional) { <span class="exp-meta prov">aprobado con cotización</span> }
                    @if (v.comprobacion_folio) {
                      <span class="exp-meta ok">comprobación {{ v.comprobacion_folio }}</span>
                    }
                    @if (v.motivo_rechazo) { <span class="exp-meta bad">{{ v.motivo_rechazo }}</span> }
                  </div>

                  @if (v.protocolo.faltan.length) {
                    <ul class="exp-faltan">
                      @for (f of v.protocolo.faltan; track f.id) {
                        <li><b>{{ f.label }}</b> — {{ f.detalle }}</li>
                      }
                    </ul>
                  }

                  <!--
                    [GX.65.2] Se fue el boton forzoso «Comprobacion de Kepler»: la comprobacion
                    ya no es obligatoria, y ademas mandaba a la captura de la SOLICITUD, no a la
                    de la comprobacion. Queda el de la factura, solo para quien quedo debiendo.
                  -->
                  <footer class="exp-acc">
                    @if (necesitaFactura(v)) {
                      <a class="exp-btn"
                         [routerLink]="['/finanzas/gastos']"
                         [queryParams]="{ folio: v.folio_solicitud, sucursal: v.sucursal }">
                        Subir la factura del gasto
                      </a>
                    }
                    @if (v.folio_solicitud && v.sucursal) {
                      <!--
                        [GX.62] El expediente imprimible de GX.15: solicitud + lo que aporto
                        quien gasto + el gasto aplicado + la comprobacion, en un PDF.
                        Estaba construido desde septiembre -endpoint, servicio y metodo en el
                        cliente- y NINGUNA pantalla lo llamaba. Este es su primer boton.
                      -->
                      <!--
                        Deliberadamente NO es primary: con dos botones naranjas compiten la
                        accion que URGE (la comprobacion que falta) y la de leer. En una
                        pantalla cuyo proposito es decir que falta, eso diluye el mensaje.
                      -->
                      <button type="button" class="exp-btn"
                              [disabled]="pdfCargando() === v.id"
                              (click)="verExpediente(v)">
                        {{ pdfCargando() === v.id ? 'Armando el PDF…' : 'Expediente en PDF' }}
                      </button>
                      <a class="exp-btn ghost"
                         [routerLink]="['/finanzas/gastos']"
                         [queryParams]="{ folio: v.folio_solicitud, sucursal: v.sucursal }">
                        Ver el vale
                      </a>
                    }
                  </footer>
                </article>
              } @empty {
                <p class="exp-msg">Esta persona no tiene vales.</p>
              }
            } @else {
              <p class="exp-msg">Elegí una persona del panel izquierdo.</p>
            }
          </section>
        </div>
        }
      }
      <p-toast />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    /* [GX.59] El Expediente. Tipografia un escalon ARRIBA de la densidad normal de
       Operations: el usuario pidio letras mas grandes en comprobacion de gastos, y esta
       pantalla es donde se decide si un tramite cerro. */
    .exp { display: flex; flex-direction: column; gap: var(--sp-3); }
    .exp-msg { font-size: var(--fs-body); color: var(--fg-2); padding: var(--sp-4); }
    .exp-msg.bad { color: var(--bad-fg); }

    /* [GX.72] Barra de filtros: etiqueta arriba del control, todo en una fila que se parte en
       pantallas angostas. */
    .exp-filtros { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3);
      background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-md); padding: var(--sp-2) var(--sp-3); }
    .exp-f { display: flex; flex-direction: column; gap: 2px; }
    .exp-f-l { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em;
      color: var(--fg-2); font-weight: var(--fw-bold); }
    .exp-f-in { font-family: inherit; font-size: var(--fs-body); padding: 6px 8px; color: var(--fg-1);
      background: var(--surface-card); border: 1px solid var(--surface-border); border-radius: var(--radius-sm); }
    /* La clase va en el HOST de p-select (v22 retiró styleClass): la regla es propia, sin ng-deep. */
    .exp-f-sel { min-width: 14rem; }
    .exp-f-limpiar { align-self: flex-end; }
    .exp-f-aviso { margin: 0; font-size: var(--fs-sm); color: var(--bad-fg); }
    .exp-f-resumen { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }

    .exp-kpis { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .exp-kpi { flex: 1 1 140px; background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); }
    .exp-kpi .k { display: block; font-size: var(--fs-xs); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-2); font-weight: var(--fw-bold); }
    .exp-kpi b { font-size: 1.5rem; font-weight: var(--fw-black); font-variant-numeric: tabular-nums; }
    .exp-kpi.ok b { color: var(--ok-fg); }
    .exp-kpi.bad b { color: var(--bad-fg); }
    .exp-kpi.warn b { color: var(--warn-fg); }
    .exp-trunc { font-size: var(--fs-sm); color: var(--warn-soft-fg); margin: 0; }

    .exp-split { display: grid; grid-template-columns: 300px 1fr; gap: var(--sp-3); align-items: start; }
    /* 56.25rem = 900px exactos (root 16px). En px el breakpoint NO acompana el zoom al 200 %
       (WCAG 1.4.4): la pantalla se queda en dos columnas justo cuando el texto crecio. */
    @media (max-width: 56.25rem) { .exp-split { grid-template-columns: 1fr; } }

    .exp-rail { display: flex; flex-direction: column; gap: 2px; background: var(--surface-card);
      border: 1px solid var(--surface-border); border-radius: var(--radius-md);
      padding: var(--sp-2); max-height: 72vh; overflow: auto; }
    .exp-busca { padding: 0 0 var(--sp-2); }
    .exp-busca input { width: 100%; }
    .exp-persona { text-align: left; background: transparent; border: 0; cursor: pointer;
      padding: var(--sp-2) var(--sp-3); border-radius: var(--radius-sm); display: flex;
      flex-direction: column; gap: 2px; font: inherit; color: inherit; }
    .exp-persona:hover { background: var(--surface-hover); }
    .exp-persona.sel { background: var(--surface-hover); box-shadow: inset 2px 0 0 var(--action); }
    .exp-nom { font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .exp-sinnom { color: var(--fg-3); font-style: italic; font-weight: var(--fw-regular); }
    .exp-user { font-size: var(--fs-xs); color: var(--fg-2); font-family: var(--font-mono); }
    .exp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
    .exp-pill { font-size: var(--fs-micro); font-weight: var(--fw-bold); padding: 1px 6px;
      border-radius: 999px; background: var(--surface-200); color: var(--fg-2); }
    .exp-pill.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .exp-pill.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }

    .exp-detalle { display: flex; flex-direction: column; gap: var(--sp-2); }
    .exp-det-h { display: flex; justify-content: space-between; align-items: flex-start;
      gap: var(--sp-3); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--surface-border); }
    .exp-det-h h2 { font-size: var(--fs-h2); font-weight: var(--fw-bold); margin: 0; }
    .exp-det-sub { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .exp-det-sub code { font-family: var(--font-mono); }
    .exp-det-n { font-size: var(--fs-body); color: var(--fg-2); white-space: nowrap; }

    .exp-vale { background: var(--surface-card); border: 1px solid var(--surface-border);
      border-radius: var(--radius-md); padding: var(--sp-3) var(--sp-4); }
    .exp-vale[data-etapa="incompleto"] { border-left: 3px solid var(--bad-fg); }
    .exp-vale[data-etapa="sin_medir"] { border-left: 3px solid var(--warn-fg); }
    .exp-vale[data-etapa="completo"] { border-left: 3px solid var(--ok-fg); }
    .exp-vale-h { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-3);
      font-size: var(--fs-body); }
    .exp-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: var(--fs-h3); }
    .exp-folio.gasto { color: var(--ok-fg); }
    .exp-sin-gasto { font-size: var(--fs-xs); color: var(--fg-3); font-style: italic; }
    .exp-suc, .exp-prov { color: var(--fg-2); }
    .exp-prov { flex: 1 1 auto; }
    .exp-monto { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; font-size: var(--fs-h3); }
    .exp-etapa { font-size: var(--fs-xs); font-weight: var(--fw-bold); padding: 2px 8px;
      border-radius: 999px; background: var(--surface-200); color: var(--fg-2); white-space: nowrap; }
    .exp-etapa[data-e="completo"] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .exp-etapa[data-e="incompleto"] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .exp-etapa[data-e="sin_medir"] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }

    .exp-vale-b { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin-top: 4px; }
    .exp-meta { font-size: var(--fs-sm); color: var(--fg-2); }
    .exp-meta.prov { color: var(--warn-soft-fg); font-weight: var(--fw-medium); }
    .exp-meta.ok { color: var(--ok-soft-fg); font-weight: var(--fw-medium); }
    .exp-meta.bad { color: var(--bad-soft-fg); }

    .exp-faltan { margin: var(--sp-2) 0 0; padding-left: 1.1rem; font-size: var(--fs-body);
      line-height: 1.5; color: var(--fg-1); }
    .exp-faltan li { margin-bottom: 2px; }
    .exp-faltan b { font-weight: var(--fw-bold); }

    .exp-acc { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
    .exp-btn { font-size: var(--fs-body); font-weight: var(--fw-bold); padding: 7px 14px;
      border-radius: var(--radius-sm); text-decoration: none; border: 1px solid var(--surface-border);
      color: var(--fg-1); background: var(--surface-card); }
    .exp-btn:hover { background: var(--surface-hover); }
    .exp-btn.primary { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .exp-btn.primary:hover { background: var(--action-hover); }
    .exp-btn.ghost { color: var(--fg-2); border-color: transparent; }
  `],
})
export class FinanzasExpedienteComponent {
  /** `[GX.68]` La sucursal del vale se nombra con clave + nombre (`02 La Piedad Abastos`). */
  readonly branchLabel = branchLabel;
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);

  readonly datos = signal<RespuestaExpediente | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  /** SENAL, no campo plano: la lee un `computed` y como propiedad quedaria congelado. */
  readonly filtro = signal('');
  readonly seleccion = signal<string | null>(null);

  readonly money = (n: number) =>
    '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  etapaLabel(e: EtapaProtocolo): string { return ETAPA_PROTOCOLO_LABEL[e] ?? e; }

  readonly personasFiltradas = computed<PersonaExpediente[]>(() => {
    const d = this.datos();
    if (!d) return [];
    // `filtrarPorBusqueda` y no `.toLowerCase().includes()`: acá se busca por NOMBRE DE PERSONA,
    // que es justo donde el `includes` crudo falla más seguido — `toLowerCase()` no quita
    // diacríticos, así que escribir "martinez" no encontraba a "MARTÍNEZ" ni "nunez" a "NÚÑEZ".
    // Tampoco toleraba dos palabras ni el orden ("juan perez" contra "PEREZ JUAN"). El helper
    // normaliza, parte en tokens y los exige todos; con texto vacío devuelve la lista entera,
    // igual que el `if (!q) return d.personas` que reemplaza.
    return filtrarPorBusqueda(d.personas, this.filtro(), (p) => [p.clave, p.username, p.nombre]);
  });

  readonly persona = computed<PersonaExpediente | null>(() => {
    const sel = this.seleccion();
    const lista = this.personasFiltradas();
    if (!lista.length) return null;
    return lista.find((p) => p.clave === sel) ?? lista[0];
  });

  /**
   * Los vales de la persona, con lo que hay que atender arriba. `completo` cae al final:
   * una lista ordenada por fecha esconde el unico vale trabado entre treinta cerrados.
   */
  readonly valesOrdenados = computed<ValeExpediente[]>(() => {
    const p = this.persona();
    if (!p) return [];
    const peso = (e: EtapaProtocolo) => {
      const i = ORDEN_ETAPA_PROTOCOLO.indexOf(e);
      return i < 0 ? ORDEN_ETAPA_PROTOCOLO.length : i;
    };
    return [...p.vales].sort((a, b) =>
      (peso(a.protocolo.etapa) - peso(b.protocolo.etapa))
      || String(b.created_dia).localeCompare(String(a.created_dia)));
  });

  /** Qué vale está armando su PDF. Señal: la lee la plantilla para apagar el botón. */
  readonly pdfCargando = signal<string | null>(null);

  /**
   * `[GX.62]` Abre el expediente imprimible de `[GX.15]`.
   *
   * ⚠️ Se baja como **blob**, no con un enlace directo: la ruta exige el token y un `href`
   * lo manda sin cabecera de autorización — el navegador abriría un 401 en una pestaña en
   * blanco, que se ve igual que un PDF roto.
   */
  verExpediente(v: ValeExpediente): void {
    if (!v.folio_solicitud || !v.sucursal || this.pdfCargando()) return;
    this.pdfCargando.set(v.id);
    this.svc.expedientePdf(v.sucursal, v.folio_solicitud)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (blob) => {
          const url = URL.createObjectURL(blob);
          globalThis.open?.(url, '_blank');
          // Se revoca después: revocarla de inmediato deja la pestaña sin nada que mostrar.
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          this.pdfCargando.set(null);
        },
        // `[GX.70]` El motivo del servidor viaja DENTRO del blob: sin leerlo, un 404 de
        // alcance y una falla del motor de PDF se veían igual — «no se pudo», sin pista.
        error: (e) => {
          this.pdfCargando.set(null);
          mensajeDeErrorBlob(e, 'Intenta de nuevo.').then((motivo) => this.toast.add({
            severity: 'error', summary: 'No se pudo armar el expediente',
            detail: `Solicitud ${v.folio_solicitud}: ${motivo}`, life: 8000 }));
        },
      });
  }

  /** Quedo debiendo la factura por haber subido una cotizacion. */
  necesitaFactura(v: ValeExpediente): boolean {
    return v.protocolo.faltan.some((f) => f.id === 'factura_del_gasto') && !!v.folio_solicitud;
  }

  // ── `[GX.72]` Filtros: fechas de levantamiento + departamento ─────────────────────────
  /** Día de México (AAAA-MM-DD) o vacío. Señales: las leen `computed` y la plantilla. */
  readonly fDesde = signal('');
  readonly fHasta = signal('');
  /** Departamento exacto, `DEPARTAMENTO_SIN`, o `null` = todos. */
  readonly fDepto = signal<string | null>(null);

  readonly hayFiltro = computed(() => !!(this.fDesde() || this.fHasta() || this.fDepto()));
  /** Con AAAA-MM-DD el orden de texto ES el de fechas. */
  readonly rangoAlReves = computed(() => !!this.fDesde() && !!this.fHasta() && this.fDesde() > this.fHasta());

  /**
   * Las opciones salen de lo que el SERVIDOR contó en el periodo (sin el filtro de
   * departamento), con cuántos vales trae cada una: ninguna opción lleva a una pantalla vacía.
   * Si lo elegido ya no aparece en el periodo nuevo se conserva con 0 — si desapareciera, el
   * selector se vería vacío mientras la consulta sigue filtrando por él.
   */
  readonly opcionesDepartamento = computed<{ label: string; value: string }[]>(() => {
    const ops = (this.datos()?.departamentos ?? []).map((o) => ({
      label: `${o.departamento ?? 'Sin departamento'} · ${o.vales}`,
      value: o.departamento ?? DEPARTAMENTO_SIN,
    }));
    const sel = this.fDepto();
    if (sel && !ops.some((o) => o.value === sel)) {
      ops.unshift({ label: `${sel === DEPARTAMENTO_SIN ? 'Sin departamento' : sel} · 0`, value: sel });
    }
    return ops;
  });

  /**
   * El rótulo de lo que se contó, armado con el filtro que DEVOLVIÓ el servidor (no con el que
   * la pantalla cree haber mandado). `null` = sin filtro: no hay nada que aclarar.
   */
  readonly resumenFiltro = computed<string | null>(() => {
    const f = this.datos()?.filtro;
    if (!f || !(f.desde || f.hasta || f.departamento)) return null;
    const dia = (s: string) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
    const partes: string[] = [];
    if (f.desde && f.hasta) partes.push(f.desde === f.hasta ? `lo levantado el ${dia(f.desde)}` : `lo levantado del ${dia(f.desde)} al ${dia(f.hasta)}`);
    else if (f.desde) partes.push(`lo levantado desde el ${dia(f.desde)}`);
    else if (f.hasta) partes.push(`lo levantado hasta el ${dia(f.hasta)}`);
    else partes.push('todas las fechas');
    if (f.departamento) partes.push(f.departamento === DEPARTAMENTO_SIN ? 'vales sin departamento' : `departamento ${f.departamento}`);
    return partes.join(' · ');
  });

  cambiarFecha(cual: 'desde' | 'hasta', v: string | null): void {
    (cual === 'desde' ? this.fDesde : this.fHasta).set(String(v || ''));
    this.cargar();
  }

  cambiarDepartamento(v: string | null): void {
    this.fDepto.set(v || null);
    this.cargar();
  }

  limpiarFiltros(): void {
    this.fDesde.set('');
    this.fHasta.set('');
    this.fDepto.set(null);
    this.cargar();
  }

  /** La petición en curso: un filtro nuevo la cancela, para que no gane la respuesta vieja. */
  private peticion: Subscription | null = null;

  /**
   * Pide el expediente con el filtro vigente. Con el rango al revés NO se pide: el servidor lo
   * rechazaría igual, y la pantalla ya lo está diciendo junto a las fechas.
   */
  private cargar(): void {
    if (this.rangoAlReves()) return;
    this.peticion?.unsubscribe();
    this.cargando.set(true);
    this.error.set(null);
    this.peticion = this.svc.expedientePorUsuario({
      desde: this.fDesde() || null,
      hasta: this.fHasta() || null,
      departamento: this.fDepto(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.aplicar(d); this.cargando.set(false); },
      error: (e) => {
        this.cargando.set(false);
        this.error.set(e?.error?.message || 'No se pudo cargar el expediente.');
      },
    });
  }

  private aplicar(d: RespuestaExpediente): void {
    this.datos.set(d);
    // Se conserva la persona elegida si sigue en el resultado; si no, la primera.
    const sel = this.seleccion();
    if (!sel || !d.personas.some((p) => p.clave === sel)) {
      this.seleccion.set(d.personas.length ? d.personas[0].clave : null);
    }
  }

  /** Hay un refresco en vuelo: el siguiente no se encima. */
  private refrescando = false;

  /**
   * `[GX.73]` **El refresco en segundo plano**, con el filtro vigente. Sin aviso de carga y sin
   * pisar con un error lo que ya está en pantalla.
   *
   * ⛔ No corre mientras se arma un PDF ni mientras una carga pedida a mano está en vuelo: no puede
   * ganarle la carrera a lo que la persona acaba de pedir. Y si el filtro cambió mientras volaba,
   * la respuesta es de otro filtro y se descarta — publicarla mostraría KPIs de un periodo con el
   * rótulo de otro.
   */
  refrescar(): void {
    if (this.cargando() || this.pdfCargando() || this.rangoAlReves() || this.refrescando) return;
    this.refrescando = true;
    const filtro = { desde: this.fDesde() || null, hasta: this.fHasta() || null, departamento: this.fDepto() };
    this.svc.expedientePorUsuario(filtro).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        const mismo = filtro.desde === (this.fDesde() || null) && filtro.hasta === (this.fHasta() || null)
          && filtro.departamento === this.fDepto();
        if (mismo && !this.cargando()) this.aplicar(d);
        this.refrescando = false;
      },
      error: () => { this.refrescando = false; },
    });
  }

  constructor() {
    this.cargar();
    // `[GX.73]` Se refresca sola mientras la pestaña se ve.
    encuestarVisible(REFRESCO_VALES_MS, () => this.refrescar());
  }
}
