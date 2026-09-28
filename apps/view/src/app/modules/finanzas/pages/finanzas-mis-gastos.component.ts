import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FormsModule } from '@angular/forms';
import {
  CLASIFICACION_LABEL, ComprobacionesService,
  type ExpenseClasificacion, type ExpenseProof, type ValeGasto,
} from '../comprobaciones.service';
import { ValeGastoPeekComponent } from '../components/vale-gasto-peek.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { parseLocalDate } from '../../../core/utils/mx-date';

/**
 * `[GX.33]` — **Mis gastos.** Lo que YO levanté, en qué quedó cada uno, y su expediente.
 *
 * ## Por qué existe, y qué reemplaza
 * Hasta acá, quien sólo levanta gastos entraba al **Historial** — una pantalla pensada para
 * revisar: calendario por mes, ámbitos «Míos/Todos», buscador de toda la empresa. Funcionaba
 * (el servidor ya le acotaba a lo suyo), pero **decía otra cosa de la que hacía**: se llama
 * «Historial», ofrece un selector de ámbito que él no puede usar, y lo que de verdad quiere
 * saber —«¿ya me lo aprobaron?»— había que deducirlo de un calendario.
 *
 * Acá la pregunta es una sola y la respuesta está arriba: **cuántos esperan firma, cuántos
 * se aprobaron, cuántos te devolvieron**. Y cada renglón abre su expediente completo.
 *
 * ## ⛔ No filtra del lado del cliente
 * Pide `GET /mine`, que el servidor acota por el token. Si el recorte viviera acá, un error
 * de esta pantalla mostraría el gasto ajeno — y peor, nadie se enteraría.
 *
 * ## ⚠️ Un rechazo se ve acá, pero no para siempre
 * A las 24 h el servidor deja de devolverlo (`[GX.29]`). No es un bug de esta pantalla: es
 * que un vale rechazado se vuelve a capturar, no se arrastra. Se dice en el vacío, para que
 * nadie crea que se perdió.
 */
