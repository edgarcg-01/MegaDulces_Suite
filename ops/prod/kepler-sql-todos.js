#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[COT.37]` Corre UN archivo SQL de permisos en los servidores de Kepler, como superusuario.
 *
 *   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cot37_kdm1_update_c115.sql
 *       → REVISA (no cambia nada): se conecta a cada servidor y dice qué haría.
 *   node ops/prod/kepler-sql-todos.js <archivo.sql> --aplicar
 *       → lo corre, en una transacción por servidor, y comprueba el resultado.
 *   --servidores 01,06       sólo esos (por omisión, los 9)
 *   --usuario postgres       superusuario (por omisión: el de cada servidor, ver SERVIDORES)
 *   --ssl                    conexión cifrada (los que responden «pg_hba … sin cifrado»)
 *
 * ⛔ La contraseña se PIDE al correrlo, sin mostrarse, y no se guarda en ningún lado (el repo es
 *    PÚBLICO y el archivo de secretos no debe guardar la de superusuario: ver kepler-push-secretos.js).
 *    Si un servidor la rechaza, se pide otra vez para ése.
 * ⛔ Sólo para GRANT/REVOKE y similares: el archivo se corre tal cual en cada servidor.
 *
 * Desde esta PC se llega a los 9 (medido el 2026-11-06, puertos abiertos). Si el `pg_hba` de un
 * servidor no deja entrar al superusuario desde aquí, el script lo dice con el error de ese servidor
 * y sigue con los demás.
 *
 * Comprobación: si el archivo trae una línea `-- verificar: <SELECT que devuelve true>`, se corre
 * antes y después, y cuenta como aplicado sólo si después da `true`.
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Client } = require('pg');

/** Los mismos de ops/prod/kepler-push-secretos.js (publicadores medidos). */
const SERVIDORES = {
  '00': { host: '192.168.9.95', port: 5432, su: 'postgres' },
  '01': { host: '192.168.10.10', port: 1977, su: 'postgres' },
  '02': { host: '192.168.42.42', port: 5432, su: 'sa' },
  '03': { host: '192.168.40.40', port: 5432, su: 'postgres' },
  '04': { host: '192.168.44.44', port: 5432, su: 'postgres' },
  '05': { host: '192.168.54.54', port: 5432, su: 'postgres' },
  '06': { host: '192.168.50.50', port: 1977, su: 'postgres' },
  '07': { host: '192.168.32.32', port: 1977, su: 'postgres' },
  '08': { host: '192.168.30.30', port: 1977, su: 'postgres' },
};
/** Por nombre, nunca por código (apps/view/src/app/core/constants/store-branches.ts). */
const NOMBRE = {
  '00': 'CEDIS', '01': 'Padre Hidalgo', '02': 'La Piedad Abastos', '03': '8 Esquinas', '04': 'Yurécuaro',
  '05': 'Zamora Centro', '06': 'Canindo', '07': 'Morelia Madero', '08': 'Morelia Abastos',
};

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const archivo = args.find((a) => a.endsWith('.sql'));
const aplicar = args.includes('--aplicar');
const lista = (opt('--servidores') || Object.keys(SERVIDORES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const usuarioFijo = opt('--usuario');

if (!archivo || !fs.existsSync(archivo)) {
  console.error('Uso: node ops/prod/kepler-sql-todos.js <archivo.sql> [--aplicar] [--servidores 01,06] [--usuario postgres]');
  process.exit(2);
}
const desconocidos = lista.filter((s) => !SERVIDORES[s]);
if (desconocidos.length) { console.error(`Servidores desconocidos: ${desconocidos.join(', ')}`); process.exit(2); }

const sql = fs.readFileSync(archivo, 'utf8');
const verificar = (sql.match(/^--\s*verificar:\s*(.+)$/m) || [])[1] || null;

/** Pide una contraseña sin mostrarla (raw mode). */
function pedirClave(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(pregunta)) process.stdout.write(s); };
    rl.question(pregunta, (r) => { rl.close(); process.stdout.write('\n'); resolve(r); });
  });
}

