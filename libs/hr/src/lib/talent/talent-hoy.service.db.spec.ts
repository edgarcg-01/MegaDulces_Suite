/**
 * `[RH.17.1]` «Hoy» contra Postgres: la consulta de verdad (RLS, SQL_ES_POSTULACION, los EXISTS de contacto y de liga, el
 * conteo de «No contestó») reparte bien a candidatos sembrados, y spam / papelera / contratados no entran.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/hr/vitest.config.ts talent-hoy
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import knexLib, { Knex } from 'knex';
import type { HrHoyDto } from '@megadulces/contracts';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.17.1] NO MEDIDO: sin HR_DB_TEST_URL no se prueba «Hoy» contra la base.');

suite('[RH.17.1] Hoy, contra la base', () => {
  it('reparte los sembrados en su pendiente y deja fuera lo que no es del día', async () => {
    const { HrTalentHoyService } = await import('./talent-hoy.service');
    const { MIGRACIONES_TALENT } = require(path.join(RAIZ, 'database/scripts/rh/carga-reclutamiento-mega-talento.js'));
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
        for (const m of MIGRACIONES_TALENT) if (!aplicadas.has(m)) await require(path.join(RAIZ, 'database/migrations-newdb', `${m}.js`)).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrTalentHoyService(tk as never, { requireTenantId: () => TENANT, get: () => null } as never);
        const antes = await svc.hoy();

        const hace = (h: number) => trx.raw(`now() - make_interval(hours => ?)`, [h]);
        const todos = ['cv', 'ine', 'curp', 'rfc', 'nss', 'comprobante', 'acta', 'banco', 'avisoPrivacidad'].map((slot) => ({ slot, storage_key: 'k/' + slot }));
        const cand = async (o: Record<string, unknown>): Promise<string> => {
          const id = randomUUID();
          await trx('talent.candidates').insert({ id, tenant_id: TENANT, full_name: `Prueba hoy ${id.slice(0, 6)}`, cv_url: 'https://x/cv.pdf', ...o });
          return id;
        };
        const evento = (candidate_id: string, o: Record<string, unknown>) =>
          trx('talent.candidate_events').insert({ tenant_id: TENANT, candidate_id, event_type: 'nota', ...o });

        const nuevo = await cand({ stage: 'filtro_inicial', created_at: hace(3), last_activity_at: hace(3) });
        const nuevoConBot = await cand({ stage: 'filtro_inicial', created_at: hace(2), last_activity_at: hace(2) });
        await evento(nuevoConBot, { channel: 'whatsapp', note: 'nota del bot', actor_name: 'bot' });                 // el bot NO cuenta como contacto
        const yaLlamado = await cand({ stage: 'filtro_inicial', created_at: hace(30), last_activity_at: hace(30) });
        await evento(yaLlamado, { event_type: 'contacto', channel: 'llamada', note: 'No contestó', actor_id: randomUUID(), actor_name: 'RH', occurred_at: hace(29) });
        await evento(yaLlamado, { event_type: 'contacto', channel: 'llamada', note: 'No contestó', actor_id: randomUUID(), actor_name: 'RH', occurred_at: hace(28) });
        const expediente = await cand({ stage: 'entrevista_rh', created_at: hace(100), last_activity_at: hace(5), documents: JSON.stringify(todos) });
        const jefe = await cand({ stage: 'aptitudes', created_at: hace(100), last_activity_at: hace(5) });
        const jefeConLiga = await cand({ stage: 'aptitudes', created_at: hace(100), last_activity_at: hace(5) });
        await evento(jefeConLiga, { channel: 'portal', actor_id: randomUUID(), actor_name: 'RH', note: 'Se generó la liga de la evaluación de aptitudes (para el jefe que entrevista) (vence en 7 días).' });
        const apartado = await cand({ stage: 'aptitudes', created_at: hace(2000), last_activity_at: hace(31 * 24) });
        // ⛔ ninguno de estos entra:
        const spam = await cand({ stage: 'filtro_inicial', created_at: hace(1), is_spam: true, spam_reason: 'prueba', spam_at: trx.fn.now() });
        const papelera = await cand({ stage: 'filtro_inicial', created_at: hace(1), deleted_at: trx.fn.now(), deletion_reason: 'manual' });
        const contratado = await cand({ stage: 'contratado', created_at: hace(1) });
        const sinCv = await cand({ stage: null, cv_url: null, created_at: hace(1) });                                   // legado sin CV: no es postulación

        const despues = await svc.hoy();
        const ids = (x: HrHoyDto, p: string) => x.pendientes.find((y) => y.id === p)!.candidatos.map((c) => c.id);
        const total = (x: HrHoyDto, p: string) => x.pendientes.find((y) => y.id === p)!.total;
        r['delta'] = ['nuevos', 'seguimiento', 'expediente', 'jefe'].map((p) => total(despues, p) - total(antes, p));
        r['apartados'] = despues.apartados - antes.apartados;
        r['nuevos'] = [nuevo, nuevoConBot].every((id) => ids(despues, 'nuevos').includes(id));
        r['seguimiento'] = ids(despues, 'seguimiento').includes(yaLlamado);
        r['intentos'] = despues.pendientes.flatMap((p) => p.candidatos).find((c) => c.id === yaLlamado)?.intentos_sin_respuesta;
        r['expediente'] = ids(despues, 'expediente').includes(expediente);
        r['jefe'] = [ids(despues, 'jefe').includes(jefe), ids(despues, 'jefe').includes(jefeConLiga)];
        r['fuera'] = [spam, papelera, contratado, sinCv, apartado].some((id) => despues.pendientes.some((p) => p.candidatos.some((c) => c.id === id)));
        r['ultimos'] = despues.pendientes.flatMap((p) => p.candidatos).find((c) => c.id === yaLlamado)?.ultimos.length;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['delta']).toEqual([2, 1, 1, 1]);
    expect(r['apartados']).toBe(1);
    expect(r['nuevos']).toBe(true);
    expect(r['seguimiento']).toBe(true);
    expect(r['intentos']).toBe(2);
    expect(r['expediente']).toBe(true);
    expect(r['jefe']).toEqual([true, false]);
    expect(r['fuera']).toBe(false);
    expect(r['ultimos']).toBe(2);
  }, 60_000);
});
