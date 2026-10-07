'use strict';
/* eslint-disable no-console */
/**
 * `[SN.21]` — Qué se rompe si aplico las dos cosas que quedaron abiertas en `[SN.20]`.
 *
 * READ-ONLY, contra PROD. Dos cambios pedidos, dos mediciones, y ninguno se aplica a ciegas:
 *
 *   A. **Filtrar las BANDEJAS por lo delegado.** `[SN.20]` sólo filtraba los ciclos, y con un
 *      criterio POR REGISTRO (`mios.length > 0` dentro de `CICLOS`). Aplicado igual a las bandejas
 *      sería un **no-op**: las claves de conciliación no cubren ninguna bandeja → `mios` vacío →
 *      no filtra nada. Para que la regla signifique lo que Edgar dijo («Ivonne es SOLO INGRESOS»)
 *      la condición tiene que cruzar los dos registros.
 *
 *      ⭐ **Y esta medición descartó la versión obvia.** «Tenés alguna responsabilidad ⇒ filtrá»
 *      deja a **6 personas con la pantalla vacía**: su única delegación es `finanzas.hallazgos`,
 *      cuya bandeja está RETIRADA desde `[SN.18]` — una delegación que apunta a una superficie
 *      apagada. La regla que se implementó es la auto-limitada: *si algo de lo que VES es tuyo, se
 *      muestra sólo eso; si nada de lo que ves es tuyo, no se filtra nada*. El script aplica ésa y
 *      **verifica el invariante contra el dato real** (nadie pasa de tener algo a no tener nada),
 *      porque un invariante que sólo vive en un comentario es una intención.
 *
 *   B. **La auto-entrada.** Con UN solo destino primario la landing navega sola y quien tiene
 *      trabajo propio nunca lo ve. Esto mide cuánta gente tiene exactamente 1 destino, y de ésos
 *      cuántos se quedarían en la pantalla con el arreglo puesto — que es el costo real del cambio:
 *      cada uno de ellos deja de entrar directo a su proyecto.
 *
 * ⛔ Lo que NO se mide se DECLARA (ADR-056). Acá hay dos simplificaciones dichas en voz alta:
 *   · «ciclo propio con pendientes» se aproxima por «tiene una responsabilidad de ciclo» — medir
 *     los 12 periodos por persona costaría una consulta por persona y las dos únicas con
 *     delegación ya se midieron en `[SN.19]` con 14 meses por resolver cada una.
 *   · el permiso efectivo se arma como `unión(role_permissions de user_roles + role_name) +
 *     user_permissions allow`, SIN los `deny` — el mismo atajo que el reporte de visibilidad, y
 *     por eso sobreestima levemente a quién le aparece cada cola.
 *
 * ⛔ La URL NO se imprime nunca. `DATABASE_URL_NEW` apunta a la RÉPLICA DE PRUEBAS; acá se resuelve
 * `FLEET_DB_URL` dentro de node y se verifica el destino antes de medir.
 *
 * Uso:  node database/scripts/sn-delegacion-impacto.js
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

// ── El mapa de la suite se carga del `.ts` REAL, no de una copia ────────────────────────────────
// `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir de Nx) y falla con
// TS5011. Mismo patrón que `suite-map-visibility-report.js`.
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs',
    target: 'es2020',
    esModuleInterop: true,
    moduleResolution: 'node',
    ignoreDeprecations: '6.0',
  },
});
const AUTHZ = path.resolve(__dirname, '../../libs/contracts/src/authz');
const { visibleSuiteMap, primaryDestinations } = require(path.join(AUTHZ, 'suite-map.ts'));

const USERS = path.resolve(__dirname, '../../libs/trade/src/lib/users');

/**
 * Los registros NO se copian a mano: se leen del `.ts` (id + responsabilidad + alcance + retirada).
 * `anyOf` sí vive acá —los enums no se pueden `require` sin resolver los paths de Nx— pero un id
 * del archivo que no esté en esta tabla ABORTA la medición, así que la copia no puede quedar vieja
 * en silencio.
 */
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

