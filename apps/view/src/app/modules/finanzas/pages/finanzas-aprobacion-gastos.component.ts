import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
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
 * `[GX.20]` La fecha ISO como `Date` **local**, para que el pipe de fecha no corra el día.
 *
 * ⚠️ `new Date('2026-09-25')` es medianoche **UTC**, y en México (−06:00) eso es el 24 a las
 * 18:00 — el pipe imprimiría «24 sep». Es la misma trampa que la Fase LC.16 pagó en el
 * respaldo, el CSV y el orden de un TXT ya entregado. Construyéndola por partes, la fecha
 * es exactamente el día que dice.
 */
export function isoADiaLocal(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').slice(0, 10));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Corre una fecha ISO N días, sin salirse del calendario.
 *
 * Se hace en UTC a propósito: mover un `Date` local a través de un cambio de horario daría
 * 23 o 25 horas y el día podría repetirse o saltarse. Acá sólo se mueve el casillero.
 */
export function sumarDias(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').slice(0, 10));
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * `[GX.20]` — **Aprobación de gastos.** El día del gasto, en tres pestañas.
 *
 * La pantalla de GX.17 era una bandeja: «todo lo que espera firma, de cualquier fecha».
 * Ahora es **el día**: lo que se levantó ese día, partido por lo que hay que hacer con ello.
 *
 * | Pestaña | Qué trae | Qué se hace ahí |
 * |---|---|---|
 * | **Aprobar** | Lo `recibida` | Dar la luz verde, o rechazar con motivo. |
 * | **Ejercer** | Lo `aprobada` y lo `revision` | Ya tiene luz verde y todavía no cierra. |
 * | **Todos** | El día entero | Leer. Incluye lo ya cerrado. |
 *
 * El reparto lo hace el servidor (`etapas-del-dia.ts`, función pura con sus pruebas), no
 * esta pantalla: si mañana aparece un estado nuevo en la tabla cae en `sin_etapa` y acá sale
 * marcado, en vez de colarse en «cerrado» y desaparecer.
 *
 * ## ⛔ Acotar por día NO esconde lo que espera firma
 * Un expediente que nadie aprobó anteayer no puede dejar de existir porque hoy miramos hoy.
 * Por eso el rail de días marca **cuántas firmas debe cada uno** y, cuando queda algo afuera
 * del rango, la pestaña *Aprobar* lo dice con su monto. El día filtra lo que se LEE.
 *
 * ## ⚠️ El día es el de CAPTURA
 * «Los levantamientos que se hicieron al día» es cuándo se **levantó** el expediente. El
 * gasto puede ser de la semana pasada: cada renglón muestra las dos fechas, justo porque no
 * siempre coinciden.
 *
 * ## ⛔ Aprobar sigue siendo de a uno
 * No hay «aprobar el grupo entero». Agrupar y filtrar es para **leer**, no para firmar en
 * bloque: un botón que autoriza 40 gastos de un clic convierte la revisión en un trámite.
 */
@Component({
  selector: 'app-finanzas-aprobacion-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, InputTextModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ap">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Aprobación de gastos</h1>
          <p class="surf-page-sub">Los levantamientos del día, partidos por lo que falta hacer con ellos.</p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      <!-- ── El día ──────────────────────────────────────────────────────────────── -->
      <nav class="ap-dia" aria-label="Día que se está mirando">
        <button pButton type="button" class="p-button-text p-button-sm" aria-label="Día anterior"
                [disabled]="cargando()" (click)="mover(-1)">
          <i class="pi pi-chevron-left" aria-hidden="true"></i>
        </button>

        <div class="ap-dia-hoy">
          <strong>{{ diaLocal(fechaActiva()) | date: 'EEEE d \\'de\\' MMMM' }}</strong>
          @if (datos()?.es_hoy) { <span class="ap-chip ok">hoy</span> }
          @else { <button type="button" class="ap-link" (click)="irAHoy()">ir a hoy</button> }
        </div>

        <button pButton type="button" class="p-button-text p-button-sm" aria-label="Día siguiente"
                [disabled]="cargando() || datos()?.es_hoy" (click)="mover(1)">
          <i class="pi pi-chevron-right" aria-hidden="true"></i>
        </button>

        <label class="ap-fecha-in">
          <span class="ap-sr">Elegir día</span>
          <input type="date" [ngModel]="fechaActiva()" (ngModelChange)="irADia($event)" [max]="datos()?.hoy || null" />
        </label>

        <span class="ap-grow"></span>

        <!-- El rail dice qué días deben firmas. Es lo que impide que el día esconda trabajo. -->
        <div class="ap-rail">
          @for (d of railVisible(); track d.dia) {
            <button type="button" class="ap-rail-d" [class.on]="d.dia === fechaActiva()"
                    [title]="d.n + ' levantamientos · ' + money(d.monto) + (d.pendientes ? ' · ' + d.pendientes + ' esperan firma' : '')"
                    (click)="irADia(d.dia)">
              <span class="ap-rail-n">{{ diaLocal(d.dia) | date: 'd' }}</span>
              @if (d.pendientes) { <span class="ap-rail-p" aria-label="esperan firma">{{ d.pendientes }}</span> }
            </button>
          }
        </div>
      </nav>

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
        @if (pestana() === 'aprobar' && d.pendientes_fuera_del_dia.n) {
          <div class="ap-aviso">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>
              Otros días tienen <strong>{{ d.pendientes_fuera_del_dia.n }}</strong> esperando firma
              ({{ money(d.pendientes_fuera_del_dia.monto) }}). Están marcados en el rail de arriba.
            </span>
          </div>
        }

        @if (!d.total) {
          <div class="ap-vacio">
            <i class="pi pi-calendar" aria-hidden="true"></i>
            <div><strong>Ese día no se levantó ningún gasto.</strong>
              <div class="ap-muted">Probá otro día del rail, o volvé a hoy.</div>
            </div>
          </div>
        } @else {
          <div class="ap-cols">
            <!-- El rail de departamentos sólo aplica a lo que se firma: quien autoriza no
                 revisa renglones sueltos, revisa «lo de Logística». -->
            @if (pestana() === 'aprobar' && d.aprobar.por_departamento.length > 1) {
              <aside class="ap-grupos">
                <div class="ap-grupos-t">Por departamento</div>
                <button type="button" class="ap-grupo" [class.on]="!grupo()" (click)="grupo.set(null)">
                  <span class="ap-g-t">Todos</span>
                  <span class="ap-g-n">{{ d.aprobar.total }}</span>
                </button>
                @for (g of d.aprobar.por_departamento; track g.clave) {
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
                <article class="ap-item" [class.cerrado]="p.etapa === 'cerrado'">
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
                    <span class="ap-chip" [class.ok]="p.etapa === 'cerrado' && p.status === 'validada'"
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
                    @if (p.etapa === 'ejercer' && p.requiere_evidencia && !p.tiene_evidencia) {
                      <span class="ap-chip warn">falta la evidencia</span>
                    }
                  </div>

                  @if (p.comentarios) { <div class="ap-it-nota">“{{ p.comentarios }}”</div> }
                  @if (p.revision_nota) { <div class="ap-it-nota warn">{{ p.revision_nota }}</div> }
                  @if (p.motivo_rechazo) { <div class="ap-it-nota bad">Rechazado: {{ p.motivo_rechazo }}</div> }
                  @if (p.validated_by) { <div class="ap-it-nota faint">Cerrado por {{ p.validated_by }}</div> }

                  <div class="ap-it-act">
                    @if (p.files.length) {
                      <a class="ap-ver" [href]="p.files[0].url" target="_blank" rel="noopener">Ver comprobante</a>
                    } @else {
                      <span class="ap-chip bad">sin archivos</span>
                    }
                    <span class="ap-grow"></span>

                    @switch (p.etapa) {
                      @case ('aprobar') {
                        <button pButton type="button" class="p-button-text p-button-sm" [disabled]="actuando() === p.id"
                                (click)="rechazar(p)">Rechazar</button>
                        <button pButton type="button" class="p-button-sm" [loading]="actuando() === p.id"
                                (click)="aprobar(p)">Aprobar</button>
                      }
                      @case ('ejercer') {
                        @if (p.requiere_evidencia && !p.tiene_evidencia) {
                          <!-- La evidencia la sube quien capturó, no quien firma. Decirlo evita
                               que el aprobador busque un botón que no le toca. -->
                          <span class="ap-faint">la evidencia la sube quien lo levantó</span>
                        }
                        <button pButton type="button" class="p-button-text p-button-sm" [disabled]="actuando() === p.id"
                                (click)="rechazar(p)">Rechazar</button>
                        <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="actuando() === p.id"
                                (click)="darPorComprobado(p)">Dar por comprobado</button>
                      }
                      @default { <span class="ap-faint">sin acciones pendientes</span> }
                    }
                  </div>
                </article>
              }
              @if (!visibles().length) { <div class="ap-muted">{{ vacioDe(pestana()) }}</div> }
            </section>
          </div>
        }
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .ap { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ap-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .ap-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-grow { flex-grow: 1; }
    .ap-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .ap-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }
    .ap-link { border: 0; background: transparent; padding: 0; font: inherit; font-size: var(--fs-xs);
      color: var(--action); cursor: pointer; text-decoration: underline; }

    .ap-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ap-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    .ap-aviso { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm);
      color: var(--fg-2); background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .ap-aviso.warn { color: var(--warn-fg); border-color: var(--warn-border); }

    /* ── El día ─────────────────────────────────────────────────────────────── */
    .ap-dia { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .ap-dia-hoy { display: flex; align-items: center; gap: var(--sp-2); min-width: 15rem;
      font-size: var(--fs-sm); }
    /* Solo la PRIMERA letra: "capitalize" a secas da «Viernes 25 De Septiembre», con el
       "De" en mayuscula, que no es como se escribe una fecha en castellano. */
    .ap-dia-hoy strong::first-letter { text-transform: uppercase; }
    .ap-fecha-in input { height: 28px; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      background: var(--layout-bg); color: var(--fg-1); font: inherit; font-size: var(--fs-xs); padding: 0 6px; }
    .ap-rail { display: flex; gap: 2px; flex-wrap: wrap; }
    .ap-rail-d { position: relative; width: 30px; height: 30px; border: 1px solid transparent;
      border-radius: var(--r-sm); background: var(--layout-bg); color: var(--fg-2);
      font: inherit; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; cursor: pointer; }
    .ap-rail-d:hover { border-color: var(--border-color); }
    .ap-rail-d.on { background: var(--fg-1); color: var(--card-bg); font-weight: var(--fw-bold); }
    .ap-rail-p { position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px;
      border-radius: 7px; background: var(--action); color: #fff;
      font-size: var(--fs-nano); line-height: 14px; padding: 0 3px; }

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
    .ap-it-act { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2);
      padding-top: var(--sp-2); border-top: 1px solid var(--c-divider); }
    .ap-ver { font-size: var(--fs-xs); }

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
  readonly pestana = signal<PestanaGasto>('aprobar');
  readonly grupo = signal<string | null>(null);
  readonly actuando = signal<string | null>(null);
  /** El día pedido. Vacío = «hoy», y quien decide cuál es hoy es el servidor. */
  private readonly fecha = signal<string>('');

  readonly tabs: { id: PestanaGasto; label: string }[] = [
    { id: 'aprobar', label: 'Aprobar' },
    { id: 'ejercer', label: 'Ejercer' },
    { id: 'todos', label: 'Todos' },
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

  irADia(iso: string): void {
    if (!iso || iso === this.fechaActiva()) return;
    this.fecha.set(iso);
    this.cargar();
  }

  irAHoy(): void {
    this.fecha.set('');
    this.cargar();
  }

  mover(delta: number): void {
    const base = this.fechaActiva();
    if (!base) return;
    const destino = sumarDias(base, delta);
    // No se navega al futuro: no hay levantamientos de mañana, y una pantalla vacía sin
    // explicación se lee como «no hay nada», que es otra cosa.
    if (this.datos()?.hoy && destino > this.datos()!.hoy) return;
    this.irADia(destino);
  }

  verPestana(p: PestanaGasto): void {
    this.pestana.set(p);
    // El filtro por departamento es de la pestaña que firma: arrastrarlo a otra dejaría la
    // lista recortada sin que se vea por qué.
    if (p !== 'aprobar') this.grupo.set(null);
  }

  /** Los días del rail, más nuevo primero y acotados a dos semanas para que entren. */
  readonly railVisible = computed(() => (this.datos()?.dias_recientes ?? []).slice(0, 14).reverse());

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
    const filas = p === 'todos' ? d.filas : d.filas.filter((f) => f.etapa === p);
    const g = this.grupo();
    if (p !== 'aprobar' || !g) return filas;
    const sel = d.aprobar.por_departamento.find((x) => x.clave === g);
    if (!sel) return filas;
    const ids = new Set(sel.ids);
    return filas.filter((f) => ids.has(f.id));
  });

  /** El contador de cada pestaña. `Todos` es el día entero, incluido lo que no se reconoce. */
  conteo(p: PestanaGasto): { n: number; monto: number } {
    const d = this.datos();
    if (!d) return { n: 0, monto: 0 };
    if (p === 'todos') return { n: d.total, monto: d.monto_total };
    return d.etapas[p] ?? { n: 0, monto: 0 };
  }

  vacioDe(p: PestanaGasto): string {
    if (p === 'aprobar') return this.grupo() ? 'Ese departamento ya no tiene nada esperando firma.' : 'Nada de este día espera tu visto bueno.';
    if (p === 'ejercer') return 'Nada de este día quedó a medio camino.';
    return 'Ese día no se levantó ningún gasto.';
  }

  diaLocal(iso: string | null | undefined): Date | null { return isoADiaLocal(String(iso ?? '')); }

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
