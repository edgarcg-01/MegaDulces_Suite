import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { describeCart, parseCartCode, type CartRow, type WaveCartsResponse } from '@megadulces/contracts';
import { AlmacenCarretasService } from '../almacen-carretas.service';
import { UsoService } from '../../../core/services/uso.service';

/**
 * `[GP.11.5]` Surtir con carreta (FASE_GP paso 4, D7): en una ola de UN pedido, la carreta se escanea ANTES
 * del primer renglón. Es un paso de la pantalla, no una columna: mientras no haya carreta, los renglones no
 * aparecen (`listo` en false).
 *
 * Las cinco preguntas (skill `diseno` §0b), contestadas antes de escribir:
 *  1. Qué ve y en qué orden: «Escanea la carreta para el pedido …» y UN campo; ya tomada, su número grande,
 *     «Agregar otra» y «Deshacer». Después, los renglones (los pinta Surtir).
 *  2. Qué no ve: el catálogo de carretas ni las de otros pedidos; sólo si choca, de quién es la otra.
 *  3. Accesibilidad: foco al aparecer, teclado numérico, el Enter del escáner envía AQUÍ y no marca un
 *     renglón (UI.4), resultado en una región viva, botones de 44 px.
 *  4. Ligas: el checado (GP.13) escanea esta carreta; el embarque (E4) la libera; el Tablero la muestra.
 *  5. ¿Le toca? Sí: la toma quien surte, al empezar (D7). El alta del catálogo vive en Ubicaciones.
 *
 * Una TANDA (varios pedidos sumados) por ahora va sin carreta y se dice (Edgar, 2026-11-20, «tandas
 * después»): no se puede repartir en una carreta por pedido mientras se surte la suma.
 */
