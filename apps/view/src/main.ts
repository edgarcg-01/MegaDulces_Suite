import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// One-time migration: si quedó registrado el SW custom legacy (`sw-offline.js`)
// de un deploy previo, lo desregistramos y borramos sus caches. ngsw toma
// el control vía `provideServiceWorker` en app.config.ts.
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs
      .filter((r) => r.active?.scriptURL?.endsWith('/assets/sw-offline.js'))
      .forEach((r) => r.unregister());
  });
  if ('caches' in window) {
    caches.keys().then((keys) => {
      keys
        .filter((k) => k.startsWith('trademarketing-'))
        .forEach((k) => caches.delete(k));
    });
  }
}

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
