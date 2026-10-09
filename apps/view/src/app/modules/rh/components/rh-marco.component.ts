import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrPersonaDirectorioDto } from '@megadulces/contracts';
import { PageTabsComponent, type PageTab } from '../../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../../core/constants/permissions';
import { RhRelojesFranjaComponent } from './rh-relojes-franja.component';
import { chipEnVivo, peorSemaforo } from '../relojes-formato';
import { RhAsistenciaEstado, type AtajoPeriodo } from '../rh-asistencia.estado';
import { departamentoDe } from '../reporte-formato';
import { fechaCorta, sumarDias } from '../rh.service';

const VER_ASISTENCIA = [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR];

/**
 * Fase RH · `[RH.1.7c]` — el marco de las cinco pestañas de Asistencia, como la página Horarios de Mega Talento:
 * encabezado, pestañas con lo que espera en cada una, la barra del reporte (plaza, periodo, personas, planta o
 * promotoras y búsqueda en todas las plazas), la franja de relojes y el aviso del cierre de la semana.
 *
 * Incidencias y Relojes lo usan sin la barra (tienen sus propios controles); Checadas, Tolerancia y Faltas, completo.
 */
@Component({
  selector: 'app-rh-marco',
  standalone: true,
  imports: [FormsModule, RouterLink, SelectModule, MultiSelectModule, InputTextModule, ButtonModule, PageTabsComponent, RhRelojesFranjaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="mc-head">
      <div>
        <h1>Asistencia</h1>
        <p>El horario de cada persona sale de sus propias checadas, salvo que RH le haya asignado uno. La semana de nómina va de jueves a miércoles.</p>
      </div>
      <div class="mc-head-btns">
        @if (barra() && est.relojesMedidos() && est.sitio()) {
          <span class="mc-vivo" [attr.data-t]="vivo().tono" [title]="vivo().titulo"><span class="mc-vivo-dot" aria-hidden="true"></span>{{ vivo().texto }}</span>
        }
        <ng-content select="[acciones]" />
        @if (barra()) {
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="est.loading()" (onClick)="est.asegurar(true)" />
        }
      </div>
    </header>

    <app-page-tabs [tabs]="tabs()" variant="underline" ariaLabel="Asistencia" />

    @if (barra()) {
      <section class="mc-bar" aria-label="Qué ver">
        <p-select [options]="est.sitios()" optionLabel="name" optionValue="code" [ngModel]="est.sitio()" (ngModelChange)="est.setSitio($event)"
                  placeholder="Plaza" appendTo="body" ariaLabel="Plaza" class="mc-plaza" />
        <div class="mc-periodo">
          <div class="mc-seg" role="group" aria-label="Periodo">
            @for (a of atajos; track a.id) {
              <button type="button" [attr.aria-pressed]="est.atajo() === a.id" (click)="est.irA(a.id)">{{ a.label }}</button>
            }
          </div>
          <div class="mc-semana" role="group" aria-label="Semana de nómina">
            <p-button icon="pi pi-chevron-left" [text]="true" severity="secondary" ariaLabel="Semana anterior" (onClick)="est.moverSemana(-7)" />
            <span class="mono">{{ est.etiquetaPeriodo() }}@if (est.atajo() === 'esta') { <em>actual</em> }</span>
            <p-button icon="pi pi-chevron-right" [text]="true" severity="secondary" ariaLabel="Semana siguiente"
                      [disabled]="est.esSemanaActual() && !est.modoHoy()" (onClick)="est.moverSemana(7)" />
          </div>
        </div>
        @if (personas()) {
          <p-multiselect [options]="deptos()" optionLabel="label" optionValue="value" [ngModel]="est.departamentos()"
                         (ngModelChange)="est.departamentos.set($event ?? []); est.unica.set(null)" placeholder="Personas: toda la plaza"
                         selectedItemsLabel="{0} departamentos" [maxSelectedLabels]="1" [showToggleAll]="false" appendTo="body"
                         ariaLabel="Personas" class="mc-personas" />
        }
        <div class="mc-seg" role="group" aria-label="A quién">
          <button type="button" [attr.aria-pressed]="!est.soloPromotoras()" (click)="est.setPromotoras(false)">Personal de planta</button>
          <button type="button" [attr.aria-pressed]="est.soloPromotoras()" (click)="est.setPromotoras(true)">Promotoras</button>
        </div>
        <div class="mc-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Buscar persona o número en todas las plazas" autocomplete="off"
                 [ngModel]="est.buscar()" (ngModelChange)="buscarCambio($event)" (focus)="est.cargarDirectorio(); abierta.set(true)"
                 (keydown.escape)="abierta.set(false)" (keydown.enter)="elegirPrimera()" (blur)="cerrarLuego()"
                 role="combobox" aria-autocomplete="list" [attr.aria-expanded]="mostrarSugerencias()" aria-controls="mc-sug"
                 aria-label="Buscar persona o número en todas las plazas" />
          @if (mostrarSugerencias()) {
            <ul class="mc-sug" id="mc-sug" role="listbox" aria-label="Personas en todas las plazas">
              @for (s of sugerencias(); track s.site_code + s.codigo) {
                <li role="option" aria-selected="false">
                  <button type="button" (mousedown)="$event.preventDefault()" (click)="elegir(s)">
                    <span class="mc-sug-cod mono">#{{ s.codigo }}</span>
                    <span class="mc-sug-nom">{{ s.nombre }}</span>
                    <small>{{ s.site_name }}@if (s.promotora) { · promotoría }@if (!s.ligado) { · sin ligar }</small>
                  </button>
                </li>
              } @empty {
                <li class="mc-sug-vacio">{{ est.directorioError() ? 'No se pudo leer el directorio. La búsqueda sigue funcionando en esta plaza.' : est.directorio() ? 'Nadie coincide en ninguna plaza.' : 'Buscando en todas las plazas…' }}</li>
              }
            </ul>
          }
        </div>
      </section>

      @if (franja() && est.relojesMedidos() && est.sitio()) {
        <app-rh-relojes-franja [relojes]="est.relojesSitio()" [sitios]="est.sitios()" [sitio]="est.sitio()" />
      }

      @if (cierre(); as c) {
        <div class="mc-cierre" [attr.data-t]="c.tono" role="note">
          <p>{{ c.texto }}</p>
          @if (c.link) { <a class="mc-cierre-link" routerLink="/rh/incidencias">{{ c.link }}</a> }
        </div>
      }
      @if (sinLigar(); as n) {
        <p class="mc-nota">{{ n }}</p>
      }
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: var(--sp-3); }
    .mc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .mc-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); letter-spacing: -0.01em; }
    .mc-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 70ch; }
    .mc-head-btns { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mc-vivo { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); font-weight: 600; padding: 2px var(--sp-2);
      border-radius: var(--r-pill); border: 1px solid var(--ok-border); background: var(--ok-soft-bg); color: var(--ok-soft-fg); white-space: nowrap; }
    .mc-vivo[data-t='warn'] { border-color: var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .mc-vivo[data-t='bad'] { border-color: var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .mc-vivo[data-t='mute'] { border-color: var(--border-color); background: var(--surface-2); color: var(--text-muted); }
    .mc-vivo-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    app-page-tabs { margin-bottom: calc(-1 * var(--sp-2)); }
    .mc-bar { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .mc-plaza { min-width: 12rem; }
    .mc-personas { min-width: 13rem; }
    .mc-periodo { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mc-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; background: var(--card-bg); }
    .mc-seg button { border: 0; background: none; color: var(--text-muted); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; white-space: nowrap; }
    .mc-seg button + button { border-left: 1px solid var(--border-color); }
    .mc-seg button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .mc-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .mc-semana { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-1); background: var(--card-bg); }
    .mc-semana span { font-size: var(--fs-sm); color: var(--text-main); min-width: 11rem; text-align: center; }
    .mc-semana em { font-style: normal; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--ok-soft-fg);
      background: var(--ok-soft-bg); border-radius: var(--r-sm); padding: 1px 5px; margin-left: var(--sp-1); }
    .mc-buscar { position: relative; flex: 1 1 240px; max-width: 360px; margin-left: auto; }
    .mc-buscar i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--text-faint); font-size: var(--fs-xs); }
    .mc-buscar input { width: 100%; padding-left: 30px; }
    .mc-sug { list-style: none; margin: 0; padding: var(--sp-1); position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-md); box-shadow: var(--shadow-float); max-height: 18rem; overflow: auto; }
    .mc-sug button { display: flex; align-items: baseline; gap: var(--sp-2); width: 100%; text-align: left; border: 0; background: none; padding: 6px var(--sp-2);
      border-radius: var(--r-sm); cursor: pointer; font-size: var(--fs-sm); color: var(--text-main); }
    .mc-sug button:hover, .mc-sug button:focus-visible { background: var(--surface-hover-bg); outline: none; }
    .mc-sug-cod { color: var(--text-muted); font-size: var(--fs-xs); min-width: 2.6rem; }
    .mc-sug small { margin-left: auto; color: var(--text-muted); font-size: var(--fs-xs); white-space: nowrap; }
    .mc-sug-vacio { padding: 6px var(--sp-2); color: var(--text-muted); font-size: var(--fs-sm); }
    .mc-cierre { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-sm);
      background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .mc-cierre[data-t='mute'] { background: var(--surface-2); color: var(--text-muted); border-color: var(--border-color); }
    .mc-cierre[data-t='curso'] { background: none; border-color: transparent; padding: 0; color: var(--text-muted); font-size: var(--fs-xs); }
    .mc-cierre p { margin: 0; flex: 1 1 30ch; }
    .mc-cierre-link { font-weight: 600; color: inherit; }
    .mc-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 40rem) {
      .mc-buscar { margin-left: 0; max-width: none; }
    }
  `],
})
export class RhMarcoComponent implements OnInit {
  readonly est = inject(RhAsistenciaEstado);
  private readonly router = inject(Router);

  /** Con la barra del reporte (Checadas, Tolerancia, Faltas). */
  readonly barra = input(true);
  /** Con la franja de relojes de la plaza. */
  readonly franja = input(true);
  /** Con el campo Personas (sólo Checadas: es un filtro del reporte). */
  readonly personas = input(false);

  readonly abierta = signal(false);
  readonly atajos: Array<{ id: AtajoPeriodo; label: string }> = [
    { id: 'hoy', label: 'Hoy' }, { id: 'esta', label: 'Esta semana' }, { id: 'pasada', label: 'Semana pasada' },
  ];

  readonly vivo = computed(() => chipEnVivo(peorSemaforo(this.est.relojesSitio())));

  readonly tabs = computed<PageTab[]>(() => [
    { label: 'Checadas', route: '/rh/asistencia', anyOf: VER_ASISTENCIA },
    { label: 'Tolerancia', route: '/rh/asistencia/tolerancia', anyOf: VER_ASISTENCIA, badge: this.est.nRebasados() },
    { label: 'Faltas', route: '/rh/asistencia/faltas', anyOf: VER_ASISTENCIA, badge: this.est.nFaltas() },
    {
      label: 'Incidencias', route: '/rh/incidencias', badge: this.est.pendientes(),
      anyOf: [Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR, Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE],
    },
    { label: 'Relojes', route: '/rh/relojes', anyOf: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] },
  ]);

  /** Los departamentos de lo que se ve, con cuántas personas trae cada uno. */
  readonly deptos = computed(() => {
    const n = new Map<string, number>();
    for (const p of this.est.datos()?.personas ?? []) n.set(departamentoDe(p), (n.get(departamentoDe(p)) ?? 0) + 1);
    return [...n.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => ({ value: d, label: `${d} (${c})` }));
  });

  readonly sugerencias = computed<HrPersonaDirectorioDto[]>(() =>
    filtrarPorBusqueda(this.est.directorio() ?? [], this.est.buscar(), (p) => [p.nombre, p.codigo]).slice(0, 8));
  readonly mostrarSugerencias = computed(() => this.abierta() && this.est.buscar().trim().length > 0);

  /** El aviso de la semana: si ya terminó y qué falta para cerrarla, o si ya se cerró. */
  readonly cierre = computed<{ texto: string; tono: 'warn' | 'mute' | 'curso'; link: string | null } | null>(() => {
    const e = this.est;
    if (!e.sitio() || !e.datos()) return null;
    const jueves = e.modoHoy() ? e.juevesActual() : e.jueves();
    if (jueves >= e.juevesActual()) {
      return { texto: `Semana en curso: se puede cerrar a partir del ${fechaCorta(sumarDias(jueves, 7))}.`, tono: 'curso', link: null };
    }
    const c = e.cierres();
    if (c === null) return null;   // sin permiso o sin respuesta: no se afirma nada
    const vigente = c.find((x) => x.vigente && x.period_start === jueves);
    if (vigente) {
      return { texto: `Semana cerrada para prenómina${vigente.closed_by_name ? ' por ' + vigente.closed_by_name : ''}. Lo que pasó a prenómina es la foto de ese día; si algo cambió después, se reabre en Incidencias.`, tono: 'mute', link: null };
    }
    const p = e.pendientes();
    const falta = p ? ` Para cerrarla falta calificar ${p} incidencia${p === 1 ? '' : 's'}.` : '';
    return { texto: `La semana del ${fechaCorta(jueves)} ya terminó y no está cerrada.${falta}`, tono: 'warn', link: p ? 'Ir a Incidencias' : 'Ir a cerrar' };
  });

  /** Quien checa sin estar ligado a su persona sale con el nombre del reloj: se dice, para que no parezca un nombre real. */
  readonly sinLigar = computed(() => {
    const ps = this.est.datos()?.personas ?? [];
    const n = ps.filter((p) => !p.registrado).length;
    if (!n) return null;
    return `${n} de ${ps.length} persona${ps.length === 1 ? '' : 's'} checa${n === 1 ? '' : 'n'} sin estar ligada${n === 1 ? '' : 's'} a su persona de la Suite: sale${n === 1 ? '' : 'n'} con el nombre del reloj.`;
  });

  ngOnInit(): void { this.est.iniciar(); }

  buscarCambio(v: string): void {
    this.est.buscar.set(v ?? '');
    this.abierta.set(true);
  }

  elegir(s: HrPersonaDirectorioDto): void {
    this.abierta.set(false);
    this.est.irAPersona(s);
    if (this.router.url.split('?')[0] !== '/rh/asistencia') void this.router.navigate(['/rh/asistencia']);
  }

  elegirPrimera(): void {
    const s = this.sugerencias()[0];
    if (s) this.elegir(s);
  }

  /** El blur llega antes que el clic en una sugerencia: se espera un instante para no cerrarla debajo del dedo. */
  cerrarLuego(): void { setTimeout(() => this.abierta.set(false), 150); }
}
