import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { MessageService } from 'primeng/api';
import {
  pagableConBilletesCaos, warehouseName,
  type ReposicionDoc, type ReposicionGrupo, type ReposicionRetiro, type ReposicionSucursales, type ReposicionVinculo,
  type AprobacionPago,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { CashLedgerService } from '../../cash-ledger.service';
import { CaosService } from '../../caos.service';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';

interface OpcionOrigen { label: string; value: string }

/**
 * ⭐ `[CGA-A.61]` **Reposición de sucursales**, dentro de Captura y arriba de la cola.
 *
 * Edgar, 2026-10-28: *«hagámoslo, pero desde una sola interfaz para tener más practicidad»*. La
 * maqueta ponía la reposición en una pestaña aparte y las correcciones vivían en Caja Fuerte: para
 * pasar CG-2026-00512 de un retiro a otro había que quitarlo en un movimiento de CAOS, ir al otro y
 * teclear folio y monto. Aquí está todo junto: qué documentos de Kepler tiene cada sucursal por día
 * de pago, de qué retiro salió cada peso, y las tres acciones —reponer lo que sigue en la cola,
 * confirmar la propuesta de vínculos, cambiar un vínculo de retiro— en la misma fila.
 *
 * Jerarquía (Q.5): primario = lo que falta por resolver (la cifra y el estado de cada fila);
 * secundario = total, CAOS y cajón; terciario = el detalle de documentos, plegado por fila.
 *
 * ⭐ `[CGA-A.63]` **No pinta nada en la página.** Edgar, 2026-10-29: *«tiene que ser un módulo muy
 * pequeño. el 95% de la interfaz si no es el 100% tiene que ser el arqueo y los movimientos»*. La
 * tabla abre en una ventana (`app-side-peek` modo `window`: diez columnas no caben en un cajón) y
 * el botón que la abre lo pone la barra de Captura, con la misma pieza que «Tu jornada»; de aquí
 * sólo lee `resumen()` y llama `abrirVentana()`.
 *
 * ⚠️ Quién hace qué lo vuelve a exigir el servidor: «Reponer» es el lote de siempre (gestionar la
 * caja); vincular y cambiar de retiro son sólo de superadmin (`[CGA-A.58]`, por rol fresco).
 */
@Component({
  selector: 'app-caja-reposicion',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, SelectModule, InputTextModule, DialogModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- [CGA-A.63] Ventana y no cajón: con diez columnas el cajón de 520px parte cada fila en tres
         renglones, y mientras se repone la cola pasa a segundo plano (la razón del modo window).
         Sin aboveModals: adentro hay p-select y se abre el p-dialog de cambiar de retiro. -->
    <app-side-peek mode="window" [width]="1280" [open]="abierta()" (openChange)="$event ? null : cerrarVentana()"
                   title="Reposición" [subtitle]="subtitulo()">
    <div class="rp">
      <header class="rp-head">
        @if (datos(); as d) {
          <span class="rp-lead" aria-live="polite" aria-atomic="true">
            @if (accionables().length) {
              {{ accionables().length }} <span class="rp-lead-sub">{{ accionables().length === 1 ? 'se resuelve de un clic' : 'se resuelven de un clic' }}</span>
            } @else {
              <span class="rp-lead-sub">Nada que resolver de un clic</span>
            }
          </span>
          @if (d.datos_al) {
            <app-freshness-pill measures="data" [since]="d.datos_al" label="Kepler" />
          } @else {
            <span class="rp-warn">Kepler sin medir</span>
          }
          @if (d.caos_al) {
            <app-freshness-pill measures="data" [since]="d.caos_al" label="CAOS" />
          } @else {
            <span class="rp-warn">CAOS sin medir</span>
          }
        }
        <span class="rp-sp"></span>
        @if (datos()) {
          <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="vista.set($any($event))"
                         ariaLabel="Qué sucursales ver" />
        }
        <p-button icon="pi pi-refresh" size="small" severity="secondary" [text]="true" [loading]="cargando()"
                  ariaLabel="Volver a leer la reposición" (onClick)="cargar()"></p-button>
      </header>

      @if (datos()) {
        <app-metric-strip class="rp-kpis" [items]="kpis()"></app-metric-strip>
      }

      <app-load-state class="dt-scope" [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!visibles().length" [skeletonRows]="3"
                      errorTitle="No se pudo leer la reposición" emptyIcon="pi-check-circle"
                      [emptyTitle]="textoVacio()"
                      [emptyHint]="pistaVacio()"
                      (retry)="cargar()">
        <p-table [value]="visibles()" size="small" dataKey="clave" [expandedRowKeys]="abiertas()" class="rp-tbl dt-stack"
                 selectionMode="single" [metaKeySelection]="false" [selection]="filaActiva()"
                 (selectionChange)="filaActiva.set($any($event))">
          <ng-template #header>
            <tr>
              <th class="rp-col-tog"><span class="sr-only">Detalle</span></th>
              <th>Sucursal</th>
              <th>Día de pago</th>
              <th class="rp-col-sec">Documentos</th>
              <th class="rp-num">Total Kepler</th>
              <th class="rp-num rp-col-sec">De CAOS</th>
              <th class="rp-num rp-col-sec">Del cajón</th>
              <th class="rp-num">Por resolver</th>
              <th>Estado</th>
              <th>Qué sigue</th>
            </tr>
          </ng-template>
          <ng-template #body let-g let-expanded="expanded">
            <tr [pSelectableRow]="g" (keydown.enter)="enterEnFila($event, g.clave)">
              <td class="rp-col-tog dt-actions" data-label="Documentos" role="cell">
                <p-button type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" [text]="true" size="small"
                          severity="secondary" [ariaLabel]="(expanded ? 'Ocultar' : 'Ver') + ' los documentos de ' + nombre(g.sucursal)"
                          (onClick)="alternar(g.clave)"></p-button>
              </td>
              <td class="rp-strong dt-id" data-label="Sucursal" role="cell">{{ nombre(g.sucursal) }}</td>
              <td class="rp-mono" data-label="Día de pago" role="cell">{{ dmy(g.fecha) }}</td>
              <td class="rp-col-sec" data-label="Documentos" role="cell">{{ textoDocs(g) }}</td>
              <td class="rp-num dt-num" data-label="Total Kepler" role="cell">{{ money(g.total) }}</td>
              <td class="rp-num rp-dim rp-col-sec dt-num" data-label="De CAOS" role="cell">{{ money(g.caos) }}</td>
              <td class="rp-num rp-dim rp-col-sec dt-num" data-label="Del cajón" role="cell">{{ money(g.cajon) }}</td>
              <td class="rp-num dt-num" data-label="Por resolver" role="cell" [class.rp-falta]="porResolverDe(g) > 0">{{ porResolverDe(g) > 0 ? money(porResolverDe(g)) : '—' }}</td>
              <td class="rp-tags rp-apila" data-label="Estado" role="cell">
                <p-tag [severity]="g.estado === 'explicada' ? 'success' : 'warn'" [value]="textoEstado(g)"></p-tag>
                @if (g.n_sin_aprobar) {
                  <p-tag severity="danger" [value]="g.n_sin_aprobar + ' sin aprobar'"></p-tag>
                }
                @if (g.n_pagado_antes_de_aprobar) {
                  <p-tag severity="warn" [value]="g.n_pagado_antes_de_aprobar + ' pagado antes de aprobar'"></p-tag>
                }
              </td>
              <td class="rp-que rp-apila dt-actions" data-label="Qué sigue" role="cell">
                @switch (g.estado) {
                  @case ('por_capturar') {
                    @if (puedeGestionar() && reponibles(g).length) {
                      <div class="rp-accion">
                        <p-select [options]="opcionesOrigen()" [ngModel]="eleccion(g)" (ngModelChange)="elegir(g, $event)"
                                  optionLabel="label" optionValue="value" placeholder="¿De dónde sale?" size="small"
                                  appendTo="body" class="rp-sel" [ariaLabel]="'De dónde sale el dinero de ' + nombre(g.sucursal)"></p-select>
                        <p-button [label]="'Reponer ' + reponibles(g).length" icon="pi pi-check" size="small"
                                  [disabled]="!eleccion(g) || !!ocupado()" [loading]="ocupado() === g.clave"
                                  (onClick)="reponer(g)"></p-button>
                      </div>
                    }
                    @if (reponibles(g).length) {
                      <small class="fin-dim">{{ g.retiro_sugerido ? g.retiro_sugerido.razon : 'Saca ' + money(pagable(montoReponible(g))) + ' de CAOS; el retiro aparece aquí cuando se sincroniza.' }}</small>
                    }
                  }
                  @case ('sin_vincular') {
                    @if (g.propuesta) {
                      <p-button [label]="esSuperadmin() ? 'Revisar y vincular' : 'Ver la propuesta'" icon="pi pi-link" size="small"
                                [severity]="esSuperadmin() ? undefined : 'secondary'" [outlined]="!expanded"
                                (onClick)="abrir(g.clave)"></p-button>
                    } @else {
                      <small class="fin-dim">Sin retiro claro de esta sucursal y de estos días.</small>
                    }
                  }
                  @default {
                    <small class="fin-dim">Nada pendiente.</small>
                  }
                }
                @if (g.n_sin_aprobar) {
                  <!-- [CGA-A.62] Sin aprobación no se repone: se firma en su pantalla y vuelve solo. -->
                  <a class="rp-link" routerLink="/finanzas/aprobacion-gastos">
                    <i class="pi pi-arrow-right" aria-hidden="true"></i>
                    {{ g.n_sin_aprobar === 1 ? '1 gasto espera' : g.n_sin_aprobar + ' gastos esperan' }} firma o se rechazó: no se repone. Ir a Aprobación de gastos
                  </a>
                }
              </td>
            </tr>
          </ng-template>
          <ng-template #expandedrow let-g>
            <tr>
              <td colspan="10" class="rp-det" role="cell">
                @if (g.propuesta; as p) {
                  <div class="rp-prop" role="group" [attr.aria-label]="'Propuesta de vínculos para ' + nombre(g.sucursal)">
                    <p class="rp-prop-t"><i class="pi pi-bolt" aria-hidden="true"></i> <strong>Propuesta del sistema</strong> <span class="fin-dim">— la confirma una persona</span></p>
                    <p class="rp-razon">{{ p.razon }}.</p>
                    <p-table [value]="p.asignaciones" size="small" class="rp-mini">
                      <ng-template #header>
                        <tr><th>Egreso</th><th>Documento</th><th>Retiro de CAOS</th><th class="rp-num">Monto</th></tr>
                      </ng-template>
                      <ng-template #body let-a>
                        <tr>
                          <td class="rp-mono dt-id" data-label="Egreso" role="cell">{{ a.cg_folio }}</td>
                          <td class="rp-mono rp-dim" data-label="Documento" role="cell">{{ folioDoc(a.origen_ref) }}</td>
                          <td data-label="Retiro de CAOS" role="cell"><span>«{{ a.ref ?? ('retiro ' + a.external_id) }}» <span class="rp-dim">· {{ a.external_id }}</span></span></td>
                          <td class="rp-num dt-num" data-label="Monto" role="cell">{{ money(a.monto) }}</td>
                        </tr>
                      </ng-template>
                    </p-table>
                    <div class="rp-prop-pie">
                      @if (esSuperadmin()) {
                        <p-button [label]="'Confirmar ' + p.asignaciones.length + (p.asignaciones.length === 1 ? ' vínculo por ' : ' vínculos por ') + money(p.monto)"
                                  icon="pi pi-check" size="small" [disabled]="!!ocupado()" [loading]="ocupado() === g.clave"
                                  (onClick)="vincular(g)"></p-button>
                        <small class="fin-dim">Se guardan todos o ninguno.@if (p.queda > 0) { Quedan {{ money(p.queda) }} sin retiro. }</small>
                      } @else {
                        <small class="fin-dim">Vincular es de superadmin: pídeselo a supervisión.</small>
                      }
                    </div>
                  </div>
                }
                <p-table [value]="g.docs" size="small" class="rp-mini">
                  <ng-template #header>
                    <tr>
                      <th>Documento de Kepler</th><th>Beneficiario</th><th>Clase</th><th>Aprobación</th><th>Egreso</th>
                      <th>De dónde salió</th><th class="rp-num">Falta</th><th class="rp-num">Monto</th>
                    </tr>
                  </ng-template>
                  <ng-template #body let-d>
                    <tr>
                      <td class="rp-mono dt-id" data-label="Documento de Kepler" role="cell">{{ d.doc_tipo }} {{ d.folio }}
                        @if (!d.en_kepler) { <p-tag severity="warn" value="ya no está en Kepler"></p-tag> }
                      </td>
                      <td data-label="Beneficiario" role="cell">{{ d.beneficiario ?? '—' }}</td>
                      <td data-label="Clase" role="cell">{{ d.clase === 'nomina' ? 'Nómina' : 'Gasto' }}</td>
                      <td class="rp-aprob rp-apila" data-label="Aprobación" role="cell">
                        @if (d.aprobacion; as a) {
                          <p-tag [severity]="severidadAprobacion(a)" [value]="etiquetaAprobacion(a)"></p-tag>
                          @if (a.estado !== 'aprobado_antes') { <small class="rp-dim">{{ a.texto }}</small> }
                        } @else {
                          <span class="rp-dim">sin medir</span>
                        }
                      </td>
                      <td class="rp-mono" data-label="Egreso" role="cell">{{ d.cg_folio ?? 'por capturar' }}</td>
                      <td class="rp-apila" data-label="De dónde salió" role="cell">
                        @for (v of d.vinculos; track v.link_id) {
                          <div class="rp-vinc">
                            <span>«{{ v.ref ?? ('retiro ' + v.external_id) }}» <span class="rp-mono">{{ money(v.monto) }}</span></span>
                            @if (esSuperadmin()) {
                              <p-button label="Cambiar retiro" icon="pi pi-arrow-right-arrow-left" size="small" severity="secondary"
                                        [text]="true" [disabled]="!!ocupado()" (onClick)="abrirMover(v, d)"></p-button>
                            }
                          </div>
                        } @empty {
                          <span class="rp-dim">{{ textoOrigen(d) }}</span>
                        }
                      </td>
                      <td class="rp-num dt-num" data-label="Falta" role="cell" [class.rp-falta]="d.estado === 'sin_vincular'">{{ d.falta > 0 ? money(d.falta) : '—' }}</td>
                      <td class="rp-num dt-num" data-label="Monto" role="cell">{{ money(d.monto) }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      @if (datos(); as d) {
        <p class="rp-universo fin-dim">
          @if (d.universo.sin_documentos.length) {
            Sin documentos de caja en estos días: {{ nombres(d.universo.sin_documentos) }}.
          }
          Oficinas no se repone: Caja General paga directo lo suyo.
        </p>
      }
    </div>
    </app-side-peek>

    <!-- appendTo body: se abre DESDE la ventana y tiene que quedar encima de ella, no adentro. -->
    <p-dialog [visible]="mover() !== null" (visibleChange)="$event ? null : cerrarMover()" [modal]="true" appendTo="body"
              header="Cambiar de retiro" [style]="{ width: '34rem' }" [draggable]="false">
      @if (mover(); as m) {
        <div class="rp-mover">
          <p>{{ m.folio }} toma hoy <strong class="rp-mono">{{ money(m.vinculo.monto) }}</strong> de «{{ m.vinculo.ref ?? ('retiro ' + m.vinculo.external_id) }}». Pásalo a:</p>
          <p-select [options]="opcionesDestino()" [(ngModel)]="destinoMover" optionLabel="label" optionValue="value"
                    placeholder="Elige el retiro" appendTo="body" class="rp-sel-ancho" ariaLabel="Retiro destino"></p-select>
          <label class="rp-lbl" for="rp-motivo">Por qué (mínimo 10 letras)</label>
          <input pInputText id="rp-motivo" [(ngModel)]="motivoMover" class="rp-sel-ancho"
                 placeholder="Ej. la nómina de Canindo salió de «nom canindo»" />
          <small class="fin-dim">La baja queda con tu nombre y el motivo; si el destino tiene menos libre, toma lo que alcance y el resto se dice.</small>
        </div>
      }
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cerrarMover()"></p-button>
        <p-button label="Cambiar de retiro" icon="pi pi-check" [disabled]="!destinoMover || motivoMover.trim().length < 10 || !!ocupado()"
                  [loading]="ocupado() === 'mover'" (onClick)="confirmarMover()"></p-button>
      </ng-template>
    </p-dialog>
  `,
  styles: [
    FINANZAS_SHARED_STYLES,
    `
    /* [CGA-A.63] Sin container-type: lo único que pinta es la ventana, y las consultas de la tabla
       ya miden su propia caja (el dt-scope de app-load-state). */
    :host { display:block; }
    /* #9: en angosto se van las tres columnas secundarias (Q.5); el detalle plegado las repite
       documento por documento, así que nada queda inalcanzable. */
    @container (max-width: 56rem) {
      .rp-col-sec { display:none; }
    }
    /* En teléfono la tabla se apila (dt-stack) y el apilado ALCANZA a las dos tablas del detalle:
       viven adentro, así que también pierden su encabezado; por eso todas sus celdas llevan
       data-label. Las celdas con varias piezas (estado, qué sigue, aprobación, de dónde salió) van
       en columna: en renglón se aprietan y lo que no cabe se corta, porque el apilado no desplaza. */
    @container densetable (max-width: 34rem) {
      .rp-apila { flex-direction:column; align-items:flex-start; }
      .rp-col-tog { width:auto; }
    }
    .rp-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:var(--sp-2); margin-bottom:var(--sp-2); }
    .rp-sp { flex:1 1 auto; }
    .rp-lead { font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-sm); font-weight:700; color:var(--fg-1); }
    .rp-lead-sub { font-family:var(--font-body); font-weight:400; color:var(--text-muted); }
    .rp-warn { color:var(--warn-soft-fg); font-size:var(--fs-xs); }
    .rp-kpis { display:block; margin-bottom:var(--sp-2); }
    .rp-num { text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .rp-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
    .rp-strong { font-weight:600; color:var(--fg-1); }
    .rp-dim { color:var(--text-muted); }
    .rp-falta { color:var(--warn-soft-fg); font-weight:600; }
    .rp-col-tog { width:2.5rem; }
    .rp-que { min-width:16rem; }
    .rp-que small { display:block; margin-top:var(--sp-1); max-width:28rem; }
    .rp-accion { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); }
    .rp-sel { min-width:14rem; }
    .rp-det { background:var(--surface-2); padding:var(--sp-3); }
    .rp-prop { border:1px solid var(--border-color); border-radius:var(--r-md, 8px); padding:var(--sp-3); margin-bottom:var(--sp-3);
               display:flex; flex-direction:column; gap:var(--sp-2); }
    .rp-prop-t { margin:0; }
    .rp-razon { margin:0; color:var(--fg-2); max-width:70rem; }
    .rp-prop-pie { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); }
    .rp-vinc { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-1); }
    .rp-universo { margin:var(--sp-2) 0 0; }
    .rp-tags { display:flex; flex-wrap:wrap; gap:var(--sp-1); }
    .rp-aprob { min-width:10rem; }
    .rp-aprob small { display:block; margin-top:var(--sp-1); max-width:22rem; }
    .rp-link { display:block; margin-top:var(--sp-1); font-size:var(--fs-xs); color:var(--bad-fg, var(--warn-soft-fg)); }
    .rp-link:focus-visible { outline:2px solid var(--action); outline-offset:2px; }
    .rp-mover { display:flex; flex-direction:column; gap:var(--sp-2); }
    .rp-mover p { margin:0; }
    .rp-lbl { font-size:var(--fs-xs); color:var(--text-muted); }
    .rp-sel-ancho { width:100%; }
    `,
  ],
})
export class CajaReposicionComponent implements OnInit {
  private readonly api = inject(CashLedgerService);
  private readonly caos = inject(CaosService);
  private readonly perms = inject(PermissionsService);
  // El p-toast lo pone Captura (providers: [MessageService]): este componente vive adentro.
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Reponer es el lote de la cola: lo puede quien gestiona la caja. */
  readonly puedeGestionar = input(false);
  /** El libro y la cola cambiaron: Captura los vuelve a leer. */
  readonly cambio = output<void>();

  readonly money = money;
  readonly dmy = dmy;
  readonly pagable = pagableConBilletesCaos;

  readonly datos = signal<ReposicionSucursales | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** `[CGA-A.63]` La ventana de la reposición; la abre el botón de la barra de Captura. */
  readonly abierta = signal(false);
  /** El botón que la abrió: al cerrar, el foco vuelve ahí y no al `<body>`. */
  private origen: HTMLElement | null = null;
  /**
   * Qué grupos se ven. ⭐ Medido en prod el 2026-10-28 (ventana 22–28/10): de 28 sucursal-día, 20
   * tenían egresos sin vincular y NINGÚN retiro de su sucursal — son de antes del proceso nuevo, o
   * se pagaron por otro lado. Mezclados con los de un clic, la lista de «pendientes» era casi toda
   * filas sin acción posible. Van aparte: son la señal de descuadre, no trabajo de un clic.
   */
  readonly vista = signal<'resolver' | 'sin_retiro' | 'explicadas'>('resolver');
  readonly abiertas = signal<Record<string, boolean>>({});
  /** D.7: la fila con el foco de teclado (flechas por `pSelectableRow`; Enter abre su detalle). */
  readonly filaActiva = signal<ReposicionGrupo | null>(null);
  /** Lo que está escribiendo (idempotencia visual): la clave del grupo, o `'mover'`. */
  readonly ocupado = signal<string | null>(null);
  private readonly elegidos = signal<Record<string, string>>({});
  readonly mover = signal<{ vinculo: ReposicionVinculo; folio: string } | null>(null);
  destinoMover: string | null = null;
  motivoMover = '';

  readonly esSuperadmin = computed(() => this.perms.isSuperadmin());
  readonly grupos = computed(() => this.datos()?.grupos ?? []);
  /** Se resuelven de un clic: lo que sigue en la cola, o egresos con propuesta de retiro. */
  readonly accionables = computed(() => this.grupos().filter((g) => g.estado === 'por_capturar' || g.n_sin_aprobar > 0
    || (g.estado === 'sin_vincular' && !!g.propuesta)));
  /** Egresos que ningún retiro de su sucursal y de esos días explica. */
  readonly sinRetiro = computed(() => this.grupos().filter((g) => g.estado === 'sin_vincular' && !g.propuesta));
  readonly explicadas = computed(() => this.grupos().filter((g) => g.estado === 'explicada'));
  readonly visibles = computed(() => {
    const v = this.vista();
    return v === 'sin_retiro' ? this.sinRetiro() : v === 'explicadas' ? this.explicadas() : this.accionables();
  });
  readonly opcionesVista = computed<SegOption[]>(() => [
    { label: 'Por resolver', value: 'resolver', count: this.accionables().length },
    { label: 'Sin retiro', value: 'sin_retiro', count: this.sinRetiro().length },
    { label: 'Explicadas', value: 'explicadas', count: this.explicadas().length },
  ]);

  /**
   * `[CGA-A.63]` Lo que dice el botón de la barra sin abrir nada: las mismas cuentas que los
   * filtros de la ventana, para que lo de afuera y lo de adentro digan lo mismo. Sin importes: el
   * botón es la puerta, la cifra está adentro con su desglose. Lo que no se midió se dice; un
   * Kepler sin medir no es «nada pendiente».
   */
  readonly resumen = computed(() => {
    const d = this.datos();
    if (!d) return this.error() ? 'no se pudo leer' : 'leyendo…';
    if (!d.datos_al) return 'Kepler sin medir';
    const partes: string[] = [];
    if (this.accionables().length) partes.push(`${this.accionables().length} por resolver`);
    if (this.sinRetiro().length) partes.push(`${this.sinRetiro().length} sin retiro`);
    if (!d.caos_al) partes.push('CAOS sin medir');
    return partes.length ? partes.join(' · ') : 'nada pendiente';
  });
  /** El título repite el rótulo del botón —como «Tu jornada»—; el resto va aquí. */
  readonly subtitulo = computed(() => {
    const d = this.datos();
    return d ? `de sucursales · pago del ${dmy(d.desde)} al ${dmy(d.hasta)}` : 'de sucursales';
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const acc = this.accionables();
    const conPropuesta = acc.reduce((a, g) => a + (g.propuesta ? g.sin_vincular : 0), 0);
    const porCapturar = acc.reduce((a, g) => a + g.por_capturar, 0);
    const nCapturar = acc.reduce((a, g) => a + g.n_por_capturar, 0);
    const sinRetiro = this.sinRetiro().reduce((a, g) => a + g.sin_vincular, 0);
    const cajon = this.grupos().reduce((a, g) => a + g.cajon, 0);
    const sinAprobar = this.grupos().reduce((a, g) => a + g.n_sin_aprobar, 0);
    const pagadoAntes = this.grupos().reduce((a, g) => a + g.n_pagado_antes_de_aprobar, 0);
    return [
      { label: 'Vincular con propuesta', value: conPropuesta, format: 'currency2', tone: conPropuesta > 0 ? 'warn' : 'ok',
        sub: 'egresos con su retiro ya identificado' },
      { label: 'Por capturar', value: porCapturar, format: 'currency2', tone: porCapturar > 0 ? 'warn' : undefined,
        sub: `${nCapturar} ${nCapturar === 1 ? 'documento sigue' : 'documentos siguen'} en la cola` },
      { label: 'Sin retiro que lo explique', value: sinRetiro, format: 'currency2', tone: sinRetiro > 0 ? 'bad' : 'ok',
        sub: 'de dónde salió ese dinero no lo dice CAOS' },
      // `[CGA-A.62]` La aprobación: lo que no se repone y lo que se pagó antes de firmarse.
      { label: 'Sin aprobar', value: sinAprobar, format: 'number', tone: sinAprobar > 0 ? 'bad' : 'ok',
        sub: `${pagadoAntes} ${pagadoAntes === 1 ? 'pagado' : 'pagados'} antes de aprobarse` },
      { label: 'Del cajón', value: cajon, format: 'currency2', sub: 'lo que CAOS no dio, en la ventana' },
    ];
  });

  readonly textoVacio = computed(() => {
    const v = this.vista();
    if (v === 'sin_retiro') return 'Todos los egresos de sucursal tienen su retiro';
    if (v === 'explicadas') return 'Ninguna sucursal está explicada todavía en estos días';
    return 'Nada que resolver de un clic';
  });
  readonly pistaVacio = computed(() => {
    if (this.vista() !== 'resolver') return 'Cambia de filtro arriba para ver las demás.';
    const n = this.sinRetiro().length;
    return n ? `Hay ${n} ${n === 1 ? 'sucursal-día' : 'sucursales-día'} con egresos que ningún retiro explica: filtro «Sin retiro».`
      : 'Sin documentos de caja de sucursal pendientes en estos días.';
  });

  /** Las opciones de «¿de dónde sale?»: los retiros con dinero libre y el cajón. */
  readonly opcionesOrigen = computed<OpcionOrigen[]>(() => [
    ...(this.datos()?.retiros ?? []).map((r) => ({ label: this.etiquetaRetiro(r), value: this.llave(r) })),
    { label: 'Del cajón (sin retiro)', value: 'cajon' },
  ]);

  /** Los retiros a los que se puede pasar el vínculo abierto: todos menos el suyo. */
  readonly opcionesDestino = computed<OpcionOrigen[]>(() => {
    const m = this.mover();
    return (this.datos()?.retiros ?? [])
      .filter((r) => !m || this.llave(r) !== `${m.vinculo.device}|${m.vinculo.external_id}`)
      .map((r) => ({ label: this.etiquetaRetiro(r), value: this.llave(r) }));
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.reposicion().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.cargando.set(false); },
      error: (e) => { this.error.set(this.textoError(e)); this.cargando.set(false); },
    });
  }

  /** Abre la ventana y RELEE: lo que la cola confirmó desde que se cargó ya no está por capturar. */
  abrirVentana(origen?: HTMLElement): void {
    this.origen = origen ?? null;
    this.abierta.set(true);
    this.cargar();
  }

  cerrarVentana(): void {
    this.abierta.set(false);
    // Después del cierre: el cajón todavía tiene el foco en este tick.
    queueMicrotask(() => this.origen?.focus());
  }

  nombre(sucursal: string): string { return warehouseName(sucursal); }
  nombres(sucursales: string[]): string { return sucursales.map((s) => warehouseName(s)).join(' · '); }
  folioDoc(origenRef: string): string { const [, tipo, folio] = origenRef.split('|'); return `${tipo} ${folio}`; }
  porResolverDe(g: ReposicionGrupo): number { return Math.round((g.sin_vincular + g.por_capturar) * 100) / 100; }

  /** `[CGA-A.62]` Lo que sigue en la cola y SÍ se puede reponer: lo que espera firma o se rechazó, no. */
  reponibles(g: ReposicionGrupo): ReposicionDoc[] {
    return g.docs.filter((d) => d.estado === 'por_capturar' && !d.aprobacion?.bloquea);
  }
  montoReponible(g: ReposicionGrupo): number { return this.reponibles(g).reduce((a, d) => a + d.monto, 0); }

  severidadAprobacion(a: AprobacionPago): 'success' | 'warn' | 'danger' | 'secondary' {
    if (a.bloquea) return 'danger';
    if (a.alerta) return 'warn';
    return a.estado === 'aprobado_antes' ? 'success' : 'secondary';
  }

  etiquetaAprobacion(a: AprobacionPago): string {
    const t: Record<AprobacionPago['estado'], string> = {
      aprobado_antes: 'Aprobado antes', aprobado_despues: 'Aprobado después', vale_despues: 'Vale después del pago',
      solicitud_despues: 'Solicitud después', aprobado_sin_hora: 'Aprobado (sin hora)', cerrado_por_kepler: 'Cerró Kepler',
      sin_firma: 'Espera firma', rechazado: 'Rechazado', sin_vale: 'Sin vale', sin_solicitud: 'Sin solicitud',
    };
    return t[a.estado];
  }

  textoDocs(g: ReposicionGrupo): string {
    const nom = g.docs.filter((d) => d.clase === 'nomina').length;
    const gas = g.docs.length - nom;
    return [gas ? `${gas} ${gas === 1 ? 'gasto' : 'gastos'}` : '', nom ? `${nom} ${nom === 1 ? 'nómina' : 'nóminas'}` : '']
      .filter(Boolean).join(' · ');
  }

  textoEstado(g: ReposicionGrupo): string {
    if (g.estado === 'por_capturar') return `${g.n_por_capturar} por capturar`;
    if (g.estado === 'sin_vincular') return `${g.n_sin_vincular} sin vincular`;
    return 'Explicada';
  }

  textoOrigen(d: ReposicionDoc): string {
    if (d.estado === 'por_capturar') return 'Sigue en la cola';
    if (d.estado === 'sin_vincular') return 'Ningún retiro';
    return d.origen_efectivo === 'cajon' ? 'Del cajón' : 'Cajón (menos de un billete)';
  }

  alternar(clave: string): void {
    this.abiertas.update((a) => { const n = { ...a }; if (n[clave]) delete n[clave]; else n[clave] = true; return n; });
  }

  /** Enter sobre la FILA abre su detalle; sobre un botón o un selector de adentro, no (ya hacen lo suyo). */
  enterEnFila(ev: Event, clave: string): void {
    if (ev.target === ev.currentTarget) this.alternar(clave);
  }

  abrir(clave: string): void {
    this.abiertas.update((a) => ({ ...a, [clave]: true }));
  }

  eleccion(g: ReposicionGrupo): string | null {
    const elegido = this.elegidos()[g.clave];
    if (elegido) return elegido;
    return g.retiro_sugerido ? `${g.retiro_sugerido.device}|${g.retiro_sugerido.external_id}` : null;
  }

  elegir(g: ReposicionGrupo, valor: string | null): void {
    this.elegidos.update((e) => ({ ...e, [g.clave]: valor ?? '' }));
  }

  /** Lo que sigue en la cola de este grupo, en un lote: el retiro elegido o el cajón. */
  reponer(g: ReposicionGrupo): void {
    const e = this.eleccion(g);
    if (!e || this.ocupado()) return;
    this.ocupado.set(g.clave);
    // `[CGA-A.62]` Sólo lo aprobado: lo que espera firma o se rechazó se queda en la cola.
    const items = this.reponibles(g).map((d) => ({ origen_ref: d.origen_ref }));
    if (!items.length) { this.ocupado.set(null); return; }
    const retiro = e === 'cajon' ? null : this.retiroDe(e);
    this.api.confirmarLote(items, retiro ? { device: retiro.device, external_id: retiro.external_id } : null, e === 'cajon' ? 'cajon' : null)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.ocupado.set(null);
          const fallaron = r.rechazados + r.no_confirmables;
          const sobre = r.retiro ? ` · CAOS ${money(r.retiro.tomado)}, cajón ${money(r.retiro.del_cajon)}` : '';
          this.toast.add({
            severity: fallaron ? 'warn' : 'success',
            summary: `${this.nombre(g.sucursal)} ${dmy(g.fecha)}`,
            detail: `${r.guardados} de ${items.length} egresos guardados por ${money(r.monto_guardado)}${sobre}`
              + (fallaron ? ` · ${fallaron} no se pudieron: siguen en la cola` : '') + '.',
            life: 8000,
          });
          this.cargar();
          this.cambio.emit();
        },
        error: (err) => {
          this.ocupado.set(null);
          this.toast.add({ severity: 'error', summary: 'No se repuso', detail: this.textoError(err), life: 10000 });
        },
      });
  }

  /** La propuesta del motor, confirmada por superadmin: todo o nada. */
  vincular(g: ReposicionGrupo): void {
    const p = g.propuesta;
    if (!p || this.ocupado()) return;
    this.ocupado.set(g.clave);
    this.caos.vincularLote({
      asignaciones: p.asignaciones.map((a) => ({ ledger_id: a.ledger_id, device: a.device, external_id: a.external_id, monto: a.monto })),
      motivo: `Reposición ${this.nombre(g.sucursal)} ${dmy(g.fecha)}`,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'success', summary: 'Vinculados',
          detail: `${r.vinculos} ${r.vinculos === 1 ? 'vínculo' : 'vínculos'} por ${money(r.monto)} · ${this.nombre(g.sucursal)} ${dmy(g.fecha)}.`, life: 8000 });
        this.cargar();
        this.cambio.emit();
      },
      error: (err) => {
        this.ocupado.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó ningún vínculo', detail: this.textoError(err), life: 12000 });
      },
    });
  }

  abrirMover(v: ReposicionVinculo, d: ReposicionDoc): void {
    this.destinoMover = null;
    this.motivoMover = '';
    this.mover.set({ vinculo: v, folio: d.cg_folio ?? d.folio });
  }

  cerrarMover(): void {
    if (this.ocupado() === 'mover') return;
    this.mover.set(null);
  }

  confirmarMover(): void {
    const m = this.mover();
    const destino = this.destinoMover ? this.retiroDe(this.destinoMover) : null;
    if (!m || !destino || this.motivoMover.trim().length < 10 || this.ocupado()) return;
    this.ocupado.set('mover');
    this.caos.moverVinculo(m.vinculo.link_id, { device: destino.device, external_id: destino.external_id, motivo: this.motivoMover.trim() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.ocupado.set(null);
          this.mover.set(null);
          this.toast.add({
            severity: r.queda > 0 ? 'warn' : 'success', summary: `${m.folio} cambió de retiro`,
            detail: `«${destino.ref ?? destino.external_id}» toma ${money(r.monto)}` + (r.queda > 0 ? `; ${money(r.queda)} quedan sin retiro.` : '.'),
            life: 8000,
          });
          this.cargar();
          this.cambio.emit();
        },
        error: (err) => {
          this.ocupado.set(null);
          this.toast.add({ severity: 'error', summary: 'No se cambió', detail: this.textoError(err), life: 10000 });
        },
      });
  }

  private llave(r: { device: string; external_id: number }): string { return `${r.device}|${r.external_id}`; }

  private retiroDe(llave: string): ReposicionRetiro | null {
    return (this.datos()?.retiros ?? []).find((r) => this.llave(r) === llave) ?? null;
  }

  private etiquetaRetiro(r: ReposicionRetiro): string {
    return `«${r.ref ?? 'retiro ' + r.external_id}» · ${dmy(r.dia)} · libre ${money(r.libre)}`;
  }

  private textoError(e: unknown): string {
    const err = e as { error?: { message?: string | string[] }; message?: string };
    const m = err?.error?.message ?? err?.message;
    return Array.isArray(m) ? m.join(' · ') : String(m ?? 'Error de red');
  }
}