/** Parte el cuerpo de un arreglo de objetos literales en sus elementos de primer nivel. */
function elementos(src, marcador) {
  const i = src.indexOf(marcador);
  if (i < 0) throw new Error(`no se encontró "${marcador}"`);
  const cuerpo = src.slice(i + marcador.length);
  const fin = cuerpo.indexOf('\n];');
  return cuerpo
    .slice(0, fin < 0 ? cuerpo.length : fin)
    .split(/\n  \},?\n/)
    .filter((b) => /\bid: '/.test(b));
}

function leerRegistro(archivo, marcador) {
  const src = fs.readFileSync(path.join(USERS, archivo), 'utf8');
  return elementos(src, marcador).map((b) => {
    const id = /\bid: '([^']+)'/.exec(b)[1];
    const label = (/\blabel: '([^']*)'/.exec(b) || [])[1] || id;
    const resp = (/\bresponsabilidad: '([^']+)'/.exec(b) || [])[1] || null;
    const alcance = (/\balcance: '([^']+)'/.exec(b) || [])[1] || null;
    const retirada = /\bretirada:/.test(b);
    if (!ANY_OF[id]) throw new Error(`el registro trae "${id}" y ANY_OF de este script no lo tiene`);
    return { id, label, resp, alcance, retirada, anyOf: ANY_OF[id] };
  });
}

const BANDEJAS = leerRegistro('me-work.ts', 'export const BANDEJAS: readonly BandejaDef[] = [');
const CICLOS = leerRegistro('me-cycles.ts', 'export const CICLOS: readonly CicloDef[] = [');

/** Las 4 fuentes de tarea, con su filtro de "abierto" (copiado de `or-landing-gap-report.js`). */
const FUENTES = [
  { t: 'finance.recon_tasks', col: 'assigned_to', filtro: "status IN ('pendiente','en_proceso')" },
  { t: 'commercial.supervisor_tasks', col: 'assigned_to_user', filtro: "status IN ('pending')" },
  { t: 'commercial.inventory_count_assignments', col: 'user_id', filtro: 'true' },
  { t: 'trade.daily_assignments', col: 'user_id', filtro: "status IN ('pendiente')" },
];

const PLATFORM_ADMIN = ['superadmin', 'admin'];
const n = (v) => Number(v ?? 0).toLocaleString('es-MX');

async function existe(c, rel) {
  const r = await c.query('SELECT to_regclass($1) AS t', [rel]);
  return r.rows[0].t !== null;
}

