import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
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
}

bootstrapApplication(AppComponent, appConfig).catch((err) =>
  console.error(err),
);
