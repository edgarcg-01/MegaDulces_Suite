#!/usr/bin/env node
/**
 * `[GX.25]` — **Historial de levantamientos de mentira, para poder MIRAR la pantalla.**
 *
 * ## Por qué existe
 * `/finanzas/gastos-historial` no se puede juzgar con una tabla vacía ni con tres filas del
 * mismo día: lo que hay que ver es si **se lee** — si los estados se distinguen, si un
 * rechazo cuenta por qué, si las fechas dispersas se agrupan bien, si el buscador corta.
 * Eso necesita volumen y variedad, y la base de desarrollo no los tiene.
 *
 * Hermano de `dev-solicitudes-gasto.js`, que siembra el OTRO lado (las solicitudes de
 * Kepler, en `kepler_ods.kdm1`). Éste siembra lo nuestro: `finance.expense_proofs`, que es
 * una tabla real de la app y sí se puede insertar.
 *
 * ## Qué siembra
 * ~60 levantamientos repartidos en **90 días**, con los cinco estados reales, varios
 * capturistas (incluido el que vos elijas, para que «Míos» no salga vacío), proveedores y
 * conceptos de dulcería, y los motivos de rechazo y notas de revisión que la pantalla
 * muestra debajo del renglón.
 *
 * ## ⛔ Candado
 * Mismo que el hermano: se niega a correr fuera de una base local declarada. Acá pesa más
 * todavía, porque `finance.expense_proofs` **es la tabla de producción del módulo**, no un
 * espejo de lectura.
 *
 * ## Uso
 *   node database/seeds-newdb/dev-historial-gastos.js --mio=superoot   # 60, varias personas
 *   node database/seeds-newdb/dev-historial-gastos.js --n=120 --mio=david_cisneros
 *   node database/seeds-newdb/dev-historial-gastos.js --limpiar        # borra SOLO lo sembrado
 */
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const BASES_PERMITIDAS = ['platform_local', 'postgres_platform_local', 'platform_dev'];
const HOSTS_PERMITIDOS = ['127.0.0.1', 'localhost', '::1'];

/** Marca de agua: todo lo sembrado la lleva, para poder retirarlo sin tocar nada más. */
const MARCA = 'SEED-HIST-GX25';
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Proveedores reales del giro, para que la tabla se lea como la de verdad. */
const PROVEEDORES = [
  ['OFFICE DEPOT', 'PAPELERIA Y TONER PARA OFICINA', 'fiscal'],
  ['GASOLINERA PEMEX 4412', 'COMBUSTIBLE RUTA VECINAL', 'fiscal'],
  ['FERRETERIA EL TORNILLO', 'MATERIAL PARA ANAQUEL', 'no_fiscal_comprobable'],
  ['TELMEX', 'INTERNET SUCURSAL', 'fiscal'],
  ['CFE', 'LUZ DEL MES', 'fiscal'],
  ['MISCELANEA LA ESQUINA', 'AGUA Y CAFE PARA PERSONAL', 'no_comprobable'],
  ['TALLER HERMANOS RUIZ', 'REPARACION DE BALATAS MOTO', 'no_fiscal_comprobable'],
  ['AGUA PURIFICADA DEL BAJIO', 'GARRAFONES QUINCENA', 'no_fiscal_comprobable'],
  ['CAPUFE', 'CASETAS VIAJE A MORELIA', 'no_comprobable'],
  ['ARRENDAMEX', 'RENTA DE MONTACARGAS', 'fiscal'],
  ['CONVERMEX', 'DESECHABLES PARA INVENTARIO', 'fiscal'],
  ['MANIOBRISTAS CEDIS', 'MANIOBRA DE DESCARGA', 'no_fiscal_comprobable'],
  ['REFACCIONARIA DEL BAJIO', 'FILTRO Y ACEITE CAMIONETA', 'fiscal'],
  ['BONOS AUTORIZADOS', 'BONO DE INVENTARIO TRIMESTRAL', 'no_comprobable'],
  ['COMISIONES RUTAS DE VENTAS', 'COMISIONES DEL PERIODO', 'no_comprobable'],
];

