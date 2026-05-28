import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet, NavigationEnd } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { BadgeModule } from 'primeng/badge';
import { MessageService } from 'primeng/api';
import { filter } from 'rxjs/operators';
import { AuthService } from '../../core/services/auth.service';

/**
 * Shell del Portal B2B. Layout minimal: header con marca + nav + logout.
 * Sin sidebar (a diferencia de admin layout). Standalone — los routes hijos se
 * cargan con RouterOutlet.
 */
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
  ],
  providers: [MessageService],
  template: `
    <div class="portal-shell">
      <p-toast></p-toast>
      <header class="portal-header">
        <div class="portal-brand">
          <i class="pi pi-shopping-cart"></i>
          <span>Portal B2B</span>
        </div>
        <nav class="portal-nav">
          <a routerLink="catalog" routerLinkActive="active">
            <i class="pi pi-list"></i> Catálogo
          </a>
          <a routerLink="recommendations" routerLinkActive="active">
            <i class="pi pi-sparkles"></i> Sugeridos
          </a>
          <a routerLink="cart" routerLinkActive="active">
            <i class="pi pi-shopping-bag"></i> Carrito
          </a>
          <a routerLink="orders" routerLinkActive="active">
            <i class="pi pi-history"></i> Mis pedidos
          </a>
        </nav>
        <div class="portal-user">
          <span class="portal-username">{{ username() }}</span>
          <button
            pButton
            icon="pi pi-sign-out"
            severity="secondary"
            size="small"
            (click)="logout()"
            pTooltip="Cerrar sesión"
          ></button>
        </div>
      </header>
      <main class="portal-main">
        <router-outlet></router-outlet>
      </main>
    </div>
  `,
  styles: [
    `
      .portal-shell {
        min-height: 100dvh;
        display: flex;
        flex-direction: column;
        background: var(--surface-100, #f3f4f6);
      }
      .portal-header {
        display: flex;
        align-items: center;
        gap: 2rem;
        padding: max(0.75rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right)) 0.75rem max(1.5rem, env(safe-area-inset-left));
        background: var(--surface-card, white);
        border-bottom: 1px solid var(--surface-border, #e5e7eb);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
      }
      .portal-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 700;
        font-size: 1.125rem;
        color: var(--primary-color, #2563eb);
      }
      .portal-nav {
        flex: 1;
        display: flex;
        gap: 1rem;
      }
      .portal-nav a {
        color: var(--text-color-secondary, #6b7280);
        text-decoration: none;
        padding: 0.5rem 0.875rem;
        border-radius: 6px;
        font-size: 0.9rem;
        transition: background 0.15s;
      }
      .portal-nav a:hover {
        background: var(--surface-100, #f3f4f6);
      }
      .portal-nav a.active {
        background: var(--primary-color, #2563eb);
        color: white;
      }
      .portal-user {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .portal-username {
        font-size: 0.875rem;
        color: var(--text-color-secondary);
      }
      .portal-main {
        flex: 1;
        padding: 1.5rem max(1.5rem, env(safe-area-inset-right)) calc(1.5rem + env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left));
        max-width: 1280px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PortalShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly username = signal<string>(this.auth.user()?.username || '');

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/portal/login');
  }
}
