import { ApplicationConfig, LOCALE_ID, isDevMode, provideZoneChangeDetection } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';

// Sin esto, CurrencyPipe/DatePipe/DecimalPipe caen a en-US en silencio (DESIGN.md §10).
registerLocaleData(localeEsMx);

const isCapacitorNative = (): boolean =>
  typeof window !== 'undefined' &&
  (window.location.protocol === 'capacitor:' ||
    !!(window as any).Capacitor?.isNativePlatform?.());

import { provideRouter, withPreloading } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
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
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: LOCALE_ID, useValue: 'es-MX' },
    provideRouter(routes, withPreloading(SelectivePreloadStrategy)),
    provideAnimationsAsync(),
    provideHttpClient(
      withInterceptors([authInterceptor])
    ),
    providePrimeNG({
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
