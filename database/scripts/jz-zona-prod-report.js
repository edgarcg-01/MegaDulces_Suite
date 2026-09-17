'use strict';
/* eslint-disable no-console */
/**
 * `[JZ.3]` — **Qué va a ver cada jefe de zona en «Mi trabajo», medido contra PROD.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El bloque se enciende con dos claves de `identity.responsibilities`, y hasta que la API se
 * redespliegue nadie lo puede abrir en pantalla. Este reporte contesta antes —y sin esperar— las
 * dos preguntas que de otro modo se descubren en vivo:
 *
 *   1. ¿Le sale un número a cada jefe, o alguno queda con la pantalla vacía?
 *   2. ¿Cuántos canales salen **sin medir**, y por cuál de los dos motivos? Distinguirlos es todo
 *      el punto: «nunca vendió» se arregla en el catálogo, «dejó de reportar el 12-ago» se
 *      arregla en el feed.
 *
 * ⭐ Corre **`medirZona` de producción**, transpilada al vuelo — no una copia. Una copia probaría
 * que dos implementaciones coinciden, no que la de producción acierta (mismo criterio que
 * `sn-veredicto-prod-report.js`).
 *
 * ⛔ READ-ONLY. La URL NO se imprime nunca. `DATABASE_URL_NEW` del `.env` apunta a la RÉPLICA DE
 * PRUEBAS, así que acá se resuelve `FLEET_DB_URL` y se verifica el destino antes de medir.
 *
 * Sale con 1 si algún jefe de zona queda **sin un solo canal medible**: eso es una portada vacía
 * para alguien que sí tiene reparto, y es accionable, no informativo.
 *
 * Uso:  node database/scripts/jz-zona-prod-report.js [dia|semana|mes]   (default: mes)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const ts = require('typescript');

const DST = process.env.FLEET_DB_URL;
if (!DST || !/railway/.test(DST)) {
  console.error('FLEET_DB_URL debe apuntar a PROD (DATABASE_URL_NEW es la réplica de pruebas).');
  process.exit(1);
}

/**
 * Transpila un `.ts` y lo evalúa con un resolvedor de `require` inyectado, porque `me-zona.ts`
 * importa de `@megadulces/contracts` y `@megadulces/platform-core` — alias de Nx que node no
 * resuelve. Se le entregan las piezas reales de cada uno (el contrato transpilado, `todayMx`
 * reimplementado con la MISMA `Intl` que usa `mx-date.ts`, y el enum de permisos), no stubs.
 */
