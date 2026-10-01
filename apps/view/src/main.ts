import { bootstrapApplication } from '@angular/platform-browser';
import { installNumberWheelGuard, installRowNavGuard } from '@megadulces/ui-web';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// DESIGN.md D.5: la rueda del mouse NO cambia el valor de un input numérico. Un solo listener
// cubre toda la app, incluida la pantalla que se escriba mañana. Acá pesa más que en las otras
// dos: es la app con las capturas de almacén, compras y contabilidad.
installNumberWheelGuard(document);
// `[KBD.1]` Las teclas de una fila navegable NO se le roban a un campo que vive adentro.
// `pSelectableRow` de PrimeNG escucha en el `<tr>` y conmuta sobre `event.code` SIN mirar
// `event.target`, asi que un `Space` tecleado en un input de esa fila selecciona el renglon y
// ademas hace `preventDefault()`: no se puede escribir un espacio. Igual con `Enter` (abre el
// detalle), `Home`/`End` (saltan de fila) y las flechas (chocan con DESIGN D.5). Un solo
// listener en fase de CAPTURA, por la misma razon que el de la rueda: una directiva hay que
// acordarse de importarla, y son 153 tablas.
installRowNavGuard(document);

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
