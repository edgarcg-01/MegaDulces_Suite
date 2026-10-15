import {
  ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type {
  PresalePickBucket,
  PresalePickDetail,
  PresalePickInboxResponse,
  PresalePickInboxRow,
  PresalePickLine,
  PresalePickState,
} from '@megadulces/contracts';
import { PresalePickingService } from '../presale-picking.service';
import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';
import { encuestarVisible } from '../../../core/utils/poll-visible';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';

/** Cada cuánto se vuelve a pedir la bandeja mientras se está viendo. El aviso en vivo la adelanta. */
const REFRESCO_MS = 20_000;

const ESTADO: Record<PresalePickState, { label: string; severity: 'info' | 'warn' | 'success' | 'secondary' | 'danger' }> = {
  nuevo: { label: 'Nuevo', severity: 'info' },
  surtiendo: { label: 'Surtiendo', severity: 'warn' },
  completo: { label: 'Surtido', severity: 'success' },
  con_faltantes: { label: 'Con faltantes', severity: 'warn' },
  en_recorrido: { label: 'En un recorrido', severity: 'secondary' },
};

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.3]` **Pedidos de preventa por surtir** de la sucursal del surtidor, separados por día.
 *
 * Decisiones (David, 2026-10-14):
 *  · llegan solos: la bandeja se vuelve a pedir cada 20 s mientras se ve, y el aviso en vivo
 *    (`order_to_pick`) la adelanta; tocar el aviso de la campana abre el pedido (`?pedido=`);
 *  · al tocar «Empezar a surtir» queda registrado quién y a qué hora;
 *  · lo que no hubo se QUITA del pedido y el total se recalcula; la vendedora recibe el reporte.
 *
 * Dentro del día se ordena por llegada (D5 de la Fase MCP): la fecha de entrega sólo separa la
 * pestaña. Lo vencido cae en «Hoy» con sus días de atraso.
 */
@Component({
  selector: 'app-almacen-surtir-preventa',
  standalone: true,
  imports: [CommonModule, ButtonModule, TagModule, ToastModule, LoadStateComponent, FreshnessPillComponent, SegmentedComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in sp-page">
      <p-toast position="top-center"></p-toast>
      <p class="sp-oculto" role="status" aria-live="polite">{{ anuncio() }}</p>

      @if (!enLinea()) {
        <div class="sp-banda sp-banda-bad" role="alert">
          <i class="pi pi-wifi" aria-hidden="true"></i>
          <span>Sin conexión. Los pedidos nuevos no van a llegar hasta que vuelva la señal.</span>
        </div>
      }

      @if (!abierto()) {
        <header class="sp-top">
          <div class="sp-top-mid">
            <h1 class="sp-h1">Pedidos de preventa</h1>
            <span class="sp-sub">{{ sucursales() }}</span>
          </div>
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="60"></app-freshness-pill>
        </header>

        @if (bandeja()?.scope === 'ninguno') {
          <div class="sp-banda sp-banda-warn" role="status">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            <span>Tu usuario no tiene una sucursal asignada. Pide que te la asignen en Administración › Personas.</span>
          </div>
        }

        <app-segmented [options]="pestanas()" [value]="pestana()" ariaLabel="Día de entrega"
                       (valueChange)="pestana.set($any($event))"></app-segmented>

        <app-load-state [loading]="cargando() && !bandeja()" [error]="error()" [isEmpty]="!!bandeja() && !visibles().length"
                        emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                        (retry)="cargar()">
          <div class="sp-lista">
            @for (p of visibles(); track p.order_id) {
              <button type="button" class="sp-card" [class.sp-card-nuevo]="p.state === 'nuevo' && p.unseen" (click)="abrir(p.order_id)">
                <span class="sp-card-r1">
                  <strong class="sp-cliente">{{ p.customer_name || p.code }}</strong>
                  <p-tag [value]="estado(p.state).label" [severity]="estado(p.state).severity"></p-tag>
                </span>
                <span class="sp-card-r2">
                  <span class="sp-folio">{{ p.code }}</span>
                  <span>llegó {{ horaDe(p.arrived_at) }}</span>
                  @if (p.days_late > 0) { <span class="sp-tarde">{{ p.days_late === 1 ? 'vencido 1 día' : 'vencido ' + p.days_late + ' días' }}</span> }
                  @if (pestana() === 'proximos') { <span>entrega {{ fechaCorta(p.requested_delivery_date) }}</span> }
                </span>
                <span class="sp-card-r2">
                  <span>{{ p.seller_name || 'Sin vendedor' }}</span>
                  <span>{{ p.lines === 1 ? '1 producto' : p.lines + ' productos' }}</span>
                  <span class="sp-num">{{ dinero(p.total) }}</span>
                </span>
                @if (p.started) {
                  <span class="sp-card-r2 sp-quien">
                    <i class="pi pi-user" aria-hidden="true"></i>
                    {{ p.started.name }} · {{ horaDe(p.started.at) }}{{ p.finished ? '–' + horaDe(p.finished.at) : ' · en curso' }}
                  </span>
                }
              </button>
            }
          </div>
        </app-load-state>
      } @else {
        <!-- ─────────── UN PEDIDO ─────────── -->
        <header class="sp-top">
          <button pButton type="button" [text]="true" severity="secondary" class="sp-tap" (click)="cerrarDetalle()" aria-label="Volver a la bandeja">
            <span class="p-button-icon pi pi-arrow-left" aria-hidden="true"></span>
          </button>
          <div class="sp-top-mid">
            <h1 class="sp-h1">{{ detalle()?.order?.customer_name || detalle()?.order?.code || 'Pedido' }}</h1>
            @if (detalle(); as d) {
              <span class="sp-sub">{{ d.order.code }} · entrega {{ fechaCorta(d.order.requested_delivery_date) }} · {{ d.order.seller_name || 'Sin vendedor' }}</span>
              @if (d.order.started) {
                <span class="sp-sub">Surte: {{ d.order.started.name }} · desde {{ horaDe(d.order.started.at) }}</span>
              }
            }
          </div>
        </header>

        <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()" [isEmpty]="false" (retry)="abrir(abierto()!)">
          @if (detalle(); as d) {
            @if (d.order.state === 'nuevo' || d.order.state === 'en_recorrido') {
              <ul class="sp-renglones">
                @for (l of d.lines; track l.line_id) {
                  <li class="sp-ren">
                    <span class="sp-ren-n">{{ l.product_name }}</span>
                    <span class="sp-ren-q"><strong>{{ l.qty }}</strong> {{ l.unit }}</span>
                  </li>
                }
              </ul>
              <div class="sp-pie">
                @if (d.order.state === 'en_recorrido') {
                  <p class="sp-tip">Este pedido ya va en un recorrido de la consola de surtido.</p>
                } @else {
                  <p class="sp-tip">Al empezar queda registrado quién surte y a qué hora empezó.</p>
                  <button type="button" class="sp-btn sp-btn-go" [disabled]="trabajando()" (click)="empezar(d.order.order_id)">
                    <i class="pi" [class.pi-play]="!trabajando()" [class.pi-spin]="trabajando()" [class.pi-spinner]="trabajando()" aria-hidden="true"></i>
                    <span>Empezar a surtir</span>
                  </button>
                }
              </div>
            } @else if (d.order.state === 'surtiendo') {
              <p class="sp-tip">Marca cada producto conforme lo levantas. Si no hubo todo, baja la cantidad a lo que sí hubo.</p>
              <ul class="sp-renglones">
                @for (l of d.lines; track l.line_id) {
                  <li class="sp-ren sp-ren-edit" [class.sp-ren-ok]="marca(l) === l.qty" [class.sp-ren-falta]="marca(l) !== null && marca(l)! < l.qty">
                    <span class="sp-ren-n">{{ l.product_name }}</span>
                    <span class="sp-ren-pedido">Pedido: <strong>{{ l.qty }} {{ l.unit }}</strong></span>
                    <div class="sp-ctrl">
                      <button type="button" class="sp-ok" [class.sp-ok-on]="marca(l) === l.qty" (click)="completo(l)">
                        <i class="pi pi-check" aria-hidden="true"></i> Completo
                      </button>
                      <div class="sp-step" role="group" [attr.aria-label]="'Cuánto hubo de ' + l.product_name">
                        <button type="button" (click)="mover(l, -1)" [attr.aria-label]="'Menos ' + l.product_name"><i class="pi pi-minus" aria-hidden="true"></i></button>
                        <span class="sp-step-n">{{ marca(l) ?? '–' }}</span>
                        <button type="button" (click)="mover(l, 1)" [attr.aria-label]="'Más ' + l.product_name"><i class="pi pi-plus" aria-hidden="true"></i></button>
                      </div>
                      <span class="sp-ctrl-l">{{ leyenda(l) }}</span>
                    </div>
                  </li>
                }
              </ul>
              <div class="sp-pie">
                <p class="sp-tip">{{ marcados() }} de {{ d.lines.length }} marcados{{ conFaltante() ? ' · ' + conFaltante() + ' con faltante' : '' }}</p>
                @if (marcados() < d.lines.length) {
                  <button type="button" class="sp-btn sp-btn-go" disabled><span>Marca todos los productos para terminar</span></button>
                } @else if (conFaltante()) {
                  <button type="button" class="sp-btn sp-btn-warn" [disabled]="trabajando()" (click)="terminar(d)">
                    <i class="pi pi-send" aria-hidden="true"></i>
                    <span>Enviar reporte a {{ d.order.seller_name || 'la vendedora' }} · faltaron {{ conFaltante() }}</span>
                  </button>
                } @else {
                  <button type="button" class="sp-btn sp-btn-ok" [disabled]="trabajando()" (click)="terminar(d)">
                    <i class="pi pi-check-circle" aria-hidden="true"></i><span>Confirmar: hubo todo</span>
                  </button>
                }
              </div>
            } @else {
              <ul class="sp-renglones">
                @for (l of d.lines; track l.line_id) {
                  <li class="sp-ren"><span class="sp-ren-n">{{ l.product_name }}</span><span class="sp-ren-q"><strong>{{ l.qty }}</strong> {{ l.unit }}</span></li>
                }
              </ul>
              <p class="sp-tip">Surtido{{ d.order.finished ? ' por ' + d.order.finished.name + ' a las ' + horaDe(d.order.finished.at) : '' }}.
                {{ d.order.state === 'con_faltantes' ? 'Lo que no hubo ya se quitó del pedido.' : 'Hubo todo.' }}</p>
            }
          }
        </app-load-state>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sp-page { max-width: 46rem; }
    .sp-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .sp-tap { min-height: var(--tap-min); }
    .sp-top { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
    .sp-top-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .sp-h1 { margin: 0; font-size: var(--fs-h2); font-weight: 800; line-height: 1.2; }
    .sp-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .sp-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-3);
      border-radius: var(--r-md); border: 1px solid currentColor; font-size: var(--fs-body); }
    .sp-banda-bad { color: var(--bad-fg); }
    .sp-banda-warn { color: var(--warn-fg); }
    .sp-lista { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); }
    .sp-card { display: flex; flex-direction: column; gap: var(--sp-1); width: 100%; text-align: left; cursor: pointer;
      padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); color: var(--text-main); }
    .sp-card:hover { background: var(--surface-hover); }
    .sp-card:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sp-card-nuevo { border-left: 4px solid var(--info-fg); }
    .sp-card-r1 { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .sp-cliente { font-size: var(--fs-lg); line-height: 1.2; }
    .sp-card-r2 { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .sp-folio { font-family: var(--font-mono); }
    .sp-tarde { color: var(--bad-fg); font-weight: 700; }
    .sp-num { font-variant-numeric: tabular-nums; color: var(--text-main); font-weight: 700; }
    .sp-quien { color: var(--text-main); align-items: center; }
    .sp-renglones { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .sp-ren { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); }
    .sp-ren-edit { flex-direction: column; align-items: stretch; }
    .sp-ren-ok { border-left: 4px solid var(--ok-fg); }
    .sp-ren-falta { border-left: 4px solid var(--warn-fg); background: var(--warn-soft-bg); }
    .sp-ren-n { font-size: var(--fs-body); font-weight: 700; line-height: 1.25; }
    .sp-ren-q { white-space: nowrap; font-size: var(--fs-body); }
    .sp-ren-q strong { font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .sp-ren-pedido { font-size: var(--fs-sm); color: var(--text-muted); }
    .sp-ctrl { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .sp-ok { min-height: var(--tap-min); display: inline-flex; align-items: center; gap: var(--sp-1); padding: 0 var(--sp-3);
      border-radius: var(--r-md); border: 1px solid var(--ok-border); background: var(--ok-soft-bg); color: var(--ok-fg); font-weight: 800; cursor: pointer; }
    .sp-ok-on { background: var(--ok-fg); color: var(--card-bg); }
    .sp-ok:focus-visible, .sp-step button:focus-visible, .sp-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .sp-step { display: inline-flex; align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .sp-step button { min-width: var(--tap-min); min-height: var(--tap-min); border: 0; background: transparent; color: var(--text-main); cursor: pointer; }
    .sp-step-n { min-width: 2.5rem; text-align: center; font-weight: 800; font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .sp-ctrl-l { margin-left: auto; font-size: var(--fs-sm); color: var(--text-muted); }
    .sp-pie { position: sticky; bottom: 0; z-index: 5; display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-4);
      padding: var(--sp-2) 0 calc(var(--sp-2) + env(safe-area-inset-bottom)); background: var(--surface-ground); border-top: 1px solid var(--border-color); }
    .sp-tip { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
    .sp-btn { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); min-height: 3.25rem; width: 100%;
      border-radius: var(--r-lg); border: 0; font-size: var(--fs-lg); font-weight: 800; cursor: pointer; }
    .sp-btn:disabled { cursor: not-allowed; background: var(--surface-border); color: var(--text-muted); }
    .sp-btn-go:not(:disabled) { background: var(--action); color: var(--action-ink); }
    .sp-btn-go:not(:disabled):hover { background: var(--action-hover); }
    .sp-btn-ok:not(:disabled) { background: var(--ok-fg); color: var(--card-bg); }
    .sp-btn-warn:not(:disabled) { background: var(--warn-fg); color: var(--card-bg); }
  `],
})
export class AlmacenSurtirPreventaComponent implements OnInit {
  private readonly api = inject(PresalePickingService);
  private readonly alertas = inject(AlertsSocketService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly bandeja = signal<PresalePickInboxResponse | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly pestana = signal<PresalePickBucket>('hoy');
  readonly enLinea = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly anuncio = signal('');

  readonly abierto = signal<string | null>(null);
  readonly detalle = signal<PresalePickDetail | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly trabajando = signal(false);
  /** Lo que marcó el surtidor por renglón, en la unidad mostrada. */
  readonly marcas = signal<Record<string, number>>({});

  readonly pestanas = computed<SegOption[]>(() => {
    const c = this.bandeja()?.counts ?? { hoy: 0, manana: 0, proximos: 0 };
    return [
      { value: 'hoy', label: `Hoy · ${c.hoy}` },
      { value: 'manana', label: `Mañana · ${c.manana}` },
      { value: 'proximos', label: `Próximos · ${c.proximos}` },
    ];
  });
  readonly visibles = computed<PresalePickInboxRow[]>(() => {
    const p = this.pestana();
    return (this.bandeja()?.data ?? []).filter((r) => r.bucket === p);
  });
  readonly sucursales = computed(() => {
    const n = [...new Set((this.bandeja()?.data ?? []).map((r) => r.warehouse_name).filter(Boolean))];
    return n.length ? n.join(' · ') : 'Tu sucursal';
  });
  readonly vacioTitulo = computed(() => ({ hoy: 'Nada por surtir hoy', manana: 'Nada para mañana todavía', proximos: 'Nada agendado más adelante' })[this.pestana()]);
  readonly vacioPista = computed(() => 'Cuando un vendedor agende un pedido para tu sucursal, va a aparecer aquí solo.');
  readonly marcados = computed(() => {
    const m = this.marcas();
    return (this.detalle()?.lines ?? []).filter((l) => m[l.line_id] !== undefined).length;
  });
  readonly conFaltante = computed(() => {
    const m = this.marcas();
    return (this.detalle()?.lines ?? []).filter((l) => m[l.line_id] !== undefined && m[l.line_id] < l.qty).length;
  });

  ngOnInit(): void {
    const onOn = () => this.enLinea.set(true);
    const onOff = () => this.enLinea.set(false);
    window.addEventListener('online', onOn);
    window.addEventListener('offline', onOff);
    this.destroyRef.onDestroy(() => { window.removeEventListener('online', onOn); window.removeEventListener('offline', onOff); });

    this.cargar();
    encuestarVisible(REFRESCO_MS, () => { if (!this.abierto()) this.cargar(true); }, { destroyRef: this.destroyRef, zone: this.zone });

    // El aviso en vivo adelanta la bandeja: no hay que esperar los 20 s.
    this.alertas.connect();
    this.alertas.alert$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((a) => {
      if ((a.type as string) === 'order_to_pick' && !this.abierto()) this.cargar(true);
    });

    // `?pedido=<id>` abre el pedido: es a donde lleva el aviso de la campana.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const id = q.get('pedido');
      if (id && id !== this.abierto()) this.abrir(id, false);
      if (!id && this.abierto()) this.limpiarDetalle();
    });
  }

  cargar(silencioso = false): void {
    if (!silencioso) this.cargando.set(true);
    this.api.inbox().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (b) => {
        const antes = new Set((this.bandeja()?.data ?? []).map((r) => r.order_id));
        const nuevos = this.bandeja() ? b.data.filter((r) => !antes.has(r.order_id) && r.bucket === 'hoy') : [];
        this.bandeja.set(b);
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
        this.error.set(null);
        if (nuevos.length) {
          const t = nuevos.length === 1 ? `Nuevo pedido para hoy: ${nuevos[0].customer_name || nuevos[0].code}` : `${nuevos.length} pedidos nuevos para hoy`;
          this.toast.add({ severity: 'info', summary: t, life: 6000 });
          this.anuncio.set(t);
        }
      },
      error: (e) => { this.cargando.set(false); this.error.set(mensaje(e, 'No se pudo cargar la bandeja.')); },
    });
  }

  abrir(orderId: string, navegar = true): void {
    if (navegar) { this.router.navigate([], { relativeTo: this.route, queryParams: { pedido: orderId } }); return; }
    this.abierto.set(orderId);
    this.detalle.set(null);
    this.marcas.set({});
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    this.api.detail(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.detalle.set(d); this.cargandoDetalle.set(false); },
      error: (e) => { this.cargandoDetalle.set(false); this.errorDetalle.set(mensaje(e, 'No se pudo abrir el pedido.')); },
    });
  }

  cerrarDetalle(): void {
    this.router.navigate([], { relativeTo: this.route, queryParams: {} });
  }

  empezar(orderId: string): void {
    this.trabajando.set(true);
    this.api.start(orderId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (fila) => {
        this.trabajando.set(false);
        const d = this.detalle();
        if (d) this.detalle.set({ ...d, order: fila });
        this.anuncio.set(`Empezaste a surtir ${fila.code} a las ${this.horaDe(fila.started?.at)}`);
      },
      error: (e) => { this.trabajando.set(false); this.toast.add({ severity: 'error', summary: mensaje(e, 'No se pudo empezar.'), life: 6000 }); },
    });
  }

  marca(l: PresalePickLine): number | null {
    const v = this.marcas()[l.line_id];
    return v === undefined ? null : v;
  }
  completo(l: PresalePickLine): void { this.poner(l, l.qty); }
  mover(l: PresalePickLine, d: number): void {
    const actual = this.marca(l) ?? l.qty;
    const paso = /^(KG|GR|LT|L)$/i.test(l.unit) ? 0.5 : 1;
    this.poner(l, Math.min(l.qty, Math.max(0, +(actual + d * paso).toFixed(3))));
  }
  private poner(l: PresalePickLine, v: number): void {
    this.marcas.update((m) => ({ ...m, [l.line_id]: v }));
  }
  leyenda(l: PresalePickLine): string {
    const v = this.marca(l);
    if (v === null) return 'sin marcar';
    if (v >= l.qty) return 'listo';
    if (v === 0) return 'no hubo';
    return `faltan ${+(l.qty - v).toFixed(3)} ${l.unit}`;
  }

  terminar(d: PresalePickDetail): void {
    const m = this.marcas();
    this.trabajando.set(true);
    this.api.finish(d.order.order_id, { lines: d.lines.map((l) => ({ line_id: l.line_id, picked: m[l.line_id] })) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.trabajando.set(false);
          const t = r.outcome === 'completo'
            ? `${d.order.code} surtido completo`
            : `${d.order.code}: reporte enviado. Nuevo total ${this.dinero(r.report?.total_after ?? 0)}`;
          this.toast.add({ severity: 'success', summary: t, life: 6000 });
          this.anuncio.set(t);
          this.cerrarDetalle();
          this.cargar(true);
        },
        error: (e) => { this.trabajando.set(false); this.toast.add({ severity: 'error', summary: mensaje(e, 'No se pudo terminar.'), life: 8000 }); },
      });
  }

  private limpiarDetalle(): void {
    this.abierto.set(null);
    this.detalle.set(null);
    this.marcas.set({});
  }

  estado(s: PresalePickState) { return ESTADO[s]; }
  dinero(n: number | string | null | undefined): string { return pesos.format(Number(n) || 0); }
  horaDe(iso: string | null | undefined): string { return iso ? hora.format(new Date(iso)) : ''; }
  fechaCorta(f: string): string {
    const [y, mo, d] = f.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, mo - 1, d)));
  }
}

function mensaje(e: unknown, def: string): string {
  const m = (e as { error?: { message?: string | string[] } })?.error?.message;
  return Array.isArray(m) ? m.join(' · ') : m || def;
}
