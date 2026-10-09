import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { Popover, PopoverModule } from 'primeng/popover';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrPersonaAsistencia } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhReporteSemanalComponent } from '../components/rh-reporte-semanal.component';
import { RhPersonaDiasComponent } from '../components/rh-persona-dias.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, fechaCorta, rhError, sumarDias } from '../rh.service';
import {
  type Irregularidad, columnasDelRango, cuentaIrregular, departamentoDe, diaLargo, difHorario, etiquetaParcial, firmaHoras,
  hora12, horarioDe, horasTexto, irregularidadesDe, porDepartamento,
} from '../reporte-formato';
import { type ContextoExport, exportarExcel, exportarPdfPersona, exportarPdfPlaza } from '../rh-exportar';

interface FormHorario { entrada: string; salida: string; comida: number; sabado: boolean; sabadoEntrada: string; sabadoSalida: string; }

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
    NgTemplateOutlet, FormsModule, ButtonModule, InputTextModule, PopoverModule, LoadStateComponent, SidePeekComponent,
    RhMarcoComponent, RhReporteSemanalComponent, RhPersonaDiasComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ra-page">
      <app-rh-marco [barra]="true" [franja]="true" [personas]="true" />

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
                <p-button label="Ver a todos" [text]="true" severity="secondary" (onClick)="est.unica.set(null)" />
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
            </div>
          </section>
        } @else {
          <section class="ra-rep" aria-label="Reporte de asistencia">
            <div class="ra-rep-head">
              <div>
                <h2>{{ est.nombreSitio() }}</h2>
                <p>{{ periodoTexto() }} · {{ visibles().length }} persona{{ visibles().length === 1 ? '' : 's' }}@if (est.soloPromotoras()) { de promotoría }@if (parcial()) { <span class="ra-parcial"> · {{ parcial() }}</span> }</p>
              </div>
              <div class="ra-rep-acc">
                @if (puedeGestionar()) {
                  <p-button label="Horario" icon="pi pi-clock" severity="secondary" [outlined]="true" (onClick)="abrirHorario(null)" />
                }
                <p-button label="Exportar" icon="pi pi-download" severity="secondary" [outlined]="true" [loading]="exportando()" (onClick)="exp.toggle($event)" />
                <p-popover #exp appendTo="body" ariaLabel="Exportar">
                  <div class="ra-menu">
                    <button type="button" (click)="exp.hide(); pdfPlaza()">PDF para firmar</button>
                    <button type="button" (click)="exp.hide(); excel()">Excel</button>
                    <p>Sale lo que se ve: {{ parcial() || 'toda la plaza' }}.</p>
                  </div>
                </p-popover>
              </div>
            </div>
            @if (form() && !destino()) {
              <ng-container *ngTemplateOutlet="formHorario; context: { $implicit: null }" />
            }
            @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
            @if (nIrregulares()) {
              <div class="ra-irr">
                <span class="ra-irr-dot" aria-hidden="true"></span>
                <span><b>{{ nIrregulares() }}</b> con irregularidades · toca su fila para ver qué día y por qué</span>
                <button type="button" class="ra-chip" [attr.aria-pressed]="est.soloIrregulares()" (click)="est.soloIrregulares.set(!est.soloIrregulares())">
                  {{ est.soloIrregulares() ? 'Ver a todos' : 'Solo irregulares' }}
                </button>
              </div>
            }
            <p class="ra-ley">Debajo de cada día: <b>D</b> minutos de desayuno · <b>C</b> minutos de comida, en ámbar si se pasó.
              {{ mide() ? 'En rojo, la entrada tarde y la falta.' : 'En esta plaza no se mide retardo: cada quien entra en su turno.' }}</p>
            @if (filas().length) {
              <app-rh-reporte-semanal [grupos]="grupos()" [todas]="todas()" [columnas]="columnas()" [irregularidades]="irr()" [hoy]="est.hoy()"
                                      [mideRetardo]="mide()" [parcial]="!!parcial()" [subtotales]="conSubtotales()"
                                      (abrir)="abrir($event)" (menu)="menu($event)" />
            } @else {
              <p class="ra-vacio">{{ sinFilas() }}</p>
            }
          </section>
        }
      </app-load-state>

      <p-popover #acc appendTo="body" ariaLabel="Acciones de la persona">
        @if (enMenu(); as p) {
          <div class="ra-menu">
            <button type="button" (click)="acc.hide(); abrir(p)">Ver su ficha</button>
            <button type="button" (click)="acc.hide(); est.unica.set(p.codigo)">Ver solo a esta persona</button>
            @if (puedeCapturar()) { <button type="button" (click)="acc.hide(); capturar(p)">Capturar incidencia</button> }
            @if (puedeGestionar()) { <button type="button" (click)="acc.hide(); abrir(p); abrirHorario(p)">Horario</button> }
          </div>
        }
      </p-popover>

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
            @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }

            <app-rh-persona-dias [persona]="p" [columnas]="columnas()" [hoy]="est.hoy()" [mideRetardo]="mide()" />

            <div class="ra-acciones">
              @if (puedeCapturar()) {
                <p-button icon="pi pi-file-edit" label="Capturar incidencia" severity="secondary" [outlined]="true" size="small" (onClick)="capturar(p)" />
              }
              <p-button label="Ver solo a esta persona" severity="secondary" [outlined]="true" size="small" (onClick)="soloEsta(p)" />
              <p-button label="PDF para firmar" icon="pi pi-file-pdf" [text]="true" size="small" [loading]="exportando()" (onClick)="pdfPersona(p)" />
            </div>
          </div>
        }
      </app-side-peek>
    </div>

    <ng-template #tiraHorario let-p>
      <div class="ra-tira">
        @if (p.horarioAsignado; as h) {
          <p>Horario de <b>{{ primerNombre(p) }}</b> asignado por RH: {{ h12(h.entrada) }} a {{ h12(h.salida) }} · comida {{ h.comidaMin }} min{{ h.sabado ? ' · trabaja el sábado' : '' }}.</p>
          @if (puedeGestionar()) {
            <p-button label="Cambiar" severity="secondary" [outlined]="true" size="small" (onClick)="abrirHorario(p)" />
            <p-button label="Volver al deducido" [text]="true" size="small" [loading]="guardando()" (onClick)="quitarHorario(p)" />
          }
        } @else {
          <p><b>{{ primerNombre(p) }}</b> no tiene horario asignado. Se mide contra el que sale de sus checadas: {{ horarioTexto(p) }}.</p>
          @if (puedeGestionar()) { <p-button label="Asignarle horario" severity="secondary" [outlined]="true" size="small" (onClick)="abrirHorario(p)" /> }
        }
      </div>
    </ng-template>

    <ng-template #formHorario let-p>
      @if (form(); as f) {
        <form class="ra-form" (ngSubmit)="guardarHorario()" aria-label="Asignar horario">
          <p class="ra-form-nota">Para <b>{{ p ? (p.nombreCompleto || p.nombre) : 'las ' + visibles().length + ' personas que se ven' }}</b>. Manda sobre lo que se deduce de las
            checadas: contra él se miden el retardo, las faltas, la salida y la comida.</p>
          <label>Entrada <input pInputText type="time" name="ent" [(ngModel)]="f.entrada" required /></label>
          <label>Salida <input pInputText type="time" name="sal" [(ngModel)]="f.salida" required /></label>
          <label>Comida (min) <input pInputText type="number" name="com" min="0" max="180" [(ngModel)]="f.comida" required /></label>
          <label class="ra-check"><input type="checkbox" name="sab" [(ngModel)]="f.sabado" /> Trabaja el sábado</label>
          @if (f.sabado) {
            <label>Sábado entra <input pInputText type="time" name="sabE" [(ngModel)]="f.sabadoEntrada" /></label>
            <label>Sábado sale <input pInputText type="time" name="sabS" [(ngModel)]="f.sabadoSalida" /></label>
          }
          <div class="ra-form-btns">
            <p-button type="submit" label="Guardar horario" [loading]="guardando()" />
            <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="form.set(null)" />
          </div>
        </form>
      }
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .ra-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .ra-rep { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .ra-rep-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-3) var(--sp-3) var(--sp-2); }
    .ra-rep-head h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .ra-rep-head p { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-parcial { color: var(--warn-soft-fg); font-weight: 600; }
    .ra-rep-acc { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .ra-menu { display: flex; flex-direction: column; min-width: 13rem; }
    .ra-menu button { text-align: left; border: 0; background: none; padding: 6px var(--sp-2); border-radius: var(--r-sm); font: inherit; font-size: var(--fs-sm); color: var(--text-main); cursor: pointer; }
    .ra-menu button:hover, .ra-menu button:focus-visible { background: var(--surface-hover-bg); outline: none; }
    .ra-menu p { margin: var(--sp-1) var(--sp-2) 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 16rem; }
    .ra-irr { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-irr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad-fg); }
    .ra-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); border-radius: var(--r-pill); padding: 2px var(--sp-3);
      font-size: var(--fs-xs); font-weight: 600; cursor: pointer; }
    .ra-chip[aria-pressed='true'] { background: var(--surface-selected-bg); border-color: var(--text-muted); }
    .ra-chip:focus-visible { outline: 2px solid var(--focus-ring); }
    .ra-ley { margin: 0; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-ley b { color: var(--text-main); }
    .ra-vacio { margin: 0; padding: var(--sp-5) var(--sp-3); text-align: center; color: var(--text-muted); font-size: var(--fs-sm); border-top: 1px solid var(--border-color); }
    .ra-una { display: flex; flex-direction: column; gap: var(--sp-3); padding: 0 var(--sp-3) var(--sp-3); }
    .ra-ficha { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ra-nums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
    .ra-nums div { display: flex; flex-direction: column; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ra-nums b { font: 700 var(--fs-h3)/1.1 var(--font-mono); color: var(--text-main); }
    .ra-nums span { font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-nums .bad b { color: var(--bad-fg); }
    .ra-irr-lista, .ra-marcas ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-marcas summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-muted); margin-bottom: var(--sp-1); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='bad'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='warn'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill[data-t='info'] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .ra-tira { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--surface-2);
      font-size: var(--fs-sm); color: var(--text-main); }
    .ra-tira p { margin: 0; flex: 1 1 28ch; }
    .ra-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ra-form { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; padding: var(--sp-3); margin: 0 var(--sp-3) var(--sp-2); border: 1px solid var(--border-color);
      border-radius: var(--r-md); background: var(--surface-2); }
    .ra-ficha .ra-form, .ra-una .ra-form { margin: 0; }
    .ra-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form input[type='number'] { width: 6rem; }
    .ra-form .ra-check { flex-direction: row; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-form-nota { flex: 1 1 100%; margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form-btns { display: flex; gap: var(--sp-2); }
    .ra-banner { margin: 0 var(--sp-3) var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ra-ficha .ra-banner, .ra-una .ra-banner { margin: 0; }
    .ra-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
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
  private readonly acc = viewChild<Popover>('acc');

  readonly gravedadLabel: Record<string, string> = { alta: 'Bloquea', media: 'Revisar', info: 'Nota', ok: 'Confirmado' };
  readonly horas = horasTexto;
  readonly firma = firmaHoras;
  readonly dif = difHorario;
  readonly diaLargo = diaLargo;
  readonly h12 = hora12;

  readonly sel = signal<HrPersonaAsistencia | null>(null);
  readonly enMenu = signal<HrPersonaAsistencia | null>(null);
  readonly form = signal<FormHorario | null>(null);
  /** A quién va el horario: una persona, o null = las que se ven. */
  readonly destino = signal<HrPersonaAsistencia | null>(null);
  readonly guardando = signal(false);
  readonly exportando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);

  readonly puedeGestionar = computed(() => this.perms.has(Permission.HR_ATTENDANCE_GESTIONAR));
  readonly puedeCapturar = computed(() => this.perms.has(Permission.HR_INCIDENTS_CAPTURAR));
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
  /** Lo que se ve antes de «Solo irregulares»: departamentos y búsqueda. */
  readonly visibles = computed(() => {
    const deps = this.est.departamentos();
    const base = deps.length ? this.todas().filter((p) => deps.includes(departamentoDe(p))) : this.todas();
    return filtrarPorBusqueda(base, this.est.buscar(), (p) => [p.nombre, p.nombreCompleto, p.codigo]);
  });
  private readonly esIrregular = (p: HrPersonaAsistencia) => cuentaIrregular(this.irr().get(p.codigo) ?? [], 'alta') > 0;
  readonly nIrregulares = computed(() => this.visibles().filter(this.esIrregular).length);
  readonly filas = computed(() => (this.est.soloIrregulares() ? this.visibles().filter(this.esIrregular) : this.visibles()));
  readonly grupos = computed(() => porDepartamento(this.todas(), this.filas()));
  readonly conSubtotales = computed(() => !this.est.buscar().trim() && !this.est.soloIrregulares());
  readonly unica = computed(() => {
    const c = this.est.unica();
    return c ? this.todas().find((p) => p.codigo === c) ?? null : null;
  });
  readonly parcial = computed(() => etiquetaParcial({
    unica: null, departamentos: this.est.departamentos(), buscar: this.est.buscar(), soloIrregulares: this.est.soloIrregulares(),
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

  abrir(p: HrPersonaAsistencia): void { this.sel.set(p); this.form.set(null); this.aviso.set(null); }
  cerrar(): void { this.sel.set(null); this.form.set(null); this.aviso.set(null); }
  cambioFicha(abierta: boolean): void { if (!abierta) this.cerrar(); }
  soloEsta(p: HrPersonaAsistencia): void { this.cerrar(); this.est.unica.set(p.codigo); }

  menu(e: { persona: HrPersonaAsistencia; evento: Event }): void {
    this.enMenu.set(e.persona);
    this.acc()?.toggle(e.evento);
  }

  /** La captura vive en Incidencias: se llega con la persona, la plaza y la semana ya puestas. */
  capturar(p: HrPersonaAsistencia): void {
    void this.router.navigate(['/rh/incidencias'], { queryParams: { nueva: 1, site: this.est.sitio(), persona: p.codigo, desde: this.est.rango().desde } });
  }

  abrirHorario(p: HrPersonaAsistencia | null): void {
    const a = p?.horarioAsignado;
    this.aviso.set(null);
    this.destino.set(p);
    this.form.set({
      entrada: a?.entrada ?? p?.horario ?? '08:00', salida: a?.salida ?? p?.salida ?? '17:00', comida: a?.comidaMin ?? 60,
      sabado: a?.sabado ?? false, sabadoEntrada: a?.sabadoEntrada ?? '', sabadoSalida: a?.sabadoSalida ?? '',
    });
  }

  guardarHorario(): void {
    const f = this.form();
    const site = this.est.sitio();
    if (!f || !site) return;
    const p = this.destino();
    const codigos = p ? [p.codigo] : this.visibles().map((x) => x.codigo);
    if (!codigos.length) return;
    this.guardando.set(true);
    this.api.asignarHorario({
      site_code: site, person_codes: codigos, starts_at: f.entrada, ends_at: f.salida, lunch_minutes: Number(f.comida),
      works_saturday: f.sabado, saturday_starts_at: f.sabado ? f.sabadoEntrada : undefined, saturday_ends_at: f.sabado ? f.sabadoSalida : undefined,
    }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        this.form.set(null);
        this.aviso.set({ texto: `Horario guardado${r.guardados > 1 ? ` para ${r.guardados} personas` : ''}. Los números ya se miden contra él.`, mal: false });
        this.est.asegurar(true);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar el horario.'), mal: true }); },
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
      hoy: this.est.hoy(), mideRetardo: this.mide(),
    };
  }

  pdfPlaza(): void { void this.exportar(() => exportarPdfPlaza(this.grupos(), this.todas(), this.contexto(), this.conSubtotales())); }
  excel(): void { void this.exportar(() => exportarExcel(this.grupos(), this.todas(), this.contexto(), this.conSubtotales())); }
  pdfPersona(p: HrPersonaAsistencia): void { void this.exportar(() => exportarPdfPersona(p, this.contexto())); }

  private async exportar(fn: () => Promise<void>): Promise<void> {
    this.exportando.set(true);
    try { await fn(); }
    catch { this.aviso.set({ texto: 'No se pudo generar el archivo. Vuelve a intentarlo.', mal: true }); }
    finally { this.exportando.set(false); }
  }
}
