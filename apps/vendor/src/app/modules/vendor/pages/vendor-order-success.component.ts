import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorService } from '../vendor.service';

/**
 * Pedido confirmado — pantalla de éxito (rediseño Mercado). Recibe los datos por
 * queryParams para celebrar al instante (sin fetch): check dibujado + confetti +
 * háptico. CTA a la zona del pulgar: enviar ticket por WhatsApp + volver a la ruta.
 * Modos: `instante` (entregado, verde) / `futuro` (agendado, info).
 */
@Component({
  selector: 'app-vendor-order-success',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ok" [class.fut]="isFuturo()">
      <span class="confetti" *ngFor="let c of confetti" [style.left.%]="c.l" [style.background]="c.c" [style.animation-delay.s]="c.d"></span>

      <div class="ok-check">
        <svg viewBox="0 0 60 60" *ngIf="!isFuturo()"><path d="M16 31 L26 41 L44 20"/></svg>
        <i *ngIf="isFuturo()" class="pi pi-calendar-plus"></i>
      </div>

      <h2>{{ isFuturo() ? 'Pedido agendado' : 'Entregado' }}</h2>
      <div class="folio">{{ code() }}<ng-container *ngIf="name()"> · {{ name() }}</ng-container></div>
      <div class="amt">{{ fmtMoney(total()) }}</div>
      <div class="sub">{{ summary() }}</div>

      <div class="acts">
        <a *ngIf="wa()" class="wa" [href]="waLink()" target="_blank" rel="noopener">
          <i class="pi pi-whatsapp"></i> Enviar ticket por WhatsApp
        </a>
        <button class="ghost" (click)="goCaptureExhibit()"><i class="pi pi-camera"></i> Capturar exhibición</button>
        <button class="back" [disabled]="finishing()" (click)="finishVisit()">
          <i class="pi" [ngClass]="finishing() ? 'pi-spin pi-spinner' : 'pi-flag'"></i> Finalizar visita
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .ok {
        position: relative; margin: -1rem; min-height: calc(100dvh - 8rem);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        padding: 2rem 1.5rem 7rem; text-align: center; overflow: hidden; color: #fff;
        background: linear-gradient(170deg, #16A34A 0%, #0E7A37 100%);
      }
      .ok.fut { background: linear-gradient(170deg, #2563EB 0%, #1E40AF 100%); }

      .confetti { position: absolute; top: -40px; width: 9px; height: 14px; border-radius: 2px; opacity: 0.9; animation: fall 2.4s linear infinite; }
      @keyframes fall { 0% { transform: translateY(-40px) rotate(0); } 100% { transform: translateY(105vh) rotate(420deg); } }

      .ok-check { width: 6.5rem; height: 6.5rem; border-radius: 50%; background: rgba(255,255,255,0.16); display: grid; place-items: center; margin-bottom: 1.4rem; animation: pop 0.4s var(--ease-out, cubic-bezier(0.23,1,0.32,1)); }
      @keyframes pop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .ok-check svg { width: 3.4rem; height: 3.4rem; }
      .ok-check path { stroke: #fff; stroke-width: 7; fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 60; stroke-dashoffset: 60; animation: draw 0.5s 0.25s var(--ease, ease) forwards; }
      @keyframes draw { to { stroke-dashoffset: 0; } }
      .ok-check i { font-size: 3rem; }

      h2 { font-size: 1.6rem; font-weight: 800; letter-spacing: -0.02em; margin: 0; }
      .folio { font-family: var(--font-mono); font-size: 0.85rem; opacity: 0.9; margin-top: 0.35rem; }
      .amt { font-family: var(--font-mono); font-size: 2.2rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: 1.1rem 0 0.3rem; }
      .sub { font-size: 0.85rem; opacity: 0.92; max-width: 18rem; }

      .acts { position: fixed; left: 1rem; right: 1rem; bottom: calc(1.75rem + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 0.7rem; z-index: 5; }
      .acts .wa, .acts .back, .acts .ghost {
        height: 3.25rem; border-radius: var(--r-md, 12px); font-family: var(--font-body); font-weight: 700; font-size: 0.95rem;
        display: flex; align-items: center; justify-content: center; gap: 0.6rem; border: none; cursor: pointer; text-decoration: none;
        transition: transform 0.1s var(--ease-out, cubic-bezier(0.23,1,0.32,1));
      }
      .acts .wa:active, .acts .back:active, .acts .ghost:active { transform: scale(0.97); }
      .acts .wa { background: #fff; color: #0E7A37; }
      .ok.fut .acts .wa { color: #1E40AF; }
      .acts .ghost { background: rgba(255,255,255,0.12); color: #fff; border: 1px solid rgba(255,255,255,0.35); }
      .acts .back { background: rgba(255,255,255,0.22); color: #fff; }
      .acts .back:disabled { opacity: 0.7; }

      @media (prefers-reduced-motion: reduce) {
        .confetti { display: none; }
        .ok-check { animation: none; } .ok-check path { animation: none; stroke-dashoffset: 0; }
        .acts .wa, .acts .back, .acts .ghost { transition: none; }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorOrderSuccessComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly haptic = inject(HapticService);
  private readonly api = inject(VendorService);

  readonly mode = signal<'instante' | 'futuro'>('instante');
  readonly code = signal<string>('');
  readonly total = signal<number>(0);
  readonly units = signal<number>(0);
  readonly name = signal<string>('');
  readonly wa = signal<string>('');
  readonly date = signal<string>('');
  readonly customerId = signal<string>('');
  readonly finishing = signal(false);

  readonly confetti = [
    { l: 12, c: '#FDE707', d: 0 }, { l: 26, c: '#fff', d: 0.5 }, { l: 40, c: '#FDE707', d: 0.9 },
    { l: 55, c: '#fff', d: 0.2 }, { l: 68, c: '#FDE707', d: 1.1 }, { l: 82, c: '#fff', d: 0.7 },
    { l: 92, c: '#FDE707', d: 0.35 },
  ];

  isFuturo(): boolean {
    return this.mode() === 'futuro';
  }

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('mode') === 'futuro') this.mode.set('futuro');
    this.code.set(q.get('code') || '');
    this.total.set(Number(q.get('total')) || 0);
    this.units.set(Number(q.get('units')) || 0);
    this.name.set(q.get('name') || '');
    this.wa.set(q.get('wa') || '');
    this.date.set(q.get('date') || '');
    this.customerId.set(q.get('customer') || '');
    this.haptic.notification('success');
  }

  /** Capturar exhibición: foto del punto de venta (customer-driven). */
  goCaptureExhibit(): void {
    this.router.navigate(['/vendor/capture'], {
      queryParams: { customerId: this.customerId(), customerName: this.name() },
    });
  }

  /** Finalizar visita: el pedido ya se tomó (had_order), cierra y vuelve a la ruta. */
  finishVisit(): void {
    const id = this.customerId();
    if (!id) { this.goHome(); return; }
    this.finishing.set(true);
    this.api.finishVisit(id, { had_order: true }).subscribe({
      next: () => { this.finishing.set(false); this.goHome(); },
      error: () => { this.finishing.set(false); this.goHome(); },
    });
  }

  summary(): string {
    const u = this.units() ? `${this.units()} productos` : 'Pedido';
    if (this.isFuturo()) {
      const d = this.date()
        ? new Date(this.date() + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })
        : '';
      return `${u} · entrega ${d}`;
    }
    return `${u} · pago en efectivo · stock descontado`;
  }

  waLink(): string {
    const num = this.wa().replace(/[^0-9]/g, '');
    const txt = encodeURIComponent(
      `🧾 Pedido ${this.code()}\n${this.name()}\n${this.units()} productos · Total ${this.fmtMoney(this.total())}\n¡Gracias por tu compra! 🍬`,
    );
    return `https://wa.me/${num}?text=${txt}`;
  }

  goHome(): void {
    this.router.navigate(['/vendor/route-home']);
  }

  fmtMoney(n: unknown): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  }
}
