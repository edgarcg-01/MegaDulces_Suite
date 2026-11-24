import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import type { MenuItem } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { PopoverModule } from 'primeng/popover';
import { MenuModule } from 'primeng/menu';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrPersonaDirectorioDto } from '@megadulces/contracts';
import { PageTabsComponent, type PageTab } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { RhAvisosSemanaComponent, RhFiltrosComponent } from './rh-semana-barra.component';
import { chipEnVivo, peorSemaforo } from '../relojes-formato';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { juevesDeLaSemana, sumarDias } from '../rh.service';
import { VER_ASISTENCIA } from '../rh-una-pantalla.guard';

/**
 * Fase RH · `[RH.1.7c]` — el marco de Asistencia, como la página Horarios de Mega Talento: encabezado, pestañas, la
 * barra del reporte (plaza, periodo, personas, planta o promotoras y búsqueda en todas las plazas) y el aviso del cierre
 * de la semana. `[RH.18.14]` La franja de relojes ya no va aquí: la dice el chip y vive en el panel de Relojes.
 *
 * `[RH.13.5]` Asistencia es UNA pantalla (David, 2026-11-11: «me refería a una misma pantalla»). Checadas, faltas,
 * tolerancia, incidencias y relojes son un solo proceso con una sola pregunta —¿está lista la semana de esta plaza para
 * prenómina?—, así que dejan de ser pestañas: Faltas y Tolerancia son modos de Checadas, e Incidencias y Relojes abren
 * en el panel lateral desde el encabezado. Quedan como pestaña sólo las que contestan OTRA pregunta: Horas extra
 * (¿cuánto se le debe?), Cruces (¿quién checó en dos plazas?) y Bajas (¿quién se fue y sigue checando?). El botón
 * principal es el paso que toca: «Cerrar semana» cuando ya terminó y no se ha cerrado; si no, «Capturar incidencia».
 *
 * `[RH.18.11]` (David, 24-nov: «lo quiero más simple») De 7 franjas antes de la tabla a 3: la plaza y la semana suben
 * junto al título; «Hoy» es un botón de texto (Esta semana y Semana pasada se van: las flechas lo hacen); el chip
 * «Sin señal» abre Relojes; Relojes y Actualizar van en «⋯»; Personas y Planta/Promotoras se pliegan en «Filtros», y
 * los avisos de una línea pasan a la fila de modos (`enLinea`). El aviso que pide algo (la semana terminó y no se
 * cerró) sigue siendo su propio aviso.
 *
 * Incidencias y Relojes lo siguen usando sin la barra en su página propia, que sólo ve quien NO ve Asistencia
 * (Contabilidad audita incidencias así): ver `rh-una-pantalla.guard.ts`.
 */
/** 'yyyy-MM-dd' → el Date LOCAL de ese día a mediodía (el datepicker trabaja en la hora de la máquina). */
const aFechaLocal = (iso: string): Date => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 12); };

