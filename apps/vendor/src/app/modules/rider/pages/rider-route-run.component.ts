import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { environment } from '../../../../environments/environment';
import { RiderRoute, RiderRouteStop, RiderService } from '../rider.service';
import { GeofenceService } from '../geofence.service';

type Phase = 'preview' | 'navigating' | 'delivering' | 'done' | 'arqueo' | 'arqueo_done';

const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

/**
 * Fase LM.11.3/11.4 — FLUJO GUIADO del repartidor ("Llevar pedidos").
 *
 * Secuencia: ver ruta en mapa → iniciar → navegar (Waze/GMaps) → al acercarse
 * al domicilio (geocerca ~40 m, o "Ya llegué") se habilita ENTREGAR → monto fijo
 * + cobro + firma del cliente → automáticamente la SIGUIENTE parada → … → al
 * terminar, ARQUEO CIEGO (cuenta sin ver lo esperado; se revela la diferencia).
 *
 * Mapa = imagen estática de Mapbox (patrón LM.10; no Leaflet en apps/vendor).
 * Navegación real = deep-link a Waze/Google Maps. La geocerca vive en el cliente.
 */
@Component({
  selector: 'app-rider-route-run',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="run">
      <!-- PREVIEW: mapa + secuencia + iniciar -->
      @if (phase() === 'preview') {
        <header class="run-head"><h1>Llevar pedidos</h1></header>
        @if (loading()) { <p class="muted">Cargando ruta…</p> }
        @else if (allStops().length === 0) {
          <div class="empty"><i class="pi pi-check-circle"></i><p>No tienes pedidos pendientes.</p></div>
        } @else {
          <div class="summary">
            <div><b>{{ allStops().length }}</b><span>paradas</span></div>
            <div><b>{{ money(totalToCollect()) }}</b><span>a cobrar</span></div>
            @if (route()?.total_km) { <div><b>{{ route()?.total_km }}</b><span>km aprox.</span></div> }
          </div>
          @if (mapUrl(); as url) { <img class="map" [src]="url" alt="Mapa de la ruta" /> }
          <ol class="stops">
            @for (s of allStops(); track s.delivery_id; let i = $index) {
              <li>
                <span class="seq" [class.off]="s.lat == null">{{ s.lat != null ? (s.sequence_order ?? i + 1) : '?' }}</span>
                <div class="info">
                  <div class="name">{{ s.customer_name }}</div>
                  <div class="addr">{{ s.street || 'Sin calle' }}</div>
                </div>
                @if (s.collect_on_delivery) { <span class="cod">{{ money(s.amount_to_collect) }}</span> }
                @else { <span class="paid">pagado</span> }
              </li>
            }
          </ol>
          <button class="primary big" (click)="start()">Iniciar ruta</button>
        }
      }

      <!-- NAVIGATING: parada actual + navegar + geocerca -->
      @if (phase() === 'navigating' && current(); as s) {
        <header class="run-head">
          <span class="progress">Parada {{ currentIndex() + 1 }} de {{ allStops().length }}</span>
        </header>
        @if (legMapUrl(); as url) { <img class="map" [src]="url" alt="Mapa de la parada" /> }
        <div class="stop-card">
          <div class="name lg">{{ s.customer_name }}</div>
          <div class="addr">{{ s.street || 'Sin calle' }}</div>
          @if (s.references) { <div class="ref">Ref: {{ s.references }}</div> }
          <div class="pay">
            @if (s.collect_on_delivery) { <span class="cod">Cobrar {{ money(s.amount_to_collect) }}</span> }
            @else { <span class="paid">Ya pagado</span> }
          </div>
        </div>

        @if (s.lat != null) {
          <div class="geo" [class.near]="canDeliver()">
            @if (geo.geoError()) { <span class="geo-err">{{ geo.geoError() }}</span> }
            @else if (geo.distanceM() == null) { <span>Buscando señal GPS…</span> }
            @else {
              <span>A <b>{{ geo.distanceM() }} m</b> del domicilio</span>
              @if (geo.accuracyM()) { <span class="acc">±{{ geo.accuracyM() }} m</span> }
            }
          </div>
          <div class="nav-btns">
            <a class="btn waze" [href]="wazeUrl(s)" target="_blank" rel="noopener">Waze</a>
            <a class="btn gmaps" [href]="gmapsUrl(s)" target="_blank" rel="noopener">Google Maps</a>
          </div>
        } @else {
          <div class="geo"><span>Sin ubicación en mapa — navega por dirección.</span></div>
          <a class="btn gmaps full" [href]="gmapsSearchUrl(s)" target="_blank" rel="noopener">Buscar en Maps</a>
        }

        <button class="primary big" [disabled]="!canDeliver()" (click)="openDeliver()">
          {{ canDeliver() ? 'Entregar pedido' : 'Acércate al domicilio…' }}
        </button>
        @if (s.lat != null && !geo.arrived() && !manualArrived()) {
          <button class="link" (click)="manualArrived.set(true)">Ya llegué (habilitar entrega)</button>
        }
      }

      <!-- DELIVERING: monto fijo + cobro + firma -->
      @if (phase() === 'delivering' && current(); as s) {
        <header class="run-head"><h1>Entregar</h1><span class="progress">{{ s.customer_name }}</span></header>
        @if (collect(s)) {
          <div class="collect-fixed"><span>Cobrar (fijo del ticket)</span><strong>{{ money(collectAmount(s)) }}</strong></div>
          <label>Método</label>
          <select [(ngModel)]="method">
            <option value="cash">Efectivo</option>
            <option value="transfer">Transferencia</option>
            <option value="card">Tarjeta (voucher)</option>
          </select>
          @if (method === 'cash') {
            <label>Efectivo recibido (para el cambio)</label>
            <input type="number" [(ngModel)]="cashReceived" min="0" step="0.01" />
            @if (change(s) != null) { <p class="change">Cambio: {{ money(change(s)) }}</p> }
          }
          @if (method === 'transfer' || method === 'card') {
            <label>Referencia / autorización</label>
            <input type="text" [(ngModel)]="reference" />
          }
        } @else {
          <div class="collect-fixed paid"><span>Ya pagado en tienda</span><strong>No se cobra</strong></div>
        }

        <label>Firma del cliente <span class="req">(obligatoria)</span></label>
        <canvas #sig class="sigpad"
                (pointerdown)="sigStart($event)" (pointermove)="sigMove($event)"
                (pointerup)="sigEnd()" (pointerleave)="sigEnd()"></canvas>
        <button type="button" class="link" (click)="clearSig()">Limpiar firma</button>

        @if (error()) { <p class="err">{{ error() }}</p> }
        <div class="row">
          <button class="ghost" (click)="cancelDeliver()" [disabled]="saving()">Atrás</button>
          <button class="primary" (click)="confirmDelivery()" [disabled]="saving()">
            {{ saving() ? 'Guardando…' : 'Confirmar entrega' }}
          </button>
        </div>
      }

      <!-- DONE -->
      @if (phase() === 'done') {
        <div class="empty"><i class="pi pi-flag"></i><h1>Ruta completada</h1><p>Entregaste todas tus paradas.</p></div>
        <button class="primary big" (click)="phase.set('arqueo')">Hacer corte del día (arqueo)</button>
      }

      <!-- ARQUEO CIEGO -->
      @if (phase() === 'arqueo') {
        <header class="run-head"><h1>Arqueo de caja</h1><span class="progress">Cuenta tu efectivo</span></header>
        <p class="muted">Ingresa cuántas piezas tienes de cada denominación. No verás lo esperado hasta cerrar.</p>
        <div class="denoms">
          @for (d of denoms; track d) {
            <div class="denom">
              <span class="d-label">{{ money(d) }}</span>
              <input type="number" min="0" step="1" [(ngModel)]="counts[d]" (ngModelChange)="recount()" />
            </div>
          }
        </div>
        <div class="arqueo-total"><span>Total contado</span><strong>{{ money(countedTotal()) }}</strong></div>
        @if (error()) { <p class="err">{{ error() }}</p> }
        <button class="primary big" (click)="closeBlind()" [disabled]="saving()">
          {{ saving() ? 'Cerrando…' : 'Cerrar caja' }}
        </button>
      }

      <!-- ARQUEO REVELADO -->
      @if (phase() === 'arqueo_done' && result(); as r) {
        <div class="reveal">
          <h1>Corte cerrado</h1>
          <div class="rev-row"><span>Esperado</span><b>{{ money(r.cash_expected) }}</b></div>
          <div class="rev-row"><span>Contaste</span><b>{{ money(r.cash_counted) }}</b></div>
          <div class="rev-row big" [class.ok]="diff(r) === 0" [class.bad]="diff(r) !== 0">
            <span>Diferencia</span><b>{{ money(diff(r)) }}</b>
          </div>
          <p class="muted">{{ diff(r) === 0 ? 'Cuadra perfecto.' : 'El encargado reconciliará la diferencia.' }}</p>
          <button class="primary big" (click)="finish()">Terminar</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .run { padding: 1rem; max-width: 640px; margin: 0 auto; padding-bottom: 5rem; }
    .run-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: .8rem; }
    .run-head h1 { font-size: 1.2rem; font-weight: 700; margin: 0; }
    .progress { font-size: .82rem; color: var(--text-muted, #888); }
    .muted { color: var(--text-muted, #888); font-size: .88rem; }
    .summary { display: flex; gap: .6rem; margin-bottom: .9rem; }
    .summary > div { flex: 1; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 12px; padding: .6rem; text-align: center; }
    .summary b { display: block; font-size: 1.25rem; font-variant-numeric: tabular-nums; }
    .summary span { font-size: .72rem; color: var(--text-muted, #888); }
    .map { width: 100%; border-radius: 14px; border: 1px solid var(--border-color, #e5e5e5); display: block; margin-bottom: 1rem; }
    .stops { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-direction: column; gap: .5rem; }
    .stops li { display: flex; align-items: center; gap: .7rem; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 12px; padding: .55rem .7rem; }
    .seq { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--action, #ea580c); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: .85rem; }
    .seq.off { background: var(--text-faint, #a8a29e); }
    .info { flex: 1; min-width: 0; }
    .name { font-weight: 600; font-size: .92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name.lg { font-size: 1.1rem; }
    .addr { font-size: .82rem; color: var(--text-muted, #777); }
    .ref { font-size: .78rem; color: var(--text-muted, #999); }
    .cod { color: #b45309; font-weight: 700; font-size: .82rem; }
    .paid { color: #16a34a; font-size: .82rem; }
    .stop-card { background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 14px; padding: .9rem; margin-bottom: .8rem; }
    .stop-card .pay { margin-top: .5rem; }
    .geo { text-align: center; padding: .7rem; border-radius: 12px; background: var(--layout-bg, #f5f5f4); margin-bottom: .7rem; font-size: .95rem; }
    .geo.near { background: #dcfce7; color: #166534; font-weight: 600; }
    .geo .acc { color: var(--text-muted, #999); font-size: .78rem; margin-left: .4rem; }
    .geo-err { color: #b45309; }
    .nav-btns { display: flex; gap: .5rem; margin-bottom: .8rem; }
    .btn { flex: 1; text-align: center; text-decoration: none; font-weight: 700; padding: .6rem; border-radius: 10px; font-size: .9rem; }
    .btn.full { display: block; margin-bottom: .8rem; }
    .btn.waze { background: #33ccff22; color: #0a7ea4; }
    .btn.gmaps { background: #4285f422; color: #1a73e8; }
    button { font: inherit; cursor: pointer; }
    .primary { background: var(--action, #ea580c); color: #fff; border: none; border-radius: 10px; padding: .7rem 1rem; font-weight: 700; }
    .primary.big { width: 100%; padding: .9rem; font-size: 1.05rem; position: sticky; bottom: 1rem; }
    .primary:disabled { opacity: .5; }
    .ghost { background: transparent; border: 1px solid var(--border-color, #ddd); border-radius: 10px; padding: .7rem 1rem; }
    .link { background: none; border: none; color: var(--action, #ea580c); text-decoration: underline; width: 100%; margin-top: .6rem; }
    .row { display: flex; gap: .6rem; margin-top: 1rem; }
    .row .primary, .row .ghost { flex: 1; }
    label { display: block; font-size: .82rem; margin: .7rem 0 .2rem; color: var(--text-muted, #666); }
    .req { color: #dc2626; }
    input, select { width: 100%; padding: .55rem; border: 1px solid var(--border-color, #ddd); border-radius: 8px; font: inherit; box-sizing: border-box; }
    .collect-fixed { display: flex; justify-content: space-between; align-items: center; background: var(--layout-bg, #f5f5f4); border: 1px solid var(--border-color, #e5e5e5); border-radius: 10px; padding: .7rem .9rem; }
    .collect-fixed strong { font-size: 1.15rem; }
    .collect-fixed.paid strong { color: #16a34a; font-size: .95rem; }
    .change { margin: .3rem 0 0; color: #16a34a; font-weight: 600; font-size: .9rem; }
    .sigpad { width: 100%; height: 170px; border: 1px dashed var(--border-color, #bbb); border-radius: 10px; background: #fff; touch-action: none; }
    .err { color: #dc2626; font-size: .88rem; }
    .empty { text-align: center; padding: 2rem 1rem; }
    .empty i { font-size: 2.4rem; color: var(--action, #ea580c); display: block; margin-bottom: .6rem; }
    .empty h1 { font-size: 1.3rem; margin: 0 0 .3rem; }
    .denoms { display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem; margin: .8rem 0; }
    .denom { display: flex; align-items: center; gap: .5rem; }
    .denom .d-label { width: 68px; font-variant-numeric: tabular-nums; font-weight: 600; }
    .arqueo-total { display: flex; justify-content: space-between; align-items: center; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 10px; padding: .7rem .9rem; margin-bottom: 1rem; }
    .arqueo-total strong { font-size: 1.3rem; font-variant-numeric: tabular-nums; }
    .reveal { text-align: center; padding: 1rem; }
    .reveal h1 { font-size: 1.4rem; }
    .rev-row { display: flex; justify-content: space-between; padding: .6rem 0; border-bottom: 1px solid var(--border-color, #eee); font-size: 1rem; }
    .rev-row.big { font-size: 1.2rem; border-bottom: none; margin-top: .3rem; }
    .rev-row.big.ok b { color: #16a34a; }
    .rev-row.big.bad b { color: #dc2626; }
  `],
})
export class RiderRouteRunComponent implements OnInit, OnDestroy {
  private readonly svc = inject(RiderService);
  private readonly router = inject(Router);
  readonly geo = inject(GeofenceService);

  @ViewChild('sig') sigRef?: ElementRef<HTMLCanvasElement>;

  readonly phase = signal<Phase>('preview');
  readonly route = signal<RiderRoute | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly currentIndex = signal(0);
  readonly manualArrived = signal(false);
  readonly result = signal<any>(null);

  readonly denoms = DENOMS;
  counts: Record<number, number> = {};
  readonly countedTotal = signal(0);

  method: 'cash' | 'transfer' | 'card' = 'cash';
  cashReceived: number | null = null;
  reference = '';
  private signed = false;
  private drawing = false;
  private lastX = 0; private lastY = 0;

  /** Todas las paradas pendientes en orden: ubicadas (secuencia) + sin ubicar al final. */
  readonly allStops = computed<RiderRouteStop[]>(() => {
    const r = this.route();
    if (!r) return [];
    return [...r.stops, ...r.unlocated];
  });
  readonly current = computed<RiderRouteStop | null>(() => this.allStops()[this.currentIndex()] ?? null);
  readonly totalToCollect = computed(() =>
    this.allStops().reduce((s, x) => s + (x.collect_on_delivery ? Number(x.amount_to_collect || 0) : 0), 0),
  );
  /** Habilita entregar: dentro del radio, override manual, o parada sin coords. */
  readonly canDeliver = computed(() => {
    const s = this.current();
    if (!s) return false;
    if (s.lat == null) return true;
    return this.geo.arrived() || this.manualArrived();
  });

  readonly mapUrl = computed(() => this.buildRouteMap(this.route()));
  readonly legMapUrl = computed(() => this.buildLegMap(this.current()));

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void { this.geo.stop(); }

  load(): void {
    this.loading.set(true);
    this.svc.myRoute().subscribe({
      next: (r) => { this.route.set(r); this.loading.set(false); },
      error: () => { this.route.set(null); this.loading.set(false); },
    });
  }

  start(): void {
    this.currentIndex.set(0);
    this.beginStop();
  }

  private beginStop(): void {
    this.manualArrived.set(false);
    const s = this.current();
    if (!s) { this.geo.stop(); this.phase.set('done'); return; }
    this.phase.set('navigating');
    if (s.lat != null && s.lng != null) this.geo.watch({ lat: s.lat, lng: s.lng });
    else this.geo.stop();
  }

  openDeliver(): void {
    this.error.set(null);
    this.method = 'cash';
    this.cashReceived = null;
    this.reference = '';
    this.signed = false;
    this.phase.set('delivering');
  }

  cancelDeliver(): void {
    this.phase.set('navigating');
  }

  confirmDelivery(): void {
    const s = this.current();
    if (!s) return;
    this.error.set(null);
    if (!this.signed) { this.error.set('Falta la firma del cliente.'); return; }
    const signature_url = this.sigRef?.nativeElement.toDataURL('image/png');
    const dto: any = { outcome: 'delivered', delivered_to: s.customer_name, signature_url };
    if (this.collect(s)) {
      dto.payment = { method: this.method, amount: this.collectAmount(s) };
      if (this.method === 'cash' && this.cashReceived != null) dto.payment.cash_received = Number(this.cashReceived);
      if ((this.method === 'transfer' || this.method === 'card') && this.reference) dto.payment.reference = this.reference;
    }
    this.saving.set(true);
    this.svc.recordDeliveryOutcome(s.delivery_id, dto).subscribe({
      next: () => { this.saving.set(false); this.advance(); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'No se pudo guardar.'); },
    });
  }

  private advance(): void {
    this.currentIndex.update((i) => i + 1);
    this.beginStop();
  }

  // ── Arqueo ciego ──
  recount(): void {
    let t = 0;
    for (const d of DENOMS) t += d * (Number(this.counts[d]) || 0);
    this.countedTotal.set(Math.round(t * 100) / 100);
  }

  closeBlind(): void {
    this.error.set(null);
    const breakdown: Record<string, number> = {};
    for (const d of DENOMS) { const c = Number(this.counts[d]) || 0; if (c > 0) breakdown[String(d)] = c; }
    this.saving.set(true);
    this.svc.blindCloseOwn(breakdown).subscribe({
      next: (r) => { this.saving.set(false); this.result.set(r); this.phase.set('arqueo_done'); },
      error: (e) => { this.saving.set(false); this.error.set(e?.error?.message || 'No se pudo cerrar el corte.'); },
    });
  }

  diff(r: any): number { return Math.round(Number(r.cash_difference || 0) * 100) / 100; }

  finish(): void { this.router.navigateByUrl('/rider/deliveries'); }

  // ── helpers ──
  collect(s: RiderRouteStop): boolean { return !!s.collect_on_delivery; }
  collectAmount(s: RiderRouteStop): number { return Number(s.amount_to_collect || 0); }
  change(s: RiderRouteStop): number | null {
    if (this.method !== 'cash' || this.cashReceived == null) return null;
    const d = Number(this.cashReceived) - this.collectAmount(s);
    return d >= 0 ? d : null;
  }
  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  wazeUrl(s: RiderRouteStop): string { return `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`; }
  gmapsUrl(s: RiderRouteStop): string { return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`; }
  gmapsSearchUrl(s: RiderRouteStop): string {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.street || s.customer_name || '')}`;
  }

  // ── firma canvas ──
  private ctx(): CanvasRenderingContext2D | null {
    const c = this.sigRef?.nativeElement;
    if (!c) return null;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) { c.width = c.clientWidth; c.height = c.clientHeight; }
    return c.getContext('2d');
  }
  sigStart(ev: PointerEvent): void {
    const g = this.ctx(); if (!g) return;
    this.drawing = true; this.signed = true; this.lastX = ev.offsetX; this.lastY = ev.offsetY;
    g.lineWidth = 2; g.lineCap = 'round'; g.strokeStyle = '#111';
  }
  sigMove(ev: PointerEvent): void {
    if (!this.drawing) return; const g = this.ctx(); if (!g) return;
    g.beginPath(); g.moveTo(this.lastX, this.lastY); g.lineTo(ev.offsetX, ev.offsetY); g.stroke();
    this.lastX = ev.offsetX; this.lastY = ev.offsetY;
  }
  sigEnd(): void { this.drawing = false; }
  clearSig(): void { const c = this.sigRef?.nativeElement, g = this.ctx(); if (c && g) g.clearRect(0, 0, c.width, c.height); this.signed = false; }

  // ── mapas estáticos Mapbox ──
  private buildRouteMap(r: RiderRoute | null): string | null {
    const token = environment.mapbox?.token;
    if (!token || !r?.stops?.length) return null;
    const ov: string[] = [];
    if (r.origin) ov.push(`pin-l-shop+2563eb(${r.origin.lng},${r.origin.lat})`);
    r.stops.slice(0, 20).forEach((s, i) => {
      if (s.lat != null && s.lng != null) ov.push(`pin-s-${s.sequence_order ?? i + 1}+f05a28(${s.lng},${s.lat})`);
    });
    if (!ov.length) return null;
    return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${ov.join(',')}/auto/640x360@2x?access_token=${token}`;
  }
  private buildLegMap(s: RiderRouteStop | null): string | null {
    const token = environment.mapbox?.token;
    if (!token || !s || s.lat == null || s.lng == null) return null;
    const pin = `pin-l-embassy+f05a28(${s.lng},${s.lat})`;
    return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${pin}/${s.lng},${s.lat},15,0/640x280@2x?access_token=${token}`;
  }
}
