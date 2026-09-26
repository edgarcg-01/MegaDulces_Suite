import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { InputTextModule } from 'primeng/inputtext';
import { ComprobacionesService, ExpenseProof, ExpenseProofsReport } from '../comprobaciones.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';

/**
 * `[GX.25]` — **Historial de levantamientos.**
 *
 * Quien toma la foto la manda y no la vuelve a ver: el levantamiento desaparece de su
 * pantalla en cuanto se envía. Acá queda, con su estado y lo que pasó después.
 *
 * ## Dos ámbitos, una pantalla
 * · **Míos** — lo que levantó ESTA persona. Sale de `/mine`, que el servidor acota por el
 *   token: no hay forma de pedir los de otro por más que se cambie un parámetro.
 * · **Todos** — el historial de todos los que generaron gastos. `[GX.26]` **Sólo
 *   god-mode** (`admin`/`superadmin`), por pedido del usuario. Antes bastaba
 *   `FINANCE_EXPENSES_VER`: eran 25 personas. Quien no lo tiene no ve esta pestaña **y
 *   tampoco la podría pedir** — el endpoint comprueba el rol igual, así que esconderla no
 *   es el candado, es la cortesía.
 *
 * ## ⚠️ De TODAS las fechas, a propósito
 * El buscador de folios de `/finanzas/gastos` muestra **sólo los de hoy** — ahí se levanta
 * el gasto del día y una solicitud vieja es ruido. Acá es al revés: un historial acotado a
 * hoy no es un historial. Son dos preguntas distintas contra la misma tabla.
 *
 * ## ⚠️ Lo que este historial NO puede mostrar
 * `finance.expense_proofs` sólo tiene lo que pasó por ESTA app. Un gasto que Kepler
 * autorizó y que nadie levantó acá no aparece — y no es un hueco de la consulta, es que
 * no existe de este lado. Por eso la pantalla dice «levantamientos», no «gastos».
 */
