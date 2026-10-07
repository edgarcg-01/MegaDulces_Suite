import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor — empaquetado nativo de la app del VENDEDOR (apps/vendor).
 * webDir apunta al output del build de Angular (application builder → /browser).
 *
 * Background tracking: el plugin @capacitor-community/background-geolocation NO
 * se configura acá; sus permisos van en android/app/src/main/AndroidManifest.xml
 * (ACCESS_FINE_LOCATION, ACCESS_BACKGROUND_LOCATION, FOREGROUND_SERVICE +
 * la notificación del foreground service). Ver el plan de empaquetado.
 *
 * Flujo: `nx build vendor` → `npx cap sync android` → abrir/buildear en Android Studio.
 */
const config: CapacitorConfig = {
  appId: 'com.megadulces.vendedor',
  appName: 'Mega Dulces Vendedor',
  webDir: 'dist/apps/vendor/browser',
};

export default config;
