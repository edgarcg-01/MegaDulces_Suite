#!/usr/bin/env node
/**
 * `[GX.17]` — **Solicitudes de gasto de mentira, para poder MIRAR la pantalla.**
 *
 * ## Por qué existe
 * `/finanzas/gastos` no se puede validar a ojo en una máquina de desarrollo: sus pasos 3, 4
 * y 5 (tipo de gasto → cómo se pagó → la foto) sólo aparecen **después** de elegir una
 * solicitud, y las solicitudes salen de `analytics.expense_requests`, que es una **vista
 * sobre el ODS** — no una tabla que se pueda sembrar.
 *
 * Eso dejó tres defectos reales llegar a producción sin que nadie los viera: el visor de la
 * cámara en negro, el disparador que no hacía nada, y «¿Cómo se pagó?» renderizado como
 * texto pegado («Efectivo01Tarjeta04…»). Los tres eran **visibles a simple vista** y ninguna
 * prueba unitaria los podía ver.
 *
 * ## Lo que hace
 * La vista no se puede insertar, pero **su fuente sí**: `kepler_ods.kdm1`, que en la base
 * local está VACÍA. Se le meten unas pocas filas con la forma exacta que la vista filtra
 * (`c2='X' · c3='A' · c4='15' · c5='1' · c1 = sucursal · c6 <> ''`) y la pantalla se
 * enciende entera, sin depender de ninguna base remota.
 *
 * ## ⛔ Candado
 * Escribe en `kepler_ods`, que en producción es **el reflejo del ERP**. Por eso se niega a
 * correr si la base no es una de las locales declaradas acá: no alcanza con no apuntarle a
 * producción, tiene que ser IMPOSIBLE apuntarle. Si el candado no puede comprobar dónde
 * está parado, aborta — un candado que no sabe es un candado abierto (ADR-056).
 *
 * ## Uso
 *   node database/seeds-newdb/dev-solicitudes-gasto.js            # siembra 6
 *   node database/seeds-newdb/dev-solicitudes-gasto.js --n=20     # siembra 20
 *   node database/seeds-newdb/dev-solicitudes-gasto.js --limpiar  # borra SOLO lo sembrado
 */
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

/** Bases donde esto puede correr. Cualquier otra cosa es un NO. */
const BASES_PERMITIDAS = ['platform_local', 'postgres_platform_local', 'platform_dev'];
/** Hosts donde esto puede correr. */
const HOSTS_PERMITIDOS = ['127.0.0.1', 'localhost', '::1'];

/** Marca de agua: TODO lo que siembra este script la lleva, para poder retirarlo sin tocar nada más. */
const MARCA = 'SEED-DEV-GX17';

const TENANT = '00000000-0000-0000-0000-00000000d01c';

const BENEFICIARIOS = [
  ['GASTOS GENERALES CAJA CHICA MORELIA ABASTOS', 'PAPELERIA Y TONER PARA OFICINA'],
  ['GASTOS GENERALES CAJA CHICA ZAMORA CENTRO', 'REPARACION DE BALATAS MOTO VECINAL'],
  ['COMISIONES RUTAS DE VENTAS', 'COMISIONES PERIODO 19 RD PH'],
  ['JORGE ALBERTO CONTRERAS BATISTA', 'FUMIGACION MES DE SEPTIEMBRE ZAMORA'],
  ['BONOS AUTORIZADOS', 'BONO DE INVENTARIO TRIMESTRAL SUC LA PIEDAD'],
  ['GASTOS GENERALES PARA INVENTARIOS', 'SODAS Y DESECHABLE PARA INVENTARIO'],
];
const SOLICITANTES = ['MKT', 'PREVENCION', 'RRHH', 'CONTABILIDAD', 'TANIA SANCHEZ', 'MORELIA ABASTOS AIDE'];

function arg(nombre, porDefecto) {
  const m = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return m ? m.split('=')[1] : porDefecto;
}

/**
 * El candado. Pregunta a LA BASE dónde está parada en vez de creerle a la cadena de
 * conexión: una URL puede decir `localhost` y estar tunelada a cualquier lado.
 */
