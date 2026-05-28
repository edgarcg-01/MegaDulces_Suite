import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// PWA Service Worker: ONLY en host de prod/preview, NUNCA en localhost.
// En dev cachea main.js (cache-first) → cuando agregás rutas nuevas (ej /portal/login),
// el bundle stale no las tiene y Angular tira al wildcard → /login. Bug vivido 2026-05-26.
const __isLocalhost =
  typeof window !== 'undefined' && window.location.hostname === 'localhost';

if (!__isLocalhost && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/assets/sw-offline.js')
      .then((registration) => {
        console.log('[PWA] SW registered: ', registration);

        // Check for updates - silent auto-update
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New version available - update silently without user notification
                console.log('[PWA] New version available, updating in background');
                newWorker.postMessage({ type: 'SKIP_WAITING' });
                localStorage.setItem('sw-update-pending', 'true');
              }
            });
          }
        });
      })
      .catch((registrationError) => {
        console.log('[PWA] SW registration failed: ', registrationError);
      });
  });
} else if (__isLocalhost && 'serviceWorker' in navigator) {
  // En localhost: desregistrar cualquier SW residual de sesiones previas y limpiar caches.
  // Sin esto, el SW viejo sigue interceptando requests aunque ya no lo registremos.
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister().then(() => console.log('[PWA dev] SW unregistered')));
  });
  if ('caches' in window) {
    caches.keys().then((keys) =>
      keys.forEach((k) => caches.delete(k).then(() => console.log('[PWA dev] cache cleared:', k))),
    );
  }
}

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
