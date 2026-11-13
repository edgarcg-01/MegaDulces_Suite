import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import {
  HR_CIUDADES_EMPLEO, HR_TALENT_SIN_CIUDAD, type HrCandidatoFichaDto, type HrCandidatoFilaDto, type HrCasilleroDto, type HrTalentApartado, type HrTalentEtapa,
} from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { RhCandidatoFichaComponent } from '../components/rh-candidato-ficha.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import { APARTADOS, ETAPAS, esperando, fechaCortaMx, rebasaSla, telefonoPartes } from '../reclutamiento-formato';

const POR_PAGINA = 100;
/** Para comparar lo que escribió la persona con el nombre de la zona: sin acentos, sin mayúsculas, sin espacios de más. */
const sinAcentos = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Fase RH · `[RH.2.3]` — Candidatos (`/rh/reclutamiento`). Antes: las pantallas por etapa del portal de Mega Talento
 * (Filtro inicial, Conductual, Aptitudes, Psicométricas, Contratados) más Papelera, Spam y No recontratables.
 *
 * Una sola tabla con dos filtros arriba —el apartado y la etapa, cada etapa con cuántos hay— en lugar de una pantalla
 * por etapa: RH ve el embudo completo de un vistazo. La ficha abre en el panel lateral sin perder la lista. El
 * apartado, la etapa y la búsqueda viven en la URL: se puede mandar la liga de «los de Aptitudes en Zamora».
 */