@Component({
  selector: 'app-finanzas-gastos-historial',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in hist">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Historial de levantamientos</h1>
          <p class="surf-page-sub">Todo lo que se levantó, de cualquier fecha. Buscá por folio, proveedor o quien lo pidió.</p>
        </div>
      </header>

      <div class="hist-barra">
        @if (puedeVerTodos()) {
          <div class="hist-seg" role="tablist" aria-label="Qué historial">
            <button type="button" role="tab" [attr.aria-selected]="ambito() === 'mios'"
                    [class.on]="ambito() === 'mios'" (click)="cambiar('mios')">Míos</button>
            <button type="button" role="tab" [attr.aria-selected]="ambito() === 'todos'"
                    [class.on]="ambito() === 'todos'" (click)="cambiar('todos')">Todos</button>
          </div>
        }
        <input pInputText [ngModel]="busqueda()" (ngModelChange)="buscar($event)"
               placeholder="Folio, proveedor o quien lo pidió…" class="hist-buscar"
               aria-label="Buscar en el historial" />
        <button type="button" class="hist-refrescar" (click)="cargar()">
          <i class="pi pi-refresh" aria-hidden="true"></i> actualizar
        </button>
      </div>

      @if (cargando()) {
        <div class="hist-vacio">Cargando…</div>
      } @else if (error()) {
        <!-- Un error NO se pinta como lista vacía: eso diría «no levantaste nada», que es otra cosa. -->
        <div class="hist-vacio bad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ error() }}</div>
      } @else if (!filas().length) {
        <div class="hist-vacio">
          @if (busqueda().trim()) { Sin coincidencias para «{{ busqueda() }}». }
          @else if (ambito() === 'mios') { Todavía no levantaste ningún gasto. }
          @else { No hay levantamientos. }
        </div>
      } @else {
        <div class="hist-kpis">
          <span><b>{{ filas().length }}</b> levantamientos</span>
          <span><b>{{ moneyFull(total()) }}</b> en total</span>
        </div>
        <div class="hist-tabla-wrap">
          <table class="hist-tabla">
            <thead>
              <tr>
                <th>Folio</th><th>Fecha</th><th>Proveedor</th><th class="num">Importe</th>
                <th>Estado</th><th>Levantó</th><th>Enviado</th>
              </tr>
            </thead>
            <tbody>
              @for (r of filas(); track r.id) {
                <tr>
                  <td class="mono">{{ r.folio_solicitud || '—' }}</td>
                  <td>{{ r.fecha_gasto ? (r.fecha_gasto | date:'dd/MM/yy') : '—' }}</td>
                  <td class="hist-prov">{{ r.proveedor || '—' }}</td>
                  <td class="num mono">{{ moneyFull(r.importe) }}</td>
                  <td><span class="hist-est" [class]="'e-' + r.status">{{ etiqueta(r.status) }}</span></td>
                  <td>{{ r.created_by || '—' }}</td>
                  <td>{{ r.created_at | date:'dd/MM/yy HH:mm' }}</td>
                </tr>
                @if (r.status === 'rechazada' && r.motivo_rechazo) {
                  <tr class="hist-nota"><td colspan="7"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ r.motivo_rechazo }}</td></tr>
                }
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }
    .hist { max-width: 72rem; margin: 0 auto; }
    .hist-barra { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center;
      margin-bottom: var(--sp-3); }
    .hist-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--r-sm);
      overflow: hidden; }
    .hist-seg button { min-height: var(--tap-min); padding: 0 var(--sp-3); border: 0; background: transparent;
      font: inherit; font-size: var(--fs-sm); color: var(--fg-2); cursor: pointer; }
    .hist-seg button.on { background: var(--fg-1); color: var(--surface-card, #fff); font-weight: var(--fw-medium); }
    .hist-buscar { flex: 1 1 18rem; min-width: 12rem; }
    .hist-refrescar { min-height: var(--tap-min); padding: 0 var(--sp-2); border: 0; background: none;
      font: inherit; font-size: var(--fs-xs); color: var(--action); cursor: pointer; }

    .hist-kpis { display: flex; gap: var(--sp-4); margin-bottom: var(--sp-2);
      font-size: var(--fs-xs); color: var(--fg-2); }
    .hist-vacio { padding: var(--sp-6); text-align: center; font-size: var(--fs-sm); color: var(--fg-3); }
    .hist-vacio.bad { color: var(--bad-fg); }

    /* Tabla densa: es una bandeja de consulta, se compara de un vistazo. */
    .hist-tabla-wrap { border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: auto; }
    .hist-tabla { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .hist-tabla th { position: sticky; top: 0; z-index: 1; text-align: left; white-space: nowrap;
      padding: var(--sp-2) var(--sp-3); background: var(--surface-ground); color: var(--fg-3);
      font-weight: var(--fw-medium); border-bottom: 1px solid var(--border-color); }
    .hist-tabla td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border-color);
      color: var(--fg-1); vertical-align: top; }
    .hist-tabla .num { text-align: right; }
    .hist-prov { max-width: 18rem; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    /* El estado se lee por color Y por palabra: el color solo no le sirve a quien no lo distingue. */
    .hist-est { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-sm);
      font-size: var(--fs-micro); border: 1px solid var(--border-color); color: var(--fg-2); }
    .hist-est.e-validada { color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-color: var(--ok-border); }
    .hist-est.e-rechazada { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .hist-nota td { color: var(--bad-fg); font-size: var(--fs-micro); padding-top: 0; }
  `],
})
export class FinanzasGastosHistorialComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * `[GX.26]` «Todos» sólo para god-mode. No es sólo estética: el endpoint comprueba el rol
   * igual, así que mostrar la pestaña a quien no lo tiene sería ofrecer una puerta que
   * devuelve 403.
   *
   * ⚠️ Se mira el ROL, no una clave del mapa de permisos. `perms.isAdmin()` es el espejo de
   * `isPlatformAdminRole` del servidor — el mismo criterio de los dos lados. Usar una clave
   * volvería a abrirlo a quien la tenga marcada, que es justo lo que se acaba de cerrar.
   */
  readonly puedeVerTodos = computed(() => this.perms.isAdmin());

  readonly ambito = signal<'mios' | 'todos'>('mios');
  readonly busqueda = signal('');
  readonly cargando = signal(false);
  readonly error = signal('');
  readonly filas = signal<ExpenseProof[]>([]);
  readonly total = computed(() => this.filas().reduce((a, r) => a + (Number(r.importe) || 0), 0));

  private debounce?: ReturnType<typeof setTimeout>;

  constructor() { this.cargar(); }

  cambiar(a: 'mios' | 'todos') {
    if (this.ambito() === a) return;
    this.ambito.set(a);
    this.cargar();
  }

  /** El buscador espera a que la persona deje de teclear: una consulta por letra no sirve a nadie. */
  buscar(v: string) {
    this.busqueda.set(v);
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.cargar(), 300);
  }

  cargar() {
    this.cargando.set(true);
    this.error.set('');
    const q = this.busqueda().trim() || undefined;
    const pide = this.ambito() === 'todos' && this.puedeVerTodos()
      ? this.svc.historial(200, q)
      : this.svc.mine(200, q);
    pide.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r: ExpenseProofsReport) => {
        this.filas.set(r?.rows || []);
        this.cargando.set(false);
        this.cdr.markForCheck();
      },
      error: () => {
        this.filas.set([]);
        this.error.set('No se pudo cargar el historial. Reintentá.');
        this.cargando.set(false);
        this.cdr.markForCheck();
      },
    });
  }

  etiqueta(s: string): string {
    switch (s) {
      case 'recibida': return 'esperando';
      case 'aprobada': return 'aprobada';
      case 'validada': return 'validada';
      case 'rechazada': return 'rechazada';
      case 'revision': return 'en revisión';
      default: return s || '—';
    }
  }

  moneyFull(n: number | null | undefined): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
