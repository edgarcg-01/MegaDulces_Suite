import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import type { HrClaseCruce, HrCrucesDto, HrPersonaCruce } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, fechaCorta, rhError } from '../rh.service';

/** Cómo se dice cada clase, y qué significa (en pantalla, no en un `title`). */
const CLASES: Record<HrClaseCruce, { label: string; severity: 'danger' | 'warn' | 'info' | 'secondary'; que: string }> = {
  traslape: { label: 'Jornadas encimadas', severity: 'danger',
    que: 'Dos jornadas completas que se pisan en el tiempo. Nadie está en dos plazas a la vez: o alguien checa por esa persona, o su código lo usa alguien más.' },
  marca_ajena: { label: 'Marca en plaza ajena', severity: 'warn',
    que: 'Una marca suelta en el reloj de otra plaza, a media jornada de la suya. Puede ser una visita legítima (un pedido, un apoyo).' },
  jornada_partida: { label: 'Jornada partida', severity: 'info',
    que: 'Cubrió dos tiendas el mismo día, sin encimarse. Su día aparece cortado: en cada plaza parece «una sola marca».' },
  sueltas: { label: 'Presencias sueltas', severity: 'secondary',
    que: 'Estuvo en dos plazas el mismo día, con más de 4 horas entre una y otra.' },
  ruta_promotora: { label: 'Ruta de promotora', severity: 'secondary',
    que: 'Una promotora haciendo su ruta por dos plazas: es su trabajo.' },
};

/**
 * Fase RH · `[RH.7.4]` — Cruces (`/rh/asistencia/cruces`): la misma persona checando en dos sedes el mismo día. Es la
 * única vista de Asistencia que NO va por plaza: el cruce sólo existe comparando una contra otra (Mega Talento, pestaña
 * «Cruces»). Lo que la hace útil es la CLASIFICACIÓN: primero lo que hay que explicar (jornadas encimadas), luego lo
 * que hay que arreglar (jornadas partidas); las rutas de promotora, que son normales, arrancan ocultas.
 */
