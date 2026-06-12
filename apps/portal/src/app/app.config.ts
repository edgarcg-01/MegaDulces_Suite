import { APP_INITIALIZER, ApplicationConfig, ErrorHandler, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withPreloading, PreloadAllModules, Router, NavigationEnd } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import { ConfirmationService, MessageService } from 'primeng/api';
import { provideServiceWorker } from '@angular/service-worker';
import { filter } from 'rxjs/operators';
import { environment } from '../environments/environment';
import { appRoutes } from './app.routes';
import { authInterceptor } from './core/http/auth.interceptor';
import { TelemetryService } from './core/telemetry/telemetry.service';
import { GlobalErrorHandler } from './core/telemetry/global-error-handler';
import { PwaService } from './core/pwa/pwa.service';
import { PushService } from './core/pwa/push.service';
import { OutboxService } from './core/offline/outbox.service';
import { PortalService } from './modules/portal/portal.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes, withPreloading(PreloadAllModules)),
    provideAnimationsAsync(),
    provideHttpClient(withInterceptors([authInterceptor])),
    providePrimeNG({
      theme: {
        preset: Aura,
        options: { darkModeSelector: '.theme-monochrome' },
      },
    }),
    // Globales para que cualquier página del portal pueda inyectarlos
    // (en la app original venían del shell; acá los proveemos a nivel app).
    MessageService,
    ConfirmationService,

    // ── Observabilidad (E1) ───────────────────────────────────────────────────
    // ErrorHandler global: toda excepción no manejada va a telemetría.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // Arranca RUM/Web Vitals + flush hooks, y registra page_view por navegación
    // (driver del funnel: por dónde entra y se mueve el cliente).
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [TelemetryService, Router, PwaService, PushService, OutboxService, PortalService],
      useFactory:
        (
          telemetry: TelemetryService,
          router: Router,
          pwa: PwaService,
          push: PushService,
          outbox: OutboxService,
          portal: PortalService,
        ) =>
        () => {
          telemetry.init();
          pwa.init();
          push.initClicks();
          void outbox.init();
          // F2: tras reproducir la cola offline, reconciliar el carrito con el server.
          outbox.replayed$.subscribe((r) => {
            if (r.synced > 0 || r.failed > 0) portal.refreshCart();
          });
          router.events
            .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
            .subscribe((e) => telemetry.track('page_view', { path: e.urlAfterRedirects }));
        },
    },

    // ── PWA (service worker) ──────────────────────────────────────────────────
    // Solo en producción (en dev rompería el HMR de ng serve). Da app shell
    // offline, carga instantánea en visitas repetidas e instalable. Registra
    // tras estabilizar (30s) para no competir con el arranque inicial.
    provideServiceWorker('ngsw-worker.js', {
      enabled: environment.production,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
