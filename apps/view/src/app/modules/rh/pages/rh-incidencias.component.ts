import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import type {
  HrAccionIncidencia, HrCapturaIncidenciaBody, HrCierreDto, HrIncidenciaDto, HrPasoIncidenciaDto, HrSiteDto, HrTipoIncidenciaDto,
} from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import {
  BANDERA_LABEL, ESTADO_INCIDENCIA_LABEL, RhService, etiquetaSemana, fechaCorta, hoyEnMexico, juevesDeLaSemana, rhError, sumarDias,
} from '../rh.service';

/**
 * Fase RH · `[RH.1.7]` — Incidencias y cierre de semana (`/rh/incidencias`). Antes: `incidencias-bandeja` y los
 * cierres de Mega Talento.
 *
 * El flujo lo decide el SERVIDOR (estados, quién puede qué, separación de funciones, semana cerrada); aquí sólo
 * se ofrecen los botones que pueden servir y se muestra su respuesta tal cual, 409 incluido. Una incidencia es
 * el único mecanismo para justificar un día (ver `[RH.1.5]` en la fase).
 */
type FiltroEstado = 'por_calificar' | 'vigentes' | 'rechazadas' | 'anuladas' | 'todas';
const FILTROS: Array<{ value: FiltroEstado; label: string; statuses: string }> = [
  { value: 'por_calificar', label: 'Por calificar', statuses: 'capturada' },
  { value: 'vigentes', label: 'Cuentan', statuses: 'calificada,cerrada,auditada' },
  { value: 'rechazadas', label: 'Rechazadas', statuses: 'rechazada' },
  { value: 'anuladas', label: 'Anuladas', statuses: 'anulada' },
  { value: 'todas', label: 'Todas', statuses: 'todas' },
];

interface FormCaptura {
  person_code: string; incident_type: string; date_from: string; date_to: string; note: string;
  horas: string; entrada: string; reason: string; authorized_by_name: string; deliver: boolean;
}

