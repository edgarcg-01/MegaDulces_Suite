import { ApplicationConfig, isDevMode, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideServiceWorker } from '@angular/service-worker';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import { ConfirmationService, MessageService } from 'primeng/api';

import { appRoutes } from './app.routes';
import { authInterceptor } from './core/http/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(appRoutes),
    provideHttpClient(withXhr(), withInterceptors([authInterceptor])),
    provideAnimationsAsync(),
    providePrimeNG({
      // PrimeNG 22 (PrimeUI) exige license key offline; Community tier. Sin key → banner "Invalid PrimeUI License".
      license: 'eyJpZCI6ImZiNDJlODllLTU1MDktNGExYy1iNjM3LTg1MmI3MDkwMmY4ZSIsInByb2R1Y3QiOiJwcmltZXVpIiwidGllciI6ImNvbW11bml0eSIsInR5cGUiOiJkZXYiLCJpYXQiOjE3ODUzNjQxMDIsImV4cCI6MTgxNjkwMDEwMn0.7e5-4WbCFb7qYfs15Y4P471RfDf0mNqncOetfI_JwmQLHfpfYTINngD9SsYybbdvNj9kfCXHfjZQkcim1VUnBQ',
      theme: { preset: Aura, options: { darkModeSelector: '.theme-monochrome' } },
    }),
    ConfirmationService,
    MessageService,
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
