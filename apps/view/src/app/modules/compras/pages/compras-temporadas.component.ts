import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import {
  TEMPORADAS_LOTE_MAX, validarDecisionTemporada, validarFechasTemporada,
  type CandidatoTemporada, type CandidatosTemporada, type ConfirmarFechasTemporadaDto, type DecisionProductoTemporadaDto,
  type DecisionTemporada, type FechasTemporada, type MomentoTemporada, type RecurrenciaTemporada, type ReposicionTemporada,
  type TemporadaResumen, type TemporadasVista,
} from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { TemporadasService } from '../temporadas.service';
import { fechaRelevante, motivoTemporadas } from '../temporadas-reglas';

const MOMENTO: Record<MomentoTemporada, string> = { por_iniciar: 'Por iniciar', en_venta: 'En venta', terminada: 'Terminada' };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const PESOS = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

/** Una temporada del calendario con su temporada-año relevante (`fechaRelevante`). */
interface FilaCalendario {
  readonly t: TemporadaResumen;
  readonly f: FechasTemporada | null;
}

/**
 * `[PQ.94]` Compras › Temporadas (PQ.99, primera entrega). Plan: FASE_PQ §19.8–§19.11.
 *
 * Dos vistas de una sola pregunta cada una:
 *  · Calendario — ¿qué temporada está en venta o viene, y qué falta confirmar?
 *  · Productos de una temporada-año — ¿cuáles de los productos que propone la venta son de esta temporada?
 *
 * ⛔ Veracidad: lo PROPUESTO no frena nada (ADR-056) y hoy confirmar sólo REGISTRA la decisión: el sugerido
 * de Pedido todavía no la usa (PQ.45). La pantalla lo dice en las dos vistas.
 * ⛔ Una sola puerta de escritura: estos POST son el único lugar donde se escribe la temporada de un producto.
 * Lo que no existe todavía (preliminar, remate, informes con IA) no tiene pestaña.
 */
