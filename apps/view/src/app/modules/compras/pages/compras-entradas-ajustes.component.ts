import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { ENTRADAS_CONTROL_TABS } from '../entradas-control-tabs';
import { EntradasService, ReceiptSettings } from '../entradas.service';

/**
 * `[RE.16.3]` — **Centro de control · Ajustes**. Los cinco parámetros del proceso.
 *
 * Existían desde RE.13.0 en `finance.receipt_settings` y el backend los leía por tenant, pero
 * **sólo había GET**: para mover la fecha de arranque o el SLA había que correr un UPDATE a mano
 * en la base. Eso choca con la regla del proyecto de que el dato operativo se administra desde
 * la interfaz, así que acá está la pantalla y en el server el `PUT`.
 *
 * Ninguno es cosmético, y por eso cada campo dice **qué se rompe** si se mueve — la validación
 * de rango vive en el server, esto explica el porqué:
 *
 *   · `reception_start` hacia atrás mete el histórico (que nunca va a tener comprobante) al % de
 *     cobertura, y el número deja de servir para exigirle a nadie.
 *   · una tolerancia grande hace que "cuadra" deje de significar algo.
 *   · los dos SLA son los dos relojes distintos del proceso: el de la sucursal que sube y el del
 *     revisor que decide. Mezclarlos borra de quién es el atraso.
 *
 * Gateado con `_VALIDAR`, no con `_VER`: cambiar esto mueve el tablero de toda la red.
 */
