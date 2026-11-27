import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { PedidoPublico } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PedidoPublicoService } from '../pedido-publico.service';
import { diaDeEntrega } from '../pedido-etiqueta-impresion';

const PESOS = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * `[MCP.36]` **El pedido desde el QR de su etiqueta**, en el celular de quien sea (David, 2026-11-25, aprobado por
 * Edgar: «para todos sin excepciones», con montos): almacén, caja, vendedor, chofer o el cliente.
 *
 * Pública (sin guard, en `RUTAS_PUBLICAS`): la autoridad es la firma `k` de la liga, que el servidor revalida y que
 * vence. Lo que la persona viene a ver, en este orden: de quién es (cliente) → en qué paso va → qué lleva y cuánto.
 * Un monto que no llegó se pinta «—», nunca $0.00.
 */
@Component({
  selector: 'app-pedido-publico',
  standalone: true,
  imports: [LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="pp">
      <header class="pp-head">
        <span class="pp-marca">Mega Dulces</span>
        <span class="pp-sub">Pedido de preventa</span>
        <!-- El paso del pedido cambia en el día: se dice a qué hora se consultó (la hora de ESTE celular, no la del dato). -->
        @if (cargadoEn(); as t) { <app-freshness-pill measures="fetch" [since]="t" /> }
      </header>

      <app-load-state [loading]="cargando()" [error]="muerto()" errorTitle="Este pedido no se puede abrir" [skeletonRows]="5" (retry)="recargar()">
        @if (pedido(); as p) {
          <section class="pp-card pp-quien">
            <h1 class="pp-cli">{{ p.cliente || 'Cliente sin nombre' }}</h1>
            <p class="pp-folio">{{ p.folio }}</p>
            <p class="pp-paso" [class.pp-paso-ok]="p.paso.clave === 'revisado' || p.paso.clave === 'entregado'"
               [class.pp-paso-bad]="p.paso.clave === 'cancelado' || p.paso.clave === 'sin_mercancia'" role="status">{{ p.paso.texto }}</p>
            <dl class="pp-datos">
              <div><dt>Vendedor</dt><dd>{{ p.vendedor || 'Sin vendedor' }}</dd></div>
              @if (dia(p.entrega); as e) { <div><dt>Entrega</dt><dd>{{ e }}</dd></div> }
              @if (p.sucursal) { <div><dt>Sucursal</dt><dd>{{ p.sucursal }}</dd></div> }
            </dl>
          </section>

          <app-metric-strip [items]="resumen()" ariaLabel="Resumen del pedido" density="compact" />

          <section class="pp-card" aria-label="Productos del pedido">
            <h2 class="pp-h2">Productos</h2>
            @if (p.renglones.length) {
              <ul class="pp-lista">
                @for (r of p.renglones; track $index) {
                  <li>
                    <span class="pp-prod">{{ r.producto }}</span>
                    <span class="pp-cant">{{ r.cantidad }} {{ r.unidad || '' }} × {{ dinero(r.precio) }}</span>
                    <span class="pp-imp">{{ dinero(r.importe) }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="pp-hint">Este pedido no tiene productos.</p>
            }
            <dl class="pp-tot">
              <div><dt>Subtotal</dt><dd>{{ dinero(p.subtotal) }}</dd></div>
              @if (p.descuento) { <div><dt>Descuento</dt><dd>−{{ dinero(p.descuento) }}</dd></div> }
              <div><dt>Impuestos</dt><dd>{{ dinero(p.impuestos) }}</dd></div>
              <div class="pp-total"><dt>Total</dt><dd>{{ dinero(p.total) }}</dd></div>
            </dl>
          </section>

          @if (p.liga_vence) { <p class="pp-pie">Esta etiqueta abre el pedido hasta el {{ fecha(p.liga_vence) }}.</p> }
        }
      </app-load-state>
    </main>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; background: var(--surface-ground, var(--layout-bg)); color: var(--text-main); }
    .pp { max-width: 32rem; margin: 0 auto; padding: var(--sp-4) var(--sp-4) var(--sp-8); }
    .pp-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--sp-4); }
    .pp-marca { font-weight: 700; font-size: var(--fs-lg, 1.125rem); }
    .pp-sub { font-size: var(--fs-sm); color: var(--text-muted); }
    .pp-card { background: var(--surface-card); border: 1px solid var(--border-color); border-radius: var(--r-lg, 12px); padding: var(--sp-4); margin-bottom: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .pp-cli { margin: 0; font-size: var(--fs-xl, 1.25rem); font-weight: 700; line-height: 1.25; }
    .pp-folio { margin: 0; font-size: var(--fs-body); font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .pp-paso { margin: 0; align-self: flex-start; font-size: var(--fs-sm); font-weight: 700; padding: 4px 10px; border-radius: var(--r-pill, 999px); background: var(--surface-2); color: var(--text-main); }
    .pp-paso-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pp-paso-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .pp-datos, .pp-tot { margin: 0; display: flex; flex-direction: column; gap: var(--sp-1, 4px); }
    .pp-datos div, .pp-tot div { display: flex; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-sm); }
    .pp-datos dt, .pp-tot dt { color: var(--text-muted); }
    .pp-datos dd, .pp-tot dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .pp-h2 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-muted); }
    .pp-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .pp-lista li { display: grid; grid-template-columns: 1fr auto; gap: 2px var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .pp-prod { font-size: var(--fs-body); font-weight: 600; grid-column: 1 / -1; }
    .pp-cant { font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .pp-imp { font-size: var(--fs-sm); font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
    .pp-hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .pp-tot .pp-total { padding-top: var(--sp-2); border-top: 1px solid var(--border-color); font-size: var(--fs-body); font-weight: 700; }
    .pp-tot .pp-total dt { color: var(--text-main); }
    .pp-pie { margin-top: var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
  `],
})
export class PedidoPublicoComponent {
  private readonly svc = inject(PedidoPublicoService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly folio = this.route.snapshot.paramMap.get('folio') || '';
  private readonly k = this.route.snapshot.queryParamMap.get('k') || '';

  readonly cargando = signal(true);
  readonly muerto = signal<string | null>(null);
  readonly pedido = signal<PedidoPublico | null>(null);
  /** Cuándo se consultó (hora de este celular): lo dice la píldora de frescura. */
  readonly cargadoEn = signal<Date | null>(null);

  /** Lo que se viene a saber después de «de quién es»: cuánto y cuántos productos. Un total que no llegó, NO MEDIDO. */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const p = this.pedido();
    if (!p) return [];
    const total: MetricStripItem = typeof p.total === 'number'
      ? { label: 'Total', value: p.total, format: 'currency2' }
      : { label: 'Total', value: '—', format: 'text', state: 'no_medido', stateNote: 'El pedido no trae su total' };
    return [total, { label: 'Productos', value: p.renglones.length, format: 'number' }];
  });

  constructor() { this.cargar(); }

  recargar(): void { this.cargando.set(true); this.muerto.set(null); this.cargar(); }

  private cargar(): void {
    if (!this.folio || !this.k) {
      this.cargando.set(false);
      this.muerto.set('La liga está incompleta. Vuelve a escanear el código QR de la etiqueta.');
      return;
    }
    this.svc.pedido(this.folio, this.k).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => { this.pedido.set(p); this.cargadoEn.set(new Date()); this.cargando.set(false); },
      error: (e: { status?: number; error?: { message?: string } }) => {
        this.cargando.set(false);
        this.muerto.set(e?.status === 403 || e?.status === 404
          ? (e?.error?.message || 'Esta etiqueta ya no abre el pedido.')
          : 'No se pudo abrir el pedido. Revisa tu señal y vuelve a intentar.');
      },
    });
  }

  /** Un monto que no llegó se dice «—»: nunca $0.00. */
  dinero(v: number | null | undefined): string {
    return typeof v === 'number' && Number.isFinite(v) ? PESOS.format(v) : '—';
  }

  dia(v: string | null): string {
    return diaDeEntrega(v);
  }

  fecha(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', timeZone: 'America/Mexico_City' });
  }
}