async function exigirLocal(knex, url) {
  const { rows } = await knex.raw(
    'select current_database() db, inet_server_addr()::text ip, inet_server_port() puerto');
  const { db, ip, puerto } = rows[0];
  const host = new URL(url).hostname;

  const motivos = [];
  if (!BASES_PERMITIDAS.includes(db)) motivos.push(`la base se llama "${db}" y no está en la lista blanca`);
  if (!HOSTS_PERMITIDOS.includes(host)) motivos.push(`el host de la cadena es "${host}"`);
  /**
   * ⚠️ Acá había una comparación contra la lista de hosts y era un FALSO POSITIVO: la base
   * local corre en Docker, así que `inet_server_addr()` devuelve la IP del contenedor
   * (`172.18.0.4`) y el candado se negaba a correr sobre la máquina de desarrollo. Medido.
   *
   * Lo que sí dice algo es si el servidor está en una dirección PÚBLICA: eso ya no es «acá».
   * Loopback y los tres rangos privados pasan; el resto, no. La defensa de fondo sigue siendo
   * el nombre de la base — ninguna de las de producción (`postgres_platform`, `railway`,
   * `platform_test`) está en la lista blanca.
   */
  const privada = (a) => !a || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1)/.test(a);
  if (!privada(ip)) motivos.push(`el servidor responde desde una dirección pública: ${ip}:${puerto}`);

  if (motivos.length) {
    console.error('\n⛔ Este script NO corre acá. Escribe en `kepler_ods`, que fuera de');
    console.error('   desarrollo es el reflejo del ERP.\n');
    motivos.forEach((m) => console.error('   · ' + m));
    console.error('\n   Bases permitidas: ' + BASES_PERMITIDAS.join(', ') + '\n');
    process.exit(1);
  }
  console.log(`✔ candado OK — ${db} en ${host} (servidor ${ip || 'socket local'})`);
}

async function main() {
  const url = process.env.DATABASE_URL_LOCAL
    || process.env.DATABASE_URL_NEW
    || 'postgres://postgres:postgres@127.0.0.1:5432/platform_local';
  const knex = require('knex')({ client: 'pg', connection: url });

  try {
    await exigirLocal(knex, url);

    if (process.argv.includes('--limpiar')) {
      const { rowCount } = await knex.raw('delete from kepler_ods.kdm1 where c67 = ?', [MARCA]);
      console.log(`🧹 ${rowCount} solicitud(es) sembrada(s) retirada(s). Lo que no lleva la marca no se toca.`);
      return;
    }

    const n = Math.max(1, Math.min(200, Number(arg('n', 6)) || 6));
    // Sucursales que EXISTEN en la base: si no, el LEFT JOIN de la vista deja `warehouse_id`
    // en NULL y el alcance por áreas del backend descarta la fila — la pantalla saldría vacía
    // igual y el problema parecería otro.
    const sucursales = (await knex('warehouses').where({ tenant_id: TENANT })
      .whereNull('deleted_at').orderBy('code').limit(3).pluck('code'));
    if (!sucursales.length) {
      console.error('⛔ No hay almacenes en `warehouses`: sin eso la vista no resuelve la sucursal.');
      process.exit(1);
    }

    const base = Date.now() % 100000;
    const filas = [];
    for (let i = 0; i < n; i++) {
      const suc = sucursales[i % sucursales.length];
      const [beneficiario, concepto] = BENEFICIARIOS[i % BENEFICIARIOS.length];
      const folio = String(base + i).padStart(7, '0');
      const fecha = new Date(Date.now() - (i % 5) * 86400000).toISOString().slice(0, 10);
      filas.push({
        sucursal: suc,
        // El filtro EXACTO de `analytics.expense_requests`. Cambiar cualquiera de estos cinco
        // hace que la fila exista y la pantalla no la vea — que es peor que no sembrarla.
        c1: suc, c2: 'X', c3: 'A', c4: '15', c5: '1',
        c6: folio,
        c9: fecha,
        c16: (250 + i * 137.25).toFixed(2),
        c24: concepto,
        c32: beneficiario,
        c43: 'A',
        c48: SOLICITANTES[i % SOLICITANTES.length],
        c67: MARCA,
      });
    }

    await knex('kepler_ods.kdm1').insert(filas);

    const vistas = await knex('analytics.expense_requests').whereIn('folio', filas.map((f) => f.c6));
    console.log(`✔ ${filas.length} sembradas en kepler_ods.kdm1 · ${vistas.length} visibles en analytics.expense_requests`);
    if (vistas.length !== filas.length) {
      console.error('⚠️ La vista no las devuelve todas: el filtro cambió. Revisá el `WHERE` de la vista.');
      process.exit(1);
    }
    console.log('\nFolios para buscar en /finanzas/gastos:');
    for (const v of vistas.slice(0, 10)) {
      console.log(`   ${v.folio}  suc ${v.sucursal}  $${Number(v.importe).toFixed(2)}  ${v.beneficiario}`);
    }
    console.log('\nPara retirarlas: node database/seeds-newdb/dev-solicitudes-gasto.js --limpiar');
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
