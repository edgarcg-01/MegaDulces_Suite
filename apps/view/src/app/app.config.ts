import { ApplicationConfig, isDevMode, provideZoneChangeDetection } from '@angular/core';

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
import Aura from '@primeng/themes/aura';
import { ConfirmationService } from 'primeng/api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withPreloading(SelectivePreloadStrategy)),
    provideAnimationsAsync(),
    provideHttpClient(
      withInterceptors([authInterceptor])
    ),
    providePrimeNG({
      theme: {
        preset: Aura,
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
