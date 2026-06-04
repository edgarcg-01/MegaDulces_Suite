import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';

/**
 * Shell de Televenta — single-pane responsive, header + nav top + outlet.
 */
@Component({
  selector: 'app-televenta-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, ButtonModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="televenta-shell">
      <p-toast position="top-center"></p-toast>
      <header class="televenta-header">
        <div class="brand">
          <i class="pi pi-headphones" aria-hidden="true"></i>
          <span>Televenta</span>
        </div>
        <nav class="nav" aria-label="Secciones de Televenta">
          <a routerLink="dashboard" routerLinkActive="active">
            <i class="pi pi-chart-bar" aria-hidden="true"></i>
            <span>Dashboard</span>
          </a>
          <a routerLink="queue" routerLinkActive="active">
            <i class="pi pi-list" aria-hidden="true"></i>
            <span>Cola</span>
          </a>
          <a routerLink="my" routerLinkActive="active">
            <i class="pi pi-bookmark" aria-hidden="true"></i>
            <span>Mis activos</span>
          </a>
        </nav>
        <div class="user">
          <span class="username">{{ username() }}</span>
          <button
            pButton
            icon="pi pi-sign-out"
            severity="secondary"
            size="small"
            text
            aria-label="Cerrar sesión"
            (click)="logout()"
          ></button>
        </div>
      </header>

      <main class="televenta-main">
        <router-outlet></router-outlet>
      </main>
    </div>
  `,
  styles: [
    `
      .televenta-shell {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background: var(--neutral-100);
      }
      .televenta-header {
        display: flex;
        align-items: center;
        gap: 1.5rem;
        padding: 0.75rem 1.25rem;
        background: var(--card-bg);
        border-bottom: 1px solid var(--border-color);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 700;
        color: var(--primary-color);
      }
      .brand i { font-size: 1.25rem; }
      .nav {
        flex: 1;
        display: flex;
        gap: 0.5rem;
        justify-content: center;
      }
      .nav a {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        text-decoration: none;
        color: var(--text-color-secondary);
        padding: 0.5rem 1rem;
        border-radius: 9999px;
        font-size: 0.875rem;
        min-height: 36px;
      }
      .nav a:hover { background: var(--neutral-100); color: var(--text-color); }
      .nav a.active {
        background: var(--primary-color);
        color: white;
        font-weight: 600;
      }
      .nav a:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
      }
      .user { display: flex; align-items: center; gap: 0.5rem; }
      .username { font-size: 0.875rem; color: var(--text-color-secondary); }
      .televenta-main {
        flex: 1;
        padding: 1rem;
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
      }
      @media (max-width: 640px) {
        .televenta-header { flex-direction: column; gap: 0.5rem; padding: 0.75rem; }
        .nav { width: 100%; }
        .username { display: none; }
      }
    `,
  ],
})
export class TeleventaShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly username = signal<string>(this.auth.user()?.username || '');

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
