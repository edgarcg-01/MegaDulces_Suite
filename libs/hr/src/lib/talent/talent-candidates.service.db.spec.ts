/**
 * `[RH.2.2]` La API de reclutamiento contra Postgres: apartados, etapas con su bitácora, eventos,
 * marcas, reingresos, duplicados, fusión (y deshacerla), papelera y vacantes.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const MIG = require(path.resolve(__dirname, '../../../../../database/migrations-newdb', '20261012155411_talent_reclutamiento_datos.js'));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la API de reclutamiento contra la base.');

suite('[RH.2.2] API de reclutamiento contra la base', () => {
  it('el ciclo de un candidato, de la lista a la fusión', async () => {
    const { HrTalentCandidatesService } = await import('./talent-candidates.service');
    const { HrTalentJobsService } = await import('./talent-jobs.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await MIG.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        let n = 0;
        // Corre algo que DEBE fallar; devuelve el status HTTP (o el código de Postgres).
        const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
          const sp = `sp${++n}`;
          await trx.raw(`SAVEPOINT ${sp}`);
          try { await fn(); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return 'sin error'; } catch (e) {
            await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
            const x = e as { getStatus?: () => number; code?: string };
            return String(x.getStatus?.() ?? x.code ?? 'error');
          }
        };
        const ctx = { get: () => ({ tenantId: TENANT, userId: null, username: 'rh_prueba' }), requireTenantId: () => TENANT };
        const tk = { run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) };
        const svc = new HrTalentCandidatesService(tk as never, ctx as never);
        const jobs = new HrTalentJobsService(tk as never, ctx as never);
        const C = 'talent.candidates';
        // Aislar de lo que ya hubiera en la base local.
        await trx(C).update({ deleted_at: trx.fn.now(), deletion_reason: 'manual' }).whereNull('deleted_at');

        const sello = String(Date.now()).slice(-7);
        const tel10 = `351${sello}`;
        r['tel10'] = tel10;
        const ins = async (x: Record<string, unknown>) => (await trx(C).insert({ tenant_id: TENANT, ...x }).returning('id'))[0].id as string;
        const portal = await ins({ full_name: 'Ana Pérez López', phone: tel10, cv_url: 'https://c/cv.pdf', source: 'portal', created_at: '2026-08-02T10:00:00Z' });
        const bot = await ins({ full_name: 'Ana Pérez', phone: `521${tel10}`, bot_state: 'esperando_cv', source: 'whatsapp',
          documents: JSON.stringify([{ slot: 'ine', url: 'https://w/ine.jpg' }]), created_at: '2026-08-01T10:00:00Z' });
        const saludo = await ins({ full_name: 'Solo saludó', phone: '4431112233' });
        await ins({ full_name: 'Spam', is_spam: true, spam_reason: 'sin ciudad ni puesto', spam_at: new Date().toISOString() });
        await ins({ full_name: 'Viejo', cv_url: 'https://c/v.pdf', stage: 'dictamen' });

        // ── Apartados: una postulación empieza con el CV (o cuando RH ya lo movió) ─────────
        const post = await svc.listar({});
        r['postulados'] = [post.total, post.filas.map((f) => f.full_name).sort(), post.por_etapa];
        const enProc = await svc.listar({ view: 'en_proceso' });
        r['enProceso'] = enProc.total;
        r['spam'] = (await svc.listar({ view: 'spam' })).total;
        r['porTelefono'] = (await svc.listar({ view: 'en_proceso', q: tel10.slice(-6) })).total;
        r['viejoEnPsico'] = (await svc.listar({ stage: 'psicometria' })).filas.map((f) => [f.full_name, f.stage, f.stage_raw]);
        r['vistaMala'] = await fallo(() => svc.listar({ view: 'todos' }));

        // ── Etapas: cada paso deja su renglón; la primera sale de filtro_inicial ───────────
        await svc.moverEtapa(portal, 'entrevista_rh');
        const f2 = await svc.moverEtapa(portal, 'aptitudes');
        r['pasos'] = f2.transiciones.map((t) => [t.stage_from, t.stage_to, t.hours_in_from !== null && t.hours_in_from >= 0, t.changed_by_name]);
        r['etapaMala'] = [await fallo(() => svc.moverEtapa(portal, 'dictamen')), await fallo(() => svc.moverEtapa(portal, 'aptitudes'))];
        r['tiempos'] = (await svc.tiempoPorEtapa()).fases.map((x) => x.etapa).sort();

        // ── Eventos ────────────────────────────────────────────────────────────────────────
        r['eventoMalo'] = [
          await fallo(() => svc.registrarEvento(portal, { event_type: 'nota', note: '  ' })),
          await fallo(() => svc.registrarEvento(portal, { event_type: 'llamada' as never })),
          await fallo(() => svc.registrarEvento(portal, { event_type: 'contacto', occurred_at: 'ayer' })),
        ];
        const ev = await svc.registrarEvento(portal, { event_type: 'entrevista', channel: 'presencial', occurred_at: '2026-10-10T09:30' });
        r['eventoHora'] = ev.occurred_at;
        await svc.registrarEvento(bot, { event_type: 'contacto', channel: 'whatsapp', note: 'le escribió el bot' });

        // ── Lista negra: motivo obligatorio; el reingreso se detecta por teléfono ──────────
        r['sinMotivo'] = await fallo(() => svc.marcarNoRecontratable(portal, { reason: ' ' }));
        await svc.marcarNoRecontratable(portal, { reason: 'abandonó el puesto en Yurécuaro' });
        r['reingresos'] = (await svc.reingresos()).map((a) => [a.id === bot, a.marcado_id === portal, a.motivo]);
        r['duplicados'] = (await svc.duplicados()).map((g) => [g.phone_key, g.candidatos.length]);
        // La fusión no pone ni quita la marca sola.
        r['fusionConMarca'] = await fallo(() => svc.fusionar(portal, bot));
        await svc.marcarNoRecontratable(portal, { mark: false });

        // ── Fusión: rellena huecos, el absorbido a la papelera, la historia se junta ───────
        r['fusionMala'] = [await fallo(() => svc.fusionar(portal, portal)), await fallo(() => svc.fusionar(portal, '00000000-0000-0000-0000-000000000000'))];
        const fu = await svc.fusionar(portal, bot);
        r['rellenados'] = fu.rellenados.sort();
        const ficha = await svc.ficha(portal);
        r['ficha'] = [
          ficha.full_name, ficha.cv_url, ficha.bot_state, new Date(ficha.created_at).toISOString().slice(0, 10),
          ficha.documents.length, ficha.absorbidos.map((a) => a.id === bot),
          ficha.eventos.filter((e) => e.event_type === 'contacto').length,
          ficha.eventos.some((e) => /fusionó/.test(e.note ?? '')),
        ];
        const abs = await trx(C).where({ id: bot }).first('deleted_at', 'deletion_reason', 'merged_into_id');
        r['absorbido'] = [!!abs.deleted_at, abs.deletion_reason, abs.merged_into_id === portal];
        r['papeleraTrasFusion'] = (await svc.listar({ view: 'papelera' })).filas.some((f) => f.id === bot);
        r['fusionDeNuevo'] = await fallo(() => svc.fusionar(portal, bot));

        // Deshacer: restaurar al absorbido lo vuelve su propio registro.
        await svc.restaurar(bot);
        const otra = await svc.ficha(portal);
        r['deshecha'] = [otra.absorbidos.length, (await trx(C).where({ id: bot }).first('merged_into_id')).merged_into_id];

        // ── Papelera ───────────────────────────────────────────────────────────────────────
        await svc.aPapelera(saludo, { reason: 'cierre_seguimiento' });
        r['papelera'] = [
          await fallo(() => svc.aPapelera(saludo, {})),
          await fallo(() => svc.moverEtapa(saludo, 'aptitudes')),
          await fallo(() => svc.aPapelera(saludo, { reason: 'porque sí' } as never)),
        ];
        await svc.restaurar(saludo);
        r['restaurarVivo'] = await fallo(() => svc.restaurar(saludo));

        // ── Edición ────────────────────────────────────────────────────────────────────────
        r['edicion'] = (await svc.editar(saludo, { city_branch: ' Zamora ', email: '' })).city_branch;
        r['edicionVacia'] = await fallo(() => svc.editar(saludo, {}));
        r['noExiste'] = await fallo(() => svc.ficha('no-es-uuid'));

        // ── Vacantes ───────────────────────────────────────────────────────────────────────
        r['vacanteMala'] = [await fallo(() => jobs.crear({ name: ' ' })), await fallo(() => jobs.crear({ name: 'X', branch_codes: 'no' as never }))];
        const v = await jobs.crear({ name: `Cajera ${sello}`, branch_codes: ['8-esquinas', '8-esquinas', ' '], salary_text: '$2,300 semanales' });
        await jobs.editar(v.id, { is_active: false });
        r['vacantes'] = [v.branch_codes, (await jobs.listar({ active: 'false' })).some((x) => x.id === v.id), (await jobs.listar({ active: 'true' })).some((x) => x.id === v.id)];

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    // Postulados: Ana (CV) y Viejo (CV); NO el bot sin CV, ni quien sólo saludó, ni el spam.
    expect(r['postulados']).toEqual([2, ['Ana Pérez López', 'Viejo'], { filtro_inicial: 1, psicometria: 1 }]);
    expect(r['enProceso']).toBe(4);
    expect(r['spam']).toBe(1);
    expect(r['porTelefono']).toBe(2); // el del bot (13 dígitos) y el del portal (10)
    expect(r['viejoEnPsico']).toEqual([['Viejo', 'psicometria', 'dictamen']]);
    expect(r['vistaMala']).toBe('400');
    expect(r['pasos']).toEqual([['filtro_inicial', 'entrevista_rh', true, 'rh_prueba'], ['entrevista_rh', 'aptitudes', true, 'rh_prueba']]);
    expect(r['etapaMala']).toEqual(['400', '409']);
    expect(r['tiempos']).toEqual(expect.arrayContaining(['entrevista_rh', 'filtro_inicial']));
    expect(r['eventoMalo']).toEqual(['400', '400', '400']);
    expect(r['eventoHora']).toBe('2026-10-10T15:30:00.000Z'); // 09:30 en México = 15:30 UTC
    expect(r['sinMotivo']).toBe('400');
    expect(r['reingresos']).toEqual([[true, true, 'abandonó el puesto en Yurécuaro']]);
    expect(r['duplicados']).toEqual([[r['tel10'], 2]]);
    expect(r['fusionConMarca']).toBe('409');
    expect(r['fusionMala']).toEqual(['400', '404']);
    expect(r['rellenados']).toEqual(['bot_state']);
    // Nombre y CV del portal intactos; el estado del bot recuperado; la alta más vieja; documentos unidos;
    // la historia del absorbido aparece en la ficha del que queda.
    expect(r['ficha']).toEqual(['Ana Pérez López', 'https://c/cv.pdf', 'esperando_cv', '2026-08-01', 1, [true], 1, true]);
    expect(r['absorbido']).toEqual([true, 'fusionado', true]);
    expect(r['papeleraTrasFusion']).toBe(true);
    expect(r['fusionDeNuevo']).toBe('409');
    expect(r['deshecha']).toEqual([0, null]);
    expect(r['papelera']).toEqual(['409', '409', '400']);
    expect(r['restaurarVivo']).toBe('409');
    expect(r['edicion']).toBe('Zamora');
    expect(r['edicionVacia']).toBe('400');
    expect(r['noExiste']).toBe('404');
    expect(r['vacanteMala']).toEqual(['400', '400']);
    expect(r['vacantes']).toEqual([['8-esquinas'], true, false]);
  }, 60_000);
});