@Component({
  selector: 'app-rh-cruces',
  standalone: true,
  imports: [
    FormsModule, SelectModule, ButtonModule, TableModule, TagModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent,
    SidePeekComponent, RhMarcoComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rc-page">
      <app-rh-marco [barra]="false" [franja]="false" />
      <section class="rc-bar" aria-label="Semana">
        <p-select [options]="est.semanasElegibles()" optionLabel="label" optionValue="value" [ngModel]="est.jueves()"
                  (ngModelChange)="est.irASemana($event)" appendTo="body" ariaLabel="Semana de nómina" class="rc-semana" />
        <span class="rc-todas">Todas las plazas</span>
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
      </section>

      <app-load-state [loading]="loading() && !datos()" [error]="error()" (retry)="cargar()">
        <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Cruces de la semana" />
        <section class="rc-card" aria-label="Cruces de plaza">
          <p class="rc-nota">Quién checó en el reloj de <b>otra plaza</b> el mismo día. Se busca entre las personas dadas de alta en dos sedes o más
            (los tres relojes de Oficinas son una sola sede).</p>
          @if (nRutas()) {
            <label class="rc-check"><input type="checkbox" [ngModel]="verRutas()" (ngModelChange)="verRutas.set($event)" />
              Incluir rutas de promotora ({{ nRutas() }})</label>
          }
          @if (!filas().length) {
            <p class="rc-vacio">Nadie checó en dos plazas en esta semana.</p>
          } @else {
            <!-- Con flechas se recorren las filas; Enter (o clic) abre el detalle por día (D.7). -->
            <p-table [value]="filas()" dataKey="user_id" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                     [rowHover]="true" [tableStyle]="{ 'min-width': '48rem' }" selectionMode="single"
                     (onRowSelect)="sel.set($any($event).data ?? null)">
              <ng-template #header>
                <tr>
                  <th scope="col">Nombre</th><th scope="col">Plazas</th><th scope="col">Lo más grave</th>
                  <th scope="col" class="comm-num">Días</th><th scope="col">El último</th>
                </tr>
              </ng-template>
              <ng-template #body let-p>
                <tr [pSelectableRow]="p">
                  <td role="cell" data-label="Nombre"><b>{{ p.nombre }}</b></td>
                  <td role="cell" data-label="Plazas">{{ plazas(p) }}</td>
                  <td role="cell" data-label="Lo más grave"><p-tag [value]="clase(p.clase).label" [severity]="clase(p.clase).severity" /></td>
                  <td class="comm-num" role="cell" data-label="Días">{{ p.diasCruzados }}</td>
                  <td class="mono" role="cell" data-label="El último">{{ fecha(p.ultimoDia) }}</td>
                </tr>
              </ng-template>
            </p-table>
          }
        </section>
      </app-load-state>

      <app-side-peek [open]="!!sel()" (openChange)="$event || sel.set(null)" [width]="640" [title]="sel()?.nombre ?? ''"
                     [subtitle]="sel() ? plazas(sel()!) : null">
        @if (sel(); as p) {
          <div class="rc-ficha">
            <p class="rc-que"><p-tag [value]="clase(p.clase).label" [severity]="clase(p.clase).severity" /> {{ clase(p.clase).que }}</p>
            <p class="rc-altas">Dada de alta en: @for (a of p.altas; track a.site_code + a.codigo; let ultimo = $last) {
              <b>{{ sitio(a.site_code) }}</b> (#{{ a.codigo }}){{ ultimo ? '' : ', ' }} }</p>
            <ul class="rc-dias">
              @for (d of p.dias; track d.fecha) {
                <li>
                  <div class="rc-dia-h"><b class="mono">{{ fecha(d.fecha) }}</b> <p-tag [value]="clase(d.clase).label" [severity]="clase(d.clase).severity" /></div>
                  <ul>
                    @for (e of d.estancias; track e.site_code + e.codigo) {
                      <li class="mono">{{ e.primera }}{{ e.marcas > 1 ? ' – ' + e.ultima : '' }} · {{ sitio(e.site_code) }} (#{{ e.codigo }}) · {{ e.marcas }} marca{{ e.marcas === 1 ? '' : 's' }}</li>
                    }
                  </ul>
                </li>
              }
            </ul>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rc-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rc-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .rc-semana { min-width: 17rem; }
    .rc-todas { font-size: var(--fs-sm); color: var(--text-muted); }
    .rc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rc-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rc-nota b { color: var(--text-main); }
    .rc-check { display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .rc-vacio { margin: 0; padding: var(--sp-4) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    .rc-ficha { display: flex; flex-direction: column; gap: var(--sp-3); }
    .rc-que, .rc-altas { margin: 0; font-size: var(--fs-sm); color: var(--text-main); line-height: 1.5; }
    .rc-dias { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .rc-dias > li { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .rc-dia-h { display: flex; align-items: center; gap: var(--sp-2); }
    .rc-dias ul { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 40rem) { .rc-page { padding: var(--sp-3); } }
  `],
})
export class RhCrucesComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly api = inject(RhService);

  readonly datos = signal<HrCrucesDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly leidoEn = signal<Date | null>(null);
  readonly verRutas = signal(false);
  readonly sel = signal<HrPersonaCruce | null>(null);
  private seq = 0;

  readonly nRutas = computed(() => this.datos()?.resumen.rutas ?? 0);
  /** Las rutas de promotora arrancan ocultas: son normales y ensucian la lista (Mega Talento hace lo mismo). */
  readonly filas = computed(() => (this.datos()?.personas ?? []).filter((p) => this.verRutas() || p.clase !== 'ruta_promotora'));
  readonly resumen = computed<MetricStripItem[]>(() => {
    const r = this.datos()?.resumen;
    if (!r) return [];
    return [
      { label: 'Jornadas encimadas', value: r.traslapes, tone: r.traslapes ? 'bad' : 'muted', sub: 'días: hay que explicarlos' },
      { label: 'Marcas en plaza ajena', value: r.marcasAjenas, tone: r.marcasAjenas ? 'warn' : 'muted', sub: 'días' },
      { label: 'Jornadas partidas', value: r.jornadasPartidas, sub: 'personas que cubrieron dos tiendas' },
      { label: 'Personas que cruzaron', value: r.personas, sub: `de ${this.datos()?.enDosSedes ?? 0} dadas de alta en dos sedes` },
    ];
  });
  readonly fecha = fechaCorta;
  clase(c: HrClaseCruce) { return CLASES[c]; }

  constructor() {
    // El periodo es la semana de nómina del estado compartido (la misma de las otras pestañas); la plaza no aplica.
    effect(() => { const r = this.est.rango(); untracked(() => this.cargar(r.desde, r.hasta)); });
  }

  cargar(desde = this.est.rango().desde, hasta = this.est.rango().hasta): void {
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.cruces(desde, hasta).subscribe({
      next: (d) => { if (mi !== this.seq) return; this.datos.set(d); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudieron leer los cruces de plaza.')); this.loading.set(false); },
    });
  }

  sitio(code: string): string { return this.est.sitios().find((s) => s.code === code)?.name ?? code; }
  plazas(p: HrPersonaCruce): string { return [...new Set(p.altas.map((a) => this.sitio(a.site_code)))].join(' · '); }
}
