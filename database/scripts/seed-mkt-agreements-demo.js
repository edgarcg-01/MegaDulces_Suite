/**
 * `[MKT.1]` — Datos de prueba para Acuerdos con proveedor (formato MKTN001).
 *
 * ── Para qué ────────────────────────────────────────────────────────────────────────────────
 * Levantar en LOCAL los cuatro estados que la pantalla tiene que saber dibujar, y sobre todo los
 * dos que sólo se ven con datos: **cobertura parcial del expediente** y **acuerdo sin monto
 * pactado**. Con la tabla vacía, el tablero se ve perfecto y no prueba nada.
 *
 * ── Qué siembra ─────────────────────────────────────────────────────────────────────────────
 *   1. Alteño 3% · AUTORIZADO · 6 canales, 3 con evidencia  → cobertura parcial (el caso real,
 *      folio 1013 del formato en papel). Con monto: $76,946.02.
 *   2. Klassco Winis · VIGENTE · 3 canales, los 3 completos → cobertura 100%.
 *   3. DELICIATE Churpias · BORRADOR · 4 canales, sin evidencia y SIN FOLIO (así se prueba que
 *      el folio nace con la autorización y no antes).
 *   4. Canels 5 EXH · VIGENTE · 6 canales, **ninguno** con evidencia y venciendo → es la fila
 *      que el tablero tiene que gritar.
 *   5. Mondelez · VIGENTE · 2 canales, **sin monto pactado** (`monto NULL`) → prueba que la
 *      pantalla escribe «sin monto» y no «$0».
 *
 * ── Idempotente ─────────────────────────────────────────────────────────────────────────────
 * Cada acuerdo se identifica por `(proveedor, fecha_negociacion)`; si ya está, se salta. Con
 * `--reset` borra sólo lo sembrado por este script (por esa misma llave), nunca la tabla entera:
 * un `DELETE FROM` acá borraría acuerdos reales el día que alguien lo corra en la DB equivocada.
 *
 * Uso:
 *   node database/scripts/seed-mkt-agreements-demo.js            # siembra lo que falte
 *   node database/scripts/seed-mkt-agreements-demo.js --reset    # rehace lo sembrado
 *
 * ⚠️ Nunca contra producción: verifica el destino antes de escribir y aborta si huele a prod.
 */
'use strict';

const knexLib = require('knex');
const fs = require('fs');
const path = require('path');

const RESET = process.argv.includes('--apply-reset') || process.argv.includes('--reset');

/** Lee `DATABASE_URL_NEW` del `.env` de la raíz sin cargar dotenv. */
function urlDelEnv() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  const envPath = path.resolve(__dirname, '../../.env');
  const linea = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('DATABASE_URL_NEW='));
  if (!linea) throw new Error('No encontré DATABASE_URL_NEW en el .env');
  return linea.slice('DATABASE_URL_NEW='.length).trim();
}

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/**
 * Los cinco acuerdos. `canales` usa códigos que existen en cualquier base con las sucursales
 * Kepler sembradas; los que no existan se avisan y se saltan, en vez de reventar el seed entero.
 */
