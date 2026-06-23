import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { SwUpdate, UnrecoverableStateEvent, VersionReadyEvent } from '@angular/service-worker';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { ToastModule } from 'primeng/toast';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, ToastModule],
  template: `
    <p-toast position="top-center"></p-toast>
    <router-outlet></router-outlet>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit {
  private readonly swUpdate = inject(SwUpdate);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Hay una versión nueva lista; se aplica en la próxima navegación. */
  private updatePending = false;

  ngOnInit(): void {
    this.setupAutoUpdate();
  }

  /**
   * Auto-update por deploy (mismo patrón que apps/view): ngsw emite VERSION_READY
   * al detectar un build nuevo; aplicamos la actualización en la PRÓXIMA navegación
   * (no en mitad de una toma de pedido). Un estado irrecuperable del SW se resuelve
   * con un reload.
   */
  private setupAutoUpdate(): void {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates
      .pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
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
          .catch(() => {
            this.updatePending = true;
          });
      });

    this.swUpdate.unrecoverable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((evt: UnrecoverableStateEvent) => {
        console.error('[SW] unrecoverable state:', evt.reason);
        document.location.reload();
      });

    this.swUpdate.checkForUpdate().catch(() => undefined);
    window.addEventListener('focus', () => {
      this.swUpdate.checkForUpdate().catch(() => undefined);
    });
  }
}
