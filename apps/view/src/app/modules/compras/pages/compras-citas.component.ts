import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { CheckboxModule } from 'primeng/checkbox';
import { AutoCompleteModule, type AutoCompleteCompleteEvent } from 'primeng/autocomplete';
import {
  AREAS_PARTICIPANTE, ETIQUETA_AREA_PARTICIPANTE, ETIQUETA_MODALIDAD_REUNION, ETIQUETA_SITUACION_REUNION, ETIQUETA_TIPO_REUNION, LIMITES_REUNION,
  MODALIDADES_REUNION, TIPOS_REUNION,
  type AccionReunion, type AgendaCitas, type AgendarReunionDto, type AreaParticipante, type DetalleReunion, type ModalidadReunion, type PersonaCitas,
  type ProveedorCitas, type ReunionVista, type SituacionReunion, type TipoReunion,
} from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PROVEEDORES_TABS } from '../proveedores-tabs';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { motivoHttp } from '../../almacen/shared/http-motivo';
import { CitasProveedoresService } from '../citas-proveedores.service';
import {
  aniosDelPlan, areaEnPalabras, choqueEnPalabras, diaCorto, diaLargo, dtoDeReunion, faltaParaGuardar, fechaDeIso, fechaIso, finSugerido, HORAS,
  horario, lugarEnPalabras, primeraDelDia, proveedorEnPalabras, quienVa, rangoSemana, relativo, respuesta, SEVERIDAD_SITUACION, sumarDiasIso,
  tipoEnPalabras,
} from '../citas-proveedores';

type Vista = 'semana' | 'sin_minuta';
type FiltroTipo = 'todos' | TipoReunion;

/** Un renglón editable de gente: de Mega Dulces (persona + área) o del proveedor (nombre + puesto). */
interface FilaInterna { id: string | null; user_id: string | null; area: AreaParticipante | null }
interface FilaProveedor { id: string | null; name: string; job_title: string }

/**
 * `[PQ.3.8]` Compras › Proveedores › **Citas** (anexo C §9.1, §10.15, §10.19; DC9, DC34, DC41).
 *
 * Las cinco preguntas (skill `diseno` §0b), contestadas ANTES de esta plantilla:
 *  1. **Qué ve y en qué orden.** La respuesta: cuántas reuniones hay en la semana, cuántas pasaron sin minuta y cuántas
 *     siguen por confirmar (las dos últimas, de cualquier semana: son lo pendiente). Después la semana, de lunes a
 *     domingo, en orden de hora, con el día pintado en el primer renglón de cada día. «Agendar reunión» arriba.
 *  2. **Qué no ve.** Una rejilla de horas (con pocas reuniones sería casi toda vacía), las cifras del proveedor (eso es
 *     Revisión, PQ.3.9), los acuerdos (PQ.3.10) ni la lista «por programar» (Revisión). Una cancelada sí se ve en su
 *     día, en gris y con su etiqueta: dice «ya no vayas».
 *  3. **Accesibilidad.** El detalle a un clic (side-peek): temas, gente de las dos partes, choques de horario y la
 *     minuta de la reunión ANTERIOR con el mismo proveedor. Semana anterior y siguiente; filtro por tipo con su conteo.
 *     Todo con teclado; la situación siempre en palabras, el color sólo acompaña.
 *  4. **Ligas.** Cada reunión trae la anterior realizada con ese proveedor (lo que se dijo la vez pasada). Los acuerdos
 *     llegan con PQ.3.10. NO liga todavía a la regla del Calendario ni a Pedido (declarado en §10.19).
 *  5. **¿Le toca a esta pantalla?** La agenda (semana + lo pendiente) vive aquí; las revisiones de negocio «por
 *     programar» y su ficha, en Revisión; las visitas por WhatsApp (PQ.3.13) entrarán aquí, sobre esta agenda.
 *
 * Jerarquía (§Q.5): primario = la respuesta y el proveedor de cada renglón; secundario = cuándo, quién va y la situación;
 * terciario = tipo, lugar y clave. La situación y los botones de cada reunión los dice la API (la misma regla que frena
 * la escritura): esta pantalla no los recalcula.
 */
