/**
 * `[RH.2.1]` La capa de datos de reclutamiento contra Postgres: lo que la base sostiene sola.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ff';
const ROLLBACK = new Error('rollback-intencional');
const MIG = require(path.resolve(__dirname, '../../../../../database/migrations-newdb', '20261012155411_talent_reclutamiento_datos.js'));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.1] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el esquema de reclutamiento contra la base.');

suite('[RH.2.1] reclutamiento — capa de datos', () => {
  it('teléfono normalizado, marcas con motivo, bitácoras de sólo agregar y aislamiento por tenant', async () => {
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    let n = 0;
    // Corre algo que DEBE fallar sin tumbar la transacción; devuelve el código de Postgres.
    const fallo = async (trx: Knex.Transaction, fn: () => Promise<unknown>, comoApp = false): Promise<string> => {
      const sp = `sp${++n}`;
      await trx.raw(`SAVEPOINT ${sp}`);
      try {
        if (comoApp) await trx.raw('SET LOCAL ROLE app_runtime');
        await fn();
        return 'sin error';
      } catch (e) {
        return String((e as { code?: string }).code ?? 'error');
      } finally {
        await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      }
    };
    try {
      await knex.transaction(async (trx) => {
        await MIG.up(trx);
        await MIG.up(trx); // idempotente
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const C = 'talent.candidates';

        // ── La misma persona por WhatsApp (13 dígitos) y por el portal (10) ────────────────
        const [bot] = await trx(C).insert({ tenant_id: TENANT, phone: '5213511234567', full_name: 'Bot', source: 'whatsapp' }).returning(['id', 'phone_key']);
        const [web] = await trx(C).insert({ tenant_id: TENANT, phone: '(351) 123-4567', full_name: 'Web', source: 'portal' }).returning(['id', 'phone_key']);
        const [sin] = await trx(C).insert({ tenant_id: TENANT, phone: null }).returning('phone_key');
        r['phone'] = [bot.phone_key, web.phone_key, sin.phone_key];

        // ── Conserva el id de Mega Talento ─────────────────────────────────────────────────
        const MT_ID = '7f1b8c2e-0000-4000-8000-000000000001';
        await trx(C).insert({ tenant_id: TENANT, id: MT_ID, legacy_portal_id: 'AbCdEfGhIjKlMnOpQrSt', stage: 'aptitudes' });
        r['mismoId'] = (await trx(C).where({ id: MT_ID }).first('legacy_portal_id')).legacy_portal_id;

        // ── Marcas sin motivo, semáforo raro, evento de un tipo que no existe ───────────────
        r['malos'] = [
          await fallo(trx, () => trx(C).where({ id: bot.id }).update({ no_rehire: true, no_rehire_at: trx.fn.now() })),
          await fallo(trx, () => trx(C).where({ id: bot.id }).update({ no_rehire: true, no_rehire_reason: '  ', no_rehire_at: trx.fn.now() })),
          await fallo(trx, () => trx(C).where({ id: bot.id }).update({ is_spam: true, spam_reason: 'sin ciudad ni puesto' })),
          await fallo(trx, () => trx(C).where({ id: bot.id }).update({ traffic_light: 'azul' })),
          await fallo(trx, () => trx('talent.candidate_events').insert({ tenant_id: TENANT, candidate_id: bot.id, event_type: 'llamada' })),
          await fallo(trx, () => trx('talent.candidate_events').insert({ tenant_id: TENANT, candidate_id: bot.id, event_type: 'contacto', channel: 'fax' })),
          await fallo(trx, () => trx('talent.job_postings').insert({ tenant_id: TENANT, name: ' ' })),
        ];
        // Con motivo, sí.
        await trx(C).where({ id: bot.id }).update({ no_rehire: true, no_rehire_reason: 'abandono', no_rehire_by_name: 'rh', no_rehire_at: trx.fn.now() });
        r['listaNegra'] = (await trx(C).where({ no_rehire: true, phone_key: '3511234567' }).count('* as n'))[0]['n'];

        // ── Bitácora de etapas y eventos: la app agrega y lee, no edita ni borra ───────────
        await trx('talent.candidate_stage_transitions').insert({ tenant_id: TENANT, candidate_id: MT_ID, stage_from: 'filtro_inicial', stage_to: 'aptitudes', hours_in_from: 5.5 });
        await trx('talent.candidate_events').insert({ tenant_id: TENANT, candidate_id: MT_ID, event_type: 'contacto', channel: 'llamada', actor_name: 'rh' });
        r['app'] = [
          await fallo(trx, () => trx('talent.candidate_stage_transitions').where({ candidate_id: MT_ID }).update({ stage_to: 'contratado' }), true),
          await fallo(trx, () => trx('talent.candidate_stage_transitions').where({ candidate_id: MT_ID }).del(), true),
          await fallo(trx, () => trx('talent.candidate_events').where({ candidate_id: MT_ID }).update({ note: 'x' }), true),
          await fallo(trx, () => trx(C).where({ id: MT_ID }).del(), true),                 // la papelera es deleted_at
          await fallo(trx, () => trx('talent.candidate_events').insert({ tenant_id: TENANT, candidate_id: MT_ID, event_type: 'nota' }), true),
          await fallo(trx, () => trx(C).where({ id: MT_ID }).update({ deleted_at: trx.fn.now() }), true),
        ];

        // ── Aislamiento: la app de otro tenant no ve ni escribe nada de éste ───────────────
        const otro = async (fn: () => Promise<unknown>) => {
          const sp = `sp${++n}`;
          await trx.raw(`SAVEPOINT ${sp}`);
          try {
            await trx.raw('SET LOCAL ROLE app_runtime');
            await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
            return await fn();
          } catch (e) {
            return String((e as { code?: string }).code ?? 'error');
          } finally {
            await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
          }
        };
        r['otroVe'] = await otro(async () => Number((await trx(C).count('* as n'))[0]['n']));
        r['otroEscribe'] = await otro(() => trx(C).insert({ tenant_id: TENANT, full_name: 'intruso' }));

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    expect(r['phone']).toEqual(['3511234567', '3511234567', null]);
    expect(r['mismoId']).toBe('AbCdEfGhIjKlMnOpQrSt');
    expect(r['malos']).toEqual(['23514', '23514', '23514', '23514', '23514', '23514', '23514']);
    expect(Number(r['listaNegra'])).toBe(1);
    // UPDATE/DELETE en bitácoras y DELETE de candidatos: sin permiso (42501). Agregar y mandar a papelera: sí.
    expect(r['app']).toEqual(['42501', '42501', '42501', '42501', 'sin error', 'sin error']);
    expect(r['otroVe']).toBe(0);
    expect(r['otroEscribe']).toBe('42501');
  }, 60_000);
});
