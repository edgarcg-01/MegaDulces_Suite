/* eslint-disable no-console */
/**
 * Desinstala el servicio "Kepler Live Poller" (par de install-service.js).
 * Ejecutar en consola ELEVADA (Administrador):
 *   node database/importers/kepler/uninstall-service.js
 */
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Kepler Live Poller',
  script: path.join(__dirname, 'live-tickets-poller.js'),
});

svc.on('uninstall', () => {
  console.log('✓ Servicio "Kepler Live Poller" desinstalado.');
  console.log('  ¿Sigue listado en services.msc? →', svc.exists ? 'SÍ (reintentá)' : 'no');
});
svc.on('error', (e) => console.error('✗ Error:', e));

console.log('Desinstalando servicio "Kepler Live Poller"…');
svc.uninstall();
