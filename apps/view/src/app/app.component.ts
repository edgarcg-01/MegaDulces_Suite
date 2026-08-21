import { Component, DestroyRef, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { DiagnosticsRecorderService } from './core/errors/diagnostics-recorder.service';
import { SwUpdate, VersionReadyEvent, UnrecoverableStateEvent } from '@angular/service-worker';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { PwaInstallService } from './core/services/pwa-install.service';
import { StatusBarService } from './core/services/status-bar.service';
import { AppErrorOutletComponent } from './core/errors/app-error-outlet.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ConfirmDialogModule, AppErrorOutletComponent],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  title = 'frontend';
  private pwaInstallService = inject(PwaInstallService);
  private swUpdate = inject(SwUpdate);
  private diag = inject(DiagnosticsRecorderService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  // Side-effect: StatusBarService se suscribe al ThemeService al instanciarse.
  // Inyectarlo acá garantiza que el effect arranque al boot de la app.
  private statusBar = inject(StatusBarService);

  private updatePending = false;
  private static readonly UPDATE_POLL_MS = 30 * 60 * 1000;
  /**
   * Cuánto se espera a que el usuario navegue solo antes de ofrecerle el botón.
   * Una pantalla de trabajo (la etiquetera, el monitor de tienda) puede pasar el día entero
   * sin cambiar de ruta: ahí la actualización nunca se aplicaba y el equipo se quedaba con
   * la versión vieja aunque el deploy hubiera salido hace horas.
   */
  private static readonly UPDATE_NUDGE_MS = 60 * 1000;
  /** Hay versión nueva lista y ya pasó el tiempo de gracia: se ofrece aplicarla. */
  readonly updateReady = signal(false);

  /** Aplica la versión nueva ahora. Es acción del usuario: nadie recarga bajo sus manos. */
  applyUpdate(): void {
    this.updateReady.set(false);
    this.updatePending = false;
    this.swUpdate.activateUpdate()
      .then(() => document.location.reload())
      .catch(() => { this.updatePending = true; this.updateReady.set(true); });
  }

  ngOnInit() {
    // Primero la grabadora: si algo se cuelga al arrancar, queremos tenerlo registrado.
    this.diag.start();
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
        // Si en un minuto no navegó (pantalla de trabajo fija), se lo ofrecemos visible.
        setTimeout(() => { if (this.updatePending) this.updateReady.set(true); }, AppComponent.UPDATE_NUDGE_MS);
      });

    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        // Al navegar con una version nueva lista se OFRECE, no se aplica.
        // Antes hacia activateUpdate() + location.reload() aca mismo: recargaba encima de
        // la navegacion que el usuario acababa de pedir. La pantalla alcanzaba a montar y
        // a lanzar sus peticiones, y se tiraba todo a la basura — desde la silla del
        // usuario es indistinguible de un cuelgue, y pasa justo despues de cada deploy.
        // El aviso ya existe y recarga con un clic (applyUpdate); esto solo lo adelanta
        // en vez de esperar el minuto de gracia.
        if (this.updatePending) this.updateReady.set(true);
      });

    // unrecoverable: el SW entró en estado roto (raro pero pasa en iOS
    // Safari cuando se evicta el cache mid-fetch). Single fix: reload.
    this.swUpdate.unrecoverable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((evt: UnrecoverableStateEvent) => {
        console.error('[SW] unrecoverable state:', evt.reason);
        document.location.reload();
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
