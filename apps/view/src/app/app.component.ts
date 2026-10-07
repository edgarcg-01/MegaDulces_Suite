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
import { alCambiarEnOtraVentana } from './core/utils/cross-tab';
import { loginUrlTree } from './core/auth/login-redirect';
import { AuthService } from './core/services/auth.service';
import { ArqueoDueService } from './modules/tienda/arqueo-due.service';

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
  /** SM.23 — el aviso "haz tu arqueo" vive en la raíz: tiene que llegar esté en la pantalla que esté. */
  readonly arqueoDue = inject(ArqueoDueService);
  private auth = inject(AuthService);

  private updatePending = false;
  private static readonly UPDATE_POLL_MS = 30 * 60 * 1000;
  /**
   * `[SW.1]` **Piso entre dos consultas de actualización, sea cual sea el disparador.**
   *
   * ⛔ Medido en una traza de red real (2026-09-22) al buscar un folio en `/comercial/tickets`:
   * **`ngsw.json` pedido SEIS veces en una sola interacción**, entre **189 y 450 ms cada una**
   * — cerca de **1.6 s** de espera. La petición de la pantalla, al lado, tardó **224 ms**. O sea
   * que lo que el usuario sentía como «la búsqueda tarda» no era la búsqueda: era el service
   * worker revisando si había versión nueva, una y otra vez.
   *
   * La culpa es del disparador de `focus`: se revisa en CADA vuelta de foco a la ventana. Hacer
   * clic en el campo, alt-tab, volver del PDF — cada uno pedía `ngsw.json` completo, y ese
   * archivo NO se cachea (`ngsw-cache-bust` le pone un query aleatorio a propósito).
   *
   * ⚠️ El `focus` NO se quita: es lo que hace que alguien que dejó la pestaña abierta toda la
   * tarde se entere del deploy al volver. Lo que se quita es revisarlo *seis veces seguidas*.
   * Con 5 minutos de piso, una ráfaga colapsa a UNA sola consulta y el caso que el `focus` existe
   * para cubrir —volver después de un rato— sigue funcionando igual.
   */
  private static readonly UPDATE_MIN_GAP_MS = 5 * 60 * 1000;
  private ultimaRevision = 0;

  /**
   * `[SW.1]` Única puerta a `checkForUpdate()`. Los tres disparadores (boot, foco, intervalo)
   * pasan por acá; sin esta puerta cada uno pedía por su cuenta y se pisaban entre ellos.
   *
   * `force` lo usa el arranque: la primera revisión de la sesión sí tiene que salir siempre —
   * es justo cuando el usuario acaba de entrar y puede estar con la versión vieja.
   */
  private revisarActualizacion(force = false): void {
    const ahora = Date.now();
    if (!force && ahora - this.ultimaRevision < AppComponent.UPDATE_MIN_GAP_MS) return;
    this.ultimaRevision = ahora;
    this.swUpdate.checkForUpdate().catch(() => {});
  }
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

  /** Lleva a contar el corte que toca y saca ese de la barra; si quedan otros, siguen. */
  irAlArqueo(): void {
    const folio = this.arqueoDue.pendiente()?.folio;
    this.router.navigate(['/tienda/arqueo']);
    this.arqueoDue.descartar(folio);
  }

  ngOnInit() {
    // Primero la grabadora: si algo se cuelga al arrancar, queremos tenerlo registrado.
    this.diag.start();
    // SM.23 — abre el canal del aviso "haz tu arqueo" (no-op si el usuario no captura).
    this.arqueoDue.iniciar();
    // `[ID.21]` Permisos frescos al arrancar: los del JWT pueden tener horas y
    // ahora se editan por persona. Sin esto, quitarle un permiso a alguien no se
    // ve en el menú hasta que vuelva a entrar. Best-effort — si falla, queda el
    // snapshot del token.
    this.auth.refreshAccess();
    this.setupPwaInstall();
    this.setupAutoUpdate();
    this.setupCierreEnOtraVentana();
  }

  /**
   * `[MT.2]` Cerrar sesión en una ventana cierra TODAS.
   *
   * Sin esto, la Suite abierta dos veces son dos apps que no se hablan: te vas en
   * una y la otra sigue pintando una pantalla viva con un token muerto hasta que
   * su próxima petición dé 401 — y hasta ahí, alguien que se levantó de la
   * computadora la dejó con la sesión de otro a la vista. Medido antes de MT.2:
   * **cero** listeners de 'storage' en toda la app.
   *
   * Se escucha la clave del token: 'removeItem' también dispara 'storage'.
   */
  private setupCierreEnOtraVentana(): void {
    const dejar = alCambiarEnOtraVentana('auth_token', (valor) => {
      // Sólo el borrado. Si llega un token NUEVO (otro usuario entró en otra
      // ventana) no se toca nada: recargar bajo las manos de alguien que está
      // capturando es peor que la incoherencia, y su próxima petición ya lo
      // resuelve con el 401 y su `returnUrl` (`[SN.31]`).
      if (valor !== null) return;
      if (!this.auth.isAuthenticated) return;
      this.auth.logout();
      void this.router.navigateByUrl(loginUrlTree(this.router, this.router.url, 'required'));
    });
    this.destroyRef.onDestroy(dejar);
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

    // La primera de la sesión sale siempre: el usuario acaba de entrar.
    this.revisarActualizacion(true);
    // ⚠️ Las dos de abajo pasan por el piso de `UPDATE_MIN_GAP_MS`. Ver su comentario: sin eso,
    // una sola interacción disparaba SEIS descargas de `ngsw.json` de hasta 450 ms cada una.
    window.addEventListener('focus', () => this.revisarActualizacion());
    setInterval(() => this.revisarActualizacion(), AppComponent.UPDATE_POLL_MS);
  }
}
