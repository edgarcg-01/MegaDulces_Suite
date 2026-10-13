import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, debounceTime } from 'rxjs';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import type { HrCandidatoFichaDto, HrCandidatoFilaDto, HrCasilleroDto, HrTalentApartado, HrTalentEtapa } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { RhCandidatoFichaComponent } from '../components/rh-candidato-ficha.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import { APARTADOS, ETAPAS, fechaMx, hace, rebasaSla, telefono } from '../reclutamiento-formato';

const POR_PAGINA = 100;

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
  imports: [FormsModule, InputTextModule, ButtonModule, LoadStateComponent, SidePeekComponent, RhReclutamientoMarcoComponent, RhCandidatoFichaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rc-page">
      <app-rh-reclutamiento-marco>
        <div acciones><p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" /></div>
      </app-rh-reclutamiento-marco>

      <section class="rc-bar" aria-label="Qué ver">
        <div class="rc-seg" role="group" aria-label="Apartado">
          @for (a of apartados; track a.id) {
            <button type="button" [attr.aria-pressed]="apartado() === a.id" [title]="a.ayuda" (click)="setApartado(a.id)">{{ a.label }}</button>
          }
        </div>
        <div class="rc-buscar">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" placeholder="Nombre, puesto o teléfono" autocomplete="off" aria-label="Buscar candidato"
                 [ngModel]="busqueda()" (ngModelChange)="buscar($event)" />
        </div>
      </section>

      @if (apartado() !== 'papelera' && apartado() !== 'spam') {
        <nav class="rc-etapas" aria-label="Etapas">
          <button type="button" [attr.aria-pressed]="!etapa()" (click)="setEtapa(null)">Todas <span class="mono">{{ totalEtapas() }}</span></button>
          @for (e of etapas; track e.id) {
            <button type="button" [attr.aria-pressed]="etapa() === e.id" (click)="setEtapa(e.id)">{{ e.corto }} <span class="mono">{{ porEtapa()[e.id] ?? 0 }}</span></button>
          }
        </nav>
      }

      <app-load-state [loading]="loading() && !filas().length" [error]="error()" [isEmpty]="!loading() && !error() && !filas().length"
                      emptyIcon="pi-users" [emptyTitle]="vacio()" (retry)="cargar()">
        <section class="rc-card" aria-label="Candidatos">
          <div class="rc-scroll dt-scope">
            <table class="rc-tabla dt-stack">
              <thead><tr>
                <th scope="col">Nombre</th><th scope="col">Etapa</th><th scope="col">Puesto</th><th scope="col">Plaza</th>
                <th scope="col">Teléfono</th><th scope="col">Última actividad</th><th scope="col">Alta</th>
              </tr></thead>
              <tbody>
                @for (c of filas(); track c.id) {
                  <tr [class.sel]="sel()?.id === c.id">
                    <td class="dt-id" role="cell">
                      <button type="button" class="rc-nom" (click)="abrir(c)">{{ c.full_name || 'Sin nombre' }}</button>
                      @if (c.no_rehire) { <span class="pill" data-t="mal">No recontratable</span> }
                      @if (!c.has_cv) { <span class="pill" data-t="aviso">Sin CV</span> }
                    </td>
                    <td role="cell" data-label="Etapa">
                      {{ etiquetaEtapa(c.stage) }}
                      @if (rebasa(c)) { <span class="pill" data-t="aviso" title="Pasó el tiempo que RH se dio para responder en esta etapa">Atrasado</span> }
                    </td>
                    <td role="cell" data-label="Puesto">{{ c.position_interest || '—' }}</td>
                    <td role="cell" data-label="Plaza">{{ c.city_branch || '—' }}</td>
                    <td class="mono" role="cell" data-label="Teléfono">{{ telefono(c.phone) }}</td>
                    <td role="cell" data-label="Última actividad">{{ hace(c.last_activity_at ?? c.created_at) }}</td>
                    <td role="cell" data-label="Alta">{{ fechaMx(c.created_at) }}</td>
                  </tr>
                }
              </tbody>
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
    .rc-seg button:focus-visible, .rc-etapas button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rc-buscar { position: relative; flex: 0 1 22rem; }
    .rc-buscar i { position: absolute; left: var(--sp-2); top: 50%; transform: translateY(-50%); color: var(--text-muted); }
    .rc-buscar input { width: 100%; padding-left: calc(var(--sp-2) * 3.5); }
    .rc-etapas { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rc-etapas button { border: 1px solid var(--border-color); background: var(--card-bg); border-radius: var(--r-pill); padding: 2px var(--sp-3);
      font: inherit; font-size: var(--fs-xs); color: var(--text-muted); cursor: pointer; }
    .rc-etapas button[aria-pressed='true'] { background: var(--surface-selected-bg); color: var(--text-main); font-weight: 600; }
    .rc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .rc-scroll { overflow-x: auto; }
    .rc-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rc-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rc-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rc-tabla tr.sel td { background: var(--surface-2); }
    .rc-nom { border: 0; background: none; padding: 0; font: inherit; font-weight: 700; color: var(--text-main); cursor: pointer; text-align: left; margin-right: var(--sp-1); }
    .rc-nom:hover { text-decoration: underline; }
    .rc-nom:focus-visible { outline: 2px solid var(--focus-ring); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); margin-left: var(--sp-1); }
    .pill[data-t='mal'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .rc-pie { display: flex; justify-content: space-between; align-items: center; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border-color); }
    .rc-err { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    @media (max-width: 40rem) { .rc-page { padding: var(--sp-3); } .rc-buscar { flex-basis: 100%; } }
  `],
})
export class RhCandidatosComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);
  private readonly perms = inject(PermissionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly busqueda$ = new Subject<string>();

  readonly apartados = APARTADOS;
  readonly etapas = ETAPAS;
  readonly fechaMx = fechaMx;
  readonly hace = hace;
  readonly telefono = telefono;

  readonly apartado = signal<HrTalentApartado>('postulados');
  readonly etapa = signal<HrTalentEtapa | null>(null);
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
    this.busqueda$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => { this.syncUrl(); this.cargar(); });
    this.api.casilleros().subscribe({ next: (c) => this.casilleros.set(c), error: () => this.casilleros.set([]) });
    this.cargar();
    const abrir = q.get('id');
    if (abrir) this.cargarFicha(abrir);
  }

  etiquetaEtapa(id: HrTalentEtapa): string {
    return ETAPAS.find((e) => e.id === id)?.corto ?? id;
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

  buscar(t: string): void {
    this.busqueda.set(t);
    this.busqueda$.next(t);
  }

  cargar(masDe = 0): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.candidatos({
      view: this.apartado(), stage: this.etapa(), q: this.busqueda().trim() || undefined, limit: POR_PAGINA, offset: masDe,
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
        view: this.apartado() === 'postulados' ? null : this.apartado(), stage: this.etapa(),
        q: this.busqueda().trim() || null, id,
      },
    });
  }
}