async function conectar(s, usuario, clave) {
  const c = new Client({
    host: SERVIDORES[s].host, port: SERVIDORES[s].port, database: `md_${s}`, user: usuario, password: clave,
    connectionTimeoutMillis: 8000, statement_timeout: 30000,
    // --ssl: varios servidores responden «no hay línea en pg_hba … sin cifrado» (medido 2026-11-06):
    // su pg_hba sólo acepta al superusuario por conexión cifrada (hostssl). El certificado de Kepler
    // es propio, por eso no se valida.
    ssl: args.includes('--ssl') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  return c;
}

(async () => {
  console.log(`${aplicar ? 'APLICAR' : 'REVISAR (sin cambios)'} · ${path.basename(archivo)} · servidores ${lista.join(', ')}`);
  if (verificar) console.log(`comprobación: ${verificar}`);
  const claves = {};
  let claveComun = null;
  const resumen = [];
  for (const s of lista) {
    const usuario = usuarioFijo || SERVIDORES[s].su;
    const etiqueta = `${s} ${NOMBRE[s]}`;
    let c = null;
    for (let intento = 0; intento < 2 && !c; intento++) {
      let clave = claves[usuario] ?? claveComun;
      if (clave === null || intento > 0) {
        clave = await pedirClave(intento > 0 ? `Contraseña de ${usuario} en ${etiqueta} (la anterior no entró): ` : `Contraseña de ${usuario}: `);
      }
      try {
        c = await conectar(s, usuario, clave);
        claves[usuario] = clave;
        if (claveComun === null) claveComun = clave;
      } catch (e) {
        if (e.code !== '28P01' || intento > 0) { console.log(`✗ ${etiqueta}: no se pudo conectar (${e.code || ''} ${e.message})`); resumen.push([etiqueta, 'sin conexión']); break; }
      }
    }
    if (!c) continue;
    try {
      const yo = (await c.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).rows[0];
      const antes = verificar ? (await c.query(verificar)).rows[0] : null;
      const yaEsta = antes ? Object.values(antes)[0] === true : null;
      if (!aplicar) {
        console.log(`· ${etiqueta}: entra como ${yo.u}${yo.su ? ' (superusuario)' : ' (⚠️ NO es superusuario)'}${verificar ? ` · ya aplicado: ${yaEsta ? 'sí' : 'no'}` : ''}`);
        resumen.push([etiqueta, yaEsta ? 'ya estaba' : 'pendiente']);
        continue;
      }
      if (yaEsta) { console.log(`= ${etiqueta}: ya estaba, no se toca`); resumen.push([etiqueta, 'ya estaba']); continue; }
      await c.query('BEGIN');
      await c.query(sql);
      const despues = verificar ? Object.values((await c.query(verificar)).rows[0])[0] === true : null;
      if (verificar && !despues) { await c.query('ROLLBACK'); console.log(`✗ ${etiqueta}: corrió pero la comprobación no da true → revertido`); resumen.push([etiqueta, 'revertido']); continue; }
      await c.query('COMMIT');
      console.log(`✓ ${etiqueta}: aplicado${verificar ? ' y comprobado' : ''}`);
      resumen.push([etiqueta, 'aplicado']);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      console.log(`✗ ${etiqueta}: ${e.code || ''} ${e.message}`);
      resumen.push([etiqueta, 'error']);
    } finally {
      await c.end().catch(() => {});
    }
  }
  console.log('\nResumen:');
  for (const [s, r] of resumen) console.log(`  ${s.padEnd(22)} ${r}`);
  if (!aplicar) console.log('\nNada cambió. Para aplicar: agrega --aplicar');
})().catch((e) => { console.error('FALLO', e.message); process.exit(1); });
