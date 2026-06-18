import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { RoutePingService } from '../../core/services/route-ping.service';

/**
 * Shell del modo vendedor — mobile-first.
 * Header compacto + bottom nav (estilo nativo). Sin sidebar.
 */
@Component({
  selector: 'app-vendor-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, ButtonModule, ToastModule],
  providers: [MessageService],
  template: `
    <div class="vendor-shell">
      <p-toast position="top-center"></p-toast>
      <header class="vendor-header">
        <div class="vendor-brand">
          <i class="pi pi-briefcase"></i>
          <span>Vendedor</span>
        </div>
        <div class="vendor-user">
          <a
            pButton
            icon="pi pi-search"
            severity="secondary"
            size="small"
            text
            routerLink="search"
            routerLinkActive="header-active"
            aria-label="Buscar cliente"
          ></a>
          <a
            pButton
            icon="pi pi-bell"
            severity="secondary"
            size="small"
            text
            routerLink="notifications"
            routerLinkActive="header-active"
            aria-label="Notificaciones"
          ></a>
          <a
            pButton
            icon="pi pi-chart-bar"
            severity="secondary"
            size="small"
            text
            routerLink="today"
            routerLinkActive="header-active"
            aria-label="Mi día"
          ></a>
          <button
            pButton
            icon="pi pi-cog"
            severity="secondary"
            size="small"
            text
            (click)="settingsOpen.set(!settingsOpen())"
            aria-label="Configuración"
          ></button>
        </div>
      </header>

      <!-- Panel de configuración (modo oscuro + cerrar sesión) -->
      <div class="settings-backdrop" *ngIf="settingsOpen()" (click)="settingsOpen.set(false)"></div>
      <div class="settings-panel" *ngIf="settingsOpen()">
        <button class="set-row" (click)="theme.toggleMonochrome()">
          <i class="pi" [ngClass]="theme.isMonochrome() ? 'pi-moon' : 'pi-sun'"></i>
          <span class="lbl">Modo oscuro</span>
          <span class="switch" [class.on]="theme.isMonochrome()"><span class="knob"></span></span>
        </button>
        <button class="set-row danger" (click)="logout()">
          <i class="pi pi-sign-out"></i>
          <span class="lbl">Cerrar sesión</span>
        </button>
      </div>

      <main class="vendor-main">
        <router-outlet></router-outlet>
      </main>

      <nav class="vendor-bottom-nav">
        <a routerLink="route-home" routerLinkActive="active">
          <i class="pi pi-map"></i>
          <span>Mi ruta</span>
        </a>
        <a routerLink="close-route" routerLinkActive="active">
          <i class="pi pi-receipt"></i>
          <span>Cierre</span>
        </a>
        <a routerLink="carga" routerLinkActive="active">
          <i class="pi pi-truck"></i>
          <span>Carga</span>
        </a>
      </nav>
    </div>
  `,
  styles: [
    `
      .vendor-shell {
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        background: var(--layout-bg);
      }
      .vendor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: max(0.75rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.75rem max(1rem, env(safe-area-inset-left));
        background: var(--card-bg);
        border-bottom: 1px solid var(--border-color);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .vendor-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 700;
        color: var(--brand-700);
      }
      .vendor-brand i { font-size: 1.25rem; }
      .vendor-user { display: flex; align-items: center; gap: 0.25rem; }
      .vendor-user a.header-active { color: var(--brand-700); }
      .vendor-main {
        flex: 1;
        padding: 1rem;
        padding-bottom: calc(5rem + env(safe-area-inset-bottom));
        max-width: 800px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
      }
      .vendor-bottom-nav {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        /* Fondo = el de la PÁGINA (no --card-bg): así la nav + la franja del
           home indicator se funden con el contenido y no se ve un bloque de
           otro tono ("borde") abajo. La separación la da solo el border-top. */
        background: var(--layout-bg);
        border-top: 1px solid var(--border-color);
        display: flex;
        justify-content: space-around;
        /* Sin padding-bottom acá: la safe-area la absorbe el área táctil de cada
           botón (abajo), así tocar la franja del home indicator activa el menú
           en vez de quedar como espacio muerto. */
        padding: 0;
        z-index: 10;
        box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.04);
      }
      .vendor-bottom-nav a {
        flex: 1;
        max-width: 110px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.125rem;
        text-decoration: none;
        color: var(--text-muted);
        /* Área táctil que llega hasta el borde (incluye la safe-area), pero el
           ícono+label quedan arriba del home indicator. Así el espacio "se usa"
           para el menú sin pelear con el gesto del sistema. */
        padding: 0.6rem 0.25rem calc(0.6rem + env(safe-area-inset-bottom));
        font-size: 0.68rem;
        white-space: nowrap;
      }
      .vendor-bottom-nav a i { font-size: 1.2rem; }
      .vendor-bottom-nav a.active {
        color: var(--brand-700);
        font-weight: 600;
      }

      /* Panel de configuración */
      .settings-backdrop { position: fixed; inset: 0; z-index: 40; }
      .settings-panel {
        position: fixed; top: calc(env(safe-area-inset-top) + 3.4rem); right: max(0.75rem, env(safe-area-inset-right));
        z-index: 41; min-width: 13.5rem; background: var(--card-bg); border: 1px solid var(--border-color);
        border-radius: var(--r-md, 12px); box-shadow: 0 14px 34px -10px rgba(0,0,0,0.4); padding: 0.35rem;
        display: flex; flex-direction: column; gap: 0.15rem; animation: setpop 0.14s var(--ease, ease);
      }
      .settings-panel .set-row {
        display: flex; align-items: center; gap: 0.65rem; width: 100%; border: none; background: none;
        color: var(--text-main); padding: 0.65rem 0.6rem; border-radius: var(--r-sm, 8px); text-align: left;
        font-family: var(--font-body); font-size: 0.9rem; font-weight: 600; cursor: pointer;
      }
      .settings-panel .set-row:active { background: var(--surface-ground); }
      .settings-panel .set-row > .pi { width: 1.25rem; text-align: center; color: var(--text-muted); font-size: 1rem; }
      .settings-panel .set-row .lbl { flex: 1; }
      .settings-panel .set-row.danger { color: var(--bad-fg); }
      .settings-panel .set-row.danger > .pi { color: var(--bad-fg); }
      .settings-panel .switch { width: 2.2rem; height: 1.3rem; border-radius: 999px; background: var(--border-color); position: relative; transition: background 0.15s var(--ease, ease); flex-shrink: 0; }
      .settings-panel .switch.on { background: var(--action); }
      .settings-panel .switch .knob { position: absolute; top: 0.15rem; left: 0.15rem; width: 1rem; height: 1rem; border-radius: 50%; background: #fff; transition: transform 0.15s var(--ease, ease); }
      .settings-panel .switch.on .knob { transform: translateX(0.9rem); }
      @keyframes setpop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      @media (prefers-reduced-motion: reduce) { .settings-panel, .settings-panel .switch, .settings-panel .switch .knob { animation: none; transition: none; } }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);
  private readonly routePing = inject(RoutePingService);

  readonly settingsOpen = signal(false);

  constructor() {
    // Tracking de jornada: arranca al entrar al modo vendedor.
    this.routePing.startShift();
  }

  logout(): void {
    this.settingsOpen.set(false);
    this.routePing.endShift();
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
