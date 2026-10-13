/**
 * `[RH.3.2]` El bot de reclutamiento contra Postgres: una persona se registra por WhatsApp de punta a punta, manda su
 * CV y queda como candidata con TODO lo que contestó; la segunda vez se le dice al confirmar (antes de pedirle el CV)
 * que ya está en un proceso. Y la tabla de conversaciones no acepta estados ni cierres incoherentes.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';
import type { RecruitmentInbound } from '@megadulces/contracts';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const MIGS = ['20261012155411_talent_reclutamiento_datos', '20261012172246_talent_fusion_y_motivo_papelera', '20261013150116_talent_bot_conversaciones']
  .map((n) => require(path.resolve(__dirname, '../../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.3.2] NO MEDIDO: sin HR_DB_TEST_URL no se prueba el bot de reclutamiento contra la base.');

suite('[RH.3.2] bot de reclutamiento contra la base', () => {
  it('registro completo → CV → candidata; la segunda vez se rechaza al confirmar; CHECKs de la conversación', async () => {
    const { HrTalentIntakeService } = await import('../talent-intake.service');
    const { HrRecruitmentBotService } = await import('./recruitment-bot.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) { await m.up(trx); }
        await MIGS[2].up(trx); // idempotente
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        let n = 0;
        const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
          const sp = `sp${++n}`;
          await trx.raw(`SAVEPOINT ${sp}`);
          try { await fn(); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return 'sin error'; } catch (e) {
            await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
            return String((e as { code?: string }).code ?? 'error');
          }
        };
        const bucket = new Map<string, Buffer>();
        const storage = {
          putBuffer: async (buf: Buffer, _ct: string, carpeta: string, nombre: string) => { const key = `${carpeta}/${bucket.size + 1}-${nombre}`; bucket.set(key, buf); return { key }; },
          remove: async (key: string) => { bucket.delete(key); },
        };
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const intake = new HrTalentIntakeService(tk as never, storage as never);
        const bot = new HrRecruitmentBotService(tk as never, intake);

        const sello = Date.now();
        const nombreVacante = `Cajero RH32 ${sello}`;
        const [vacante] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: nombreVacante, branch_codes: ['zamora-canindo'] }).returning('id');
        const vacanteId = String(vacante.id ?? vacante);
        const tel10 = `35${String(sello).slice(-8)}`;
        const tel = `521${tel10}`;
        const PDF = Buffer.from('%PDF-1.7\n' + ' '.repeat(40));
        const msg = (o: Partial<RecruitmentInbound>): RecruitmentInbound => ({
          tenantId: TENANT, phone: tel, phoneNumberId: 'rh-num', waMessageId: `w${++n}`, type: 'text', text: null,
          profileName: 'Ana', media: null, descargar: null, ...o,
        });
        const decir = async (texto: string) => (await bot.handleMessage(msg({ text: texto }))).map((x) => x.body).join('\n');

        // ── Registro de punta a punta ───────────────────────────────────────────────────────────
        const respuestas: string[] = [];
        for (const t of ['hola', nombreVacante, 'Ana Prueba López', 'no tengo', 'Canindo', '15 minutos', 'tiempo completo',
          'Oxxo', '2500 semanales', 'LOGA900101AB1', '12345678901', 'ninguno', 'no']) respuestas.push(await decir(t));
        r['resumen'] = respuestas[respuestas.length - 1].includes('Revisa que tus datos sean correctos');
        r['tecleo'] = await decir('qwerty'); // en el resumen: no es número ni «sí» → recuerda opciones
        r['archivoAntes'] = (await bot.handleMessage(msg({ type: 'document', media: { id: 'm0', mimeType: 'application/pdf', filename: 'cv.pdf' },
          descargar: async () => ({ buffer: PDF, mime: 'application/pdf' }) })))[0].body;
        r['pideCV'] = (await decir('sí')).includes('currículum (CV)');
        r['estadoCV'] = (await trx('talent.bot_conversations').where({ phone_key: tel10 }).first('state')).state;
        r['sinCandidatoAun'] = Number((await trx('talent.candidates').where({ phone_key: tel10 }).count('* as n'))[0]['n']);

        // Un archivo que no es PDF ni imagen (por firma) no entra.
        r['noEsCV'] = (await bot.handleMessage(msg({ type: 'document', media: { id: 'm1', mimeType: 'application/pdf', filename: 'x.pdf' },
          descargar: async () => ({ buffer: Buffer.from('no soy un pdf'), mime: 'application/pdf' }) })))[0].body;

        r['cierre'] = (await bot.handleMessage(msg({ type: 'document', media: { id: 'm2', mimeType: 'application/pdf', filename: 'Mi CV.pdf' },
          descargar: async () => ({ buffer: PDF, mime: 'application/pdf' }) })))[0].body;
        const cand = await trx('talent.candidates').where({ phone_key: tel10 }).first();
        r['candidata'] = cand && {
          origin: cand.origin, stage: cand.stage, job: cand.job_posting_id, city: cand.city_branch, email: cand.email,
          rfc: cand.rfc, nss: cand.nss, commute: cand.commute_time, salary: cand.desired_salary, previo: cand.previous_employer,
          cv: (cand.documents as Array<{ slot: string }>).map((d) => d.slot),
        };
        const conv = await trx('talent.bot_conversations').where({ phone_key: tel10 }).first();
        r['conv'] = [conv.state, conv.outcome, conv.candidate_id === cand?.id, conv.profile_name];
        r['enRevision'] = (await decir('hola?')).includes('la está *revisando*');

        // ── Segunda vez: reinicia, se registra igual, y al CONFIRMAR se le dice (sin pedirle el CV) ──────
        await decir('reiniciar');
        for (const t of [nombreVacante, 'Ana Prueba López', 'no tengo', 'Zamora', '15', 'completo', 'Oxxo', '2500',
          'LOGA900101AB1', '12345678901', 'ninguno', 'no']) await decir(t);
        r['segunda'] = await decir('si');
        const conv2 = await trx('talent.bot_conversations').where({ phone_key: tel10 }).first();
        r['conv2'] = [conv2.state, conv2.outcome, conv2.outcome_reason, conv2.candidate_id === cand?.id];
        r['unaSola'] = Number((await trx('talent.candidates').where({ phone_key: tel10 }).count('* as n'))[0]['n']);

        // ── [RH.3.2.2] Orientación: pide un puesto que no hay, rechaza lo ofrecido y termina; la ficha guarda lo que pidió ──
        // (lo que se le ofrezca depende de las vacantes de esta base: se prueba lo que no depende de ellas).
        const tel2 = `521${String(sello + 7).slice(-10)}`;
        const tel2k = tel2.slice(-10);
        const decir2 = async (texto: string) => (await bot.handleMessage(msg({ phone: tel2, text: texto }))).map((x) => x.body).join('\n');
        await decir2('hola');
        await decir2('ayudante general');
        const enOrienta = await trx('talent.bot_conversations').where({ phone_key: tel2k }).first('state', 'orientation', 'data');
        r['orienta'] = [enOrienta.state, enOrienta.orientation?.pedido, enOrienta.data?.position_interest];
        r['rechazo'] = await decir2('ninguno');
        for (const t of ['Luis Prueba Gómez', 'no tengo', 'Zamora', '10 minutos', 'completo', 'Oxxo', '2000', 'LOGA900101AB1',
          '12345678901', 'ninguno', 'no', 'si']) await decir2(t);
        await bot.handleMessage(msg({ phone: tel2, type: 'document', media: { id: 'm3', mimeType: 'application/pdf', filename: 'cv.pdf' },
          descargar: async () => ({ buffer: PDF, mime: 'application/pdf' }) }));
        const cand2 = await trx('talent.candidates').where({ phone_key: tel2k }).first('position_interest', 'portal_data');
        r['ficha2'] = [cand2?.position_interest, cand2?.portal_data?.orientacion?.pedido, cand2?.portal_data?.orientacion?.rechazada];

        // ── CHECKs ─────────────────────────────────────────────────────────────────────────────
        const C = 'talent.bot_conversations';
        const fila = (o: Record<string, unknown>) => ({ tenant_id: TENANT, phone: `52${String(sello + ++n).slice(-10)}`, ...o });
        r['checks'] = [
          await fallo(() => trx(C).insert(fila({ state: 'cualquier_cosa' }))),
          await fallo(() => trx(C).insert(fila({ state: 'postulada', outcome: 'postulada' }))),          // sin candidato
          await fallo(() => trx(C).insert(fila({ state: 'rechazada', outcome: 'rechazada' }))),          // sin motivo
          await fallo(() => trx(C).insert(fila({ state: 'esperando_rfc', outcome: 'postulada' }))),      // cierre sin estado final
          await fallo(() => trx(C).insert(fila({ phone: '123' }))),                                      // teléfono corto
          await fallo(() => trx(C).insert(fila({ data: JSON.stringify([1]) }))),                         // data no es objeto
          await fallo(() => trx(C).insert({ tenant_id: TENANT, phone: tel, state: 'nuevo' })),           // mismo teléfono
          await fallo(() => trx(C).insert(fila({ orientation: JSON.stringify(['x']) }))),                // orientación no es objeto
        ];
        r['buenos'] = [
          await fallo(() => trx(C).insert(fila({ state: 'editando_city_branch' }))),
          await fallo(() => trx(C).insert(fila({ state: 'orientando_puesto', orientation: JSON.stringify({ pedido: 'x' }) }))),
        ];
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    expect(r['resumen']).toBe(true);
    expect(String(r['tecleo'])).toContain('Responde *sí* para confirmar');
    expect(String(r['archivoAntes'])).toContain('primero necesito terminar tu registro');
    expect(r['pideCV']).toBe(true);
    expect(r['estadoCV']).toBe('esperando_cv');
    expect(r['sinCandidatoAun']).toBe(0);
    expect(String(r['noEsCV'])).toContain('No pude usar ese archivo');
    expect(String(r['cierre'])).toContain('postulación queda completa');
    expect(r['candidata']).toEqual({
      origin: 'whatsapp', stage: 'filtro_inicial', job: expect.any(String), city: 'Zamora', email: null,
      rfc: 'LOGA900101AB1', nss: '12345678901', commute: '15 minutos', salary: '2500 semanales', previo: 'Oxxo', cv: ['cv'],
    });
    expect(r['conv']).toEqual(['postulada', 'postulada', true, 'Ana']);
    expect(r['enRevision']).toBe(true);
    expect(String(r['segunda'])).toContain('Ya tienes una postulación para');
    expect(r['conv2']).toEqual(['rechazada', 'rechazada', 'en_proceso_misma_vacante', true]);
    expect(r['unaSola']).toBe(1);
    expect(r['orienta']).toEqual(['orientando_puesto', 'ayudante general', 'ayudante general']);
    expect(String(r['rechazo'])).toContain('Te dejo registrado para *ayudante general*');
    expect(r['ficha2']).toEqual(['ayudante general', 'ayudante general', true]);
    expect(r['checks']).toEqual(['23514', '23514', '23514', '23514', '23514', '23514', '23505', '23514']);
    expect(r['buenos']).toEqual(['sin error', 'sin error']);
  }, 60_000);
});
