import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';

/**
 * Shell de Reparto — donde el personal de tienda asigna pedidos a domicilio a
 * los repartidores y controla el cierre de caja. Header + nav top + outlet.
 */
@Component({
  selector: 'app-reparto-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet, ButtonModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="reparto-shell">
      <p-toast position="top-center"></p-toast>
      <header class="reparto-header">
        <div class="brand">
          <i class="pi pi-send" aria-hidden="true"></i>
          <span>Reparto</span>
        </div>
        <nav class="nav" aria-label="Secciones de Reparto">
          <a routerLink="asignar" routerLinkActive="active">
            <i class="pi pi-home" aria-hidden="true"></i>
            <span>Asignar pedido</span>
          </a>
          <a routerLink="cortes" routerLinkActive="active">
            <i class="pi pi-wallet" aria-hidden="true"></i>
            <span>Cortes de caja</span>
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

      <main class="reparto-main">
        <router-outlet></router-outlet>
      </main>
    </div>
  `,
  styles: [`
    .reparto-shell { min-height: 100dvh; display: flex; flex-direction: column; background: var(--layout-bg); }
    .reparto-header { display: flex; align-items: center; gap: 1rem; padding: .6rem 1rem; background: var(--card-bg); border-bottom: 1px solid var(--border-color); position: sticky; top: 0; z-index: 10; }
    .brand { display: flex; align-items: center; gap: .5rem; font-weight: 700; color: var(--text-main); }
    .brand i { color: var(--action); }
    .nav { display: flex; gap: .25rem; flex: 1; }
    .nav a { display: inline-flex; align-items: center; gap: .4rem; padding: .45rem .7rem; border-radius: 8px; text-decoration: none; color: var(--text-muted); font-size: .9rem; }
    .nav a:hover { background: var(--hover-bg); color: var(--text-main); }
    .nav a.active { background: var(--action); color: var(--action-ink); }
    .user { display: flex; align-items: center; gap: .5rem; }
    .username { font-size: .85rem; color: var(--text-muted); }
    .reparto-main { flex: 1; }
  `],
})
export class RepartoShellComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly username = signal(this.auth.user()?.username || this.auth.user()?.role_name || 'Tienda');

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