function cargar(p, resolver) {
  const js = ts.transpileModule(fs.readFileSync(p, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(mod.exports, resolver, mod);
  return mod.exports;
}

const R = (rel) => path.resolve(__dirname, '..', '..', rel);

const contrato = cargar(R('libs/contracts/src/http/identity-me.contract.ts'), () => ({}));
const permisos = cargar(R('libs/contracts/src/authz/permissions.ts'), () => ({}));
const mxDate = cargar(R('libs/platform-core/src/lib/date/mx-date.ts'), () => ({}));

const meZona = cargar(R('libs/trade/src/lib/users/me-zona.ts'), (id) => {
  if (id === '@megadulces/contracts') return contrato;
  if (id === '@megadulces/platform-core') return mxDate;
  if (id === '@megadulces/contracts/authz/permissions') return permisos;
  throw new Error(`import no previsto en me-zona.ts: ${id}`);
});

const knex = require('knex')({
  client: 'pg',
  connection: { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 2 },
});

const mdp = (n) =>
  n === null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MDP` : Math.round(n).toLocaleString('es-MX');
const pct = (p) => (p === null ? 'sin medir' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p * 100).toFixed(1)}%`);

(async () => {
  const jefes = await knex('identity.users as u')
    .leftJoin('identity.role_permissions as rp', function () {
      this.on('rp.role_name', '=', 'u.role_name').andOn('rp.tenant_id', '=', 'u.tenant_id');
    })
    .whereNull('u.deleted_at')
    .whereIn('u.position_code', function () {
      this.from('identity.position_responsibilities')
        .whereNull('deleted_at')
        .where('responsibility_key', 'like', 'comercial.venta%')
        .distinct('position_code');
    })
    .select('u.id', 'u.username', 'u.nombre', 'u.tenant_id', 'u.role_name', 'rp.permissions');

  console.log(`\n[JZ.3] ${jefes.length} persona(s) con reparto de venta por zona\n`);

  const PERIODO = ['dia', 'semana', 'mes'].includes(process.argv[2]) ? process.argv[2] : 'mes';
  const claves = await knex('identity.responsibilities')
    .where('key', 'like', 'comercial.venta%')
    .pluck('key');
  let vacias = 0;
  let enlacesRotos = 0;

  /*
   * `[JZ.6]` Los valores que el filtro de `/comercial/ventas-por-ruta` acepta de verdad, tal cual
   * los arma `salesByRouteRoutes()`. Existe porque `[JZ.1]` mandaba `?route=RUTA-28` y la pantalla
   * filtra por `"<sucursal>|<route_code>"` (`01|WIN-28`): el enlace abría la tabla **vacía** y
   * ninguna prueba lo vio, porque afirmaban sobre el argumento que viajaba y no sobre el valor que
   * el backend reconoce. Un enlace que no filtra es peor que no tener enlace.
   */
  const validos = new Set(
    (
      await knex('analytics.sales_by_route_monthly as s')
        .join('commercial.warehouses as w', function () {
          this.on('w.id', '=', 's.warehouse_id').andOn('w.tenant_id', '=', 's.tenant_id');
        })
        .whereRaw(`s.route_code LIKE 'WIN-%'`)
        .distinct(knex.raw(`w.code || '|' || s.route_code as v`))
    ).map((r) => r.v),
  );

  for (const j of jefes) {
    const r = await meZona.medirZona(
      knex,
      {
        tenantId: j.tenant_id,
        userId: j.id,
        responsabilidades: new Set(claves),
        permisos: j.permissions || {},
        esAdmin: false, // a propósito: se mide el permiso REAL, no el god-mode
      },
      PERIODO,
    );

    console.log('═'.repeat(78));
    console.log(`${j.nombre || j.username}  ·  ${j.role_name}`);
    if (!r.zona) {
      console.log(`  ⓘ sin bloque — ${r.motivo || 'no responde de ningún canal'}`);
      vacias++;
      continue;
    }
    const z = r.zona;
    console.log(`  ${z.zona}  ·  [${z.periodo}]  ${z.desde}…${z.hasta}  contra  ${z.desde_comparado}…${z.hasta_comparado}`);
    /*
     * ⛔ El recorte por frescura. Sin esta linea, MORELIA ABASTOS publicaba −26.1 % siendo
     * +17.1 %: `hasta` salia del RELOJ y no de hasta donde entrego la fuente mas lenta.
     */
    if (z.corte) {
      console.log(
        `  ⛔ tramo RECORTADO al ${z.hasta} (nominal ${z.corte.hasta_nominal}): ` +
          `${z.corte.fuentes.join(', ')} lleva(n) ${z.corte.dias_sin_entregar} dia(s) sin entregar`,
      );
    }
    console.log(`  TOTAL ${mdp(z.monto)}   ${pct(z.variacion_pct)}   (contra ${mdp(z.comparado)})`);
    /*
     * Lo que NO entró en la comparación. Sin esta línea, ZAMORA se leería como «−10.7 %» sin que
     * nadie sepa que hay 3 rutas que valían medio millón y dejaron de reportar. El total honesto
     * y el hueco declarado son las DOS mitades de la misma verdad.
     */
    if (z.no_comparado) {
      console.log(
        `  ⚠ ${z.no_comparado.canales} canal(es) sin dato este mes ` +
          `(${mdp(z.no_comparado.monto_anterior)} el mes pasado) FUERA de la comparación`,
      );
    }
    console.log('');

    let medibles = 0;
    for (const b of z.bloques) {
      const peso = b.peso === null ? '' : ` · ${(b.peso * 100).toFixed(0)}% de la zona`;
      console.log(`  ── ${b.label}  ${mdp(b.monto)}  ${pct(b.variacion_pct)}${peso}`);
      for (const c of b.canales) {
        if (c.monto !== null) medibles++;
        const candado = c.ruta ? '' : '  🔒 sin permiso';
        const nota = c.sin_medir ? `  ⚠ ${c.sin_medir}` : '';
        const destino = c.queryParams?.route;
        let roto = '';
        if (destino && !validos.has(destino)) {
          roto = `  ⛔ ENLACE ROTO (${destino} no existe en el filtro de la pantalla)`;
          enlacesRotos++;
        }
        console.log(
          `     ${c.label.padEnd(28)} ${mdp(c.monto).padStart(11)} ${pct(c.variacion_pct).padStart(10)}${nota}${candado}${roto}`,
        );
      }
      for (const x of b.excluidos) console.log(`     ⛔ ${x.label} — ${x.motivo}`);
    }
    console.log('');
    if (medibles === 0) {
      console.log('  ⛔ NINGÚN canal medible: esta persona vería una portada vacía.\n');
      vacias++;
    }
  }

  console.log('═'.repeat(78));
  console.log(vacias === 0
    ? 'Todos los jefes de zona reciben al menos un canal con cifra.'
    : `⛔ ${vacias} jefe(s) de zona sin una sola cifra.`);
  console.log(enlacesRotos === 0
    ? 'Todos los enlaces aterrizan en un filtro que la pantalla reconoce.'
    : `⛔ ${enlacesRotos} enlace(s) llevarían a una tabla VACÍA.`);
  await knex.destroy();
  process.exitCode = vacias === 0 && enlacesRotos === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error(e.stack || e.message);
  await knex.destroy();
  process.exit(1);
});
