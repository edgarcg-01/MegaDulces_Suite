/**
 * `[RH.8.1]` El Resumen y el filtro por ciudad de la lista, contra Postgres: la celda del Resumen y la lista a la que
 * lleva cuentan LO MISMO (Morelia y «sin ciudad», que incluye la vacía y la no reconocida), y spam/papelera no entran.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts talent-resumen
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.8.1] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el Resumen contra la base.');

suite('[RH.8.1] Resumen y filtro por ciudad, contra la base', () => {
  it('la celda y la lista cuentan lo mismo', async () => {
    const { HrTalentCandidatesService } = await import('./talent-candidates.service');
    const { MIGRACIONES_TALENT } = require(path.join(RAIZ, 'database/scripts/rh/carga-reclutamiento-mega-talento.js'));
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
        for (const m of MIGRACIONES_TALENT) if (!aplicadas.has(m)) await require(path.join(RAIZ, 'database/migrations-newdb', `${m}.js`)).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const tk = { run: async (_t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrTalentCandidatesService(tk as never, { requireTenantId: () => TENANT, get: () => null } as never, {} as never);
        const antes = await svc.resumen();
        const cand = (o: Record<string, unknown>) => trx('talent.candidates').insert({ id: randomUUID(), tenant_id: TENANT, full_name: 'Prueba', ...o });
        const sello = `rh81-${Date.now()}`;   // textos únicos: no chocan con lo que la base ya traiga
        await cand({ city_branch: `Morelia, Michoacán ${sello}`, stage: 'aptitudes' });
        await cand({ city_branch: `En morelia ${sello}`, stage: null });
        await cand({ city_branch: `La Piedad o Santa Ana ${sello}`, stage: 'entrevista_rh' });   // dos ciudades: no se adivina
        await cand({ city_branch: null, stage: null });
        await cand({ city_branch: `Morelia ${sello}`, is_spam: true, spam_reason: 'prueba', spam_at: trx.fn.now() });      // ⛔ no entra
        await cand({ city_branch: `Morelia ${sello}`, deleted_at: trx.fn.now(), deletion_reason: 'manual' });               // ⛔ no entra
        const despues = await svc.resumen();
        const total = (x: typeof antes, c: string) => x.ciudades.find((y) => y.ciudad === c)?.total ?? 0;
        r['suma'] = [total(despues, 'Morelia') - total(antes, 'Morelia'), total(despues, 'sin_ciudad') - total(antes, 'sin_ciudad'),
          despues.total - antes.total, despues.sin_ciudad.vacia - antes.sin_ciudad.vacia, despues.sin_ciudad.no_reconocida - antes.sin_ciudad.no_reconocida];
        // La lista a la que lleva cada celda cuenta lo mismo que la celda.
        r['listaMorelia'] = [(await svc.listar({ view: 'en_proceso', city: 'Morelia' })).total, total(despues, 'Morelia')];
        r['listaSin'] = [(await svc.listar({ view: 'en_proceso', city: 'sin_ciudad' })).total, total(despues, 'sin_ciudad')];
        r['listaMoreliaApt'] = [(await svc.listar({ view: 'en_proceso', city: 'Morelia', stage: 'aptitudes' })).total,
          despues.ciudades.find((y) => y.ciudad === 'Morelia')?.por_etapa.aptitudes];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['suma']).toEqual([2, 2, 4, 1, 1]);
    const [lm, cm] = r['listaMorelia'] as number[];
    expect(lm).toBe(cm);
    const [ls, cs] = r['listaSin'] as number[];
    expect(ls).toBe(cs);
    const [la, ca] = r['listaMoreliaApt'] as number[];
    expect(la).toBe(ca);
  }, 60_000);
});
