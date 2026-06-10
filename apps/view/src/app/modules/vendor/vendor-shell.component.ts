import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';

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
            icon="pi pi-sign-out"
            severity="secondary"
            size="small"
            text
            (click)="logout()"
            aria-label="Salir"
          ></button>
        </div>
      </header>

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
        background: var(--card-bg);
        border-top: 1px solid var(--border-color);
        display: flex;
        justify-content: space-around;
        padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom));
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
        padding: 0.5rem 0.25rem;
        font-size: 0.68rem;
        white-space: nowrap;
      }
      .vendor-bottom-nav a i { font-size: 1.2rem; }
      .vendor-bottom-nav a.active {
        color: var(--brand-700);
        font-weight: 600;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