const CAPTURISTAS = [
  ['Tania Sanchez', 'MKT'],
  ['Leonardo Cazares', 'LOGISTICA'],
  ['Monica Mejia', 'RRHH'],
  ['Rosy Madero', 'INVENTARIOS'],
  ['Inventarios Staff', 'INVENTARIOS'],
  ['Juan Angel Lopez', 'PREVENCION'],
];

const FORMAS = [
  ['efectivo', null], ['tarjeta', '0000'], ['transferencia', '882301'],
  ['cheque', '1204'], ['vales', null], ['otro', 'Vale de gasolina prepagado'],
];

/** Los motivos con los que de verdad se rechaza. Sin ellos la fila rechazada no dice nada. */
const MOTIVOS = [
  'Sin comprobante y sin motivo declarado.',
  'La foto no corresponde al folio: es de otro proveedor.',
  'El ticket esta ilegible, no se ve el total.',
  'Falta la autorizacion firmada del area.',
];
const NOTAS_REVISION = [
  'El ticket dice $1,080.00 y la solicitud $980.00.',
  'Foto ilegible o sin lectura - validar a mano.',
  'El monto cuadra pero falta la cotizacion que menciona el concepto.',
];

function arg(nombre, porDefecto) {
  const m = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return m ? m.split('=')[1] : porDefecto;
}

/** Determinista: la misma siembra dos veces da la misma tabla, y eso hace comparables las capturas. */
function azar(semilla) {
  let s = semilla;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

async function exigirLocal(knex, url) {
  const { rows } = await knex.raw(
    'select current_database() db, inet_server_addr()::text ip, inet_server_port() puerto');
  const { db, ip, puerto } = rows[0];
  const host = new URL(url).hostname;
  const motivos = [];
  if (!BASES_PERMITIDAS.includes(db)) motivos.push(`la base se llama "${db}" y no está en la lista blanca`);
  if (!HOSTS_PERMITIDOS.includes(host)) motivos.push(`el host de la cadena es "${host}"`);
  // Docker responde desde una IP privada del contenedor: eso sigue siendo local.
  const privada = (a) => !a || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1)/.test(a);
  if (!privada(ip)) motivos.push(`el servidor responde desde una dirección pública: ${ip}:${puerto}`);

  if (motivos.length) {
    console.error('\n⛔ Este script NO corre acá. Escribe en `finance.expense_proofs`, que');
    console.error('   fuera de desarrollo es la tabla de produccion del modulo de gastos.\n');
    motivos.forEach((m) => console.error('   · ' + m));
    console.error('\n   Bases permitidas: ' + BASES_PERMITIDAS.join(', ') + '\n');
    process.exit(1);
  }
  console.log(`✔ candado OK — ${db} en ${host} (servidor ${ip || 'socket local'})`);
}

