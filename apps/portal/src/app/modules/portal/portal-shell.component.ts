import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  trigger,
  transition,
  style,
  animate,
  keyframes,
} from '@angular/animations';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { BadgeModule } from 'primeng/badge';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { PortalService } from './portal.service';
import { NotificationPrefsService, NotifKey } from './notification-prefs.service';
import {
  AlertsSocketService,
  CommercialAlert,
} from '../dashboard/command-center/alerts-socket.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  isCart?: boolean;
}

@Component({
  selector: 'app-portal-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    RouterOutlet,
    ButtonModule,
    ToastModule,
    BadgeModule,
    TooltipModule,
  ],
  providers: [MessageService],
  animations: [
    trigger('badgePop', [
      transition(':increment', [
        animate(
          '420ms cubic-bezier(0.34, 1.4, 0.5, 1)',
          keyframes([
            style({ transform: 'scale(1)', offset: 0 }),
            style({ transform: 'scale(1.45)', offset: 0.35 }),
            style({ transform: 'scale(0.9)', offset: 0.65 }),
            style({ transform: 'scale(1)', offset: 1 }),
          ]),
        ),
      ]),
      transition(':enter', [
        style({ transform: 'scale(0)', opacity: 0 }),
        animate(
          '320ms cubic-bezier(0.34, 1.4, 0.5, 1)',
          style({ transform: 'scale(1)', opacity: 1 }),
        ),
      ]),
    ]),
  ],
  template: `
    <div class="portal-shell">
      <p-toast position="top-right"></p-toast>

      <!-- DESKTOP SIDEBAR -->
      <aside class="portal-sidebar" aria-label="Navegación principal">
        <a routerLink="/portal/home" class="portal-brand">
          <img
            src="/assets/logos/mega-dulces-logo-240.webp"
            alt="Mega Dulces"
            class="portal-brand-logo"
          />
          <div class="portal-brand-text">
            <span class="portal-brand-name">Mega Dulces</span>
            <span class="portal-brand-sub">Portal B2B</span>
          </div>
        </a>

        <nav class="portal-nav-desktop">
          <a
            *ngFor="let item of navItems"
            [routerLink]="item.path"
            routerLinkActive="active"
            class="portal-nav-item"
            [attr.aria-label]="item.isCart && cart.cartLineCount() > 0
              ? item.label + ': ' + cart.cartLineCount() + ' item(s)'
              : null"
          >
            <span class="portal-nav-icon-wrap">
              <i [class]="item.icon" aria-hidden="true"></i>
              <span
                *ngIf="item.isCart && cart.cartLineCount() > 0"
                class="portal-cart-badge"
                aria-hidden="true"
                [@badgePop]="cart.cartLineCount()"
              >{{ cart.cartLineCount() }}</span>
            </span>
            <span class="portal-nav-label">{{ item.label }}</span>
          </a>
        </nav>

        <div class="portal-sidebar-foot">
          <button
            type="button"
            class="portal-user-card portal-user-card-btn"
            (click)="openSettings()"
            pTooltip="Abrir configuración"
            tooltipPosition="right"
            aria-label="Abrir configuración"
          >
            <div class="portal-user-avatar">{{ initial() }}</div>
            <div class="portal-user-info">
              <span class="portal-user-name">{{ username() }}</span>
              <span class="portal-user-role">Cliente B2B</span>
            </div>
            <i class="pi pi-cog portal-user-cog" aria-hidden="true"></i>
          </button>
        </div>
      </aside>

      <!-- MAIN COLUMN -->
      <div class="portal-column">
        <!-- MOBILE HEADER -->
        <header class="portal-header-mobile">
          <a routerLink="/portal/home" class="portal-brand-mobile">
            <img
              src="/assets/logos/mega-dulces-logo-240.webp"
              alt="Mega Dulces"
              class="portal-brand-logo-mobile"
            />
            <span>Mega Dulces</span>
          </a>
          <button
            type="button"
            class="portal-icon-btn"
            (click)="openSettings()"
            pTooltip="Configuración"
            tooltipPosition="bottom"
            aria-label="Abrir configuración"
          >
            <i class="pi pi-cog" aria-hidden="true"></i>
          </button>
        </header>

        <!-- CONTENT -->
        <main class="portal-main">
          <router-outlet></router-outlet>
        </main>

        <!-- MOBILE BOTTOM TAB BAR (floating pill, Stitch-style) -->
        <nav class="portal-tabbar" aria-label="Navegación móvil">
          <a
            *ngFor="let item of navItems"
            [routerLink]="item.path"
            routerLinkActive="active"
            class="portal-tab"
            [attr.aria-label]="item.isCart && cart.cartLineCount() > 0
              ? item.label + ': ' + cart.cartLineCount() + ' item(s)'
              : item.label"
          >
            <span class="portal-tab-icon-wrap">
              <i [class]="item.icon" aria-hidden="true"></i>
              <span
                *ngIf="item.isCart && cart.cartLineCount() > 0"
                class="portal-cart-badge-mobile"
                aria-hidden="true"
                [@badgePop]="cart.cartLineCount()"
              >{{ cart.cartLineCount() }}</span>
            </span>
            <span class="portal-tab-label">{{ item.label }}</span>
          </a>
        </nav>

      </div>

      <!-- ── SETTINGS PANEL (slide-in derecha) ────────────────────── -->
      <div
        class="ps-backdrop"
        [class.open]="settingsOpen()"
        (click)="closeSettings()"
        aria-hidden="true"
      ></div>
      <aside
        class="ps-panel"
        [class.open]="settingsOpen()"
        role="dialog"
        aria-label="Configuración"
      >
        <header class="ps-head">
          <div>
            <span class="ps-eyebrow">Tu cuenta</span>
            <h2>Configuración</h2>
          </div>
          <button
            type="button"
            class="ps-close"
            (click)="closeSettings()"
            aria-label="Cerrar configuración"
          ><i class="pi pi-times" aria-hidden="true"></i></button>
        </header>

        <div class="ps-body">
          <!-- Usuario -->
          <section class="ps-section">
            <div class="ps-user">
              <div class="ps-user-avatar">{{ initial() }}</div>
              <div class="ps-user-info">
                <span class="ps-user-name">{{ username() }}</span>
                <span class="ps-user-role">Cliente B2B · Mega Dulces</span>
              </div>
            </div>
          </section>

          <!-- Apariencia -->
          <section class="ps-section">
            <h3 class="ps-section-title">
              <i class="pi pi-palette" aria-hidden="true"></i> Apariencia
            </h3>
            <div class="ps-segment" role="radiogroup" aria-label="Tema">
              <button
                type="button"
                class="ps-segment-btn"
                [class.active]="themeMode() === 'system'"
                (click)="setTheme('system')"
                role="radio"
                [attr.aria-checked]="themeMode() === 'system'"
              >
                <i class="pi pi-desktop"></i>
                <span>Sistema</span>
              </button>
              <button
                type="button"
                class="ps-segment-btn"
                [class.active]="themeMode() === 'light'"
                (click)="setTheme('light')"
                role="radio"
                [attr.aria-checked]="themeMode() === 'light'"
              >
                <i class="pi pi-sun"></i>
                <span>Claro</span>
              </button>
              <button
                type="button"
                class="ps-segment-btn"
                [class.active]="themeMode() === 'dark'"
                (click)="setTheme('dark')"
                role="radio"
                [attr.aria-checked]="themeMode() === 'dark'"
              >
                <i class="pi pi-moon"></i>
                <span>Oscuro</span>
              </button>
            </div>
            <p class="ps-hint">
              "Sistema" sigue las preferencias de tu dispositivo automáticamente.
            </p>
          </section>

          <!-- Notificaciones -->
          <section class="ps-section">
            <h3 class="ps-section-title">
              <i class="pi pi-bell" aria-hidden="true"></i> Notificaciones
            </h3>

            <ul class="ps-notif-list">
              <li class="ps-notif-item">
                <span class="ps-notif-icon"><i class="pi pi-receipt" aria-hidden="true"></i></span>
                <div class="ps-notif-text">
                  <span class="ps-notif-title">Estado de pedidos</span>
                  <span class="ps-notif-desc">Aviso en tiempo real cuando confirmen o entreguen tu pedido.</span>
                </div>
                <button
                  type="button"
                  class="ps-switch"
                  [class.on]="notif.prefs().orders"
                  (click)="toggleNotif('orders')"
                  [attr.aria-checked]="notif.prefs().orders"
                  role="switch"
                  [attr.aria-label]="'Notificaciones de pedidos: ' + (notif.prefs().orders ? 'activadas' : 'desactivadas')"
                ><span class="ps-switch-thumb" aria-hidden="true"></span></button>
              </li>
            </ul>
          </section>
        </div>

        <footer class="ps-foot">
          <button type="button" class="ps-logout" (click)="logout()">
            <i class="pi pi-sign-out" aria-hidden="true"></i>
            Cerrar sesión
          </button>
        </footer>
      </aside>
    </div>
  `,
  styles: [
    `
      :host { display: block; }

      .portal-shell {
        min-height: 100dvh;
        display: flex;
        background: var(--surface-ground);
        color: var(--text-main);
      }

      /* ── DESKTOP SIDEBAR ───────────────────────────────────────────── */
      .portal-sidebar {
        width: 248px;
        flex-shrink: 0;
        background: var(--card-bg);
        border-right: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        padding: 1.25rem 0.875rem calc(1rem + env(safe-area-inset-bottom));
        position: sticky;
        top: 0;
        height: 100dvh;
        gap: 1.25rem;
      }

      .portal-brand {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.5rem 1rem;
        border-bottom: 1px solid var(--border-color);
        text-decoration: none;
        color: inherit;
      }
      .portal-brand-logo {
        width: 44px;
        height: 44px;
        object-fit: contain;
        border-radius: 10px;
        background: var(--neutral-100);
        padding: 4px;
      }
      .portal-brand-text { display: flex; flex-direction: column; line-height: 1.1; min-width: 0; }
      .portal-brand-name {
        font-weight: 700;
        font-size: var(--fs-body);
        color: var(--text-main);
      }
      .portal-brand-sub {
        font-size: var(--fs-micro);
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-top: 2px;
      }

      .portal-nav-desktop {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        overflow-y: auto;
      }
      .portal-nav-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.625rem 0.75rem;
        border-radius: 10px;
        color: var(--text-muted);
        text-decoration: none;
        font-size: var(--fs-body);
        font-weight: 500;
        position: relative;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .portal-nav-item:hover {
        background: var(--hover-bg);
        color: var(--text-main);
      }
      .portal-nav-item.active {
        background: var(--neutral-100);
        color: var(--text-main);
        font-weight: 600;
      }
      .portal-nav-item.active::before {
        content: '';
        position: absolute;
        left: -0.875rem;
        top: 8px;
        bottom: 8px;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: var(--brand-500);
      }
      .portal-nav-icon-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
      }
      .portal-nav-icon-wrap i { font-size: var(--fs-h3); }

      .portal-cart-badge {
        position: absolute;
        top: -6px;
        right: -8px;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--brand-400);
        color: var(--neutral-950);
        font-size: var(--fs-nano);
        font-weight: 800;
        line-height: 18px;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }

      .portal-sidebar-foot {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--border-color);
      }
      .portal-user-card {
        display: flex;
        align-items: center;
        gap: 0.625rem;
        padding: 0.5rem;
        border-radius: 10px;
        background: var(--surface-ground);
      }
      .portal-user-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--neutral-900);
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: var(--fs-h3);
        flex-shrink: 0;
      }
      .portal-user-info {
        display: flex;
        flex-direction: column;
        line-height: 1.15;
        min-width: 0;
        overflow: hidden;
      }
      .portal-user-name {
        font-size: var(--fs-body);
        font-weight: 600;
        color: var(--text-main);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .portal-user-role {
        font-size: var(--fs-micro);
        color: var(--text-muted);
      }

      .portal-logout :deep(.p-button-label) { font-weight: 500; }

      /* ── MAIN COLUMN ──────────────────────────────────────────────── */
      .portal-column {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .portal-header-mobile {
        display: none;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: calc(0.625rem + env(safe-area-inset-top))
          max(1rem, env(safe-area-inset-right)) 0.625rem
          max(1rem, env(safe-area-inset-left));
        background: var(--card-bg);
        border-bottom: 1px solid var(--border-color);
        position: sticky;
        top: 0;
        z-index: 20;
        backdrop-filter: blur(10px) saturate(180%);
        -webkit-backdrop-filter: blur(10px) saturate(180%);
      }
      .portal-brand-mobile {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        text-decoration: none;
        color: var(--text-main);
        font-weight: 700;
        font-size: var(--fs-h3);
      }
      .portal-brand-logo-mobile {
        width: 32px;
        height: 32px;
        object-fit: contain;
        border-radius: 8px;
        background: var(--neutral-100);
        padding: 3px;
      }
      .portal-icon-btn {
        width: 40px;
        height: 40px;
        border-radius: 10px;
        background: transparent;
        border: none;
        color: var(--text-muted);
        display: grid;
        place-items: center;
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard), color 150ms var(--ease-standard);
      }
      .portal-icon-btn:hover { background: var(--hover-bg); color: var(--text-main); }
      .portal-icon-btn:active { transform: scale(0.94); }

      .portal-main {
        flex: 1;
        padding: 1.5rem max(1.5rem, env(safe-area-inset-right))
          calc(1.5rem + env(safe-area-inset-bottom))
          max(1.5rem, env(safe-area-inset-left));
        max-width: 1280px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
      }

      /* ── MOBILE BOTTOM TAB BAR (floating pill — Stitch style) ─── */
      .portal-tabbar {
        display: none;
        position: fixed;
        bottom: calc(1rem + env(safe-area-inset-bottom));
        left: 50%;
        transform: translateX(-50%);
        width: 92%;
        max-width: 480px;
        z-index: 40;
        background: color-mix(in srgb, var(--card-bg) 86%, transparent);
        border: 1px solid var(--border-color);
        border-radius: 9999px;
        padding: 0.375rem;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.2);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
      }
      .portal-tab {
        flex: 1;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        min-height: 44px;
        padding: 0.375rem 0.5rem;
        border-radius: 9999px;
        text-decoration: none;
        color: var(--text-muted);
        font-size: var(--fs-nano);
        font-weight: 600;
        transition:
          color 220ms var(--ease-standard),
          background-color 220ms var(--ease-standard),
          padding 220ms var(--ease-standard),
          flex 220ms var(--ease-standard);
      }
      .portal-tab.active {
        background: var(--neutral-950);
        color: var(--brand-400);
        flex: 0 0 auto;
        padding: 0.5rem 1.125rem;
      }
      .portal-tab.active .portal-tab-icon-wrap i {
        color: var(--brand-400);
      }
      .portal-tab:active {
        transform: scale(0.92);
      }
      .portal-tab-icon-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
      }
      .portal-tab-icon-wrap i { font-size: var(--fs-h2); }
      .portal-tab-label {
        line-height: 1;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      .portal-tab:not(.active) .portal-tab-label {
        display: none;
      }

      .portal-cart-badge-mobile {
        position: absolute;
        top: -6px;
        right: -10px;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--brand-400);
        color: var(--neutral-950);
        font-size: var(--fs-nano);
        font-weight: 800;
        line-height: 18px;
        text-align: center;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 0 0 2px var(--card-bg);
      }

      /* ── RESPONSIVE BREAKPOINT ────────────────────────────────────── */
      @media (max-width: 900px) {
        .portal-sidebar { display: none; }
        .portal-header-mobile { display: flex; }
        .portal-tabbar { display: flex; }
        .portal-main {
          /* 5rem tabbar + 1rem margen + safe-area garantizan que el contenido
             no quede oculto detrás del tabbar flotante (Stitch style). */
          padding: 1rem max(1rem, env(safe-area-inset-right))
            calc(6.5rem + env(safe-area-inset-bottom))
            max(1rem, env(safe-area-inset-left));
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .ps-panel,
        .ps-backdrop,
        .portal-tab,
        .ps-switch-thumb { transition: none !important; animation: none !important; }
      }

      /* ── USER CARD BUTTON (sidebar foot) ─────────────────────── */
      .portal-user-card-btn {
        width: 100%;
        cursor: pointer;
        border: none;
        text-align: left;
        gap: 0.625rem;
        transition: background-color 150ms var(--ease-standard);
      }
      .portal-user-card-btn:hover {
        background: var(--neutral-200);
      }
      .portal-user-cog {
        color: var(--text-faint);
        font-size: var(--fs-body);
        margin-left: auto;
      }
      .portal-user-card-btn:hover .portal-user-cog {
        color: var(--text-main);
      }

      /* ── SETTINGS PANEL (slide-in derecha) ───────────────────── */
      .ps-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        opacity: 0;
        visibility: hidden;
        transition: opacity 220ms var(--ease-standard), visibility 220ms;
        z-index: 100;
        backdrop-filter: blur(2px);
      }
      .ps-backdrop.open { opacity: 1; visibility: visible; }

      .ps-panel {
        position: fixed;
        top: 0;
        right: 0;
        height: 100dvh;
        width: min(400px, 100vw);
        background: var(--card-bg);
        z-index: 101;
        display: flex;
        flex-direction: column;
        box-shadow: -12px 0 32px -8px rgba(0, 0, 0, 0.2);
        transform: translateX(100%);
        transition: transform 320ms cubic-bezier(0.2, 0, 0, 1);
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-right: env(safe-area-inset-right);
      }
      .ps-panel.open { transform: translateX(0); }

      .ps-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 1.25rem 1.25rem 1rem;
        border-bottom: 1px solid var(--border-color);
      }
      .ps-eyebrow {
        display: block;
        font-size: var(--fs-micro);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 0.25rem;
      }
      .ps-head h2 {
        margin: 0;
        font-size: var(--fs-h2);
        font-weight: 800;
        color: var(--text-main);
        letter-spacing: -0.015em;
      }
      .ps-close {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: var(--neutral-100);
        border: none;
        cursor: pointer;
        color: var(--text-muted);
        display: grid;
        place-items: center;
      }
      .ps-close:hover {
        background: var(--neutral-200);
        color: var(--text-main);
      }

      .ps-body {
        flex: 1;
        overflow-y: auto;
        padding: 1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }

      .ps-section { display: flex; flex-direction: column; gap: 0.625rem; }
      .ps-section-title {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        font-size: var(--fs-sm);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
      }
      .ps-section-title i {
        font-size: var(--fs-body);
        color: var(--text-muted);
      }
      .ps-section-count {
        margin-left: auto;
        font-size: var(--fs-micro);
        font-weight: 600;
        color: var(--text-faint);
        text-transform: none;
        letter-spacing: 0;
        font-variant-numeric: tabular-nums;
      }

      .ps-user {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.875rem;
        background: var(--neutral-100);
        border-radius: 12px;
      }
      .ps-user-avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: var(--neutral-900);
        color: #fff;
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: var(--fs-h3);
        flex-shrink: 0;
      }
      .ps-user-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .ps-user-name {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--text-main);
      }
      .ps-user-role {
        font-size: var(--fs-xs);
        color: var(--text-muted);
      }

      /* ── Segment control (Sistema / Claro / Oscuro) ──────────── */
      .ps-segment {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
        padding: 4px;
        background: var(--neutral-100);
        border: 1px solid var(--border-color);
        border-radius: 12px;
      }
      .ps-segment-btn {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0.625rem 0.5rem;
        background: transparent;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        color: var(--text-muted);
        font-size: var(--fs-xs);
        font-weight: 600;
        transition: background-color 180ms var(--ease-standard), color 180ms var(--ease-standard);
      }
      .ps-segment-btn i { font-size: var(--fs-h3); }
      .ps-segment-btn:hover:not(.active) {
        color: var(--text-main);
      }
      .ps-segment-btn.active {
        background: var(--card-bg);
        color: var(--text-main);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06),
                    inset 0 -2px 0 var(--brand-500);
      }
      .ps-hint {
        margin: 0;
        font-size: var(--fs-micro);
        color: var(--text-faint);
        line-height: 1.4;
      }

      /* ── Notification list with switches ─────────────────────── */
      .ps-notif-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }
      .ps-notif-item {
        display: grid;
        grid-template-columns: 36px 1fr auto;
        gap: 0.75rem;
        align-items: center;
        padding: 0.75rem;
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 12px;
      }
      .ps-notif-icon {
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: var(--neutral-100);
        color: var(--text-main);
        display: grid;
        place-items: center;
      }
      .ps-notif-icon i { font-size: var(--fs-h3); }
      .ps-notif-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .ps-notif-title {
        font-size: var(--fs-body);
        font-weight: 700;
        color: var(--text-main);
        line-height: 1.2;
      }
      .ps-notif-desc {
        font-size: var(--fs-xs);
        color: var(--text-muted);
        line-height: 1.3;
      }

      /* ── Switch ─────────────────────────────────────────────── */
      .ps-switch {
        width: 40px;
        height: 22px;
        border-radius: 999px;
        background: var(--neutral-300);
        border: none;
        position: relative;
        cursor: pointer;
        padding: 2px;
        flex-shrink: 0;
        transition: background-color 200ms var(--ease-standard);
      }
      .ps-switch-thumb {
        display: block;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
        transition: transform 220ms cubic-bezier(0.34, 1.4, 0.5, 1);
        transform: translateX(0);
      }
      .ps-switch.on {
        background: var(--neutral-900);
      }
      .ps-switch.on .ps-switch-thumb {
        transform: translateX(18px);
        background: var(--brand-400);
      }
      .ps-switch:focus-visible {
        outline: 2px solid var(--brand-500);
        outline-offset: 2px;
      }

      /* ── Footer ─────────────────────────────────────────────── */
      .ps-foot {
        padding: 1rem 1.25rem 1.25rem;
        border-top: 1px solid var(--border-color);
      }
      .ps-logout {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        background: transparent;
        color: var(--bad-fg);
        border: 1px solid var(--bad-border);
        border-radius: 10px;
        font-weight: 700;
        font-size: var(--fs-body);
        cursor: pointer;
        transition: background-color 150ms var(--ease-standard);
      }
      .ps-logout:hover {
        background: var(--bad-soft-bg);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(MessageService);
  private readonly alerts = inject(AlertsSocketService);
  private readonly destroyRef = inject(DestroyRef);
  readonly cart = inject(PortalService);
  readonly notif = inject(NotificationPrefsService);

  readonly username = signal<string>(this.auth.user()?.username || '');
  readonly initial = computed(() =>
    (this.username() || '?').trim().charAt(0).toUpperCase() || '?',
  );

  readonly settingsOpen = signal<boolean>(false);

  readonly themeMode = computed<'system' | 'light' | 'dark'>(() => {
    if (this.theme.followingSystem()) return 'system';
    return this.theme.isMonochrome() ? 'dark' : 'light';
  });

  private readonly myCustomerId = signal<string | null>(null);

  openSettings(): void { this.settingsOpen.set(true); }
  closeSettings(): void { this.settingsOpen.set(false); }

  setTheme(mode: 'system' | 'light' | 'dark'): void {
    if (mode === 'system') this.theme.resetToSystem();
    else this.theme.setMonochrome(mode === 'dark');
  }

  toggleNotif(key: NotifKey): void {
    this.notif.toggle(key);
  }

  readonly navItems: NavItem[] = [
    { path: 'home', label: 'Inicio', icon: 'pi pi-home' },
    { path: 'catalog', label: 'Catálogo', icon: 'pi pi-th-large' },
    { path: 'promotions', label: 'Promos', icon: 'pi pi-megaphone' },
    { path: 'cart', label: 'Carrito', icon: 'pi pi-shopping-bag', isCart: true },
    { path: 'orders', label: 'Pedidos', icon: 'pi pi-receipt' },
  ];

  constructor() {
    this.cart.refreshCart();

    // Resolver el customer_id del JWT una vez al montar (lo usamos para filtrar
    // alertas WS que llegan tenant-wide).
    this.cart.myCustomerInfo().subscribe({
      next: (c) => this.myCustomerId.set(c?.id || null),
      error: () => this.myCustomerId.set(null),
    });

    // Conectar al namespace /alerts. Las alertas llegan a TODO el tenant —
    // acá filtramos por customer_id propio + tipo + preferencia local.
    this.alerts.connect();
    this.alerts.alert$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((a) => this.handleAlert(a));

    this.destroyRef.onDestroy(() => this.alerts.disconnect());
  }

  private handleAlert(a: CommercialAlert): void {
    if (!this.notif.prefs().orders) return;
    if (a.type !== 'order_confirmed' && a.type !== 'order_fulfilled') return;
    const mine = this.myCustomerId();
    if (!mine || a.data?.customer_id !== mine) return;

    this.toast.add({
      severity: 'success',
      summary: a.title,
      detail: a.message,
      life: 6000,
    });
    this.cart.refreshCart();
  }

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/portal/login');
  }
}
