'use strict';
/* eslint-disable no-console */
/**
 * `[SN.30]` — **Qué colas quedaron sin nadie, y a quién se le vació la portada.**
 *
 * Desde `[SN.30]` una cola se muestra en «Mi trabajo» **sólo si esa persona responde de ella**
 * (Edgar, 2026-09-14: *«si no tiene responsabilidades no se le muestra nada»*). Es la regla
 * correcta y cierra el defecto que se reportó tres veces —trabajo de otra persona en tu portada—,
 * pero abre dos huecos que **no se pueden ver desde el código** y que este reporte existe para
 * que nadie descubra por accidente:
 *
 *   1. **Una cola cuya clave no tiene NINGÚN dueño desaparece de la portada de todo el mundo.**
 *      No es un bug: es la regla funcionando. Pero si nadie lo mira, una cola con trabajo real
 *      deja de pedir atención y nadie se entera. Medido el 2026-09-14: le pasa a `logistica.flota`.
 *   2. **Una persona sin ninguna responsabilidad ve su columna vacía.** También correcto, y
 *      también hay que saber a cuántas les pasa: 94 de 122 el día que se aplicó.
 *
 * Y un tercer caso, que es el que MENTIRÍA si no se distinguiera:
 *
 *   3. **Alguien cuya única responsabilidad apunta a una bandeja RETIRADA** (`BandejaDef.retirada`).
 *      Sí tiene reparto; lo que pasa es que su cola está apagada. La pantalla lo dice aparte
 *      (`MeDelegacion.retiradas`), y acá se listan para poder arreglarlo.
 *
 * ⛔ READ-ONLY. La URL NO se imprime nunca. `DATABASE_URL_NEW` del `.env` apunta a la RÉPLICA DE
 * PRUEBAS, así que acá se resuelve `FLEET_DB_URL` dentro de node y se verifica el destino antes de
 * medir — el mismo patrón de `or-landing-gap-report.js`.
 *
 * Sale con 1 si hay alguna cola viva sin dueño: es una condición accionable, no informativa.
 *
 * Uso:  node database/scripts/sn-responsabilidad-huecos.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { Client } = require('pg');

const DST = process.env.FLEET_DB_URL;
if (!DST || !/railway/.test(DST)) {
  console.error('FLEET_DB_URL debe apuntar a PROD (DATABASE_URL_NEW es la réplica de pruebas).');
  process.exit(1);
}

/**
 * Las claves que hoy usan bandejas y ciclos, con lo que hay que saber de cada una.
 *
 * ⚠️ Se declara acá y no se deriva del `.ts` a propósito: este reporte tiene que poder correr sin
 * ts-node en cualquier máquina. El candado de que la lista siga al día es el bloque 4c del smoke
 * (`test-newdb-me-context.js`), que verifica la biyección cola ↔ `identity.responsibilities`.
 */
const COLAS = [
  { clave: 'almacen.cuadre', que: 'bandeja · Descuadres por revisar' },
  { clave: 'finanzas.acciones', que: 'bandeja · Acciones de finanzas por aprobar' },
  { clave: 'comercial.thot', que: 'bandeja · Acciones comerciales por aprobar' },
  { clave: 'compras.reabasto', que: 'bandeja · Hallazgos de reabastecimiento' },
  { clave: 'logistica.flota', que: 'bandeja · Alertas de flota' },
  { clave: 'tienda.caducidades', que: 'bandeja · Revisiones de caducidad (tu borrador)' },
  { clave: 'almacen.conteo', que: 'tarea · Conteos de inventario asignados' },
  { clave: 'finanzas.conciliacion_ingresos', que: 'ciclo · Conciliación de ingresos (bancos y caja)' },
  { clave: 'finanzas.conciliacion_egresos', que: 'ciclo · Conciliación de egresos (bancos y caja)' },
  // Retirada desde `[SN.18]`: la superficie está apagada, así que su dueño no ve nada.
  { clave: 'finanzas.hallazgos', que: 'bandeja · Hallazgos de finanzas', retirada: true },
];

/** Responsabilidades vigentes por persona: las del puesto más las excepciones que SUMAN. */
const SQL_RESP = `
  with resp as (
    select u.id, u.username, u.role_name, r.responsibility_key clave, 'puesto' via
      from identity.users u
      join identity.position_responsibilities r on r.position_code = u.position_code
     where u.activo and r.deleted_at is null and u.deleted_at is null
    union
    select u.id, u.username, u.role_name, e.responsibility_key, 'persona'
      from identity.users u
      join identity.user_responsibilities e on e.user_id = u.id
     where u.activo and e.accion = 'suma' and e.deleted_at is null and u.deleted_at is null
       and e.valid_from <= current_date
       and (e.valid_to is null or e.valid_to >= current_date)
  )`;

