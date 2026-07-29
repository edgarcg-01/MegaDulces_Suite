import { ApplicationConfig, LOCALE_ID, isDevMode, provideZonelessChangeDetection } from '@angular/core';
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
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './app.routes';
import { authInterceptor } from './core/http/auth.interceptor';
import { SelectivePreloadStrategy } from './core/strategies/selective-preload.strategy';

import { providePrimeNG } from 'primeng/config';
import { OperationsPreset } from './core/theme/operations-preset';
import { ConfirmationService } from 'primeng/api';

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless (Angular 22): la CD depende de signals/Resource API, no de zone.js.
    // zone.js sigue en polyfills como no-op hasta validar en runtime; luego se quita (bundle).
    provideZonelessChangeDetection(),
    { provide: LOCALE_ID, useValue: 'es-MX' },
    // v22 cambió el default de paramsInheritanceStrategy a 'always'; preservamos
    // 'emptyOnly' (comportamiento Angular 18) para no heredar params de rutas padre.
    provideRouter(
      routes,
      withPreloading(SelectivePreloadStrategy),
      withRouterConfig({ paramsInheritanceStrategy: 'emptyOnly' }),
    ),
    provideAnimationsAsync(),
    provideHttpClient(withXhr(), 
      withInterceptors([authInterceptor])
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