const ACUERDOS = [
  {
    clave: 'Alteño|2026-09-22',
    cabecera: {
      folio: 'MK-2026-1013',
      empresa: 'Mega Dulces De Los Altos',
      apoyo: 'sell_out',
      proveedor: 'Alteño',
      agente_ventas: null,
      fecha_negociacion: '2026-09-22',
      periodo: 9,
      vigencia_desde: '2026-10-05',
      vigencia_hasta: '2026-10-16',
      vigencia_hasta_texto: null,
      oferta_negociada: '3% de descuento en toda la línea Alteño, en 2 pedidos.',
      mecanica:
        '3% de descuento en la línea Alteño. Descuento aplicado por Sistemas: actualiza, ' +
        'realiza tus exhibiciones especiales y labor de venta.',
      presupuesto_tipo: 'topado',
      presupuesto_detalle: '50 cajas Pal Vaquita /10 para la 1ª compra, 125 cajas para la 2ª.',
      presupuesto_fecha: '2026-10-16',
      recurso: 'otros',
      recurso_otros: '3% en 2 pedidos',
      conceptos:
        'Agendar reporte de lo vendido en dichas fechas y canales por el 3%. ' +
        'Agendar reporte de avance el 12, 19 y 26 de octubre.',
      monto: 76946.02,
      distribucion_producto: 'Pal Vaquita /10',
      distribucion_codigo: '20054',
      distribucion_cargo: 'con_cargo',
      autoriza_nombre: 'Cristian López',
      status: 'autorizado',
      created_by_username: 'jefe_marketing',
      authorized_by_username: 'jefe_marketing',
      authorized_at: '2026-09-22T19:04:00Z',
    },
    codigos: [
      { position: 1, code: '20054', descripcion: 'Pal Vaquita /10' },
      { position: 2, code: '20061', descripcion: 'Pal Vaquita mini /40' },
    ],
    canales: [
      { code: '01', cajas_texto: '13 cj 20054', con_cargo: true, requeridas: 3, evidencias: 3 },
      { code: '03', cajas_texto: '13 cj 20054', con_cargo: true, requeridas: 3, evidencias: 2 },
      { code: 'MD-30', cajas_texto: '24 cj 20054', con_cargo: true, requeridas: 3, evidencias: 3 },
      { code: '06', cajas_texto: '12 cj 20054', con_cargo: true, requeridas: 3, evidencias: 0 },
      { code: '05', cajas_texto: null, con_cargo: false, requeridas: 3, evidencias: 0 },
      { code: '04', cajas_texto: '6 cj 20054', con_cargo: true, requeridas: 2, evidencias: 1 },
    ],
  },
  {
    clave: 'Klassco|2026-09-01',
    cabecera: {
      folio: 'MK-2026-0994',
      empresa: 'Mega Dulces De Los Altos',
      apoyo: 'sell_out',
      proveedor: 'Klassco',
      fecha_negociacion: '2026-09-01',
      periodo: 9,
      vigencia_desde: '2026-09-01',
      vigencia_hasta: '2026-09-30',
      vigencia_hasta_texto: null,
      oferta_negociada: '2 exhibidores de Winis congelada = 1 exhibidor más sin costo.',
      mecanica: '2 EXH Winis congelada = gratis 1 EXH más',
      presupuesto_tipo: 'topado',
      presupuesto_detalle: '40 exhibidores en total.',
      presupuesto_fecha: '2026-09-30',
      recurso: 'proveedor_sin_cargo',
      conceptos: 'Reporte semanal de exhibidores entregados.',
      monto: 38400.0,
      distribucion_producto: 'Winis congelada EXH',
      distribucion_codigo: '09068',
      distribucion_cargo: 'sin_cargo',
      autoriza_nombre: 'Cristian López',
      status: 'vigente',
      created_by_username: 'marketing',
      authorized_by_username: 'jefe_marketing',
      authorized_at: '2026-08-30T16:00:00Z',
    },
    codigos: [{ position: 1, code: '09068', descripcion: 'Winis congelada EXH' }],
    canales: [
      { code: '01', cajas_texto: '10 exh', con_cargo: false, requeridas: 2, evidencias: 2 },
      { code: '03', cajas_texto: '10 exh', con_cargo: false, requeridas: 2, evidencias: 2 },
      { code: '06', cajas_texto: '8 exh', con_cargo: false, requeridas: 2, evidencias: 2 },
    ],
  },
  {
    clave: 'DELICIATE|2026-09-23',
    cabecera: {
      // Sin folio: es BORRADOR. El CHECK de la tabla lo exige, y es justo lo que se quiere probar.
      folio: null,
      empresa: 'Mega Dulces De Los Altos',
      apoyo: 'sell_out',
      proveedor: 'DELICIATE',
      fecha_negociacion: '2026-09-23',
      periodo: 4,
      vigencia_desde: '2026-09-23',
      vigencia_hasta: null,
      vigencia_hasta_texto: 'hasta agotar',
      oferta_negociada: 'En la compra de 3 exhibidores de Churpias /24 = gratis 1 exhibidor más',
      mecanica: 'En la compra de 3 exhibidores de Churpias /24 = gratis 1 exhibidor más',
      presupuesto_tipo: 'topado',
      presupuesto_detalle: '30 exhibidores.',
      recurso: 'proveedor_sin_cargo',
      monto: 18250.5,
      distribucion_producto: 'Churpia /24',
      distribucion_codigo: '20054',
      distribucion_cargo: 'sin_cargo',
      status: 'borrador',
      created_by_username: 'marketing',
    },
    codigos: [
      { position: 1, code: '20054', descripcion: 'Churpia /24' },
      { position: 2, code: '20061', descripcion: 'Churpia mini /40' },
    ],
    canales: [
      { code: '01', cajas_texto: '13 cj', con_cargo: true, requeridas: 1, evidencias: 0 },
      { code: '03', cajas_texto: '13 cj', con_cargo: true, requeridas: 1, evidencias: 0 },
      { code: 'MD-30', cajas_texto: '24 cj', con_cargo: true, requeridas: 1, evidencias: 0 },
      { code: '06', cajas_texto: null, con_cargo: false, requeridas: 1, evidencias: 0 },
    ],
  },
  {
    clave: 'Canels|2026-09-10',
    cabecera: {
      folio: 'MK-2026-1001',
      empresa: 'Mega Dulces De Los Altos',
      apoyo: 'exhibicion',
      proveedor: 'Canels',
      fecha_negociacion: '2026-09-10',
      periodo: 9,
      vigencia_desde: '2026-09-20',
      vigencia_hasta: '2026-09-26',
      vigencia_hasta_texto: null,
      mecanica: '5 EXH chicle Canels celofán 4S /60 = gratis 1 EXH más',
      presupuesto_tipo: 'topado',
      presupuesto_detalle: '25 exhibidores.',
      recurso: 'cedis_nota_credito',
      conceptos: 'Se cobra con nota de crédito al cierre.',
      monto: 24180.0,
      distribucion_producto: 'Canels celofán 4S /60',
      distribucion_codigo: '09003',
      distribucion_cargo: 'con_cargo',
      status: 'vigente',
      created_by_username: 'marketing',
      authorized_by_username: 'jefe_marketing',
      authorized_at: '2026-09-18T15:30:00Z',
    },
    codigos: [{ position: 1, code: '09003', descripcion: 'Canels celofán 4S /60' }],
    // Ninguna plaza subió evidencia y está por vencer: la fila que el tablero tiene que gritar.
    canales: [
      { code: '01', cajas_texto: '5 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
      { code: '02', cajas_texto: '5 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
      { code: '03', cajas_texto: '5 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
      { code: '04', cajas_texto: '3 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
      { code: '05', cajas_texto: '3 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
      { code: '06', cajas_texto: '4 exh', con_cargo: true, requeridas: 2, evidencias: 0 },
    ],
  },
  {
    clave: 'Mondelez|2026-09-05',
    cabecera: {
      folio: 'MK-2026-0987',
      empresa: 'Mega Dulces De Los Altos',
      apoyo: 'promocional',
      proveedor: 'Mondelez',
      fecha_negociacion: '2026-09-05',
      periodo: 9,
      vigencia_desde: '2026-09-05',
      vigencia_hasta: null,
      vigencia_hasta_texto: 'hasta agotar promocionales',
      mecanica: '$250 de mercancía = 1 promocional',
      presupuesto_tipo: 'abierto',
      // SIN monto pactado. NULL, no 0: es lo que prueba que la pantalla escribe «sin monto».
      monto: null,
      recurso: 'proveedor_promocionales',
      status: 'vigente',
      created_by_username: 'marketing',
      authorized_by_username: 'jefe_marketing',
      authorized_at: '2026-09-04T18:00:00Z',
    },
    codigos: [],
    canales: [
      { code: '01', cajas_texto: null, con_cargo: false, requeridas: 1, evidencias: 1 },
      { code: 'MD-30', cajas_texto: null, con_cargo: false, requeridas: 1, evidencias: 0 },
    ],
  },
];

/**
 * Quién crea, quién autoriza y quién sube la evidencia — resueltos CONTRA LA BASE.
 *
 * ⚠️ El CHECK `commercial_promo_agreements_autorizacion_chk` exige `authorized_by` (el **id**),
 * no el nombre: un acuerdo autorizado por "alguien" no se puede auditar. Este seed no inventa
 * UUIDs — busca al usuario de verdad, y si no está lo DECLARA y aborta, en vez de sembrar una
 * autorización que apunta a nadie.
 *
 * `cristian.lopez` es quien firma el formato en papel; `fer_zambrano`, Mercadotecnia.
 */
const PERSONAS = {
  autoriza: { username: 'cristian.lopez', rol: 'jefe_marketing' },
  crea: { username: 'fer_zambrano', rol: 'marketing' },
};

async function resolverPersonas(knex) {
  const salida = {};
  const faltan = [];
  for (const [papel, quien] of Object.entries(PERSONAS)) {
    let u = await knex('identity.users')
      .select('id', 'username')
      .where({ tenant_id: TENANT, username: quien.username })
      .first();
    // Si esa persona no está en esta base, sirve cualquiera con el mismo rol: lo que el seed
    // necesita es un id REAL, no ese id en particular.
    if (!u) {
      u = await knex('identity.users')
        .select('id', 'username')
        .where({ tenant_id: TENANT, role_name: quien.rol })
        .orderBy('username')
        .first();
    }
    if (!u) faltan.push(`${papel} (${quien.username} o rol ${quien.rol})`);
    else salida[papel] = u;
  }
  if (faltan.length) {
    throw new Error(
      `No hay usuario para: ${faltan.join(', ')}. ` +
        'Corré antes los seeds base — sembrar una autorización sin autor no se puede auditar.',
    );
  }
  return salida;
}

/** Quién sube la evidencia de cada plaza: gente de tienda real de esta base. */
async function resolverGenteDeTienda(knex) {
  const filas = await knex('identity.users')
    .select('id', 'username')
    .where('tenant_id', TENANT)
    .whereIn('role_name', ['encargado_tienda', 'auxiliar_tienda', 'supervisor'])
    .orderBy('username');
  return filas;
}

/** Nombres de archivo verosímiles para la evidencia sembrada. */
const NOMBRES_EVIDENCIA = [
  'exhibicion-armada.jpg',
  'cenefa-precio.jpg',
  'anaquel-cierre.jpg',
  'exhibidor-lateral.jpg',
];

async function main() {
  const url = urlDelEnv();

  // Guarda de destino: este script ESCRIBE. Mejor abortar por exceso de cuidado que sembrar
  // acuerdos de prueba en la base que usa el negocio.
  if (/railway|rlwy\.net|proxy\.rlw/i.test(url)) {
    console.error('⛔ La URL apunta a producción (Railway). Este seed es sólo para local/staging.');
    process.exit(1);
  }

  const knex = knexLib({ client: 'pg', connection: url });
  const resumen = { creados: 0, saltados: 0, canales: 0, evidencias: 0, sinSucursal: [] };

  try {
    // Sucursales disponibles en ESTA base. Se resuelven una vez y se reusan.
    const almacenes = await knex('commercial.warehouses')
      .select('id', 'code', 'name')
      .where('tenant_id', TENANT)
      .whereNull('deleted_at');
    const porCode = new Map(almacenes.map((w) => [w.code.toLowerCase(), w]));
    if (!porCode.size) throw new Error('No hay sucursales sembradas: corré antes los seeds base.');

    const personas = await resolverPersonas(knex);
    const gente = await resolverGenteDeTienda(knex);
    console.log(
      `  crea: ${personas.crea.username} · autoriza: ${personas.autoriza.username} · ` +
        `gente de tienda: ${gente.length}`,
    );

    for (const acuerdo of ACUERDOS) {
      const [proveedor, fecha] = acuerdo.clave.split('|');

      const existente = await knex('commercial.promo_agreements')
        .select('id')
        .where({ tenant_id: TENANT, proveedor, fecha_negociacion: fecha })
        .first();

      if (existente && !RESET) {
        resumen.saltados++;
        continue;
      }
      if (existente && RESET) {
        // CASCADE se lleva códigos, canales y archivos de ESE acuerdo. No se toca nada más.
        await knex('commercial.promo_agreements').where('id', existente.id).del();
      }

      // El autor y el autorizador se sobrescriben SIEMPRE con gente real de esta base: los
      // nombres que trae `ACUERDOS` son sólo para leer el script.
      const cab = { ...acuerdo.cabecera };
      cab.created_by = personas.crea.id;
      cab.created_by_username = personas.crea.username;
      if (cab.authorized_at) {
        cab.authorized_by = personas.autoriza.id;
        cab.authorized_by_username = personas.autoriza.username;
      }

      const [fila] = await knex('commercial.promo_agreements')
        .insert({ tenant_id: TENANT, ...cab })
        .returning('id');
      const agreementId = fila.id ?? fila;
      resumen.creados++;

      if (acuerdo.codigos.length) {
        await knex('commercial.promo_agreement_codes').insert(
          acuerdo.codigos.map((c) => ({ tenant_id: TENANT, agreement_id: agreementId, ...c })),
        );
      }

      for (const canal of acuerdo.canales) {
        const w = porCode.get(canal.code.toLowerCase());
        if (!w) {
          // Se declara y se sigue: una base sin esa plaza no invalida el resto del seed.
          if (!resumen.sinSucursal.includes(canal.code)) resumen.sinSucursal.push(canal.code);
          continue;
        }

        const [canalFila] = await knex('commercial.promo_agreement_channels')
          .insert({
            tenant_id: TENANT,
            agreement_id: agreementId,
            warehouse_id: w.id,
            warehouse_code: w.code,
            warehouse_name: w.name,
            cajas_texto: canal.cajas_texto,
            con_cargo: canal.con_cargo,
            evidence_required: canal.requeridas,
            // Se inserta en 0 a propósito y se deja que el recálculo lo ponga: así el seed ejerce
            // el MISMO camino que la app, en vez de escribir un contador a mano que podría
            // quedar diciendo algo que los archivos no respaldan.
            evidence_count: 0,
          })
          .returning('id');
        const channelId = canalFila.id ?? canalFila;
        resumen.canales++;

        for (let i = 0; i < canal.evidencias; i++) {
          // Persona de tienda real, rotando: la evidencia la sube quien está en el piso, y
          // `uploaded_by` tiene que poder auditarse igual que la autorización.
          const sube = gente.length ? gente[(resumen.evidencias + i) % gente.length] : null;
          await knex('commercial.promo_agreement_files').insert({
            tenant_id: TENANT,
            agreement_id: agreementId,
            channel_id: channelId,
            kind: 'evidencia',
            file_name: NOMBRES_EVIDENCIA[i % NOMBRES_EVIDENCIA.length],
            file_url: `https://demo.local/mkt/${agreementId}/${w.code}/${i + 1}.jpg`,
            mime_type: 'image/jpeg',
            size_bytes: 180000 + i * 4200,
            uploaded_by: sube?.id ?? null,
            uploaded_by_username: sube?.username ?? null,
          });
          resumen.evidencias++;
        }

        // Recálculo desde los archivos — el mismo criterio que el servicio.
        const [agg] = await knex('commercial.promo_agreement_files')
          .where({ channel_id: channelId, kind: 'evidencia' })
          .whereNull('deleted_at')
          .select(
            knex.raw('count(*)::int as n'),
            knex.raw('min(uploaded_at) as primera'),
            knex.raw('max(uploaded_at) as ultima'),
          );
        await knex('commercial.promo_agreement_channels')
          .where('id', channelId)
          .update({
            evidence_count: agg.n,
            evidence_first_at: agg.primera ?? null,
            evidence_last_at: agg.ultima ?? null,
          });
      }

      // La evidencia de la NEGOCIACIÓN (channel_id NULL): el correo con el que se pactó.
      if (acuerdo.cabecera.status !== 'borrador') {
        await knex('commercial.promo_agreement_files').insert({
          tenant_id: TENANT,
          agreement_id: agreementId,
          channel_id: null,
          kind: 'negociacion',
          file_name: `correo-${proveedor.toLowerCase()}.png`,
          file_url: `https://demo.local/mkt/${agreementId}/negociacion.png`,
          mime_type: 'image/png',
          size_bytes: 19400,
          uploaded_by: personas.autoriza.id,
          uploaded_by_username: personas.autoriza.username,
        });
      }
    }

    console.log('\n[MKT.1] Seed de acuerdos con proveedor (demo)');
    console.log(`  acuerdos creados : ${resumen.creados}`);
    console.log(`  ya existían      : ${resumen.saltados}${RESET ? '' : '  (usá --reset para rehacerlos)'}`);
    console.log(`  expedientes      : ${resumen.canales}`);
    console.log(`  evidencias       : ${resumen.evidencias}`);
    if (resumen.sinSucursal.length) {
      console.log(`  ⚠️  sin sucursal en esta base (se saltaron): ${resumen.sinSucursal.join(', ')}`);
    }

    // Foto final: lo que la pantalla debería estar mostrando.
    const filas = await knex.raw(
      `SELECT a.proveedor, a.folio, a.status, a.monto,
              count(c.id) AS canales,
              count(*) FILTER (WHERE c.evidence_count >= c.evidence_required) AS completos
         FROM commercial.promo_agreements a
         LEFT JOIN commercial.promo_agreement_channels c
                ON c.tenant_id = a.tenant_id AND c.agreement_id = a.id
        WHERE a.tenant_id = ? AND a.deleted_at IS NULL
        GROUP BY a.id, a.proveedor, a.folio, a.status, a.monto
        ORDER BY a.fecha_negociacion DESC`,
      [TENANT],
    );
    console.log('\n  proveedor    folio           estado      canales  completos  monto');
    for (const r of filas.rows) {
      console.log(
        `  ${String(r.proveedor).padEnd(12)} ${String(r.folio ?? '—').padEnd(15)} ` +
          `${String(r.status).padEnd(11)} ${String(r.canales).padStart(7)} ` +
          `${String(r.completos).padStart(10)}  ${r.monto === null ? 'sin monto' : '$' + r.monto}`,
      );
    }
    console.log('');
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