@Component({
  selector: 'app-compras-entradas-ajustes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, DatePickerModule, InputTextModule, ToastModule, PageTabsComponent, LoadStateComponent, ContextHelpComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page in ea">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Control de entradas · Parámetros</h1>
          <p class="surf-page-sub">
            Los parámetros del proceso de recepción documental. Aplican a toda la red y se ven en
            el mismo click.
          </p>
        </div>
        <app-context-help topic="compras-entradas" />
      </header>

      <app-page-tabs [tabs]="tabs" />

      <section class="surf-card ea-card">
        @if (error() && !form()) {
          <app-load-state [error]="error()" (retry)="cargar()" />
        } @else if (!form()) {
          <app-load-state [loading]="true" [skeletonRows]="5" />
        } @else if (form(); as f) {
          <div class="ea-grid">
            <label class="ea-field">
              <span class="ea-k">Arranque del proceso</span>
              <!-- p-datepicker y no un input date nativo (checklist 3): el nativo se ve distinto
                   en cada navegador y no respeta el tema. La conversión va por partes locales,
                   nunca por toISOString — ver los métodos fecha/setFecha. -->
              <p-datepicker [ngModel]="fecha(f.reception_start)" (ngModelChange)="setFecha($event)"
                            name="reception_start" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body"
                            styleClass="ea-dp" inputStyleClass="ea-in mono" ariaLabel="Arranque del proceso" />
              <span class="ea-why">
                Las órdenes anteriores a esta fecha son <b>rezago</b>: se cuentan aparte y no
                entran al % de cobertura ni al semáforo. Moverla hacia atrás mete al tablero
                facturas que nunca van a existir.
              </span>
            </label>

            <label class="ea-field">
              <span class="ea-k">Tolerancia del cuadre</span>
              <span class="ea-inrow">
                <em>$</em>
                <input pInputText type="number" min="0" max="500" step="0.5"
                       [ngModel]="f.match_tolerance" (ngModelChange)="set('match_tolerance', +$event)"
                       name="match_tolerance" class="ea-in mono" />
              </span>
              <span class="ea-why">
                Diferencia máxima entre el total de la factura y el de Kepler para decir que
                <b>cuadra</b>. Sirve para el redondeo de centavos; si se agranda, "cuadra" deja de
                significar algo.
              </span>
            </label>

            <label class="ea-field">
              <span class="ea-k">Plazo para subir la factura</span>
              <span class="ea-inrow">
                <input pInputText type="number" min="1" max="60" step="1"
                       [ngModel]="f.sla_capture_days" (ngModelChange)="set('sla_capture_days', +$event)"
                       name="sla_capture_days" class="ea-in mono" />
                <em>días</em>
              </span>
              <span class="ea-why">
                Reloj de la <b>sucursal</b>. Pasado esto la orden se marca vencida y sube en la
                lista de pendientes.
              </span>
            </label>

            <label class="ea-field">
              <span class="ea-k">Plazo para revisarla</span>
              <span class="ea-inrow">
                <input pInputText type="number" min="1" max="60" step="1"
                       [ngModel]="f.sla_review_days" (ngModelChange)="set('sla_review_days', +$event)"
                       name="sla_review_days" class="ea-in mono" />
                <em>días</em>
              </span>
              <span class="ea-why">
                Reloj del <b>revisor</b>: cuánto puede esperar una factura ya subida sin decisión.
                Es otro reloj a propósito — si fuera el mismo, no se sabría de quién es el atraso.
              </span>
            </label>

            <label class="ea-field">
              <span class="ea-k">Tope de archivos por lote</span>
              <span class="ea-inrow">
                <input pInputText type="number" min="1" max="200" step="1"
                       [ngModel]="f.bulk_max_files" (ngModelChange)="set('bulk_max_files', +$event)"
                       name="bulk_max_files" class="ea-in mono" />
                <em>PDFs</em>
              </span>
              <span class="ea-why">
                Cuántos PDFs se pueden soltar de una sola vez. CEDIS sube ~30 al día; el tope
                existe para que un arrastre accidental de una carpeta entera no cueste 400 OCR.
              </span>
            </label>
          </div>

          <footer class="ea-foot">
            @if (sucio()) {
              <span class="ea-dirty">Hay cambios sin guardar.</span>
            } @else if (guardadoAt()) {
              <span class="ea-saved"><i class="pi pi-check" aria-hidden="true"></i> Guardado.</span>
            }
            <span class="ea-spacer"></span>
            <button pButton type="button" class="p-button-sm p-button-text" [disabled]="!sucio() || saving()"
                    (click)="descartar()">
              <span class="p-button-label">Descartar</span>
            </button>
            <button pButton type="button" class="p-button-sm" [disabled]="!sucio() || saving()" [loading]="saving()"
                    (click)="guardar()">
              <span class="p-button-icon p-button-icon-left pi pi-save" aria-hidden="true"></span>
              <span class="p-button-label">Guardar cambios</span>
            </button>
          </footer>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ea-card { padding: 0; }
    .ea-grid { display: grid; gap: 0; }
    .ea-field {
      display: grid; grid-template-columns: 14rem 12rem minmax(0, 1fr); align-items: center;
      gap: var(--sp-4); padding: var(--sp-4) var(--sp-5);
      border-bottom: 1px solid var(--border-color);
    }
    .ea-field:last-child { border-bottom: 0; }
    @media (max-width: 60rem) {
      .ea-field { grid-template-columns: minmax(0, 1fr); gap: var(--sp-2); }
    }
    .ea-k { font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .ea-in { width: 100%; }
    .ea-inrow { display: flex; align-items: center; gap: var(--sp-2); }
    .ea-inrow em { font-style: normal; font-size: var(--fs-xs); color: var(--text-faint); white-space: nowrap; }
    .mono { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }
    .ea-why { font-size: var(--fs-xs); color: var(--text-muted); max-width: 42rem; }
    .ea-why b { color: var(--text-main); font-weight: 600; }

    .ea-foot {
      display: flex; align-items: center; gap: var(--sp-2);
      padding: var(--sp-3) var(--sp-5); border-top: 1px solid var(--border-color);
      background: var(--surface-2);
    }
    .ea-spacer { flex: 1 1 auto; }
    .ea-dirty { font-size: var(--fs-xs); color: var(--warn-fg); }
    .ea-saved { font-size: var(--fs-xs); color: var(--ok-fg); }
  `],
})
export class ComprasEntradasAjustesComponent {
  private readonly svc = inject(EntradasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = ENTRADAS_CONTROL_TABS;
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly guardadoAt = signal<number | null>(null);
  /** Lo que vino del server: la referencia para saber qué está sucio y para descartar. */
  private readonly original = signal<ReceiptSettings | null>(null);
  readonly form = signal<ReceiptSettings | null>(null);

  readonly sucio = computed(() => {
    const a = this.original(), b = this.form();
    return !!a && !!b && JSON.stringify(a) !== JSON.stringify(b);
  });

  /**
   * `[RE.17.2]` — DESIGN §8. La pantalla ya avisaba "Hay cambios sin guardar" y después te
   * dejaba salir en silencio. Estos parámetros mueven el tablero de toda la red (la fecha de
   * arranque cambia el % de cobertura de las 9 sucursales), así que perderlos por un clic en el
   * sidebar es caro. `hasUnsavedChanges` lo consume `unsavedChangesGuard` en la ruta.
   */
  hasUnsavedChanges(): boolean { return this.sucio() && !this.saving(); }

  /** Salida EXTERNA (cerrar pestaña / F5): el Router no la ve, sólo el navegador. */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.hasUnsavedChanges()) e.preventDefault();
  }

  constructor() { this.cargar(); }

  cargar(): void {
    this.error.set(null);
    this.svc.settings().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (s) => { this.original.set({ ...s }); this.form.set({ ...s }); },
      error: (e) => this.error.set(e?.error?.message || 'No se pudieron cargar los parámetros'),
    });
  }

  /**
   * `YYYY-MM-DD` → `Date` **por partes locales**. `new Date('2026-08-01')` lo parsea como
   * medianoche UTC, que en México es el 31 de julio a las 18:00 y el calendario pinta el día
   * anterior (checklist 10: la TZ ya viene normalizada del backend, no se re-convierte).
   */
  fecha(s: string | null | undefined): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /** Y de vuelta, también por partes locales: `toISOString()` corre el día por el mismo motivo. */
  setFecha(d: Date | null): void {
    if (!d) return;
    const p = (n: number) => String(n).padStart(2, '0');
    this.set('reception_start', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  }

  set<K extends keyof ReceiptSettings>(k: K, v: ReceiptSettings[K]): void {
    const f = this.form();
    if (!f) return;
    this.form.set({ ...f, [k]: v });
    this.guardadoAt.set(null);
  }

  descartar(): void {
    const a = this.original();
    if (a) this.form.set({ ...a });
  }

  guardar(): void {
    const f = this.form();
    if (!f) return;
    this.saving.set(true);
    this.svc.saveSettings(f).subscribe({
      next: (s) => {
        this.saving.set(false);
        this.original.set({ ...s });
        this.form.set({ ...s });
        this.guardadoAt.set(Date.now());
        this.toast.add({
          severity: 'success',
          summary: 'Parámetros guardados',
          detail: 'La cobertura y los semáforos se recalculan con esto desde ahora.',
        });
      },
      error: (e) => {
        this.saving.set(false);
        // El server valida rangos: su mensaje dice exactamente qué campo y con qué límites.
        this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Revisá los valores' });
      },
    });
  }
}
