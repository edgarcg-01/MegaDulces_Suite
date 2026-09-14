'use strict';
/* eslint-disable no-console */
/**
 * `[SN.23]` — **Qué le muestra de verdad la pantalla principal a cada una de las 122 personas.**
 *
 * READ-ONLY, contra PROD. La landing se diseñó, se midió por ROL (36 roles, §7 de la fase) y se
 * probó con casos armados a mano. Lo que nunca se midió es lo único que importa: **persona por
 * persona, ¿qué ve al entrar?** Un rol con 11 destinos no dice nada de la cuenta que tiene ese rol
 * y ningún permiso efectivo.
 *
 * Tres preguntas, y las tres son sobre pantallas que fallan en silencio:
 *
 *   1. **¿A quién le queda la pantalla VACÍA?** Sin puertas y sin trabajo no hay nada que hacer
 *      ahí: la persona entra, lee un estado declarado y se va. Es el peor resultado posible de la
 *      pantalla que abre la suite, y hoy nadie lo mide.
 *   2. **¿A quién le queda SÓLO el catálogo?** Puertas sí, trabajo no. La mitad izquierda —la que
 *      da nombre a la pantalla— está vacía para esa gente.
 *   3. **¿A quién le repartieron trabajo que NO puede abrir?** Responsabilidad declarada cuya
 *      cola su permiso no abre: se le asignó algo que no va a ver nunca. Medido en `[SN.21]`: 3
 *      supervisores responden de `comercial.thot` sin `COMMERCIAL_THOT_GESTIONAR`.
 *
 * ⛔ El mapa de la suite se carga del `.ts` REAL (ts-node), no de una copia: una reimplementación
 * mediría mi reimplementación. Mismo patrón que `suite-map-visibility-report.js`.
 *
 * ⛔ La URL NO se imprime nunca. `DATABASE_URL_NEW` apunta a la réplica de pruebas; acá se resuelve
 * `FLEET_DB_URL` dentro de node y se verifica el destino antes de medir.
 *
 * Uso:  node database/scripts/sn-landing-censo.js
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { Client } = require('pg');

const DST = process.env.FLEET_DB_URL;
if (!DST) {
  console.error('Falta FLEET_DB_URL en .env (es la URL de PROD; DATABASE_URL_NEW es platform_test).');
  process.exit(1);
}

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const AUTHZ = path.resolve(__dirname, '../../libs/contracts/src/authz');
const { visibleSuiteMap, primaryDestinations } = require(path.join(AUTHZ, 'suite-map.ts'));
const USERS = path.resolve(__dirname, '../../libs/trade/src/lib/users');

/** Igual que en `sn-delegacion-impacto.js`: los ids salen del registro, el `anyOf` vive acá. */
const ANY_OF = {
  'caducidades-mias': ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'],
  cuadre: ['RECONCILIATION_VER'],
  'finanzas-hallazgos': ['FINANCE_AI_CHAT'],
  'maat-acciones': ['FINANCE_AI_CHAT'],
  'thot-acciones': ['COMMERCIAL_THOT_GESTIONAR'],
  'compras-hallazgos': ['COMPRAS_HALLAZGOS_VER'],
  'flota-alertas': ['LOGISTICS_FLEET_VER'],
  'conciliacion-bancos-ingresos': ['FINANCE_BANK_VER'],
  'conciliacion-caja-ingresos': ['FINANCE_BANK_VER'],
  'conciliacion-bancos-egresos': ['FINANCE_BANK_VER'],
  'conciliacion-caja-egresos': ['FINANCE_BANK_VER'],
  'libro-de-compras': ['FISCAL_PURCHASE_BOOK_VER'],
};

function elementos(src, marcador) {
  const i = src.indexOf(marcador);
  if (i < 0) throw new Error(`no se encontró "${marcador}"`);
  const cuerpo = src.slice(i + marcador.length);
  const fin = cuerpo.indexOf('\n];');
  return cuerpo.slice(0, fin < 0 ? cuerpo.length : fin).split(/\n  \},?\n/).filter((b) => /\bid: '/.test(b));
}
function leerRegistro(archivo, marcador) {
  const src = fs.readFileSync(path.join(USERS, archivo), 'utf8');
  return elementos(src, marcador).map((b) => {
    const id = /\bid: '([^']+)'/.exec(b)[1];
    if (!ANY_OF[id]) throw new Error(`el registro trae "${id}" y ANY_OF de este script no lo tiene`);
    return {
      id,
      resp: (/\bresponsabilidad: '([^']+)'/.exec(b) || [])[1] || null,
      alcance: (/\balcance: '([^']+)'/.exec(b) || [])[1] || null,
      retirada: /\bretirada:/.test(b),
      anyOf: ANY_OF[id],
    };
  });
}
const BANDEJAS = leerRegistro('me-work.ts', 'export const BANDEJAS: readonly BandejaDef[] = [');
const CICLOS = leerRegistro('me-cycles.ts', 'export const CICLOS: readonly CicloDef[] = [');