(async () => {
  const c = new Client({ connectionString: DST, ssl: { rejectUnauthorized: false } });
  await c.connect();
  let salida = 0;
  try {
    const ver = await c.query(
      `SELECT current_database() AS db, current_user AS usr, current_setting('server_version') AS v`,
    );
    const { db, usr, v } = ver.rows[0];
    console.log(`\n═══ [SN.21] Impacto de delegar de verdad + de no auto-entrar ═══`);
    console.log(`destino: db=${db} · usuario=${usr} · PG ${v}`);
    if (db !== 'railway') {
      console.error(`\n✗ ABORTADO: se esperaba PROD (db='railway') y se encontró '${db}'.`);
      process.exit(2);
    }
    console.log(
      `registros leídos del código: ${BANDEJAS.length} bandejas (${BANDEJAS.filter((b) => b.retirada).length} retirada) · ${CICLOS.length} ciclos`,
    );

    // ── Padrón + permiso efectivo por persona ────────────────────────────────────────────────
    const permisoEfectivo = `
      WITH roles AS (
        SELECT u.id AS user_id, u.tenant_id, r.role_name
          FROM identity.users u
          JOIN identity.user_roles r ON r.user_id = u.id AND r.tenant_id = u.tenant_id
         WHERE u.deleted_at IS NULL AND u.activo = true
         UNION
        SELECT u.id, u.tenant_id, u.role_name
          FROM identity.users u
         WHERE u.deleted_at IS NULL AND u.activo = true
      ),
      efectivo AS (
        SELECT ro.user_id, k.key AS permiso
          FROM roles ro
          JOIN identity.role_permissions rp
            ON rp.tenant_id = ro.tenant_id AND lower(rp.role_name) = lower(ro.role_name)
           AND rp.deleted_at IS NULL
          CROSS JOIN LATERAL jsonb_each(rp.permissions) AS k(key, val)
         WHERE k.val = 'true'::jsonb
         UNION
        SELECT up.user_id, up.permission_key
          FROM identity.user_permissions up WHERE up.allow = true
      )`;

    const padron = await c.query(
      `SELECT u.id, u.username, u.nombre, lower(u.role_name) AS rol, u.position_code
         FROM identity.users u
        WHERE u.deleted_at IS NULL AND u.activo = true
        ORDER BY u.username`,
    );
    const gente = new Map(
      padron.rows.map((r) => [
        r.id,
        { ...r, perms: {}, esAdmin: PLATFORM_ADMIN.includes(r.rol), resp: new Set() },
      ]),
    );
    console.log(`usuarios activos: ${n(gente.size)}`);

    const perms = await c.query(`${permisoEfectivo} SELECT user_id, permiso FROM efectivo`);
    for (const r of perms.rows) {
      const g = gente.get(r.user_id);
      if (g) g.perms[r.permiso] = true;
    }

    // ── 1. El padrón de delegación HOY ────────────────────────────────────────────────────────
    console.log(`\n── 1. Quién tiene algo delegado (la condición que enciende el filtro) ──`);
    const dePuesto = await c.query(
      `SELECT u.id, pr.responsibility_key AS k
         FROM identity.position_responsibilities pr
         JOIN identity.users u
           ON u.position_code = pr.position_code AND u.tenant_id = pr.tenant_id
        WHERE pr.deleted_at IS NULL AND u.deleted_at IS NULL AND u.activo = true`,
    );
    const dePersona = await c.query(
      `SELECT user_id AS id, responsibility_key AS k, accion
         FROM identity.user_responsibilities
        WHERE deleted_at IS NULL
          AND valid_from <= CURRENT_DATE
          AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`,
    );
    for (const r of dePuesto.rows) gente.get(r.id)?.resp.add(r.k);
    for (const r of dePersona.rows) {
      const g = gente.get(r.id);
      if (!g) continue;
      if (r.accion === 'resta') g.resp.delete(r.k);
      else g.resp.add(r.k);
    }
    console.log(`   por PUESTO (position_responsibilities): ${n(dePuesto.rowCount)} fila(s)`);
    console.log(`   por PERSONA (user_responsibilities, vigentes): ${n(dePersona.rowCount)} fila(s)`);
    const delegados = [...gente.values()].filter((g) => g.resp.size > 0);
    console.log(
      `   → ${n(delegados.length)} de ${n(gente.size)} personas encenderían el filtro (${((delegados.length / gente.size) * 100).toFixed(1)}%)`,
    );
    if (delegados.length === 0) {
      console.log(`   ⚠️  Con cero delegaciones el filtro es un NO-OP: nadie vería un cambio hoy.`);
    }

    // ── 2. Qué pierde cada persona delegada ──────────────────────────────────────────────────
    console.log(`\n── 2. Antes / después, persona por persona ──`);
    console.log(
      `   regla aplicada: si algo de lo que VES es tuyo, se muestra sólo eso; si nada de lo que\n` +
        `   ves es tuyo, no se filtra nada. Se compara contra la versión INGENUA («tenés alguna\n` +
        `   responsabilidad ⇒ filtrá») para dejar por escrito por qué se descartó.`,
    );
    const ve = (g, item) => g.esAdmin || item.anyOf.some((k) => g.perms[k] === true);
    const esMio = (g, item) => !!item.resp && g.resp.has(item.resp);
    const vaciadosPorLaIngenua = [];

    for (const g of delegados) {
      const bandejasHoy = BANDEJAS.filter((b) => !b.retirada && ve(g, b));
      const propias = bandejasHoy.filter((b) => b.alcance === 'mio');
      const compartidas = bandejasHoy.filter((b) => b.alcance !== 'mio');
      const ciclosHoy = CICLOS.filter((cc) => ve(g, cc));

      // La condición REAL: se calcula sobre lo visible, no sobre cuántas claves tiene la persona.
      const activa = compartidas.some((b) => esMio(g, b)) || ciclosHoy.some((cc) => esMio(g, cc));
      const compartidasDespues = activa ? compartidas.filter((b) => esMio(g, b)) : compartidas;
      const ciclosDespues = activa ? ciclosHoy.filter((cc) => esMio(g, cc)) : ciclosHoy;

      const antes = propias.length + compartidas.length + ciclosHoy.length;
      const despues = propias.length + compartidasDespues.length + ciclosDespues.length;

      console.log(`\n   ${g.username} (${g.nombre || 's/n'}) · rol=${g.rol} · puesto=${g.position_code || '—'}`);
      console.log(`     delegado: ${[...g.resp].join(', ')}`);
      console.log(`     filtro: ${activa ? 'ENCENDIDO' : 'apagado (nada de lo que ve es suyo)'}`);
      console.log(
        `     bandejas compartidas: ${compartidas.length} → ${compartidasDespues.length}` +
          (compartidas.length > compartidasDespues.length
            ? `   (fuera: ${compartidas.filter((b) => !esMio(g, b)).map((b) => b.id).join(', ')})`
            : '   (sin cambio)'),
      );
      console.log(
        `     bandejas propias (tu borrador, NUNCA se filtran): ${propias.length}` +
          (propias.length ? ` (${propias.map((b) => b.id).join(', ')})` : ''),
      );
      console.log(
        `     ciclos: ${ciclosHoy.length} → ${ciclosDespues.length}` +
          (ciclosHoy.length > ciclosDespues.length
            ? `   (fuera: ${ciclosHoy.filter((cc) => !esMio(g, cc)).map((cc) => cc.id).join(', ')})`
            : '   (sin cambio)'),
      );

      /*
       * ⛔ El invariante: la regla NO puede dejar en cero a quien tenía algo. Por construcción no
       * puede —sólo se enciende si algo sobrevive— pero se comprueba contra el dato real igual:
       * un invariante que sólo vive en un comentario es una intención.
       */
      if (antes > 0 && despues === 0) {
        console.log(`     ⛔ REGRESIÓN: tenía ${antes} y se queda con 0.`);
        salida = 1;
      }

      // La versión ingenua, para dejar medido por qué no se usó.
      const ingenua = propias.length + compartidas.filter((b) => esMio(g, b)).length + ciclosHoy.filter((cc) => esMio(g, cc)).length;
      if (antes > 0 && ingenua === 0) vaciadosPorLaIngenua.push(g.username);
    }

    console.log(`\n   ── Por qué no se usó la regla ingenua ──`);
    console.log(
      vaciadosPorLaIngenua.length
        ? `   «tenés alguna responsabilidad ⇒ filtrá» dejaría con la PANTALLA VACÍA a ${n(vaciadosPorLaIngenua.length)} persona(s):\n` +
            `     ${vaciadosPorLaIngenua.join(', ')}\n` +
            `   Todas tienen la misma causa: su única delegación apunta a una superficie apagada.`
        : `   hoy no vaciaría a nadie — pero la condición sigue siendo la de "algo visible es tuyo",\n` +
            `   que es la única que no puede vaciar por construcción.`,
    );

    // ── 3. Auto-entrada: cuánta gente tiene exactamente UN destino ───────────────────────────
    console.log(`\n── 3. Auto-entrada: quién no llega nunca a «Mi trabajo» ──`);
    const conUnDestino = [];
    const histo = new Map();
    for (const g of gente.values()) {
      const vis = visibleSuiteMap(g.perms, g.esAdmin, g.rol);
      const d = primaryDestinations(vis);
      histo.set(d.length, (histo.get(d.length) ?? 0) + 1);
      if (d.length === 1) conUnDestino.push({ g, destino: d[0] });
    }
    console.log(`   destinos primarios por persona:`);
    for (const k of [...histo.keys()].sort((a, b) => a - b)) {
      console.log(`     ${String(k).padStart(2)} destino(s): ${n(histo.get(k))} persona(s)`);
    }
    console.log(
      `   → ${n(conUnDestino.length)} persona(s) NUNCA ven la landing hoy (la app los redirige sola).`,
    );
    const porDestino = new Map();
    for (const x of conUnDestino) porDestino.set(x.destino, (porDestino.get(x.destino) ?? 0) + 1);
    for (const [ruta, cuantos] of [...porDestino.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${ruta.padEnd(28)} ${n(cuantos)}`);
    }

    // ¿Cuántos de ésos tienen trabajo PROPIO que el arreglo les haría ver?
    const conTarea = new Set();
    for (const f of FUENTES) {
      if (!(await existe(c, f.t))) continue;
      const r = await c.query(
        `SELECT DISTINCT t.${f.col} AS id FROM ${f.t} t WHERE t.${f.col} IS NOT NULL AND ${f.filtro}`,
      );
      for (const row of r.rows) conTarea.add(row.id);
    }
    const conBorrador = new Set();
    if (await existe(c, 'commercial.expiry_reviews')) {
      const r = await c.query(
        `SELECT DISTINCT responsible_user_id AS id FROM commercial.expiry_reviews
          WHERE status = 'draft' AND responsible_user_id IS NOT NULL`,
      );
      for (const row of r.rows) conBorrador.add(row.id);
    }
    const clavesCiclo = new Set(CICLOS.map((cc) => cc.resp).filter(Boolean));
    const tieneAlgoPropio = (g) =>
      conTarea.has(g.id) ||
      conBorrador.has(g.id) ||
      [...g.resp].some((k) => clavesCiclo.has(k));

    const sePararian = conUnDestino.filter((x) => tieneAlgoPropio(x.g));
    console.log(
      `\n   de esas ${n(conUnDestino.length)}, tienen trabajo PROPIO (tarea asignada, borrador o ciclo delegado): ${n(sePararian.length)}`,
    );
    console.log(
      `   → con el arreglo puesto, ${n(sePararian.length)} persona(s) dejan de entrar directo y ven «Mi trabajo»;`,
    );
    console.log(
      `     las otras ${n(conUnDestino.length - sePararian.length)} siguen entrando igual (no tienen nada propio que mostrarles).`,
    );
    for (const x of sePararian.slice(0, 25)) {
      console.log(
        `     ${x.g.username.padEnd(24)} ${x.destino.padEnd(22)} tarea=${conTarea.has(x.g.id) ? 'sí' : 'no'} borrador=${conBorrador.has(x.g.id) ? 'sí' : 'no'} ciclo=${[...x.g.resp].some((k) => clavesCiclo.has(k)) ? 'sí' : 'no'}`,
      );
    }
    if (sePararian.length > 25) console.log(`     … y ${n(sePararian.length - 25)} más`);

    console.log(
      `\n   ⚠️  Costo del cambio: cada una de esas ${n(sePararian.length)} personas pierde el atajo de entrar\n` +
        `      directo a su proyecto. Gana ver lo que le toca. Es un intercambio, no una mejora gratis.`,
    );

    console.log(`\n═══ fin ═══\n`);
  } catch (e) {
    console.error(`\n✗ error: ${e.message}`);
    salida = 2;
  } finally {
    await c.end();
  }
  process.exitCode = salida;
})();
