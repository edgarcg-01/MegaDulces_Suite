import { bootstrapApplication } from '@angular/platform-browser';
import { installNumberWheelGuard } from '@megadulces/ui-web';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// DESIGN.md D.5: la rueda del mouse NO cambia el valor de un input numérico. Un solo listener
// cubre toda la app, incluida la pantalla que se escriba mañana. Acá pesa más que en las otras
// dos: es la app con las capturas de almacén, compras y contabilidad.
installNumberWheelGuard(document);

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
