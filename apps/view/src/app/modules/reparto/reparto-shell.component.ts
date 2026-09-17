import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Shell de Reparto — prepara y despacha lo que sale: **Surtido** (juntar la mercancía de varios
 * pedidos en un recorrido, Fase SU) + la entrega a domicilio (asignar, seguimiento, cortes).
 *
 * ⚠️ El nav se GATEA por permiso desde `[SU.2.1]`. Antes era estático y alcanzaba, porque el
 * guard del proyecto exigía `REPARTO_DESPACHAR` para entrar y todos los que estaban adentro
 * podían abrir las cuatro pantallas. Con Surtido eso dejó de ser cierto: `almacenista` entra por
 * su permiso y NO puede abrir los cortes del repartidor — pintarle el link sería ofrecerle una
 * puerta que lo rebota.
 */
@Component({
  selector: 'app-reparto-shell',
  standalone: true,
  imports: [RouterModule, RouterOutlet, ButtonModule, ToastModule],
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
          @if (verSurtido()) {
            <a routerLink="surtido" routerLinkActive="active">
              <i class="pi pi-bolt" aria-hidden="true"></i>
              <span>Surtido</span>
            </a>
          }
          @if (verDespacho()) {
            <a routerLink="asignar" routerLinkActive="active">
              <i class="pi pi-home" aria-hidden="true"></i>
              <span>Asignar pedido</span>
            </a>
            <a routerLink="pedidos-whatsapp" routerLinkActive="active">
              <i class="pi pi-whatsapp" aria-hidden="true"></i>
              <span>Pedidos WhatsApp</span>
            </a>
            <a routerLink="seguimiento" routerLinkActive="active">
              <i class="pi pi-map-marker" aria-hidden="true"></i>
              <span>Seguimiento</span>
            </a>
            <a routerLink="cortes" routerLinkActive="active">
              <i class="pi pi-wallet" aria-hidden="true"></i>
              <span>Cortes de caja</span>
            </a>
          }
        </nav>
        <div class="user">
          <span class="username">{{ username() }}</span>
          <button
            pButton
           
            severity="secondary"
            size="small"
            text
            aria-label="Cerrar sesión"
            (click)="logout()"
          ><span class="p-button-icon p-button-icon-left pi pi-sign-out" aria-hidden="true"></span></button>
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
  private readonly perms = inject(PermissionsService);
  // El god-mode va adentro de `PermissionsService`: nunca leer `auth.user()?.permissions` a mano
  // (serían dos fuentes para la misma pregunta — DESIGN §5 del checklist).
  readonly verSurtido = computed(() => this.perms.has(Permission.COMMERCIAL_PICKING_VER));
  readonly verDespacho = computed(() => this.perms.has(Permission.REPARTO_DESPACHAR));
  readonly username = signal(this.auth.user()?.username || this.auth.user()?.role_name || 'Tienda');

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