@Component({
  selector: 'app-rh-incidencias',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, InputTextModule, ButtonModule, LoadStateComponent, RhMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ri-page" [class.con-ficha]="!!sel()">
      <app-rh-marco [barra]="false" [franja]="false">
        <div acciones class="ri-head-btns">
          @if (puede.capturar()) { <p-button icon="pi pi-plus" label="Capturar incidencia" (onClick)="abrirCaptura()" /> }
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </app-rh-marco>
      <p class="ri-intro">Vacaciones, permisos, incapacidades, horas extra… Lo capturado no cuenta hasta que lo califica otra persona;
        al cerrar la semana para prenómina ya no se puede cambiar sin reabrirla.</p>

      <section class="ri-ctl" aria-label="Qué ver">
        <p-select [options]="sitios()" optionLabel="name" optionValue="code" [ngModel]="sitio()" (ngModelChange)="setSitio($event)"
                  placeholder="Sitio de checado" appendTo="body" ariaLabel="Sitio de checado" class="ri-sitio" />
        <div class="ri-semana" role="group" aria-label="Semana de nómina">
          <p-button icon="pi pi-chevron-left" [text]="true" severity="secondary" ariaLabel="Semana anterior" (onClick)="moverSemana(-7)" />
          <span class="mono">{{ etiqueta() }}</span>
          <p-button icon="pi pi-chevron-right" [text]="true" severity="secondary" ariaLabel="Semana siguiente" (onClick)="moverSemana(7)" />
        </div>
        @for (f of filtros; track f.value) {
          <button type="button" class="ri-chip" [class.on]="filtro() === f.value" (click)="setFiltro(f.value)">{{ f.label }}</button>
        }
      </section>

      <section class="ri-cierre" aria-label="Cierre de la semana">
        @if (cierreVigente(); as c) {
          <p><i class="pi pi-lock" aria-hidden="true"></i> Semana cerrada para prenómina@if (c.closed_by_name) { por {{ c.closed_by_name }} }
            · {{ c.summary?.incidencias ?? 0 }} incidencias · {{ c.summary?.faltas ?? 0 }} faltas.</p>
          @if (puede.cerrar()) {
            @if (modoReabrir()) {
              <input pInputText type="text" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Por qué se reabre (queda en el registro)" aria-label="Motivo para reabrir" />
              <p-button label="Reabrir" severity="danger" size="small" [disabled]="!motivo().trim()" [loading]="ocupado()" (onClick)="reabrir(c)" />
              <p-button label="Cancelar" [text]="true" size="small" (onClick)="modoReabrir.set(false)" />
            } @else {
              <p-button label="Reabrir semana" icon="pi pi-lock-open" [text]="true" size="small" (onClick)="modoReabrir.set(true); motivo.set('')" />
            }
          }
        } @else {
          <p><i class="pi pi-lock-open" aria-hidden="true"></i> Semana abierta.@if (!semanaTerminada()) { Se puede cerrar a partir del jueves siguiente. }</p>
          @if (puede.cerrar() && semanaTerminada()) {
            <p-button label="Cerrar semana para prenómina" icon="pi pi-lock" size="small" [loading]="ocupado()" (onClick)="cerrarSemana()" />
          }
        }
      </section>

      @if (aviso(); as a) { <p class="ri-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }

      @if (form(); as f) {
        <form class="ri-form" (ngSubmit)="guardarCaptura()" aria-label="Capturar incidencia">
          <h2>Capturar incidencia</h2>
          <label>Número de la persona <input pInputText name="persona" [(ngModel)]="f.person_code" required /></label>
          <label>Tipo
            <p-select [options]="tipos()" optionLabel="etiqueta" optionValue="tipo" name="tipo" [(ngModel)]="f.incident_type" appendTo="body" placeholder="Elige el tipo" ariaLabel="Tipo de incidencia" />
          </label>
          <label>Desde <input pInputText type="date" name="desde" [(ngModel)]="f.date_from" required /></label>
          @if (f.incident_type !== 'horario_distinto') {
            <label>Hasta <input pInputText type="date" name="hasta" [(ngModel)]="f.date_to" [min]="f.date_from" /></label>
          }
          @if (f.incident_type === 'horas_extra') {
            <label>Horas extra usadas <input pInputText type="time" name="horas" [(ngModel)]="f.horas" required /></label>
          }
          @if (f.incident_type === 'horario_distinto') {
            <label>Entró a las <input pInputText type="time" name="entrada" [(ngModel)]="f.entrada" required /></label>
            <label class="ri-ancho">Por qué entró en otro horario <input pInputText name="motivo" [(ngModel)]="f.reason" required /></label>
            <label>Quién lo autorizó <input pInputText name="autorizo" [(ngModel)]="f.authorized_by_name" required /></label>
          }
          <label class="ri-ancho">Nota (folio, motivo) <input pInputText name="nota" [(ngModel)]="f.note" [required]="f.incident_type === 'otros'" /></label>
          @if (puede.calificar()) {
            <label class="ri-check"><input type="checkbox" name="entregar" [(ngModel)]="f.deliver" /> Entregarla para que la califique otra persona</label>
          }
          <div class="ri-form-btns">
            <p-button type="submit" label="Guardar" [loading]="ocupado()" />
            <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="form.set(null)" />
          </div>
        </form>
      }

      <app-load-state [loading]="loading() && !lista().length" [error]="error()" [isEmpty]="!loading() && !error() && !lista().length"
                      emptyIcon="pi-file-edit" emptyTitle="No hay incidencias con este filtro" emptyHint="Prueba otra semana u otro estado." (retry)="cargar()">
        <div class="ri-body" [class.has-detail]="!!sel()">
          <section class="ri-list" aria-label="Incidencias">
            <div class="ri-wrap dt-scope">
              <table class="ri-table dt-stack">
                <thead><tr><th>Persona</th><th>Tipo</th><th>Periodo</th><th>Estado</th><th class="opc">Banderas</th><th class="opc">Capturó</th></tr></thead>
                <tbody>
                  @for (i of lista(); track i.id) {
                    <tr [class.sel]="sel()?.id === i.id" (click)="abrir(i)" tabindex="0" (keydown.enter)="abrir(i)">
                      <td class="mono dt-id" role="cell" data-label="Persona">#{{ i.person_code }}</td>
                      <td role="cell" data-label="Tipo"><b class="mono">{{ tipoDe(i)?.codigo ?? 'OTR' }}</b> {{ tipoDe(i)?.etiqueta ?? i.incident_type }}</td>
                      <td class="mono" role="cell" data-label="Periodo">{{ periodo(i) }}</td>
                      <td role="cell" data-label="Estado"><span class="pill" [attr.data-s]="i.status">{{ estadoLabel[i.status] }}</span></td>
                      <td class="opc" role="cell" data-label="Banderas">@for (b of i.banderas ?? []; track b) { <span class="flag" [title]="banderaLabel[b]">{{ banderaLabel[b] }}</span> }</td>
                      <td class="opc" role="cell" data-label="Capturó">{{ i.created_by_name || '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          @if (sel(); as i) {
            <section class="ri-detail" aria-label="Ficha de la incidencia">
              <header class="ri-dhead">
                <div>
                  <h2>{{ tipoDe(i)?.etiqueta ?? i.incident_type }} · #{{ i.person_code }}</h2>
                  <p class="mono">{{ periodo(i) }} · <span class="pill" [attr.data-s]="i.status">{{ estadoLabel[i.status] }}</span></p>
                </div>
                <p-button icon="pi pi-times" [text]="true" severity="secondary" ariaLabel="Cerrar ficha" (onClick)="cerrar()" />
              </header>
              <dl class="ri-dl">
                @if (i.note) { <dt>Nota</dt><dd>{{ i.note }}</dd> }
                @if (i.minutes !== null) { <dt>{{ i.incident_type === 'horario_distinto' ? 'Entró a las' : 'Minutos' }}</dt><dd class="mono">{{ i.incident_type === 'horario_distinto' ? hhmm(i.minutes) : i.minutes }}</dd> }
                @if (i.authorized_by_name) { <dt>Autorizó</dt><dd>{{ i.authorized_by_name }}</dd> }
                <dt>Capturó</dt><dd>{{ i.created_by_name || '—' }}</dd>
                @if (i.rated_by_name) { <dt>{{ i.status === 'rechazada' ? 'Rechazó' : 'Calificó' }}</dt><dd>{{ i.rated_by_name }}</dd> }
                @if (i.rejection_reason) { <dt>Motivo del rechazo</dt><dd>{{ i.rejection_reason }}</dd> }
                @if (i.audited_by_name) { <dt>Auditó</dt><dd>{{ i.audited_by_name }}@if (i.audit_note) { — {{ i.audit_note }} }</dd> }
                @if (i.voided_by_name) { <dt>Anuló</dt><dd>{{ i.voided_by_name }} — {{ i.void_reason }}</dd> }
              </dl>
              @if ((i.banderas ?? []).length) {
                <ul class="ri-flags">@for (b of i.banderas ?? []; track b) { <li>{{ banderaLabel[b] }}</li> }</ul>
              }

              @if (acciones(i).length) {
                <div class="ri-acciones">
                  @for (a of acciones(i); track a.accion) {
                    <p-button [label]="a.label" [severity]="a.peligro ? 'danger' : 'primary'" [outlined]="a.peligro" size="small"
                              [loading]="ocupado()" (onClick)="elegir(i, a.accion, a.motivo)" />
                  }
                </div>
              }
              @if (pendiente(); as p) {
                <div class="ri-motivo">
                  <label>{{ p.accion === 'auditar' ? 'Nota de auditoría (opcional)' : 'Motivo (queda en el registro)' }}
                    <input pInputText [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" aria-label="Motivo" />
                  </label>
                  <p-button label="Confirmar" size="small" [disabled]="p.accion !== 'auditar' && !motivo().trim()" [loading]="ocupado()" (onClick)="ejecutar(i, p.accion)" />
                  <p-button label="Cancelar" [text]="true" size="small" (onClick)="pendiente.set(null)" />
                </div>
              }

              <h3>Bitácora</h3>
              <ol class="ri-log">
                @for (l of bitacora(); track $index) {
                  <li><span class="mono">{{ l.acted_at | date: 'd MMM HH:mm' }}</span> {{ l.action }}@if (l.actor_name) { · {{ l.actor_name }} }@if (l.detail) { — {{ l.detail }} }</li>
                } @empty { <li class="muted">Sin pasos registrados.</li> }
              </ol>
            </section>
          }
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ri-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .ri-intro { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 90ch; }
    .ri-head-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ri-ctl { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .ri-sitio { min-width: 200px; }
    .ri-semana { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-1); background: var(--card-bg); }
    .ri-semana span { font-size: var(--fs-sm); color: var(--text-main); min-width: 12rem; text-align: center; }
    .ri-chip { border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-muted); border-radius: var(--r-pill); padding: 4px var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .ri-chip.on { border-color: var(--action); color: var(--text-main); background: var(--surface-selected-bg); }
    .ri-chip:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ri-cierre { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); }
    .ri-cierre p { margin: 0; color: var(--text-main); }
    .ri-cierre input { min-width: 18rem; }
    .ri-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ri-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .ri-form { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .ri-form h2 { flex: 1 1 100%; margin: 0; font-size: var(--fs-h3); color: var(--text-main); }
    .ri-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ri-form .ri-ancho { flex: 1 1 18rem; }
    .ri-form .ri-check { flex-direction: row; align-items: center; gap: var(--sp-2); }
    .ri-form-btns { display: flex; gap: var(--sp-2); }
    .ri-body { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
    .ri-body.has-detail { grid-template-columns: minmax(0, 1.2fr) minmax(380px, 1fr); }
    .ri-list, .ri-detail { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .ri-wrap { overflow: auto; max-height: calc(100vh - 360px); }
    .ri-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ri-table th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600; color: var(--text-muted); font-size: var(--fs-micro); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .ri-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: top; }
    .ri-table tbody tr { cursor: pointer; }
    .ri-table tbody tr:hover { background: var(--surface-hover-bg); }
    .ri-table tbody tr.sel { background: var(--surface-selected-bg); }
    .ri-table tbody tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-s='capturada'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill[data-s='calificada'], .pill[data-s='cerrada'], .pill[data-s='auditada'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pill[data-s='rechazada'], .pill[data-s='anulada'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .flag { display: inline-block; margin: 0 var(--sp-1) var(--sp-1) 0; padding: 1px var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .ri-detail { padding: var(--sp-4); position: sticky; top: var(--sp-4); max-height: calc(100vh - 2 * var(--sp-4)); overflow: auto; display: flex; flex-direction: column; gap: var(--sp-3); }
    .ri-dhead { display: flex; justify-content: space-between; gap: var(--sp-3); }
    .ri-dhead h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .ri-dhead p { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ri-dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .ri-dl dt { color: var(--text-muted); }
    .ri-dl dd { margin: 0; color: var(--text-main); overflow-wrap: anywhere; }
    .ri-flags { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-sm); color: var(--warn-soft-fg); }
    .ri-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ri-motivo { display: flex; gap: var(--sp-2); align-items: flex-end; flex-wrap: wrap; }
    .ri-motivo label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); flex: 1 1 16rem; }
    .ri-detail h3 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .ri-log { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-xs); color: var(--text-main); display: flex; flex-direction: column; gap: var(--sp-1); }
    .muted { color: var(--text-muted); }
    .ri-body.has-detail .opc { display: none; }
    @media (max-width: 68.75rem) {
      .ri-body.has-detail { grid-template-columns: 1fr; }
      .ri-body.has-detail .ri-list { display: none; }
      .ri-detail { position: static; max-height: none; }
    }
    @media (max-width: 40rem) {
      .ri-page { padding: var(--sp-3); }
      .ri-cierre input { min-width: 0; flex: 1 1 100%; }
      .ri-wrap { max-height: none; }
    }
  `],
})
export class RhIncidenciasComponent implements OnInit {
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  /** `[RH.1.7c]` La plaza y la semana que se estaban viendo en las otras pestañas. */
  private readonly est = inject(RhAsistenciaEstado);

  readonly filtros = FILTROS;
  readonly estadoLabel = ESTADO_INCIDENCIA_LABEL;
  readonly banderaLabel = BANDERA_LABEL;

  readonly sitios = signal<HrSiteDto[]>([]);
  readonly sitio = signal<string | null>(null);
  readonly jueves = signal(juevesDeLaSemana(hoyEnMexico()));
  readonly filtro = signal<FiltroEstado>('por_calificar');
  readonly tipos = signal<HrTipoIncidenciaDto[]>([]);
  readonly lista = signal<HrIncidenciaDto[]>([]);
  readonly cierres = signal<HrCierreDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sel = signal<HrIncidenciaDto | null>(null);
  readonly bitacora = signal<HrPasoIncidenciaDto[]>([]);
  readonly form = signal<FormCaptura | null>(null);
  readonly ocupado = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly pendiente = signal<{ accion: HrAccionIncidencia } | null>(null);
  readonly motivo = signal('');
  readonly modoReabrir = signal(false);

  readonly puede = {
    capturar: computed(() => this.perms.has(Permission.HR_INCIDENTS_CAPTURAR)),
    calificar: computed(() => this.perms.has(Permission.HR_INCIDENTS_CALIFICAR)),
    auditar: computed(() => this.perms.has(Permission.HR_INCIDENTS_AUDITAR)),
    cerrar: computed(() => this.perms.has(Permission.HR_PERIOD_CLOSE)),
  };

  readonly etiqueta = computed(() => etiquetaSemana(this.jueves()));
  /** Sólo se cierra lo que ya pasó: el miércoles que cierra la semana tiene que ser antes de hoy. */
  readonly semanaTerminada = computed(() => sumarDias(this.jueves(), 6) < hoyEnMexico());
  readonly cierreVigente = computed(() => this.cierres().find((c) => c.vigente && c.period_start === this.jueves()) ?? null);
  private readonly tiposPorClave = computed(() => new Map(this.tipos().map((t) => [t.tipo, t])));

  ngOnInit(): void {
    const q = this.route.snapshot?.queryParamMap;
    const siteQ = q?.get('site');
    const desdeQ = q?.get('desde');
    if (desdeQ) this.jueves.set(juevesDeLaSemana(desdeQ));
    else if (this.est.sitio()) this.jueves.set(this.est.modoHoy() ? juevesDeLaSemana(this.est.hoy()) : this.est.jueves());
    this.api.tiposIncidencia().subscribe({ next: (t) => this.tipos.set(t), error: () => this.tipos.set([]) });
    this.api.sitios().subscribe({
      next: (s) => {
        const activos = s.filter((x) => x.is_active);
        this.sitios.set(activos);
        const previo = this.est.sitio();
        const inicial = siteQ && activos.some((x) => x.code === siteQ) ? siteQ
          : previo && activos.some((x) => x.code === previo) ? previo : activos[0]?.code ?? null;
        this.sitio.set(inicial);
        if (inicial) this.cargar();
        if (q?.get('nueva') === '1') this.abrirCaptura(q.get('persona') ?? '', desdeQ ?? '');
      },
      error: (e) => this.error.set(rhError(e, 'No se pudieron leer los sitios de checado.')),
    });
  }

  private seq = 0;
  cargar(): void {
    const site = this.sitio();
    if (!site) return;
    const mi = ++this.seq;
    const statuses = FILTROS.find((f) => f.value === this.filtro())?.statuses;
    this.loading.set(true);
    this.error.set(null);
    this.api.incidencias({ site_code: site, date_from: this.jueves(), date_to: sumarDias(this.jueves(), 6), statuses }).subscribe({
      next: (l) => {
        if (mi !== this.seq) return;
        this.lista.set(l);
        this.loading.set(false);
        this.est.refrescarIncidencias();
        const s = this.sel();
        if (s) this.sel.set(l.find((x) => x.id === s.id) ?? null);
      },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudieron leer las incidencias.')); this.loading.set(false); },
    });
    this.api.cierres(site).subscribe({ next: (c) => this.cierres.set(c), error: () => this.cierres.set([]) });
  }

  setSitio(s: string): void { this.sitio.set(s); this.sel.set(null); this.est.setSitio(s); this.cargar(); }
  setFiltro(f: FiltroEstado): void { this.filtro.set(f); this.cargar(); }
  moverSemana(d: number): void { this.jueves.set(sumarDias(this.jueves(), d)); this.sel.set(null); this.est.irASemana(this.jueves()); this.cargar(); }

  abrir(i: HrIncidenciaDto): void {
    this.sel.set(i);
    this.pendiente.set(null);
    this.bitacora.set([]);
    this.api.bitacora(i.id).subscribe({ next: (b) => this.bitacora.set(b), error: () => this.bitacora.set([]) });
  }
  cerrar(): void { this.sel.set(null); this.pendiente.set(null); }

  tipoDe(i: HrIncidenciaDto): HrTipoIncidenciaDto | undefined { return this.tiposPorClave().get(i.incident_type); }
  periodo(i: HrIncidenciaDto): string { return i.date_from === i.date_to ? fechaCorta(i.date_from) : `${fechaCorta(i.date_from)} – ${fechaCorta(i.date_to)}`; }
  hhmm(min: number | null): string { return min == null ? '—' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }

  /**
   * Los botones que PUEDEN servir. El servidor vuelve a decidir (y responde con su motivo): esto sólo evita
   * ofrecer lo que de seguro rebota. Auditar no se ofrece a quien capturó o calificó — el servidor y la base
   * lo impiden igual, pero un botón que siempre falla enseña a desconfiar de todos.
   */
  acciones(i: HrIncidenciaDto): Array<{ accion: HrAccionIncidencia; label: string; motivo: boolean; peligro: boolean }> {
    const out: Array<{ accion: HrAccionIncidencia; label: string; motivo: boolean; peligro: boolean }> = [];
    const califica = this.puede.calificar();
    if (i.status === 'capturada' && califica) {
      out.push({ accion: 'calificar', label: 'Calificar', motivo: false, peligro: false });
      out.push({ accion: 'rechazar', label: 'Rechazar', motivo: true, peligro: true });
    }
    if ((i.status === 'capturada' && (califica || this.puede.capturar())) || (i.status === 'calificada' && califica)) {
      out.push({ accion: 'anular', label: 'Quitar', motivo: true, peligro: true });
    }
    if (i.status === 'cerrada' && this.puede.auditar()) out.push({ accion: 'auditar', label: 'Auditar', motivo: true, peligro: false });
    return out;
  }

  elegir(i: HrIncidenciaDto, accion: HrAccionIncidencia, conMotivo: boolean): void {
    this.motivo.set('');
    if (conMotivo) { this.pendiente.set({ accion }); return; }
    this.ejecutar(i, accion);
  }

  ejecutar(i: HrIncidenciaDto, accion: HrAccionIncidencia): void {
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.paso(i.id, accion, this.motivo().trim()).subscribe({
      next: (n) => {
        this.ocupado.set(false);
        this.pendiente.set(null);
        this.sel.set(n);
        this.aviso.set({ texto: `Listo: la incidencia quedó ${this.estadoLabel[n.status].toLowerCase()}.`, mal: false });
        this.abrir(n);
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo completar el paso.'), mal: true }); },
    });
  }

  abrirCaptura(persona = '', desde = ''): void {
    this.aviso.set(null);
    this.form.set({
      person_code: persona, incident_type: 'vacaciones', date_from: desde || hoyEnMexico(), date_to: '',
      note: '', horas: '', entrada: '', reason: '', authorized_by_name: '', deliver: false,
    });
  }

  /** Lo que se manda al servidor; público para que la prueba verifique QUÉ se envía. */
  cuerpoCaptura(f: FormCaptura, site: string): HrCapturaIncidenciaBody {
    const aMin = (t: string): number | undefined => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
    };
    const distinto = f.incident_type === 'horario_distinto';
    return {
      site_code: site, person_code: f.person_code.trim(), incident_type: f.incident_type, date_from: f.date_from,
      date_to: distinto ? undefined : f.date_to || undefined, note: f.note.trim() || undefined,
      minutes: f.incident_type === 'horas_extra' ? aMin(f.horas) : distinto ? aMin(f.entrada) : undefined,
      reason: distinto ? f.reason.trim() : undefined, authorized_by_name: distinto ? f.authorized_by_name.trim() : undefined,
      deliver: f.deliver || undefined,
    };
  }

  guardarCaptura(): void {
    const f = this.form();
    const site = this.sitio();
    if (!f || !site) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.capturar(this.cuerpoCaptura(f, site)).subscribe({
      next: (n) => {
        this.ocupado.set(false);
        this.form.set(null);
        this.aviso.set({ texto: n.status === 'calificada' ? 'Guardada y calificada: ya cuenta en la asistencia.' : 'Guardada. Cuenta cuando otra persona la califique.', mal: false });
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar la incidencia.'), mal: true }); },
    });
  }

  cerrarSemana(): void {
    const site = this.sitio();
    if (!site) return;
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.cerrarSemana(site, this.jueves()).subscribe({
      next: () => { this.ocupado.set(false); this.aviso.set({ texto: 'Semana cerrada: se guardó la foto para prenómina.', mal: false }); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo cerrar la semana.'), mal: true }); },
    });
  }

  reabrir(c: HrCierreDto): void {
    this.ocupado.set(true);
    this.aviso.set(null);
    this.api.reabrirSemana(c.id, this.motivo().trim()).subscribe({
      next: () => { this.ocupado.set(false); this.modoReabrir.set(false); this.aviso.set({ texto: 'Semana reabierta. La foto anterior se conserva.', mal: false }); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo reabrir la semana.'), mal: true }); },
    });
  }
}
