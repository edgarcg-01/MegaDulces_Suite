/* eslint-disable no-console */
/**
 * Instalador del servicio de Windows para el POLLER de tickets en vivo (Opción A).
 *
 * Registra `live-tickets-poller.js` como SERVICIO DE WINDOWS via node-windows:
 *   - corre headless (SIN ventana de consola),
 *   - arranca solo con la máquina (boot),
 *   - se AUTO-REINICIA si crashea (política wait/grow/maxRestarts),
 *   - logs a archivo en `logs/` (el wrapper de node-windows captura stdout/stderr).
 *
 * Requisitos:
 *   1. Ejecutar en una consola ELEVADA (Administrador). Crear servicios necesita admin.
 *   2. Copiar `service.env.example` → `service.env` y completar STORE_INGEST_URL / _KEY.
 *
 * Uso:
 *   node database/importers/kepler/install-service.js
 *
 * Desinstalar:
 *   node database/importers/kepler/uninstall-service.js
 */
const path = require('path');
const fs = require('fs');
const { Service } = require('node-windows');

const HERE = __dirname;
const ENV_PATH = path.join(HERE, 'service.env');
const SCRIPT = path.join(HERE, 'live-tickets-poller.js');
const LOG_DIR = path.join(HERE, 'logs');

// --- 1. Cargar y validar config -------------------------------------------
if (!fs.existsSync(ENV_PATH)) {
  console.error(`\n✗ Falta ${ENV_PATH}\n  Copiá service.env.example → service.env y completá los valores de PROD.\n`);
  process.exit(1);
}
require('dotenv').config({ path: ENV_PATH });

const cfg = {
  STORE_INGEST_URL: process.env.STORE_INGEST_URL,
  STORE_INGEST_KEY: process.env.STORE_INGEST_KEY,
  POLL_SECONDS: process.env.POLL_SECONDS || '60',
  WINDOW_MINUTES: process.env.WINDOW_MINUTES || '5',
};

const problems = [];
if (!cfg.STORE_INGEST_URL || /TU-API-PROD/.test(cfg.STORE_INGEST_URL)) problems.push('STORE_INGEST_URL sin definir (o dejaste el placeholder).');
if (!cfg.STORE_INGEST_KEY || /CAMBIAME/.test(cfg.STORE_INGEST_KEY)) problems.push('STORE_INGEST_KEY sin definir (o dejaste el placeholder).');
if (!/^https:\/\//.test(cfg.STORE_INGEST_URL || '')) problems.push('STORE_INGEST_URL debería ser https:// (la clave viaja en el header).');
if (problems.length) {
  console.error('\n✗ Config inválida en service.env:');
  for (const p of problems) console.error('   - ' + p);
  console.error('');
  process.exit(1);
}

if (!fs.existsSync(SCRIPT)) {
  console.error(`\n✗ No encuentro el poller: ${SCRIPT}\n`);
  process.exit(1);
}
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// --- 2. Definir el servicio ------------------------------------------------
const svc = new Service({
  name: 'Kepler Live Poller',
  description: 'Empuja tickets de venta Kepler (on-prem) → API de PROD cada minuto. Sin consola, auto-restart.',
  script: SCRIPT,
  logpath: LOG_DIR,
  // Política de reinicio: espera 2s, crece 0.5x por reintento consecutivo,
  // hasta 60 reinicios en la ventana; luego marca el servicio como fallido.
  wait: 2,
  grow: 0.5,
  maxRestarts: 60,
  env: Object.entries(cfg).map(([name, value]) => ({ name, value: String(value) })),
});

// --- 3. Hooks --------------------------------------------------------------
svc.on('install', () => {
  console.log('✓ Servicio instalado. Arrancando…');
  svc.start();
});
svc.on('alreadyinstalled', () => {
  console.log('ℹ El servicio ya estaba instalado. Para reconfigurar: uninstall-service.js y volvé a instalar.');
});
svc.on('start', () => {
  console.log(`✓ "Kepler Live Poller" corriendo.`);
  console.log(`   Cadencia : cada ${cfg.POLL_SECONDS}s (ventana ${cfg.WINDOW_MINUTES}min)`);
  console.log(`   Destino  : ${cfg.STORE_INGEST_URL}`);
  console.log(`   Logs     : ${LOG_DIR}`);
  console.log(`   Gestión  : services.msc  ó  net stop/start "Kepler Live Poller"`);
});
svc.on('error', (e) => console.error('✗ Error del servicio:', e));

console.log('Instalando servicio "Kepler Live Poller" (requiere consola de Administrador)…');
svc.install();