async function main() {
  const url = process.env.DATABASE_URL_LOCAL
    || 'postgres://postgres:postgres@127.0.0.1:5432/platform_local';
  const knex = require('knex')({ client: 'pg', connection: url });

  try {
    await exigirLocal(knex, url);

    if (process.argv.includes('--limpiar')) {
      const r = await knex('finance.expense_proofs').where('comentarios', 'like', `%${MARCA}%`).del();
      console.log(`🧹 ${r} levantamiento(s) sembrado(s) retirado(s). Lo que no lleva la marca no se toca.`);
      return;
    }

    const n = Math.max(1, Math.min(400, Number(arg('n', 60)) || 60));
    const mio = String(arg('mio', '') || '').trim();
    const rnd = azar(20260925);

    const filas = [];
    for (let i = 0; i < n; i++) {
      const [prov, concepto, clas] = PROVEEDORES[Math.floor(rnd() * PROVEEDORES.length)];
      // Una de cada tres es del usuario elegido: suficiente para que «Míos» tenga cuerpo
      // sin que «Todos» deje de verse como la tabla de toda la empresa.
      const propio = mio && i % 3 === 0;
      const [persona, depto] = propio ? [mio, 'SISTEMAS'] : CAPTURISTAS[Math.floor(rnd() * CAPTURISTAS.length)];
      const [forma, detalle] = FORMAS[Math.floor(rnd() * FORMAS.length)];

      // 90 dias hacia atras: el punto de la pantalla es que el historial NO es de hoy.
      const diasAtras = Math.floor(rnd() * 90);
      const cuando = new Date(Date.now() - diasAtras * 86400000 - Math.floor(rnd() * 10) * 3600000);
      const fechaGasto = new Date(cuando.getTime() - Math.floor(rnd() * 3) * 86400000);

      // La mezcla de estados imita la real: la mayoria pasa, un puñado se atora.
      const d = rnd();
      let status = 'recibida';
      if (d > 0.82) status = 'validada';
      else if (d > 0.68) status = 'aprobada';
      else if (d > 0.58) status = 'revision';
      else if (d > 0.50) status = 'rechazada';

      const importe = Math.round((120 + rnd() * 18000) * 100) / 100;
      const hora = cuando.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      const files = [{ role: 'comprobante_1', url: 'seed://foto', name: `Foto tomada ${hora}`, live: true }];
      if (rnd() > 0.7) files.push({ role: 'cotizacion', url: 'seed://cotizacion', name: 'cotizacion.pdf' });
      if (rnd() > 0.88) files.push({ role: 'comprobante_2', url: 'seed://foto2', name: 'Foto tomada ' + hora, live: true });

      filas.push({
        tenant_id: TENANT,
        solicitante: depto,
        departamento: depto,
        sucursal: ['00', '01', '02', '03'][Math.floor(rnd() * 4)],
        fecha_gasto: fechaGasto.toISOString().slice(0, 10),
        folio_solicitud: String(9000 + i).padStart(7, '0'),
        proveedor: prov,
        importe,
        files: JSON.stringify(files),
        // La marca viaja en el comentario: es el unico campo libre que la tabla ya tiene.
        comentarios: `${concepto} · ${MARCA}`,
        status,
        clasificacion: clas,
        forma_pago: forma,
        forma_pago_detalle: detalle,
        motivo_rechazo: status === 'rechazada' ? MOTIVOS[Math.floor(rnd() * MOTIVOS.length)] : null,
        revision_nota: status === 'revision' ? NOTAS_REVISION[Math.floor(rnd() * NOTAS_REVISION.length)] : null,
        monto_ocr: rnd() > 0.35 ? importe : null,
        monto_match: rnd() > 0.35,
        created_by: persona,
        created_at: cuando.toISOString(),
        updated_at: cuando.toISOString(),
        origen: 'interno',
      });
    }

    await knex('finance.expense_proofs').insert(filas);

    const por = await knex('finance.expense_proofs')
      .where('comentarios', 'like', `%${MARCA}%`)
      .groupBy('status').select('status', knex.raw('count(*)::int n'), knex.raw('sum(importe)::numeric total'));
    const rango = await knex('finance.expense_proofs')
      .where('comentarios', 'like', `%${MARCA}%`)
      .select(knex.raw('min(fecha_gasto)::text desde'), knex.raw('max(fecha_gasto)::text hasta'))
      .first();

    console.log(`✔ ${filas.length} levantamientos sembrados · del ${rango.desde} al ${rango.hasta}`);
    for (const r of por) {
      console.log(`   ${String(r.status).padEnd(11)} ${String(r.n).padStart(3)}   $${Number(r.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    }
    if (mio) {
      const mios = await knex('finance.expense_proofs').where({ created_by: mio })
        .where('comentarios', 'like', `%${MARCA}%`).count({ n: '*' }).first();
      console.log(`   de «${mio}»: ${mios.n}  (la pestaña «Míos»)`);
    }
    console.log('\nPara retirarlos: node database/seeds-newdb/dev-historial-gastos.js --limpiar');
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
