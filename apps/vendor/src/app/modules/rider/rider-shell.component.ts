import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { RoutePingService } from '../../core/services/route-ping.service';

/**
 * Shell del REPARTIDOR — app propia (separada del vendedor). Header + outlet +
 * bottom nav nativo con "Entregas". Sin cartera, carga, cierre ni Thot (eso es
 * del vendedor). El repartidor solo entrega y cobra.
 */
@Component({
  selector: 'app-rider-shell',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rider-shell">
      <header class="rider-header">
        <div class="brand"><i class="pi pi-home"></i><span>Repartidor</span></div>
        <div class="spacer"></div>
        <button class="hdr-btn" (click)="settingsOpen.set(!settingsOpen())" aria-label="Ajustes">
          <i class="pi pi-cog"></i>
        </button>
      </header>

      <div class="settings-backdrop" *ngIf="settingsOpen()" (click)="settingsOpen.set(false)"></div>
      <div class="settings-panel" *ngIf="settingsOpen()">
        <button class="set-row" (click)="theme.toggleMonochrome()">
          <i class="pi" [ngClass]="theme.isMonochrome() ? 'pi-moon' : 'pi-sun'"></i>
          <span class="lbl">Modo oscuro</span>
        </button>
        <button class="set-row danger" (click)="logout()">
          <i class="pi pi-sign-out"></i>
          <span class="lbl">Cerrar sesión</span>
        </button>
      </div>

      <main class="rider-main"><router-outlet></router-outlet></main>

      <nav class="rider-bottom-nav">
        <a routerLink="deliveries" routerLinkActive="active">
          <i class="pi pi-home"></i>
          <span>Entregas</span>
        </a>
        <a routerLink="route" routerLinkActive="active">
          <i class="pi pi-map"></i>
          <span>Ruta</span>
        </a>
      </nav>
    </div>
  `,
  styles: [`
    .rider-shell { min-height: 100dvh; display: flex; flex-direction: column; background: var(--layout-bg, #f5f5f4); }
    .rider-header { display: flex; align-items: center; gap: .5rem; padding: .7rem 1rem; background: var(--card-bg, #fff); border-bottom: 1px solid var(--border-color, #e5e5e5); position: sticky; top: 0; z-index: 10; }
    .brand { display: flex; align-items: center; gap: .5rem; font-weight: 700; }
    .brand i { color: var(--action, #ea580c); }
    .spacer { flex: 1; }
    .hdr-btn { border: none; background: transparent; font-size: 1.1rem; cursor: pointer; color: var(--text-muted, #666); }
    .rider-main { flex: 1; padding-bottom: 4rem; }
    .rider-bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-around; background: var(--card-bg, #fff); border-top: 1px solid var(--border-color, #e5e5e5); padding: .4rem 0 max(.4rem, env(safe-area-inset-bottom)); }
    .rider-bottom-nav a { display: flex; flex-direction: column; align-items: center; gap: .1rem; font-size: .72rem; color: var(--text-muted, #888); text-decoration: none; padding: .2rem .8rem; }
    .rider-bottom-nav a.active { color: var(--action, #ea580c); }
    .settings-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 20; }
    .settings-panel { position: fixed; top: 3.2rem; right: .6rem; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e5e5e5); border-radius: 12px; z-index: 21; overflow: hidden; min-width: 200px; }
    .set-row { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .7rem 1rem; border: none; background: transparent; cursor: pointer; font: inherit; }
    .set-row.danger { color: #dc2626; border-top: 1px solid var(--border-color, #eee); }
  `],
})
export class RiderShellComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);
  /** Tracking GPS en vivo del repartidor (mismo servicio que el vendedor). */
  private readonly ping = inject(RoutePingService);
  readonly settingsOpen = signal(false);

  ngOnInit(): void {
    // Abre la jornada del repartidor → empieza a emitir posición para el mapa de tienda.
    this.ping.startShift();
  }

  ngOnDestroy(): void {
    this.ping.endShift();
  }

  logout(): void {
    this.ping.endShift();
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