(async () => {
  const c = new Client({ connectionString: DST, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("set statement_timeout='30s'");
  const db = (await c.query('select current_database() d')).rows[0].d;
  console.log(`# base: ${db}  ·  ${new Date().toISOString()}\n`);

  const porClave = (await c.query(`${SQL_RESP}
    select clave, count(distinct id)::int personas, string_agg(distinct via, '+') via
      from resp group by 1`)).rows;
  const dueno = new Map(porClave.map((r) => [r.clave, r]));

  // ── 1. Colas sin nadie que las vea ─────────────────────────────────────────────────────────
  console.log('## Colas y quién responde de ellas');
  const huerfanas = [];
  for (const col of COLAS) {
    const d = dueno.get(col.clave);
    const marca = col.retirada ? ' (RETIRADA)' : '';
    if (!d) {
      huerfanas.push(col);
      console.log(`   ⛔ SIN DUEÑO   ${col.clave.padEnd(32)} ${col.que}${marca}`);
    } else {
      console.log(`      ${String(d.personas).padStart(3)} pers.  ${col.clave.padEnd(32)} ${col.que}${marca} [${d.via}]`);
    }
  }

  // ── 2. Cobertura de personas ───────────────────────────────────────────────────────────────
  const cob = (await c.query(`${SQL_RESP}
    select (select count(*) from identity.users where activo and deleted_at is null)::int activos,
           (select count(distinct id) from resp)::int con_resp`)).rows[0];
  const sin = cob.activos - cob.con_resp;
  console.log(`\n## Cobertura`);
  console.log(`   ${cob.con_resp} de ${cob.activos} personas activas tienen alguna responsabilidad`);
  console.log(`   ⛔ ${sin} (${((sin * 100) / cob.activos).toFixed(1)}%) ven su columna «Tu trabajo» vacía`);

  // Las que igual conservan algo: una tarea con su nombre o un borrador propio no se filtran.
  const otras = (await c.query(`${SQL_RESP}
    , sin_resp as (
      select u.id, u.username, u.role_name from identity.users u
       where u.activo and u.deleted_at is null and u.id not in (select id from resp))
    select s.username, s.role_name,
      (select count(*) from finance.recon_tasks t
        where t.assigned_to = s.id and t.status in ('pendiente','en_proceso'))::int t_fin,
      (select count(*) from commercial.supervisor_tasks t
        where t.assigned_to_user = s.id and t.status = 'pending')::int t_sup,
      (select count(*) from commercial.expiry_reviews e
        where e.responsible_user_id = s.id and e.status = 'draft')::int borradores
      from sin_resp s`)).rows;
  const conAlgo = otras.filter((r) => r.t_fin + r.t_sup + r.borradores > 0);
  console.log(`   de ésas, ${conAlgo.length} conservan algo por tarea asignada o borrador propio:`);
  for (const r of conAlgo) {
    console.log(`      ${r.username.padEnd(22)} ${r.role_name.padEnd(20)} tareas ${r.t_fin + r.t_sup} · borradores ${r.borradores}`);
  }

  // ── 3. Reparto que apunta a una superficie apagada ─────────────────────────────────────────
  const retiradas = COLAS.filter((x) => x.retirada).map((x) => x.clave);
  if (retiradas.length) {
    const solo = (await c.query(`${SQL_RESP}
      select username, role_name from resp
       group by id, username, role_name
      having bool_and(clave = any($1::text[]))`, [retiradas])).rows;
    console.log(`\n## Reparto que apunta SÓLO a una bandeja apagada (${retiradas.join(', ')})`);
    console.log(`   ${solo.length} personas: ${solo.map((r) => r.username).join(', ') || '—'}`);
    console.log('   Tienen reparto, pero su cola está retirada. La pantalla lo dice aparte;');
    console.log('   el arreglo es prender la bandeja o darles otra responsabilidad.');
  }

  console.log('\n## Qué hacer');
  if (huerfanas.length) {
    console.log(`   ⛔ ${huerfanas.length} cola(s) sin dueño: nadie las va a ver en su portada.`);
    for (const h of huerfanas) {
      console.log(`      · ${h.clave} → sembrar en identity.position_responsibilities (o user_responsibilities)`);
    }
  } else {
    console.log('   Todas las colas vivas tienen al menos un dueño.');
  }
  console.log('   ⓘ `libro-de-compras` NO aparece acá porque ni siquiera declara clave en el');
  console.log('     registro de ciclos: con [SN.30] no lo ve nadie. Lo vigila el bloque 4h del smoke.');

  await c.end();
  // Exit 1 sólo por las colas VIVAS sin dueño: la retirada es una decisión tomada.
  process.exitCode = huerfanas.some((h) => !h.retirada) ? 1 : 0;
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
