import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Shell de Telemarketing — single-pane responsive, header + nav top + outlet.
 *
 * E.9: el módulo se llamaba "Televenta" en el código y "Remote Manager" en el plan, mientras
 * el ERP y el rol de prod lo llaman **telemarketing** (canal TELEMARK en el 100% de las
 * facturas U/D/8). Se unifica a Telemarketing: la ruta canónica es `/telemarketing` y
 * `/televenta/*` queda como redirect que conserva los segmentos (enlaces guardados).
 * Los archivos y las clases siguen diciendo `televenta` — renombrarlos es churn sin efecto
 * visible; lo que el usuario ve y teclea ya es telemarketing.
 *
 * "Dashboard" pasa a "Resumen" y se le suma "Facturación", que es el resultado del canal:
 * el tablero medía sólo actividad (llamadas, minutos) y no veía los $8.2M/30d que el ERP
 * factura por telemarketing.
 */
@Component({
  selector: 'app-televenta-shell',
  standalone: true,
  imports: [RouterModule, RouterOutlet, ButtonModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="televenta-shell">
      <p-toast position="top-center"></p-toast>
      <header class="televenta-header">
        <div class="brand">
          <i class="pi pi-headphones" aria-hidden="true"></i>
          <span>Telemarketing</span>
        </div>
        <nav class="nav" aria-label="Secciones de Telemarketing">
          <a routerLink="dashboard" routerLinkActive="active">
            <i class="pi pi-chart-bar" aria-hidden="true"></i>
            <span>Resumen</span>
          </a>
          <a routerLink="queue" routerLinkActive="active">
            <i class="pi pi-list" aria-hidden="true"></i>
            <span>Cola</span>
          </a>
          <a routerLink="my" routerLinkActive="active">
            <i class="pi pi-bookmark" aria-hidden="true"></i>
            <span>Mis activos</span>
          </a>
          <!-- La facturación completa vive en su propia pantalla (Operations, tabla densa +
               side-peek + anexo imprimible). Aquí sólo el enlace: duplicar esa UI dentro del
               shell sería una segunda copia de la misma pantalla.
               Va gateado por SU permiso: un enlace que lleva a un rechazo del guard es peor
               que no mostrarlo. Medido en prod, los 3 roles con acceso al módulo ya lo tienen. -->
          @if (verFacturacion()) {
            <a routerLink="/comercial/documentos" routerLinkActive="active">
              <i class="pi pi-file" aria-hidden="true"></i>
              <span>Facturación</span>
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
  private readonly perms = inject(PermissionsService);

  readonly username = signal<string>(this.auth.user()?.username || '');
  /** La facturación es otra superficie con su propio permiso; sin él, el enlace no se ofrece. */
  readonly verFacturacion = this.perms.has$(Permission.COMMERCIAL_SALES_DOCS_VER);

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
