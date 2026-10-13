import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type { HrDuplicadoGrupoDto, HrReingresoAlertaDto, HrTiempoPorEtapaDto } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { RhReclutamientoMarcoComponent } from '../components/rh-reclutamiento-marco.component';
import { ReclutamientoService } from '../reclutamiento.service';
import { rhError } from '../rh.service';
import { ETAPAS, duracion, etapaLabel, fechaMx, telefono } from '../reclutamiento-formato';

/** El tiempo por etapa contra la meta que RH se dio (SLA de Mega Talento). `null` = la etapa no tiene meta. */
export function contraMeta(f: HrTiempoPorEtapaDto): { meta: number | null; pasa: boolean | null } {
  const meta = ETAPAS.find((e) => e.id === f.etapa)?.slaHoras ?? null;
  return { meta, pasa: meta == null ? null : f.avg_horas > meta };
}

/**
 * Fase RH · `[RH.2.3]` — Revisiones (`/rh/reclutamiento/revisiones`): lo que hay que mirar aunque nadie lo pida.
 *
 *   · Quién se volvió a postular estando marcado como no recontratable. Una lista negra que hay que ir a consultar no
 *     evita nada: en Mega Talento el caso de Yurécuaro se detectó porque alguien reconoció a la persona.
 *   · Registros duplicados por teléfono: el bot y el portal abren a la misma persona por separado.
 *   · El tiempo promedio en cada etapa contra la meta que RH se dio.
 */
