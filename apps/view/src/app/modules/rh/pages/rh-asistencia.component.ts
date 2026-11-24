import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { Popover, PopoverModule } from 'primeng/popover';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrCatalogosFichaDto, HrFichaPersonaDto, HrIncidenciaDto, HrPersonaAsistencia, HrSinPlazasDto, HrTipoIncidenciaDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAvisosSemanaComponent, RhFiltrosComponent } from '../components/rh-semana-barra.component';
import { RhReporteSemanalComponent } from '../components/rh-reporte-semanal.component';
import { RhPersonaDiasComponent } from '../components/rh-persona-dias.component';
import { RhExpedienteFirmasComponent } from '../components/rh-expediente-firmas.component';
import { RhCapturaIncidenciaComponent } from '../components/rh-captura-incidencia.component';
import { type FormCaptura, aliasDelDia, contextoDelDia, formDelDia, sugerenciasDelDia } from '../incidencia-captura';
import { RhFaltasComponent } from './rh-faltas.component';
import { RhToleranciaComponent } from './rh-tolerancia.component';
import { RhIncidenciasComponent } from './rh-incidencias.component';
import { RhRelojesComponent } from './rh-relojes.component';
import { RhNombresPorConfirmarComponent } from '../components/rh-nombres-por-confirmar.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, fechaCorta, rhError, sumarDias } from '../rh.service';
import {
  GRUPOS_INCIDENCIA, type Irregularidad, columnasDelRango, cuentaIrregular, departamentoDe, diaLargo, diasPorFecha, difHorario, etiquetaParcial, firmaHoras,
  hora12, horarioDe, horasTexto, irregularidadesDe, porDepartamento, SIN_DEPARTAMENTO,
} from '../reporte-formato';
import { cubiertas, haySeleccion, personaUnica } from '../personas-seleccion';
import { type ContextoExport, exportarPdfPersona, exportarPdfPlaza } from '../rh-exportar';

interface TurnoForm { entrada: string; salida: string; comida: number; }
/** `[RH.6.3]` Hasta 4 horarios (mañana, tarde…): cada día se mide contra el más cercano a su entrada. El sábado es uno. */
interface FormHorario { turnos: TurnoForm[]; sabado: boolean; sabadoEntrada: string; sabadoSalida: string; }
const MAX_HORARIOS = 4;
/** `[RH.7.1]` La ficha de la persona en la plaza, mientras RH la edita. `[RH.14.5]` Más lo de la persona (sin acceso). */
interface FormFicha { codigo: string; nombre: string; seccion: string; promotora: boolean; departamento: string | null; puesto: string | null; sucursal: string | null; }

/**
 * Fase RH · `[RH.1.7c]` — Checadas (`/rh/asistencia`): el reporte semanal «calcado» de Mega Talento. Una fila por
 * persona y una columna por día, por departamento; la fila abre la ficha (encima, de lado) donde se justifica, se
 * asigna horario y se imprime lo de esa persona. El número sale del servidor (la regla trasladada); aquí no se
 * recalcula nada.
 */
