import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TableModule } from 'primeng/table';
import type { CaidaKepler, ServidorKepler, TorreSistemas } from '@megadulces/contracts';
import { resumenDeSenales } from '@megadulces/contracts';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { TorreBandejaComponent } from './torre-bandeja.component';
import { TorreEstadoComponent } from './torre-estado.component';
import { TorresService } from './torres.service';

/**
 * `[TOR.3.1]` **Torre de Sistemas** — ¿qué servidor o carril de Kepler está caído o atrasado, en
 * qué sucursal, y qué hago? (plan: `FASE_TOR_TORRES_DE_CONTROL.md` §3.1, diseño aprobado por Edgar
 * el 2026-11-04).
 *
 * Primario: la frase de arriba y los servidores con falla. Secundario: la tabla de servidores y
 * «Atender». Terciario: los demás carriles. Lo que no se mide dice «no medido», nunca un cero.
 */
@Component({
  selector: 'app-torre-sistemas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TableModule, FreshnessPillComponent, LoadStateComponent, MetricStripComponent,
    SidePeekComponent, TorreBandejaComponent, TorreEstadoComponent],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1>Torre de Sistemas</h1>
          <p class="sub">Los servidores Kepler de las 9 sucursales y los carriles que alimentan la suite</p>
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
          @if (d.avisos && d.avisos.abiertas_30d > 0 && d.avisos.notificadas_30d === 0) {
            <section class="aviso" aria-label="Avisos">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <p><strong>Las alertas no salen de esta pantalla.</strong>
                En 30 días se abrieron {{ d.avisos.abiertas_30d }} alertas y no se avisó ninguna por correo ni WhatsApp:
                faltan los destinatarios de Sistemas.</p>
            </section>
          }

          <section class="frase" aria-live="polite">
            <p class="primaria">{{ frase() }}</p>
            <p class="secundaria">{{ subfrase() }}</p>
          </section>

          <app-metric-strip [items]="metricas()" ariaLabel="Resumen de la torre de Sistemas" density="compact" [instant]="true" />

          <section class="bloque" aria-labelledby="t-serv">
            <div class="bloque-head">
              <h2 id="t-serv">Servidores Kepler</h2>
              <span class="meta">primero lo que hay que mirar</span>
            </div>
            <div class="dt-scope tabla">
              <p-table [value]="d.servidores" styleClass="surf-table surf-table--plain dt-stack" [tableStyle]="{ 'min-width': '52rem' }">
                <ng-template #header>
                  <tr>
                    <th>Sucursal</th>
                    <th>Servidor</th>
                    <th>Réplica a md</th>
                    <th>Disco retenido</th>
                    <th>Horario de hoy</th>
                    <th class="num">Caídas de 10 min o más · 30 días</th>
                    <th><span class="sr-only">Detalle</span></th>
                  </tr>
                </ng-template>
                <ng-template #body let-s>
                  <tr [class.sel]="seleccion()?.codigo === s.codigo">
                    <td class="dt-id nombre" role="cell">{{ s.nombre }}</td>
                    <td role="cell" data-label="Servidor"><app-torre-estado [estado]="s.estado" [texto]="s.texto_estado" /></td>
                    <td role="cell" data-label="Réplica a md">
                      @if (s.replica_s != null) { <span class="mono">{{ s.replica_s }} s</span> } @else { <span class="nm">no medido</span> }
                      @if (s.errores_replica) { <span class="linea2">{{ s.errores_replica }} error(es) de réplica acumulados</span> }
                    </td>
                    <td role="cell" data-label="Disco retenido">
                      @if (s.disco_retenido_bytes != null) { <span class="mono">{{ tam(s.disco_retenido_bytes) }}</span> } @else { <span class="nm">no medido</span> }
                    </td>
                    <td role="cell" data-label="Horario de hoy">
                      @if (s.abre && s.cierra) { <span class="mono">{{ s.abre }} – {{ s.cierra }}</span> } @else { <span class="nm">sin venta al público</span> }
                    </td>
                    <td role="cell" data-label="Caídas · 30 días" class="num">
                      @if (s.caidas_30d != null) {
                        <span class="mono fuerte">{{ s.caidas_30d }}</span>
                        <span class="linea2">la más larga {{ dur(s.caida_mas_larga_min) }}</span>
                      } @else { <span class="nm">no medido</span> }
                    </td>
                    <td role="cell" class="acc">
                      <button type="button" class="btn-icono" [attr.aria-label]="'Ver detalle de ' + s.nombre" (click)="abrir(s)">
                        <i class="pi pi-angle-right" aria-hidden="true"></i>
                      </button>
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </div>
            <p class="pie">Servidor: lo que ve la consulta de tienda en vivo (cada 25 s). Réplica: segundos desde el último
              mensaje del servidor a md. Horario: el habitual de este día de la semana, sacado de su propia venta.
              Disco retenido: lo que el servidor guarda para md; si md deja de leer, crece hasta llenar el disco y tirar la caja.</p>
          </section>

          <section class="bloque" aria-labelledby="t-atender">
            <div class="bloque-head">
              <h2 id="t-atender">Atender</h2>
              <span class="meta">lo más grave primero</span>
            </div>
            <app-torre-bandeja [senales]="d.atender" (visto)="marcarVista($event)" />
          </section>

          <section class="bloque" aria-labelledby="t-otros">
            <h2 id="t-otros">Otros carriles de Kepler</h2>
            <div class="tarjetas">
              @for (c of d.otros; track c.clave) {
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

    <app-side-peek [(open)]="peekAbierto" [title]="seleccion()?.nombre ?? ''" [subtitle]="peekSub()">
      @if (seleccion(); as s) {
        <div class="peek">
          @if (s.falla) { <p class="falla"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ s.falla }}</p> }
          <dl class="datos">
            <div><dt>Horario de hoy</dt><dd class="mono">{{ s.abre && s.cierra ? s.abre + ' – ' + s.cierra : 'sin venta al público' }}</dd></div>
            <div><dt>Réplica a md</dt><dd>{{ s.replica_s != null ? s.replica_s + ' s' : 'no medido' }}</dd></div>
            <div><dt>Errores de réplica</dt><dd>{{ s.errores_replica != null ? s.errores_replica : 'no medido' }}</dd></div>
            <div><dt>Disco retenido</dt><dd>{{ s.disco_retenido_bytes != null ? tam(s.disco_retenido_bytes) : 'no medido' }}</dd></div>
            <div><dt>Tablas publicadas</dt><dd>{{ s.tablas_publicadas != null ? s.tablas_publicadas : 'no medido' }}</dd></div>
            <div><dt>Último arranque</dt><dd>{{ s.arranque ? (s.arranque | date: 'dd/MM HH:mm') : 'no medido' }}</dd></div>
          </dl>
          @if (s.sin_tope_wal) {
            <p class="riesgo"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Sin tope de WAL: si md deja de leer, el disco de esta sucursal se puede llenar.</p>
          }

          <h3>{{ caidasDe().length }} caídas de 10 min o más en 30 días</h3>
          @if (caidasDe().length) {
            <p class="explica">{{ explicacion() }}</p>
            <ol class="caidas">
              @for (c of caidasDe(); track c.desde) {
                <li>
                  <span class="mono">{{ c.desde | date: 'dd/MM HH:mm' }} – {{ c.hasta | date: 'dd/MM HH:mm' }}</span>
                  <span class="mono" [class.larga]="c.minutos >= 120">{{ dur(c.minutos) }}</span>
                  <span class="tipo">{{ c.tipo === 'inalcanzable' ? 'no responde' : c.tipo === 'lento' ? 'lento' : 'otra' }}</span>
                </li>
              }
            </ol>
          } @else if (datos()?.caidas === null) {
            <p class="explica">El historial de caídas no se pudo leer.</p>
          }
        </div>
      }
    </app-side-peek>
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
    .btn:focus-visible, .btn-icono:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .accion { margin: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border); border-radius: var(--r-sm); background: var(--warn-soft-bg); color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .aviso { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--bad-border);
             border-radius: var(--r-md); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .aviso p { margin: 0; font-size: var(--fs-body); }
    .frase { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-4); }
    .primaria { margin: 0; font-size: var(--fs-display); font-weight: var(--fw-bold); letter-spacing: -0.02em; color: var(--text-main); line-height: 1.15; }
    .secundaria { margin: 0; font-size: var(--fs-body); color: var(--text-muted); }
    .bloque { display: flex; flex-direction: column; gap: var(--sp-2); }
    .bloque-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
    h2 { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--text-main); }
    .meta { font-size: var(--fs-xs); color: var(--text-faint); }
    .tabla { border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-card); overflow: hidden; }
    .nombre { font-weight: var(--fw-bold); }
    .mono { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-soft); }
    .fuerte { font-weight: var(--fw-bold); color: var(--text-main); }
    .linea2 { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .nm { font-size: var(--fs-sm); color: var(--text-muted); }
    .num { text-align: right; }
    .acc { text-align: right; }
    .sel td { background: var(--surface-hover); }
    .btn-icono { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border-color);
                 border-radius: var(--r-sm); background: var(--surface-card); color: var(--text-soft); cursor: pointer; }
    .pie { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--sp-3); }
    .tarjeta { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-card); }
    .tarjeta-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .tarjeta-nombre { font-weight: var(--fw-bold); font-size: var(--fs-sm); color: var(--text-main); }
    .tarjeta-linea { font-size: var(--fs-xs); color: var(--text-muted); }
    .peek { display: flex; flex-direction: column; gap: var(--sp-3); }
    .falla { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-size: var(--fs-sm); }
    .riesgo { margin: 0; color: var(--warn-soft-fg); font-size: var(--fs-sm); }
    .datos { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2) var(--sp-4); }
    .datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .datos dd { margin: 0; font-size: var(--fs-sm); color: var(--text-main); }
    h3 { margin: var(--sp-2) 0 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); }
    .explica { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .caidas { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border-color); }
    .caidas li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .larga { color: var(--bad-soft-fg); font-weight: var(--fw-bold); }
    .tipo { font-size: var(--fs-xs); color: var(--text-muted); }
    @container (max-width: 40rem) { .primaria { font-size: var(--fs-h2); } .page { padding: var(--sp-4); } }
    @media (pointer: coarse) { .btn-icono { width: 44px; height: 44px; } .btn { height: 44px; } }
  `],
})
export class TorreSistemasComponent implements OnInit {
  private readonly svc = inject(TorresService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly datos = signal<TorreSistemas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly seleccion = signal<ServidorKepler | null>(null);
  readonly peekAbierto = signal(false);
  readonly accion = signal<string | null>(null);

  private readonly servidores = computed(() => this.datos()?.servidores ?? []);
  private readonly conFalla = computed(() => this.servidores().filter((s) => s.estado === 'falla'));
  private readonly sinMedir = computed(() => this.servidores().filter((s) => s.estado === 'no_medido'));

  /** La pregunta de la pantalla, contestada en una frase. */
  readonly frase = computed(() => {
    const total = this.servidores().length;
    const f = this.conFalla();
    if (!total) return 'No se pudo leer ningún servidor';
    if (f.length === 1) return `${f[0].nombre}: ${f[0].texto_estado}`;
    if (f.length > 1) return `${f.length} servidores con falla`;
    const nm = this.sinMedir().length;
    if (nm === total) return 'No se sabe si los servidores responden';
    return nm ? `${total - nm} de ${total} servidores responden; ${nm} sin medir` : `Los ${total} servidores responden`;
  });

  readonly subfrase = computed(() => {
    const d = this.datos();
    if (!d) return '';
    const r = resumenDeSenales(d.atender);
    const partes: string[] = [];
    if (r.fallas) partes.push(`${r.fallas} en falla`);
    if (r.riesgos) partes.push(`${r.riesgos} en riesgo`);
    if (r.no_medidos) partes.push(`${r.no_medidos} sin medir`);
    return partes.length ? `Para atender: ${partes.join(' · ')}` : 'Nada que atender';
  });

  readonly metricas = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const total = this.servidores().length;
    const responden = this.servidores().filter((s) => s.estado === 'ok').length;
    const caidas = d.caidas;
    return [
      { label: 'Servidores que responden', value: `${responden} de ${total}`, format: 'text', tone: this.conFalla().length ? 'bad' : 'default' },
      caidas == null
        ? { label: 'Caídas de 10 min o más · 30 días', value: '—', format: 'text', state: 'no_medido', stateNote: 'el historial de caídas no se pudo leer' }
        : { label: 'Caídas de 10 min o más · 30 días', value: caidas.length, format: 'number' },
      d.mesa == null
        ? { label: 'Tickets abiertos en Mesa de Servicio', value: '—', format: 'text', state: 'no_medido', stateNote: 'Mesa de Servicio no se pudo leer' }
        : { label: 'Tickets abiertos en Mesa de Servicio', value: d.mesa.abiertos, format: 'number', tone: d.mesa.abiertos ? 'warn' : 'default' },
      d.avisos == null
        ? { label: 'Alertas avisadas fuera de la pantalla', value: '—', format: 'text', state: 'no_medido', stateNote: 'no se pudo leer' }
        : { label: 'Alertas avisadas fuera de la pantalla · 30 días', value: `${d.avisos.notificadas_30d} de ${d.avisos.abiertas_30d}`, format: 'text', tone: d.avisos.notificadas_30d === 0 && d.avisos.abiertas_30d > 0 ? 'bad' : 'default' },
    ];
  });

  readonly caidasDe = computed<CaidaKepler[]>(() => {
    const s = this.seleccion();
    return s ? (this.datos()?.caidas ?? []).filter((c) => c.codigo === s.codigo) : [];
  });

  readonly peekSub = computed(() => {
    const s = this.seleccion();
    if (!s) return null;
    return `Servidor Kepler · ${s.texto_estado}${s.replica_s != null ? ` · réplica ${s.replica_s} s` : ''}`;
  });

  readonly explicacion = computed(() => {
    const c = this.caidasDe();
    const lentas = c.filter((x) => x.tipo === 'lento').length;
    const sin = c.filter((x) => x.tipo === 'inalcanzable').length;
    const partes: string[] = [];
    if (lentas) partes.push(`${lentas} lento: el servidor contesta pero no termina la consulta en 30 s (saturado o enlace lento)`);
    if (sin) partes.push(`${sin} no responde: no se pudo conectar (red de la sucursal o servidor apagado)`);
    return partes.join('. ') + '.';
  });

  ngOnInit(): void {
    this.cargar();
    encuestarVisible(60_000, () => this.cargar(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.svc.sistemas().subscribe({
      next: (d) => {
        this.datos.set(d);
        this.error.set(null);
        this.cargando.set(false);
        const s = this.seleccion();
        if (s) this.seleccion.set(d.servidores.find((x) => x.codigo === s.codigo) ?? null);
      },
      // Una falla se dice; si ya había dato, se queda a la vista con su edad (la píldora la marca vieja).
      error: (e) => { this.cargando.set(false); if (!this.datos()) this.error.set(e?.error?.message || e?.message || 'Error de red'); },
    });
  }

  abrir(s: ServidorKepler): void {
    this.seleccion.set(s);
    this.peekAbierto.set(true);
  }

  marcarVista(id: string): void {
    this.accion.set(null);
    this.svc.marcarVista(id).subscribe({
      next: (r) => { if (!r?.ok) this.accion.set('No se marcó como vista: la alerta ya no existe.'); this.cargar(true); },
      error: (e) => this.accion.set(`No se pudo marcar como vista: ${e?.error?.message || e?.message || 'error de red'}`),
    });
  }

  tam(bytes: number): string {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  dur(min: number | null): string {
    if (min == null) return '—';
    if (min < 1) return 'menos de 1 min';
    if (min < 60) return `${Math.round(min)} min`;
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
}
