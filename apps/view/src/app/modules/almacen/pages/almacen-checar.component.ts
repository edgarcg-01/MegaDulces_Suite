import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import type {
  ChecadoEscaneoResultado,
  ChecadoEtiquetaP,
  ChecadoPedido,
  ChecadoRenglon,
  ChecadoTerminarResponse,
  ConsolaSurtidoAlmacen,
} from '@megadulces/contracts';
import { PickingService } from '../../reparto/picking.service';
import { AuthService } from '../../../core/services/auth.service';
import { etiquetaDeCaja, etiquetaDeCajaP, imprimirEtiquetas } from '../checado-etiquetas';

type Fase = 'cargando' | 'listo' | 'checando' | 'terminado';
type Origen = '' | 'TELEMARK' | 'SUCURSAL';
type Tono = 'ok' | 'warn' | 'bad';

const PREF_ALMACEN = 'gp.checar.almacen';
const PREF_ORIGEN = 'gp.checar.origen';

const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;
const TONO: Record<ChecadoEscaneoResultado, Tono> = {
  ok: 'ok', sobra: 'warn', pide_peso: 'warn', ajeno: 'bad', desconocido: 'bad', ambiguo: 'bad',
};
const ORDEN_ESTADO: Record<ChecadoRenglon['estado'], number> = { sobra: 0, falta: 1, pendiente: 2, completo: 3 };

/**
 * `[GP.4]` **Checar** (`FASE_GP` §9): pantalla de foco del checador, para celular y handheld.
 *
 * "Tomar siguiente" da un pedido surtido que Facturación ya pasó a SURTIDO en Kepler y que quien
 * checa no surtió (P4, lo cuida el servidor). Luego se **rastrilla**: la caja del producto cuenta
 * una caja; la paquetería entra a la caja P abierta. Cerrar la caja P imprime su etiqueta por
 * triplicado; terminar imprime las de las cajas "1/7…". Lo checado es lo que sale (P7).
 *
 * El campo de código se queda con el foco: el escáner del handheld "teclea" el código y Enter.
 */
