#!/usr/bin/env node
// [PDV.6] Junta las fichas de `censo-caja.ps1` y contesta lo que la fase necesita del hardware:
// cuántas cajas tienen la impresora de tickets por COM (la gaveta va por el navegador) y cuántas
// necesitan el agente local (D-I3), qué ancho ve el navegador (PDV.UI.8), si el lector manda Enter,
// si hay segunda pantalla para el cliente y la latencia a md.
//
//   node ops/cajas/consolidar-censo.js <carpeta con censo-*.json> [--universo 37]
//
// ⛔ La salida lleva nombres de equipo: NO se pega tal cual en un .md del repo (es público). Al doc
// de la fase va el resumen por conteos.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const carpeta = args.find((a) => !a.startsWith('--'));
const universo = Number(args[args.indexOf('--universo') + 1]) || 37;
if (!carpeta) {
  console.error('Uso: node ops/cajas/consolidar-censo.js <carpeta> [--universo 37]');
  process.exit(1);
}

/** Impresora de tickets por nombre. Heurística declarada: lo que no reconoce sale como «no identificada». */
const TICKET = /star|epson|tm-|tsp|bsc|bixolon|srp-|xprinter|xp-\d|\bpos\b|ticket|80\s?mm|ec-?line|3nstar|citizen|sewoo|custom|rongta|hprt/i;
const NO_TICKET = /pdf|xps|onenote|fax|brother|\bhp\b|canon|lexmark|tsc|zebra|godex|argox|label|etiqueta/i;
const ETIQUETAS = /tsc|zebra|godex|argox|label|etiqueta/i;

function tipoPuerto(puerto) {
  const p = String(puerto || '');
  if (/^COM\d+/i.test(p)) return 'COM';
  if (/^USB\d+/i.test(p) || /usb/i.test(p)) return 'USB';
  if (/^LPT\d+/i.test(p)) return 'LPT';
  if (/^(IP_|WSD|TCP)|\d+\.\d+\.\d+\.\d+/i.test(p)) return 'red';
  return 'otro';
}

/** Major de una versión «120.0.6099.71» → 120. */
const mayor = (v) => (v ? Number(String(v).split('.')[0]) || 0 : 0);

const fichas = fs
  .readdirSync(carpeta)
  .filter((f) => /^censo-.*\.json$/i.test(f))
  .map((f) => {
    try {
      return { archivo: f, ...JSON.parse(fs.readFileSync(path.join(carpeta, f), 'utf8').replace(/^﻿/, '')) };
    } catch (e) {
      return { archivo: f, error: e.message };
    }
  });

const malas = fichas.filter((f) => f.error);
const buenas = fichas.filter((f) => !f.error);

const filas = buenas.map((f) => {
  const imps = f.impresoras || [];
  const ticket = imps.filter((p) => TICKET.test(p.nombre + ' ' + p.driver) && !NO_TICKET.test(p.nombre));
  const t = ticket.find((p) => p.predeterminada) || ticket[0] || null;
  const pantallas = f.pantallas || [];
  const principal = pantallas.find((s) => s.principal) || pantallas[0] || null;
  const chrome = mayor(f.navegadores?.chrome);
  const edge = mayor(f.navegadores?.edge);
  return {
    sucursal: f.encargado?.sucursal || '¿?',
    caja: f.encargado?.caja || '¿?',
    equipo: f.equipo?.nombre,
    windows: (f.equipo?.windows || '').replace('Microsoft ', ''),
    ram: f.equipo?.ram_gb,
    ancho: principal?.ancho ?? null,
    alto: principal?.alto ?? null,
    segunda: pantallas.length > 1,
    navegador: chrome >= 89 ? 'Chrome ' + chrome : edge >= 89 ? 'Edge ' + edge : chrome || edge ? 'viejo' : 'ninguno',
    ticket: t ? t.nombre : null,
    puerto: t ? tipoPuerto(t.puerto) : null,
    etiquetas: imps.some((p) => ETIQUETAS.test(p.nombre)),
    cajon: f.encargado?.cajon_en_impresora,
    lector: f.lector?.probado ? f.lector.sufijo : null,
    bascula: f.encargado?.bascula,
    ping: f.red?.ping_ms ?? null,
    suite: f.red?.salud_ms ?? null,
  };
});

const si = (v) => (v === true ? 'sí' : v === false ? 'no' : 'NO DICHO');
const nm = (v) => (v === null || v === undefined ? 'NO MEDIDO' : v);

console.log(`# Censo de cajas (PDV.6) — ${buenas.length} fichas de ${universo} cajas` + (malas.length ? ` · ${malas.length} ilegibles` : ''));
console.log('');
console.log('| Sucursal | Caja | Equipo | Windows | RAM | Pantalla | 2ª | Navegador | Impresora de tickets | Puerto | Cajón | Lector | Báscula | md ms | Suite ms |');
console.log('|---|---|---|---|--:|---|---|---|---|---|---|---|---|--:|--:|');
for (const r of filas.sort((a, b) => (a.sucursal + a.caja).localeCompare(b.sucursal + b.caja))) {
  console.log(
    `| ${r.sucursal} | ${r.caja} | ${r.equipo} | ${r.windows} | ${r.ram} | ${r.ancho ? r.ancho + '×' + r.alto : 'NO MEDIDO'} | ${r.segunda ? 'sí' : 'no'} | ${r.navegador} | ${r.ticket || 'no identificada'} | ${r.puerto || '—'} | ${si(r.cajon)} | ${r.lector || 'NO PROBADO'} | ${si(r.bascula)} | ${nm(r.ping)} | ${nm(r.suite)} |`,
  );
}

const cuenta = (fn) => filas.filter(fn).length;
console.log('');
console.log('## Lo que decide');
console.log(`- Fichas: ${buenas.length} de ${universo} (faltan ${Math.max(0, universo - buenas.length)}).`);
console.log(`- Gaveta por el navegador (impresora de tickets por COM): ${cuenta((r) => r.puerto === 'COM')}`);
console.log(`- Necesitan el agente local (USB, red o LPT): ${cuenta((r) => ['USB', 'red', 'LPT'].includes(r.puerto))}`);
console.log(`- Impresora de tickets no identificada por nombre: ${cuenta((r) => !r.ticket)} (revisar a mano con la foto)`);
console.log(`- Navegador apto (Chrome/Edge 89+): ${cuenta((r) => /^(Chrome|Edge) /.test(r.navegador))} · viejo o ninguno: ${cuenta((r) => !/^(Chrome|Edge) /.test(r.navegador))}`);
console.log(`- Ancho del navegador < 1280 px (PDV.UI.8): ${cuenta((r) => r.ancho && r.ancho < 1280)} · sin medir: ${cuenta((r) => !r.ancho)}`);
console.log(`- Segunda pantalla para el cliente: ${cuenta((r) => r.segunda)}`);
console.log(`- Lector que termina con Enter: ${cuenta((r) => r.lector === 'Enter')} · con otro: ${cuenta((r) => r.lector && r.lector !== 'Enter')} · no probado: ${cuenta((r) => !r.lector)}`);
console.log(`- Cajón a la impresora: ${cuenta((r) => r.cajon === true)} · no: ${cuenta((r) => r.cajon === false)} · no dicho: ${cuenta((r) => r.cajon == null)}`);
console.log(`- Báscula: ${cuenta((r) => r.bascula === true)}`);
for (const m of malas) console.log(`- ⚠️ ${m.archivo}: no se pudo leer (${m.error})`);
