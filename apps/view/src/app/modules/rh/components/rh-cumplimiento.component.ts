import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { HrCumplimientoDto } from '@megadulces/contracts';

import { environment } from '../../../../environments/environment';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';

/**
 * Fase RH · `[RH.15.0]` `[RH.15.7]` `[RH.15.8]` — Cumplimiento de la plaza elegida.
 *
 * Tres listas que la ley pide tener a la mano y hoy no se veían:
 *  · huellas de personas dadas de baja que el reloj todavía tiene (sólo se avisa: quitarlas lo aprueba Sistemas);
 *  · hasta cuándo se conservan las checadas de cada baja (la baja + 1 año, LFT 804-III; nada se borra solo);
 *  · personas activas que no checaron en una semana (la ley pide registrar la jornada de cada trabajador).
 *
 * Las cinco preguntas (`diseno` §0b): 1) primero lo que hay que hacer (huellas por quitar), con su número; 2) lo que
 * ya está bien queda contado, no listado; 3) cada pendiente dice a quién pedírselo; 4) ligado al padrón de la plaza y a
 * los relojes; 5) vive con los relojes, porque las huellas son de ellos.
 *
 * `[RH.15.6]` El aviso de privacidad por la huella salió de aquí (2026-11-23): cuando Legal entregue el texto, se
 * extiende el registro de avisos de Mesa de Servicio en vez de abrir otro.
 */
@Component({
  selector: 'app-rh-cumplimiento',
  standalone: true,
  imports: [LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="rc" aria-labelledby="rc-tit">
      <header class="rc-head">
        <h3 id="rc-tit">Cumplimiento · {{ est.nombreSitio() || 'elige una plaza' }}</h3>
        <app-freshness-pill measures="fetch" [since]="leidoEn()" label="leído" />
      </header>
      @if (datos()) { <app-metric-strip [items]="cifras()" density="compact" ariaLabel="Lo pendiente de cumplimiento en la plaza" /> }
      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!est.sitio()" [skeletonRows]="3"
                      emptyIcon="pi-map-marker" emptyTitle="Elige una plaza" emptyHint="El cumplimiento se ve plaza por plaza." (retry)="cargar()">
        @if (datos(); as d) {
          <div class="rc-bloque">
            <h4>Huellas de personas dadas de baja <span class="rc-n" [class.bad]="pendientes()">{{ pendientes() }} por quitar</span></h4>
            <p class="rc-nota">El reloj todavía las tiene. Pasados {{ diasGracia }} días de la baja ya no hay para qué guardarlas: pídele a Sistemas
              que las quite del reloj. Aquí no se borra nada.</p>
            <ul class="rc-lista">
              @for (p of d.huellasDeBajas; track p.codigo) {
                <li [class.rc-pend]="p.pendiente"><span>{{ p.nombre }} <span class="rc-cod">#{{ p.codigo }}</span></span>
                  <span class="rc-meta">baja el {{ p.baja }} · hace {{ p.dias }} día{{ p.dias === 1 ? '' : 's' }}{{ p.pendiente ? ' · por quitar' : ' · en plazo' }}</span></li>
              } @empty { <li class="rc-meta">Ninguna.</li> }
            </ul>
          </div>

          <div class="rc-bloque">
            <h4>Sin registrar su jornada <span class="rc-n" [class.bad]="d.sinRegistro.length">{{ d.sinRegistro.length }}</span></h4>
            <p class="rc-nota">Activas que no checaron en una semana: o no vinieron, o trabajan sin registrar (ruta, chofer). La ley pide el registro de cada trabajador.</p>
            <ul class="rc-lista">
              @for (p of d.sinRegistro; track p.codigo) {
                <li><span>{{ p.nombre }} <span class="rc-cod">#{{ p.codigo }}</span></span>
                  <span class="rc-meta">{{ p.ultima ? 'última checada el ' + p.ultima : 'nunca ha checado' }}</span></li>
              } @empty { <li class="rc-meta">Todas checaron esta semana.</li> }
            </ul>
          </div>

          <details class="rc-bloque">
            <summary><h4>Hasta cuándo se conservan las checadas de las bajas <span class="rc-n">{{ d.conservar.length }}</span></h4></summary>
            <p class="rc-nota">La ley pide guardarlas al menos un año después de la baja (LFT art. 804). La fecha de baja es la última vez que se
              editó su ficha inactiva. Nada se borra solo.</p>
            <ul class="rc-lista">
              @for (p of d.conservar; track p.codigo) {
                <li><span>{{ p.nombre }} <span class="rc-cod">#{{ p.codigo }}</span></span><span class="rc-meta">baja {{ p.baja }} · conservar hasta {{ p.hasta }}</span></li>
              } @empty { <li class="rc-meta">Sin bajas en esta plaza.</li> }
            </ul>
          </details>
        }
      </app-load-state>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rc { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .rc-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
    .rc h3 { margin: 0; font-size: var(--fs-h3); font-weight: 700; color: var(--text-main); }
    .rc h4 { display: inline-flex; gap: var(--sp-2); align-items: baseline; margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .rc-bloque { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-2); border-top: 1px solid var(--border-color); }
    .rc-bloque summary { cursor: pointer; list-style: none; }
    .rc-bloque summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .rc-n { font-weight: 600; color: var(--text-muted); font-size: var(--fs-sm); }
    .rc-n.bad { color: var(--bad-soft-fg); }
    .rc-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 72ch; }
    .rc-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rc-lista li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); padding: var(--sp-1) 0; font-size: var(--fs-sm); color: var(--text-main); min-height: var(--tap-min); }
    .rc-pend span:first-child { font-weight: 600; }
    .rc-cod { color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-xs); }
    .rc-meta { color: var(--text-muted); font-size: var(--fs-xs); }
  `],
})
export class RhCumplimientoComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/hr/attendance/compliance`;

  readonly diasGracia = 7;

  readonly datos = signal<HrCumplimientoDto | null>(null);
  readonly leidoEn = signal<Date | null>(null);
  /** Q.1: lo pendiente primero. */
  readonly cifras = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return [
      { label: 'Huellas por quitar', value: this.pendientes(), format: 'number', tone: this.pendientes() ? 'bad' : 'ok' },
      { label: 'Sin registrar jornada', value: d.sinRegistro.length, format: 'number', tone: d.sinRegistro.length ? 'warn' : 'ok' },
    ];
  });
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly pendientes = computed(() => (this.datos()?.huellasDeBajas ?? []).filter((p) => p.pendiente).length);

  constructor() {
    effect(() => { this.est.sitio(); untracked(() => this.cargar()); });
  }

  cargar(): void {
    const site = this.est.sitio();
    if (!site) { this.datos.set(null); return; }
    this.cargando.set(true);
    this.error.set(null);
    this.http.get<HrCumplimientoDto>(this.base, { params: new HttpParams().set('site_code', site) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.cargando.set(false); },
        error: (e) => { this.error.set(mensajeDe(e, 'No se pudo leer el cumplimiento de la plaza.')); this.cargando.set(false); },
      });
  }
}

function mensajeDe(e: unknown, porDefecto: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : (m || porDefecto);
}