@Component({
  selector: 'app-almacen-checar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RouterLink, ButtonModule],
  template: `
    <div class="ck">
      <header class="ck-top">
        <a routerLink="/almacen" class="ck-salir"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Salir</span></a>
        <h1>Checar</h1>
      </header>

      @if (error(); as e) {
        <div class="ck-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ e }}</span>
          @if (fase() === 'listo') { <button type="button" class="ck-link" (click)="iniciar()">Reintentar</button> }
        </div>
      }

      @switch (fase()) {
        @case ('cargando') { <p class="ck-muted" aria-busy="true">Cargando…</p> }

        @case ('listo') {
          <section class="ck-card">
            @if (almacenes().length > 1) {
              <label class="ck-l" for="ck-alm">Almacén donde checas</label>
              <select id="ck-alm" class="ck-select" [ngModel]="almacenId()" (ngModelChange)="elegirAlmacen($event)">
                <option value="">— Elige —</option>
                @for (a of almacenes(); track a.id) { <option [value]="a.id">{{ a.code }} · {{ a.nombre }}</option> }
              </select>
            } @else if (almacenes().length === 1) {
              <p class="ck-l">Almacén: <b>{{ almacenes()[0].code }} · {{ almacenes()[0].nombre }}</b></p>
            } @else {
              <p class="ck-warn">No tienes una sucursal asignada. Pídele a Sistemas que te asigne tu sucursal.</p>
            }
            <p class="ck-l">Pedidos de</p>
            <div class="ck-seg" role="group" aria-label="Pedidos de">
              @for (o of origenes; track o.v) {
                <button type="button" class="ck-seg-b" [class.on]="origen() === o.v" [attr.aria-pressed]="origen() === o.v" (click)="elegirOrigen(o.v)">{{ o.l }}</button>
              }
            </div>
            <button type="button" class="ck-go" [disabled]="!almacenId() || ocupado()" (click)="tomar()">
              <i class="pi pi-play" aria-hidden="true"></i><span>{{ ocupado() ? 'Buscando…' : 'Tomar siguiente' }}</span>
            </button>
            @if (!almacenId() && almacenes().length > 1) { <p class="ck-muted">Elige primero tu almacén.</p> }
            @if (sinTrabajo(); as s) { <p class="ck-note" role="status">{{ s }}</p> }
          </section>
        }

        @case ('checando') {
          @if (pedido(); as p) {
            <section class="ck-head">
              <div><span class="ck-code">{{ p.order_code }}</span><span class="ck-dest">{{ p.destino || '—' }}</span></div>
              <span class="ck-prog">{{ completos() }} de {{ p.renglones.length }} productos listos</span>
            </section>

            <form class="ck-scan" (ngSubmit)="escanear()" autocomplete="off">
              <label class="ck-l" for="ck-code">{{ pidePeso() ? 'Peso en la báscula (kg)' : 'Escanea o escribe el código' }}</label>
              @if (!pidePeso()) {
                <div class="ck-row">
                  <input #codigoInput id="ck-code" name="code" class="ck-input" [ngModel]="codigo()" (ngModelChange)="codigo.set($event)" inputmode="text" enterkeyhint="send" autocapitalize="characters" [disabled]="ocupado()" />
                  <button type="submit" class="ck-btn" [disabled]="!codigo().trim() || ocupado()">Agregar</button>
                </div>
                <div class="ck-row ck-cant">
                  <span class="ck-l">Cantidad</span>
                  <button type="button" class="ck-step" (click)="paso(-1)" [disabled]="cantidad() <= 1" aria-label="Una menos">−</button>
                  <span class="ck-n" aria-live="polite">{{ cantidad() }}</span>
                  <button type="button" class="ck-step" (click)="paso(1)" [disabled]="cantidad() >= 999" aria-label="Una más">+</button>
                  <span class="ck-muted ck-small">Para cajas sin etiqueta: escanea la pieza y pon cuántas.</span>
                </div>
              } @else {
                <div class="ck-row">
                  <input #pesoInput id="ck-code" name="peso" type="number" step="0.001" min="0" inputmode="decimal" class="ck-input" [ngModel]="peso()" (ngModelChange)="peso.set($event)" [disabled]="ocupado()" />
                  <button type="submit" class="ck-btn" [disabled]="!(peso() > 0) || ocupado()">Agregar</button>
                  <button type="button" class="ck-link" (click)="cancelarPeso()">Cancelar</button>
                </div>
              }
            </form>

            <div class="ck-aviso" [ngClass]="'ck-' + (aviso()?.tono ?? 'ok')" role="status" aria-live="polite">
              @if (aviso(); as a) { <span>{{ a.texto }}</span> }
            </div>

            @if (p.ultimo_escaneo; as u) {
              <div class="ck-ult">
                <span>Último: {{ u.cantidad }} {{ u.unidad ?? '' }} · {{ u.producto ?? '' }}@if (u.kind === 'ajeno') { (no va en el pedido) }</span>
                <button type="button" class="ck-link" [disabled]="ocupado()" (click)="deshacer(u.id)">Deshacer</button>
              </div>
            }

            @if (cajaAbierta(); as c) {
              <section class="ck-caja">
                <div><b>Caja P{{ c.numero }} abierta</b> · {{ plural(articulos(c.contenido), 'artículo', 'artículos') }}</div>
                <button type="button" class="ck-btn" [disabled]="ocupado() || !c.contenido.length" (click)="cerrarCaja()">Cerrar caja P{{ c.numero }} e imprimir etiqueta</button>
              </section>
            }
            @if (ultimaEtiquetaP(); as e) {
              <p class="ck-muted ck-small">Etiqueta de P{{ e.numero }} enviada a la etiquetera (3 iguales). <button type="button" class="ck-link" (click)="reimprimirP()">Reimprimir</button></p>
            }

            <ul class="ck-lista" aria-label="Productos del pedido">
              @for (r of renglonesOrdenados(); track r.id) {
                <li class="ck-item" [ngClass]="'ck-e-' + r.estado">
                  <div class="ck-item-t"><span class="ck-prod">{{ r.producto ?? r.sku }}</span><span class="ck-sku">{{ r.sku }}</span></div>
                  <div class="ck-item-n">
                    <span>{{ esperadoTexto(r) }}</span>
                    <span class="ck-chk">{{ checadoTexto(r) }}</span>
                    <span class="ck-badge">{{ estadoTexto(r) }}</span>
                  </div>
                </li>
              }
            </ul>

            @if (cajasCerradas().length) {
              <details class="ck-cerradas">
                <summary>{{ plural(cajasCerradas().length, 'caja P cerrada', 'cajas P cerradas') }}</summary>
                @for (c of cajasCerradas(); track c.id) {
                  <p><b>P{{ c.numero }}</b>: @for (x of c.contenido; track $index) { {{ x.cantidad }} {{ x.unidad ?? '' }} {{ x.producto ?? x.sku }}@if (!$last) {, } }</p>
                }
              </details>
            }

            @if (!confirmando()) {
              <button type="button" class="ck-go ck-fin" [disabled]="ocupado()" (click)="confirmando.set(true)"><span>Terminar checado</span></button>
            } @else {
              <section class="ck-confirm" role="group" aria-label="Terminar checado">
                @if (pendientes() > 0) {
                  <p class="ck-warn">{{ plural(pendientes(), 'producto no cuadra', 'productos no cuadran') }}: sale como lo checaste (si falta, sale incompleto).</p>
                } @else {
                  <p>Todo cuadra.</p>
                }
                <label class="ck-l" for="ck-espera">Dónde queda esperando la unidad (opcional)</label>
                <input id="ck-espera" class="ck-input" [ngModel]="espera()" (ngModelChange)="espera.set($event)" maxlength="40" placeholder="Ej. A2" />
                <div class="ck-row">
                  <button type="button" class="ck-btn" [disabled]="ocupado()" (click)="terminar()">Sí, terminar</button>
                  <button type="button" class="ck-link" [disabled]="ocupado()" (click)="confirmando.set(false)">Volver</button>
                </div>
              </section>
            }
          }
        }

        @case ('terminado') {
          @if (fin(); as f) {
            <section class="ck-card">
              <h2>{{ f.order_code }} checado</h2>
              <p class="ck-muted">{{ f.destino || '—' }} · {{ plural(f.cajas_p, 'caja P', 'cajas P') }} · {{ plural(f.etiquetas_cj.length, 'caja', 'cajas') }} de unidad mayor</p>
              @if (f.diferencias.length) {
                <p class="ck-warn">Sale con {{ plural(f.diferencias.length, 'diferencia', 'diferencias') }}:</p>
                <ul class="ck-dif">
                  @for (d of f.diferencias; track $index) {
                    <li>{{ d.producto ?? d.sku }}: esperado {{ d.esperado }} {{ d.unidad ?? '' }}, checado {{ d.checado }}</li>
                  }
                </ul>
              } @else {
                <p class="ck-ok">Todo cuadró.</p>
              }
              @if (f.etiquetas_cj.length) {
                <button type="button" class="ck-btn" (click)="imprimirCajas()">Imprimir etiquetas de cajas ({{ f.etiquetas_cj.length }})</button>
              }
              <button type="button" class="ck-go" [disabled]="ocupado()" (click)="tomar()"><i class="pi pi-play" aria-hidden="true"></i><span>Tomar siguiente</span></button>
            </section>
          }
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .ck { max-width:40rem; margin:0 auto; padding:var(--sp-3) var(--sp-3) var(--sp-6); }
    .ck-top { display:flex; align-items:center; gap:var(--sp-3); margin-bottom:var(--sp-3); }
    .ck-top h1 { margin:0; font-size:var(--fs-h2); font-weight:700; }
    .ck-salir { display:inline-flex; align-items:center; gap:.4rem; min-height:var(--tap-min); color:var(--text-muted); text-decoration:none; font-size:var(--fs-md); }
    .ck-card, .ck-head, .ck-caja, .ck-confirm { border:1px solid var(--border-color); border-radius:var(--r-lg); background:var(--card-bg); padding:var(--sp-3); margin-bottom:var(--sp-3); }
    .ck-card h2 { margin:0 0 .3rem; font-size:var(--fs-h3); }
    .ck-head { display:flex; justify-content:space-between; align-items:center; gap:var(--sp-2); flex-wrap:wrap; }
    .ck-code { display:block; font-family:var(--font-mono); font-weight:700; font-size:var(--fs-lg); }
    .ck-dest { display:block; color:var(--text-muted); font-size:var(--fs-sm); }
    .ck-prog { font-size:var(--fs-sm); font-weight:600; }
    .ck-l { display:block; font-size:var(--fs-sm); color:var(--text-muted); margin:.4rem 0 .25rem; }
    .ck-l b { color:var(--text-main); }
    .ck-select, .ck-input { width:100%; min-height:var(--tap-min); padding:0 .7rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-lg); box-sizing:border-box; }
    .ck-select:focus-visible, .ck-input:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .ck-row { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .ck-row .ck-input { flex:1; min-width:10rem; }
    .ck-cant { margin-top:.4rem; }
    .ck-cant .ck-l { margin:0; }
    .ck-step { width:var(--tap-min); height:var(--tap-min); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-size:var(--fs-lg); cursor:pointer; }
    .ck-n { min-width:2.5rem; text-align:center; font-family:var(--font-mono); font-size:var(--fs-lg); font-weight:700; }
    .ck-small { font-size:var(--fs-xs); }
    .ck-seg { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:var(--sp-3); }
    .ck-seg-b { min-height:var(--tap-min); padding:0 1rem; border:1px solid var(--border-color); border-radius:var(--r-pill); background:var(--card-bg); color:var(--text-main); font:inherit; cursor:pointer; }
    .ck-seg-b.on { border-color:var(--action); box-shadow:inset 0 0 0 1px var(--action); font-weight:600; }
    .ck-go { display:flex; align-items:center; justify-content:center; gap:.6rem; width:100%; min-height:4rem; border:0; border-radius:var(--r-lg); background:var(--action); color:var(--action-ink); font:inherit; font-size:var(--fs-h3); font-weight:700; cursor:pointer; margin-top:var(--sp-2); }
    .ck-go:disabled { background:var(--surface-border); color:var(--text-muted); cursor:not-allowed; }
    .ck-fin { background:var(--text-main); color:var(--card-bg); }
    .ck-btn { min-height:var(--tap-min); padding:0 1rem; border:0; border-radius:var(--r-md); background:var(--action); color:var(--action-ink); font:inherit; font-weight:600; cursor:pointer; }
    .ck-btn:disabled { background:var(--surface-border); color:var(--text-muted); cursor:not-allowed; }
    .ck-go:focus-visible, .ck-btn:focus-visible, .ck-step:focus-visible, .ck-seg-b:focus-visible, .ck-link:focus-visible, .ck-salir:focus-visible { outline:2px solid var(--action-ring); outline-offset:2px; }
    .ck-link { background:none; border:0; padding:0 .3rem; min-height:var(--tap-min); color:var(--action); font:inherit; text-decoration:underline; cursor:pointer; }
    .ck-aviso { min-height:2.4rem; margin:var(--sp-2) 0; padding:.5rem .8rem; border-radius:var(--r-md); font-size:var(--fs-md); font-weight:600; }
    .ck-aviso:empty { padding:0; min-height:0; }
    .ck-ok { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .ck-warn { background:var(--warn-soft-bg); color:var(--warn-soft-fg); padding:.4rem .6rem; border-radius:var(--r-md); }
    .ck-bad { background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .ck-ult { display:flex; justify-content:space-between; align-items:center; gap:.5rem; font-size:var(--fs-sm); margin-bottom:var(--sp-2); }
    .ck-caja { display:flex; flex-direction:column; gap:.5rem; border-left:3px solid var(--action); }
    .ck-lista { list-style:none; margin:0 0 var(--sp-3); padding:0; display:flex; flex-direction:column; gap:.4rem; }
    .ck-item { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.6rem .75rem; }
    .ck-item-t { display:flex; justify-content:space-between; gap:.5rem; }
    .ck-prod { font-weight:600; }
    .ck-sku { font-family:var(--font-mono); color:var(--text-muted); font-size:var(--fs-sm); }
    .ck-item-n { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; font-size:var(--fs-sm); margin-top:.2rem; }
    .ck-chk { font-family:var(--font-mono); font-weight:700; }
    .ck-badge { margin-left:auto; padding:.1rem .5rem; border-radius:var(--r-pill); font-size:var(--fs-xs); font-weight:700; background:var(--hover-bg); }
    .ck-e-completo .ck-badge { background:var(--ok-soft-bg); color:var(--ok-soft-fg); }
    .ck-e-falta .ck-badge { background:var(--warn-soft-bg); color:var(--warn-soft-fg); }
    .ck-e-sobra { border-left:3px solid var(--bad-fg); }
    .ck-e-sobra .ck-badge { background:var(--bad-soft-bg); color:var(--bad-soft-fg); }
    .ck-cerradas { margin-bottom:var(--sp-3); font-size:var(--fs-sm); }
    .ck-cerradas summary { min-height:var(--tap-min); display:flex; align-items:center; cursor:pointer; font-weight:600; }
    .ck-muted { color:var(--text-muted); }
    .ck-note { margin:var(--sp-2) 0 0; font-size:var(--fs-sm); }
    .ck-err { display:flex; align-items:center; gap:.5rem; padding:.6rem .8rem; margin-bottom:var(--sp-3); border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .ck-err .pi { color:var(--bad-fg); }
    .ck-dif { margin:0 0 var(--sp-3); padding-left:1.2rem; font-size:var(--fs-sm); }
  `],
})
export class AlmacenChecarComponent implements OnInit {
  private readonly api = inject(PickingService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly codigoInput = viewChild<ElementRef<HTMLInputElement>>('codigoInput');
  private readonly pesoInput = viewChild<ElementRef<HTMLInputElement>>('pesoInput');

  readonly plural = plural;
  readonly origenes: Array<{ v: Origen; l: string }> = [
    { v: '', l: 'Todos' },
    { v: 'TELEMARK', l: 'Telemarketing' },
    { v: 'SUCURSAL', l: 'Sucursal' },
  ];

  readonly fase = signal<Fase>('cargando');
  readonly almacenes = signal<ConsolaSurtidoAlmacen[]>([]);
  readonly almacenId = signal('');
  readonly origen = signal<Origen>('');
  readonly pedido = signal<ChecadoPedido | null>(null);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<{ tono: Tono; texto: string } | null>(null);
  readonly sinTrabajo = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly codigo = signal('');
  readonly cantidad = signal(1);
  readonly pidePeso = signal<string | null>(null);
  readonly peso = signal<number>(0);
  readonly confirmando = signal(false);
  readonly espera = signal('');
  readonly fin = signal<ChecadoTerminarResponse | null>(null);
  readonly ultimaEtiquetaP = signal<ChecadoEtiquetaP | null>(null);

  readonly completos = computed(() => (this.pedido()?.renglones ?? []).filter((r) => r.estado === 'completo').length);
  readonly pendientes = computed(() => (this.pedido()?.renglones ?? []).filter((r) => r.estado !== 'completo').length);
  readonly renglonesOrdenados = computed(() =>
    [...(this.pedido()?.renglones ?? [])].sort((a, b) => ORDEN_ESTADO[a.estado] - ORDEN_ESTADO[b.estado]),
  );
  readonly cajaAbierta = computed(() => (this.pedido()?.cajas_p ?? []).find((c) => c.status === 'abierta') ?? null);
  readonly cajasCerradas = computed(() => (this.pedido()?.cajas_p ?? []).filter((c) => c.status === 'cerrada'));

  ngOnInit(): void {
    this.origen.set(this.leer(PREF_ORIGEN) as Origen);
    this.iniciar();
  }

  /** Almacenes (con la clave del checado) + el pedido que ya traía, si cerró la app a medias. */
  iniciar(): void {
    this.error.set(null);
    this.fase.set('cargando');
    this.api.checadoAlmacenes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws) => {
        this.almacenes.set(ws || []);
        const guardado = this.leer(PREF_ALMACEN);
        const delUsuario = this.auth.user()?.warehouse_code;
        const def = ws.find((w) => w.id === guardado) ?? ws.find((w) => w.code === delUsuario) ?? (ws.length === 1 ? ws[0] : undefined);
        this.almacenId.set(def?.id ?? '');
        this.api.checadoMio().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (p) => {
            if (p) this.entrar(p, 'Retomaste el pedido que traías.');
            else this.fase.set('listo');
          },
          error: () => {
            this.error.set('No se pudo revisar si ya traías un pedido.');
            this.fase.set('listo');
          },
        });
      },
      error: () => {
        this.error.set('No se pudo leer la lista de almacenes.');
        this.fase.set('listo');
      },
    });
  }

  elegirAlmacen(id: string): void {
    this.almacenId.set(id);
    this.guardar(PREF_ALMACEN, id);
    this.sinTrabajo.set(null);
  }

  elegirOrigen(o: Origen): void {
    this.origen.set(o);
    this.guardar(PREF_ORIGEN, o);
    this.sinTrabajo.set(null);
  }

  tomar(): void {
    const alm = this.almacenId();
    if (!alm || this.ocupado()) return;
    this.ocupado.set(true);
    this.error.set(null);
    this.sinTrabajo.set(null);
    this.api.checadoSiguiente(alm, this.origen() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        if (r.estado === 'asignado') {
          this.entrar(r.pedido, r.ya_era_tuyo ? 'Retomaste el pedido que traías.' : 'Empieza a escanear.');
        } else {
          this.fase.set('listo');
          this.sinTrabajo.set(r.motivo);
        }
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.fase.set('listo');
        this.error.set(this.mensaje(e, 'No se pudo tomar un pedido.'));
      },
    });
  }

  paso(d: number): void {
    this.cantidad.set(Math.min(999, Math.max(1, this.cantidad() + d)));
  }

  escanear(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    const pesando = this.pidePeso();
    const code = pesando ?? this.codigo().trim();
    if (!code) return;
    if (pesando && !(this.peso() > 0)) return;
    this.ocupado.set(true);
    this.api
      .checadoEscanear(p.id, { code, cantidad: this.cantidad(), peso_kg: pesando ? Number(this.peso()) : undefined })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.ocupado.set(false);
          this.pedido.set(r.pedido);
          this.aviso.set({ tono: TONO[r.resultado], texto: r.mensaje });
          if (r.resultado === 'pide_peso') {
            this.pidePeso.set(code);
            this.peso.set(0);
            setTimeout(() => this.pesoInput()?.nativeElement.focus());
            return;
          }
          this.pidePeso.set(null);
          this.codigo.set('');
          this.cantidad.set(1);
          this.enfocar();
        },
        error: (e: unknown) => {
          this.ocupado.set(false);
          this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se registró el escaneo. Vuelve a escanear.') });
          this.enfocar();
        },
      });
  }

  cancelarPeso(): void {
    this.pidePeso.set(null);
    this.codigo.set('');
    this.aviso.set(null);
    this.enfocar();
  }

  deshacer(scanId: string): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoDeshacer(p.id, scanId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (np) => {
        this.ocupado.set(false);
        this.pedido.set(np);
        this.aviso.set({ tono: 'warn', texto: 'Se deshizo el último escaneo.' });
        this.enfocar();
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo deshacer.') });
      },
    });
  }

  cerrarCaja(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoCerrarCaja(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.pedido.set(r.pedido);
        this.ultimaEtiquetaP.set(r.etiqueta);
        this.aviso.set({ tono: 'ok', texto: `Caja P${r.etiqueta.numero} cerrada. Pega una etiqueta en dos lados de la caja.` });
        this.imprimirP(r.etiqueta);
        this.enfocar();
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo cerrar la caja.') });
      },
    });
  }

  reimprimirP(): void {
    const e = this.ultimaEtiquetaP();
    if (e) this.imprimirP(e);
  }

  terminar(): void {
    const p = this.pedido();
    if (!p || this.ocupado()) return;
    this.ocupado.set(true);
    this.api.checadoTerminar(p.id, this.espera().trim() || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.fin.set(r);
        this.pedido.set(null);
        this.confirmando.set(false);
        this.espera.set('');
        this.fase.set('terminado');
        if (r.etiqueta_p) this.imprimirP(r.etiqueta_p);
      },
      error: (e: unknown) => {
        this.ocupado.set(false);
        this.aviso.set({ tono: 'bad', texto: this.mensaje(e, 'No se pudo terminar el checado.') });
      },
    });
  }

  imprimirCajas(): void {
    const f = this.fin();
    if (!f) return;
    imprimirEtiquetas(f.etiquetas_cj.map((e) => etiquetaDeCaja(e, f.order_code, f.destino)));
  }

  esperadoTexto(r: ChecadoRenglon): string {
    if (r.esperado_mayor !== null && r.unidad_mayor) return `Van ${r.esperado_mayor} ${r.unidad_mayor}`;
    return `Van ${this.num(r.esperado)} ${r.unidad ?? ''}`.trim();
  }

  checadoTexto(r: ChecadoRenglon): string {
    if (r.esperado_mayor !== null && r.unidad_mayor) return `${r.checado_mayor} ${r.unidad_mayor}`;
    return `${this.num(r.checado)} ${r.unidad ?? ''}`.trim();
  }

  estadoTexto(r: ChecadoRenglon): string {
    switch (r.estado) {
      case 'completo': return 'Listo';
      case 'falta': return `Faltan ${this.num(r.esperado - r.checado)} ${r.unidad ?? ''}`.trim();
      case 'sobra': return `Sobran ${this.num(r.checado - r.esperado)} ${r.unidad ?? ''}`.trim();
      default: return 'Pendiente';
    }
  }

  articulos(contenido: Array<{ cantidad: number }>): number {
    return contenido.reduce((s, x) => s + x.cantidad, 0);
  }

  private entrar(p: ChecadoPedido, texto: string): void {
    this.pedido.set(p);
    this.fin.set(null);
    this.ultimaEtiquetaP.set(null);
    this.aviso.set({ tono: 'ok', texto });
    this.fase.set('checando');
    this.enfocar();
  }

  /** La etiqueta de la caja P por triplicado: llena la fila de 3 del rollo. */
  private imprimirP(e: ChecadoEtiquetaP): void {
    const et = etiquetaDeCajaP(e);
    imprimirEtiquetas([et, et, et], () => this.enfocar());
  }

  private enfocar(): void {
    setTimeout(() => this.codigoInput()?.nativeElement.focus());
  }

  private num(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  private mensaje(e: unknown, def: string): string {
    const m = (e as { error?: { message?: unknown } })?.error?.message;
    return typeof m === 'string' && m ? m : def;
  }

  private leer(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  }

  private guardar(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* sin almacenamiento: se elige de nuevo la próxima vez */
    }
  }
}
