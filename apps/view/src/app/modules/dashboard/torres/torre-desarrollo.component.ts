import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { TorreDesarrollo } from '@megadulces/contracts';
import { resumenDeSenales } from '@megadulces/contracts';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { TorreBandejaComponent } from './torre-bandeja.component';
import { TorreEstadoComponent } from './torre-estado.component';
import { TorresService } from './torres.service';

/**
 * `[TOR.3.2]` **Torre de Desarrollo** — ¿producción está sana y al día con main, y qué rompimos?
 * (plan: `FASE_TOR_TORRES_DE_CONTROL.md` §3.2, diseño aprobado por Edgar el 2026-11-04).
 * Reemplaza `/admin/db-health`, que redirige aquí.
 *
 * Primario: la frase y la entrega. Secundario: «Atender». Terciario: las tarjetas por carril.
 */
@Component({
  selector: 'app-torre-desarrollo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FreshnessPillComponent, LoadStateComponent, MetricStripComponent, TorreBandejaComponent, TorreEstadoComponent],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1>Torre de Desarrollo</h1>
          <p class="sub">Nuestra infraestructura: la entrega, el servidor md, la base, los respaldos y los carriles de la suite</p>
        </div>
        <div class="acciones">
          @if (datos(); as d) {
            <app-freshness-pill measures="data" [since]="d.verificado_al" label="verificado" [staleAfterSec]="180" />
          }
          <button type="button" class="btn" (click)="cargar()" [disabled]="cargando()">
            <i class="pi pi-refresh" aria-hidden="true"></i> Actualizar
          </button>
        </div>
      </header>

      @if (accion(); as a) {
        <p class="accion" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</p>
      }

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        @if (datos(); as d) {
          <section class="frase" aria-live="polite">
            <p class="primaria">{{ frase() }}</p>
            <p class="secundaria">{{ subfrase() }}</p>
          </section>

          <app-metric-strip [items]="metricas()" ariaLabel="Resumen de la torre de Desarrollo" density="compact" [instant]="true" />

          <section class="entrega" aria-labelledby="t-entrega">
            <h2 id="t-entrega">Entrega: de main a lo que corre</h2>
            <ol class="pasos">
              <li class="paso">
                <span class="paso-n">1 · main en GitHub</span>
                <span class="sha">{{ d.entrega.main ?? 'no medido' }}</span>
                <span class="paso-nota">lo último que se empujó</span>
              </li>
              <li class="paso">
                <span class="paso-n">2 · sellado por el CI</span>
                <span class="sha">{{ d.entrega.sellado ?? 'no medido' }}</span>
                @if (d.entrega.main && d.entrega.sellado) {
                  @if (d.entrega.main === d.entrega.sellado) {
                    <app-torre-estado estado="ok" texto="igual a main" />
                  } @else {
                    <app-torre-estado estado="riesgo" texto="el CI no ha sellado lo último" />
                  }
                }
              </li>
              <li class="paso" [class.alerta]="(d.entrega.sin_soltar ?? 0) > 0">
                <span class="paso-n">3 · soltado a producción</span>
                <span class="sha">{{ d.entrega.soltado ?? 'no medido' }}</span>
                @if (d.entrega.sin_soltar != null) {
                  @if (d.entrega.sin_soltar === 0) {
                    <app-torre-estado estado="ok" texto="igual a lo sellado" />
                  } @else {
                    <app-torre-estado estado="riesgo" [texto]="d.entrega.sin_soltar + ' commit(s) sellados sin soltar'" />
                  }
                }
              </li>
              <li class="paso">
                <span class="paso-n">4 · corriendo en producción</span>
                <span class="sha">{{ d.entrega.corriendo }}</span>
                @if (d.entrega.soltado && !mismo(d.entrega.soltado, d.entrega.corriendo)) {
                  <app-torre-estado estado="falla" texto="no es lo soltado" />
                } @else {
                  <span class="paso-nota">arriba desde {{ d.entrega.arriba_desde | date: 'dd/MM HH:mm' }}</span>
                }
              </li>
            </ol>
            @if (d.entrega.migraciones_pendientes != null && d.entrega.migraciones_pendientes > 0) {
              <p class="migr"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span><strong>{{ d.entrega.migraciones_pendientes }} migraciones sin aplicar</strong>, según el último paso del despliegue. Se aplican una por una, antes de soltar.</span></p>
            } @else if (d.entrega.migraciones_pendientes == null) {
              <p class="migr nm">Migraciones pendientes: no medido. Sólo se saben cuando el despliegue las encuentra.</p>
            }
          </section>

          <section class="bloque" aria-labelledby="t-atender">
            <div class="bloque-head">
              <h2 id="t-atender">Atender</h2>
              <span class="meta">lo más grave primero</span>
            </div>
            <app-torre-bandeja [senales]="d.atender" (visto)="marcarVista($event)" />
          </section>

          <section class="bloque" aria-labelledby="t-carriles">
            <h2 id="t-carriles">Por carril</h2>
            <div class="tarjetas">
              @for (c of d.carriles; track c.clave) {
                <div class="tarjeta">
                  <div class="tarjeta-head"><span class="tarjeta-nombre">{{ c.nombre }}</span><app-torre-estado [estado]="c.estado" [texto]="c.texto_estado" /></div>
                  @for (l of c.lineas; track $index) { <span class="tarjeta-linea">{{ l }}</span> }
                </div>
              }
            </div>
          </section>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { padding: var(--sp-5) var(--sp-6) var(--sp-10); max-width: 1320px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--sp-5); container-type: inline-size; }
    .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-4); }
    h1 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--text-main); }
    .sub { margin: 0; color: var(--text-muted); font-size: var(--fs-body); }
    .acciones { display: flex; align-items: center; gap: var(--sp-3); }
    .btn { height: 36px; display: inline-flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-3); border: 1px solid var(--border-color);
           border-radius: var(--r-sm); background: var(--surface-card); color: var(--text-main); font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-bold); cursor: pointer; }
    .btn:hover { background: var(--surface-hover); }
    .btn:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .accion { margin: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border); border-radius: var(--r-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .frase { display: flex; flex-direction: column; gap: var(--sp-1); }
    .primaria { margin: 0; font-size: var(--fs-display); font-weight: var(--fw-bold); letter-spacing: -0.02em; color: var(--text-main); line-height: 1.15; }
    .secundaria { margin: 0; font-size: var(--fs-body); color: var(--text-muted); }
    h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); }
    .entrega { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-card); }
    .pasos { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: var(--sp-3); }
    .paso { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .paso.alerta { border-color: var(--warn-border); background: var(--warn-soft-bg); }
    .paso-n { font-size: var(--fs-xs); color: var(--text-muted); }
    .sha { font-family: var(--font-mono); font-size: var(--fs-lg); color: var(--text-main); }
    .paso-nota { font-size: var(--fs-xs); color: var(--text-muted); }
    .migr { margin: 0; display: flex; gap: var(--sp-2); align-items: flex-start; font-size: var(--fs-sm); color: var(--warn-soft-fg); }
    .migr.nm { color: var(--text-muted); }
    .bloque { display: flex; flex-direction: column; gap: var(--sp-2); }
    .bloque-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
    .meta { font-size: var(--fs-xs); color: var(--text-faint); }
    .tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: var(--sp-3); }
    .tarjeta { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-card); }
    .tarjeta-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); margin-bottom: var(--sp-1); }
    .tarjeta-nombre { font-weight: var(--fw-bold); font-size: var(--fs-body); color: var(--text-main); }
    .tarjeta-linea { font-size: var(--fs-sm); color: var(--text-soft); }
    @container (max-width: 40rem) { .primaria { font-size: var(--fs-h2); } .page { padding: var(--sp-4); } }
    @media (pointer: coarse) { .btn { height: 44px; } }
  `],
})
export class TorreDesarrolloComponent implements OnInit {
  private readonly svc = inject(TorresService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly datos = signal<TorreDesarrollo | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly accion = signal<string | null>(null);

  private readonly resumen = computed(() => resumenDeSenales(this.datos()?.atender ?? []));

  /** La pregunta de la pantalla en una frase: lo más grave, con nombre. */
  readonly frase = computed(() => {
    const d = this.datos();
    if (!d) return '';
    const fallas = d.atender.filter((s) => s.estado === 'falla');
    if (!fallas.length) return this.resumen().riesgos ? 'Producción responde; hay riesgos que atender' : 'Producción responde y no hay nada roto';
    return fallas.length === 1
      ? `Producción responde, pero «${fallas[0].que}» está en falla`
      : `Producción responde, pero hay ${fallas.length} cosas en falla`;
  });

  readonly subfrase = computed(() => {
    const d = this.datos();
    if (!d) return '';
    const p: string[] = [];
    const r = this.resumen();
    if (r.fallas) p.push(`${r.fallas} en falla`);
    if (r.riesgos) p.push(`${r.riesgos} en riesgo`);
    if (r.no_medidos) p.push(`${r.no_medidos} sin medir`);
    if (d.entrega.sin_soltar) p.push(`${d.entrega.sin_soltar} commit(s) sin soltar`);
    return p.join(' · ');
  });

  readonly metricas = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const r = this.resumen();
    return [
      { label: 'En falla', value: r.fallas, format: 'number', tone: r.fallas ? 'bad' : 'default' },
      { label: 'En riesgo', value: r.riesgos, format: 'number', tone: r.riesgos ? 'warn' : 'default' },
      d.entrega.sin_soltar == null
        ? { label: 'Commits sellados sin soltar', value: '—', format: 'text', state: 'no_medido', stateNote: 'GitHub no contestó' }
        : { label: 'Commits sellados sin soltar', value: d.entrega.sin_soltar, format: 'number', tone: d.entrega.sin_soltar ? 'warn' : 'default' },
      d.entrega.migraciones_pendientes == null
        ? { label: 'Migraciones sin aplicar', value: '—', format: 'text', state: 'no_medido', stateNote: 'sólo se saben cuando el despliegue las encuentra' }
        : { label: 'Migraciones sin aplicar', value: d.entrega.migraciones_pendientes, format: 'number', tone: d.entrega.migraciones_pendientes ? 'warn' : 'default' },
    ];
  });

  ngOnInit(): void {
    this.cargar();
    encuestarVisible(60_000, () => this.cargar(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.svc.desarrollo().subscribe({
      next: (d) => { this.datos.set(d); this.error.set(null); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); if (!this.datos()) this.error.set(e?.error?.message || e?.message || 'Error de red'); },
    });
  }

  marcarVista(id: string): void {
    this.accion.set(null);
    this.svc.marcarVista(id).subscribe({
      next: (r) => { if (!r?.ok) this.accion.set('No se marcó como vista: la alerta ya no existe.'); this.cargar(true); },
      error: (e) => this.accion.set(`No se pudo marcar como vista: ${e?.error?.message || e?.message || 'error de red'}`),
    });
  }

  /** Dos sha del mismo commit pueden venir con distinto largo. */
  mismo(a: string, b: string): boolean {
    return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
  }
}
