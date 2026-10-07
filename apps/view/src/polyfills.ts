// App ZONELESS (Angular 22): `provideZonelessChangeDetection()` en app.config maneja el
// change detection por señales, así que Zone.js NO se necesita y se quitó de acá (antes había
// `import 'zone.js'`). Beneficio: ~13 kB menos + arranque más rápido (Zone parcheaba todas las
// APIs async al boot). NgZone queda como NoopNgZone → los `zone.run()`/`runOutsideAngular()`
// existentes son no-ops que solo ejecutan la función (siguen funcionando). Si en el futuro se
// necesita un polyfill real (browser viejo, etc.), va acá.
export {};
