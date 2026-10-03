import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ToastModule } from 'primeng/toast';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import {
  ETAPA_PROTOCOLO_LABEL, ORDEN_ETAPA_PROTOCOLO,
  type EtapaProtocolo, type PersonaExpediente, type RespuestaExpediente, type ValeExpediente,
} from '@megadulces/contracts';
import { ComprobacionesService } from '../comprobaciones.service';
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
 * ## El protocolo, y por qué casi todo va a salir incompleto el primer día
 * Un vale cierra el protocolo con tres cosas: la firma, la **comprobación de Kepler** (que el
 * usuario pidió hacer forzosa) y —si se aprobó con una cotización— la **factura del gasto**.
 * La regla vive en `@megadulces/contracts` y la calcula el SERVIDOR; esta pantalla la muestra.
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
  imports: [CommonModule, FormsModule, RouterLink, ToastModule, InputTextModule],
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

      @if (cargando()) {
        <div class="exp-msg">Cargando el expediente…</div>
      } @else if (error()) {
        <div class="exp-msg bad">{{ error() }}</div>
      } @else if (datos(); as d) {

        <!--
          La banda que declara lo que no se pudo medir. Va ARRIBA del tablero: si fuera un
          pie, el numero de «incompletos» se leeria como un hecho y seria una medicion que
          no corrio. Nunca se pinta si la medicion si ocurrio.
        -->
        @if (!d.comprobaciones_medidas) {
          <div class="exp-aviso">
            <strong>Sin medir la comprobación de Kepler.</strong>
            La tabla de comprobaciones no está disponible en este entorno, así que ningún vale
            puede salir completo. Lo que ves no dice que nadie comprobó: dice que no se pudo
            preguntar.
          </div>
        }

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
                    <span class="exp-suc">{{ v.sucursal || '—' }}</span>
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
                    Los dos botones del pedido. El de Kepler se ofrece SIEMPRE que falte,
                    porque es el forzoso; el de la factura solo a quien quedo debiendo, que
                    es la unica persona a la que se le puede reclamar.
                  -->
                  <footer class="exp-acc">
                    @if (necesitaKepler(v)) {
                      <a class="exp-btn primary"
                         [routerLink]="['/finanzas/solicitudes']"
                         [queryParams]="{ folio: v.folio_solicitud }">
                        Comprobación de Kepler
                      </a>
                    }
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

    .exp-aviso { font-size: var(--fs-body); line-height: 1.45; padding: var(--sp-3) var(--sp-4);
      background: var(--warn-soft-bg); border: 1px solid var(--warn-border);
      border-left: 3px solid var(--warn-fg); border-radius: var(--radius-sm); color: var(--warn-soft-fg); }
    .exp-aviso strong { display: block; }

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
    @media (max-width: 900px) { .exp-split { grid-template-columns: 1fr; } }

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
    .exp-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: 1rem; }
    .exp-folio.gasto { color: var(--ok-fg); }
    .exp-sin-gasto { font-size: var(--fs-xs); color: var(--fg-3); font-style: italic; }
    .exp-suc, .exp-prov { color: var(--fg-2); }
    .exp-prov { flex: 1 1 auto; }
    .exp-monto { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; font-size: 1rem; }
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
    const q = this.filtro().trim().toLowerCase();
    if (!q) return d.personas;
    return d.personas.filter((p) =>
      p.clave.toLowerCase().includes(q)
      || (p.username || '').toLowerCase().includes(q)
      || (p.nombre || '').toLowerCase().includes(q));
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
        error: () => {
          this.pdfCargando.set(null);
          this.toast.add({ severity: 'error', summary: 'No se pudo armar el expediente',
            detail: `Solicitud ${v.folio_solicitud}` });
        },
      });
  }

  /** Falta la comprobacion de Kepler: el boton forzoso. */
  necesitaKepler(v: ValeExpediente): boolean {
    return v.protocolo.faltan.some((f) => f.id === 'comprobacion_kepler') && !!v.folio_solicitud;
  }

  /** Quedo debiendo la factura por haber subido una cotizacion. */
  necesitaFactura(v: ValeExpediente): boolean {
    return v.protocolo.faltan.some((f) => f.id === 'factura_del_gasto') && !!v.folio_solicitud;
  }

  constructor() {
    this.svc.expedientePorUsuario().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.datos.set(d);
        this.cargando.set(false);
        if (d.personas.length) this.seleccion.set(d.personas[0].clave);
      },
      error: (e) => {
        this.cargando.set(false);
        this.error.set(e?.error?.message || 'No se pudo cargar el expediente.');
      },
    });
  }
}
