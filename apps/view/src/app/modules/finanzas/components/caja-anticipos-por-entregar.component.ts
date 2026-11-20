import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, interval, map, merge, of, switchMap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { nombreDeBase, type AnticipoPorEntregarRow } from '@megadulces/contracts';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { environment } from '../../../../environments/environment';
import { money, dmy } from '../pages/finanzas-format';

/**
 * `[PGP.157]` **Los anticipos en efectivo que Caja General tiene por entregar**, en Captura.
 *
 * Francisco (2026-11-19): *«una vez autorizado el anticipo con caja general, que se genere en caja general, en la
 * sucursal que se le va a dar el dinero»*. Nace al AUTORIZAR su pago en el Calendario y se va solo cuando Kepler
 * tiene su `X-D-60`; nada se copia (lo arma el servidor del pago y del pareo de anticipos). El efectivo sale de la
 * Caja General de la BASE del anticipo: cada base cuadra sola.
 *
 * ⭐ **Un botón en la barra y una ventana, como «Reposición»** (`[CGA-A.63]`, Edgar: *«el 95 % de la interfaz si no
 * es el 100 % tiene que ser el arqueo y los movimientos»*). El recorrido visual del 2026-11-19 lo midió: en línea,
 * 3 anticipos ocupaban 386 px (247 px compactados) de la primera pantalla y empujaban la cola. Este componente no
 * pinta nada en la pantalla: da `hay()` y `resumen()` para el botón y abre su ventana con `abrirVentana()`.
 *
 * Las cinco preguntas (skill `diseno` §0b):
 *  1. **Qué ve y en qué orden:** en la barra, cuántos y cuánto; en la ventana, el día del Calendario más cercano
 *     primero; de cada uno, a quién, de qué Caja General sale y cuánto; luego quién lo autorizó y el folio del pago.
 *  2. **Qué no ve:** la cotización, la cuenta, las etapas de Compras. Sin acciones: la entrega se registra con el
 *     `X-D-60` de Kepler, que entra a la cola. Sin anticipos, ni el botón (no hay nada que hacer).
 *  3. **Accesibilidad:** el botón dice el resumen en palabras y anuncia que abre una ventana; Esc la cierra y el foco
 *     regresa al botón. Si la lectura falla, el botón lo dice (nunca se confunde con «no hay»).
 *  4. **Ligas:** el Calendario (folio y día del pago) y Kepler (el `X-D-60` que falta, en qué base y por cuánto).
 *  5. **¿Le toca a Captura?** Sí: es la pantalla de Caja General hoy (decidido por Francisco el 2026-11-19).
 */
