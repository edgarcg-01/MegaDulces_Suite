#!/usr/bin/env node
'use strict';
/**
 * [PGP.193][PGP.194] El aviso de pago al proveedor — servicio y migración REALES (ts-node) contra base real, con un
 * Kepler sintético en `kepler_ods` (sucursal 00, acreedor CZZ194, año 2099), todo dentro de una transacción que se
 * revierte al final (cero efecto).
 *
 * `crear()` ESCRIBE (el contacto de cobranza y el registro del aviso), así que se ejerce contra Postgres con el
 * payload de la pantalla. El PDF (Chromium) no se genera aquí: `pdfDeLaLiga` se prueba con `pdf` sustituido (lo que se
 * prueba es la liga: firma, tenant y revocación). Verifica:
 *   0. la migración pgp193 corre dos veces (idempotente) y deja las dos tablas con RLS;
 *   1. ⭐ el aviso de un pago pagado: proveedor del acreedor de Kepler, la factura con SU referencia y su documento, la
 *      nota de crédito que Kepler le aplicó (con la referencia del proveedor), lo pagado, la clave de rastreo y el
 *      comprobante; se puede mandar; dice que la factura va sin CFDI ligado;
 *   2. ⛔ un pago pendiente: no se puede mandar (con su motivo) y `crear` lo rechaza sin dejar fila;
 *   3. ⭐ crear por WhatsApp: guarda el contacto (WhatsApp a 12 dígitos, correo limpio), deja UNA fila de aviso con
 *      canal y destino, y devuelve la liga pública firmada, el wa.me con el número y el mailto;
 *   4. un segundo aviso por correo SÓLO con correo: el contacto conserva el WhatsApp (no se borra lo que ya estaba);
 *      el historial del pago trae los dos, el más nuevo primero;
 *   5. ⛔ correo o WhatsApp mal escritos, o un canal que no existe: 400, sin fila;
 *   6. la liga: abre el pago de SU aviso; revocada no abre; un token de otro tipo o basura no abre.
 *   7. ⭐ [PGP.208] un pago que el banco probó, sin comprobante: la clave de rastreo y la cuenta destino salen de la
 *      descarga del banco, y el mensaje al proveedor la lleva;
 *   8. ⛔ [PGP.208] descarga sin clave: no se inventa, se declara; con comprobante manda la del comprobante.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp194-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Aviso, JwtService, migracion;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ AvisoDePagoService: Aviso } = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/aviso-de-pago.service.ts')));
  ({ JwtService } = require('@nestjs/jwt'));
  migracion = require(path.join(__dirname, '../migrations-newdb/20261122001437_pgp193_contacto_y_avisos_al_proveedor.js'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp194-aviso-de-pago');

const nada = () => undefined;
const PROV = 'CZZ194';
const esperaError = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  console.log('\n[PGP.193][PGP.194] El aviso de pago al proveedor — servicio y migración reales, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdxe') IS NOT NULL AND to_regclass('kepler_ods.kdxf') IS NOT NULL AS ods`);
    if (!hay.rows[0].ods) { console.log('  · NO MEDIDO: este entorno no tiene kepler_ods'); await knex.destroy(); process.exit(0); }

    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);

      // 0. la migración, dos veces
      await migracion.up(trx);
      await migracion.up(trx);
      const t0 = (await trx.raw(`SELECT c.relname, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'finance' AND c.relname IN ('supplier_collection_contacts', 'payment_notices') ORDER BY 1`)).rows;
      ok(t0.length === 2 && t0.every((x) => x.rls), `0. la migración corre dos veces y deja las dos tablas con RLS (${t0.map((x) => x.relname).join(', ')})`);

      // ── Kepler sintético: una factura (X-A-20) con su referencia, una nota de crédito (X-D-55) aplicada a ella.
      await trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: 'FZZ194A', c7: '2099-03-01', c11: 1000, c16: 'F-PROV-194' });
      await trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'D', c4: 55, c5: 1, c6: 'NZZ194A', c7: '2099-03-05', c11: 300, c16: 'NC-PROV-194' });
      await trx('kepler_ods.kdxf').insert({ sucursal: '00', c1: '00', c2: PROV, c3: '2099-03-05', c4: 55, c5: 1, c6: 'NZZ194A', c7: 20, c8: 1, c9: 'FZZ194A', c10: 300 });
      await trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: 'FZZ194B', c7: '2099-03-01', c11: 500 });
      const oid = async (folio) => (await trx.raw(`SELECT md5('kepler_payable|00|20|1|' || ?)::uuid::text AS id`, [folio])).rows[0].id;

      // ── El Calendario: un pago ya pagado (con su comprobante) y uno pendiente.
      await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: '2099-03-10' }).del();
      const lote = (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: '2099-03-10' }).returning('*'))[0];
      const cuenta = (await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'BBVA', alias: 'BBVA PRUEBA', account_label: '7719499194', kind: 'bank' }).returning('*'))[0];
      const mk = async (folio, extra = {}) => {
        const a = (await trx('finance.payment_allocations').insert({
          tenant_id: T, lot_id: lote.id, classification: 'proveedor_mercancia', amount_assigned: 700, payment_method: 'transferencia',
          bank_account_id: cuenta.id, destination_account_text: '002320094300419400', ...extra,
        }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: await oid(folio), applied_amount: 700 });
        return a;
      };
      const pagado = await mk('FZZ194A', { status: 'executed', executed_at: trx.fn.now() });
      const pendiente = await mk('FZZ194B');
      await trx('finance.supplier_payment_proofs').insert({
        tenant_id: T, sucursal: 'CAL', doc_prefix: 'CAL', folio: pagado.id, metodo_pago: 'transferencia', pago_monto: 700,
        files: JSON.stringify([{ role: 'comprobante', url: 'prueba/pgp194.pdf', kind: 'pdf' }]), ocr_referencia: 'RASTREO194', ocr_fecha: '2099-03-10',
        ocr_cuenta_origen: '0489 7719 4991 94', status: 'validado', created_by: 'prueba_pgp194',
      });

      const jwt = new JwtService({ secret: process.env.JWT_SECRET });
      const s = Object.create(Aviso.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }), run: (_ctx, fn) => fn() },
        tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
        jwt, storage: null,
      });

      // 1. el aviso del pago pagado
      const a1 = await s.datos(pagado.id);
      const f1 = a1.facturas[0];
      ok(a1.proveedor.codigo === PROV && a1.se_puede === true && a1.motivo === null, `1. ⭐ se puede mandar, del acreedor de Kepler (${a1.proveedor.codigo}${a1.motivo ? ': ' + a1.motivo : ''})`);
      ok(a1.facturas.length === 1 && f1.referencia === 'F-PROV-194' && f1.documento === 'X-A-20 FZZ194A' && f1.pagado === 700 && f1.total === 1000 && f1.fecha === '2099-03-01',
        `1. la factura con SU referencia, su documento, su total y lo pagado (${JSON.stringify({ r: f1.referencia, d: f1.documento, t: f1.total, p: f1.pagado })})`);
      ok(f1.notas.length === 1 && f1.notas[0].nombre === 'Nota de crédito' && f1.notas[0].documento === 'X-D-55 NZZ194A' && f1.notas[0].referencia === 'NC-PROV-194' && f1.notas[0].importe === 300,
        `1. ⭐ la nota de crédito que Kepler le aplicó, con la referencia del proveedor (${JSON.stringify(f1.notas[0] ?? null)})`);
      ok(a1.rastreo === 'RASTREO194' && !!a1.comprobante_id && a1.fecha_pago === '2099-03-10' && a1.origen === 'BBVA PRUEBA ···9194' && a1.destino === '···9400',
        `1. rastreo, comprobante, fecha y cuentas enmascaradas (${a1.origen} → ${a1.destino})`);
      // Sin CFDI recibido sembrado, la factura va sin UUID y se dice; sin la vista de RFC (algún entorno), también se dice.
      const vistaRfc = (await trx.raw(`SELECT to_regclass('analytics.v_supplier_rfc') IS NOT NULL AS ok`)).rows[0].ok;
      ok(a1.faltantes.some((x) => /sin CFDI ligado/.test(x)) && a1.faltantes.length === (vistaRfc ? 1 : 2) && f1.uuid === null,
        `1. declara lo que no sabe (vista de RFC: ${vistaRfc ? 'sí' : 'NO, también se declara'}): ${a1.faltantes.join(' | ')}`);

      // 2. pendiente
      const a2 = await s.datos(pendiente.id);
      const e2 = await esperaError(() => s.crear(pendiente.id, { canal: 'whatsapp', whatsapp: '3511234567' }, 'prueba_pgp194'));
      ok(a2.se_puede === false && /no está marcado pagado/.test(a2.motivo) && !!e2 && (await trx('finance.payment_notices').where({ allocation_id: pendiente.id })).length === 0,
        `2. ⛔ un pago pendiente no se avisa (${a2.motivo})`);

      // 3. por WhatsApp
      const c3 = await s.crear(pagado.id, { canal: 'whatsapp', whatsapp: '351 123 4567', email: ' Cobranza@Proveedor194.COM ', nombre: 'Cobranza Prueba' }, 'prueba_pgp194');
      const avisos3 = await trx('finance.payment_notices').where({ allocation_id: pagado.id });
      const ct3 = await trx('finance.supplier_collection_contacts').where({ tenant_id: T, proveedor_code: PROV }).first();
      ok(avisos3.length === 1 && avisos3[0].canal === 'whatsapp' && avisos3[0].destino === '523511234567' && avisos3[0].created_by === 'prueba_pgp194',
        '3. ⭐ UNA fila de aviso, con canal, destino y quién');
      ok(ct3 && ct3.whatsapp === '523511234567' && ct3.email === 'cobranza@proveedor194.com' && ct3.contact_name === 'Cobranza Prueba', '3. el contacto de cobranza queda guardado, limpio');
      const tok = /\/api\/finance\/payment-notice\/([^/]+)\/aviso\.pdf$/.exec(c3.url)?.[1];
      ok(!!tok && jwt.verify(tok).n === avisos3[0].id && c3.aviso_id === avisos3[0].id, '3. la liga pública lleva firmado el id del aviso');
      ok(c3.whatsapp_url.startsWith('https://wa.me/523511234567?text=') && decodeURIComponent(c3.whatsapp_url).includes(c3.url) && decodeURIComponent(c3.whatsapp_url).includes('RASTREO194')
        && c3.mailto.startsWith('mailto:cobranza@proveedor194.com?subject='), '3. wa.me con el número, el mensaje y la liga; mailto con el correo');

      // 4. un segundo aviso, por correo, sólo con correo
      await s.crear(pagado.id, { canal: 'correo', email: 'pagos@proveedor194.com' }, 'prueba_pgp194');
      const ct4 = await trx('finance.supplier_collection_contacts').where({ tenant_id: T, proveedor_code: PROV }).first();
      const a4 = await s.datos(pagado.id);
      ok(ct4.email === 'pagos@proveedor194.com' && ct4.whatsapp === '523511234567' && ct4.contact_name === 'Cobranza Prueba',
        '4. el contacto cambia el correo y conserva el WhatsApp y el nombre');
      ok(a4.avisos.length === 2 && a4.avisos[0].canal === 'correo' && a4.avisos[1].canal === 'whatsapp' && a4.contacto?.email === 'pagos@proveedor194.com',
        '4. el historial trae los dos avisos, el más nuevo primero, y el diálogo se llena con el contacto');

      // 5. mal escrito
      const antes = (await trx('finance.payment_notices').where({ allocation_id: pagado.id })).length;
      const e5a = await esperaError(() => s.crear(pagado.id, { canal: 'correo', email: 'no-es-correo' }, 'prueba_pgp194'));
      const e5b = await esperaError(() => s.crear(pagado.id, { canal: 'whatsapp', whatsapp: '12345' }, 'prueba_pgp194'));
      const e5c = await esperaError(() => s.crear(pagado.id, { canal: 'fax' }, 'prueba_pgp194'));
      ok(!!e5a && !!e5b && !!e5c && (await trx('finance.payment_notices').where({ allocation_id: pagado.id })).length === antes,
        `5. ⛔ correo o WhatsApp mal escritos y canal inexistente: 400, sin fila (${[e5a, e5b, e5c].map((e) => e && e.message).join(' | ')})`);

      // 6. la liga
      s.pdf = async (id) => ({ pdf: Buffer.from(id), nombre: 'x.pdf' });
      const r6 = await s.pdfDeLaLiga(tok);
      ok(r6.pdf.toString() === pagado.id, '6. la liga abre el pago de SU aviso');
      await trx('finance.payment_notices').where({ id: avisos3[0].id }).update({ revoked_at: trx.fn.now(), revoked_by: 'prueba_pgp194' });
      const e6a = await esperaError(() => s.pdfDeLaLiga(tok));
      const ajeno = jwt.sign({ t: 'customer_deposit', tenant_id: T, n: avisos3[0].id });
      const e6b = await esperaError(() => s.pdfDeLaLiga(ajeno));
      const e6c = await esperaError(() => s.pdfDeLaLiga('basura'));
      ok(!!e6a && /ya no está disponible/.test(e6a.message) && !!e6b && !!e6c, '6. ⛔ revocada, de otro tipo o basura: no abre');

      // 7–8. [PGP.208] Un pago que el BANCO probó y nadie le subió comprobante (DISTRIBUIDORA DE LA ROSA, 2026-11-20):
      // la clave de rastreo y la cuenta que recibió salen de la descarga del banco. Sin comprobante y con una descarga
      // que no trae clave (traspaso del mismo banco), se declara — antes salía «—» sin decir nada.
      await trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: 'FZZ194C', c7: '2099-03-01', c11: 900 });
      await trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: 'FZZ194D', c7: '2099-03-01', c11: 800 });
      const archivo = (await trx('finance.bank_statement_files').insert({
        tenant_id: T, bank_account_id: cuenta.id, bank: 'BBVA', file_sha1: 'pgp208-prueba', date_from: '2099-03-10', date_to: '2099-03-10',
        lines_in_file: 2, lines_new: 2, opening_balance: 5000, closing_balance: 3500, total_in: 0, total_out: 1500, balance_ok: true, account_check: 'sin_testigo',
      }).returning('*'))[0];
      const estado = (await trx('finance.bank_statements').insert({ tenant_id: T, bank_account_id: cuenta.id, period: '2099-03' }).returning('*'))[0];
      const salida = async (llave, importe, extra) => {
        await trx('finance.bank_statement_lines').insert({
          tenant_id: T, file_id: archivo.id, bank_account_id: cuenta.id, line_no: llave === 'pgp208-con' ? 1 : 2, seq: llave === 'pgp208-con' ? 1 : 2,
          movement_date: '2099-03-10', concept: 'PAGO TRANSFERENCIA SPEI', amount_in: 0, amount_out: importe, running_balance: 0, line_key: llave, ...extra,
        });
        return (await trx('finance.bank_movements').insert({
          tenant_id: T, statement_id: estado.id, bank_account_id: cuenta.id, movement_date: '2099-03-10', concept: 'PAGO TRANSFERENCIA SPEI',
          amount_in: 0, amount_out: importe, client_uuid: `banco:${llave}`, sync_source: 'banco',
        }).returning('id'))[0].id;
      };
      const RASTREO_DEL_BANCO = ' RASTREO-BANCO-208 '; // con espacios a propósito: el aviso los recorta
      const movCon = await salida('pgp208-con', 700, { tracking_key: RASTREO_DEL_BANCO, counterparty_account: '002320000000008208' });
      const movSin = await salida('pgp208-sin', 800, { tracking_key: null, counterparty_account: null });
      const porBanco = await mk('FZZ194C', { status: 'executed', executed_at: trx.fn.now(), destination_account_text: null, paid_bank_movement_id: movCon, paid_bank_date: '2099-03-10', paid_bank_amount: 700 });
      const sinClave = await mk('FZZ194D', { status: 'executed', executed_at: trx.fn.now(), destination_account_text: null, paid_bank_movement_id: movSin, paid_bank_date: '2099-03-10', paid_bank_amount: 800 });

      const a7 = await s.datos(porBanco.id);
      ok(a7.rastreo === 'RASTREO-BANCO-208' && a7.destino === '···8208' && a7.fecha_pago === '2099-03-10' && a7.comprobante_id === null,
        `7. ⭐ [PGP.208] sin comprobante, la clave y la cuenta salen de la descarga del banco (${a7.rastreo} → ${a7.destino})`);
      ok(a7.faltantes.some((x) => /sin comprobante anexo/.test(x)) && !a7.faltantes.some((x) => /clave de rastreo/i.test(x)),
        `7. declara el PDF que falta y NO declara la clave, porque sí la tiene (${a7.faltantes.join(' | ')})`);
      const c7 = await s.crear(porBanco.id, { canal: 'liga' }, 'prueba_pgp208');
      ok(decodeURIComponent(c7.whatsapp_url).includes('RASTREO-BANCO-208'), '7. el mensaje al proveedor lleva la clave de rastreo del banco');

      const a8 = await s.datos(sinClave.id);
      ok(a8.rastreo === null && a8.destino === null && a8.faltantes.some((x) => /Sin clave de rastreo/.test(x)),
        `8. ⛔ [PGP.208] la descarga sin clave (traspaso del mismo banco): no se inventa, se declara (${a8.faltantes.join(' | ')})`);
      // Control: el pago con comprobante (caso 1) sigue tomando SU clave, no la del banco.
      ok((await s.datos(pagado.id)).rastreo === 'RASTREO194', '8. control: con comprobante manda la clave del comprobante');

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail++; console.log('  ✗ error:', e.message); }
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
