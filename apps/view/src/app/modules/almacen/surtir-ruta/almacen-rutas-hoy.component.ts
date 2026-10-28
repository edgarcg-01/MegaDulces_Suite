import {
  ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, output, signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';
import type { RouteBatchRow, RouteBatchState } from '@megadulces/contracts';
import { irConservandoPanel } from '../../../core/panel/ir-conservando-panel';
import { AuthService } from '../../../core/services/auth.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PresalePickingService } from '../presale-picking.service';
import { horaMx, nombreRuta, textoOtrasSucursales } from './ruta-surtido.util';

/** Cada cuánto se vuelve a pedir: igual que la lista de sueltos de Surtir. */
const RUTAS_CADA_MS = 30_000;

/** Lo que hay que hacer primero arriba: lista → surtiendo → en ruta → surtida. */
const ORDEN: Record<RouteBatchState, number> = { lista: 0, surtiendo: 1, en_ruta: 2, surtida: 3 };

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * `[MCP.3.6]` **Las rutas de hoy, arriba de los pedidos sueltos de Surtir › Sucursal.**
 *
 * Una tarjeta por ruta, según en qué va:
 *  · `lista`     el vendedor finalizó: «Empezar a recolectar» (arranca y entra a Recolectar).
 *  · `surtiendo` «Seguir recolectando» si es de esta persona; si la tiene otra, se dice quién y
 *                no se ofrece entrar (una ruta la cierra quien la recolectó).
 *  · `en_ruta`   sin botón: todavía no hay lista que recolectar.
 *  · `surtida`   discreta, con quién y a qué hora.
 *
 * ⚠️ Error ≠ vacío: si no se pudieron leer, se dice con Reintentar y los sueltos de abajo siguen
 * funcionando (esta pieza no los toca). Sin rutas hoy no se pinta nada: no hay texto de relleno.
 */
@Component({
  selector: 'app-almacen-rutas-hoy',
  standalone: true,
  imports: [LoadStateComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (cargando() || error() || rutas().length) {
      <section class="rh" aria-labelledby="rh-titulo">
        <div class="rh-head">
          <h3 class="rh-h3" id="rh-titulo">Rutas de hoy</h3>
          <app-freshness-pill measures="fetch" [since]="cargadoAl()"></app-freshness-pill>
        </div>
        <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" [skeletonRows]="2"
                        errorTitle="No se pudieron cargar las rutas" (retry)="cargar()">
          @if (refrescoFallo()) {
            <p class="rh-tip rh-tip-warn" role="status">No se pudo actualizar: estas rutas pueden estar atrasadas.</p>
          }
          @if (errorAlEmpezar()) {
            <p class="rh-tip rh-tip-bad" role="alert">{{ errorAlEmpezar() }}</p>
          }
          @for (r of rutas(); track r.route_day_id) {
            @switch (r.state) {
              @case ('lista') {
                <article class="rh-card rh-card-lista" [attr.data-estado]="r.state">
                  <strong class="rh-nom">{{ nombreRuta(r) }}</strong>
                  @if (r.kind === 'fuera_de_ruta') { <span class="rh-sub">Levantado después de cerrar su ruta</span> }
                  @else if (r.finished_at) { <span class="rh-sub">Terminó a las {{ hora(r.finished_at) }}</span> }
                  <span class="rh-datos">{{ plural(r.orders, 'pedido', 'pedidos') }} · {{ plural(r.products, 'producto', 'productos') }}</span>
                  <!-- [MCP.3.13] Pedidos agrupados: otra sucursal surte su parte de esta ruta. -->
                  @if (otras(r); as o) { <span class="rh-parte">{{ o }}</span> }
                  <button type="button" class="rh-btn" [disabled]="abriendo() !== null" (click)="empezar(r)">
                    <i class="pi" [class.pi-play]="abriendo() !== r.route_day_id"
                       [class.pi-spin]="abriendo() === r.route_day_id" [class.pi-spinner]="abriendo() === r.route_day_id" aria-hidden="true"></i>
                    <span>Empezar a recolectar</span>
                  </button>
                </article>
              }
              @case ('surtiendo') {
                <article class="rh-card" [attr.data-estado]="r.state">
                  <strong class="rh-nom">{{ nombreRuta(r) }}</strong>
                  <span class="rh-datos">{{ plural(r.orders, 'pedido', 'pedidos') }} · {{ plural(r.products, 'producto', 'productos') }}</span>
                  <!-- [MCP.3.13] Pedidos agrupados: otra sucursal surte su parte de esta ruta. -->
                  @if (otras(r); as o) { <span class="rh-parte">{{ o }}</span> }
                  @if (esMia(r)) {
                    <button type="button" class="rh-btn" [disabled]="abriendo() !== null" (click)="seguir(r)">
                      <i class="pi pi-play" aria-hidden="true"></i><span>Seguir recolectando</span>
                    </button>
                  } @else {
                    <span class="rh-sub">{{ textoRecolectando(r) }}</span>
                  }
                </article>
              }
              @case ('en_ruta') {
                <article class="rh-card rh-card-min" [attr.data-estado]="r.state">
                  <strong class="rh-nom-min">{{ nombreRuta(r) }}</strong>
                  <span class="rh-sub">En ruta desde las {{ hora(r.started_at) }} · Te llega la lista cuando finalice</span>
                </article>
              }
              @case ('surtida') {
                <article class="rh-card rh-card-min rh-card-hecha" [attr.data-estado]="r.state">
                  <span class="rh-sub"><i class="pi pi-check" aria-hidden="true"></i> {{ textoSurtida(r) }}</span>
                </article>
              }
            }
          }
        </app-load-state>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .rh { margin: var(--sp-3) 0 var(--sp-4); }
    .rh-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
    .rh-h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-h3); }
    .rh-tip { margin: 0 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .rh-tip-warn { color: var(--warn-fg); }
    .rh-tip-bad { color: var(--bad-fg); font-size: var(--fs-body); font-weight: 600; }
    .rh-card { display: flex; flex-direction: column; gap: var(--sp-1); margin-bottom: var(--sp-2);
      padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-lg); }
    /* La que hay que recolectar: borde de acción (el único color de marca, porque es lo que se hace ahora). */
    .rh-card-lista { border: 2px solid var(--action); }
    .rh-card-min { padding: var(--sp-2) var(--sp-3); gap: 0; }
    .rh-card-hecha { border-left: 4px solid var(--ok-fg); }
    .rh-nom { font-size: var(--fs-lg); line-height: 1.2; }
    .rh-nom-min { font-size: var(--fs-body); }
    .rh-sub { font-size: var(--fs-body); color: var(--text-muted); }
    .rh-card-hecha .rh-sub i { color: var(--ok-fg); }
    .rh-datos { font-size: var(--fs-body); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .rh-parte { font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); }
    .rh-btn { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); margin-top: var(--sp-2);
      min-height: max(3.25rem, var(--tap-min)); border: 0; border-radius: var(--r-lg); cursor: pointer;
      background: var(--action); color: var(--action-ink); font-size: var(--fs-h2); font-weight: 800; }
    .rh-btn:not(:disabled):hover { background: var(--action-hover); }
    .rh-btn:disabled { background: var(--border-color); color: var(--text-muted); cursor: not-allowed; }
    .rh-btn:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
  `],
})
export class AlmacenRutasHoyComponent implements OnInit {
  private readonly api = inject(PresalePickingService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly alertas = inject(AlertsSocketService);

  /** Cuántas rutas hay hoy: Surtir lo usa para rotular «Pedidos sueltos» sólo cuando hay rutas. */
  readonly hayRutas = output<number>();

  readonly plural = plural;
  readonly nombreRuta = nombreRuta;
  /** [MCP.3.13] «Pedidos agrupados · también surte PH…»; null si la ruta no tiene partes en otra sucursal. */
  readonly otras = textoOtrasSucursales;

  private readonly filas = signal<RouteBatchRow[]>([]);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly refrescoFallo = signal(false);
  readonly cargadoAl = signal<number | null>(null);
  /** La ruta que se está abriendo: apaga todos los botones (un toque, un arranque). */
  readonly abriendo = signal<string | null>(null);
  /** Lo que respondió el servidor al no poder empezar (p. ej. otra persona ya la tomó). */
  readonly errorAlEmpezar = signal<string | null>(null);

  readonly rutas = computed(() =>
    [...this.filas()].sort((a, b) => ORDEN[a.state] - ORDEN[b.state]),
  );

  ngOnInit(): void {
    this.cargar();
    const reloj = setInterval(() => {
      if (!this.cargando() && this.abriendo() === null) this.cargar(true);
    }, RUTAS_CADA_MS);
    this.destroyRef.onDestroy(() => clearInterval(reloj));

    // [MCP.3.6] Al finalizar la ruta el servidor avisa en vivo (`order_to_pick`): la tarjeta pasa a
    // «lista» al instante, sin esperar la siguiente vuelta del reloj.
    this.alertas.connect();
    this.alertas.alert$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((a) => {
      if ((a.type as string) === 'order_to_pick' && !this.cargando() && this.abriendo() === null) this.cargar(true);
    });
  }

  cargar(silencioso = false): void {
    if (!silencioso) {
      this.cargando.set(true);
      this.error.set(null);
    }
    this.api.routes().subscribe({
      next: (r) => {
        this.filas.set(r.data ?? []);
        this.cargando.set(false);
        this.error.set(null);
        this.refrescoFallo.set(false);
        this.cargadoAl.set(Date.now());
        this.hayRutas.emit(this.filas().length);
      },
      error: (e) => {
        this.cargando.set(false);
        // Con rutas ya pintadas, un refresco fallido no las borra: se avisa que pueden estar atrasadas.
        if (this.filas().length) this.refrescoFallo.set(true);
        else this.error.set(this.mensaje(e, 'Revisa la señal y vuelve a intentar. Los pedidos sueltos de abajo siguen disponibles.'));
      },
    });
  }

  esMia(r: RouteBatchRow): boolean {
    const yo = this.auth.user()?.sub;
    return !!yo && r.pick_started?.user_id === yo;
  }

  /** «La está recolectando Ángel desde las 14:05.» */
  textoRecolectando(r: RouteBatchRow): string {
    const p = r.pick_started;
    const h = horaMx(p?.at);
    return 'La está recolectando ' + (p?.name || 'otra persona') + (h ? ' desde las ' + h : '') + '.';
  }

  /** «Ruta de Paulina · Surtida por Ángel a las 15:40» */
  textoSurtida(r: RouteBatchRow): string {
    const p = r.pick_finished;
    const h = horaMx(p?.at);
    return nombreRuta(r) + ' · Surtida por ' + (p?.name || 'alguien sin nombre') + (h ? ' a las ' + h : '');
  }

  hora(iso: string | null | undefined): string {
    return horaMx(iso);
  }

  /** Arranca la ruta (queda a nombre de esta persona) y entra a Recolectar. */
  empezar(r: RouteBatchRow): void {
    if (this.abriendo() !== null) return;
    this.abriendo.set(r.route_day_id);
    this.errorAlEmpezar.set(null);
    this.api.routeStart(r.route_day_id).subscribe({
      next: () => {
        this.abriendo.set(null);
        this.entrar(r.route_day_id);
      },
      error: (e) => {
        this.abriendo.set(null);
        // Quizá alguien más la tomó un segundo antes: la lista nueva lo dice con su nombre.
        this.error.set(null);
        this.refrescoFallo.set(false);
        this.cargar(true);
        this.errorAlEmpezar.set(this.mensaje(e, 'No se pudo empezar la ruta.'));
      },
    });
  }

  seguir(r: RouteBatchRow): void {
    this.entrar(r.route_day_id);
  }

  private entrar(id: string): void {
    irConservandoPanel(this.router, `/almacen/surtir/ruta/${encodeURIComponent(id)}`);
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }
}
