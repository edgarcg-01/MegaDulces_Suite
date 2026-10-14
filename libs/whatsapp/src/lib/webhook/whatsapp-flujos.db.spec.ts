/**
 * `[RH.3.1]` La migración del libro de WhatsApp contra Postgres: un mensaje de reclutamiento cabe sin hilo de comercio,
 * pero un mensaje de COMERCIO sigue exigiendo su hilo, y el mapa de números acepta sólo flujos conocidos.
 *
 *   WHATSAPP_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/whatsapp/vitest.config.ts
 *   (también acepta HR_DB_TEST_URL). Todo dentro de una transacción que se deshace. Sin base: NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['WHATSAPP_DB_TEST_URL'] || process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const MIG = require(path.resolve(__dirname, '../../../../../database/migrations-newdb', '20261013144148_whatsapp_flujo_por_numero.js'));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.3.1] NO MEDIDO: sin WHATSAPP_DB_TEST_URL no se prueba la migración del libro de WhatsApp.');

suite('[RH.3.1] libro de WhatsApp por flujo', () => {
  it('reclutamiento sin hilo sí; comercio sin hilo no; flujos y teléfono obligatorios', async () => {
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    let n = 0;
    const fallo = async (trx: Knex.Transaction, fn: () => Promise<unknown>): Promise<string> => {
      const sp = `sp${++n}`;
      await trx.raw(`SAVEPOINT ${sp}`);
      try { await fn(); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return 'sin error'; } catch (e) {
        await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
        return String((e as { code?: string }).code ?? 'error');
      }
    };
    try {
      await knex.transaction(async (trx) => {
        await MIG.up(trx);
        await MIG.up(trx); // idempotente
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const sello = Date.now();
        const M = 'whatsapp.messages';
        const msg = (o: Record<string, unknown>) => ({ tenant_id: TENANT, direction: 'in', type: 'text', body: 'hola', wa_message_id: `w-${sello}-${++n}`, ...o });

        r['reclutamiento'] = await fallo(trx, () => trx(M).insert(msg({ flow: 'recruitment', phone: '523511234567', phone_number_id: 'rh-1' })));
        r['malos'] = [
          await fallo(trx, () => trx(M).insert(msg({ flow: 'commerce' }))),                           // comercio sin hilo
          await fallo(trx, () => trx(M).insert(msg({ flow: 'recruitment' }))),                        // sin teléfono
          await fallo(trx, () => trx(M).insert(msg({ flow: 'marketing', phone: '523511234567' }))),   // flujo inventado
          await fallo(trx, () => trx('whatsapp.phone_number_tenant_map').insert({ phone_number_id: `x-${sello}`, tenant_id: TENANT, flow: 'ventas' })),
        ];
        // Lo existente sigue siendo comercio (el default).
        r['default'] = (await trx.raw(`SELECT column_default FROM information_schema.columns WHERE table_schema='whatsapp' AND table_name='messages' AND column_name='flow'`)).rows[0]?.column_default;
        await trx('whatsapp.phone_number_tenant_map').insert({ phone_number_id: `rh-${sello}`, tenant_id: TENANT, label: 'RH prueba', flow: 'recruitment' });
        r['mapa'] = (await trx('whatsapp.phone_number_tenant_map').where({ phone_number_id: `rh-${sello}` }).first('flow')).flow;

        // La ventana de 24 h: el último ENTRANTE de ese teléfono en ese flujo.
        const tel = `52${String(sello).slice(-10)}`;
        await trx(M).insert(msg({ flow: 'recruitment', phone: tel, created_at: trx.raw(`now() - interval '30 hours'`) }));
        await trx(M).insert(msg({ flow: 'recruitment', phone: tel, direction: 'out', created_at: trx.raw(`now() - interval '1 hour'`) })); // salida: no cuenta
        const ventana = async () => (await trx.raw(`SELECT now() - max(created_at) < interval '24 hours' AS dentro FROM whatsapp.messages WHERE flow='recruitment' AND phone=? AND direction='in'`, [tel])).rows[0].dentro;
        r['fueraDeVentana'] = await ventana();
        await trx(M).insert(msg({ flow: 'recruitment', phone: tel, created_at: trx.raw(`now() - interval '2 hours'`) }));
        r['dentroDeVentana'] = await ventana();
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    expect(r['reclutamiento']).toBe('sin error');
    expect(r['malos']).toEqual(['23514', '23514', '23514', '23514']);
    expect(String(r['default'])).toContain('commerce');
    expect(r['mapa']).toBe('recruitment');
    // Un mensaje SALIENTE reciente no abre la ventana; sólo un entrante.
    expect(r['fueraDeVentana']).toBe(false);
    expect(r['dentroDeVentana']).toBe(true);
  }, 60_000);
});
