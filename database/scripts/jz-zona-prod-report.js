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
    .select('u.id', 'u.username', 'u.nombre', 'u.tenant_id', 'u.role_name', 'u.position_code', 'rp.permissions');

  console.log(`\n[JZ.3] ${jefes.length} persona(s) con reparto de venta por zona\n`);

  const PERIODO = ['dia', 'semana', 'mes'].includes(process.argv[2]) ? process.argv[2] : 'mes';
  /*
   * ⛔ `[JZ.7]` Las claves REALES de cada puesto, no el catálogo entero.
   *
   * Hasta acá el reporte le pasaba a todo el mundo `new Set(<todas las claves comercial.venta%>)`,
   * lo cual era inofensivo mientras las tres claves fueran del mismo puesto. Con
   * `comercial.venta_zonas` deja de serlo: le daría a cada jefe de zona la vista de dirección y el
   * reporte publicaría 6 zonas para quien sólo responde de una. Un arnés que le presta permisos al
   * sujeto no mide al sujeto.
   */
  const reparto = new Map();
  for (const f of await knex('identity.position_responsibilities')
    .whereNull('deleted_at')
    .where('responsibility_key', 'like', 'comercial.venta%')
    .select('position_code', 'responsibility_key')) {
    const prev = reparto.get(f.position_code);
    if (prev) prev.add(f.responsibility_key);
    else reparto.set(f.position_code, new Set([f.responsibility_key]));
  }
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
        responsabilidades: reparto.get(j.position_code) ?? new Set(),
        permisos: j.permissions || {},
        esAdmin: false, // a propósito: se mide el permiso REAL, no el god-mode
      },
      PERIODO,
    );

    console.log('═'.repeat(78));
    console.log(`${j.nombre || j.username}  ·  ${j.role_name}  ·  puesto ${j.position_code}`);
    if (r.zonas.length === 0) {
      console.log(`  ⓘ sin bloque — ${r.motivo || 'no responde de ningún canal'}`);
      vacias++;
      continue;
    }
    /*
     * `[JZ.7]` El total de TODAS las zonas, sobre un solo tramo. Sólo aparece con más de una: es
     * lo que ve la dirección. Un jefe de zona sigue viendo exactamente lo de antes.
     */
    if (r.consolidado) {
      const k = r.consolidado;
      console.log(
        `  ⭐ CONSOLIDADO de ${k.zonas} zonas: ${mdp(k.monto)}  ${pct(k.variacion_pct)}  (contra ${mdp(k.comparado)})`,
      );
      if (k.no_comparado) {
        console.log(
          `     ⚠ ${k.no_comparado.canales} zona(s) sin dato en el tramo ` +
            `(${mdp(k.no_comparado.monto_anterior)} en el anterior) FUERA de la comparación`,
        );
      }
      console.log('');
    }
    let medibles = 0;
    for (const z of r.zonas) {
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

    for (const b of z.bloques) {
      const peso = b.peso === null ? '' : ` · ${(b.peso * 100).toFixed(0)}% de la zona`;
      console.log(`  ── ${b.label}  ${mdp(b.monto)}  ${pct(b.variacion_pct)}${peso}`);
      /*
       * `[CDRP.1]` Margen y ticket del canal. La COBERTURA se imprime siempre: un margen sobre el
       * 89% de la venta se lee igual que uno sobre el 100% si nadie dice cual es cual.
       */
      const mg = b.margen_pct === null
        ? 'margen sin medir (la fuente de este canal no trae costo)'
        : `margen ${(b.margen_pct * 100).toFixed(2)}%` +
          (b.margen_cobertura === null
            ? ' (cobertura sin medir)'
            : ` sobre el ${(b.margen_cobertura * 100).toFixed(1)}% de su venta`);
      const tk = b.ticket_promedio === null
        ? 'ticket sin medir'
        : `ticket ${mdp(b.ticket_promedio)} en ${Number(b.tickets).toLocaleString('es-MX')} tickets`;
      console.log(`     ${mg}  ·  ${tk}`);
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
    }
    if (medibles === 0) {
      console.log('  ⛔ NINGÚN canal medible: esta persona vería una portada vacía.\n');
      vacias++;
    }
  }

  /*
   * `[JZ.7]` **Lo que va a ver la dirección, ANTES de moverle el puesto a nadie.**
   *
   * Es una SIMULACIÓN y se rotula como tal: corre la `medirZona` de producción con la clave
   * `comercial.venta_zonas` en la mano, contra los datos reales. Existe porque los dos puestos de
   * dirección están HOY vacíos (`superuser` y `guillermo_lopez` están fichados en `sistemas`), así
   * que la migración reparte la clave y no la recibe nadie: sin esto, la primera vez que alguien
   * viera el bloque sería en producción, con el director mirando.
   *
   * ⛔ El sujeto es un usuario REAL (el primero de la tenant) sólo para que `medirZona` tenga un
   * `userId` válido: con esta clave la zona NO sale de su ficha, así que cuál sea da igual.
   */
  const tenant = jefes[0] && jefes[0].tenant_id;
  if (tenant) {
    const alguien = await knex('identity.users').where({ tenant_id: tenant }).first('id');
    const d = await meZona.medirZona(
      knex,
      {
        tenantId: tenant,
        userId: alguien.id,
        responsabilidades: new Set(['comercial.venta_zonas']),
        permisos: {},
        esAdmin: true, // dirección abre las dos pantallas de destino
      },
      PERIODO,
    );
    console.log('═'.repeat(78));
    console.log('SIMULACIÓN — lo que verá DIRECCIÓN con comercial.venta_zonas (hoy nadie la tiene)');
    if (d.consolidado) {
      const k = d.consolidado;
      console.log(
        `  ⭐ ${k.zonas} zonas: ${mdp(k.monto)}  ${pct(k.variacion_pct)}  (contra ${mdp(k.comparado)})`,
      );
      if (k.no_comparado) {
        console.log(
          `     ⚠ ${k.no_comparado.canales} zona(s) fuera de la comparación ` +
            `(${mdp(k.no_comparado.monto_anterior)} en el tramo anterior)`,
        );
      }
    } else {
      console.log(`  ⛔ sin consolidado — ${d.motivo || `${d.zonas.length} zona(s)`}`);
    }
    for (const z of d.zonas) {
      const corte = z.corte ? `  ⛔ recortado al ${z.hasta} por ${z.corte.fuentes.join(', ')}` : '';
      console.log(
        `     ${z.zona.padEnd(20)} ${mdp(z.monto).padStart(11)} ${pct(z.variacion_pct).padStart(10)}` +
          `   ${z.bloques.length} bloque(s)${corte}`,
      );
    }
    /* ⛔ Todas las zonas tienen que compartir el tramo: si no, el total suma tramos distintos. */
    const tramos = new Set(d.zonas.map((z) => `${z.desde}…${z.hasta}`));
    console.log(
      tramos.size <= 1
        ? `  ✔ las ${d.zonas.length} zonas comparten el tramo ${[...tramos][0] || '—'}`
        : `  ⛔ TRAMOS DISTINTOS entre zonas (${[...tramos].join(' | ')}): el total suma peras con manzanas`,
    );
    if (tramos.size > 1) enlacesRotos++;
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
