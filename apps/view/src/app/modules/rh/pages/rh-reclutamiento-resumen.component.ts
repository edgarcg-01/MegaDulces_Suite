import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { HR_TALENT_SIN_CIUDAD, type HrResumenReclutamientoDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { ETAPAS } from '../reclutamiento-formato';
import { rhError } from '../rh.service';

/**
 * Fase RH · `[RH.8.1]` — Resumen del reclutamiento (`/rh/reclutamiento/resumen`): el «concentrado» de Mega Talento,
 * reducido a la pregunta de todos los días — ¿cuántos candidatos hay en cada etapa y de qué ciudad? — con lo primero que
 * importa arriba: cuántos llevan en su etapa más que la meta de RH (ahí se atora el proceso).
 *
 * Cada número lleva a Candidatos ya filtrado por esa etapa y esa ciudad, y la lista cuenta lo mismo que la celda (lo
 * prueba `talent-resumen.db.spec`). La ciudad es la que reconoce el bot en lo que escribió la persona; lo que no se
 * reconoce va a «sin ciudad reconocida» y se dice cuántos y por qué.
 */
@Component({
  selector: 'app-rh-reclutamiento-resumen',
  standalone: true,
  imports: [RouterLink, ButtonModule, TableModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rr-page">
      <app-rh-reclutamiento-marco>
        <div acciones class="rr-acc">
          <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !datos()" [error]="error()" (retry)="cargar()">
        <app-metric-strip [items]="metas()" density="compact" ariaLabel="Fuera de la meta de su etapa" />
        <section class="rr-card" aria-label="Candidatos en proceso por ciudad y etapa">
          <p class="rr-nota">Candidatos <b>en proceso</b> (sin spam ni papelera), por ciudad y etapa. Toca un número para ver quiénes son;
            Enter sobre una fila abre toda esa ciudad.</p>
          <p-table [value]="filas()" dataKey="ciudad" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                   [tableStyle]="{ 'min-width': '44rem' }" selectionMode="single" (onRowSelect)="abrirCiudad($any($event).data?.ciudad)">
            <ng-template #header>
              <tr>
                <th scope="col">Ciudad</th>
                @for (e of etapas; track e.id) { <th scope="col" class="comm-num">{{ e.corto }}</th> }
                <th scope="col" class="comm-num">Total</th>
              </tr>
            </ng-template>
            <ng-template #body let-c>
              <tr [pSelectableRow]="c" [class.rr-sin]="c.ciudad === sinCiudad">
                <td role="cell" data-label="Ciudad"><b>{{ nombre(c.ciudad) }}</b></td>
                @for (e of etapas; track e.id) {
                  <td class="comm-num" role="cell" [attr.data-label]="e.corto">
                    @if (c.por_etapa[e.id]) {
                      <a [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', stage: e.id, city: c.ciudad }"
                         (click)="$event.stopPropagation()" [attr.aria-label]="c.por_etapa[e.id] + ' en ' + e.label + ', ' + nombre(c.ciudad)">{{ c.por_etapa[e.id] }}</a>
                    } @else { <span class="rr-cero">0</span> }
                  </td>
                }
                <td class="comm-num rr-tot" role="cell" data-label="Total">{{ c.total }}</td>
              </tr>
            </ng-template>
          </p-table>
          @if (datos(); as d) {
            <p class="rr-nota">«Sin ciudad reconocida»: <b>{{ d.sin_ciudad.vacia }}</b> no la escribieron y <b>{{ d.sin_ciudad.no_reconocida }}</b>
              escribieron algo que no es una de nuestras ciudades o nombra dos («La Piedad o Santa Ana»). No se adivina.</p>
          }
        </section>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rr-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rr-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .rr-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rr-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rr-nota b { color: var(--text-main); }
    .rr-card a { color: var(--text-main); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
    .rr-card a:focus-visible { outline: 2px solid var(--focus-ring); border-radius: var(--r-sm); }
    .rr-cero { color: var(--text-faint); }
    .rr-tot { font-weight: 700; }
    tr.rr-sin td { color: var(--text-muted); }
    @media (max-width: 40rem) { .rr-page { padding: var(--sp-3); } }
  `],
})
export class RhReclutamientoResumenComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);
  private readonly router = inject(Router);

  readonly etapas = ETAPAS;
  readonly sinCiudad = HR_TALENT_SIN_CIUDAD;
  readonly datos = signal<HrResumenReclutamientoDto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly leidoEn = signal<Date | null>(null);

  readonly filas = computed(() => this.datos()?.ciudades ?? []);
  /**
   * Lo primero: dónde se atora el proceso HOY (fuera de meta, entre los que se mueven) y, aparte, el rezago (sin
   * movimiento hace más de `rezago_dias`): revueltos, todo se veía atrasado y no decía nada.
   */
  readonly metas = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const vigentes = d.etapas.filter((e) => e.fuera_de_meta !== null);
    const rezago = vigentes.reduce((t, e) => t + e.rezago, 0);
    return [
      ...vigentes.map((e) => {
        const v = ETAPAS.find((x) => x.id === e.etapa);
        const n = e.fuera_de_meta ?? 0;
        return { label: `${v?.corto ?? e.etapa}: fuera de meta`, value: n, tone: n ? 'warn' as const : 'muted' as const,
          sub: `de ${e.total - e.rezago} que se mueven · meta ${v?.slaHoras ?? '—'} h` };
      }),
      { label: `Sin movimiento hace más de ${d.rezago_dias} días`, value: rezago, tone: rezago ? 'bad' : 'muted',
        sub: 'nadie los ha movido ni cerrado' },
    ];
  });

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.resumen().subscribe({
      next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { this.error.set(rhError(e, 'No se pudo leer el resumen del reclutamiento.')); this.loading.set(false); },
    });
  }

  nombre(c: string): string { return c === HR_TALENT_SIN_CIUDAD ? 'Sin ciudad reconocida' : c; }

  abrirCiudad(ciudad: string | null | undefined): void {
    if (!ciudad) return;
    void this.router.navigate(['/rh/reclutamiento'], { queryParams: { view: 'en_proceso', city: ciudad } });
  }
}
