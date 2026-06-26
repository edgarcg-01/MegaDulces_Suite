import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { trigger, transition, style, animate } from '@angular/animations';
import { forkJoin } from 'rxjs';
import { PortalService, Order, OrderHistoryEntry, OrderShipmentEntry } from '../portal.service';
import { cldImage } from '../../../core/util/cloudinary';
import { brandPlaceholderGradient } from '../../../core/util/brand-placeholder';
import { CountUpDirective } from '../ui/count-up.directive';

@Component({
  selector: 'app-portal-order-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CurrencyPipe,
    SkeletonModule,
    TagModule,
    ButtonModule,
    CountUpDirective,
  ],
  animations: [
    trigger('celebrateOverlay', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate('200ms ease-out', style({ opacity: 1 })),
      ]),
      transition(':leave', [
        animate('300ms ease-in', style({ opacity: 0 })),
      ]),
    ]),
  ],
  template: `
    <!-- Cierre celebratorio: solo al llegar recién confirmado desde el carrito -->
    <div
      *ngIf="celebrate()"
      class="od-celebrate"
      role="status"
      aria-live="polite"
      [@celebrateOverlay]
      (click)="celebrate.set(false)"
    >
      <div class="od-celebrate-card">
        <span class="od-celebrate-rings" aria-hidden="true"></span>
        <span class="od-celebrate-check" aria-hidden="true">
          <svg viewBox="0 0 52 52" width="56" height="56">
            <circle class="od-celebrate-circle" cx="26" cy="26" r="24" fill="none" />
            <path class="od-celebrate-tick" fill="none" d="M14 27 l8 8 l16 -18" />
          </svg>
        </span>
        <p class="od-celebrate-title">¡Pedido enviado!</p>
        <p class="od-celebrate-sub">Ya avisamos a Mega Dulces para aprobarlo.</p>
      </div>
    </div>

    <a routerLink="/portal/orders" class="od-back">
      <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a mis pedidos
    </a>

    <div *ngIf="loading()" class="od-skel" aria-hidden="true">
      <p-skeleton width="100%" height="96px" borderRadius="16px"></p-skeleton>
      <div class="od-skel-layout">
        <div class="od-skel-lines">
          <div class="od-skel-line" *ngFor="let i of [1, 2, 3]">
            <p-skeleton width="48px" height="48px" borderRadius="12px"></p-skeleton>
            <div class="od-skel-body">
              <p-skeleton width="35%" height="0.6rem"></p-skeleton>
              <p-skeleton width="70%" height="0.95rem"></p-skeleton>
            </div>
            <p-skeleton width="72px" height="1rem"></p-skeleton>
          </div>
        </div>
        <div class="od-skel-side">
          <p-skeleton width="50%" height="0.9rem"></p-skeleton>
          <p-skeleton width="100%" height="3.25rem" borderRadius="12px"></p-skeleton>
          <p-skeleton width="100%" height="3.25rem" borderRadius="12px"></p-skeleton>
        </div>
      </div>
    </div>

    <ng-container *ngIf="!loading() && order() as o">
      <!-- Page header consistente -->
      <header class="portal-page-head">
        <div class="portal-page-head-text">
          <span class="portal-eyebrow">
            <i class="pi pi-receipt" aria-hidden="true"></i>
            Pedido
          </span>
          <h1>{{ o.code }}</h1>
          <p class="portal-page-sub">Creado {{ fmtDate(o.created_at) }}</p>
        </div>
        <span class="portal-status-pill" [class]="'is-' + o.status">
          {{ statusLabel(o.status) }}
        </span>
      </header>

      <!-- Status hero (con mensaje contextual + total) -->
      <section class="od-hero" [class]="'od-hero-' + o.status">
        <div class="od-hero-icon">
          <i [class]="statusIcon(o.status)" aria-hidden="true"></i>
        </div>
        <div class="od-hero-body">
          <p
            class="od-hero-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >{{ statusMessage(o.status) }}</p>
          <div class="od-hero-meta">
            <span *ngIf="o.confirmed_at">
              <i class="pi pi-check" aria-hidden="true"></i> Confirmado {{ fmtDate(o.confirmed_at) }}
            </span>
            <span *ngIf="o.fulfilled_at">
              <i class="pi pi-truck" aria-hidden="true"></i> Entregado {{ fmtDate(o.fulfilled_at) }}
            </span>
            <span *ngIf="o.cancelled_at">
              <i class="pi pi-times" aria-hidden="true"></i> Cancelado {{ fmtDate(o.cancelled_at) }}
            </span>
          </div>
        </div>
        <div class="od-hero-total">
          <span class="od-hero-total-label">Total</span>
          <b [countUp]="+(o.total || 0)"></b>
        </div>
      </section>

      <!-- Repetir pedido (1 tap → clona líneas al carrito) -->
      <div class="od-actions" *ngIf="o.status !== 'draft' && (o.lines || []).length > 0">
        <button
          type="button"
          class="portal-btn-primary od-reorder-btn"
          [disabled]="reordering()"
          (click)="reorder(o)"
        >
          <i [class]="reordering() ? 'pi pi-spin pi-spinner' : 'pi pi-replay'" aria-hidden="true"></i>
          {{ reordering() ? 'Agregando al carrito…' : 'Repetir pedido' }}
        </button>
        <span class="od-actions-hint">
          Agrega los {{ (o.lines || []).length }} producto(s) de este pedido a tu carrito.
        </span>
      </div>
      <p *ngIf="reorderError()" class="od-actions-error" role="alert">
        <i class="pi pi-exclamation-circle" aria-hidden="true"></i> {{ reorderError() }}
      </p>

      <div class="od-layout">
        <!-- Lines -->
        <section class="od-lines-section" aria-label="Líneas del pedido">
          <header class="od-section-head">
            <h2><i class="pi pi-list"></i> Líneas del pedido</h2>
            <span class="od-section-count">
              {{ (o.lines || []).length }} producto(s)
            </span>
          </header>

          <div class="od-lines">
            <article *ngFor="let l of o.lines || []; trackBy: trackByLine" class="od-line">
              <div
                class="od-line-avatar"
                [class.has-photo]="lineImg(l)"
                [style.background]="lineImg(l) ? null : linePh(l)"
              >
                <img *ngIf="lineImg(l) as src" [src]="src" [alt]="l.product_name || ''" loading="lazy" decoding="async" />
                <span *ngIf="!lineImg(l)" class="od-line-mono" aria-hidden="true">{{ lineInitials(l) }}</span>
              </div>

              <div class="od-line-body">
                <span class="od-line-brand" *ngIf="l.brand_name">{{ l.brand_name }}</span>
                <span class="od-line-name">{{ l.product_name || shortId(l.product_id) }}</span>
                <div class="od-line-meta">
                  <span class="od-meta-item">
                    <i class="pi pi-shopping-cart"></i>
                    {{ l.quantity }} unid.
                  </span>
                  <span class="od-meta-item">
                    {{ +l.unit_price | currency:'MXN':'symbol-narrow':'1.2-2' }}/u
                  </span>
                </div>
              </div>

              <div class="od-line-total">
                <span class="od-line-label">Total</span>
                <b>{{ +l.line_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
              </div>
            </article>

            <p *ngIf="(o.lines || []).length === 0" class="od-empty-lines">
              Este pedido no tiene líneas.
            </p>
          </div>

          <!-- Totals box -->
          <div class="od-totals">
            <div class="od-totals-row">
              <span>Subtotal</span>
              <b>{{ +o.subtotal | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
            <div class="od-totals-row">
              <span>IVA</span>
              <b>{{ +o.tax_total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
            <div class="od-totals-row od-totals-grand">
              <span>Total</span>
              <b>{{ +o.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
            <div class="od-totals-row od-totals-due" *ngIf="+o.balance_due > 0">
              <span><i class="pi pi-exclamation-circle"></i> Saldo pendiente</span>
              <b>{{ +o.balance_due | currency:'MXN':'symbol-narrow':'1.2-2' }}</b>
            </div>
          </div>
        </section>

        <!-- Tracking de embarques (J.10) -->
        <section class="od-tracking-section" *ngIf="shipments().length > 0" aria-label="Rastreo de entrega">
          <header class="od-section-head">
            <h2><i class="pi pi-truck"></i> Rastreo</h2>
          </header>

          <div class="od-shipments">
            <article *ngFor="let s of shipments()" class="od-shipment" [class]="'is-' + s.status">
              <div class="od-ship-head">
                <code class="od-ship-folio">{{ s.folio }}</code>
                <span class="od-ship-badge" [class]="'is-' + s.status">
                  <i [class]="shipStatusIcon(s.status)" aria-hidden="true"></i>
                  {{ shipStatusLabel(s.status) }}
                </span>
              </div>
              <div class="od-ship-meta">
                <span *ngIf="s.route_name">
                  <i class="pi pi-map" aria-hidden="true"></i> {{ s.route_name }}
                </span>
                <span *ngIf="s.vehicle_plate">
                  <i class="pi pi-car" aria-hidden="true"></i> {{ s.vehicle_plate }}
                </span>
                <span *ngIf="!s.route_name && !s.vehicle_plate && s.destination">
                  <i class="pi pi-flag" aria-hidden="true"></i> {{ s.destination }}
                </span>
              </div>
              <div class="od-ship-stamps">
                <span *ngIf="s.departure_at">
                  <i class="pi pi-send" aria-hidden="true"></i> Salió {{ fmtDateTime(s.departure_at) }}
                </span>
                <span *ngIf="s.arrival_at">
                  <i class="pi pi-check-circle" aria-hidden="true"></i> Entregado {{ fmtDateTime(s.arrival_at) }}
                </span>
                <span *ngIf="!s.departure_at && !s.arrival_at">
                  <i class="pi pi-calendar" aria-hidden="true"></i> Programado {{ fmtDate(s.shipment_date) }}
                </span>
              </div>
            </article>
          </div>
        </section>

        <!-- Timeline -->
        <aside class="od-timeline-section" aria-label="Historial del pedido">
          <header class="od-section-head">
            <h2><i class="pi pi-history"></i> Historial</h2>
          </header>

          <ol class="od-timeline">
            <li *ngFor="let h of history()" class="od-tl-item">
              <div class="od-tl-dot" [class]="'od-tl-dot-' + h.to_status">
                <i [class]="statusIcon(h.to_status)"></i>
              </div>
              <div class="od-tl-content">
                <div class="od-tl-transition">
                  <span class="od-tl-from" *ngIf="h.from_status">
                    {{ statusLabel(h.from_status) }}
                  </span>
                  <span class="od-tl-from od-tl-from-init" *ngIf="!h.from_status">
                    Inicio
                  </span>
                  <i class="pi pi-arrow-right"></i>
                  <span class="od-tl-to">{{ statusLabel(h.to_status) }}</span>
                </div>
                <div class="od-tl-by">
                  <i class="pi pi-user"></i>
                  {{ h.changed_by_username || 'sistema' }}
                  <span class="od-tl-sep">·</span>
                  {{ fmtDateTime(h.changed_at) }}
                </div>
                <p class="od-tl-reason" *ngIf="h.reason">{{ h.reason }}</p>
              </div>
            </li>
            <li *ngIf="history().length === 0" class="od-tl-empty">
              <i class="pi pi-info-circle"></i>
              Sin historial registrado.
            </li>
          </ol>
        </aside>
      </div>
    </ng-container>
  `,
  styles: [
    `
      :host { display: block; }

      /* ── Cierre celebratorio (recién confirmado) ── */
      .od-celebrate {
        position: fixed;
        inset: 0;
        z-index: 1200;
        display: grid;
        place-items: center;
        background: rgba(16, 13, 9, 0.55);
        backdrop-filter: blur(3px);
        cursor: pointer;
      }
      .od-celebrate-card {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        padding: 2.25rem 2.5rem;
        background: var(--card-bg);
        border-radius: var(--r-xl);
        box-shadow: 0 24px 60px -16px rgba(0, 0, 0, 0.4);
        animation: odCelebrateIn 460ms cubic-bezier(0.34, 1.4, 0.5, 1) both;
        overflow: hidden;
        text-align: center;
      }
      @keyframes odCelebrateIn {
        from { opacity: 0; transform: scale(0.82) translateY(12px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }
      .od-celebrate-rings {
        position: absolute;
        top: 2.9rem;
        width: 64px;
        height: 64px;
        border-radius: var(--r-pill);
        background: var(--ember-soft);
        animation: odRing 1100ms ease-out 220ms both;
        pointer-events: none;
      }
      @keyframes odRing {
        0%   { transform: scale(0.6); opacity: 0.9; }
        100% { transform: scale(2.6); opacity: 0; }
      }
      .od-celebrate-check {
        position: relative;
        display: grid;
        place-items: center;
        width: 64px;
        height: 64px;
      }
      .od-celebrate-circle {
        stroke: var(--action);
        stroke-width: 3;
        stroke-dasharray: 151;
        stroke-dashoffset: 151;
        animation: odDraw 520ms ease-out 120ms forwards;
      }
      .od-celebrate-tick {
        stroke: var(--action);
        stroke-width: 4;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-dasharray: 44;
        stroke-dashoffset: 44;
        animation: odDraw 320ms ease-out 520ms forwards;
      }
      @keyframes odDraw { to { stroke-dashoffset: 0; } }
      .od-celebrate-title {
        margin: 0.5rem 0 0;
        font-family: var(--font-display);
        font-size: var(--fs-h2);
        font-weight: 700;
        color: var(--text-main);
      }
      .od-celebrate-sub {
        margin: 0;
        font-size: var(--fs-sm);
        color: var(--text-muted);
        max-width: 22ch;
      }
      @media (prefers-reduced-motion: reduce) {
        .od-celebrate-card,
        .od-celebrate-rings,
        .od-celebrate-circle,
        .od-celebrate-tick { animation: none; }
        .od-celebrate-circle, .od-celebrate-tick { stroke-dashoffset: 0; }
      }

      .od-back {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        margin-bottom: 1rem;
        color: var(--text-muted);
        text-decoration: none;
        font-size: var(--fs-sm);
        font-weight: 600;
        padding: 0.375rem 0.625rem;
        border-radius: var(--r-sm);
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .od-back:hover { background: var(--neutral-100); color: var(--text-main); }
      .od-back i { font-size: var(--fs-xs); }

      /* ── HERO (mensaje contextual + total) ─────────────────────── */
      .od-hero {
        display: grid;
        grid-template-columns: 64px 1fr auto;
        gap: 1.25rem;
        align-items: center;
        padding: 1.25rem 1.5rem;
        border-radius: var(--r-lg);
        margin-bottom: 1.5rem;
        color: var(--text-main);
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-left-width: 4px;
        position: relative;
      }
      @media (max-width: 640px) {
        .od-hero {
          grid-template-columns: 56px 1fr;
          grid-template-areas:
            "icon body"
            "total total";
          gap: 1rem;
        }
        .od-hero-icon { grid-area: icon; }
        .od-hero-body { grid-area: body; }
        .od-hero-total {
          grid-area: total;
          padding-top: 1rem;
          border-top: 1px solid var(--border-color);
          flex-direction: row !important;
          align-items: center !important;
          justify-content: space-between !important;
          text-align: left !important;
        }
      }

      .od-hero-draft { border-left-color: var(--warn-fg); }
      .od-hero-confirmed { border-left-color: var(--info-fg); }
      .od-hero-fulfilled { border-left-color: var(--ok-fg); }
      .od-hero-cancelled { border-left-color: var(--bad-fg); }

      .od-hero-icon {
        width: 64px;
        height: 64px;
        border-radius: var(--r-lg);
        background: var(--neutral-100);
        color: var(--text-main);
        display: grid;
        place-items: center;
        font-size: var(--fs-h1);
        position: relative;
      }
      .od-hero-draft .od-hero-icon { color: var(--warn-fg); }
      .od-hero-confirmed .od-hero-icon { color: var(--info-fg); }
      .od-hero-fulfilled .od-hero-icon { color: var(--ok-fg); }
      .od-hero-cancelled .od-hero-icon { color: var(--bad-fg); }
      @media (max-width: 640px) {
        .od-hero-icon { width: 56px; height: 56px; font-size: var(--fs-h2); }
      }

      .od-hero-body { position: relative; min-width: 0; }
      .od-hero-status {
        margin: 0 0 0.5rem;
        font-size: var(--fs-body);
        color: var(--text-muted);
        line-height: 1.45;
      }
      .od-hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.875rem;
        font-size: var(--fs-xs);
        color: var(--text-faint);
      }
      .od-hero-meta i { margin-right: 0.25rem; }

      .od-hero-total {
        text-align: right;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .od-hero-total-label {
        font-size: var(--fs-micro);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-faint);
      }
      .od-hero-total b {
        font-size: var(--fs-h1);
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.015em;
        color: var(--text-main);
      }

      /* ── ACTIONS (repetir pedido) ──────────────────────────────── */
      .od-actions {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
      }
      .od-reorder-btn { flex-shrink: 0; }
      .od-actions-hint {
        font-size: var(--fs-sm);
        color: var(--text-muted);
        line-height: 1.4;
      }
      .od-actions-error {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin: -0.75rem 0 1.25rem;
        padding: 0.625rem 0.875rem;
        background: var(--bad-soft-bg);
        color: var(--bad-soft-fg);
        border: 1px solid var(--bad-border);
        border-radius: var(--r-md);
        font-size: var(--fs-sm);
        font-weight: 600;
      }

      /* ── LAYOUT ────────────────────────────────────────────────── */
      .od-layout {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: 1.25rem;
        align-items: start;
      }
      @media (max-width: 900px) {
        .od-layout { grid-template-columns: 1fr; }
      }

      .od-section-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.875rem;
      }
      .od-section-head h2 {
        margin: 0;
        font-size: var(--fs-h3);
        font-weight: 700;
        color: var(--text-main);
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }
      .od-section-head h2 i {
        color: var(--text-muted);
        font-size: var(--fs-h3);
      }
      .od-section-count {
        font-size: var(--fs-sm);
        color: var(--text-muted);
      }

      /* ── LINES ─────────────────────────────────────────────────── */
      .od-lines {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      .od-line {
        display: grid;
        grid-template-columns: 48px 1fr auto;
        gap: 0.875rem;
        align-items: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-md);
        padding: 0.75rem 0.875rem;
      }
      .od-line-avatar {
        position: relative;
        width: 48px;
        height: 48px;
        border-radius: var(--r-md);
        overflow: hidden;
        display: grid;
        place-items: center;
        flex-shrink: 0;
      }
      .od-line-avatar.has-photo { background: #fff; border: 1px solid var(--border-color); }
      .od-line-avatar img { width: 100%; height: 100%; object-fit: contain; padding: 5px; }
      .od-line-mono {
        font-family: var(--font-display);
        font-weight: 700;
        font-size: var(--fs-h3);
        color: #fff;
        letter-spacing: -0.01em;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      }
      .od-line-body {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
      }
      .od-line-label {
        font-size: var(--fs-nano);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--text-faint);
      }
      .od-line-brand {
        font-size: var(--fs-nano);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .od-line-name {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--text-main);
        line-height: 1.25;
      }
      .od-line-meta {
        display: flex;
        gap: 0.75rem;
        font-size: var(--fs-xs);
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .od-meta-item { display: inline-flex; align-items: center; gap: 0.25rem; }
      .od-line-total {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.125rem;
        min-width: 92px;
      }
      .od-line-total b {
        font-size: var(--fs-body);
        font-weight: 800;
        color: var(--text-main);
        font-variant-numeric: tabular-nums;
      }
      .od-empty-lines {
        text-align: center;
        padding: 1.5rem;
        color: var(--text-muted);
        margin: 0;
      }

      /* ── TOTALS BOX ───────────────────────────────────────────── */
      .od-totals {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-md);
        padding: 1rem 1.125rem;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .od-totals-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: var(--fs-body);
      }
      .od-totals-row span { color: var(--text-muted); }
      .od-totals-row b {
        color: var(--text-main);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .od-totals-grand {
        margin-top: 0.5rem;
        padding-top: 0.75rem;
        border-top: 2px solid var(--border-color);
        position: relative;
      }
      .od-totals-grand::before {
        content: '';
        position: absolute;
        top: -2px;
        left: 0;
        width: 32px;
        height: 2px;
        background: var(--neutral-400);
      }
      .od-totals-grand span {
        color: var(--text-muted);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: var(--fs-xs);
      }
      .od-totals-grand b {
        font-size: var(--fs-h2);
        font-weight: 800;
        color: var(--text-main);
        letter-spacing: -0.01em;
      }
      .od-totals-due {
        color: var(--bad-fg);
        background: var(--bad-soft-bg);
        margin-top: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-radius: var(--r-sm);
      }
      .od-totals-due span,
      .od-totals-due b {
        color: var(--bad-soft-fg);
      }

      /* ── TRACKING (J.10) ──────────────────────────────────────── */
      .od-tracking-section {
        grid-column: 1 / -1;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 1rem 1.125rem 1.125rem;
        margin-bottom: 1rem;
      }
      .od-shipments {
        display: grid;
        gap: 0.625rem;
      }
      .od-shipment {
        display: grid;
        gap: 0.375rem;
        padding: 0.75rem 0.875rem;
        background: var(--neutral-50, var(--card-bg));
        border: 1px solid var(--border-color);
        border-radius: var(--r-md);
      }
      .od-shipment.is-en_ruta { border-color: var(--info-fg); background: var(--info-soft-bg); }
      .od-shipment.is-entregado,
      .od-shipment.is-cerrado { border-color: var(--ok-fg); background: var(--ok-soft-bg); }
      .od-shipment.is-cancelado { border-color: var(--bad-fg); background: var(--bad-soft-bg); opacity: 0.85; }

      .od-ship-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.5rem;
      }
      .od-ship-folio {
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--text-main);
        letter-spacing: 0.02em;
      }
      .od-ship-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.25rem 0.625rem;
        border-radius: var(--r-pill);
        font-size: var(--fs-xs);
        font-weight: 700;
        background: var(--neutral-100);
        color: var(--text-main);
      }
      .od-ship-badge.is-en_ruta { background: var(--info-fg); color: var(--info-soft-bg); }
      .od-ship-badge.is-entregado,
      .od-ship-badge.is-cerrado { background: var(--ok-fg); color: var(--ok-soft-bg); }
      .od-ship-badge.is-cancelado { background: var(--bad-fg); color: var(--bad-soft-bg); }

      .od-ship-meta,
      .od-ship-stamps {
        display: flex;
        flex-wrap: wrap;
        gap: 0.875rem;
        font-size: var(--fs-sm);
        color: var(--text-muted);
      }
      .od-ship-meta i,
      .od-ship-stamps i {
        margin-right: 0.25rem;
        font-size: var(--fs-xs);
      }

      /* ── TIMELINE ─────────────────────────────────────────────── */
      .od-timeline-section {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 1rem 1.125rem 1.125rem;
      }

      .od-timeline {
        list-style: none;
        padding: 0;
        margin: 0;
        position: relative;
      }
      .od-timeline::before {
        content: '';
        position: absolute;
        left: 15px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        background: var(--border-color);
        z-index: 0;
      }

      .od-tl-item {
        display: grid;
        grid-template-columns: 32px 1fr;
        gap: 0.625rem;
        padding: 0.625rem 0;
        position: relative;
      }

      .od-tl-dot {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        font-size: var(--fs-xs);
        color: #fff;
        z-index: 1;
        flex-shrink: 0;
        box-shadow: 0 0 0 4px var(--card-bg);
      }
      .od-tl-dot-draft { background: var(--warn-fg); }
      .od-tl-dot-confirmed { background: var(--info-fg); }
      .od-tl-dot-fulfilled { background: var(--ok-fg); }
      .od-tl-dot-cancelled { background: var(--bad-fg); }

      .od-tl-content { min-width: 0; }
      .od-tl-transition {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: var(--fs-sm);
        font-weight: 700;
        color: var(--text-main);
        flex-wrap: wrap;
      }
      .od-tl-transition i {
        font-size: var(--fs-nano);
        color: var(--text-faint);
      }
      .od-tl-from {
        color: var(--text-muted);
        font-weight: 500;
      }
      .od-tl-from-init {
        font-style: italic;
        opacity: 0.7;
      }
      .od-tl-by {
        font-size: var(--fs-micro);
        color: var(--text-muted);
        margin-top: 0.25rem;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        flex-wrap: wrap;
      }
      .od-tl-by i { font-size: var(--fs-nano); }
      .od-tl-sep { opacity: 0.5; }
      .od-tl-reason {
        font-size: var(--fs-xs);
        margin: 0.375rem 0 0;
        padding: 0.375rem 0.625rem;
        background: var(--surface-ground);
        border-left: 3px solid var(--neutral-300);
        border-radius: 4px;
        color: var(--text-main);
        font-style: italic;
        line-height: 1.4;
      }
      .od-tl-empty {
        color: var(--text-muted);
        font-size: var(--fs-body);
        text-align: center;
        padding: 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.375rem;
      }

      /* ── Skeleton con forma (hero + líneas + side) ── */
      .od-skel { display: flex; flex-direction: column; gap: 1.5rem; }
      .od-skel-layout {
        display: grid;
        grid-template-columns: 1.6fr 1fr;
        gap: 1.25rem;
        align-items: start;
      }
      @media (max-width: 900px) { .od-skel-layout { grid-template-columns: 1fr; } }
      .od-skel-lines { display: flex; flex-direction: column; gap: 0.5rem; }
      .od-skel-line {
        display: grid;
        grid-template-columns: 48px 1fr auto;
        gap: 0.875rem;
        align-items: center;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-md);
        padding: 0.75rem 0.875rem;
      }
      .od-skel-body { display: flex; flex-direction: column; gap: 0.45rem; min-width: 0; }
      .od-skel-side {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--r-lg);
        padding: 1.125rem;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalOrderDetailComponent implements OnInit {
  private readonly api = inject(PortalService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);

  readonly loading = signal(true);
  readonly order = signal<Order | null>(null);
  readonly history = signal<OrderHistoryEntry[]>([]);
  readonly shipments = signal<OrderShipmentEntry[]>([]);
  readonly reordering = signal(false);
  readonly reorderError = signal<string | null>(null);
  readonly celebrate = signal(false);

  /** Capturado en construcción: navegar borra `history.state` después. */
  private readonly justConfirmed =
    !!this.router.getCurrentNavigation()?.extras.state?.['justConfirmed'];

  reorder(o: Order): void {
    if (this.reordering()) return;
    this.reordering.set(true);
    this.reorderError.set(null);
    this.api.reorder(o).subscribe({
      next: ({ added }) => {
        this.reordering.set(false);
        if (added === 0) {
          this.reorderError.set(
            'Ningún producto de este pedido está disponible para reordenar.',
          );
          return;
        }
        this.router.navigate(['/portal/cart']);
      },
      error: () => {
        this.reordering.set(false);
        this.reorderError.set('No pudimos repetir el pedido. Intenta de nuevo.');
      },
    });
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    forkJoin({
      order: this.api.orderById(id),
      history: this.api.orderHistory(id),
      shipments: this.api.orderShipments(id),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ order, history, shipments }) => {
          this.order.set(order);
          this.history.set(history);
          this.shipments.set(shipments);
          this.loading.set(false);
          this.revealContent();
          if (this.justConfirmed) {
            this.celebrate.set(true);
            setTimeout(() => this.celebrate.set(false), 3000);
          }
        },
        error: () => this.loading.set(false),
      });
  }

  trackByLine = (_i: number, l: any) => l.id;

  shortId(id: string): string {
    return id?.slice(0, 8) || '—';
  }

  /** Thumbnail Cloudinary si la línea trae imagen (futuro backend), sino null. */
  lineImg(line: any): string | null {
    return line?.image_url ? cldImage(line.image_url, 120) : null;
  }
  /** Placeholder Stone canónico (mismo que las cards/carrito). */
  linePh(line: any): string {
    return brandPlaceholderGradient(line?.product_id || line?.product_name);
  }
  lineInitials(line: any): string {
    const words = (line?.product_name || '?').trim().split(/\s+/).slice(0, 2);
    return words.map((w: string) => w.charAt(0).toUpperCase()).join('') || '?';
  }

  statusLabel(s: string | null | undefined): string {
    const m: Record<string, string> = {
      draft: 'Borrador',
      pending_approval: 'Esperando confirmación',
      confirmed: 'Confirmado',
      fulfilled: 'Entregado',
      cancelled: 'Cancelado',
    };
    return s ? (m[s] || s) : '—';
  }

  statusIcon(s: string): string {
    const m: Record<string, string> = {
      draft: 'pi pi-pencil',
      pending_approval: 'pi pi-hourglass',
      confirmed: 'pi pi-check',
      fulfilled: 'pi pi-truck',
      cancelled: 'pi pi-times',
    };
    return m[s] || 'pi pi-circle';
  }

  shipStatusLabel(s: string): string {
    const m: Record<string, string> = {
      programado: 'Programado',
      checklist_salida: 'Inspección de salida',
      en_ruta: 'En ruta',
      entregado: 'Entregado',
      checklist_llegada: 'Inspección de llegada',
      costos_pendientes: 'Cierre administrativo',
      cerrado: 'Cerrado',
      cancelado: 'Cancelado',
    };
    return m[s] || s;
  }

  shipStatusIcon(s: string): string {
    const m: Record<string, string> = {
      programado: 'pi pi-calendar',
      checklist_salida: 'pi pi-list-check',
      en_ruta: 'pi pi-send',
      entregado: 'pi pi-check-circle',
      checklist_llegada: 'pi pi-list-check',
      costos_pendientes: 'pi pi-receipt',
      cerrado: 'pi pi-flag-fill',
      cancelado: 'pi pi-times',
    };
    return m[s] || 'pi pi-truck';
  }

  statusMessage(s: string): string {
    const m: Record<string, string> = {
      draft: 'Tu pedido está en borrador, todavía no fue enviado.',
      pending_approval: 'Espera a que tu pedido sea confirmado por Mega Dulces. Te avisamos cuando esté aprobado.',
      confirmed: 'Tu pedido fue aprobado y estamos preparándolo.',
      fulfilled: 'Tu pedido fue entregado.',
      cancelled: 'Este pedido fue cancelado.',
    };
    return m[s] || s;
  }

  fmtDate(s: string): string {
    return new Date(s).toLocaleDateString('es-MX', { dateStyle: 'medium' } as any);
  }
  fmtDateTime(s: string): string {
    return new Date(s).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' } as any);
  }

  // ── Reveal GSAP del contenido al cargar ────────────────────────
  private G: any = null;
  private gsapLoading?: Promise<any>;

  private ensureGsap(): Promise<any> {
    if (this.G) return Promise.resolve(this.G);
    if (this.gsapLoading) return this.gsapLoading;
    this.gsapLoading = import('gsap').then((m: any) => (this.G = m.gsap || m.default));
    return this.gsapLoading;
  }

  /** Entrada escalonada de líneas + items del timeline. Reduced-motion: no-op. */
  private revealContent(): void {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.zone.runOutsideAngular(() =>
      requestAnimationFrame(async () => {
        const el = this.host.nativeElement;
        const items = Array.from(
          el.querySelectorAll('.od-line, .od-tl-item'),
        ) as HTMLElement[];
        if (!items.length) return;
        try {
          const gsap = await this.ensureGsap();
          gsap.from(items, {
            opacity: 0,
            y: 16,
            duration: 0.42,
            stagger: 0.045,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          });
        } catch {
          /* sin gsap: visible */
        }
      }),
    );
  }
}