@Component({
  selector: 'app-surtir-carreta',
  standalone: true,
  imports: [FormsModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (estado(); as e) {
      @if (!e.catalogo) {
        <p class="sc-nota" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i>
          Este almacén todavía no tiene carretas dadas de alta: se surte sin carreta.</p>
      } @else if (e.tanda) {
        <p class="sc-nota" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i>
          Tanda de {{ e.pedidos }} pedidos: por ahora se surte sin carreta.</p>
      } @else {
        <section class="sc" [class.sc-pide]="!e.carretas.length" aria-labelledby="sc-t">
          @if (e.carretas.length) {
            <h2 class="sc-t" id="sc-t">Va en</h2>
            <ul class="sc-lista">
              @for (c of e.carretas; track c.id) {
                <li class="sc-chip">
                  <span class="sc-num">{{ nombre(c) }}</span>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary sc-tap" [disabled]="ocupado()"
                          [attr.aria-label]="'Deshacer ' + nombre(c)" (click)="deshacer(c)"><span class="p-button-label">Deshacer</span></button>
                </li>
              }
            </ul>
            @if (!agregando()) {
              <button pButton type="button" class="p-button-sm p-button-outlined sc-tap" (click)="abrirAgregar()"><span class="p-button-label">Agregar otra carreta</span></button>
            }
          } @else {
            <h2 class="sc-t" id="sc-t">Escanea la carreta para {{ pedido() }}</h2>
          }
          @if (!e.carretas.length || agregando()) {
            <form class="sc-form" (ngSubmit)="tomar()">
              <label class="sc-l" for="sc-in">Carreta o carrito</label>
              <input #campo id="sc-in" name="carreta" class="sc-in mono" inputmode="numeric" autocomplete="off" autocapitalize="characters"
                     [ngModel]="entrada()" (ngModelChange)="entrada.set($event)" (keydown.enter)="$event.stopPropagation()" placeholder="C07 o 7" />
              <button pButton type="submit" class="sc-tap" [loading]="ocupado()" [disabled]="!entrada().trim()"><span class="p-button-label">Tomar</span></button>
            </form>
          }
        </section>
      }
    } @else if (error(); as err) {
      <p class="sc-nota sc-mal" role="alert">{{ err }}
        <button pButton type="button" class="p-button-sm p-button-text sc-tap" (click)="cargar()"><span class="p-button-label">Reintentar</span></button></p>
    }
    <p class="sc-msg" [class.sc-mal]="aviso()?.mal" aria-live="polite">{{ aviso()?.texto ?? '' }}</p>
  `,
  styles: [`
    :host { display: block; }
    .sc { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .sc-pide { border-color: var(--action); }
    .sc-t { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .sc-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .sc-chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: 0 0 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .sc-num { font-size: var(--fs-lg); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .sc-form { display: flex; flex-wrap: wrap; align-items: end; gap: var(--sp-2); }
    .sc-l { width: 100%; font-size: var(--fs-xs); color: var(--text-muted); }
    .sc-in { flex: 1 1 8rem; min-height: 44px; font-size: var(--fs-lg); padding: 0 var(--sp-2); }
    .sc-tap { min-height: 44px; }
    .sc-nota { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .sc-msg { margin: 0; min-height: 1.4em; font-size: var(--fs-sm); }
    .sc-mal { color: var(--bad-soft-fg); }
  `],
})
export class SurtirCarretaComponent {
  private readonly api = inject(AlmacenCarretasService);
  private readonly uso = inject(UsoService);

  readonly warehouseId = input.required<string>();
  readonly waveId = input.required<string>();
  /** Cómo se lee el pedido de la ola, para el título («U-D-40 2840»). */
  readonly pedido = input<string>('este pedido');
  /** `true` cuando ya se puede surtir: hay carreta, o es una tanda (va sin carreta por ahora). */
  readonly listo = output<boolean>();

  readonly estado = signal<WaveCartsResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly entrada = signal('');
  readonly ocupado = signal(false);
  readonly agregando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  readonly esListo = computed(() => {
    const e = this.estado();
    return !!e && (!e.catalogo || e.tanda || e.carretas.length > 0);
  });
  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');
  private folio = 0;

  constructor() {
    // Otra ola: lo de la anterior no se cuela (sin esto, la ola nueva heredaría la carreta de la vieja).
    effect(() => {
      if (!this.waveId()) return;
      this.estado.set(null);
      this.agregando.set(false);
      this.aviso.set(null);
      void this.cargar();
    });
    effect(() => this.listo.emit(this.esListo()));
    // El campo toma el foco al aparecer: el surtidor escanea sin tocar la pantalla.
    effect(() => {
      const c = this.campo();
      if (c) queueMicrotask(() => c.nativeElement.focus());
    });
  }

  nombre(c: CartRow): string { return describeCart(c.tipo, c.numero); }

  async cargar(): Promise<void> {
    const folio = ++this.folio;
    this.error.set(null);
    try {
      const e = await firstValueFrom(this.api.forWave(this.waveId()));
      if (folio === this.folio) this.estado.set(e);
    } catch (e) {
      if (folio === this.folio) this.error.set(mensaje(e, 'No se pudo leer la carreta de esta ola.'));
    }
  }

  abrirAgregar(): void {
    this.agregando.set(true);
    this.aviso.set(null);
  }

  async tomar(): Promise<void> {
    if (this.ocupado()) return;
    const leida = parseCartCode(this.entrada());
    if (!leida.ok) { this.aviso.set({ texto: leida.motivo, mal: true }); return; }
    this.ocupado.set(true);
    try {
      const r = await firstValueFrom(this.api.occupy({ warehouse_id: this.warehouseId(), carreta: leida.code, pedido: { source: 'ola', wave_id: this.waveId() } }));
      this.entrada.set('');
      this.agregando.set(false);
      this.aviso.set({ texto: r.ya_estaba ? `${this.nombre(r.carreta)} ya era de este pedido.` : `${this.nombre(r.carreta)} tomada.`, mal: false });
      await this.cargar();
    } catch (e) {
      const texto = mensaje(e, 'No se pudo tomar la carreta.');
      this.aviso.set({ texto, mal: true });
      this.uso.reportarIncidente('carreta_rechazada', { status: Number((e as HttpErrorResponse)?.status ?? 0) || 0, motivo: texto.slice(0, 300), carreta: leida.code, wave_id: this.waveId() });
    } finally {
      this.ocupado.set(false);
    }
  }

  async deshacer(c: CartRow): Promise<void> {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    try {
      await firstValueFrom(this.api.undo(c.id));
      this.aviso.set({ texto: `${this.nombre(c)} quedó libre.`, mal: false });
      await this.cargar();
    } catch (e) {
      this.aviso.set({ texto: mensaje(e, 'No se pudo deshacer.'), mal: true });
    } finally {
      this.ocupado.set(false);
    }
  }
}

function mensaje(e: unknown, fallback: string): string {
  const m = (e as HttpErrorResponse)?.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