@Component({
  selector: 'app-rh-asistencia',
  standalone: true,
  imports: [
    NgTemplateOutlet, FormsModule, ButtonModule, InputTextModule, SelectModule, PopoverModule, LoadStateComponent, SidePeekComponent,
    RhMarcoComponent, RhFiltrosComponent, RhAvisosSemanaComponent, RhReporteSemanalComponent, RhPersonaDiasComponent, RhExpedienteFirmasComponent, RhCapturaIncidenciaComponent,
    RhFaltasComponent, RhToleranciaComponent, RhIncidenciasComponent, RhRelojesComponent, RhNombresPorConfirmarComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ra-page">
      <app-rh-marco [barra]="true" [enLinea]="true" />
      <!-- Sin plazas el marco lo declara: aquí no se pinta «nadie» ni ceros de algo que nadie midió. -->
      @if (!est.sinPlazas()) {

      <!-- [RH.13.5] Faltas y Tolerancia eran pestañas: son la MISMA semana vista de otra forma. Su cifra sólo sale
           cuando hay datos (sin datos no hay «0 faltas», hay «no medido»). -->
      <!-- [RH.13.5] Un solo renglón: qué ver, cuántos y quién tiene algo que revisar, y las acciones del reporte. Antes eran
           cuatro (modo, título que repetía plaza y semana, irregularidades y leyenda) y la primera persona salía al 76 % del alto. -->
      <div class="ra-barra">
        <div class="ra-ver" role="group" aria-label="Qué ver de la semana">
          <button type="button" [attr.aria-pressed]="ver() === 'semana'" (click)="irAVer('semana')">Semana</button>
          <button type="button" [attr.aria-pressed]="ver() === 'faltas'" (click)="irAVer('faltas')">
            Faltas@if (est.datos()) {&ngsp;<b class="ra-ver-n">{{ est.nFaltas() }}</b> }
          </button>
          <button type="button" [attr.aria-pressed]="ver() === 'tolerancia'" (click)="irAVer('tolerancia')">
            Tolerancia@if (est.datos() && est.nRebasados() !== null) {&ngsp;<b class="ra-ver-n">{{ est.nRebasados() }}</b> }
          </button>
        </div>
        @if (ver() === 'semana' && !unica() && est.datos() && !vacio()) {
          <p class="ra-resumen">
            <span>{{ visibles().length }} persona{{ visibles().length === 1 ? '' : 's' }}@if (est.soloPromotoras()) { de promotoría }</span>
            @if (parcial()) { <span class="ra-parcial">· {{ parcial() }}</span> }
            @if (nIrregulares()) {
              <span class="ra-irr"><span class="ra-irr-dot" aria-hidden="true"></span><b>{{ nIrregulares() }}</b>&ngsp;con irregularidades, en rojo</span>
              <button type="button" class="ra-chip" [attr.aria-pressed]="est.soloIrregulares()" (click)="est.soloIrregulares.set(!est.soloIrregulares())">
                {{ est.soloIrregulares() ? 'Ver a todos' : 'Solo irregulares' }}
              </button>
            }
            <app-rh-avisos-semana />
          </p>
        } @else {
          <p class="ra-resumen"><app-rh-avisos-semana class="solo" /></p>
        }
        <!-- [RH.18.11] «Filtros» siempre a la vista (también vacío o en Faltas): si filtra, se tiene que poder quitar. -->
        <div class="ra-rep-acc">
          <app-rh-filtros [personas]="true" />
          @if (ver() === 'semana' && !unica() && est.datos() && !vacio()) {
            @if (puedeGestionar()) {
              <p-button label="Horario" icon="pi pi-clock" ariaLabel="Horario" styleClass="ra-icono-chico" severity="secondary" [outlined]="true" (onClick)="abrirHorario(null)" />
            }
            <!-- [RH.13.5] Sólo el PDF para firmar (David, 13-nov: sin Excel). Una sola salida no necesita menú. Sale lo que se ve:
                 si hay filtro, el resumen de la izquierda ya lo dice («solo SISTEMAS»). -->
            <p-button label="PDF para firmar" icon="pi pi-file-pdf" ariaLabel="PDF para firmar" styleClass="ra-icono-chico" severity="secondary" [outlined]="true" [loading]="exportando()" [disabled]="est.loading()" (onClick)="pdfPlaza()" />
          }
        </div>
      </div>

      @switch (ver()) {
        @case ('faltas') { <app-rh-faltas [embebido]="true" /> }
        @case ('tolerancia') { <app-rh-tolerancia [embebido]="true" /> }
        @default {

      <app-load-state [loading]="est.loading() && !est.datos()" [error]="est.error()" [isEmpty]="vacio()"
                      emptyIcon="pi-users" [emptyTitle]="vacioTitulo()" emptyHint="Revisa en la franja de relojes que el reloj de la plaza esté mandando checadas."
                      (retry)="est.asegurar(true)">
        @if (unica(); as p) {
          <section class="ra-rep" aria-label="Asistencia de una persona">
            <div class="ra-rep-head">
              <div>
                <h2>{{ p.nombreCompleto || p.nombre }}</h2>
                <p>#{{ p.codigo }} · {{ depto(p) }} · {{ est.nombreSitio() }} · {{ periodoTexto() }} <span class="ra-parcial">· solo esta persona</span></p>
              </div>
              <div class="ra-rep-acc">
                <p-button label="Ver a todos" [text]="true" severity="secondary" (onClick)="est.verATodos()" />
                <p-button label="PDF para firmar" icon="pi pi-file-pdf" severity="secondary" [outlined]="true" [loading]="exportando()" (onClick)="pdfPersona(p)" />
              </div>
            </div>
            <div class="ra-una">
              <ng-container *ngTemplateOutlet="tiraHorario; context: { $implicit: p }" />
              @if (form() && destino()?.codigo === p.codigo) {
                <ng-container *ngTemplateOutlet="formHorario; context: { $implicit: p }" />
              }
              @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
              <app-rh-persona-dias [persona]="p" [columnas]="columnas()" [hoy]="est.hoy()" [mideRetardo]="mide()" />
              <!-- [RH.15.11] Sus firmas de la semana (celular o papel). Ligado a su persona: las de todas sus plazas.
                   [RH.18.12] Vienen de la ficha: aquí está todo lo de UNA persona (sus días, el registro para la autoridad y el PDF). -->
              @if (p.userId) {
                <app-rh-expediente-firmas [userId]="p.userId" />
              } @else if (est.sitio(); as site) {
                <app-rh-expediente-firmas [site]="site" [persona]="p.codigo" />
              }
            </div>
          </section>
        } @else {
          <section class="ra-rep" [attr.aria-label]="'Asistencia de ' + est.nombreSitio() + ', ' + periodoTexto()">
            @if (form() && !destino()) {
              <ng-container *ngTemplateOutlet="formHorario; context: { $implicit: null }" />
            }
            @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
            <!-- [RH.14.1] Con la baja se quedó sin ninguna plaza: se propone archivarla también como persona (nunca solo). -->
            @if (sinPlazas(); as s) {
              <div class="ra-banner ra-sinplazas" role="note">
                <span>{{ s.nombre || 'Sin nombre' }} quedó sin plazas{{ s.archivable ? '.' : ' · cuenta con acceso: la baja es de Sistemas.' }}</span>
                @if (s.archivable && puedeEditarFicha()) {
                  <p-button label="Archivar" severity="danger" [outlined]="true" size="small" [loading]="guardando()" (onClick)="archivar(s)" />
                }
                <p-button label="Ahora no" [text]="true" severity="secondary" size="small" (onClick)="sinPlazas.set(null)" />
              </div>
            }
            @if (filas().length) {
              <app-rh-reporte-semanal [grupos]="grupos()" [todas]="todas()" [columnas]="columnas()" [irregularidades]="irr()" [hoy]="est.hoy()"
                                      [mideRetardo]="mide()" [parcial]="!!parcial()" [subtotales]="conSubtotales()" [saldos]="est.saldosHE()"
                                      [capturable]="puedeCapturar()" [pendientes]="est.pendientesLista()" [etiquetas]="etiquetasInc()"
                                      [destello]="destello()" (abrir)="abrir($event)" (capturarDia)="capturarEnTabla($event)" />
              <!-- La leyenda, al pie y en palabras: cada color dice lo que significa; toca a una persona para ver su semana. -->
              <p class="ra-ley">
                @if (mide()) { <span><b class="ra-ley-rojo">En rojo</b>, la entrada tarde y la falta.</span> }
                @else { <span>En esta plaza no se mide retardo: cada quien entra en su turno.</span> }
                <span class="ra-ley-dc"><b class="ra-ley-ambar">D</b> desayuno y <b class="ra-ley-ambar">C</b> comida salen sólo si se pasó, con sus minutos.</span>
                <!-- [RH.18.7] El color de cada bloque de incidencia, con su nombre (Q.6: el color nunca va solo). -->
                @for (g of gruposInc; track g.grupo) { <span class="ra-ley-g"><i class="ra-ley-mu" [attr.data-g]="g.grupo"></i>{{ g.nombre }}</span> }
                <span class="ra-ley-g"><i class="ra-ley-mu pend"></i>punteado = por calificar</span>
                <span>Toca a una persona para ver su semana día por día.</span>
              </p>
            } @else {
              <p class="ra-vacio">{{ sinFilas() }}</p>
            }
          </section>
        }
      </app-load-state>
        }
      }
      }


      <app-side-peek [open]="!!sel()" (openChange)="cambioFicha($event)" [width]="720" [title]="fichaTitulo()" [subtitle]="fichaSub()">
        @if (sel(); as p) {
          <div class="ra-ficha">
            <div class="ra-nums">
              <div [class.bad]="mide() && p.atrasoBrutoMin > 0"><b>{{ mide() ? p.atrasoBrutoMin : '—' }}</b><span>min tarde</span></div>
              <div [class.bad]="p.retardoRealMin > 0"><b>{{ mide() ? p.retardoRealMin : '—' }}</b><span>excede la tolerancia</span></div>
              <div [class.bad]="faltasDe(p) > 0"><b>{{ faltasDe(p) }}</b><span>falta{{ faltasDe(p) === 1 ? '' : 's' }}@if (p.faltasJustificadas) { (+{{ p.faltasJustificadas }} justificadas) }</span></div>
              <div><b>{{ horas(p.minutosTrabajados) }}</b><span>trabajadas@if (p.horarioAsignado) { · {{ firma(dif(p)) }} vs. horario }</span></div>
            </div>

            @if (irrDe(p).length) {
              <ul class="ra-irr-lista" aria-label="Irregularidades">
                @for (i of irrDe(p); track $index) {
                  <li><span class="pill" [attr.data-t]="i.nivel === 'alta' && i.tipo !== 'tolerancia' ? 'bad' : 'warn'">{{ diaLargo(i.fecha) }}</span> {{ i.texto }}</li>
                }
              </ul>
            }
            @if (p.marcas.length) {
              <details class="ra-marcas">
                <summary>Por qué su número puede no servir ({{ p.marcas.length }})</summary>
                <ul>
                  @for (m of p.marcas; track m.codigo) {
                    <li><span class="pill" [attr.data-t]="m.gravedad === 'alta' ? 'bad' : m.gravedad === 'media' ? 'warn' : 'info'">{{ gravedadLabel[m.gravedad] }}</span> {{ m.detalle }}</li>
                  }
                </ul>
              </details>
            }

            <ng-container *ngTemplateOutlet="tiraHorario; context: { $implicit: p }" />
            @if (form() && destino()?.codigo === p.codigo) {
              <ng-container *ngTemplateOutlet="formHorario; context: { $implicit: p }" />
            }

            <!-- [RH.14.3] El número y el nombre de cada reloj junto al de la Suite, y alinearlos aquí. [RH.14] Sin párrafos:
                 Edgar (18-nov) pidió botones sin explicación alrededor. -->
            @if (fichaDet(); as fd) {
              <div class="ra-reloj">
                <p class="ra-reloj-t">Reloj</p>
                <ul>
                  @for (r of fd.relojes; track r.serial_number) {
                    <li><span class="mono">#{{ r.device_user_id }}</span> {{ r.nombre_reloj || '—' }} <small>{{ r.device_label || r.serial_number }}</small></li>
                  } @empty { <li>—</li> }
                </ul>
                @if (puedeEditarFicha() && relojDistinto(fd)) {
                  <p-button label="Actualizar en el reloj" icon="pi pi-sync" severity="secondary" [outlined]="true" size="small"
                            [ariaLabel]="'Poner ' + fd.nombre_para_reloj + ' en el reloj'" [loading]="guardando()" (onClick)="ponerEnReloj(p, fd)" />
                }
              </div>
              @if (fd.nombre_por_confirmar) {
                <div class="ra-tira ra-confirmar">
                  <p><b>Nombre por confirmar</b></p>
                  @if (puedeEditarFicha() && fichaForm()?.codigo !== p.codigo) { <p-button label="Corregir" size="small" (onClick)="abrirFicha(p)" /> }
                </div>
              }
            } @else if (fichaDetError()) {
              <p class="ra-form-nota">No se pudo leer el reloj.</p>
            }

            <!-- [RH.7.1] Su ficha en esta plaza: lo que agrupa el reporte y lo que exige el cierre semanal. -->
            <!-- [RH.20.1] (David, 24-nov: «a todos se les pueda modificar aunque no estén en la Suite») La ficha se edita
                 también sin ligar: al guardar, el servidor la da de alta sin acceso. La baja sigue pidiendo persona. -->
            @if (!p.registrado && puedeEditarFicha()) {
              <p class="ra-form-nota" role="note">Todavía no está en la Suite: al guardar su ficha se da de alta, sin acceso.</p>
            }
            <div class="ra-tira">
                <p>Sección <b [class.ra-falta]="depto(p) === sinDepartamento">{{ depto(p) === sinDepartamento ? 'sin sección' : depto(p) }}</b>
                  · {{ est.soloPromotoras() ? 'promotora' : 'planta' }}
                  @if (fichaDet(); as fd) {
                    <br />{{ nombreDe(catalogos()?.departamentos, fd.departamento_code, 'sin departamento') }} · {{ nombreDe(catalogos()?.puestos, fd.puesto_code, 'sin puesto') }}
                    · {{ nombreDe(catalogos()?.sucursales, fd.sucursal_code, 'sin sucursal') }}@if (fd.zona_nombre) { ({{ fd.zona_nombre }}) }
                    @if (fd.con_acceso) { <small class="ra-acceso">con acceso a la Suite</small> }
                  }</p>
                @if (puedeEditarFicha()) { <p-button label="Editar" severity="secondary" [outlined]="true" size="small" (onClick)="abrirFicha(p)" /> }
              </div>
              <!-- [RH.7.2] Baja en ESTA plaza, separada de lo diario y con motivo (Von Restorff): se deshace en Bajas. -->
              @if (puedeEditarFicha() && p.registrado) {
                @if (bajaDe() === p.codigo) {
                  <form class="ra-form ra-baja" (ngSubmit)="darDeBaja(p)" aria-label="Dar de baja en esta plaza">
                    <label class="ra-ancho">Motivo
                      <input pInputText name="bmot" [ngModel]="motivoBaja()" (ngModelChange)="motivoBaja.set($event)" required /></label>
                    <div class="ra-form-btns">
                      <p-button type="submit" label="Dar de baja" severity="danger" [disabled]="motivoBaja().trim().length < 5" [loading]="guardando()" />
                      <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="bajaDe.set(null)" />
                    </div>
                  </form>
                } @else {
                  <div class="ra-baja-lnk">
                    <p-button label="Dar de baja" icon="pi pi-user-minus" [text]="true" severity="danger" size="small" (onClick)="abrirBaja(p)" />
                  </div>
                }
              }
              @if (fichaForm(); as ff) {
                @if (ff.codigo === p.codigo) {
                  <form class="ra-form" (ngSubmit)="guardarFicha(p)" aria-label="Editar la ficha en esta plaza">
                    <!-- [RH.14.4] El nombre, a cualquiera (con o sin acceso a la Suite). -->
                    <label class="ra-ancho">Nombre completo <input pInputText name="fnom" [(ngModel)]="ff.nombre" required placeholder="Nombre y apellidos" /></label>
                    <label>Sección del reporte
                      <p-select [options]="seccionesConocidas()" [editable]="true" name="fsec" [(ngModel)]="ff.seccion" appendTo="body"
                                placeholder="Elige o escribe" ariaLabel="Sección del reporte de RH" />
                    </label>
                    <label class="ra-check"><input type="checkbox" name="fpro" [(ngModel)]="ff.promotora" /> Es promotora de marca</label>
                    <!-- [RH.14.5] Lo de la persona (no de la plaza), sólo sin acceso: la zona sale de la sucursal. -->
                    @if (fichaDet() && !fichaDet()!.con_acceso) {
                      @if (catalogos(); as cat) {
                        <label>Departamento
                          <p-select [options]="cat.departamentos" optionLabel="name" optionValue="code" name="fdep" [(ngModel)]="ff.departamento" [showClear]="true"
                                    [filter]="true" filterBy="name" appendTo="body" placeholder="Sin departamento" ariaLabel="Departamento" />
                        </label>
                        <label>Puesto
                          <p-select [options]="puestosDe(cat, ff.departamento)" optionLabel="name" optionValue="code" name="fpue" [(ngModel)]="ff.puesto" [showClear]="true"
                                    [filter]="true" filterBy="name" appendTo="body" placeholder="Sin puesto" ariaLabel="Puesto" />
                        </label>
                        <label>Sucursal
                          <p-select [options]="cat.sucursales" optionLabel="name" optionValue="code" name="fsuc" [(ngModel)]="ff.sucursal" [showClear]="true"
                                    [filter]="true" filterBy="name" appendTo="body" placeholder="Sin sucursal" ariaLabel="Sucursal" />
                        </label>
                      } @else if (catalogosError()) {
                        <p class="ra-form-nota">No se pudo cargar departamento, puesto y sucursal.</p>
                      } @else {
                        <p class="ra-form-nota">Cargando…</p>
                      }
                    } @else if (fichaDet()?.con_acceso) {
                      <!-- [RH.18.2] (E2) Antes los tres campos desaparecían sin decir por qué. Con acceso, la sucursal y la zona definen lo
                           que la persona ve en la Suite: eso es de Sistemas (D2 de Edgar). El nombre sí lo corrige RH. -->
                      <p class="ra-form-nota ra-ancho ra-bloqueado" role="note">
                        <i class="pi pi-lock" aria-hidden="true"></i>
                        Tiene acceso a la Suite: su departamento, puesto y sucursal deciden lo que ve, por eso los cambia Sistemas en Administración › Personas.
                        @if (puedeVerPersonas()) { <a class="ra-ir" href="/admin/users" (click)="irAPersonas($event)">Abrir Personas</a> }
                      </p>
                    }
                    <div class="ra-form-btns">
                      <p-button type="submit" label="Guardar" [loading]="guardando()" />
                      <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="fichaForm.set(null)" />
                    </div>
                  </form>
                }
              }
            @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }

            <!-- [RH.18.10] (David, 23-nov) La ficha ya no repite la semana día por día: eso se ve (y se captura) en la tabla de
                 la semana. [RH.18.12] (David, 24-nov: «esto quítalo») Tampoco trae el registro para la autoridad, el PDF ni sus
                 firmas: los tres viven en «Ver solo a esta persona», que es la puerta que se queda. -->
            <div class="ra-acciones">
              <p-button label="Ver solo a esta persona" severity="secondary" [outlined]="true" size="small" (onClick)="soloEsta(p)" />
            </div>
          </div>
        }
      </app-side-peek>

      <!-- [RH.18.4] Desde la tabla de la semana: la captura en un globo sobre la celda del día, sin salir de la tabla. -->
      <p-popover #capPop appendTo="body" ariaLabel="Levantar incidencia" (onHide)="alCerrarGlobo()">
        @if (captura(); as c) {
          @if (c.origen === 'tabla') {
            <div class="ra-globo">
              <app-rh-captura-incidencia [(form)]="capturaForm" [site]="est.sitio()" [tipos]="tiposInc()" [sugeridos]="c.sugeridos" [alias]="c.alias"
                                         [persona]="c.nombre" [titulo]="'Incidencia del ' + diaLargo(c.fecha)"
                                         [deLoChecado]="c.deLoChecado" [contexto]="c.contexto" [puedeCalificar]="puedeCalificar()"
                                         (guardada)="capturaGuardada($event)" (cancelada)="cerrarGlobo()" />
            </div>
          }
        }
      </p-popover>

      <!-- [RH.13.5] Incidencias y Relojes eran pestañas con su página: son trabajo SOBRE esta semana y esta plaza, así que
           se abren encima, sin salir. La URL dice cuál está abierto (?panel=): un enlace o un aviso lo abre igual. -->
      <app-side-peek [open]="panel() === 'incidencias'" (openChange)="!$event && cerrarPanel()" [width]="1040"
                     title="Incidencias y cierre de semana" [subtitle]="est.nombreSitio()">
        @if (panel() === 'incidencias') { <app-rh-incidencias [embebido]="true" /> }
      </app-side-peek>
      <app-side-peek [open]="panel() === 'relojes'" (openChange)="!$event && cerrarPanel()" [width]="1040"
                     title="Relojes checadores" subtitle="Todas las plazas">
        @if (panel() === 'relojes') { <app-rh-relojes [embebido]="true" /> }
      </app-side-peek>
      <!-- [RH.14.4] Los nombres que son el apodo del reloj: se corrigen aquí, sin salir de Asistencia. -->
      <app-side-peek [open]="panel() === 'nombres'" (openChange)="!$event && cerrarPanel()" [width]="760"
                     title="Nombres por confirmar" [subtitle]="est.nombreSitio()">
        @if (panel() === 'nombres') {
          <app-rh-nombres-por-confirmar [sitio]="est.sitio()" [puedeEditar]="puedeEditarFicha()" (cambio)="est.refrescarNombres(); est.asegurar(true)" />
        }
      </app-side-peek>
    </div>

    <ng-template #tiraHorario let-p>
      <div class="ra-tira">
        @if (p.horarioAsignado; as h) {
          @if (h.horarios.length > 1) {
            <p>Horarios:
              @for (x of h.horarios; track x.entrada; let ultimo = $last) { {{ h12(x.entrada) }} a {{ h12(x.salida) }} · comida {{ x.comidaMin }} min{{ ultimo ? '' : ';' }} }
              {{ h.sabado ? ' · sábado' : '' }}</p>
          } @else {
            <p>Horario: {{ h12(h.entrada) }} a {{ h12(h.salida) }} · comida {{ h.comidaMin }} min{{ h.sabado ? ' · sábado' : '' }}</p>
          }
          @if (puedeGestionar()) {
            <p-button label="Cambiar" severity="secondary" [outlined]="true" size="small" (onClick)="abrirHorario(p)" />
            <p-button label="Quitar" [text]="true" size="small" [loading]="guardando()" (onClick)="quitarHorario(p)" />
          }
        } @else {
          <p>Horario deducido: {{ horarioTexto(p) }}</p>
          @if (puedeGestionar()) { <p-button label="Asignar" severity="secondary" [outlined]="true" size="small" (onClick)="abrirHorario(p)" /> }
        }
      </div>
    </ng-template>

    <ng-template #formHorario let-p>
      @if (form(); as f) {
        <form class="ra-form" (ngSubmit)="guardarHorario()" aria-label="Asignar horario">
          <!-- [RH.14.7] «Las que se ven» son las filas en pantalla (con «Solo irregulares», sólo ésas): antes decía las de la
               búsqueda y le escribía el horario también a las que el filtro escondía. -->
          <p class="ra-form-nota">Para <b>{{ p ? (p.nombreCompleto || p.nombre) : (filas().length === 1 ? 'la persona que se ve' : 'las ' + filas().length + ' personas que se ven') }}</b></p>
          @for (t of f.turnos; track $index; let i = $index) {
            <fieldset class="ra-turno">
              @if (f.turnos.length > 1) { <legend>Horario {{ i + 1 }}</legend> }
              <label>Entrada <input pInputText type="time" [name]="'ent' + i" [(ngModel)]="t.entrada" required /></label>
              <label>Salida <input pInputText type="time" [name]="'sal' + i" [(ngModel)]="t.salida" required /></label>
              <label>Comida (min) <input pInputText type="number" [name]="'com' + i" min="0" max="180" [(ngModel)]="t.comida" required /></label>
              @if (f.turnos.length > 1) {
                <p-button icon="pi pi-times" [text]="true" severity="secondary" size="small" [ariaLabel]="'Quitar el horario ' + (i + 1)" (onClick)="quitarTurno(i)" />
              }
            </fieldset>
          }
          @if (f.turnos.length < maxHorarios) {
            <p class="ra-form-nota">
              <p-button label="Agregar horario" icon="pi pi-plus" [text]="true" size="small" (onClick)="agregarTurno()" />
            </p>
          }
          <label class="ra-check"><input type="checkbox" name="sab" [(ngModel)]="f.sabado" /> Trabaja el sábado</label>
          @if (f.sabado) {
            <label>Sábado entra <input pInputText type="time" name="sabE" [(ngModel)]="f.sabadoEntrada" /></label>
            <label>Sábado sale <input pInputText type="time" name="sabS" [(ngModel)]="f.sabadoSalida" /></label>
          }
          <div class="ra-form-btns">
            <p-button type="submit" [label]="p || filas().length <= 1 ? 'Guardar horario' : 'Guardar horario a ' + filas().length" [loading]="guardando()" />
            <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="form.set(null)" />
          </div>
        </form>
      }
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .ra-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .ra-barra { display: flex; align-items: center; gap: var(--sp-2) var(--sp-3); flex-wrap: wrap; }
    /* [RH.13.5] Con el dedo, todo lo que se toca mide al menos 44 px (--tap-min: 0 con mouse). */
    .ra-chip { min-height: var(--tap-min); }
    :host ::ng-deep .p-button { min-height: var(--tap-min); }
    .ra-resumen { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    .ra-barra .ra-rep-acc { margin-left: auto; }
    .ra-ver { display: inline-flex; align-self: flex-start; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; background: var(--card-bg); }
    .ra-ver button { border: 0; background: none; color: var(--text-muted); padding: var(--sp-2) var(--sp-3); font: inherit; font-size: var(--fs-sm); cursor: pointer;
      white-space: nowrap; display: inline-flex; align-items: center; gap: var(--sp-1); }
    .ra-ver button + button { border-left: 1px solid var(--border-color); }
    .ra-ver button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .ra-ver button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .ra-ver-n { font-variant-numeric: tabular-nums; font-weight: 700; color: var(--text-main); }
    @media (pointer: coarse) { .ra-ver button { min-height: 44px; } }
    .ra-rep { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .ra-rep-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-3) var(--sp-3) var(--sp-2); }
    .ra-rep-head h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .ra-rep-head p { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-parcial { color: var(--warn-soft-fg); font-weight: 600; }
    .ra-rep-acc { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .ra-irr { display: inline-flex; align-items: center; gap: 6px; }
    .ra-irr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad-fg); }
    .ra-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); border-radius: var(--r-pill); padding: 2px var(--sp-3);
      font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
    .ra-chip[aria-pressed='true'] { background: var(--surface-selected-bg); border-color: var(--text-muted); }
    .ra-chip:focus-visible { outline: 2px solid var(--focus-ring); }
    .ra-ley { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted);
      border-top: 1px solid var(--border-color); }
    .ra-ley-rojo { color: var(--bad-soft-fg); }
    .ra-ley-ambar { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: 3px; padding: 0 3px; }
    .ra-ley-g { display: inline-flex; align-items: center; gap: 5px; }
    .ra-ley-mu { display: inline-block; width: 14px; height: 10px; border-radius: 3px;
      --g: var(--chart-8); background: color-mix(in srgb, var(--g) 16%, var(--card-bg)); border: 1px solid color-mix(in srgb, var(--g) 55%, var(--card-bg)); }
    .ra-ley-mu[data-g='permiso'] { --g: var(--chart-7); }
    .ra-ley-mu[data-g='salud'] { --g: var(--chart-5); }
    .ra-ley-mu[data-g='vacaciones'] { --g: var(--chart-4); }
    .ra-ley-mu[data-g='horario'] { --g: var(--chart-2); }
    .ra-ley-mu.pend { background: var(--card-bg); border-style: dashed; }
    .ra-vacio { margin: 0; padding: var(--sp-5) var(--sp-3); text-align: center; color: var(--text-muted); font-size: var(--fs-sm); border-top: 1px solid var(--border-color); }
    .ra-una { display: flex; flex-direction: column; gap: var(--sp-3); padding: 0 var(--sp-3) var(--sp-3); }
    .ra-ficha { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ra-nums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
    .ra-nums div { display: flex; flex-direction: column; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ra-nums b { font: 700 var(--fs-h3)/1.1 var(--font-mono); color: var(--text-main); }
    .ra-nums span { font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-nums .bad b { color: var(--bad-soft-fg); }
    .ra-irr-lista, .ra-marcas ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-marcas summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-muted); margin-bottom: var(--sp-1); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='bad'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='warn'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill[data-t='info'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .ra-tira { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--surface-2);
      font-size: var(--fs-sm); color: var(--text-main); }
    .ra-tira p { margin: 0; flex: 1 1 28ch; }
    .ra-falta { color: var(--bad-soft-fg); }
    .ra-baja-lnk { display: flex; justify-content: flex-end; }
    .ra-baja { border-color: var(--bad-border); }
    .ra-ancho { flex: 1 1 100%; }
    .ra-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ra-form { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; padding: var(--sp-3); margin: 0 var(--sp-3) var(--sp-2); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--surface-2); }
    .ra-ficha .ra-form, .ra-una .ra-form { margin: 0; }
    .ra-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form input[type='number'] { width: 6rem; }
    .ra-form .ra-check { flex-direction: row; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-form-nota { flex: 1 1 100%; margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form-btns { display: flex; gap: var(--sp-2); }
    .ra-turno { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; border: 0; margin: 0; padding: 0; }
    .ra-turno legend { flex: 1 1 100%; padding: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); }
    .ra-banner { margin: 0 var(--sp-3) var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ra-ficha .ra-banner, .ra-una .ra-banner { margin: 0; }
    .ra-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .ra-sinplazas { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); background: var(--surface-2); color: var(--text-main); }
    .ra-sinplazas span { flex: 1 1 30ch; }
    .ra-reloj { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-reloj-t { margin: 0; font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; flex: 1 1 100%; }
    .ra-reloj ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; flex: 1 1 20rem; }
    .ra-reloj small { color: var(--text-muted); font-size: var(--fs-xs); }
    .ra-confirmar { border: 1px solid var(--border-color); }
    .ra-acceso { margin-left: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-globo { width: min(36rem, 92vw); max-height: 80vh; overflow-y: auto; }
    .ra-bloqueado { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-2); }
    .ra-ir { color: var(--action); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
    .ra-ir:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* [RH.13.5] Angosta: «Horario» y «PDF para firmar» sólo con su ícono (conservan el nombre para el lector de pantalla).
       En el teléfono la tabla no trae los días, así que la leyenda de D y C sobra. */
    @media (max-width: 48rem) {
      :host ::ng-deep .ra-icono-chico .p-button-label { display: none; }
      /* Renglón 1: qué ver y las dos acciones; renglón 2: cuántos y quién tiene algo. */
      .ra-ver { order: 1; }
      .ra-barra .ra-rep-acc { order: 2; }
      .ra-resumen { order: 3; flex: 1 1 100%; }
    }
    @media (max-width: 34rem) {
      .ra-ley-dc { display: none; }
    }
    @media (max-width: 40rem) {
      .ra-page { padding: var(--sp-3); }
      .ra-nums { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `],
})
export class RhAsistenciaComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);

  readonly gravedadLabel: Record<string, string> = { alta: 'Bloquea', media: 'Revisar', info: 'Nota', ok: 'Confirmado' };
  readonly horas = horasTexto;
  readonly firma = firmaHoras;
  readonly dif = difHorario;
  readonly diaLargo = diaLargo;
  readonly h12 = hora12;

  readonly sel = signal<HrPersonaAsistencia | null>(null);
  readonly form = signal<FormHorario | null>(null);
  /** A quién va el horario: una persona, o null = las que se ven. */
  readonly destino = signal<HrPersonaAsistencia | null>(null);
  readonly guardando = signal(false);
  readonly exportando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);

  readonly puedeGestionar = computed(() => this.perms.has(Permission.HR_ATTENDANCE_GESTIONAR));
  /** `[RH.7.1]` La misma clave que da de alta y liga personas (`HR_DEVICES_GESTIONAR`, ya repartida a RH). */
  readonly puedeEditarFicha = computed(() => this.perms.has(Permission.HR_DEVICES_GESTIONAR));
  readonly sinDepartamento = SIN_DEPARTAMENTO;
  readonly fichaForm = signal<FormFicha | null>(null);
  /** `[RH.7.2]` A quién se le está dando de baja (su código) y el motivo que se escribe. */
  readonly bajaDe = signal<string | null>(null);
  readonly motivoBaja = signal('');
  /** Las secciones que ya existen en la plaza: se elige una antes que escribir otra variante de la misma. */
  readonly seccionesConocidas = computed(() =>
    [...new Set(this.todas().map((x) => departamentoDe(x)).filter((d) => d !== SIN_DEPARTAMENTO))].sort((a, b) => a.localeCompare(b, 'es')));
  readonly puedeCapturar = computed(() => this.perms.has(Permission.HR_INCIDENTS_CAPTURAR));
  readonly puedeCalificar = computed(() => this.perms.has(Permission.HR_INCIDENTS_CALIFICAR));
  /** `[RH.18.2]` Quien ve Personas (Administración) puede ir directo a cambiar lo que aquí no se puede. */
  readonly puedeVerPersonas = computed(() => this.perms.has(Permission.USUARIOS_VER));
  irAPersonas(ev: Event): void { ev.preventDefault(); void this.router.navigate(['/admin/users']); }
  /** `[RH.18.1]` La incidencia que se está capturando desde un día (de quién, qué día, qué se le propone). */
  /** `[RH.18.4]` La incidencia que se está capturando desde una celda de la tabla (de quién, qué día, qué se le propone). */
  readonly captura = signal<{ codigo: string; nombre: string; fecha: string; sugeridos: string[]; alias: Record<string, string>; deLoChecado: boolean; contexto: string; origen: 'tabla' } | null>(null);
  /** `[RH.18.7]` Los grupos de la leyenda de bloques. */
  readonly gruposInc = GRUPOS_INCIDENCIA;
  /** El nombre de cada tipo (para las pendientes de la tabla, que sólo traen su clave). */
  readonly etiquetasInc = computed(() => new Map(this.tiposInc().map((x) => [x.tipo, x.etiqueta] as const)));
  /** `[RH.18.7]` La celda que acaba de guardar: destella una vez en la tabla. */
  readonly destello = signal<{ codigo: string; fecha: string } | null>(null);
  /** `[RH.18.4]` El globo de la tabla semanal. */
  private readonly capPop = viewChild<Popover>('capPop');
  /** Se cambió de celda con el globo abierto: se abre la nueva cuando termina de cerrarse la anterior. */
  private reabrir: (() => void) | null = null;
  readonly capturaForm = signal<FormCaptura | null>(null);
  /** Los 19 tipos: se leen la primera vez que se captura. */
  readonly tiposInc = signal<HrTipoIncidenciaDto[]>([]);
  readonly mide = computed(() => this.est.datos()?.mideRetardo ?? true);

  readonly todas = computed(() => this.est.datos()?.personas ?? []);
  /** Una columna por día: la semana entera (lo que no ha pasado sale en blanco), o sólo hoy. */
  readonly columnas = computed(() => {
    const e = this.est;
    if (e.modoHoy()) return columnasDelRango(e.hoy(), e.hoy(), e.hoy());
    return columnasDelRango(e.jueves(), sumarDias(e.jueves(), 6), e.hoy());
  });
  readonly irr = computed(() => {
    const o = { hoy: this.est.hoy(), desayunoAlertaMin: this.est.datos()?.desayunoAlertaMin ?? 10 };
    return new Map<string, Irregularidad[]>(this.todas().map((p) => [p.codigo, irregularidadesDe(p, o)]));
  });
  /** `[RH.13.5]` Lo elegido en «Personas»: departamentos enteros y personas sueltas. */
  private readonly seleccion = computed(() => ({ departamentos: this.est.departamentos(), elegidas: this.est.elegidas() }));
  /** Lo que se ve antes de «Solo irregulares»: personas elegidas y búsqueda. */
  readonly visibles = computed(() => {
    const s = this.seleccion();
    const dentro = cubiertas(this.todas(), s);
    const base = haySeleccion(s) ? this.todas().filter((p) => dentro.has(p.codigo)) : this.todas();
    return filtrarPorBusqueda(base, this.est.buscar(), (p) => [p.nombre, p.nombreCompleto, p.codigo]);
  });
  private readonly esIrregular = (p: HrPersonaAsistencia) => cuentaIrregular(this.irr().get(p.codigo) ?? [], 'alta') > 0;
  readonly nIrregulares = computed(() => this.visibles().filter(this.esIrregular).length);
  readonly filas = computed(() => (this.est.soloIrregulares() ? this.visibles().filter(this.esIrregular) : this.visibles()));
  readonly grupos = computed(() => porDepartamento(this.todas(), this.filas()));
  readonly conSubtotales = computed(() => !this.est.buscar().trim() && !this.est.soloIrregulares());
  /** Lo elegido cubre a una sola persona («Ver solo a esta persona», o elegirla en «Personas»): su tabla día por día. */
  readonly unica = computed(() => personaUnica(this.todas(), this.seleccion()));
  readonly parcial = computed(() => etiquetaParcial({
    unica: null, departamentos: this.est.departamentos(), sueltas: this.est.elegidas().filter((c) => this.todas().some((p) => p.codigo === c)).length,
    buscar: this.est.buscar(), soloIrregulares: this.est.soloIrregulares(),
  }));
  readonly periodoTexto = computed(() => {
    const e = this.est;
    if (e.modoHoy()) return `Hoy, ${fechaCorta(e.hoy())}`;
    return `Semana del ${fechaCorta(e.jueves())} al ${fechaCorta(sumarDias(e.jueves(), 6))}${e.esSemanaActual() ? ', en curso' : ''}`;
  });
  readonly vacio = computed(() => !this.est.loading() && !this.est.error() && !!this.est.datos() && !this.todas().length);
  readonly vacioTitulo = computed(() => (this.est.soloPromotoras() ? 'Nadie de promotoría checó en este periodo' : 'Nadie checó en este periodo'));
  readonly sinFilas = computed(() => {
    const q = this.est.buscar().trim();
    return q
      ? `Nadie de esta plaza coincide con «${q}». Las sugerencias de la búsqueda miran en todas las plazas.`
      : 'Nadie con irregularidades en lo que se ve.';
  });
  readonly fichaTitulo = computed(() => this.sel()?.nombreCompleto || this.sel()?.nombre || '');
  readonly fichaSub = computed(() => {
    const p = this.sel();
    return p ? `#${p.codigo} · ${this.depto(p)} · ${this.est.nombreSitio()}` : null;
  });

  /** `[RH.13.5]` Qué se ve de la semana y qué panel está abierto: en la URL, para que un enlace llegue igual. */
  private readonly ruta = inject(ActivatedRoute);
  private readonly q = toSignal(this.ruta.queryParamMap, { initialValue: this.ruta.snapshot.queryParamMap });
  readonly ver = computed<'semana' | 'faltas' | 'tolerancia'>(() => {
    const v = this.q().get('ver');
    return v === 'faltas' || v === 'tolerancia' ? v : 'semana';
  });
  readonly panel = computed<'incidencias' | 'relojes' | 'nombres' | null>(() => {
    const p = this.q().get('panel');
    return p === 'incidencias' || p === 'relojes' || p === 'nombres' ? p : null;
  });

  // ── [RH.14.3] La ficha completa (relojes y datos de la persona), leída al abrir a alguien ──
  readonly fichaDet = signal<HrFichaPersonaDto | null>(null);
  readonly fichaDetError = signal<string | null>(null);
  readonly catalogos = signal<HrCatalogosFichaDto | null>(null);
  readonly catalogosError = signal<string | null>(null);
  /** `[RH.14.1]` Con la última baja, la persona se quedó sin plazas. */
  readonly sinPlazas = signal<HrSinPlazasDto | null>(null);
  private fichaSeq = 0;

  private cargarFichaDet(p: HrPersonaAsistencia): void {
    const site = this.est.sitio();
    const mi = ++this.fichaSeq;
    this.fichaDet.set(null);
    this.fichaDetError.set(null);
    if (!site) return;
    this.api.fichaPersona(site, p.codigo).subscribe({
      next: (f) => { if (mi === this.fichaSeq) this.fichaDet.set(f); },
      error: (e) => { if (mi === this.fichaSeq) this.fichaDetError.set(rhError(e, '')); },
    });
    if (!this.catalogos()) {
      this.api.catalogosFicha().subscribe({
        next: (c) => { this.catalogos.set(c); this.catalogosError.set(null); },
        error: (e) => this.catalogosError.set(rhError(e, 'No se pudieron leer.')),
      });
    }
  }

  /** Algún reloj la tiene con un nombre distinto del que quedaría con su nombre de la Suite. */
  relojDistinto(fd: HrFichaPersonaDto): boolean {
    return !!fd.nombre_para_reloj && fd.relojes.some((r) => (r.nombre_reloj ?? '') !== fd.nombre_para_reloj);
  }

  /** Un código del catálogo, por su nombre. Sin catálogo se dice que no se pudo leer; sin valor, lo que diga `vacio` («sin departamento»). */
  nombreDe(lista: Array<{ code: string; name: string }> | undefined, code: string | null, vacio: string): string {
    if (!code) return vacio;
    if (!lista) return this.catalogosError() ? 'no se pudo leer' : '…';
    return lista.find((x) => x.code === code)?.name ?? 'ya no existe en el catálogo';
  }

  /** Con departamento elegido, sus puestos primero; sin él, todos. */
  puestosDe(cat: HrCatalogosFichaDto, dep: string | null): HrCatalogosFichaDto['puestos'] {
    if (!dep) return cat.puestos;
    return [...cat.puestos.filter((x) => x.department_code === dep), ...cat.puestos.filter((x) => x.department_code !== dep)];
  }

  ponerEnReloj(p: HrPersonaAsistencia, fd: HrFichaPersonaDto): void {
    const site = this.est.sitio();
    if (!site || !fd.nombre_para_reloj || this.guardando()) return;
    this.guardando.set(true);
    this.api.renombrar(site, p.codigo, fd.nombre_para_reloj).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.aviso.set({ texto: `Enviado al reloj: ${r.nombre}`, mal: false });
        this.cargarFichaDet(p);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo mandar el nombre al reloj.'), mal: true }); },
    });
  }

  archivar(s: HrSinPlazasDto): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.api.archivarPersona({ user_id: s.user_id, motivo: 'Sin plazas activas: se dio de baja en la última que tenía' }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.sinPlazas.set(null);
        this.aviso.set({ texto: `Archivada: ${s.nombre || 'sin nombre'}`, mal: false });
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo archivar.'), mal: true }); },
    });
  }

  irAVer(v: 'semana' | 'faltas' | 'tolerancia'): void {
    void this.router.navigate([], { relativeTo: this.ruta, queryParams: { ver: v === 'semana' ? null : v }, queryParamsHandling: 'merge' });
  }

  /** Al cerrar el panel se quita lo que sólo servía para abrirlo (la captura nueva, la persona, el día). */
  cerrarPanel(): void {
    void this.router.navigate([], {
      relativeTo: this.ruta, queryParamsHandling: 'merge',
      queryParams: { panel: null, nueva: null, persona: null, desde: null, site: null },
    });
  }

  constructor() {
    // Elegida en «Buscar en todas las plazas»: en cuanto llega su plaza, se abre su ficha.
    effect(() => {
      const c = this.est.fichaPendiente();
      const d = this.est.datos();
      if (!c || !d || this.est.loading()) return;
      const p = d.personas.find((x) => x.codigo === c);
      this.est.fichaPendiente.set(null);
      if (p) this.abrir(p);
    });
    // `[RH.18.7]` Hay incidencias por calificar en la semana: se leen los nombres de los tipos para pintar sus bloques.
    effect(() => {
      if (this.est.pendientesLista().length && !untracked(() => this.tiposInc().length)) untracked(() => this.conTipos(() => undefined));
    });
    // Al recalcular (otra semana, horario guardado), la ficha abierta se refresca con los números nuevos.
    effect(() => {
      const d = this.est.datos();
      const s = this.sel();
      if (!d || !s) return;
      const nueva = d.personas.find((x) => x.codigo === s.codigo) ?? null;
      if (nueva !== s) this.sel.set(nueva);
    });
  }

  depto(p: HrPersonaAsistencia): string { return departamentoDe(p); }
  primerNombre(p: HrPersonaAsistencia): string { return (p.nombreCompleto || p.nombre).split(' ')[0]; }
  horarioTexto(p: HrPersonaAsistencia): string { return horarioDe(p).texto.replace(/^Deducido · /, 'entra '); }
  irrDe(p: HrPersonaAsistencia): Irregularidad[] { return this.irr().get(p.codigo) ?? []; }
  /** Sus faltas del periodo sin contar hoy (el día no ha terminado). */
  faltasDe(p: HrPersonaAsistencia): number {
    const hoy = this.est.hoy();
    return p.semanas.reduce((t, s) => t + s.dias.filter((d) => d.estado === 'falta' && d.fecha < hoy).length, 0);
  }

  abrir(p: HrPersonaAsistencia): void {
    this.sel.set(p); this.form.set(null); this.fichaForm.set(null); this.bajaDe.set(null); this.aviso.set(null); this.sinPlazas.set(null);
    this.cargarFichaDet(p);
  }
  cerrar(): void { this.cerrarCaptura(); this.sel.set(null); this.form.set(null); this.fichaForm.set(null); this.bajaDe.set(null); this.aviso.set(null); this.fichaDet.set(null); this.fichaSeq++; }
  cambioFicha(abierta: boolean): void { if (!abierta) this.cerrar(); }
  soloEsta(p: HrPersonaAsistencia): void { this.cerrar(); this.est.verSolo(p.codigo); }

  /** Los 19 tipos se leen la primera vez que se captura; después, al momento. */
  private conTipos(sigue: () => void): void {
    if (this.tiposInc().length) { sigue(); return; }
    this.api.tiposIncidencia().subscribe({
      next: (tipos) => { this.tiposInc.set(tipos); sigue(); },
      error: (e) => this.aviso.set({ texto: rhError(e, 'No se pudieron leer los tipos de incidencia.'), mal: true }),
    });
  }

  /**
   * `[RH.18.4]` La celda del día en la tabla de la semana: la captura se abre en un globo sobre esa celda (la persona y el
   * día puestos, los botones del día), sin salir de la tabla. La misma celda otra vez lo cierra; otra celda lo mueve.
   */
  capturarEnTabla(e: { persona: HrPersonaAsistencia; fecha: string; ancla: HTMLElement }): void {
    const pop = this.capPop();
    const c = this.captura();
    if (c && c.origen === 'tabla' && c.codigo === e.persona.codigo && c.fecha === e.fecha) { this.cerrarGlobo(); return; }
    this.aviso.set(null);
    const abrir = () => this.conTipos(() => { this.abrirCaptura(e.persona, e.fecha, 'tabla'); pop?.show(null, e.ancla); });
    if (pop?.overlayVisible()) { this.reabrir = abrir; pop.hide(); return; }
    abrir();
  }

  cerrarGlobo(): void {
    if (this.capPop()?.overlayVisible()) this.capPop()!.hide();
    else if (this.captura()?.origen === 'tabla') this.cerrarCaptura();
  }

  /** El globo se cerró (Esc, clic fuera, Guardar, Cancelar): se suelta la captura; si se cambió de celda, se abre la nueva. */
  alCerrarGlobo(): void {
    if (this.captura()?.origen === 'tabla') this.cerrarCaptura();
    const r = this.reabrir;
    this.reabrir = null;
    if (r) setTimeout(r);
  }

  private abrirCaptura(p: HrPersonaAsistencia, fecha: string, origen: 'tabla'): void {
    const d = diasPorFecha(p).get(fecha);
    const hoy = this.est.hoy();
    const form = formDelDia(p.codigo, fecha, d);
    this.capturaForm.set(form);
    this.captura.set({ codigo: p.codigo, nombre: p.nombreCompleto || p.nombre, fecha, sugeridos: sugerenciasDelDia(d, fecha, hoy), alias: aliasDelDia(d), deLoChecado: !!form.entrada, contexto: contextoDelDia(d, fecha, hoy), origen });
  }

  cerrarCaptura(): void { this.captura.set(null); this.capturaForm.set(null); }

  /** Guardada: se dice si ya cuenta y se recalcula (la ficha abierta se refresca sola con los números nuevos). */
  capturaGuardada(n: HrIncidenciaDto): void {
    const c = this.captura();
    if (c) { this.destello.set(null); queueMicrotask(() => this.destello.set({ codigo: c.codigo, fecha: c.fecha })); }
    if (c?.origen === 'tabla') this.capPop()?.hide();
    this.cerrarCaptura();
    this.aviso.set({ texto: n.status === 'calificada' ? 'Incidencia guardada y calificada: ya cuenta en la asistencia.' : 'Incidencia guardada. Cuenta cuando otra persona la califique (en Incidencias).', mal: false });
    this.est.asegurar(true);
  }

  abrirHorario(p: HrPersonaAsistencia | null): void {
    const a = p?.horarioAsignado;
    this.aviso.set(null);
    this.destino.set(p);
    this.form.set({
      turnos: a?.horarios?.length
        ? a.horarios.map((h) => ({ entrada: h.entrada, salida: h.salida, comida: h.comidaMin }))
        : [{ entrada: p?.horario ?? '08:00', salida: p?.salida ?? '17:00', comida: 60 }],
      sabado: a?.sabado ?? false, sabadoEntrada: a?.sabadoEntrada ?? '', sabadoSalida: a?.sabadoSalida ?? '',
    });
  }

  readonly maxHorarios = MAX_HORARIOS;
  agregarTurno(): void {
    const f = this.form();
    if (!f || f.turnos.length >= MAX_HORARIOS) return;
    this.form.set({ ...f, turnos: [...f.turnos, { entrada: '', salida: '', comida: f.turnos[0]?.comida ?? 60 }] });
  }
  quitarTurno(i: number): void {
    const f = this.form();
    if (!f || f.turnos.length < 2) return;
    this.form.set({ ...f, turnos: f.turnos.filter((_, k) => k !== i) });
  }

  guardarHorario(): void {
    const f = this.form();
    const site = this.est.sitio();
    if (!f || !site || !f.turnos.length) return;
    const p = this.destino();
    // `[RH.14.7]` A quien está en pantalla: con «Solo irregulares», sólo a ésas (antes, a todas las de la búsqueda).
    const codigos = p ? [p.codigo] : this.filas().map((x) => x.codigo);
    if (!codigos.length) return;
    const [t0] = f.turnos;
    this.guardando.set(true);
    this.api.asignarHorario({
      site_code: site, person_codes: codigos, starts_at: t0.entrada, ends_at: t0.salida, lunch_minutes: Number(t0.comida),
      works_saturday: f.sabado, saturday_starts_at: f.sabado ? f.sabadoEntrada : undefined, saturday_ends_at: f.sabado ? f.sabadoSalida : undefined,
      // Con uno solo no se manda la lista: el servidor guarda lo de siempre (shifts = NULL).
      ...(f.turnos.length > 1
        ? { shifts: f.turnos.map((t) => ({ starts_at: t.entrada, ends_at: t.salida, lunch_minutes: Number(t.comida) })) } : {}),
    }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.form.set(null);
        this.aviso.set({ texto: `Horario guardado${r.guardados > 1 ? ` (${r.guardados})` : ''}`, mal: false });
        this.est.asegurar(true);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar el horario.'), mal: true }); },
    });
  }

  abrirFicha(p: HrPersonaAsistencia): void {
    this.aviso.set(null);
    this.form.set(null);
    const d = departamentoDe(p);
    const fd = this.fichaDet();
    this.fichaForm.set({
      // `[RH.14.4]` Si su nombre es el apodo del reloj, el campo arranca vacío: copiar el apodo invita a guardarlo igual.
      // `[RH.20.1]` Sin ligar, lo que se ve es el apodo del reloj: también arranca vacío.
      codigo: p.codigo, nombre: fd?.nombre_por_confirmar === 'apodo_del_reloj' || !p.registrado ? '' : (p.nombreCompleto || p.nombre), seccion: d === SIN_DEPARTAMENTO ? '' : d,
      promotora: this.est.soloPromotoras(),
      departamento: fd?.departamento_code ?? null, puesto: fd?.puesto_code ?? null, sucursal: fd?.sucursal_code ?? null,
    });
  }

  /** Manda sólo lo que cambió: el servidor no toca lo que no viene (y el nombre de una cuenta con acceso, nunca). */
  guardarFicha(p: HrPersonaAsistencia): void {
    const f = this.fichaForm();
    const site = this.est.sitio();
    if (!f || !site) return;
    const antes = departamentoDe(p);
    const fd = this.fichaDet();
    const cambios: { nombre?: string; seccion?: string; promotora?: boolean; departamento_code?: string | null; puesto_code?: string | null; sucursal_code?: string | null } = {};
    // `[RH.14.4]` El nombre va para cualquiera. Lo de la persona (departamento, puesto, sucursal), sólo sin acceso: con
    // acceso el servidor lo rechaza (lo cambia Sistemas).
    const sinAcceso = !!fd && !fd.con_acceso;
    if (f.nombre.trim() && f.nombre.trim() !== (p.nombreCompleto || p.nombre)) cambios.nombre = f.nombre;
    if (f.seccion.trim().toUpperCase() !== (antes === SIN_DEPARTAMENTO ? '' : antes)) cambios.seccion = f.seccion;
    if (f.promotora !== this.est.soloPromotoras()) cambios.promotora = f.promotora;
    // `[RH.20.1]` Sin ligar, guardar es darla de alta: el servidor necesita el nombre completo y la sección aunque no cambien.
    if (!p.registrado) {
      cambios.nombre = f.nombre;
      cambios.seccion = f.seccion;
    }
    if (sinAcceso && fd) {
      if ((f.departamento ?? null) !== fd.departamento_code) cambios.departamento_code = f.departamento ?? null;
      if ((f.puesto ?? null) !== fd.puesto_code) cambios.puesto_code = f.puesto ?? null;
      if ((f.sucursal ?? null) !== fd.sucursal_code) cambios.sucursal_code = f.sucursal ?? null;
    }
    if (!Object.keys(cambios).length) { this.aviso.set({ texto: 'No cambiaste nada.', mal: false }); return; }
    this.guardando.set(true);
    this.api.editarFicha({ site_code: site, person_code: p.codigo, ...cambios }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.fichaForm.set(null);
        this.aviso.set({
          texto: (!p.registrado ? 'Dada de alta en la Suite, sin acceso · ' : '') + (cambios.promotora !== undefined
            ? `Guardado · ahora en ${cambios.promotora ? 'Promotoras' : 'Planta'}`
            : 'Guardado'),
          mal: false,
        });
        this.est.asegurar(true);
        if (cambios.nombre !== undefined) this.est.refrescarNombres();
        this.cargarFichaDet(p);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar la ficha.'), mal: true }); },
    });
  }

  abrirBaja(p: HrPersonaAsistencia): void {
    this.aviso.set(null);
    this.fichaForm.set(null);
    this.form.set(null);
    this.motivoBaja.set('');
    this.bajaDe.set(p.codigo);
  }

  /** `[RH.7.2]` Baja en la plaza: sale del reporte y de la ficha (se cierra), y queda en la pestaña Bajas. */
  darDeBaja(p: HrPersonaAsistencia): void {
    const site = this.est.sitio();
    const motivo = this.motivoBaja().trim();
    if (!site || motivo.length < 5 || this.guardando()) return;
    this.guardando.set(true);
    this.api.darDeBaja({ site_code: site, person_code: p.codigo, motivo }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.bajaDe.set(null);
        this.cerrar();
        this.aviso.set({ texto: `De baja: ${p.nombreCompleto || p.nombre}`, mal: false });
        this.sinPlazas.set(r.sin_plazas ?? null);
        this.est.asegurar(true);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo dar de baja.'), mal: true }); },
    });
  }

  quitarHorario(p: HrPersonaAsistencia): void {
    const site = this.est.sitio();
    if (!site) return;
    this.guardando.set(true);
    this.api.quitarHorario(site, [p.codigo]).subscribe({
      next: () => { this.guardando.set(false); this.aviso.set({ texto: 'Vuelve a medirse con el horario deducido de sus checadas.', mal: false }); this.est.asegurar(true); },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo quitar el horario.'), mal: true }); },
    });
  }

  // ── Exportar: lo que se ve es lo que sale ──
  private contexto(): ContextoExport {
    return {
      plaza: this.est.nombreSitio(), periodo: this.periodoTexto(), parcial: this.parcial(), columnas: this.columnas(),
      hoy: this.est.hoy(), mideRetardo: this.mide(), saldos: this.est.saldosHE(),
    };
  }

  pdfPlaza(): void { void this.exportar(() => exportarPdfPlaza(this.grupos(), this.todas(), this.contexto(), this.conSubtotales())); }
  pdfPersona(p: HrPersonaAsistencia): void { void this.exportar(() => exportarPdfPersona(p, this.contexto())); }

  private async exportar(fn: () => Promise<void>): Promise<void> {
    this.exportando.set(true);
    try { await fn(); }
    catch { this.aviso.set({ texto: 'No se pudo generar el archivo. Vuelve a intentarlo.', mal: true }); }
    finally { this.exportando.set(false); }
  }
}