/** Las 4 fuentes de tarea con su filtro de "abierto" (`libs/contracts/src/work/task.contract.ts`). */
const FUENTES = [
  { t: 'finance.recon_tasks', col: 'assigned_to', filtro: "status IN ('pendiente','en_proceso')" },
  { t: 'commercial.supervisor_tasks', col: 'assigned_to_user', filtro: "status IN ('pending')" },
  { t: 'commercial.inventory_count_assignments', col: 'user_id', filtro: 'true' },
  { t: 'trade.daily_assignments', col: 'user_id', filtro: "status IN ('pendiente') AND day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int" },
];

const PLATFORM_ADMIN = ['superadmin', 'admin'];
const n = (v) => Number(v ?? 0).toLocaleString('es-MX');
async function existe(c, rel) {
  return (await c.query('SELECT to_regclass($1) AS t', [rel])).rows[0].t !== null;
}

(async () => {
  const c = new Client({ connectionString: DST, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let salida = 0;
  try {
    const { db } = (await c.query('SELECT current_database() AS db')).rows[0];
    console.log(`\n═══ [SN.23] Censo de la pantalla principal, persona por persona ═══`);
    console.log(`destino: db=${db}`);
    if (db !== 'railway') {
      console.error(`\n✗ ABORTADO: se esperaba PROD (db='railway') y se encontró '${db}'.`);
      process.exit(2);
    }

    const padron = await c.query(
      `SELECT u.id, u.username, u.nombre, lower(u.role_name) AS rol, u.position_code
         FROM identity.users u WHERE u.deleted_at IS NULL AND u.activo = true ORDER BY u.username`,
    );
    const gente = new Map(padron.rows.map((r) => [r.id, {
      ...r, perms: {}, esAdmin: PLATFORM_ADMIN.includes(r.rol), resp: new Set(), tareas: 0,
    }]));
    console.log(`usuarios activos: ${n(gente.size)}`);

    const perms = await c.query(`
      WITH roles AS (
        SELECT u.id AS user_id, u.tenant_id, r.role_name FROM identity.users u
          JOIN identity.user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
         WHERE u.deleted_at IS NULL AND u.activo = true
        UNION
        SELECT u.id, u.tenant_id, u.role_name FROM identity.users u
         WHERE u.deleted_at IS NULL AND u.activo = true)
      SELECT ro.user_id, k.key AS permiso
        FROM roles ro
        JOIN identity.role_permissions rp ON rp.tenant_id = ro.tenant_id
         AND lower(rp.role_name) = lower(ro.role_name) AND rp.deleted_at IS NULL
        CROSS JOIN LATERAL jsonb_each(rp.permissions) AS k(key, val)
       WHERE k.val = 'true'::jsonb
       UNION
      SELECT up.user_id, up.permission_key FROM identity.user_permissions up WHERE up.allow = true`);
    for (const r of perms.rows) gente.get(r.user_id)?.perms[r.permiso] === undefined && (gente.get(r.user_id).perms[r.permiso] = true);

    // Responsabilidades vigentes (puesto + persona, la de persona gana).
    for (const r of (await c.query(
      `SELECT u.id, pr.responsibility_key AS k FROM identity.position_responsibilities pr
         JOIN identity.users u ON u.position_code = pr.position_code AND u.tenant_id = pr.tenant_id
        WHERE pr.deleted_at IS NULL AND u.deleted_at IS NULL AND u.activo = true`)).rows) {
      gente.get(r.id)?.resp.add(r.k);
    }
    for (const r of (await c.query(
      `SELECT user_id AS id, responsibility_key AS k, accion FROM identity.user_responsibilities
        WHERE deleted_at IS NULL AND valid_from <= CURRENT_DATE
          AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`)).rows) {
      const g = gente.get(r.id);
      if (!g) continue;
      if (r.accion === 'resta') g.resp.delete(r.k); else g.resp.add(r.k);
    }

    // Tareas abiertas por persona (4 consultas, no 4 por persona).
    for (const f of FUENTES) {
      if (!(await existe(c, f.t))) continue;
      for (const row of (await c.query(
        `SELECT t.${f.col} AS id, count(*)::int AS n FROM ${f.t} t
          WHERE t.${f.col} IS NOT NULL AND ${f.filtro} GROUP BY 1`)).rows) {
        const g = gente.get(row.id);
        if (g) g.tareas += row.n;
      }
    }

    // ── El censo ──────────────────────────────────────────────────────────────────────────────
    // Qué actividades tienen dueño en TODO el tenant (la mitad que define la regla por cola).
    const conDueno = new Set();
    for (const x of gente.values()) for (const k of x.resp) conDueno.add(k);

    const ve = (g, it) => g.esAdmin || it.anyOf.some((k) => g.perms[k] === true);
    const esMio = (g, it) => !!it.resp && g.resp.has(it.resp);

    const vacias = [];        // ni puertas ni trabajo
    const soloCatalogo = [];  // puertas sí, trabajo no
    const repartoCiego = [];  // responsabilidad cuya cola su permiso NO abre
    const repartoApagado = []; // responsabilidad cuya cola apagamos nosotros (retirada)
    const histo = new Map();

    for (const g of gente.values()) {
      const vis = visibleSuiteMap(g.perms, g.esAdmin, g.rol);
      const puertas = primaryDestinations(vis).length;
      const entradas = vis.spaces.reduce((a, s) => a + s.entries.length, 0);
      histo.set(puertas, (histo.get(puertas) ?? 0) + 1);

      /*
       * `[SN.24]` La regla vigente, POR COLA: si la actividad tiene dueño, sólo su dueño la ve;
       * si no tiene dueño, es compartida. Y la cola que es TUYA pero tu permiso no abre **se
       * muestra igual** (sin enlace), así que cuenta como trabajo: si no contara, el censo diría
       * que esas 5 personas no tienen nada y es al revés — tienen algo que no pueden abrir.
       */
      const ajena = (it) => it.resp && conDueno.has(it.resp) && !esMio(g, it) && it.alcance !== 'mio';
      const bandFinal = BANDEJAS.filter(
        (b) => !b.retirada && (ve(g, b) || esMio(g, b)) && !ajena(b),
      );
      const cicFinal = CICLOS.filter((x) => (ve(g, x) || esMio(g, x)) && !ajena(x));
      const trabajo = g.tareas + bandFinal.length + cicFinal.length;

      if (entradas === 0 && trabajo === 0) vacias.push({ g, puertas, entradas });
      else if (trabajo === 0) soloCatalogo.push({ g, entradas });

      /*
       * Reparto que no se ve, separado por CAUSA — y la separación no es cosmética: la primera
       * versión de este bloque las mezclaba y acusaba **14** personas, cuando 10 de ellas están
       * ciegas por una decisión NUESTRA (la bandeja de `finanzas.hallazgos` se retiró en
       * `[SN.18]`), no por un permiso que les falte. Publicar 14 habría inflado el hallazgo 3×.
       */
      const ciegas = [];
      const apagadas = [];
      for (const k of g.resp) {
        const colas = [...BANDEJAS, ...CICLOS].filter((it) => it.resp === k);
        if (!colas.length) continue;                       // clave sin cola: la vigila el smoke
        const vivas = colas.filter((it) => !it.retirada);
        if (!vivas.length) apagadas.push(k);                // la apagamos nosotros
        else if (!vivas.some((it) => ve(g, it))) ciegas.push(k); // le falta el permiso
      }
      if (ciegas.length) repartoCiego.push({ g, ciegas });
      if (apagadas.length) repartoApagado.push({ g, apagadas });
    }

    console.log(`\n── 1. Puertas por persona ──`);
    for (const k of [...histo.keys()].sort((a, b) => a - b)) {
      console.log(`   ${String(k).padStart(2)} destino(s) primario(s): ${n(histo.get(k))} persona(s)`);
    }

    console.log(`\n── 2. ⛔ Pantalla VACÍA (sin puertas y sin trabajo): ${n(vacias.length)} ──`);
    for (const v of vacias) {
      console.log(`   ${v.g.username.padEnd(24)} rol=${String(v.g.rol).padEnd(22)} puesto=${v.g.position_code || '—'}  permisos=${Object.keys(v.g.perms).length}`);
    }
    if (vacias.length) salida = 1;

    console.log(`\n── 3. Sólo catálogo (puertas sí, «Tu trabajo» vacío): ${n(soloCatalogo.length)} de ${n(gente.size)} ──`);
    const porRol = new Map();
    for (const s of soloCatalogo) porRol.set(s.g.rol, (porRol.get(s.g.rol) ?? 0) + 1);
    for (const [rol, cuantos] of [...porRol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`   ${String(rol).padEnd(26)} ${n(cuantos)}`);
    }

    console.log(`\n── 4. ⚠️ Reparto que su PERMISO no abre: ${n(repartoCiego.length)} persona(s) ──`);
    console.log(`   Responden de algo cuya pantalla no pueden abrir: se les repartió trabajo invisible.`);
    for (const r of repartoCiego) {
      console.log(`   ${r.g.username.padEnd(24)} rol=${String(r.g.rol).padEnd(20)} responde de: ${r.ciegas.join(', ')}`);
    }

    console.log(`\n── 4b. Reparto cuya cola apagamos NOSOTROS: ${n(repartoApagado.length)} persona(s) ──`);
    console.log(`   NO es un defecto de permisos: la responsabilidad es real y la bandeja está`);
    console.log(`   retirada a propósito (\`[SN.18]\`). Se separa porque mezclarlas inflaba el hallazgo 3×.`);
    for (const r of repartoApagado) {
      console.log(`   ${r.g.username.padEnd(24)} ${r.apagadas.join(', ')}`);
    }

    console.log(`\n═══ fin ═══\n`);
  } catch (e) {
    console.error(`\n✗ error: ${e.message}`);
    salida = 2;
  } finally {
    await c.end();
  }
  process.exitCode = salida;
})();