@Component({
  selector: 'app-caja-anticipos-por-entregar',
  standalone: true,
  imports: [ButtonModule, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-side-peek mode="window" [width]="820" [open]="abierta()" (openChange)="$event ? null : cerrarVentana()"
                   title="Anticipos en efectivo por entregar" [subtitle]="subtitulo()">
      <div class="ape">
        @if (error(); as e) {
          <p class="ape-error" role="status">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <span>No se pudieron leer los anticipos en efectivo autorizados en el Calendario ({{ e }}). Puede haber alguno por entregar.</span>
            <p-button label="Reintentar" icon="pi pi-refresh" size="small" [text]="true" (onClick)="cargar()" />
          </p>
        } @else if (!filas().length) {
          <p class="ape-explica">No hay anticipos en efectivo autorizados por entregar.</p>
        } @else {
          <p class="ape-explica">Autorizados en el Calendario. Cada uno sale de la Caja General de su base y se va de aquí cuando su <b>X-D-60</b> llega al Kepler de esa base; entonces entra a la cola.</p>
          <ul class="ape-list">
            @for (a of filas(); track a.allocation_id + a.obligation_id) {
              <li class="ape-row">
                <div class="ape-main">
                  <span class="ape-prov">{{ a.proveedor_nombre }} <span class="mono ape-dim">{{ a.proveedor }}</span></span>
                  <span class="ape-caja">Caja General de <b>{{ nombre(a.sucursal) }}</b></span>
                  <span class="mono ape-monto">{{ money(a.monto) }}</span>
                </div>
                <div class="ape-sub">
                  @if (a.monto_anticipo && a.monto !== a.monto_anticipo) { en este pago, de un anticipo de <span class="mono">{{ money(a.monto_anticipo) }}</span> · }
                  autorizó {{ a.autorizado_por || '—' }}@if (a.autorizado_el) { el {{ fechaHora(a.autorizado_el) }}}
                  · pago {{ a.pago_folio || 'sin folio' }} del {{ dmy(a.programado_dia) }}
                  @if (a.ocs.length) { · OC {{ ocs(a) }} }
                  @if (a.motivo) { · {{ a.motivo }} }
                </div>
                @if (a.kepler_previo; as k) {
                  <p class="ape-aviso">
                    <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                    <span>Kepler ya tiene un X-D-60 de este proveedor por ese importe del {{ dmy(k.fecha) }} ({{ k.folio }}), <b>de antes de la autorización</b>: revisa que no se haya entregado ya.</span>
                  </p>
                }
              </li>
            }
          </ul>
        }
      </div>
    </app-side-peek>
  `,
  styles: [`
    :host { display: contents; }
    .ape { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ape-explica { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .ape-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .ape-row { padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 2px; }
    .ape-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 var(--sp-3); }
    .ape-prov { font-weight: 600; }
    .ape-monto { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ape-sub, .ape-dim { color: var(--text-muted); font-size: var(--fs-xs); }
    /* Texto de aviso: --warn-soft-fg (7:1); --warn-fg como texto da 2.15:1 (auditoria-diseno §3c). */
    .ape-aviso { margin: 2px 0 0; display: flex; gap: var(--sp-2); align-items: flex-start; color: var(--warn-soft-fg); font-size: var(--fs-xs); }
    .ape-error { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); margin: 0; color: var(--warn-soft-fg); font-size: var(--fs-sm); }
  `],
})
export class CajaAnticiposPorEntregarComponent {
  private readonly http = inject(HttpClient);
  /** Cada pedido de lectura; sólo cuenta la respuesta del último (`switchMap`): una vieja no pisa a una nueva. */
  private readonly pedir$ = new Subject<void>();
  private origen: HTMLElement | null = null;

  /** Cambia cuando la cola de Captura se recarga: el anticipo se relee con ella. */
  readonly recarga = input<unknown>(null);

  readonly filas = signal<AnticipoPorEntregarRow[]>([]);
  readonly error = signal<string | null>(null);
  readonly abierta = signal(false);
  readonly total = computed(() => this.filas().reduce((s, a) => s + Number(a.monto || 0), 0));
  /** El botón de la barra sale si hay algo que entregar, o si no se pudo saber (eso también se dice). */
  readonly hay = computed(() => this.filas().length > 0 || !!this.error());
  /** Lo que dice el botón de la barra. */
  readonly resumen = computed(() => {
    if (this.error()) return 'no se pudo leer';
    const n = this.filas().length;
    return `${n} ${n === 1 ? 'anticipo' : 'anticipos'} · ${money(this.total())}`;
  });
  readonly subtitulo = computed(() => (this.error() ? 'No se pudo leer el Calendario' : this.resumen()));

  readonly money = money;
  readonly dmy = dmy;

  constructor() {
    // Se relee con la cola de Captura y, además, cada minuto: una autorización en el Calendario no mueve la cola de
    // Kepler, y sin esto no aparecería hasta que algo más la recargara.
    merge(this.pedir$, interval(60_000)).pipe(
      switchMap(() => this.http.get<AnticipoPorEntregarRow[]>(`${environment.apiUrl}/commercial/supplier-obligations/anticipos/por-entregar`).pipe(
        map((r) => ({ filas: Array.isArray(r) ? r : [], error: null as string | null })),
        catchError((e: HttpErrorResponse) => of({ filas: null, error: e?.status === 403 ? 'sin permiso' : (e?.error?.message || e?.message || 'error de red') })),
      )),
      takeUntilDestroyed(),
    ).subscribe((r) => {
      if (r.filas) this.filas.set(r.filas);
      this.error.set(r.error);
    });
    effect(() => { this.recarga(); untracked(() => this.cargar()); });
  }

  cargar(): void { this.pedir$.next(); }

  /** Abre la ventana y relee (como «Reposición»). */
  abrirVentana(origen?: HTMLElement): void {
    this.origen = origen ?? null;
    this.abierta.set(true);
    this.cargar();
  }

  cerrarVentana(): void {
    this.abierta.set(false);
    queueMicrotask(() => this.origen?.focus());
  }

  nombre(codigo: string | null | undefined): string { return codigo ? nombreDeBase(codigo) : 'su sucursal'; }
  ocs(a: AnticipoPorEntregarRow): string { return a.ocs.map((o) => o.folio).join(', '); }
  /** `YYYY-MM-DDTHH:MI` (hora de México, del servidor) → «19/11 16:40». */
  fechaHora(v: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(v);
    return m ? `${m[3]}/${m[2]} ${m[4]}` : v;
  }
}
