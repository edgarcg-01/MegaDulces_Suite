import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { PwaInstallService } from './core/services/pwa-install.service';
import { StatusBarService } from './core/services/status-bar.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConfirmDialogModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  title = 'frontend';
  private pwaInstallService = inject(PwaInstallService);
  private swUpdate = inject(SwUpdate);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  // Side-effect: StatusBarService se suscribe al ThemeService al instanciarse.
  // Inyectarlo acá garantiza que el effect arranque al boot de la app.
  private statusBar = inject(StatusBarService);

  private updatePending = false;
  private static readonly UPDATE_POLL_MS = 30 * 60 * 1000;

  ngOnInit() {
    this.setupPwaInstall();
    this.setupAutoUpdate();
  }

  private setupPwaInstall(): void {
    this.pwaInstallService.installPrompt$.subscribe(canShow => {
      if (canShow) this.pwaInstallService.showInstallNotification();
    });
  }

  /**
   * Auto-update por deploy:
   * - ngsw detecta hash manifest nuevo y emite VERSION_READY.
   * - Marcamos pending y aplicamos la actualización en la PRÓXIMA navegación
   *   (así no interrumpimos al usuario en mitad de un formulario).
   * - Si no hay nav en X minutos, igual chequeamos por updates con el polling
   *   y el próximo VERSION_READY resetea el ciclo.
   * - Foco de ventana también dispara un check (común si dejan la pestaña
   *   abierta por horas).
   */
  private setupAutoUpdate(): void {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(
        filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.updatePending = true;
      });

    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        if (!this.updatePending) return;
        this.updatePending = false;
        this.swUpdate
          .activateUpdate()
          .then(() => document.location.reload())
          .catch(() => { this.updatePending = true; });
      });

    this.swUpdate.checkForUpdate().catch(() => {});
    window.addEventListener('focus', () => {
      this.swUpdate.checkForUpdate().catch(() => {});
    });
    setInterval(() => {
      this.swUpdate.checkForUpdate().catch(() => {});
    }, AppComponent.UPDATE_POLL_MS);
  }
}