@Component({
  selector: 'app-rh-marco',
  standalone: true,
  imports: [FormsModule, SelectModule, InputTextModule, ButtonModule, DatePickerModule, PopoverModule, MenuModule, PageTabsComponent,
    RhFiltrosComponent, RhAvisosSemanaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- [RH.18.11] Un solo renglón arriba: qué plaza y qué semana junto al título; a la derecha buscar, Incidencias, el paso
         que toca y «⋯». -->
    <header class="mc-head">
      <div class="mc-titulo">
        <h1>Asistencia</h1>
        @if (barra() && !est.sinPlazas()) {
          <p-select [options]="est.sitios()" optionLabel="name" optionValue="code" [ngModel]="est.sitio()" (ngModelChange)="est.setSitio($event)"
                    placeholder="Plaza" appendTo="body" ariaLabel="Plaza" class="mc-plaza" />
          <div class="mc-semana" role="group" aria-label="Semana de nómina">
            <p-button icon="pi pi-chevron-left" [text]="true" severity="secondary" ariaLabel="Semana anterior" (onClick)="est.moverSemana(-7)" />
            @if (est.modoHoy()) {
              <span class="mono">{{ est.etiquetaPeriodo() }}</span>
            } @else {
              <!-- [RH.6.4] Elegir la semana de nómina por su número fiscal (Mega Talento 8dd5521): las últimas 52. -->
              <p-select [options]="est.semanasElegibles()" optionLabel="label" optionValue="value" [ngModel]="est.jueves()"
                        (ngModelChange)="est.irASemana($event)" [placeholder]="'Semana ' + est.semanaFiscal().numero + ' · ' + est.etiquetaPeriodo()"
                        appendTo="body" ariaLabel="Semana de nómina a revisar" class="mc-sem-sel" />
            }
            <!-- [RH.13.5] «Por semanas, pero también de calendario» (David, 13-nov). El calendario empieza en JUEVES, así cada
                 renglón es una semana de nómina; se toca cualquier día y se abre su semana completa. -->
            <p-button icon="pi pi-calendar" [text]="true" severity="secondary" ariaLabel="Elegir la semana en el calendario"
                      (onClick)="cal.toggle($event)" />
            <p-popover #cal appendTo="body" ariaLabel="Elegir la semana en el calendario">
              <div class="mc-cal">
                <p-datepicker [inline]="true" selectionMode="range" [firstDayOfWeek]="4" [maxDate]="maxFecha()"
                              [ngModel]="rangoSemana()" (onSelect)="elegirDia($event); cal.hide()" />
                <p>Toca cualquier día: se abre su semana, de jueves a miércoles.</p>
              </div>
            </p-popover>
            <p-button icon="pi pi-chevron-right" [text]="true" severity="secondary" ariaLabel="Semana siguiente"
                      [disabled]="est.esSemanaActual() && !est.modoHoy()" (onClick)="est.moverSemana(7)" />
          </div>
          <!-- «Hoy» prende y apaga el día de hoy; apagado vuelve a la semana en curso. -->
          <button type="button" class="mc-hoy" [attr.aria-pressed]="est.modoHoy()" (click)="est.irA(est.modoHoy() ? 'esta' : 'hoy')">Hoy</button>
          @if (!enLinea()) { <app-rh-filtros /> }
        }
        @if (barra() && est.relojesMedidos() && est.sitio()) {
          @if (veRelojes()) {
            <button type="button" class="mc-vivo" [attr.data-t]="vivo().tono" [title]="vivo().titulo + ' · abre Relojes'"
                    (click)="abrir({ panel: 'relojes' })"><span class="mc-vivo-dot" aria-hidden="true"></span>{{ vivo().texto }}</button>
          } @else {
            <span class="mc-vivo" [attr.data-t]="vivo().tono" [title]="vivo().titulo"><span class="mc-vivo-dot" aria-hidden="true"></span>{{ vivo().texto }}</span>
          }
        }
      </div>
      @if (barra() && !est.sinPlazas()) {
        <div class="mc-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Buscar en todas las plazas" autocomplete="off"
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
      }
      <div class="mc-head-btns">
        <ng-content select="[acciones]" />
        @if (barra()) {
          @if (veIncidencias()) {
            <p-button icon="pi pi-file-edit" label="Incidencias" styleClass="mc-icono-chico" severity="secondary" [outlined]="true" [badge]="porCalificar()" badgeSeverity="warn"
                      [ariaLabel]="porCalificar() ? 'Incidencias: ' + porCalificar() + ' por calificar' : 'Incidencias'"
                      (onClick)="abrir({ panel: 'incidencias', site: est.sitio() ?? '' })" />
          }
          @if (primario(); as pr) {
            <p-button [icon]="pr.icon" [label]="pr.label" (onClick)="abrir(pr.abrir)" />
          }
          <!-- [RH.18.11] Lo que no se usa todos los días: Relojes (también abre desde el chip) y Actualizar. -->
          <p-button icon="pi pi-ellipsis-h" severity="secondary" [outlined]="true" [loading]="est.loading()" styleClass="mc-mas"
                    [ariaLabel]="veRelojes() ? 'Más: Relojes y Actualizar' : 'Más: Actualizar'" (onClick)="mas.toggle($event)" />
          <p-menu #mas [model]="masItems()" [popup]="true" appendTo="body" />
        }
      </div>
    </header>

    <app-page-tabs [tabs]="tabs()" variant="underline" ariaLabel="Asistencia" />

    <!-- Sin plazas no hay nada que medir: se dice una vez aquí, y las pestañas que calculan no pintan «nadie» ni ceros. -->
    @if (est.sinPlazas()) {
      <section class="mc-sin" role="status" aria-labelledby="mc-sin-t">
        <h2 id="mc-sin-t">Todavía no hay plazas de checado en la Suite</h2>
        <p>Las plazas, sus relojes y su historial llegan con el corte de asistencia desde Mega Talento, que aún no se hace.
          Mientras tanto la asistencia se consulta en Mega Talento: aquí no hay nada medido, por eso no se muestran cifras.</p>
      </section>
    }

    @if (barra() && !est.sinPlazas()) {
      <!-- [RH.18.14] (David, 24-nov: «quita esto») Sin franja de relojes: el chip «Sin señal» lo dice y abre Relojes, donde
           está el detalle de cada equipo (también la hora corrida). -->
      <!-- El aviso que pide algo (terminó y no se cerró) o lo cerrado. La semana en curso se dice en una línea. -->
      @if (cierre(); as c) {
        <div class="mc-cierre" [attr.data-t]="c.tono" role="note">
          <p>{{ c.texto }}</p>
          @if (c.link) {
            <button type="button" class="mc-cierre-link" (click)="abrir({ panel: 'incidencias', site: est.sitio() ?? '', desde: c.desde })">{{ c.link }}</button>
          }
        </div>
      }
      @if (!enLinea() && hayAvisos()) {
        <p class="mc-avisos"><app-rh-avisos-semana class="solo" /></p>
      }
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: var(--sp-3); container: mc / inline-size; }
    .mc-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3) var(--sp-4); flex-wrap: wrap; }
    .mc-titulo { display: flex; align-items: center; gap: var(--sp-2) var(--sp-3); flex-wrap: wrap; min-width: 0; }
    .mc-head h1 { margin: 0 var(--sp-1) 0 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); letter-spacing: -0.01em; }
    .mc-head-btns { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .mc-vivo { display: inline-flex; align-items: center; gap: var(--sp-1); font: inherit; font-size: var(--fs-xs); font-weight: 600; padding: 2px var(--sp-2);
      border-radius: var(--r-pill); border: 1px solid var(--ok-border); background: var(--ok-soft-bg); color: var(--ok-soft-fg); white-space: nowrap; }
    button.mc-vivo { cursor: pointer; }
    button.mc-vivo:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mc-vivo[data-t='warn'] { border-color: var(--warn-border); background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .mc-vivo[data-t='bad'] { border-color: var(--bad-border); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .mc-vivo[data-t='mute'] { border-color: var(--border-color); background: var(--surface-2); color: var(--text-muted); }
    .mc-vivo-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    app-page-tabs { margin-bottom: calc(-1 * var(--sp-2)); }
    .mc-plaza { min-width: 10rem; }
    .mc-semana { display: inline-flex; align-items: center; gap: var(--sp-1); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-1); background: var(--card-bg);
      min-width: 0; max-width: 100%; }
    .mc-semana span { font-size: var(--fs-sm); color: var(--text-main); min-width: 11rem; text-align: center; }
    .mc-cal p { margin: var(--sp-2) 0 0; max-width: 18rem; font-size: var(--fs-xs); color: var(--text-muted); }
    /* La semana se encoge (con «…») en vez de empujar la flecha fuera de la pantalla: a 390 px la «›» quedaba en 382–418. */
    .mc-sem-sel { border: 0; background: transparent; box-shadow: none; min-width: 15rem; max-width: 100%; flex: 0 1 auto; font-variant-numeric: tabular-nums; }
    :host ::ng-deep .mc-sem-sel .p-select-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mc-hoy { font: inherit; font-size: var(--fs-sm); color: var(--text-muted); background: none; border: 1px solid transparent; border-radius: var(--r-md);
      padding: 0 var(--sp-2); min-height: max(var(--tap-min), 2.25rem); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
    .mc-hoy[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; text-decoration: none; }
    .mc-hoy:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    /* Con el dedo, todo lo que se toca mide al menos 44 px (token --tap-min: 0 con mouse, 44 en táctil). */
    .mc-buscar input { min-height: var(--tap-min); }
    :host ::ng-deep .p-button, :host ::ng-deep .p-select { min-height: var(--tap-min); }
    :host ::ng-deep .mc-semana .p-button { min-width: var(--tap-min); }
    .mc-buscar { position: relative; flex: 1 1 200px; max-width: 300px; margin-left: auto; }
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
    .mc-cierre p { margin: 0; flex: 1 1 30ch; }
    .mc-cierre-link { font: inherit; font-weight: 600; color: inherit; background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; min-height: var(--tap-min); }
    .mc-cierre-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mc-avisos { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--sp-2); }
    .mc-sin { padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .mc-sin h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .mc-sin p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 72ch; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    /* [RH.13.5] Pantalla angosta: el buscador a todo lo ancho y los botones secundarios sólo con su ícono (conservan su
       nombre para el lector de pantalla). La plaza y la semana se encogen en vez de empujar la flecha fuera. */
    @container mc (max-width: 48rem) {
      .mc-titulo { flex: 1 1 100%; }
      .mc-head h1 { flex: 1 1 100%; }
      .mc-buscar { order: 3; flex: 1 1 100%; margin-left: 0; max-width: none; }
      .mc-head-btns { order: 2; }
      :host ::ng-deep .mc-icono-chico .p-button-label { display: none; }
      .mc-plaza { flex: 1 1 10rem; min-width: 0; }
      .mc-semana { flex: 1 1 auto; }
      .mc-sem-sel { flex: 1 1 auto; width: auto; min-width: 0; }
    }
  `],
})
export class RhMarcoComponent implements OnInit {
  readonly est = inject(RhAsistenciaEstado);
  private readonly router = inject(Router);
  private readonly perms = inject(PermissionsService);

  /** Con la barra del reporte (Checadas, Tolerancia, Faltas). */
  readonly barra = input(true);
  /**
   * `[RH.18.11]` La página pone «Filtros» (con Personas) y los avisos de una línea en su fila de modos (Checadas). Sin
   * esto, el marco los pone él: Filtros junto a la semana y los avisos debajo.
   */
  readonly enLinea = input(false);

  readonly abierta = signal(false);

  readonly vivo = computed(() => chipEnVivo(peorSemaforo(this.est.relojesSitio())));

  /**
   * `[RH.13.5]` Sólo lo que contesta OTRA pregunta es pestaña. Faltas y Tolerancia son modos de Checadas (`?ver=`);
   * Incidencias y Relojes, paneles (`?panel=`). Sus cifras ya no van en la pestaña: están en el modo y en el botón.
   */
  readonly tabs = computed<PageTab[]>(() => [
    { label: 'Checadas', route: '/rh/asistencia', anyOf: VER_ASISTENCIA },
    {
      label: 'Horas extra', route: '/rh/asistencia/horas-extra',
      anyOf: [...VER_ASISTENCIA, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR],
    },
    // `[RH.7.4]` Quién checó en el reloj de otra plaza (todas las plazas a la vez).
    { label: 'Cruces', route: '/rh/asistencia/cruces', anyOf: VER_ASISTENCIA },
    // `[RH.7.2]` La papelera de empleados de Mega Talento, por plaza.
    { label: 'Bajas', route: '/rh/asistencia/bajas', anyOf: [Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR] },
  ]);

  /** Los mismos permisos que pedía la pestaña de cada uno (y su endpoint de lectura). */
  readonly veRelojes = computed(() => this.perms.hasAny(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR));
  readonly veIncidencias = computed(() => this.perms.hasAny(Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR,
    Permission.HR_INCIDENTS_CALIFICAR, Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE));
  /** Lo capturado que espera a quien califica; sin cifra (o sin medir), sin globo. */
  readonly porCalificar = computed(() => { const n = this.est.pendientes(); return n ? String(n) : undefined; });

  /** `[RH.18.11]` «⋯»: Relojes (a quien lo ve) y Actualizar. */
  readonly masItems = computed<MenuItem[]>(() => [
    ...(this.veRelojes() ? [{ label: 'Relojes', icon: 'pi pi-clock', command: () => this.abrir({ panel: 'relojes' }) }] : []),
    { label: 'Actualizar', icon: 'pi pi-refresh', command: () => this.est.asegurar(true) },
  ]);

  /**
   * El paso que toca: cerrar la semana que ya terminó y sigue abierta. `[RH.18.13]` (David, 24-nov: «si ya capturas desde la
   * tabla, ¿no está de más?») Ya no hay «Capturar incidencia» aquí: se captura en la celda del día de la tabla, y lo que la
   * tabla no alcanza (otra semana, celular, varias personas) en el panel de Incidencias, que trae su propio botón. Así el
   * botón naranja sólo aparece cuando hay algo que hacer.
   */
  readonly primario = computed<{ label: string; icon: string; abrir: Record<string, string> } | null>(() => {
    const e = this.est;
    const site = e.sitio();
    if (!site) return null;
    const jueves = e.modoHoy() ? e.juevesActual() : e.jueves();
    const cerrada = (e.cierres() ?? []).some((x) => x.vigente && x.period_start === jueves);
    if (jueves < e.juevesActual() && !cerrada && e.cierres() !== null && this.perms.has(Permission.HR_PERIOD_CLOSE)) {
      const abrir: Record<string, string> = { panel: 'incidencias', site, desde: jueves };
      return { label: 'Cerrar semana', icon: 'pi pi-lock', abrir };
    }
    return null;
  });

  // ── [RH.13.5] La semana en el calendario ──
  /** La semana en pantalla, pintada como rango en el calendario (en «Hoy», la semana de hoy). */
  readonly rangoSemana = computed(() => {
    const j = this.est.modoHoy() ? juevesDeLaSemana(this.est.hoy()) : this.est.jueves();
    return [aFechaLocal(j), aFechaLocal(sumarDias(j, 6))];
  });
  /** No se eligen días que no han pasado: esa semana todavía no existe. */
  readonly maxFecha = computed(() => aFechaLocal(this.est.hoy()));
  /** Cualquier día lleva a SU semana de nómina (el jueves que la abre). */
  elegirDia(d: Date | null): void {
    if (!d) return;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    this.est.irASemana(juevesDeLaSemana(iso));
  }

  readonly sugerencias = computed<HrPersonaDirectorioDto[]>(() =>
    filtrarPorBusqueda(this.est.directorio() ?? [], this.est.buscar(), (p) => [p.nombre, p.codigo]).slice(0, 8));
  readonly mostrarSugerencias = computed(() => this.abierta() && this.est.buscar().trim().length > 0);

  /** El aviso propio de la semana: ya terminó y qué falta para cerrarla, o ya se cerró. La semana en curso va en línea. */
  readonly cierre = computed(() => { const c = this.est.cierreSemana(); return c && c.tono !== 'curso' ? c : null; });
  /** Hay algo que decir en la línea de avisos (cuando el marco la pone él). */
  readonly hayAvisos = computed(() => this.est.cierreSemana()?.tono === 'curso' || !!this.est.sinLigar() || !!this.est.nombresPendientes());

  ngOnInit(): void { this.est.iniciar(); }

  /** `[RH.13.5]` Todo se abre DENTRO de Asistencia: desde Horas extra, Cruces o Bajas también se vuelve a Checadas. */
  abrir(q: Record<string, string>): void {
    void this.router.navigate(['/rh/asistencia'], { queryParams: q });
  }

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
