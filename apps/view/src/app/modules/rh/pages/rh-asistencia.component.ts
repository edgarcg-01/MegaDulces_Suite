import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrAsistenciaResponse, HrDiaAsistencia, HrPersonaAsistencia, HrSiteDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import {
  ESTADO_DIA_LABEL, RhService, etiquetaSemana, fechaCorta, hoyEnMexico, juevesDeLaSemana, minutosTexto, rhError, sumarDias,
} from '../rh.service';

/**
 * Fase RH · `[RH.1.7]` — Asistencia por persona (`/rh/asistencia`). Antes: `horarios` + `asistencia-resumen` de
 * Mega Talento. El número sale del servidor (la regla trasladada, con paridad 0 contra Mega Talento); aquí no
 * se recalcula nada.
 *
 * Operations (DESIGN.md): tabla densa a la izquierda, ficha a la derecha; abajo de 1100 px la ficha reemplaza
 * a la lista. Primero lo que hay que ATENDER: el servidor ya ordena por «no usable» → «con duda» → retardo.
 */
@Component({
  selector: 'app-rh-asistencia',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, InputTextModule, ButtonModule, LoadStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ra-page" [class.con-ficha]="!!sel()">
      <header class="ra-head">
        <div>
          <h1>Asistencia</h1>
          <p>El horario de cada persona sale de sus propias checadas. La tolerancia es de {{ datos()?.bolsaSemanalMin ?? 15 }} min por semana
            (jueves a miércoles) y sólo cuenta lo que la excede.</p>
        </div>
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
      </header>

      <section class="ra-ctl" aria-label="Qué ver">
        <p-select [options]="sitios()" optionLabel="name" optionValue="code" [ngModel]="sitio()" (ngModelChange)="setSitio($event)"
                  placeholder="Sitio de checado" appendTo="body" ariaLabel="Sitio de checado" class="ra-sitio" />
        <div class="ra-semana" role="group" aria-label="Semana de nómina">
          <p-button icon="pi pi-chevron-left" [text]="true" severity="secondary" ariaLabel="Semana anterior" (onClick)="moverSemana(-7)" />
          <span class="mono">{{ etiqueta() }}</span>
          <p-button icon="pi pi-chevron-right" [text]="true" severity="secondary" ariaLabel="Semana siguiente" [disabled]="esSemanaActual()" (onClick)="moverSemana(7)" />
        </div>
        <div class="ra-seg" role="group" aria-label="A quién">
          <button type="button" [class.on]="!soloPromotoras()" (click)="setPromotoras(false)">Personal de planta</button>
          <button type="button" [class.on]="soloPromotoras()" (click)="setPromotoras(true)">Promotoras</button>
        </div>
        <span class="ra-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Buscar persona o número" [ngModel]="buscar()" (ngModelChange)="buscar.set($event)" aria-label="Buscar persona" />
        </span>
      </section>

      @if (datos(); as d) {
        <section class="ra-kpis" aria-label="Resumen de la semana">
          <div class="ra-kpi"><b>{{ d.resumen.personas }}</b><span>Personas</span></div>
          <div class="ra-kpi" [class.warn]="d.resumen.conPendiente > 0"><b>{{ d.resumen.conPendiente }}</b><span>Con algo que revisar</span></div>
          <div class="ra-kpi" [class.bad]="d.resumen.faltas > 0"><b>{{ d.resumen.faltas }}</b><span>Faltas</span></div>
          <div class="ra-kpi"><b>{{ d.resumen.retardoRealUsableMin }}</b><span>Min de retardo real (de fiar)</span></div>
          <div class="ra-kpi"><b>{{ d.resumen.horasTrabajadas }}</b><span>Horas trabajadas</span></div>
        </section>
      }

      <app-load-state [loading]="loading() && !datos()" [error]="error()" [isEmpty]="!loading() && !error() && !!datos() && !visibles().length"
                      emptyIcon="pi-users" [emptyTitle]="buscar() ? 'Nadie coincide con la búsqueda' : 'Nadie checó en esta semana'"
                      [emptyHint]="buscar() ? null : 'Revisa que el reloj del sitio esté mandando checadas (Relojes).'" (retry)="cargar()">
        <div class="ra-body" [class.has-detail]="!!sel()">
          <section class="ra-list" aria-label="Personas">
            <div class="ra-wrap dt-scope">
              <table class="ra-table dt-stack">
                <thead>
                  <tr><th>Persona</th><th>Horario</th><th class="num">Retardo real</th><th class="num">Faltas</th><th class="num opc">Horas</th><th>Revisar</th></tr>
                </thead>
                <tbody>
                  @for (p of visibles(); track p.codigo) {
                    <tr [class.sel]="sel()?.codigo === p.codigo" (click)="abrir(p)" tabindex="0" (keydown.enter)="abrir(p)">
                      <td class="dt-id" role="cell" data-label="Persona">
                        <span class="ra-nombre">{{ p.nombreCompleto || p.nombre }}</span>
                        <small class="mono">#{{ p.codigo }}@if (!p.registrado) { · sin ligar a una persona }</small>
                      </td>
                      <td role="cell" data-label="Horario"><span class="mono">{{ horario(p) }}</span><small>{{ tipoLabel[p.tipo] }}</small></td>
                      <td class="num" role="cell" data-label="Retardo real">{{ p.retardoRealMin || '—' }}</td>
                      <td class="num" role="cell" data-label="Faltas">{{ p.faltas || '—' }}</td>
                      <td class="num opc" role="cell" data-label="Horas">{{ p.horasTrabajadas || '—' }}</td>
                      <td role="cell" data-label="Revisar">
                        @if (!p.usable) { <span class="pill bad">No usar</span> }
                        @else if (tieneDuda(p)) { <span class="pill warn">Revisar</span> }
                        @else { <span class="pill ok">Bien</span> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          @if (sel(); as p) {
            <section class="ra-detail" aria-label="Ficha de la persona">
              <p-button class="ra-back" icon="pi pi-arrow-left" label="Volver a la lista" [text]="true" severity="secondary" size="small" (onClick)="cerrar()" />
              <header class="ra-dhead">
                <div>
                  <h2>{{ p.nombreCompleto || p.nombre }}</h2>
                  <p class="mono">#{{ p.codigo }} · {{ tipoLabel[p.tipo] }}@if (p.horario) { · entra {{ p.horario }} }@if (p.salida) { · sale {{ p.salida }} }</p>
                </div>
                <p-button icon="pi pi-times" [text]="true" severity="secondary" ariaLabel="Cerrar ficha" (onClick)="cerrar()" />
              </header>

              <div class="ra-nums">
                <div><b>{{ p.retardoRealMin }}</b><span>min de retardo real</span></div>
                <div><b>{{ p.atrasoBrutoMin }}</b><span>min de atraso bruto</span></div>
                <div><b>{{ p.faltas }}</b><span>faltas@if (p.faltasJustificadas) { (+{{ p.faltasJustificadas }} justificadas) }</span></div>
                <div><b>{{ p.pctATiempo === null ? '—' : p.pctATiempo + '%' }}</b><span>a tiempo</span></div>
              </div>

              @if (p.marcas.length) {
                <ul class="ra-marcas" aria-label="Por qué revisar">
                  @for (m of p.marcas; track m.codigo) {
                    <li [attr.data-g]="m.gravedad"><span class="pill" [ngClass]="claseGravedad(m.gravedad)">{{ gravedadLabel[m.gravedad] }}</span> {{ m.detalle }}</li>
                  }
                </ul>
              }

              @for (s of p.semanas; track s.inicio) {
                <div class="ra-sem">
                  <h3>Semana del {{ fechaCorta(s.inicio) }} <span>· tolerancia restante {{ s.bolsaRestante }} de {{ s.bolsaInicial }} min · {{ minutosTexto(s.minutosTrabajados) }} trabajados</span></h3>
                  <table class="ra-dias">
                    <thead><tr><th>Día</th><th>Estado</th><th>Entrada</th><th>Salida</th><th>Comida</th><th class="num">Horas</th><th class="num">Retardo</th></tr></thead>
                    <tbody>
                      @for (dd of s.dias; track dd.fecha) {
                        <tr>
                          <td class="mono">{{ fechaCorta(dd.fecha) }}</td>
                          <td>
                            <span class="pill" [ngClass]="claseEstado(dd)">{{ estadoLabel[dd.estado] }}</span>
                            @for (i of dd.incidencias ?? []; track i.id) { <span class="inc" [title]="i.etiqueta">{{ i.codigo }}</span> }
                          </td>
                          <td class="mono">{{ dd.entrada || dd.hora || '—' }}</td>
                          <td class="mono">{{ dd.salida || '—' }}</td>
                          <td class="mono ra-comida">{{ dd.comida }}</td>
                          <td class="num">{{ dd.horasNetas }}</td>
                          <td class="num">{{ dd.retardoRealMin || '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }

              <div class="ra-acciones">
                @if (puedeCapturar()) {
                  <p-button icon="pi pi-file-edit" label="Capturar incidencia" severity="secondary" [outlined]="true" size="small" (onClick)="capturar(p)" />
                }
                @if (puedeGestionar()) {
                  <p-button icon="pi pi-clock" [label]="p.horarioAsignado ? 'Cambiar horario' : 'Asignar horario'" severity="secondary" [outlined]="true" size="small" (onClick)="abrirHorario(p)" />
                  @if (p.horarioAsignado) {
                    <p-button icon="pi pi-undo" label="Volver al horario deducido" [text]="true" size="small" [loading]="guardando()" (onClick)="quitarHorario(p)" />
                  }
                }
              </div>

              @if (formHorario(); as f) {
                <form class="ra-form" (ngSubmit)="guardarHorario(p)" aria-label="Horario de la persona">
                  <p class="ra-form-nota">Manda sobre la deducción: contra él se miden el retardo, las faltas, la salida y la comida.</p>
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
                    <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="formHorario.set(null)" />
                  </div>
                </form>
              }
              @if (aviso(); as a) { <p class="ra-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
            </section>
          }
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ra-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .ra-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .ra-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); letter-spacing: -0.01em; }
    .ra-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 70ch; }
    .ra-ctl { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .ra-sitio { min-width: 200px; }
    .ra-semana { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-1); background: var(--card-bg); }
    .ra-semana span { font-size: var(--fs-sm); color: var(--text-main); min-width: 12rem; text-align: center; }
    .ra-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .ra-seg button { border: 0; background: var(--card-bg); color: var(--text-muted); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
    .ra-seg button.on { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .ra-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .ra-search { position: relative; flex: 1 1 220px; max-width: 320px; margin-left: auto; }
    .ra-search i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: var(--fs-xs); }
    .ra-search input { width: 100%; padding-left: 30px; }
    .ra-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--sp-3); }
    .ra-kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ra-kpi b { font: 700 var(--fs-h2)/1 var(--font-mono); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .ra-kpi span { font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-kpi.warn b { color: var(--warn-fg); }
    .ra-kpi.bad b { color: var(--bad-fg); }
    .ra-body { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
    .ra-body.has-detail { grid-template-columns: minmax(0, 1fr) minmax(420px, 1.2fr); }
    .ra-list, .ra-detail { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .ra-wrap { overflow: auto; max-height: calc(100vh - 340px); }
    .ra-table, .ra-dias { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ra-table th, .ra-dias th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600; color: var(--text-muted);
      font-size: var(--fs-micro); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .ra-table td, .ra-dias td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: top; }
    .ra-table tbody tr { cursor: pointer; }
    .ra-table tbody tr:hover { background: var(--surface-hover-bg); }
    .ra-table tbody tr.sel { background: var(--surface-selected-bg); }
    .ra-table tbody tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .ra-nombre { font-weight: 600; overflow-wrap: anywhere; }
    td small { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pill.warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .inc { display: inline-block; margin-left: var(--sp-1); font: 600 var(--fs-xs)/1 var(--font-mono); color: var(--info-soft-fg); }
    .ra-detail { padding: var(--sp-4); position: sticky; top: var(--sp-4); max-height: calc(100vh - 2 * var(--sp-4)); overflow: auto; display: flex; flex-direction: column; gap: var(--sp-3); }
    .ra-dhead { display: flex; justify-content: space-between; gap: var(--sp-3); }
    .ra-dhead h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .ra-dhead p { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-nums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-2); }
    .ra-nums div { display: flex; flex-direction: column; padding: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ra-nums b { font: 700 var(--fs-h3)/1.1 var(--font-mono); color: var(--text-main); }
    .ra-nums span { font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-marcas { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .ra-sem h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .ra-sem h3 span { font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); }
    .ra-comida { font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ra-form { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); }
    .ra-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form input[type='number'] { width: 6rem; }
    .ra-form .ra-check { flex-direction: row; align-items: center; gap: var(--sp-2); }
    .ra-form-nota { flex: 1 1 100%; margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ra-form-btns { display: flex; gap: var(--sp-2); }
    .ra-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .ra-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .ra-back { display: none; }
    .ra-body.has-detail .opc { display: none; }
    @media (max-width: 68.75rem) {
      .ra-body.has-detail { grid-template-columns: 1fr; }
      .ra-body.has-detail .ra-list { display: none; }
      .ra-detail { position: static; max-height: none; }
      .ra-back { display: inline-flex; align-self: flex-start; }
      .ra-page.con-ficha .ra-kpis, .ra-page.con-ficha .ra-ctl, .ra-page.con-ficha .ra-head { display: none; }
    }
    @media (max-width: 40rem) {
      .ra-page { padding: var(--sp-3); }
      .ra-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ra-nums { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ra-search { margin-left: 0; max-width: none; }
      .ra-wrap { max-height: none; }
    }
  `],
})
export class RhAsistenciaComponent implements OnInit {
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);
  private readonly router = inject(Router);

  readonly estadoLabel = ESTADO_DIA_LABEL;
  readonly tipoLabel: Record<HrPersonaAsistencia['tipo'], string> = {
    fijo: 'Horario fijo', rotativo: 'Rota turnos', sin_patron: 'Sin horario reconocible', sin_datos: 'Sin datos suficientes',
  };
  readonly gravedadLabel: Record<string, string> = { alta: 'Bloquea', media: 'Revisar', info: 'Nota', ok: 'Confirmado' };
  readonly fechaCorta = fechaCorta;
  readonly minutosTexto = minutosTexto;

  readonly sitios = signal<HrSiteDto[]>([]);
  readonly sitio = signal<string | null>(null);
  readonly jueves = signal(juevesDeLaSemana(hoyEnMexico()));
  readonly soloPromotoras = signal(false);
  readonly buscar = signal('');
  readonly datos = signal<HrAsistenciaResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sel = signal<HrPersonaAsistencia | null>(null);
  readonly formHorario = signal<{ entrada: string; salida: string; comida: number; sabado: boolean; sabadoEntrada: string; sabadoSalida: string } | null>(null);
  readonly guardando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);

  readonly etiqueta = computed(() => etiquetaSemana(this.jueves()));
  readonly esSemanaActual = computed(() => this.jueves() >= juevesDeLaSemana(hoyEnMexico()));
  readonly visibles = computed(() => filtrarPorBusqueda(this.datos()?.personas ?? [], this.buscar(), (p) => [p.nombre, p.nombreCompleto, p.codigo]));
  readonly puedeGestionar = computed(() => this.perms.has(Permission.HR_ATTENDANCE_GESTIONAR));
  readonly puedeCapturar = computed(() => this.perms.has(Permission.HR_INCIDENTS_CAPTURAR));

  ngOnInit(): void {
    this.api.sitios().subscribe({
      next: (s) => {
        const activos = s.filter((x) => x.is_active);
        this.sitios.set(activos);
        if (!this.sitio() && activos.length) { this.sitio.set(activos[0].code); this.cargar(); }
      },
      error: (e) => this.error.set(rhError(e, 'No se pudieron leer los sitios de checado.')),
    });
  }

  /** El rango que se pide: la semana de nómina, recortada a hoy (lo que no ha pasado no se mide). */
  rango(): { desde: string; hasta: string } {
    const desde = this.jueves();
    const fin = sumarDias(desde, 6);
    const hoy = hoyEnMexico();
    return { desde, hasta: fin > hoy ? hoy : fin };
  }

  private seq = 0;
  cargar(): void {
    const site = this.sitio();
    if (!site) return;
    const mi = ++this.seq;
    const { desde, hasta } = this.rango();
    this.loading.set(true);
    this.error.set(null);
    this.api.asistencia({ site_code: site, date_from: desde, date_to: hasta, only_promoters: this.soloPromotoras() }).subscribe({
      next: (d) => {
        if (mi !== this.seq) return;
        this.datos.set(d);
        this.loading.set(false);
        const s = this.sel();
        this.sel.set(s ? d.personas.find((p) => p.codigo === s.codigo) ?? null : null);
      },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudo calcular la asistencia.')); this.loading.set(false); },
    });
  }

  setSitio(s: string): void { this.sitio.set(s); this.sel.set(null); this.cargar(); }
  setPromotoras(v: boolean): void { this.soloPromotoras.set(v); this.sel.set(null); this.cargar(); }
  moverSemana(dias: number): void { this.jueves.set(sumarDias(this.jueves(), dias)); this.cargar(); }

  abrir(p: HrPersonaAsistencia): void { this.sel.set(p); this.formHorario.set(null); this.aviso.set(null); }
  cerrar(): void { this.sel.set(null); this.formHorario.set(null); this.aviso.set(null); }

  horario(p: HrPersonaAsistencia): string {
    const t = p.turnos.filter(Boolean);
    return t.length > 1 ? t.join(' / ') : (p.horario ?? '—');
  }
  tieneDuda(p: HrPersonaAsistencia): boolean { return p.marcas.some((m) => m.gravedad === 'media'); }
  claseGravedad(g: string): string { return g === 'alta' ? 'bad' : g === 'media' ? 'warn' : g === 'ok' ? 'ok' : 'info'; }
  claseEstado(d: HrDiaAsistencia): string {
    switch (d.estado) {
      case 'falta': return 'bad';
      case 'retardo': case 'marca_faltante': return 'warn';
      case 'justificado': return 'info';
      case 'a_tiempo': case 'absorbido': return 'ok';
      default: return '';
    }
  }

  /** La captura vive en Incidencias: se llega con la persona y el sitio ya puestos. */
  capturar(p: HrPersonaAsistencia): void {
    void this.router.navigate(['/rh/incidencias'], { queryParams: { nueva: 1, site: this.sitio(), persona: p.codigo, desde: this.rango().desde } });
  }

  abrirHorario(p: HrPersonaAsistencia): void {
    const a = p.horarioAsignado;
    this.aviso.set(null);
    this.formHorario.set({
      entrada: a?.entrada ?? p.horario ?? '08:00', salida: a?.salida ?? p.salida ?? '18:00', comida: a?.comidaMin ?? 60,
      sabado: a?.sabado ?? false, sabadoEntrada: a?.sabadoEntrada ?? '', sabadoSalida: a?.sabadoSalida ?? '',
    });
  }

  guardarHorario(p: HrPersonaAsistencia): void {
    const f = this.formHorario();
    const site = this.sitio();
    if (!f || !site) return;
    this.guardando.set(true);
    this.api.asignarHorario({
      site_code: site, person_codes: [p.codigo], starts_at: f.entrada, ends_at: f.salida, lunch_minutes: Number(f.comida),
      works_saturday: f.sabado, saturday_starts_at: f.sabado ? f.sabadoEntrada : undefined, saturday_ends_at: f.sabado ? f.sabadoSalida : undefined,
    }).subscribe({
      next: () => { this.guardando.set(false); this.formHorario.set(null); this.aviso.set({ texto: 'Horario guardado. Los números ya se miden contra él.', mal: false }); this.cargar(); },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo guardar el horario.'), mal: true }); },
    });
  }

  quitarHorario(p: HrPersonaAsistencia): void {
    const site = this.sitio();
    if (!site) return;
    this.guardando.set(true);
    this.api.quitarHorario(site, [p.codigo]).subscribe({
      next: () => { this.guardando.set(false); this.aviso.set({ texto: 'Vuelve a medirse con el horario deducido de sus checadas.', mal: false }); this.cargar(); },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo quitar el horario.'), mal: true }); },
    });
  }
}