@Component({
  selector: 'app-rh-reclutamiento-revisiones',
  standalone: true,
  imports: [RouterLink, ButtonModule, LoadStateComponent, RhReclutamientoMarcoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rr2-page">
      <app-rh-reclutamiento-marco subtitulo="Lo que hay que mirar aunque nadie lo pida: quién regresó estando marcado, quién está registrado dos veces y cuánto tarda cada etapa.">
        <div acciones><p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" /></div>
      </app-rh-reclutamiento-marco>

      <app-load-state [loading]="loading() && !cargado()" [error]="error()" (retry)="cargar()">
        <section class="rr2-card" aria-label="Se volvieron a postular">
          <h2>Se volvieron a postular estando marcados <span class="mono">{{ reingresos().length }}</span></h2>
          @if (!reingresos().length) {
            <p class="rr2-nota">Nadie en proceso comparte teléfono con alguien marcado como no recontratable.</p>
          } @else {
            <ul class="rr2-lista">
              @for (a of reingresos(); track a.id) {
                <li class="mal">
                  <a [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', id: a.id }"><b>{{ a.full_name || 'Sin nombre' }}</b></a>
                  <span class="mono">{{ telefono(a.phone) }}</span> · {{ etapaLabel(a.stage) }} · se postuló {{ fechaMx(a.created_at) }}
                  <small>Marcado como «{{ a.marcado_nombre || 'sin nombre' }}»: {{ a.motivo }} — {{ a.marcado_por || 'RH' }}, {{ fechaMx(a.marcado_en) }}</small>
                </li>
              }
            </ul>
          }
        </section>

        <section class="rr2-card" aria-label="Registros duplicados">
          <h2>Registros duplicados por teléfono <span class="mono">{{ duplicados().length }}</span></h2>
          <p class="rr2-nota">Abre la ficha del que se queda y usa «Fusionar aquí»: sólo se rellenan los datos que le faltan.</p>
          @if (duplicados().length) {
            <ul class="rr2-lista">
              @for (g of duplicados(); track g.phone_key) {
                <li>
                  <span class="mono">{{ telefono(g.phone_key) }}</span>
                  <span class="rr2-dup">
                    @for (c of g.candidatos; track c.id) {
                      <a [routerLink]="['/rh/reclutamiento']" [queryParams]="{ view: 'en_proceso', id: c.id }">{{ c.full_name || 'Sin nombre' }}</a>
                      <small>({{ c.source || 'sin origen' }}, {{ fechaMx(c.created_at) }}{{ c.has_cv ? ', con CV' : ', sin CV' }})</small>
                    }
                  </span>
                </li>
              }
            </ul>
          }
        </section>

        <section class="rr2-card" aria-label="Tiempo por etapa">
          <h2>Tiempo promedio en cada etapa</h2>
          @if (!tiempos().length) {
            <p class="rr2-nota">Todavía no hay cambios de etapa registrados para medirlo.</p>
          } @else {
            <div class="rr2-scroll dt-scope">
              <table class="rr2-tabla dt-stack">
                <thead><tr><th scope="col">Etapa</th><th scope="col" class="num">Pasos</th><th scope="col" class="num">Promedio</th>
                  <th scope="col" class="num">Mínimo</th><th scope="col" class="num">Máximo</th><th scope="col">Meta</th></tr></thead>
                <tbody>
                  @for (f of tiempos(); track f.etapa) {
                    <tr>
                      <td class="dt-id" role="cell">{{ etapaLabel(f.etapa) }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Pasos">{{ f.n }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Promedio">{{ duracion(f.avg_horas) }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Mínimo">{{ duracion(f.min_horas) }}</td>
                      <td class="num mono dt-num" role="cell" data-label="Máximo">{{ duracion(f.max_horas) }}</td>
                      <td role="cell" data-label="Meta">
                        @let m = contraMeta(f);
                        @if (m.meta == null) { <span class="rr2-gris">sin meta</span> }
                        @else { {{ duracion(m.meta) }} <span class="pill" [attr.data-t]="m.pasa ? 'aviso' : 'ok'">{{ m.pasa ? 'pasa la meta' : 'dentro' }}</span> }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="rr2-nota">{{ total() }} cambios de etapa medidos. Mide desde que entró a la etapa hasta que salió; quien sigue ahí no cuenta todavía.</p>
          }
        </section>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rr2-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rr2-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0;
      padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-3); }
    .rr2-card h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-main); }
    .rr2-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rr2-lista { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .rr2-lista li { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: baseline; }
    .rr2-lista li.mal { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rr2-lista small { display: block; width: 100%; font-size: var(--fs-xs); color: var(--text-muted); }
    .rr2-lista li.mal small { color: inherit; opacity: .85; }
    .rr2-lista a { color: var(--action); }
    .rr2-dup { display: flex; gap: var(--sp-1) var(--sp-2); flex-wrap: wrap; align-items: baseline; }
    .rr2-dup small { display: inline; width: auto; }
    .rr2-scroll { overflow-x: auto; }
    .rr2-tabla { border-collapse: collapse; width: 100%; font-size: var(--fs-sm); }
    .rr2-tabla th { text-align: left; font-size: var(--fs-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted);
      background: var(--surface-2); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rr2-tabla td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: middle; }
    .rr2-tabla .num { text-align: right; }
    .rr2-gris { color: var(--text-muted); font-size: var(--fs-xs); }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-t='ok'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pill[data-t='aviso'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    @media (max-width: 40rem) { .rr2-page { padding: var(--sp-3); } }
  `],
})
export class RhReclutamientoRevisionesComponent implements OnInit {
  private readonly api = inject(ReclutamientoService);

  readonly etapaLabel = etapaLabel;
  readonly fechaMx = fechaMx;
  readonly telefono = telefono;
  readonly duracion = duracion;
  readonly contraMeta = contraMeta;

  readonly reingresos = signal<HrReingresoAlertaDto[]>([]);
  readonly duplicados = signal<HrDuplicadoGrupoDto[]>([]);
  readonly tiempos = signal<HrTiempoPorEtapaDto[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly cargado = signal(false);
  readonly error = signal<string | null>(null);

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    let pendientes = 3;
    const fin = () => { if (--pendientes === 0) { this.loading.set(false); this.cargado.set(true); } };
    const falla = (e: unknown) => { this.error.set(rhError(e, 'No se pudieron leer las revisiones.')); fin(); };
    this.api.reingresos().subscribe({ next: (r) => { this.reingresos.set(r); fin(); }, error: falla });
    this.api.duplicados().subscribe({ next: (d) => { this.duplicados.set(d); fin(); }, error: falla });
    const orden = (id: string) => { const i = ETAPAS.findIndex((e) => e.id === id); return i < 0 ? 99 : i; };
    this.api.tiempoPorEtapa().subscribe({
      next: (t) => { this.tiempos.set([...t.fases].sort((a, b) => orden(a.etapa) - orden(b.etapa))); this.total.set(t.total); fin(); },
      error: falla,
    });
  }
}