@Component({
  selector: 'app-compras-temporadas',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, TableModule, TagModule, DialogModule, DatePickerModule, InputNumberModule, InputTextModule,
    TextareaModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page tp-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          @if (fechaSel()) {
            <button type="button" class="tp-volver" (click)="volverAlCalendario()">
              <i class="pi pi-arrow-left" aria-hidden="true"></i> Calendario de temporadas
            </button>
            <h1>{{ temporadaAbierta()?.name ?? cands()?.temporada ?? 'Temporada' }} {{ cands()?.year ?? '' }}</h1>
          } @else {
            <h1>Temporadas</h1>
          }
          <p class="surf-page-sub">
            <span>Las ventanas son de <strong>venta del mayorista</strong>: van adelantadas a la fecha del consumidor. Lo propuesto no frena nada; hoy confirmar sólo registra la decisión, el sugerido de Pedido todavía no la usa.</span>
          </p>
        </div>
        <div class="tp-head-acc">
          @if (fechaSel()) {
            <app-freshness-pill measures="fetch" label="calculado" [since]="cands()?.calculado_at ?? null" />
          } @else {
            <app-freshness-pill measures="fetch" [since]="cargadoCalEn()" />
          }
        </div>
      </header>

      <!-- El error de una accion se ve aunque el dialogo ya se haya cerrado mientras guardaba. -->
      @if (errorAccion()) { <p class="tp-error tp-error-fuera" role="alert">{{ errorAccion() }}</p> }

      @if (!fechaSel()) {
        <!-- ===== Calendario ===== -->
        <!-- Respuesta y cifras SOLO con el calendario leido: cargando o con error no se dibuja un cero. -->
        @if (vista() && !errorCal()) {
          @if (respuestaCal()) { <p class="tp-respuesta" role="status">{{ respuestaCal() }}</p> }
          <app-metric-strip [items]="kpisCal()" density="compact" ariaLabel="Resumen del calendario de temporadas" />
        }

        <app-load-state class="dt-scope" [loading]="cargandoCal()" [error]="errorCal()" [isEmpty]="!filas().length" [skeletonRows]="7"
                        emptyIcon="pi-calendar" emptyTitle="Todavía no hay temporadas"
                        emptyHint="Las temporadas se cargan con la migración del calendario; si no aparece ninguna, la base no la tiene aplicada."
                        (retry)="cargarCalendario()">
          <p-table [value]="filas()" dataKey="t.id" class="tp-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                   [rowHover]="true" [tableStyle]="{ 'min-width': '60rem' }">
            <ng-template #header>
              <tr>
                <th>Temporada</th>
                <th>Venta del mayorista</th>
                <th>Hoy</th>
                <th>Fechas</th>
                <th class="comm-num">Productos confirmados</th>
                <th class="comm-num">Descartados</th>
                <th><span class="tp-sr">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-x>
              <tr>
                <td role="cell" data-label="Temporada">
                  <span class="tp-pri">{{ x.t.name }}</span>
                  @if (x.t.date_rule === 'movil') { <span class="tp-sub">fecha móvil</span> }
                </td>
                <td role="cell" data-label="Venta del mayorista">
                  @if (x.f) {
                    {{ dia(x.f.sale_from) }} al {{ dia(x.f.sale_to) }} <span class="tp-sub">{{ x.f.year }}</span>
                  } @else { <span class="tp-falta">sin fechas</span> }
                </td>
                <td role="cell" data-label="Hoy">
                  @if (x.f) { <p-tag [value]="momento(x.f.momento)" severity="secondary" /> } @else { — }
                </td>
                <td role="cell" data-label="Fechas">
                  @if (!x.f) {
                    <span class="tp-falta">sin definir</span>
                  } @else if (x.f.status === 'confirmada') {
                    <span class="tp-pri">Confirmadas</span>
                    <span class="tp-sub">{{ x.f.confirmed_by_name ?? 'sin nombre' }} · {{ momentoDe(x.f.confirmed_at) }}</span>
                  } @else {
                    <span class="tp-falta">Propuestas, sin confirmar</span>
                  }
                </td>
                <td role="cell" data-label="Productos confirmados" class="comm-num">{{ x.t.productos.confirmados }}</td>
                <td role="cell" data-label="Descartados" class="comm-num">{{ x.t.productos.descartados }}</td>
                <td role="cell" data-label="Acciones">
                  <div class="tp-acc">
                    @if (x.f) {
                      <!-- Neutros a proposito (T6): con 7 filas, el naranja en cada una no distinguia nada. -->
                      <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" (click)="abrirProductos(x.f.id)"
                              [attr.aria-label]="'Ver los productos de ' + x.t.name + ' ' + x.f.year">
                        <span class="p-button-label">Ver productos</span>
                      </button>
                      @if (puedeGestionar()) {
                        <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="abrirFechas(x.t, x.f)"
                                [attr.aria-label]="(x.f.status === 'propuesta' ? 'Confirmar' : 'Corregir') + ' las fechas de ' + x.t.name + ' ' + x.f.year">
                          <span class="p-button-label">{{ x.f.status === 'propuesta' ? 'Confirmar fechas' : 'Corregir fechas' }}</span>
                        </button>
                      }
                    }
                  </div>
                </td>
              </tr>
            </ng-template>
          </p-table>
          @if (fuentePropuesta(); as fuente) {
            <p class="tp-nota">De dónde salen las fechas propuestas: {{ fuente }}.</p>
          }
        </app-load-state>
      } @else {
        <!-- ===== Productos de una temporada-año ===== -->
        @if (anios().length > 1) {
          <app-segmented [options]="anios()" [value]="fechaSel() ?? ''" (valueChange)="cambiarAnio($event)" ariaLabel="Año de la temporada" />
        }

        @if (cands(); as c) {
          <p class="tp-nota">
            Venta del {{ dia(c.sale_from) }} al {{ dia(c.sale_to) }} de {{ c.year }}, medida con los meses de {{ mes(c.meses.desde) }} a {{ mes(c.meses.hasta) }}
            (un mes cuenta si la ventana cubre la mitad de sus días). Venta neta en pesos de Wincaja y Kepler.
            @if (c.fechas_status === 'propuesta') { Las fechas de esta temporada siguen propuestas. }
          </p>
          <!-- Advertencias de LECTURA (nivel secundario, no banner rojo): lo que el numero de abajo no puede decir solo. -->
          @if (!c.ventana_cerrada) {
            <p class="tp-advertencia">La ventana todavía no cierra: la propuesta puede cambiar y «cayó después» sale sin medir.</p>
          }
          @if (!c.base.completa) {
            <p class="tp-advertencia">El «% de su año» se calculó con {{ c.base.meses }} de 12 meses (antes de 2025 no hay historia): sale inflado, revísalo con más cuidado.</p>
          }
          <app-metric-strip [items]="kpisProd()" density="compact" ariaLabel="Productos que propone la venta para esta temporada" />
        }
        <!-- Fuera del estado de carga: si la propuesta sale vacia, el resultado del lote no se esconde. -->
        @if (aviso()) { <p class="tp-aviso" role="status">{{ aviso() }}</p> }

        <app-load-state class="dt-scope" [loading]="cargandoCand()" [error]="errorCand()" [isEmpty]="!!cands() && !cands()!.candidatos.length"
                        [skeletonRows]="8" emptyIcon="pi-search"
                        emptyTitle="La venta de esta ventana no propone productos"
                        emptyHint="Ningún producto juntó 60 % o más de su venta del año en esta ventana con $5,000 o más y con el nombre de la temporada o con caída después. Revisa otro año."
                        (retry)="cargarCandidatos()">
          <div class="tp-barra">
            <input pInputText type="search" class="tp-buscar" [value]="busqueda()" (input)="alBuscar($any($event.target).value)"
                   placeholder="Buscar por nombre o clave" aria-label="Buscar productos por nombre o clave" autocomplete="off" />
            @if (puedeGestionar()) {
              <span class="tp-sel" role="status">{{ seleccion().length }} seleccionados</span>
              <button pButton type="button" class="p-button-sm" [disabled]="!seleccion().length || ocupado()" (click)="abrirConfirmar()">
                <span class="p-button-label">Confirmar</span>
              </button>
              <span class="tp-esp"></span>
              <button pButton type="button" class="p-button-sm p-button-text tp-btn-bad" [disabled]="!seleccion().length || ocupado()" (click)="abrirDescartar()">
                <span class="p-button-label">Descartar</span>
              </button>
            }
          </div>

          <p-table [value]="candidatos()" dataKey="sku" class="tp-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                   [rowHover]="true" [tableStyle]="{ 'min-width': '56rem' }"
                   [selection]="seleccion()" (selectionChange)="seleccion.set($event)">
            <ng-template #header>
              <tr>
                @if (puedeGestionar()) { <th class="tp-chk"><p-table-header-checkbox ariaLabel="Seleccionar todos los que se ven" /></th> }
                <th>Producto</th>
                <th class="comm-num">Venta en la temporada</th>
                <th class="comm-num">% de su año</th>
                <th>Cayó después</th>
                <th>Nombre de la temporada</th>
                <th>Decisión</th>
              </tr>
            </ng-template>
            <ng-template #body let-c>
              <tr [class.tp-fallo]="!!fallidas()[c.sku]">
                @if (puedeGestionar()) {
                  <td class="tp-chk"><p-table-checkbox [value]="c" [ariaLabel]="'Seleccionar ' + c.nombre" /></td>
                }
                <td role="cell" data-label="Producto">
                  <span class="tp-pri">{{ c.nombre }}</span>
                  <span class="tp-sub">clave {{ c.sku }}</span>
                </td>
                <td role="cell" data-label="Venta en la temporada" class="comm-num">{{ pesos(c.venta_temporada) }}</td>
                <td role="cell" data-label="% de su año" class="comm-num">{{ pct(c.concentracion) }}</td>
                <td role="cell" data-label="Cayó después">
                  <span [class.tp-falta]="c.cayo_despues === null">{{ cayo(c.cayo_despues) }}</span>
                </td>
                <td role="cell" data-label="Nombre de la temporada">{{ c.por_nombre ? 'Sí' : 'No' }}</td>
                <td role="cell" data-label="Decisión">
                  @if (c.decision === 'confirmada') {
                    <p-tag value="Confirmado" severity="success" />
                  } @else if (c.decision === 'descartada') {
                    <p-tag value="Descartado" severity="secondary" />
                  } @else {
                    <span class="tp-pri">por decidir</span>
                  }
                  @if (fallidas()[c.sku]; as m) { <span class="tp-error">No se guardó: {{ m }}</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="puedeGestionar() ? 7 : 6" class="tp-nota">Ningún producto coincide con «{{ busqueda() }}».</td></tr>
            </ng-template>
          </p-table>
          <p class="tp-nota">
            «% de su año»: qué parte de la venta de 12 meses del producto cayó en esta ventana. «Cayó después»: si el mes siguiente vendió menos de la cuarta parte; «sin medir» si ese mes no ha cerrado.
          </p>
        </app-load-state>

        <!-- Fuera del estado de carga: con la propuesta vacia, lo ya decidido a mano se sigue viendo. -->
        @if (cands()?.fuera_de_propuesta?.length) {
            <section class="tp-fuera" aria-label="Decisiones fuera de la propuesta de este año">
              <h2>También decididos en esta temporada, fuera de la propuesta de este año</h2>
              <p-table [value]="$any(cands()!.fuera_de_propuesta)" dataKey="sku" class="tp-table dt-stack surf-table surf-table--plain" size="small">
                <ng-template #header>
                  <tr><th>Producto</th><th>Decisión</th><th>Cómo entró</th></tr>
                </ng-template>
                <ng-template #body let-d>
                  <tr>
                    <td role="cell" data-label="Producto"><span class="tp-pri">{{ d.nombre ?? 'sin nombre' }}</span><span class="tp-sub">clave {{ d.sku }}</span></td>
                    <td role="cell" data-label="Decisión">{{ d.decision === 'confirmada' ? 'Confirmado' : 'Descartado' }}</td>
                    <td role="cell" data-label="Cómo entró">{{ origen(d.origin) }}</td>
                  </tr>
                </ng-template>
              </p-table>
            </section>
        }
      }

      <!-- ===== Confirmar productos ===== -->
      <p-dialog [visible]="dlgConfirmar()" (visibleChange)="dlgConfirmar.set($event)" [modal]="true" [draggable]="false"
                header="Confirmar productos de la temporada" [style]="{ width: '34rem' }" appendTo="body">
        <div class="tp-form">
          <p>{{ seleccion().length }} productos de {{ cands()?.temporada }} {{ cands()?.year }}.</p>
          <span class="tp-label" id="tp-rec-l">¿Vuelven cada año?</span>
          <app-segmented [options]="opcionesRecurrencia" [value]="recurrencia" (valueChange)="cambiarRecurrencia($event)" ariaLabel="Si los productos vuelven cada año" />
          @if (recurrencia === 'solo_un_anio') {
            <label class="tp-label" for="tp-anio">¿De qué año?</label>
            <p-inputnumber [(ngModel)]="anioUnico" [useGrouping]="false" [min]="2020" [max]="2100" inputId="tp-anio" />
          }
          <span class="tp-label">¿Se reponen dentro de la temporada?</span>
          <app-segmented [options]="opcionesReposicion" [value]="reposicion ?? ''" (valueChange)="cambiarReposicion($event)" ariaLabel="Si se reponen dentro de la temporada" />
          @if (problemaLote('confirmada'); as p) { <p class="tp-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="tp-error" role="alert">{{ errorDlg() }}</p> }
          <div class="tp-acc">
            <button pButton type="button" class="p-button-sm" [disabled]="!!problemaLote('confirmada') || ocupado()" (click)="enviar('confirmada')">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Confirmar ' + seleccion().length }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgConfirmar.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>

      <!-- ===== Descartar productos ===== -->
      <p-dialog [visible]="dlgDescartar()" (visibleChange)="dlgDescartar.set($event)" [modal]="true" [draggable]="false"
                header="Descartar productos de la temporada" [style]="{ width: '32rem' }" appendTo="body">
        <div class="tp-form">
          <p>{{ seleccion().length }} productos dejan de proponerse para {{ cands()?.temporada }}.</p>
          <label class="tp-label" for="tp-motivo">¿Por qué no son de esta temporada? (obligatorio)</label>
          <textarea pTextarea id="tp-motivo" rows="3" [(ngModel)]="motivo" maxlength="500"
                    placeholder="Ejemplo: se vende todo el año; fue un lanzamiento"></textarea>
          @if (problemaLote('descartada'); as p) { <p class="tp-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="tp-error" role="alert">{{ errorDlg() }}</p> }
          <div class="tp-acc">
            <button pButton type="button" class="p-button-sm tp-btn-bad-solid" [disabled]="!!problemaLote('descartada') || ocupado()" (click)="enviar('descartada')">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : 'Descartar ' + seleccion().length }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgDescartar.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>

      <!-- ===== Confirmar o corregir fechas (mismo endpoint) ===== -->
      <p-dialog [visible]="dlgFechas()" (visibleChange)="dlgFechas.set($event)" [modal]="true" [draggable]="false"
                [header]="(corrigiendo() ? 'Corregir' : 'Confirmar') + ' fechas de ' + (fechasDe()?.t?.name ?? '') + ' ' + (fechasDe()?.f?.year ?? '')"
                [style]="{ width: '34rem' }" appendTo="body">
        <div class="tp-form">
          @if (corrigiendo()) {
            <p class="tp-sub">Ya estaban confirmadas por {{ fechasDe()?.f?.confirmed_by_name ?? 'alguien sin nombre registrado' }}. Al corregirlas quedan con tu nombre y la fecha de hoy.</p>
          } @else {
            <p class="tp-sub">Al confirmarlas, las fechas dejan de ser propuesta y quedan con tu nombre. Las que nadie ha definido pueden quedar vacías.</p>
          }
          <div class="tp-fechas">
            <label class="tp-label" for="tp-f1">Venta desde</label>
            <p-datepicker [(ngModel)]="fVentaDesde" dateFormat="dd/mm/yy" appendTo="body" [showOnFocus]="false" [showIcon]="true" inputId="tp-f1" />
            <label class="tp-label" for="tp-f2">Venta hasta</label>
            <p-datepicker [(ngModel)]="fVentaHasta" dateFormat="dd/mm/yy" appendTo="body" [showOnFocus]="false" [showIcon]="true" inputId="tp-f2" />
            <label class="tp-label" for="tp-f3">Comprar antes de (opcional)</label>
            <p-datepicker [(ngModel)]="fComprarAntes" dateFormat="dd/mm/yy" appendTo="body" [showOnFocus]="false" [showIcon]="true" inputId="tp-f3" [showClear]="true" />
            <label class="tp-label" for="tp-f4">Corte de reposición (opcional)</label>
            <p-datepicker [(ngModel)]="fCorte" dateFormat="dd/mm/yy" appendTo="body" [showOnFocus]="false" [showIcon]="true" inputId="tp-f4" [showClear]="true" />
            <label class="tp-label" for="tp-f5">Remate desde (opcional)</label>
            <p-datepicker [(ngModel)]="fRemate" dateFormat="dd/mm/yy" appendTo="body" [showOnFocus]="false" [showIcon]="true" inputId="tp-f5" [showClear]="true" />
          </div>
          @if (!corrigiendo() && fechasDe()?.f?.proposal_source; as fuente) { <p class="tp-sub">Propuesta: {{ fuente }}</p> }
          @if (problemaFechas(); as p) { <p class="tp-sub" role="status">{{ p }}</p> }
          @if (errorDlg()) { <p class="tp-error" role="alert">{{ errorDlg() }}</p> }
          <div class="tp-acc">
            <button pButton type="button" class="p-button-sm" [disabled]="!!problemaFechas() || ocupado()" (click)="confirmarFechas()">
              <span class="p-button-label">{{ ocupado() ? 'Guardando…' : (corrigiendo() ? 'Guardar la corrección' : 'Confirmar fechas') }}</span>
            </button>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="dlgFechas.set(false)">
              <span class="p-button-label">Cancelar</span>
            </button>
          </div>
        </div>
      </p-dialog>
    </div>
  `,
  styleUrls: ['./compras-temporadas.component.css'],
})
export class ComprasTemporadasComponent implements OnInit {
  private readonly api = inject(TemporadasService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly puedeGestionar = this.perms.has$(Permission.COMPRAS_TEMPORADAS_GESTIONAR);
  readonly loteMax = TEMPORADAS_LOTE_MAX;

  // ── Calendario ──────────────────────────────────────────────────────────────────────────────
  readonly vista = signal<TemporadasVista | null>(null);
  readonly cargandoCal = signal(true);
  readonly errorCal = signal<string | null>(null);
  readonly cargadoCalEn = signal<Date | null>(null);

  // ── Productos de una temporada-año ─────────────────────────────────────────────────────────
  /** El id de `catalog.season_dates` abierto (va en la URL: `?fecha=`). `null` = calendario. */
  readonly fechaSel = signal<string | null>(null);
  readonly cands = signal<CandidatosTemporada | null>(null);
  readonly cargandoCand = signal(false);
  readonly errorCand = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly seleccion = signal<CandidatoTemporada[]>([]);
  /** Motivo por clave de lo que NO se guardó en el último lote: la fila lo muestra y sigue seleccionada. */
  readonly fallidas = signal<Record<string, string>>({});
  readonly aviso = signal<string | null>(null);

  // ── Diálogos ────────────────────────────────────────────────────────────────────────────────
  readonly dlgConfirmar = signal(false);
  readonly dlgDescartar = signal(false);
  readonly dlgFechas = signal(false);
  readonly fechasDe = signal<{ t: TemporadaResumen; f: FechasTemporada } | null>(null);
  readonly ocupado = signal(false);
  readonly errorDlg = signal<string | null>(null);
  /** El error de la última acción, también FUERA del diálogo: si se cerró mientras guardaba, no se pierde. */
  readonly errorAccion = signal<string | null>(null);
  /** Las fechas abiertas ya estaban confirmadas: el diálogo corrige en vez de confirmar (mismo endpoint). */
  readonly corrigiendo = computed(() => this.fechasDe()?.f.status === 'confirmada');

  // Formularios: ngModel, así que son campos y no signals (los métodos de abajo se recalculan por evento).
  recurrencia: RecurrenciaTemporada = 'anual';
  anioUnico: number | null = null;
  reposicion: ReposicionTemporada | null = null;
  motivo = '';
  fVentaDesde: Date | null = null;
  fVentaHasta: Date | null = null;
  fComprarAntes: Date | null = null;
  fCorte: Date | null = null;
  fRemate: Date | null = null;

  readonly opcionesRecurrencia: SegOption[] = [
    { label: 'Vuelve cada año', value: 'anual' },
    { label: 'Sólo un año', value: 'solo_un_anio' },
  ];
  readonly opcionesReposicion: SegOption[] = [
    { label: 'Compra única: no se repone', value: 'compra_unica' },
    { label: 'Se repone hasta el corte', value: 'hasta_corte' },
  ];

  // ── Derivados del calendario ────────────────────────────────────────────────────────────────
  /**
   * El orden lo da la API (en venta → por iniciar → terminadas): no se reordena aquí. De cada temporada se
   * muestra la temporada-año RELEVANTE, no la más reciente a secas: el día que exista 2027, una de 2026 que
   * sigue en venta no puede desaparecer del calendario.
   */
  readonly filas = computed<FilaCalendario[]>(() =>
    (this.vista()?.temporadas ?? []).map((t) => ({ t, f: fechaRelevante(t.fechas) })));

  readonly respuestaCal = computed(() => {
    const fs = this.filas();
    if (!fs.length) return '';
    const enVenta = fs.find((x) => x.f?.momento === 'en_venta');
    const proxima = fs.find((x) => x.f?.momento === 'por_iniciar');
    const partes: string[] = [];
    if (enVenta?.f) {
      partes.push(`${enVenta.t.name} está en venta (del ${this.dia(enVenta.f.sale_from)} al ${this.dia(enVenta.f.sale_to)}).`);
      partes.push(enVenta.f.status === 'propuesta'
        ? 'Sus fechas siguen propuestas: todavía no frenan nada.'
        : 'Sus fechas están confirmadas.');
    } else {
      partes.push('Hoy no hay ninguna temporada en venta.');
    }
    if (proxima?.f) partes.push(`La que sigue es ${proxima.t.name}, desde el ${this.dia(proxima.f.sale_from)}.`);
    return partes.join(' ');
  });

  readonly kpisCal = computed<MetricStripItem[]>(() => {
    const fs = this.filas();
    const porConfirmar = fs.filter((x) => x.f?.status === 'propuesta').length;
    const conf = fs.reduce((s, x) => s + x.t.productos.confirmados, 0);
    const desc = fs.reduce((s, x) => s + x.t.productos.descartados, 0);
    return [
      { label: 'Fechas por confirmar', value: porConfirmar, format: 'number', sub: `de ${fs.length} temporadas: la que está en venta o la próxima de cada una` },
      { label: 'Productos confirmados', value: conf, format: 'number', sub: 'en todas las temporadas' },
      { label: 'Productos descartados', value: desc, format: 'number', sub: 'en todas las temporadas, con su motivo' },
    ];
  });

  /** La fuente de la propuesta, una sola vez (es la misma para toda la siembra). */
  readonly fuentePropuesta = computed(() => {
    const f = this.filas().find((x) => x.f?.status === 'propuesta' && x.f.proposal_source)?.f;
    return f?.proposal_source ?? null;
  });

  // ── Derivados de la vista de productos ─────────────────────────────────────────────────────
  readonly temporadaAbierta = computed<TemporadaResumen | null>(() => {
    const id = this.fechaSel();
    if (!id) return null;
    return this.vista()?.temporadas.find((t) => t.fechas.some((f) => f.id === id)) ?? null;
  });

  readonly anios = computed<SegOption[]>(() =>
    (this.temporadaAbierta()?.fechas ?? []).map((f) => ({ label: String(f.year), value: f.id })));

  /** Por decidir primero; después por venta en la temporada (la mayor arriba). */
  readonly candidatos = computed<CandidatoTemporada[]>(() => {
    const q = this.busqueda();
    const rango = (c: CandidatoTemporada) => (c.decision === null ? 0 : 1);
    return [...(this.cands()?.candidatos ?? [])]
      .filter((c) => coincideBusqueda(q, c.nombre, c.sku))
      .sort((a, b) => rango(a) - rango(b) || Number(b.venta_temporada) - Number(a.venta_temporada));
  });

  /** Cuentas de la PROPUESTA (el universo se dice en cada una): se derivan de las filas, no se repiten del servidor. */
  readonly cuentas = computed(() => {
    const cs = this.cands()?.candidatos ?? [];
    const conf = cs.filter((c) => c.decision === 'confirmada').length;
    const desc = cs.filter((c) => c.decision === 'descartada').length;
    return { propuestos: cs.length, confirmados: conf, descartados: desc, porDecidir: cs.length - conf - desc };
  });

  readonly kpisProd = computed<MetricStripItem[]>(() => {
    const c = this.cuentas();
    return [
      { label: 'Por decidir', value: c.porDecidir, format: 'number', sub: `de ${c.propuestos} que propone la venta` },
      { label: 'Confirmados', value: c.confirmados, format: 'number', sub: 'de la propuesta' },
      { label: 'Descartados', value: c.descartados, format: 'number', sub: 'de la propuesta, con su motivo' },
    ];
  });

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      const id = p.get('fecha');
      if (id !== this.fechaSel()) {
        this.fechaSel.set(id);
        this.limpiarProductos();
        if (id) this.cargarCandidatos();
      }
    });
    this.cargarCalendario();
  }

  // ── Carga ───────────────────────────────────────────────────────────────────────────────────
  cargarCalendario(): void {
    this.cargandoCal.set(true);
    this.errorCal.set(null);
    this.api.calendario().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => { this.vista.set(v); this.cargandoCal.set(false); this.cargadoCalEn.set(new Date()); },
      error: (e) => { this.errorCal.set(this.mensajeDe(e, 'leer el calendario de temporadas')); this.cargandoCal.set(false); },
    });
  }

  cargarCandidatos(conservar: string[] = []): void {
    const id = this.fechaSel();
    if (!id) return;
    this.cargandoCand.set(true);
    this.errorCand.set(null);
    this.api.candidatos(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (this.fechaSel() !== id) return; // el usuario ya abrió otra temporada-año
        this.cands.set(r);
        this.seleccion.set(r.candidatos.filter((c) => conservar.includes(c.sku)));
        this.cargandoCand.set(false);
      },
      error: (e) => {
        if (this.fechaSel() !== id) return;
        this.errorCand.set(this.mensajeDe(e, 'leer los productos de esta temporada'));
        this.cargandoCand.set(false);
      },
    });
  }

  // ── Navegación ──────────────────────────────────────────────────────────────────────────────
  abrirProductos(seasonDateId: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { fecha: seasonDateId }, queryParamsHandling: 'merge' });
  }

  volverAlCalendario(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { fecha: null }, queryParamsHandling: 'merge' });
  }

  private limpiarProductos(): void {
    this.cands.set(null);
    this.errorCand.set(null);
    this.busqueda.set('');
    this.seleccion.set([]);
    this.fallidas.set({});
    this.aviso.set(null);
  }

  // ── Decisiones por lote ─────────────────────────────────────────────────────────────────────
  abrirConfirmar(): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.recurrencia = 'anual';
    this.anioUnico = this.cands()?.year ?? null;
    this.reposicion = null; // a propósito sin valor: es una decisión, no un default
    this.dlgConfirmar.set(true);
  }

  abrirDescartar(): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.motivo = '';
    this.dlgDescartar.set(true);
  }

  cambiarRecurrencia(v: string): void {
    this.recurrencia = v === 'solo_un_anio' ? 'solo_un_anio' : 'anual';
  }

  cambiarReposicion(v: string): void {
    this.reposicion = v === 'hasta_corte' ? 'hasta_corte' : v === 'compra_unica' ? 'compra_unica' : null;
  }

  /** Lo que viaja: una decisión por fila seleccionada, con la evidencia que la fila mostró. */
  private decisiones(decision: DecisionTemporada): DecisionProductoTemporadaDto[] {
    const year = this.cands()?.year ?? null;
    return this.seleccion().map((c) => ({
      sku: c.sku,
      decision,
      origin: 'propuesta_del_sistema' as const,
      ...(decision === 'confirmada'
        ? {
            recurrence: this.recurrencia,
            only_year: this.recurrencia === 'solo_un_anio' ? this.anioUnico : null,
            replenishment: this.reposicion,
          }
        : { reason: this.motivo.trim() }),
      evidence: {
        venta_temporada: Number(c.venta_temporada),
        concentracion: Number(c.concentracion),
        cayo_despues: c.cayo_despues,
        por_nombre: c.por_nombre,
        year,
      },
    }));
  }

  /** La MISMA validación del servidor (contrato), antes de enviar. `null` = se puede enviar. */
  problemaLote(decision: DecisionTemporada): string | null {
    const n = this.seleccion().length;
    if (!n) return 'Elige al menos un producto.';
    if (n > TEMPORADAS_LOTE_MAX) return `Elige hasta ${TEMPORADAS_LOTE_MAX} productos a la vez.`;
    for (const d of this.decisiones(decision)) {
      const p = validarDecisionTemporada(d);
      if (p) return p;
    }
    return null;
  }

  enviar(decision: DecisionTemporada): void {
    if (this.ocupado() || this.problemaLote(decision)) return;
    // La temporada sale de los CANDIDATOS, no del calendario: con un enlace directo (?fecha=) el calendario
    // puede no haber llegado todavía, y entonces el botón no hacía nada sin decir por qué.
    const seasonId = this.cands()?.season_id ?? null;
    if (!seasonId) {
      this.errorDlg.set('No se sabe a qué temporada pertenecen estos productos: vuelve a abrirla desde el calendario.');
      return;
    }
    this.ocupado.set(true); // en el primer clic, antes de esperar la respuesta
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    const enviadas = this.decisiones(decision);
    this.api.decidir(seasonId, { decisiones: enviadas }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        const fall: Record<string, string> = {};
        for (const f of r.fallidas) fall[f.sku] = f.motivo;
        this.fallidas.set(fall);
        const verbo = decision === 'confirmada' ? 'confirmados' : 'descartados';
        this.aviso.set(r.fallidas.length
          ? `${r.guardadas} ${verbo} · ${r.fallidas.length} no se guardaron (siguen seleccionados, con su motivo).`
          : `${r.guardadas} ${verbo}.`);
        this.dlgConfirmar.set(false);
        this.dlgDescartar.set(false);
        // Se vuelve a leer: la decisión que se ve es la que quedó en la base, no la que se mandó.
        this.cargarCandidatos(r.fallidas.map((f) => f.sku));
        this.cargarCalendario();
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `No se guardó ninguna decisión. ${this.mensajeDe(e, 'guardar las decisiones')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m); // por si el diálogo ya se cerró
      },
    });
  }

  // ── Confirmar fechas ────────────────────────────────────────────────────────────────────────
  abrirFechas(t: TemporadaResumen, f: FechasTemporada): void {
    this.errorDlg.set(null);
    this.errorAccion.set(null);
    this.fechasDe.set({ t, f });
    this.fVentaDesde = this.aFecha(f.sale_from);
    this.fVentaHasta = this.aFecha(f.sale_to);
    this.fComprarAntes = this.aFecha(f.buy_by);
    this.fCorte = this.aFecha(f.cutoff);
    this.fRemate = this.aFecha(f.clearance_from);
    this.dlgFechas.set(true);
  }

  private dtoFechas(): ConfirmarFechasTemporadaDto {
    return {
      sale_from: this.fVentaDesde ? this.iso(this.fVentaDesde) : '',
      sale_to: this.fVentaHasta ? this.iso(this.fVentaHasta) : '',
      buy_by: this.fComprarAntes ? this.iso(this.fComprarAntes) : null,
      cutoff: this.fCorte ? this.iso(this.fCorte) : null,
      clearance_from: this.fRemate ? this.iso(this.fRemate) : null,
    };
  }

  /** Con el AÑO de la temporada-año que se confirma o corrige: la venta tiene que empezar en ese año. */
  problemaFechas(): string | null {
    return validarFechasTemporada(this.dtoFechas(), this.fechasDe()?.f.year);
  }

  confirmarFechas(): void {
    const sel = this.fechasDe();
    if (!sel || this.ocupado() || this.problemaFechas()) return;
    this.ocupado.set(true);
    this.errorDlg.set(null);
    this.api.confirmarFechas(sel.f.id, this.dtoFechas()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ocupado.set(false);
        this.dlgFechas.set(false);
        this.cargarCalendario();
        if (this.fechaSel() === sel.f.id) this.cargarCandidatos(this.seleccion().map((c) => c.sku));
      },
      error: (e) => {
        this.ocupado.set(false);
        const m = `Las fechas no cambiaron. ${this.mensajeDe(e, 'guardar las fechas')}`;
        this.errorDlg.set(m);
        this.errorAccion.set(m); // por si el diálogo ya se cerró
      },
    });
  }

  // ── Presentación ────────────────────────────────────────────────────────────────────────────
  momento(m: MomentoTemporada | undefined): string {
    return m ? MOMENTO[m] : '—';
  }

  /** `YYYY-MM-DD` → «1 sep» sin pasar por la zona horaria (un `Date` en UTC de noche adelanta el día). */
  dia(s: string | null | undefined): string {
    if (!s) return '—';
    const [, m, d] = s.split('-').map(Number);
    return `${d} ${MESES[(m || 1) - 1]}`;
  }

  /** «1 sep 2026, 14:05» de un timestamp completo, en hora local. */
  momentoDe(ts: string | null | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** `YYYY-MM` → «sep 2025». */
  mes(s: string | null | undefined): string {
    if (!s) return '—';
    const [y, m] = s.split('-').map(Number);
    return `${MESES[(m || 1) - 1]} ${y}`;
  }

  pesos(v: number | string | null | undefined): string {
    return PESOS.format(Number(v ?? 0));
  }

  pct(v: number | string | null | undefined): string {
    return `${Math.round(Number(v ?? 0) * 100)} %`;
  }

  /** `null` = el mes siguiente no ha cerrado: «sin medir», nunca «No». */
  cayo(v: boolean | null): string {
    return v === null ? 'sin medir' : v ? 'Sí' : 'No';
  }

  origen(o: string): string {
    return o === 'manual' ? 'agregado a mano' : 'de otra propuesta';
  }

  alBuscar(v: string): void {
    this.busqueda.set(v);
  }

  cambiarAnio(id: string): void {
    if (id && id !== this.fechaSel()) this.abrirProductos(id);
  }

  private aFecha(s: string | null | undefined): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  /** `YYYY-MM-DD` en hora LOCAL: `toISOString()` es UTC y de noche adelanta el día. */
  private iso(f: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`;
  }

  private mensajeDe(e: unknown, accion: string): string {
    return motivoTemporadas(e, accion);
  }
}