@Component({
  selector: 'app-rh-candidatos',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule, SelectModule, LoadStateComponent, SidePeekComponent, RhReclutamientoMarcoComponent, RhCandidatoFichaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rc-page">
      <app-rh-reclutamiento-marco>
        <div acciones><p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" /></div>
      </app-rh-reclutamiento-marco>

      <!-- [RH.13.6] «Aquí quiero más orden» (David, 13-nov; eligió «embudo con cifras»). Qué lista ver es un menú —lo de
           todos los días arriba y el archivo aparte, cada opción con lo que significa— y las etapas son el embudo de abajo. -->
      <section class="rc-bar" aria-label="Qué ver">
        <div class="rc-grupo">
          <label class="rc-cap" for="rc-ver">Ver</label>
          <p-select inputId="rc-ver" [options]="opcionesVer" [group]="true" optionGroupLabel="label" optionGroupChildren="items"
                    optionLabel="label" optionValue="value" [ngModel]="apartado()" (ngModelChange)="setApartado($event)"
                    appendTo="body" class="rc-ver" panelStyleClass="rc-ver-panel" ariaLabel="Qué lista ver">
            <ng-template #group let-g><span class="rc-ver-grupo">{{ g.label }}</span></ng-template>
            <ng-template #item let-o><span class="rc-ver-op"><b>{{ o.label }}</b><small>{{ o.ayuda }}</small></span></ng-template>
          </p-select>
        </div>
        <div class="rc-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Nombre, puesto, ciudad o teléfono" autocomplete="off" aria-label="Buscar candidato"
                 [ngModel]="busqueda()" (ngModelChange)="buscar($event)" />
        </div>
        <!-- [RH.8.1] Llegó desde una celda del Resumen: la ciudad se ve y se quita. -->
        @if (ciudad(); as c) {
          <span class="rc-ciudad">Ciudad: <b>{{ nombreCiudad(c) }}</b>
            <button type="button" (click)="setCiudad(null)" [attr.aria-label]="'Quitar el filtro de ciudad ' + nombreCiudad(c)"><i class="pi pi-times" aria-hidden="true"></i></button>
          </span>
        }
      </section>

      @if (apartado() !== 'papelera' && apartado() !== 'spam') {
        <!-- El EMBUDO: cada etapa con su cifra grande, en el orden en que se avanza; aparte cómo terminó. Se ve de un
             vistazo dónde se junta la gente, y cada cuadro filtra la lista. -->
        <nav class="rc-embudo" aria-label="Etapas">
          <div class="rc-emb" role="group" aria-label="Todas las etapas">
            <button type="button" [attr.aria-pressed]="!etapa()" (click)="setEtapa(null)"><span class="rc-emb-l">Todas</span><span class="rc-emb-n">{{ totalEtapas() }}</span></button>
          </div>
          <div class="rc-emb rc-flujo" role="group" aria-label="Pasos del proceso, en orden">
            @for (e of flujo; track e.id) {
              <button type="button" [attr.aria-pressed]="etapa() === e.id" (click)="setEtapa(e.id)"><span class="rc-emb-l">{{ e.corto }}</span><span class="rc-emb-n">{{ porEtapa()[e.id] ?? 0 }}</span></button>
            }
          </div>
          <div class="rc-emb rc-fin" role="group" aria-label="Cómo terminó">
            @for (e of resultado; track e.id) {
              <button type="button" [attr.aria-pressed]="etapa() === e.id" (click)="setEtapa(e.id)"><span class="rc-emb-l">{{ e.corto }}</span><span class="rc-emb-n">{{ porEtapa()[e.id] ?? 0 }}</span></button>
            }
          </div>
        </nav>
      }

      <app-load-state [loading]="loading() && !filas().length" [error]="error()" [isEmpty]="!loading() && !error() && !filas().length"
                      emptyIcon="pi-users" [emptyTitle]="vacio()" (retry)="cargar()">
        <section class="rc-card" aria-label="Candidatos">
          <div class="rc-scroll dt-scope">
            <table class="rc-tabla dt-stack">
              <!-- [RH.13.6] «Formato para una mejor lectura» (David, 13-nov). Siete columnas a lo ancho obligaban a recorrer
                   la fila: quién es, qué busca y dónde van JUNTOS (nombre y debajo puesto · plaza); «Esperando» dice cuánto
                   lleva sin respuesta y por eso está atrasado; el teléfono en 3-3-4; la fecha corta. -->
              <thead><tr>
                <th scope="col" class="rc-cand">Candidato</th><th scope="col">Etapa</th><th scope="col">Esperando</th>
                <th scope="col">Teléfono</th><th scope="col">Se postuló</th>
              </tr></thead>
              <!-- [RH.13.6] «Acomódalos por zona» (David, 13-nov). Zona = ciudad, como en Mega Talento; en el orden del
                   catálogo y «sin ciudad reconocida» al final. Cada zona es su propio <tbody>, con su encabezado. -->
              @for (g of grupos(); track g.zona) {
              <tbody>
                @if (g.zona !== null) {
                  <tr class="rc-zona">
                    <th scope="rowgroup" colspan="5">
                      <span>{{ g.etiqueta }}</span>
                      <small>{{ g.filas.length }}@if (!completo()) {&ngsp;de los cargados}@if (g.atrasados) {&ngsp;· <b>{{ g.atrasados }} atrasado{{ g.atrasados === 1 ? '' : 's' }}</b>}</small>
                    </th>
                  </tr>
                }
                @for (c of g.filas; track c.id) {
                  <!-- La fila entera abre la ficha, con el mouse y con el teclado (Tab llega a la fila; Enter o Espacio la abre). -->
                  <tr [class.sel]="sel()?.id === c.id" (click)="abrir(c)" tabindex="0" (keydown.enter)="abrir(c)"
                      (keydown.space)="$event.preventDefault(); abrir(c)" [attr.aria-label]="'Abrir la ficha de ' + (c.full_name || 'sin nombre')">
                    <td class="dt-id rc-cand" role="cell">
                      <!-- Un solo bloque: apilada en el teléfono, cada hijo de la celda se vuelve una columna. -->
                      <div>
                        <b class="rc-nom">{{ c.full_name || 'Sin nombre' }}</b>
                        @if (c.no_rehire) { <span class="pill" data-t="mal">No recontratable</span> }
                        @if (!c.has_cv) { <span class="pill" data-t="aviso">Sin CV</span> }
                        @if (detalle(c, g.zona); as d) { <span class="rc-meta">{{ d }}</span> }
                      </div>
                    </td>
                    <td role="cell" data-label="Etapa">{{ etiquetaEtapa(c.stage) }}</td>
                    <td class="rc-esp" role="cell" data-label="Esperando">
                      @if (esDesenlace(c)) {
                        <span class="rc-tenue">desde {{ fechaCorta(c.last_activity_at ?? c.created_at) }}</span>
                      } @else {
                        <span>{{ esperando(c.last_activity_at ?? c.created_at) }}@if (rebasa(c)) { <span class="pill" data-t="aviso" title="Pasó el tiempo que RH se dio para responder en esta etapa">Atrasado</span> }</span>
                      }
                    </td>
                    <td class="mono rc-tel" role="cell" data-label="Teléfono"><span>@for (p of telefonoPartes(c.phone); track $index) {<span>{{ p }}</span>} @empty {—}</span></td>
                    <td class="mono rc-fecha" role="cell" data-label="Se postuló">{{ fechaCorta(c.created_at) }}</td>
                  </tr>
                }
              </tbody>
              }
            </table>
          </div>
          <footer class="rc-pie">
            <span>{{ filas().length }} de {{ total() }}</span>
            @if (filas().length < total()) { <p-button label="Ver más" size="small" [text]="true" [loading]="loading()" (onClick)="masFilas()" /> }
          </footer>
        </section>
      </app-load-state>

      <app-side-peek [open]="peek()" (openChange)="cambioPeek($event)" [title]="ficha()?.full_name || 'Candidato'" [subtitle]="subtituloFicha()" [width]="640">
        @if (ficha(); as f) {
          <app-rh-candidato-ficha [ficha]="f" [casilleros]="casilleros()" [gestiona]="gestiona()" (actualizada)="alActualizar($event)" (fusionado)="cargar()" />
        } @else if (errorFicha()) {
          <p class="rc-err" role="alert">{{ errorFicha() }}</p>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rc-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rc-bar { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .rc-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-sm); overflow: hidden; flex-wrap: wrap; }
    .rc-seg button { border: 0; background: var(--card-bg); padding: var(--sp-1) var(--sp-3); font: inherit; font-size: var(--fs-sm); color: var(--text-muted); cursor: pointer; }
    .rc-seg button + button { border-left: 1px solid var(--border-color); }
    .rc-seg button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .rc-seg button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rc-buscar { position: relative; flex: 0 1 22rem; margin-left: auto; }
    .rc-ciudad { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-1) 2px var(--sp-2); border-radius: var(--r-pill);
      background: var(--info-soft-bg); color: var(--info-soft-fg); font-size: var(--fs-sm); }
    .rc-ciudad button { border: 0; background: none; color: inherit; cursor: pointer; padding: 2px; border-radius: var(--r-sm); }
    .rc-ciudad button:focus-visible { outline: 2px solid var(--focus-ring); }
    .rc-buscar i { position: absolute; left: var(--sp-2); top: 50%; transform: translateY(-50%); color: var(--text-muted); }
    .rc-buscar input { width: 100%; padding-left: calc(var(--sp-2) * 3.5); }
    /* [RH.13.6] «Ver»: un menú; lo de todos los días arriba y el archivo aparte, cada opción con lo que significa. */
    .rc-grupo { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .rc-cap { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); white-space: nowrap; }
    .rc-ver { min-width: 13rem; }
    :host ::ng-deep .rc-ver, .rc-buscar input { min-height: var(--tap-min); }
    .rc-ver-grupo { font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
    .rc-ver-op { display: flex; flex-direction: column; gap: 1px; max-width: 22rem; white-space: normal; }
    .rc-ver-op b { font-weight: 600; }
    .rc-ver-op small { font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.3; }
    /* El EMBUDO: cifra grande, nombre chico arriba; los pasos numerados con flecha al siguiente; el resultado aparte. */
    .rc-embudo { display: flex; align-items: stretch; gap: var(--sp-3); flex-wrap: wrap; }
    .rc-emb { display: flex; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); overflow: hidden; }
    .rc-emb button { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 7.5rem; min-height: var(--tap-min);
      padding: var(--sp-2) var(--sp-4) var(--sp-2) var(--sp-3); border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
    .rc-emb button + button { border-left: 1px solid var(--border-color); }
    .rc-emb button:hover { background: var(--surface-hover-bg); }
    .rc-emb button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    /* La elegida: fondo y una barra abajo (el color de acción marca lo SELECCIONADO, como en las pestañas). */
    .rc-emb button[aria-pressed='true'] { background: var(--surface-selected-bg); box-shadow: inset 0 -3px 0 var(--action); }
    .rc-emb-l { font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
    .rc-emb-n { font: 700 var(--fs-h2)/1.1 var(--font-body); font-variant-numeric: tabular-nums; color: var(--text-main); }
    .rc-emb button[aria-pressed='true'] .rc-emb-l { color: var(--text-main); font-weight: 600; }
    .rc-fin .rc-emb-n { color: var(--text-muted); }
    /* El número de paso y la flecha los pone el CSS: el nombre de la etapa no cambia. */
    .rc-flujo { counter-reset: paso; }
    .rc-flujo .rc-emb-l::before { counter-increment: paso; content: counter(paso) ' · '; font-weight: 700; }
    .rc-flujo button:not(:last-child)::after { content: '→'; position: absolute; right: var(--sp-2); top: 50%; transform: translateY(-50%);
      color: var(--text-faint); font-size: var(--fs-sm); }
    .rc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .rc-scroll { overflow-x: auto; }
    .rc-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rc-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rc-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rc-tabla tr.sel td { background: var(--surface-2); }
    /* [RH.13.6] La fila entera abre la ficha; el nombre sigue siendo el botón para el teclado. */
    .rc-tabla tbody tr { cursor: pointer; }
    .rc-tabla tbody tr:hover td { background: var(--surface-hover-bg); }
    .rc-cand { width: 36%; }
    .rc-tabla tr.rc-zona th { text-align: left; background: var(--surface-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color);
      font-size: var(--fs-xs); font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-main); cursor: default; }
    .rc-tabla tr.rc-zona small { margin-left: var(--sp-2); font-size: var(--fs-xs); font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text-muted); }
    .rc-tabla tr.rc-zona b { color: var(--warn-soft-fg); font-weight: 700; }
    .rc-tabla tbody tr.rc-zona:hover th { background: var(--surface-2); }
    /* Apilada (teléfono) la celda del nombre es el título de la tarjeta: todo el ancho. */
    @container densetable (max-width: 34rem) { .rc-tabla td.rc-cand { width: auto; } }
    .rc-meta { display: block; margin-top: 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .rc-esp, .rc-tel, .rc-fecha { white-space: nowrap; }
    .rc-tel span span + span { margin-left: .4em; }
    .rc-tenue { color: var(--text-muted); }
    /* Con el dedo, todo lo que se toca mide al menos 44 px (--tap-min: 0 con mouse). */
    .rc-seg button { min-height: var(--tap-min); }
    :host ::ng-deep .p-button { min-height: var(--tap-min); }
    .rc-nom { font-weight: 700; color: var(--text-main); margin-right: var(--sp-1); }
    .rc-tabla tbody tr:not(.rc-zona):hover .rc-nom { text-decoration: underline; }
    .rc-tabla tbody tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rc-tabla tbody tr:focus-visible td { background: var(--surface-hover-bg); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); margin-left: var(--sp-1); }
    .pill[data-t='mal'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rc-pie { display: flex; justify-content: space-between; align-items: center; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    .rc-err { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    @media (max-width: 40rem) {
      .rc-page { padding: var(--sp-3); }
      .rc-buscar { flex-basis: 100%; margin-left: 0; }
      /* En el teléfono el embudo se desplaza de lado en su renglón, sin partir los grupos. */
      .rc-embudo { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
      .rc-emb { flex: 0 0 auto; }
      .rc-emb button { min-width: 6.5rem; }
      .rc-grupo, .rc-ver { flex: 1 1 auto; }
    }
  `],
})
export class RhCandidatosComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly busqueda$ = new Subject<string>();

  /** `[RH.13.6]` «Ver»: con lo que se trabaja a diario, y aparte lo que se consulta de vez en cuando. */
  readonly opcionesVer = [
    { label: 'Para trabajar', items: APARTADOS.filter((a) => a.id === 'postulados' || a.id === 'en_proceso').map((a) => ({ label: a.label, value: a.id, ayuda: a.ayuda })) },
    { label: 'Archivo', items: APARTADOS.filter((a) => a.id !== 'postulados' && a.id !== 'en_proceso').map((a) => ({ label: a.label, value: a.id, ayuda: a.ayuda })) },
  ];
  /** Los pasos, en el orden en que se avanza, y aparte cómo terminó. */
  readonly flujo = ETAPAS.filter((e) => e.id !== 'contratado' && e.id !== 'rechazado');
  readonly resultado = ETAPAS.filter((e) => e.id === 'contratado' || e.id === 'rechazado');
  readonly esperando = esperando;
  readonly fechaCorta = fechaCortaMx;
  readonly telefonoPartes = telefonoPartes;

  readonly apartado = signal<HrTalentApartado>('postulados');
  readonly etapa = signal<HrTalentEtapa | null>(null);
  /** `[RH.8.1]` Ciudad del catálogo (o `sin_ciudad`), cuando se llega desde una celda del Resumen. */
  readonly ciudad = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly filas = signal<HrCandidatoFilaDto[]>([]);
  readonly total = signal(0);
  readonly porEtapa = signal<Record<string, number>>({});
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly casilleros = signal<HrCasilleroDto[]>([]);
  readonly sel = signal<HrCandidatoFilaDto | null>(null);
  readonly ficha = signal<HrCandidatoFichaDto | null>(null);
  readonly errorFicha = signal<string | null>(null);
  readonly peek = signal(false);

  readonly gestiona = computed(() => this.perms.has(Permission.HR_RECRUITMENT_GESTIONAR));
  readonly totalEtapas = computed(() => Object.values(this.porEtapa()).reduce((s, n) => s + n, 0));
  readonly subtituloFicha = computed(() => {
    const f = this.ficha();
    return f ? [f.position_interest, f.city_branch].filter(Boolean).join(' · ') || null : null;
  });
  readonly vacio = computed(() => {
    if (this.busqueda().trim()) return 'Nadie coincide con la búsqueda';
    if (this.etapa()) return 'Nadie en esta etapa';
    return this.apartado() === 'papelera' ? 'La papelera está vacía' : 'Sin candidatos en este apartado';
  });

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const ap = q.get('view');
    if (APARTADOS.some((a) => a.id === ap)) this.apartado.set(ap as HrTalentApartado);
    const et = q.get('stage');
    if (ETAPAS.some((e) => e.id === et)) this.etapa.set(et as HrTalentEtapa);
    this.busqueda.set(q.get('q') ?? '');
    this.ciudad.set(q.get('city') || null);
    this.busqueda$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.syncUrl(); this.cargar(); });
    this.api.casilleros().subscribe({ next: (c) => this.casilleros.set(c), error: () => this.casilleros.set([]) });
    this.cargar();
    const abrir = q.get('id');
    if (abrir) this.cargarFicha(abrir);
  }

  etiquetaEtapa(id: HrTalentEtapa): string {
    return ETAPAS.find((e) => e.id === id)?.corto ?? id;
  }

  /**
   * `[RH.13.6]` Lo que busca, debajo del nombre. El lugar sólo cuando dice algo que el encabezado de la zona no dice
   * («Morelia Norte» dentro de Morelia, o lo que escribió quien cae en «sin ciudad reconocida»).
   */
  detalle(c: HrCandidatoFilaDto, zona: string | null = null): string {
    const lugar = (c.city_branch ?? '').trim();
    const repite = zona !== null && zona !== HR_TALENT_SIN_CIUDAD && sinAcentos(lugar) === sinAcentos(zona);
    return [c.position_interest?.trim(), repite ? '' : lugar].filter(Boolean).join(' · ');
  }

  /** ¿Ya están cargados todos los de la lista? Si no, las cuentas por zona son de lo cargado y se dice. */
  readonly completo = computed(() => this.filas().length >= this.total());

  /**
   * Los renglones por zona, en el orden del catálogo y «sin ciudad reconocida» al final. Si el servidor todavía no manda
   * la zona (otra versión), la lista va plana: nunca se agrupa con una regla inventada aquí.
   */
  readonly grupos = computed(() => {
    const filas = this.filas();
    if (!filas.every((f) => typeof f.ciudad === 'string')) return [{ zona: null as string | null, etiqueta: '', filas, atrasados: 0 }];
    const orden = [...HR_CIUDADES_EMPLEO, HR_TALENT_SIN_CIUDAD];
    const zonas = [...new Set(filas.map((f) => f.ciudad))].sort((a, b) => (orden.indexOf(a) + 1 || 99) - (orden.indexOf(b) + 1 || 99) || a.localeCompare(b));
    return zonas.map((zona) => {
      const de = filas.filter((f) => f.ciudad === zona);
      return { zona: zona as string | null, etiqueta: zona === HR_TALENT_SIN_CIUDAD ? 'Sin ciudad reconocida' : zona, filas: de, atrasados: de.filter((f) => this.rebasa(f)).length };
    });
  });

  /** Contratado o rechazado: ya no espera respuesta; se dice desde cuándo. */
  esDesenlace(c: HrCandidatoFilaDto): boolean {
    return c.stage === 'contratado' || c.stage === 'rechazado';
  }

  rebasa(c: HrCandidatoFilaDto): boolean {
    return this.apartado() !== 'papelera' && rebasaSla(c.stage, c.last_activity_at ?? c.created_at) === true;
  }

  setApartado(a: HrTalentApartado): void {
    this.apartado.set(a);
    if (a === 'papelera' || a === 'spam') this.etapa.set(null);
    this.syncUrl();
    this.cargar();
  }

  setEtapa(e: HrTalentEtapa | null): void {
    this.etapa.set(e);
    this.syncUrl();
    this.cargar();
  }

  setCiudad(c: string | null): void {
    this.ciudad.set(c);
    this.syncUrl();
    this.cargar();
  }

  nombreCiudad(c: string): string { return c === HR_TALENT_SIN_CIUDAD ? 'sin ciudad reconocida' : c; }

  buscar(t: string): void {
    this.busqueda.set(t);
    this.busqueda$.next(t);
  }

  cargar(masDe = 0): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.candidatos({
      view: this.apartado(), stage: this.etapa(), city: this.ciudad(), q: this.busqueda().trim() || undefined, limit: POR_PAGINA, offset: masDe,
    }).subscribe({
      next: (r) => {
        this.filas.set(masDe ? [...this.filas(), ...r.filas] : r.filas);
        this.total.set(r.total);
        this.porEtapa.set(r.por_etapa);
        this.loading.set(false);
      },
      error: (e) => { this.error.set(rhError(e, 'No se pudo leer la lista de candidatos.')); this.loading.set(false); },
    });
  }

  masFilas(): void { this.cargar(this.filas().length); }

  abrir(c: HrCandidatoFilaDto): void {
    this.sel.set(c);
    this.cargarFicha(c.id);
  }

  private cargarFicha(id: string): void {
    this.ficha.set(null);
    this.errorFicha.set(null);
    this.peek.set(true);
    this.syncUrl(id);
    this.api.ficha(id).subscribe({
      next: (f) => this.ficha.set(f),
      error: (e) => this.errorFicha.set(rhError(e, 'No se pudo abrir la ficha.')),
    });
  }

  /** La ficha cambió: se refleja en la lista sin recargarla (si salió del apartado, se recarga). */
  alActualizar(f: HrCandidatoFichaDto): void {
    this.ficha.set(f);
    const sigueAqui = this.apartado() === 'papelera' ? !!f.deleted_at
      : this.apartado() === 'spam' ? f.is_spam && !f.deleted_at
        : this.apartado() === 'no_recontratables' ? f.no_rehire && !f.deleted_at
          : !f.deleted_at && !f.is_spam;
    const etapaOk = !this.etapa() || this.etapa() === f.stage;
    if (!sigueAqui || !etapaOk) { this.cargar(); return; }
    this.filas.set(this.filas().map((c) => (c.id === f.id ? { ...c, ...f } : c)));
  }

  cambioPeek(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) { this.sel.set(null); this.ficha.set(null); this.syncUrl(null); }
  }

  /** `id` sin pasar = conserva la ficha abierta; `null` = la quita de la URL. */
  private syncUrl(id?: string | null): void {
    if (id === undefined) id = this.ficha()?.id ?? this.sel()?.id ?? null;
    void this.router.navigate([], {
      relativeTo: this.route, replaceUrl: true,
      queryParams: {
        view: this.apartado() === 'postulados' ? null : this.apartado(), stage: this.etapa(), city: this.ciudad(),
        q: this.busqueda().trim() || null, id,
      },
    });
  }
}