@Component({
  selector: 'app-finanzas-mis-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, ValeGastoPeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in mg">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Mis gastos</h1>
          <p class="surf-page-sub">Los que levantaste vos, y en qué quedó cada uno.</p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      @if (cargando()) { <div class="mg-muted">Cargando…</div> }
      @else if (error()) { <div class="mg-err">{{ error() }}</div> }
      @else {
        <!-- La respuesta a «¿en qué quedaron?», arriba y sin tener que contar renglones. -->
        <div class="mg-kpis">
          <div class="mg-kpi">
            <span class="mg-kpi-t">Esperan firma</span>
            <strong class="mg-kpi-v">{{ kpis().recibidas }}</strong>
          </div>
          <div class="mg-kpi ok">
            <span class="mg-kpi-t">Aprobados</span>
            <strong class="mg-kpi-v">{{ kpis().validadas }}</strong>
          </div>
          <div class="mg-kpi" [class.bad]="kpis().rechazadas > 0">
            <span class="mg-kpi-t">Te los devolvieron</span>
            <strong class="mg-kpi-v">{{ kpis().rechazadas }}</strong>
          </div>
        </div>

        <div class="mg-barra">
          <span class="p-input-icon-left mg-buscar">
            <i class="pi pi-search" aria-hidden="true"></i>
            <input pInputText [(ngModel)]="q" (keyup.enter)="cargar()"
                   placeholder="Folio, proveedor o concepto…" />
          </span>
          @if (q) { <button type="button" class="mg-link" (click)="q = ''; cargar()">limpiar</button> }
        </div>

        @if (!filas().length) {
          <div class="mg-vacio">
            <i class="pi pi-inbox" aria-hidden="true"></i>
            <div>
              @if (q) {
                <strong>Ninguno de tus gastos coincide con «{{ q }}».</strong>
              } @else {
                <strong>Todavía no levantaste ningún gasto.</strong>
                <div class="mg-muted">Cuando levantes uno, aparece acá con su estado.</div>
              }
              <!-- Sin esto, quien busque un rechazo viejo va a creer que se perdió. -->
              <div class="mg-muted">Un gasto que te devolvieron deja de verse a las 24 h: ése se vuelve a capturar.</div>
            </div>
          </div>
        } @else {
          <section class="mg-lista">
            @for (p of filas(); track p.id) {
              <article class="mg-item" role="button" tabindex="0"
                       [attr.aria-label]="'Ver el vale ' + (p.folio_solicitud || 'sin folio')"
                       (click)="abrir(p)" (keydown.enter)="abrir(p)"
                       (keydown.space)="abrir(p); $event.preventDefault()">
                <div class="mg-it-head">
                  <span class="mg-folio">{{ p.folio_solicitud || 'sin folio' }}</span>
                  @if (p.sucursal) { <span class="mg-faint">suc {{ p.sucursal }}</span> }
                  <span class="mg-grow"></span>
                  <span class="mg-imp">{{ money(p.importe) }}</span>
                </div>
                <div class="mg-it-con">{{ p.proveedor || '—' }}</div>
                <div class="mg-it-meta">
                  <span>{{ diaLocal(p.fecha_gasto) | date: 'dd/MM/yy' }}</span>
                  @if (p.clasificacion) { <span>·</span><span>{{ tipoGasto(p.clasificacion) }}</span> }
                </div>
                <div class="mg-it-chips">
                  <span class="mg-chip" [class.ok]="p.status === 'validada'"
                        [class.warn]="p.status === 'revision' || p.status === 'aprobada'"
                        [class.bad]="p.status === 'rechazada'">{{ estado(p.status) }}</span>
                  @if (p.status === 'aprobada') {
                    <span class="mg-chip warn">te toca subir la evidencia</span>
                  }
                </div>
                <!-- El motivo del rechazo va COMPLETO: es lo que hay que corregir. -->
                @if (p.motivo_rechazo) { <div class="mg-it-nota bad">Te lo devolvieron: {{ p.motivo_rechazo }}</div> }
              </article>
            }
          </section>
        }
      }

      <!-- El mismo visor que usan Aprobación y el Historial. Acá sin acciones: es lo tuyo,
           pero quien decide sobre el dinero es otro. -->
      <app-vale-gasto-peek [open]="abierto() !== null" (openChange)="cerrar($event)" [vale]="abierto()" />
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .mg { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 60rem; }
    .mg-muted { font-size: var(--fs-sm); color: var(--fg-2); }
    .mg-faint { font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-grow { flex-grow: 1; }
    .mg-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }
    .mg-link { border: 0; background: transparent; color: var(--action); font: inherit;
      font-size: var(--fs-xs); cursor: pointer; }

    .mg-kpis { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
    .mg-kpi { flex: 1 1 10rem; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); }
    .mg-kpi.ok { border-color: var(--ok-fg); }
    .mg-kpi.bad { border-color: var(--bad-border); }
    .mg-kpi-t { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .mg-kpi-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-h1); font-weight: var(--fw-bold); line-height: 1.1; }

    .mg-barra { display: flex; align-items: center; gap: var(--sp-2); }
    .mg-buscar input { width: 20rem; max-width: 100%; }

    .mg-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .mg-vacio .pi { color: var(--fg-3); font-size: 1.4rem; }

    .mg-lista { display: flex; flex-direction: column; gap: var(--sp-2); }
    .mg-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column;
      gap: 4px; cursor: pointer; }
    .mg-item:hover { border-color: var(--action); }
    .mg-item:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
    .mg-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .mg-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .mg-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); }
    .mg-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .mg-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .mg-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .mg-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .mg-chip.ok { color: var(--ok-fg); border-color: var(--ok-fg); }
    .mg-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .mg-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .mg-it-nota { font-size: var(--fs-xs); margin-top: 2px; }
    .mg-it-nota.bad { color: var(--bad-fg); }
  `],
})
export class FinanzasMisGastosComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly filas = signal<ExpenseProof[]>([]);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly abierto = signal<ValeGasto | null>(null);
  q = '';

  /**
   * ⚠️ Los KPI salen de `kpis` del SERVIDOR, no de contar `filas()`. La lista viene acotada
   * a un `limit`, así que contarla diría «tenés 200 gastos» al que tiene 340.
   */
  private readonly reporte = signal<{ recibidas: number; validadas: number; rechazadas: number } | null>(null);
  readonly kpis = computed(() => this.reporte() ?? { recibidas: 0, validadas: 0, rechazadas: 0 });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.svc.mine(200, this.q || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.filas.set(r.rows ?? []);
        this.reporte.set({
          recibidas: r.kpis?.recibidas ?? 0,
          validadas: r.kpis?.validadas ?? 0,
          rechazadas: r.kpis?.rechazadas ?? 0,
        });
        this.cargando.set(false);
      },
      // Un error NO se pinta como «no levantaste nada»: es otra afirmación, y la equivocada
      // manda a alguien a capturar de nuevo un gasto que ya mandó.
      error: () => { this.error.set('No se pudieron cargar tus gastos. Reintentá.'); this.cargando.set(false); },
    });
  }

  abrir(p: ExpenseProof): void { this.abierto.set(p as ValeGasto); }
  cerrar(abierto: boolean): void { if (!abierto) this.abierto.set(null); }

  diaLocal(iso: string | null | undefined): Date | null { return parseLocalDate(iso); }

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  /**
   * Cómo se lee cada estado **desde el lado de quien levantó el gasto**. No son las mismas
   * palabras que ve quien aprueba: a él «aprobada» le dice que ya firmó; a quien capturó le
   * dice que todavía le toca hacer algo.
   */
  estado(s: string): string {
    return ({
      recibida: 'Esperando firma',
      aprobada: 'Aprobado',
      revision: 'En revisión',
      validada: 'Listo',
      rechazada: 'Te lo devolvieron',
    } as Record<string, string>)[s] ?? s;
  }

  tipoGasto(c: string): string { return CLASIFICACION_LABEL[c as ExpenseClasificacion] ?? c; }
}
