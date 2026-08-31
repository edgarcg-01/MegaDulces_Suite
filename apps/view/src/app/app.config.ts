import { ApplicationConfig, ErrorHandler, LOCALE_ID, isDevMode, provideZonelessChangeDetection } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';

// Sin esto, CurrencyPipe/DatePipe/DecimalPipe caen a en-US en silencio (DESIGN.md §10).
registerLocaleData(localeEsMx);

const isCapacitorNative = (): boolean =>
  typeof window !== 'undefined' &&
  (window.location.protocol === 'capacitor:' ||
    !!(window as any).Capacitor?.isNativePlatform?.());

import { provideRouter, withPreloading, withRouterConfig } from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/errors/global-error-handler';
import { authInterceptor } from './core/http/auth.interceptor';
import { diagnosticsInterceptor } from './core/http/diagnostics.interceptor';
import { SelectivePreloadStrategy } from './core/strategies/selective-preload.strategy';

import { providePrimeNG } from 'primeng/config';
import { OperationsPreset } from './core/theme/operations-preset';
import { ConfirmationService } from 'primeng/api';

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless (Angular 22). NOTA: el stack overflow de /compras/pedido NO es de zoneless
    // (se reproduce igual bajo zone.js) — es una recursión real de render; ver diagnóstico en
    // compras-pedido-real (money() guard). Migración zoneless COMPLETA: zone.js removido de
    // polyfills (~13 kB menos + arranque más rápido); NgZone queda como NoopNgZone.
    provideZonelessChangeDetection(),
    { provide: LOCALE_ID, useValue: 'es-MX' },
    // Sin esto una excepción no capturada dejaba la pantalla en blanco: nada
    // que ver, nada que reportar, nada registrado.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // v22 cambió el default de paramsInheritanceStrategy a 'always'; preservamos
    // 'emptyOnly' (comportamiento Angular 18) para no heredar params de rutas padre.
    provideRouter(
      routes,
      withPreloading(SelectivePreloadStrategy),
      withRouterConfig({ paramsInheritanceStrategy: 'emptyOnly' }),
    ),
    provideHttpClient(withXhr(), 
      withInterceptors([authInterceptor, diagnosticsInterceptor])
    ),
    providePrimeNG({
      // PrimeNG 22 (PrimeUI) exige license key offline; Community tier (dev).
      // Renovación anual confirmando elegibilidad. Sin key → banner "Invalid PrimeUI License".
      license: 'eyJpZCI6ImZiNDJlODllLTU1MDktNGExYy1iNjM3LTg1MmI3MDkwMmY4ZSIsInByb2R1Y3QiOiJwcmltZXVpIiwidGllciI6ImNvbW11bml0eSIsInR5cGUiOiJkZXYiLCJpYXQiOjE3ODUzNjQxMDIsImV4cCI6MTgxNjkwMDEwMn0.7e5-4WbCFb7qYfs15Y4P471RfDf0mNqncOetfI_JwmQLHfpfYTINngD9SsYybbdvNj9kfCXHfjZQkcim1VUnBQ',
      theme: {
        preset: OperationsPreset,
        options: {
          darkModeSelector: '.theme-monochrome'
        }
      }
    }),
    ConfirmationService,
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && !isCapacitorNative(),
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
};
