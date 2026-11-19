import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { firstValueFrom } from 'rxjs';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrBajaPlazaDto, HrPosibleBajaDto, HrPosiblesBajasResponse, HrSinPlazasDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, fechaCorta, rhError } from '../rh.service';
import { fechaHoraMx } from '../reclutamiento-formato';

/** `[RH.14.6]` Los días sin checar que proponen la baja (Edgar, D1 del 18-nov); el servidor tiene el mismo valor. */
const DIAS_POR_OMISION = 31;

/**
 * Fase RH · `[RH.7.2]` — Bajas (`/rh/asistencia/bajas`): la papelera de empleados de Mega Talento, por plaza. Quien está
 * aquí no cuenta en el reporte de esa plaza (sin faltas de quien ya se fue). Lo primero es quien SIGUE checando
 * después de su baja: o la baja fue un error, o alguien usa su código. De aquí se reactiva.
 *
 * La baja se da desde la ficha de la persona en Checadas, con motivo. Es baja EN LA PLAZA: quien rota sigue activo en
 * las otras. No borra la huella del reloj físico.
 */
@Component({
  selector: 'app-rh-bajas',
  standalone: true,
  imports: [
    FormsModule, SelectModule, InputTextModule, ButtonModule, TableModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent,
    RhMarcoComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rb-page">
      <app-rh-marco [barra]="false" [franja]="false" />
      <!-- Sin plazas el marco lo declara: aquí no se pinta «nadie» ni ceros de algo que nadie midió. -->
      @if (!est.sinPlazas()) {
      <section class="rb-bar" aria-label="Plaza">
        <p-select [options]="est.sitios()" optionLabel="name" optionValue="code" [ngModel]="est.sitio()" (ngModelChange)="est.setSitio($event)"
                  placeholder="Plaza" appendTo="body" ariaLabel="Plaza" class="rb-plaza" />
        <input pInputText type="search" class="rb-buscar" [ngModel]="buscar()" (ngModelChange)="buscar.set($event)"
               placeholder="Buscar por nombre, código o sección" aria-label="Buscar en las bajas" />
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
      </section>

      <!-- [RH.14.6] Lo que hay que decidir va primero: quién lleva N días sin checar y sigue activo. Nunca se da de baja solo:
           RH elige, escribe el motivo y la baja de cada uno es independiente (la que falla se queda seleccionada). -->
      <section class="rb-card" aria-labelledby="rb-pb-t">
        <div class="rb-pb-head">
          <h2 id="rb-pb-t">Posibles bajas</h2>
          <label class="rb-dias">Sin checar en
            <input pInputText type="number" inputmode="numeric" min="7" max="365" [ngModel]="dias()" (ngModelChange)="cambiarDias($event)"
                   aria-label="Días sin checar" />
            días o más</label>
          <app-freshness-pill measures="fetch" [since]="pbLeidoEn()" label="Leído" />
        </div>
        <app-load-state [loading]="pbLoading() && !posibles()" [error]="pbError()" (retry)="cargarPosibles()">
          @if (pbAviso(); as a) { <p class="rb-aviso" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
          @if (sinPlazas().length) {
            <div class="rb-sinplazas" role="note">
              <p><b>{{ sinPlazas().length }}</b> sin plazas: {{ nombresSinPlazas() }}@if (noArchivables().length) { · {{ noArchivables().length }} con acceso (Sistemas) }</p>
              @if (gestiona() && archivables().length) {
                @if (confirmarArchivo()) {
                  <p-button [label]="'Sí, archivar (' + archivables().length + ')'" severity="danger" size="small" [loading]="archivando()" (onClick)="archivar()" />
                  <p-button label="No" [text]="true" severity="secondary" size="small" (onClick)="confirmarArchivo.set(false)" />
                } @else {
                  <p-button [label]="'Archivar (' + archivables().length + ')'" severity="danger" [outlined]="true" size="small" (onClick)="confirmarArchivo.set(true)" />
                }
              }
            </div>
          }
          @if (!posibles()?.filas?.length) {
            <p class="rb-vacio">Nadie.</p>
          } @else {
            <p-table [value]="posibles()!.filas" dataKey="person_code" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                     [rowHover]="true" [tableStyle]="{ 'min-width': '46rem' }" [selection]="seleccion()" (selectionChange)="seleccion.set($event)">
              <ng-template #header>
                <tr>
                  @if (gestiona()) { <th class="rb-chk"><p-table-header-checkbox ariaLabel="Seleccionar a todos" /></th> }
                  <th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Sección</th><th scope="col">Última checada</th>
                  <th scope="col" class="comm-num">Días sin checar</th><th scope="col">Otras plazas</th>
                </tr>
              </ng-template>
              <ng-template #body let-p>
                <tr>
                  @if (gestiona()) { <td class="rb-chk"><p-table-checkbox [value]="p" [ariaLabel]="'Elegir a ' + (p.nombre || p.person_code)" /></td> }
                  <td class="mono" role="cell" data-label="Clv">{{ p.person_code }}</td>
                  <td role="cell" data-label="Nombre"><b>{{ p.nombre || '—' }}</b>@if (p.promotora) { <span class="rb-tag">promotora</span> }</td>
                  <td role="cell" data-label="Sección">{{ p.seccion || 'sin sección' }}</td>
                  <td class="mono" role="cell" data-label="Última checada">{{ p.ultima_checada ? fecha(p.ultima_checada) : 'nunca checó aquí' }}</td>
                  <td class="mono comm-num" role="cell" data-label="Días sin checar">{{ p.dias_sin_checar ?? '—' }}</td>
                  <td role="cell" data-label="Otras plazas">{{ p.otras_plazas_activas ? 'sigue en ' + p.otras_plazas_activas : 'ninguna' }}</td>
                </tr>
              </ng-template>
            </p-table>
            @if (gestiona()) {
              <form class="rb-lote" (ngSubmit)="darDeBaja()" aria-label="Dar de baja a las personas elegidas">
                <label class="rb-motivo">Motivo
                  <input pInputText name="motivo" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" required /></label>
                <p-button type="submit" [label]="'Dar de baja (' + seleccion().length + ')'"
                          severity="danger" [disabled]="!seleccion().length || motivo().trim().length < 5" [loading]="guardandoLote()" />
              </form>
            }
          }
          @if (posibles()?.explicadas?.length) {
            <details class="rb-explicadas">
              <summary>{{ posibles()!.explicadas.length }} con incidencia</summary>
              <ul>
                @for (x of posibles()!.explicadas; track x.person_code) {
                  <li><span class="mono">#{{ x.person_code }}</span> {{ x.nombre || '—' }} · {{ x.incidencia.etiqueta }} del {{ dia(x.incidencia.desde) }} al {{ dia(x.incidencia.hasta) }}</li>
                }
              </ul>
            </details>
          }
        </app-load-state>
      </section>

      <app-load-state [loading]="loading() && !lista()" [error]="error()" (retry)="cargar()">
        <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Bajas de la plaza" />
        <section class="rb-card dt-scope" aria-label="Bajas de la plaza">
          @if (aviso(); as a) { <p class="rb-aviso" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
          @if (!filas().length) {
            <p class="rb-vacio">{{ lista()?.length ? 'Nadie coincide con «' + buscar() + '».' : 'Nadie está de baja en esta plaza.' }}</p>
          } @else {
            <!-- Con flechas se recorren las filas; Enter (o clic) en una fila pide confirmar su reactivación (D.7). -->
            <p-table [value]="filas()" dataKey="person_code" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                     [rowHover]="true" [tableStyle]="{ 'min-width': '52rem' }" [selectionMode]="gestiona() ? 'single' : undefined"
                     (onRowSelect)="confirmar.set($any($event).data?.person_code ?? null)">
              <ng-template #header>
                <tr>
                  <th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Sección</th><th scope="col">De baja desde</th>
                  <th scope="col">Motivo</th><th scope="col" class="comm-num">Checadas después</th><th scope="col"><span class="sr-only">Acción</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-b>
                    <tr [class.rb-sigue]="b.checadas_desde_baja > 0" [pSelectableRow]="b">
                      <td class="mono" role="cell" data-label="Clv">{{ b.person_code }}</td>
                      <td role="cell" data-label="Nombre"><b>{{ b.nombre || 'Sin persona ligada' }}</b>@if (b.promotora) { <span class="rb-tag">promotora</span> }</td>
                      <td role="cell" data-label="Sección">{{ b.seccion || 'sin sección' }}</td>
                      <td class="mono" role="cell" data-label="De baja desde">{{ fecha(b.desde) }}</td>
                      <td role="cell" data-label="Motivo">
                        @if (b.origen === 'mega_talento') { <span class="rb-muted">Llegó de baja desde Mega Talento</span> }
                        @else { {{ b.motivo || '—' }}@if (b.por) { <span class="rb-muted"> · {{ b.por }}</span> } }
                      </td>
                      <td class="mono comm-num" role="cell" data-label="Checadas después">
                        @if (b.checadas_desde_baja > 0) { <span class="rb-bad">{{ b.checadas_desde_baja }}</span> · la última {{ fecha(b.ultima_checada) }} }
                        @else { 0 }
                      </td>
                      <td class="rb-acc" role="cell">
                        @if (gestiona()) {
                          @if (confirmar() === b.person_code) {
                            <p-button label="Sí, reactivar" size="small" [loading]="guardando()" (onClick)="reactivar(b)" />
                            <p-button label="No" [text]="true" severity="secondary" size="small" (onClick)="confirmar.set(null)" />
                          } @else {
                            <p-button label="Reactivar" severity="secondary" [outlined]="true" size="small" (onClick)="confirmar.set(b.person_code)" />
                          }
                        }
                      </td>
                    </tr>
              </ng-template>
            </p-table>
          }
        </section>
      </app-load-state>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    /* [RH.13.5] Con el dedo, todo lo que se toca mide al menos 44 px (--tap-min: 0 con mouse, 44 en táctil). */
    :host ::ng-deep .p-button, :host ::ng-deep .p-select, :host ::ng-deep .p-multiselect, :host ::ng-deep input.p-inputtext { min-height: var(--tap-min); }
    :host ::ng-deep input { min-height: var(--tap-min); }
    .rb-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rb-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .rb-plaza { min-width: 14rem; }
    .rb-buscar { flex: 1 1 16rem; max-width: 24rem; }
    .rb-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rb-aviso { margin: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--ok-soft-fg); }
    .rb-aviso.bad { color: var(--bad-fg); }
    .rb-vacio { margin: 0; padding: var(--sp-4) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    tr.rb-sigue td { background: var(--warn-soft-bg); }
    .rb-tag { display: inline-block; margin-left: var(--sp-1); font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 4px; border-radius: var(--r-sm);
      background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .rb-muted { color: var(--text-muted); }
    .rb-bad { color: var(--bad-fg); font-weight: 700; }
    .rb-acc { text-align: right; white-space: nowrap; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rb-pb-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-3); }
    .rb-pb-head h2 { margin: 0; font: 700 var(--fs-h3)/1.25 var(--font-body); color: var(--text-main); }
    .rb-dias { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-muted); }
    .rb-dias input { width: 5rem; font-variant-numeric: tabular-nums; }
    .rb-chk { width: 2.75rem; text-align: center; }
    .rb-lote { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-2) var(--sp-3); padding: var(--sp-3); border-top: 1px solid var(--border-color); }
    .rb-motivo { display: flex; flex-direction: column; gap: var(--sp-1); flex: 1 1 20rem; max-width: 34rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .rb-sinplazas { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin: 0 var(--sp-3) var(--sp-2); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); color: var(--text-main); }
    .rb-sinplazas p { margin: 0; flex: 1 1 30ch; }
    .rb-explicadas { margin: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .rb-explicadas summary { cursor: pointer; color: var(--text-muted); min-height: var(--tap-min); }
    .rb-explicadas ul { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: 2px; }
    @media (max-width: 40rem) { .rb-page { padding: var(--sp-3); } }
  `],
})
export class RhBajasComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);

  readonly lista = signal<HrBajaPlazaDto[] | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscar = signal('');
  readonly confirmar = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  private seq = 0;

  readonly gestiona = computed(() => this.perms.has(Permission.HR_DEVICES_GESTIONAR));
  /** Quien sigue checando va primero; después, la baja más reciente (el orden del servidor). */
  readonly filas = computed(() => {
    const todas = filtrarPorBusqueda(this.lista() ?? [], this.buscar(), (b) => [b.person_code, b.nombre ?? '', b.seccion ?? '']);
    return [...todas].sort((a, b) => Number(b.checadas_desde_baja > 0) - Number(a.checadas_desde_baja > 0));
  });
  readonly siguen = computed(() => (this.lista() ?? []).filter((b) => b.checadas_desde_baja > 0));
  readonly leidoEn = signal<Date | null>(null);
  /** Lo primero que se ve: cuántas bajas y cuántas siguen checando (lo que hay que revisar). */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    if (!l) return [];
    const n = this.siguen().length;
    return [
      { label: 'De baja en la plaza', value: l.length },
      { label: 'Siguen checando', value: n, tone: n ? 'warn' : 'muted', sub: n ? '¿la baja fue un error?' : 'en los últimos 30 días' },
    ];
  });
  readonly fecha = fechaHoraMx;
  readonly dia = fechaCorta;

  // ── [RH.14.6] Posibles bajas ──
  readonly dias = signal(DIAS_POR_OMISION);
  readonly posibles = signal<HrPosiblesBajasResponse | null>(null);
  readonly pbLoading = signal(false);
  readonly pbError = signal<string | null>(null);
  readonly pbLeidoEn = signal<Date | null>(null);
  readonly pbAviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly seleccion = signal<HrPosibleBajaDto[]>([]);
  readonly motivo = signal('');
  readonly guardandoLote = signal(false);
  /** `[RH.14.1]` Quién se quedó sin plazas con la última baja (de aquí se archiva). */
  readonly sinPlazas = signal<HrSinPlazasDto[]>([]);
  readonly archivables = computed(() => this.sinPlazas().filter((s) => s.archivable));
  readonly noArchivables = computed(() => this.sinPlazas().filter((s) => !s.archivable));
  readonly nombresSinPlazas = computed(() => this.sinPlazas().map((s) => s.nombre || 'sin nombre').join(', '));
  readonly confirmarArchivo = signal(false);
  readonly archivando = signal(false);
  private pbSeq = 0;
  private motivoDe(dias: number): string { return `Sin checar en esta plaza desde hace ${dias} días o más`; }

  constructor() {
    // Sólo la plaza dispara la lectura; lo que `cargar` toca adentro no se rastrea.
    effect(() => { if (this.est.sitio()) untracked(() => { this.cargar(); this.cargarPosibles(); }); });
  }

  cambiarDias(v: unknown): void {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || n < 7 || n > 365) return;     // el campo dice el rango; fuera de él no se pide nada
    if (n === this.dias()) return;
    this.dias.set(n);
    this.cargarPosibles();
  }

  cargarPosibles(): void {
    const site = this.est.sitio();
    if (!site) return;
    const mi = ++this.pbSeq;
    this.pbLoading.set(true);
    this.pbError.set(null);
    this.api.posiblesBajas(site, this.dias()).subscribe({
      next: (r) => {
        if (mi !== this.pbSeq) return;
        this.posibles.set(r);
        // Lo elegido que ya no está en la lista (otra plaza, otra ventana) se suelta.
        const hay = new Set(r.filas.map((f) => f.person_code));
        this.seleccion.set(this.seleccion().filter((s) => hay.has(s.person_code)));
        if (!this.motivo().trim() || this.motivo().startsWith('Sin checar en esta plaza')) this.motivo.set(this.motivoDe(r.dias));
        this.pbLeidoEn.set(new Date());
        this.pbLoading.set(false);
      },
      error: (e) => { if (mi !== this.pbSeq) return; this.posibles.set(null); this.pbError.set(rhError(e, 'No se pudieron leer las posibles bajas.')); this.pbLoading.set(false); },
    });
  }

  /** Cada baja es independiente: las que fallan se quedan seleccionadas para reintentar, y se dice por qué. */
  darDeBaja(): void {
    const site = this.est.sitio();
    const elegidas = this.seleccion();
    if (!site || !elegidas.length || this.motivo().trim().length < 5 || this.guardandoLote()) return;
    this.guardandoLote.set(true);
    this.pbAviso.set(null);
    this.api.darDeBajaLote({ site_code: site, person_codes: elegidas.map((p) => p.person_code), motivo: this.motivo().trim() }).subscribe({
      next: (r) => {
        this.guardandoLote.set(false);
        const fallo = new Set(r.fallaron.map((f) => f.person_code));
        this.seleccion.set(elegidas.filter((p) => fallo.has(p.person_code)));
        this.sinPlazas.set(r.sin_plazas);
        this.confirmarArchivo.set(false);
        const ok = `${r.dados_de_baja.length} ${r.dados_de_baja.length === 1 ? 'dada' : 'dadas'} de baja en la plaza`;
        this.pbAviso.set(r.fallaron.length
          ? { texto: `${ok} · ${r.fallaron.length} fallaron (siguen elegidas): ${r.fallaron.map((f) => `#${f.person_code}: ${f.error}`).join(' · ')}`, mal: true }
          : { texto: `${ok}`, mal: false });
        this.cargarPosibles();
        this.cargar();
        this.est.asegurar(true);
      },
      error: (e) => { this.guardandoLote.set(false); this.pbAviso.set({ texto: rhError(e, 'No se pudo dar de baja.'), mal: true }); },
    });
  }

  /** `[RH.14.1]` Una por una: la que falla no frena a las demás y se nombra. */
  async archivar(): Promise<void> {
    const lista = this.archivables();
    if (!lista.length || this.archivando()) return;
    this.archivando.set(true);
    const fallaron: string[] = [];
    const fallidas = new Set<string>();
    for (const s of lista) {
      try {
        await firstValueFrom(this.api.archivarPersona({ user_id: s.user_id, motivo: 'Sin plazas activas: se dio de baja en la última que tenía' }));
      } catch (e) {
        fallidas.add(s.user_id);
        fallaron.push(`${s.nombre || 'sin nombre'}: ${rhError(e, 'no se pudo')}`);
      }
    }
    this.archivando.set(false);
    this.confirmarArchivo.set(false);
    const hechas = lista.length - fallaron.length;
    // Se quedan en el aviso las que no se pudieron archivar (para reintentar) y las que tienen acceso (las ve Sistemas).
    this.sinPlazas.set(this.sinPlazas().filter((s) => !s.archivable || fallidas.has(s.user_id)));
    this.pbAviso.set(fallaron.length
      ? { texto: `${hechas} archivada${hechas === 1 ? '' : 's'} · ${fallaron.length} no: ${fallaron.join(' · ')}`, mal: true }
      : { texto: `${hechas} archivada${hechas === 1 ? '' : 's'}`, mal: false });
  }

  cargar(): void {
    const site = this.est.sitio();
    if (!site) return;
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.bajas(site).subscribe({
      next: (l) => { if (mi !== this.seq) return; this.lista.set(l); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudieron leer las bajas.')); this.loading.set(false); },
    });
  }

  reactivar(b: HrBajaPlazaDto): void {
    const site = this.est.sitio();
    if (!site || this.guardando()) return;
    this.guardando.set(true);
    this.api.reactivar({ site_code: site, person_code: b.person_code }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.confirmar.set(null);
        this.aviso.set({ texto: `Reactivada: ${b.nombre || '#' + b.person_code}`, mal: false });
        this.cargar();
        this.est.asegurar(true);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo reactivar.'), mal: true }); },
    });
  }
}
