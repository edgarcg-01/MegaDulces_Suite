#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[CT.9]` CANDADO: el handle que dice "producción" tiene que SER producción.
 *
 * ── Qué lo obliga ───────────────────────────────────────────────────────────────────────────
 * Medido el 2026-09-25, tres días después de mudar prod de Railway a `md`: `FLEET_DB_URL`
 * seguía apuntando a Railway, **que no se apagó**. Los dos clústeres tienen una base llamada
 * `railway`, los dos responden, y el equivocado va 23 migraciones atrás (838 contra 861). Un
 * guion que pide "prod" no falla: **triunfa en el lugar equivocado**.
 *
 * Lo peor que arrastró: la suite de regresión lee `FLEET_DB_URL` ANTES que `DATABASE_URL_NEW`,
 * así que desde el corte estuvo validando el clúster viejo. Ningún verde de esos días dice lo
 * que parecía decir.
 *
 * ── Qué comprueba ───────────────────────────────────────────────────────────────────────────
 *   1. El destino de prod resuelve al clúster de prod (por `system_identifier`, no por el
 *      nombre de la variable ni por el de la base — los dos mienten).
 *   2. Esa cuenta NO puede escribir. Es lo que vuelve el arreglo estructural: un guion de
 *      reporte apuntado a prod no puede mutarla ni por accidente.
 *   3. Cuenta —y lo DECLARA— cuántos consumidores siguen leyendo `FLEET_DB_URL` a secas.
 *
 * ⚠️ Si no hay red hasta prod, esto reporta **NO MEDIDO** y sale 0. No se pinta verde algo que
 * no se pudo comprobar, y tampoco se rompe el trabajo de quien no tiene acceso (ADR-056).
 *
 *   node scripts/check-prod-target.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env') });

const { PROD_CLUSTER_ID, CONOCIDOS, urlDeProd, sinClave, medirDestino, explicar } =
  require(path.join(RAIZ, 'database', 'scripts', 'lib', 'destino-prod.js'));

/** Cuántos archivos siguen usando `FLEET_DB_URL` como si fuera prod. */
function consumidoresViejos() {
  const out = [];
  const caminar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.nx', '.angular'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) caminar(p);
      else if (e.name.endsWith('.js') && !e.name.startsWith('check-prod-target')) {
        const s = fs.readFileSync(p, 'utf8');
        if (s.includes('FLEET_DB_URL') && !s.includes('PROD_DB_URL')) {
          out.push(path.relative(RAIZ, p).split(path.sep).join('/'));
        }
      }
    }
  };
  for (const d of ['database', 'scripts']) {
    const dir = path.join(RAIZ, d);
    if (fs.existsSync(dir)) caminar(dir);
  }
  return out;
}

(async () => {
  console.log('[CT.9] El handle que dice "producción", ¿es producción?\n');

  const viejos = consumidoresViejos();
  const url = urlDeProd();

  if (!url) {
    console.log('  ⊘ NO MEDIDO — no hay ningún destino de prod configurado.');
    console.log('     Definí `PROD_DB_URL` en .env (ops/prod/README.md §2.2). Sin eso, este');
    console.log('     candado no puede afirmar nada.');
    if (viejos.length) {
      console.log(`\n  ⚠️ ${viejos.length} archivo(s) usan \`FLEET_DB_URL\` como si fuera prod.`);
    }
    process.exit(0);
  }

  console.log(`  destino configurado : ${sinClave(url)}`);

  const knex = require(path.join(RAIZ, 'node_modules', 'knex'))({
    client: 'pg', connection: url, pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 12000,
  });

  let m;
  try {
    m = await medirDestino(knex);
  } catch (e) {
    await knex.destroy().catch(() => {});
    console.log(`\n  ⊘ NO MEDIDO — no se pudo conectar: ${e.message.slice(0, 120)}`);
    console.log('     Puede ser falta de red o de credencial. No se aprueba ni se reprueba.');
    process.exit(0);
  }
  await knex.destroy().catch(() => {});

  console.log(`  clúster conectado   : ${m.id}  (${m.conocido})`);
  console.log(`  cuenta              : ${m.usuario}  · solo lectura: ${m.soloLectura ? 'sí' : 'NO'}`);
  if (viejos.length) console.log(`  todavía en FLEET_DB_URL: ${viejos.length} archivo(s)`);
  console.log('');

  let fallas = 0;

  if (!m.ok) {
    console.log(explicar(m));
    fallas++;
  } else {
    console.log('  ✓ el destino de prod ES el clúster de prod.');
  }

  if (m.ok && !m.soloLectura) {
    console.log(`\n  ⛔ La cuenta \`${m.usuario}\` PUEDE ESCRIBIR en producción.`);
    console.log('     El handle de prod debe ser de solo lectura: es lo que hace imposible —no');
    console.log('     improbable— que un guion de reporte la mute. Ver ops/prod/README.md §2.2.');
    fallas++;
  } else if (m.ok) {
    console.log('  ✓ la cuenta no puede escribir: un guion equivocado falla en vez de mutar prod.');
  }

  // Esto NO reprueba: es deuda declarada, no un defecto del cambio de quien corre el candado.
  if (viejos.length) {
    console.log(`\n  ⚠️ DECLARADO: ${viejos.length} archivo(s) siguen resolviendo prod por \`FLEET_DB_URL\``);
    console.log('     a secas, sin pasar por la compuerta de identidad. Mientras esa variable');
    console.log('     apunte a Railway, lo que midan es el clúster viejo. Migrarlos a');
    console.log('     `database/scripts/lib/destino-prod.js` es lo que cierra el hueco.');
    console.log('     Los 5 más pesados:');
    for (const f of viejos.slice(0, 5)) console.log(`       · ${f}`);
  }

  process.exit(fallas ? 1 : 0);
})();