@Component({
  selector: 'app-compras-citas',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, TableModule, TagModule, DialogModule, DatePickerModule, InputTextModule, SelectModule, TextareaModule,
    CheckboxModule, AutoCompleteModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent,
    SidePeekComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ct-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Citas con proveedores</h1>
          <p class="surf-page-sub">
            <span>Reuniones con ejecutivos, revisiones de negocio y planes de trabajo, en una sola agenda.</span>
          </p>
        </div>
        <div class="ct-head-acc">
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
          @if (puedeAgendar()) {
            <button pButton type="button" class="p-button-sm" (click)="abrirNueva()">
              <i class="pi pi-plus" aria-hidden="true"></i><span class="p-button-label">Agendar reunión</span>
            </button>
          }
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (errorAccion()) { <p class="ct-error" role="alert">{{ errorAccion() }}</p> }
      @if (aviso()) { <p class="ct-aviso" role="status">{{ aviso() }}</p> }

      <!-- La respuesta y las cifras SÓLO con la agenda leída: cargando o con error no se dibuja un cero. -->
      @if (agenda() && !error()) {
        <p class="ct-respuesta" role="status">{{ respuestaTexto() }}</p>
        <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Reuniones" (drill)="irAVista($event)" />
      }

      <div class="ct-barra">
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="irAVista($event)" ariaLabel="Qué ver" />
        @if (vista() === 'semana') {
          <div class="ct-semana" role="group" aria-label="Cambiar de semana">
            <!-- En PrimeNG 22 el ícono va DENTRO del botón ([iconOnly]): el atributo «icon» de pButton ya no dibuja nada. -->
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ct-ico" [iconOnly]="true"
                    (click)="moverSemana(-7)" aria-label="Semana anterior"><i class="pi pi-chevron-left" aria-hidden="true"></i></button>
            <span class="ct-rango">{{ rango() }}</span>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ct-ico" [iconOnly]="true"
                    (click)="moverSemana(7)" aria-label="Semana siguiente"><i class="pi pi-chevron-right" aria-hidden="true"></i></button>
            @if (agenda() && !esSemanaActual()) {
              <button pButton type="button" class="p-button-sm p-button-text" (click)="irASemana(null)">
                <span class="p-button-label">Esta semana</span>
              </button>
            }
          </div>
        }
        <app-segmented [options]="opcionesTipo()" [value]="tipo()" (valueChange)="tipo.set($any($event))" ariaLabel="Tipo de reunión" />
      </div>

      <app-load-state class="dt-scope" [loading]="cargando()" [error]="error()" [isEmpty]="vacio()" [skeletonRows]="6"
                      emptyIcon="pi-calendar" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                      [emptyCta]="puedeAgendar() && vista() === 'semana' ? 'Agendar reunión' : null" (cta)="abrirNueva()" (retry)="cargar()">
        <p-table [value]="$any(lista())" dataKey="id" class="ct-table dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                 [rowHover]="true" [tableStyle]="{ 'min-width': '44rem' }">
          <ng-template #header>
            <tr>
              <th>Cuándo</th>
              <th>Proveedor</th>
              <th>Quién va</th>
              <th>Situación</th>
              <th><span class="ct-sr">Acciones</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-r let-i="rowIndex">
            <tr [class.ct-dia-nuevo]="vista() === 'semana' && esPrimera(i)" [class.ct-cancelada]="r.situacion === 'cancelada'">
              <td role="cell" data-label="Cuándo">
                <div class="ct-celda">
                  @if (vista() === 'sin_minuta' || esPrimera(i)) {
                    <span class="ct-dia" [class.ct-hoy]="r.date === agenda()?.hoy">{{ r.date === agenda()?.hoy ? 'Hoy · ' : '' }}{{ diaCorto(r.date) }}</span>
                  }
                  <span class="ct-hora">{{ horario(r) }}</span>
                  @if (vista() === 'sin_minuta') { <span class="ct-sub">{{ rel(r.date) }}</span> }
                </div>
              </td>
              <td role="cell" data-label="Proveedor">
                <div class="ct-celda">
                  <button type="button" class="ct-link" (click)="abrir(r.id)" [attr.aria-label]="'Ver la reunión con ' + proveedor(r) + ' del ' + diaLargo(r.date)">
                    {{ proveedor(r) }}
                  </button>
                  <span class="ct-sub">{{ tipoTexto(r) }} · {{ lugar(r) }}</span>
                </div>
              </td>
              <td role="cell" data-label="Quién va">
                <div class="ct-celda">
                  <span>{{ quienVa(r) }}</span>
                  @if (r.choques.length) {
                    <span class="ct-choque"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Choca con otra reunión</span>
                  }
                </div>
              </td>
              <td role="cell" data-label="Situación">
                <p-tag [value]="etiqueta(r.situacion)" [severity]="severidad(r.situacion)" />
              </td>
              <td role="cell" data-label="Acciones">
                <div class="ct-acc">
                  @if (puedeAgendar()) {
                    @if (puede(r, 'minuta')) {
                      <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirMinuta(r)"
                              [attr.aria-label]="'Escribir la minuta de la reunión con ' + proveedor(r)">
                        <span class="p-button-label">Escribir minuta</span>
                      </button>
                    } @else if (puede(r, 'confirmar')) {
                      <button pButton type="button" class="p-button-sm p-button-text" (click)="confirmar(r)" [disabled]="guardando()"
                              [attr.aria-label]="'Confirmar la reunión con ' + proveedor(r)">
                        <span class="p-button-label">Confirmar</span>
                      </button>
                    }
                  }
                </div>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="5" class="ct-nota">Ninguna reunión de ese tipo{{ vista() === 'semana' ? ' en esta semana' : ' pasó sin minuta' }}.</td></tr>
          </ng-template>
        </p-table>
        @if (vista() === 'sin_minuta' && agenda(); as a) {
          @if (a.sin_minuta.total > a.sin_minuta.reuniones.length) {
            <p class="ct-nota ct-pie">
              Se ven las {{ a.sin_minuta.reuniones.length }} más viejas de {{ a.sin_minuta.total }}: al escribir su minuta o cancelarlas aparecen las siguientes.
            </p>
          }
        }
      </app-load-state>

      <!-- ===== Detalle de una reunión ===== -->
      <app-side-peek [open]="!!abierta() || cargandoDetalle()" (openChange)="!$event && cerrar()" [width]="520"
                     [title]="abierta() ? proveedor(abierta()!.reunion) : 'Reunión'"
                     [subtitle]="abierta() ? tipoTexto(abierta()!.reunion) + ' · ' + diaLargo(abierta()!.reunion.date) + ', ' + horario(abierta()!.reunion) : null">
        @if (cargandoDetalle()) { <p class="ct-nota">Cargando la reunión…</p> }
        @if (errorDetalle()) { <p class="ct-error" role="alert">{{ errorDetalle() }}</p> }
        @if (abierta(); as d) {
          <div class="ct-peek">
            <section>
              <div class="ct-peek-estado">
                <p-tag [value]="etiqueta(d.reunion.situacion)" [severity]="severidad(d.reunion.situacion)" />
                @if (d.reunion.status === 'to_confirm' && d.reunion.situacion !== 'sin_minuta') { <span class="ct-sub">El ejecutivo no ha confirmado el horario.</span> }
              </div>
              @if (puedeAgendar() && d.reunion.acciones.length) {
                <div class="ct-acc">
                  @if (puede(d.reunion, 'minuta')) {
                    <button pButton type="button" class="p-button-sm" (click)="abrirMinuta(d.reunion)"><span class="p-button-label">Escribir minuta</span></button>
                  }
                  @if (puede(d.reunion, 'confirmar')) {
                    <button pButton type="button" class="p-button-sm p-button-outlined" (click)="confirmar(d.reunion)" [disabled]="guardando()">
                      <span class="p-button-label">Confirmar</span>
                    </button>
                  }
                  @if (puede(d.reunion, 'editar')) {
                    <button pButton type="button" class="p-button-sm p-button-outlined p-button-secondary" (click)="abrirEditar(d.reunion)">
                      <span class="p-button-label">Editar o reprogramar</span>
                    </button>
                  }
                </div>
              }
            </section>

            @if (d.reunion.choques.length) {
              <section class="ct-advertencia" role="note">
                @for (c of d.reunion.choques; track c.meeting_id + c.user_id) { <p>{{ choque(c) }}</p> }
              </section>
            }

            <section>
              <h3>Cuándo y dónde</h3>
              <p>{{ diaLargo(d.reunion.date) }}, de {{ horario(d.reunion) }}</p>
              <p class="ct-sub">{{ lugar(d.reunion) }}</p>
            </section>

            <section>
              <h3>Temas</h3>
              @if (d.reunion.topics.length) {
                <ol class="ct-temas">@for (t of d.reunion.topics; track $index) { <li>{{ t }}</li> }</ol>
              } @else { <p class="ct-falta">Sin temas escritos.</p> }
            </section>

            <section>
              <h3>Quién va</h3>
              <ul class="ct-gente">
                @for (p of d.reunion.participants; track p.id) {
                  <li>
                    <span>{{ p.nombre }}</span>
                    <span class="ct-sub ct-inline">{{ ' · ' }}{{ p.side === 'internal' ? areaTexto(p.area) : 'Proveedor' + (p.job_title ? ', ' + p.job_title : '') }}</span>
                  </li>
                }
              </ul>
              <p class="ct-sub">La agendó {{ d.reunion.organizer.nombre }}.</p>
            </section>

            @if (d.reunion.minutes) {
              <section>
                <h3>Minuta</h3>
                <p class="ct-texto">{{ d.reunion.minutes }}</p>
                <p class="ct-sub">La escribió {{ d.reunion.minutes_by || 'alguien sin nombre' }}{{ d.reunion.minutes_at ? ' el ' + diaLargo(d.reunion.minutes_at.slice(0, 10)) : '' }}.</p>
              </section>
            }
            @if (d.reunion.cancelled_reason) {
              <section>
                <h3>Por qué se canceló</h3>
                <p class="ct-texto">{{ d.reunion.cancelled_reason }}</p>
                <p class="ct-sub">La canceló {{ d.reunion.cancelled_by || 'alguien sin nombre' }}.</p>
              </section>
            }

            <section>
              <h3>La reunión anterior con este proveedor</h3>
              @if (d.anterior; as an) {
                <p>{{ tipoTexto(an) }} · {{ diaLargo(an.date) }} ({{ rel(an.date) }})</p>
                <p class="ct-texto">{{ an.minutes }}</p>
              } @else {
                <p class="ct-falta">No hay otra reunión realizada con este proveedor antes de ésta.</p>
              }
            </section>

            @if (puedeAgendar() && puede(d.reunion, 'cancelar')) {
              <section class="ct-peek-baja">
                <button pButton type="button" class="p-button-sm p-button-text ct-btn-bad" (click)="abrirCancelar(d.reunion)">
                  <span class="p-button-label">Cancelar la reunión</span>
                </button>
              </section>
            }
          </div>
        }
      </app-side-peek>

      <!-- ===== Agendar o editar ===== -->
      <p-dialog [visible]="dlg()" (visibleChange)="dlg.set($event)" [modal]="true" [draggable]="false" [style]="{ width: 'min(44rem, 96vw)' }"
                [header]="editandoId() ? 'Editar o reprogramar la reunión' : 'Agendar reunión'">
        <div class="ct-form">
          <fieldset class="ct-grupo">
            <legend>Con quién y para qué</legend>
            <label class="ct-label" for="ct-prov">Proveedor</label>
            <p-autocomplete inputId="ct-prov" [(ngModel)]="fProveedor" [suggestions]="sugerencias()" (completeMethod)="buscarProveedor($event)"
                            optionLabel="etiqueta" [forceSelection]="true" [minQueryLength]="2" [delay]="250" appendTo="body" [fluid]="true"
                            placeholder="Nombre o clave del proveedor" [showEmptyMessage]="true" emptyMessage="Nada coincide en el catálogo de proveedores" />
            <span class="ct-label" id="ct-tipo-l">Tipo</span>
            <app-segmented [options]="opcionesTipoForm" [value]="fTipo" (valueChange)="cambiarTipo($event)" ariaLabel="Tipo de reunión" />
            @if (fTipo === 'work_plan') {
              <label class="ct-label" for="ct-anio">Año del plan</label>
              <p-select inputId="ct-anio" [options]="anios()" [(ngModel)]="fAnio" placeholder="Elige el año" appendTo="body" />
            }
          </fieldset>

          <fieldset class="ct-grupo">
            <legend>Cuándo y dónde</legend>
            <div class="ct-fila">
              <div class="ct-campo">
                <label class="ct-label" for="ct-fecha">Fecha</label>
                <p-datepicker inputId="ct-fecha" [(ngModel)]="fFecha" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" />
              </div>
              <div class="ct-campo">
                <label class="ct-label" for="ct-ini">De</label>
                <p-select inputId="ct-ini" [options]="horas" [(ngModel)]="fInicio" (onChange)="cambiarInicio()" appendTo="body" [filter]="true" />
              </div>
              <div class="ct-campo">
                <label class="ct-label" for="ct-fin">A</label>
                <p-select inputId="ct-fin" [options]="horas" [(ngModel)]="fFin" appendTo="body" [filter]="true" />
              </div>
            </div>
            <span class="ct-label">Cómo</span>
            <app-segmented [options]="opcionesModo" [value]="fModo" (valueChange)="fModo = $any($event)" ariaLabel="Cómo se reúnen" />
            <label class="ct-label" for="ct-lugar">{{ fModo === 'in_person' ? 'Lugar (opcional)' : 'Liga o teléfono (opcional)' }}</label>
            <input pInputText id="ct-lugar" [(ngModel)]="fLugar" [maxlength]="limites.lugar" autocomplete="off" />
            @if (!editandoId()) {
              <div class="ct-casilla">
                <p-checkbox inputId="ct-porconf" [(ngModel)]="fPorConfirmar" [binary]="true" />
                <label for="ct-porconf">El ejecutivo todavía no confirma el horario</label>
              </div>
            }
          </fieldset>

          <fieldset class="ct-grupo">
            <legend>Temas, en el orden en que se van a tratar</legend>
            @for (t of fTemas; track $index; let k = $index) {
              <div class="ct-fila-rengl ct-fila-tema">
                <input pInputText [(ngModel)]="fTemas[k]" [maxlength]="limites.tema" [attr.aria-label]="'Tema ' + (k + 1)" autocomplete="off" />
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ct-ico" [iconOnly]="true" (click)="quitarTema(k)"
                        [attr.aria-label]="'Quitar el tema ' + (k + 1)"><i class="pi pi-times" aria-hidden="true"></i></button>
              </div>
            }
            @if (fTemas.length < limites.temas) {
              <button pButton type="button" class="p-button-sm p-button-text ct-agregar" (click)="fTemas.push('')"><span class="p-button-label">+ Agregar tema</span></button>
            }
          </fieldset>

          <fieldset class="ct-grupo">
            <legend>Quién va por Mega Dulces</legend>
            @for (p of fInternos; track $index; let k = $index) {
              <div class="ct-fila-rengl">
                <p-select [options]="personasOpciones()" [(ngModel)]="p.user_id" (onChange)="cambiarPersona(p)" optionLabel="label" optionValue="value"
                          [filter]="true" filterBy="label" placeholder="Persona" appendTo="body" [ariaLabel]="'Persona ' + (k + 1)" class="ct-persona" />
                <p-select [options]="opcionesArea" [(ngModel)]="p.area" optionLabel="label" optionValue="value" placeholder="Área" appendTo="body"
                          [ariaLabel]="'Área de la persona ' + (k + 1)" class="ct-area" />
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ct-ico" [iconOnly]="true" (click)="fInternos.splice(k, 1)"
                        [attr.aria-label]="'Quitar a la persona ' + (k + 1)"><i class="pi pi-times" aria-hidden="true"></i></button>
              </div>
            }
            <button pButton type="button" class="p-button-sm p-button-text ct-agregar" (click)="fInternos.push({ id: null, user_id: null, area: null })">
              <span class="p-button-label">+ Agregar persona</span>
            </button>
            @if (personasError()) { <p class="ct-error" role="alert">{{ personasError() }}</p> }
          </fieldset>

          <fieldset class="ct-grupo">
            <legend>Quién va por el proveedor</legend>
            @for (p of fProveedorGente; track $index; let k = $index) {
              <div class="ct-fila-rengl">
                <input pInputText [(ngModel)]="p.name" placeholder="Nombre" [maxlength]="limites.nombre" [attr.aria-label]="'Nombre de quien va por el proveedor ' + (k + 1)" autocomplete="off" />
                <input pInputText [(ngModel)]="p.job_title" placeholder="Puesto (opcional)" [maxlength]="limites.puesto" [attr.aria-label]="'Puesto ' + (k + 1)" autocomplete="off" />
                <button pButton type="button" class="p-button-sm p-button-text p-button-secondary ct-ico" [iconOnly]="true" (click)="fProveedorGente.splice(k, 1)"
                        [attr.aria-label]="'Quitar a quien va por el proveedor ' + (k + 1)"><i class="pi pi-times" aria-hidden="true"></i></button>
              </div>
            }
            <button pButton type="button" class="p-button-sm p-button-text ct-agregar" (click)="fProveedorGente.push({ id: null, name: '', job_title: '' })">
              <span class="p-button-label">+ Agregar del proveedor</span>
            </button>
          </fieldset>

          @if (falta(); as f) { <p class="ct-nota" role="status">{{ f }}</p> }
          @if (errorDlg()) { <p class="ct-error" role="alert">{{ errorDlg() }}</p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="dlg.set(false)"><span class="p-button-label">Cerrar sin guardar</span></button>
          <button pButton type="button" (click)="guardar()" [disabled]="!!falta() || guardando()">
            <span class="p-button-label">{{ guardando() ? 'Guardando…' : (editandoId() ? 'Guardar cambios' : 'Agendar') }}</span>
          </button>
        </ng-template>
      </p-dialog>

      <!-- ===== Minuta ===== -->
      <p-dialog [visible]="dlgMinuta()" (visibleChange)="dlgMinuta.set($event)" [modal]="true" [draggable]="false" [style]="{ width: 'min(38rem, 96vw)' }"
                header="Minuta de la reunión">
        <div class="ct-form">
          @if (reunionAccion(); as r) { <p class="ct-sub">{{ proveedor(r) }} · {{ diaLargo(r.date) }}, {{ horario(r) }}</p> }
          <label class="ct-label" for="ct-minuta">Qué se habló y qué se acordó</label>
          <textarea pTextarea id="ct-minuta" rows="7" [(ngModel)]="fMinuta" [maxlength]="limites.minuta"></textarea>
          <p class="ct-nota">Al guardarla, la reunión queda <strong>realizada</strong> y su minuta ya no se cambia. {{ fMinuta.length }} de {{ limites.minuta }} caracteres.</p>
          @if (errorDlg()) { <p class="ct-error" role="alert">{{ errorDlg() }}</p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="dlgMinuta.set(false)"><span class="p-button-label">Cerrar sin guardar</span></button>
          <button pButton type="button" (click)="guardarMinuta()" [disabled]="!fMinuta.trim() || guardando()">
            <span class="p-button-label">{{ guardando() ? 'Guardando…' : 'Guardar minuta' }}</span>
          </button>
        </ng-template>
      </p-dialog>

      <!-- ===== Cancelar ===== -->
      <p-dialog [visible]="dlgCancelar()" (visibleChange)="dlgCancelar.set($event)" [modal]="true" [draggable]="false" [style]="{ width: 'min(32rem, 96vw)' }"
                header="Cancelar la reunión">
        <div class="ct-form">
          @if (reunionAccion(); as r) { <p class="ct-sub">{{ proveedor(r) }} · {{ diaLargo(r.date) }}, {{ horario(r) }}</p> }
          <label class="ct-label" for="ct-motivo">Por qué se cancela</label>
          <textarea pTextarea id="ct-motivo" rows="3" [(ngModel)]="fMotivo" [maxlength]="limites.motivo"></textarea>
          <p class="ct-nota">La reunión no se borra: queda cancelada con el motivo y quién la canceló. Si se va a hacer otro día, mejor edítala.</p>
          @if (errorDlg()) { <p class="ct-error" role="alert">{{ errorDlg() }}</p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="dlgCancelar.set(false)"><span class="p-button-label">No cancelar</span></button>
          <button pButton type="button" class="ct-btn-bad-solid" (click)="guardarCancelacion()" [disabled]="!fMotivo.trim() || guardando()">
            <span class="p-button-label">{{ guardando() ? 'Cancelando…' : 'Cancelar la reunión' }}</span>
          </button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styleUrls: ['./compras-citas.component.css'],
})
export class ComprasCitasComponent implements OnInit {
  readonly tabs = PROVEEDORES_TABS;
  private readonly api = inject(CitasProveedoresService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly puedeAgendar = this.perms.has$(Permission.COMPRAS_CITAS_AGENDAR);
  readonly limites = LIMITES_REUNION;
  readonly horas = [...HORAS];

  // ── La agenda ────────────────────────────────────────────────────────────────────────────────
  readonly agenda = signal<AgendaCitas | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  /** La semana que se pide (cualquier día de ella); `null` = la de hoy. */
  private readonly semana = signal<string | null>(null);
  readonly vista = signal<Vista>('semana');
  readonly tipo = signal<FiltroTipo>('todos');
  readonly aviso = signal<string | null>(null);
  readonly errorAccion = signal<string | null>(null);
  readonly guardando = signal(false);

  private readonly deLaVista = computed(() => {
    const a = this.agenda();
    if (!a) return [] as readonly ReunionVista[];
    return this.vista() === 'semana' ? a.reuniones : a.sin_minuta.reuniones;
  });
  readonly lista = computed(() => {
    const t = this.tipo();
    return t === 'todos' ? this.deLaVista() : this.deLaVista().filter((r) => r.kind === t);
  });
  readonly vacio = computed(() => !!this.agenda() && this.deLaVista().length === 0);
  readonly vacioTitulo = computed(() => (this.vista() === 'semana' ? 'Sin reuniones en esta semana' : 'Ninguna reunión pasó sin minuta'));
  readonly vacioPista = computed(() => {
    if (this.vista() === 'sin_minuta') return 'Todas las reuniones que ya pasaron tienen su minuta o están canceladas.';
    return this.puedeAgendar() ? 'Agenda una cita con un ejecutivo, una revisión de negocio o el plan de trabajo del año.' : 'Cuando Compras, Mercadotecnia o Tesorería agenden una, aparece aquí.';
  });
  readonly respuestaTexto = computed(() => (this.agenda() ? respuesta(this.agenda()!) : ''));
  readonly rango = computed(() => (this.agenda() ? rangoSemana(this.agenda()!.semana) : ''));
  readonly esSemanaActual = computed(() => {
    const a = this.agenda();
    return !!a && a.semana.desde <= a.hoy && a.hoy <= a.semana.hasta;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const a = this.agenda();
    if (!a) return [];
    const vivas = a.reuniones.filter((r) => r.situacion !== 'cancelada').length;
    return [
      { label: this.esSemanaActual() ? 'Esta semana' : 'En la semana', value: vivas, format: 'number', drill: 'semana', drillLabel: 'Ver las reuniones de la semana' },
      { label: 'Pasaron sin minuta', value: a.sin_minuta.total, format: 'number', tone: a.sin_minuta.total ? 'warn' : 'muted', drill: 'sin_minuta', drillLabel: 'Ver las reuniones que pasaron sin minuta' },
      { label: 'Por confirmar', value: a.por_confirmar, format: 'number', tone: a.por_confirmar ? 'warn' : 'muted' },
    ];
  });

  readonly opcionesVista = computed<SegOption[]>(() => {
    const a = this.agenda();
    return [
      { label: 'Semana', value: 'semana', count: a ? a.reuniones.length : undefined },
      { label: 'Sin minuta', value: 'sin_minuta', count: a ? a.sin_minuta.total : undefined },
    ];
  });
  readonly opcionesTipo = computed<SegOption[]>(() => {
    const l = this.deLaVista();
    return [
      { label: 'Todas', value: 'todos', count: l.length },
      ...TIPOS_REUNION.map((t) => ({ label: ETIQUETA_TIPO_REUNION[t], value: t, count: l.filter((r) => r.kind === t).length })),
    ];
  });

  // ── El detalle ───────────────────────────────────────────────────────────────────────────────
  readonly abierta = signal<DetalleReunion | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);

  // ── El formulario ────────────────────────────────────────────────────────────────────────────
  readonly dlg = signal(false);
  readonly editandoId = signal<string | null>(null);
  readonly errorDlg = signal<string | null>(null);
  readonly sugerencias = signal<(ProveedorCitas & { etiqueta: string })[]>([]);
  private readonly personas = signal<readonly PersonaCitas[]>([]);
  readonly personasError = signal<string | null>(null);
  readonly personasOpciones = computed(() => this.personas().map((p) => ({ label: p.nombre, value: p.user_id })));
  readonly anios = computed(() => aniosDelPlan(this.agenda()?.hoy ?? fechaIso(new Date())));
  readonly opcionesTipoForm: SegOption[] = TIPOS_REUNION.map((t) => ({ label: ETIQUETA_TIPO_REUNION[t], value: t }));
  readonly opcionesModo: SegOption[] = MODALIDADES_REUNION.map((m) => ({ label: ETIQUETA_MODALIDAD_REUNION[m], value: m }));
  readonly opcionesArea = AREAS_PARTICIPANTE.map((a) => ({ label: ETIQUETA_AREA_PARTICIPANTE[a], value: a }));

  fProveedor: (ProveedorCitas & { etiqueta: string }) | null = null;
  fTipo: TipoReunion = 'executive';
  fAnio: number | null = null;
  fFecha: Date | null = null;
  fInicio = '10:00';
  fFin = '11:00';
  fModo: ModalidadReunion = 'in_person';
  fLugar = '';
  fPorConfirmar = false;
  fTemas: string[] = [];
  fInternos: FilaInterna[] = [];
  fProveedorGente: FilaProveedor[] = [];

  // ── Minuta y cancelación ─────────────────────────────────────────────────────────────────────
  readonly dlgMinuta = signal(false);
  readonly dlgCancelar = signal(false);
  readonly reunionAccion = signal<ReunionVista | null>(null);
  fMinuta = '';
  fMotivo = '';

  // ── Lo que la plantilla pone en palabras ─────────────────────────────────────────────────────
  readonly diaCorto = diaCorto;
  readonly diaLargo = diaLargo;
  readonly horario = horario;
  readonly quienVa = quienVa;
  readonly proveedor = proveedorEnPalabras;
  readonly lugar = lugarEnPalabras;
  readonly tipoTexto = tipoEnPalabras;
  readonly areaTexto = areaEnPalabras;
  readonly choque = choqueEnPalabras;
  etiqueta = (s: SituacionReunion) => ETIQUETA_SITUACION_REUNION[s];
  severidad = (s: SituacionReunion) => SEVERIDAD_SITUACION[s];
  rel = (fecha: string) => relativo(fecha, this.agenda()?.hoy ?? fecha);
  esPrimera = (i: number) => primeraDelDia(this.lista(), i);
  puede = (r: ReunionVista, a: AccionReunion) => r.acciones.indexOf(a) >= 0;

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.agenda(this.semana()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => { this.agenda.set(a); this.cargando.set(false); this.cargadoEn.set(new Date()); },
      error: (e) => { this.error.set(motivoHttp(e, 'leer la agenda de citas')); this.cargando.set(false); },
    });
  }

  irAVista(v: string): void {
    if (v === 'semana' || v === 'sin_minuta') this.vista.set(v);
  }

  moverSemana(dias: number): void {
    const a = this.agenda();
    if (!a) return;
    this.irASemana(sumarDiasIso(a.semana.desde, dias));
  }

  irASemana(fecha: string | null): void {
    this.semana.set(fecha);
    this.vista.set('semana');
    this.cargar();
  }

  abrir(id: string): void {
    this.abierta.set(null);
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.api.detalle(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.abierta.set(d); this.cargandoDetalle.set(false); },
      error: (e) => { this.errorDetalle.set(motivoHttp(e, 'abrir la reunión')); this.cargandoDetalle.set(false); },
    });
  }

  cerrar(): void {
    this.abierta.set(null);
    this.cargandoDetalle.set(false);
    this.errorDetalle.set(null);
  }

  /** Después de escribir: la agenda otra vez y, si había un detalle abierto, ése también. */
  private recargar(mensaje: string): void {
    this.aviso.set(mensaje);
    this.cargar();
    const abierta = this.abierta()?.reunion.id;
    if (abierta) this.abrir(abierta);
  }

  // ── Agendar / editar ─────────────────────────────────────────────────────────────────────────
  private cargarPersonas(): void {
    if (this.personas().length) return;
    this.personasError.set(null);
    this.api.opciones().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (o) => {
        this.personas.set(o.personas);
        // Al agendar, quien agenda va propuesto (con el área de su puesto), si ve la agenda.
        const yo = this.auth.user()?.sub;
        const mia = o.personas.find((p) => p.user_id === yo);
        if (!this.editandoId() && mia && !this.fInternos.some((f) => f.user_id)) this.fInternos = [{ id: null, user_id: mia.user_id, area: mia.area }];
      },
      error: (e) => this.personasError.set(motivoHttp(e, 'leer quién puede ir a la reunión')),
    });
  }

  abrirNueva(): void {
    this.editandoId.set(null);
    this.errorDlg.set(null);
    this.fProveedor = null;
    this.fTipo = 'executive';
    this.fAnio = null;
    this.fFecha = null;
    this.fInicio = '10:00';
    this.fFin = '11:00';
    this.fModo = 'in_person';
    this.fLugar = '';
    this.fPorConfirmar = false;
    this.fTemas = [''];
    this.fInternos = [{ id: null, user_id: null, area: null }];
    this.fProveedorGente = [{ id: null, name: '', job_title: '' }];
    const yo = this.auth.user()?.sub;
    const mia = this.personas().find((p) => p.user_id === yo);
    if (mia) this.fInternos = [{ id: null, user_id: mia.user_id, area: mia.area }];
    this.cargarPersonas();
    this.dlg.set(true);
  }

  abrirEditar(r: ReunionVista): void {
    const dto = dtoDeReunion(r);
    this.editandoId.set(r.id);
    this.errorDlg.set(null);
    this.fProveedor = { code: r.supplier_code, name: r.supplier_name, etiqueta: this.etiquetaProveedor({ code: r.supplier_code, name: r.supplier_name }) };
    this.fTipo = r.kind;
    this.fAnio = r.work_plan_year;
    this.fFecha = fechaDeIso(r.date);
    this.fInicio = r.start_time;
    this.fFin = r.end_time;
    this.fModo = r.mode;
    this.fLugar = r.location ?? '';
    this.fTemas = [...(dto.topics ?? [])];
    this.fInternos = dto.participants.filter((p) => p.side === 'internal')
      .map((p) => ({ id: p.id ?? null, user_id: p.user_id ?? null, area: (p.area ?? null) as AreaParticipante | null }));
    this.fProveedorGente = dto.participants.filter((p) => p.side === 'supplier')
      .map((p) => ({ id: p.id ?? null, name: p.name ?? '', job_title: p.job_title ?? '' }));
    this.cargarPersonas();
    this.dlg.set(true);
  }

  private etiquetaProveedor(p: ProveedorCitas): string {
    return p.name ? `${p.name} · ${p.code}` : `Clave ${p.code}`;
  }

  buscarProveedor(e: AutoCompleteCompleteEvent): void {
    this.api.proveedores(e.query).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.sugerencias.set(r.proveedores.map((p) => ({ ...p, etiqueta: this.etiquetaProveedor(p) }))),
      error: () => this.sugerencias.set([]),
    });
  }

  cambiarTipo(t: string): void {
    this.fTipo = t as TipoReunion;
    if (this.fTipo === 'work_plan' && !this.fAnio) this.fAnio = this.anios()[1] ?? null;
    if (this.fTipo !== 'work_plan') this.fAnio = null;
  }

  cambiarInicio(): void {
    if (!this.fFin || this.fFin <= this.fInicio) this.fFin = finSugerido(this.fInicio);
  }

  cambiarPersona(p: FilaInterna): void {
    const persona = this.personas().find((x) => x.user_id === p.user_id);
    if (persona?.area) p.area = persona.area;
  }

  quitarTema(k: number): void {
    this.fTemas.splice(k, 1);
  }

  private dto(): AgendarReunionDto {
    return {
      supplier_code: this.fProveedor?.code ?? '',
      kind: this.fTipo,
      ...(this.editandoId() ? {} : { status: this.fPorConfirmar ? 'to_confirm' as const : 'scheduled' as const }),
      date: this.fFecha ? fechaIso(this.fFecha) : '',
      start_time: this.fInicio,
      end_time: this.fFin,
      mode: this.fModo,
      location: this.fLugar.trim() || null,
      topics: this.fTemas.map((t) => t.trim()).filter(Boolean),
      work_plan_year: this.fTipo === 'work_plan' ? this.fAnio : null,
      // Un renglón NUEVO que nadie llenó no cuenta (el diálogo abre con uno vacío del proveedor, y muchas veces no se sabe
      // quién viene): no se manda ni frena el guardado. Uno a medias sí se revisa, y uno que ya estaba guardado también.
      participants: [
        ...this.fInternos.filter((p) => p.id || p.user_id || p.area)
          .map((p) => ({ id: p.id, side: 'internal' as const, user_id: p.user_id, area: p.area })),
        ...this.fProveedorGente.filter((p) => p.id || p.name.trim() || p.job_title.trim())
          .map((p) => ({ id: p.id, side: 'supplier' as const, name: p.name, job_title: p.job_title.trim() || null })),
      ],
    };
  }

  falta(): string | null {
    return faltaParaGuardar(this.dto());
  }

  guardar(): void {
    if (this.falta() || this.guardando()) return;
    const id = this.editandoId();
    this.guardando.set(true);
    this.errorDlg.set(null);
    const peticion = id ? this.api.editar(id, this.dto()) : this.api.agendar(this.dto());
    peticion.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (g) => {
        this.guardando.set(false);
        this.dlg.set(false);
        const base = id ? 'Cambios guardados.' : 'Reunión agendada.';
        this.recargar(g.choques.length ? `${base} Ojo: ${g.choques.map(choqueEnPalabras).join(' ')}` : base);
      },
      error: (e) => { this.guardando.set(false); this.errorDlg.set(motivoHttp(e, id ? 'guardar los cambios' : 'agendar la reunión')); },
    });
  }

  confirmar(r: ReunionVista): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.errorAccion.set(null);
    this.api.confirmar(r.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.recargar(`La reunión con ${proveedorEnPalabras(r)} quedó agendada.`); },
      error: (e) => { this.guardando.set(false); this.errorAccion.set(motivoHttp(e, 'confirmar la reunión')); },
    });
  }

  abrirMinuta(r: ReunionVista): void {
    this.reunionAccion.set(r);
    this.fMinuta = '';
    this.errorDlg.set(null);
    this.dlgMinuta.set(true);
  }

  guardarMinuta(): void {
    const r = this.reunionAccion();
    if (!r || !this.fMinuta.trim() || this.guardando()) return;
    this.guardando.set(true);
    this.errorDlg.set(null);
    this.api.minuta(r.id, this.fMinuta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.dlgMinuta.set(false); this.recargar(`Minuta guardada: la reunión con ${proveedorEnPalabras(r)} quedó realizada.`); },
      error: (e) => { this.guardando.set(false); this.errorDlg.set(motivoHttp(e, 'guardar la minuta')); },
    });
  }

  abrirCancelar(r: ReunionVista): void {
    this.reunionAccion.set(r);
    this.fMotivo = '';
    this.errorDlg.set(null);
    this.dlgCancelar.set(true);
  }

  guardarCancelacion(): void {
    const r = this.reunionAccion();
    if (!r || !this.fMotivo.trim() || this.guardando()) return;
    this.guardando.set(true);
    this.errorDlg.set(null);
    this.api.cancelar(r.id, this.fMotivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.dlgCancelar.set(false); this.recargar(`La reunión con ${proveedorEnPalabras(r)} quedó cancelada.`); },
      error: (e) => { this.guardando.set(false); this.errorDlg.set(motivoHttp(e, 'cancelar la reunión')); },
    });
  }
}
