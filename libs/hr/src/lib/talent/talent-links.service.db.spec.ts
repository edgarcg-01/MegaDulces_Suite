/**
 * `[RH.2.4]` Las ligas personales contra Postgres: se generan atadas a un candidato, abren UNA cosa, vencen, y no sirven
 * alteradas, firmadas con el secreto de las sesiones, ni con el candidato en la papelera.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';
import { JwtService } from '@nestjs/jwt';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const MIGS = ['20261012155411_talent_reclutamiento_datos', '20261012172246_talent_fusion_y_motivo_papelera']
  .map((n) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.4] NO MEDIDO: sin HR_DB_TEST_URL no se prueban las ligas personales contra la base.');

suite('[RH.2.4] ligas personales contra la base', () => {
  it('se generan, abren lo mínimo, reciben el CV y no sirven alteradas, con otro secreto, vencidas ni en la papelera', async () => {
    const { HrTalentLinksService, validarCvDeLiga } = await import('./talent-links.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    const SECRETO = 'secreto-de-prueba';
    const jwt = new JwtService({ secret: `${SECRETO}:talent-link`, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } });
    const sesion = new JwtService({ secret: SECRETO, signOptions: { algorithm: 'HS256' } });
    const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
      try { await fn(); return 'sin error'; } catch (e) {
        const x = e as { getStatus?: () => number; code?: string };
        return String(x.getStatus?.() ?? x.code ?? 'error');
      }
    };
    const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.7\n' + ' '.repeat(40)).toString('base64')}`;
    const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0x20)]).toString('base64')}`;

    // Las reglas del CV por liga (las de Mega Talento): un PDF, o dos fotos.
    r['reglasCv'] = [
      await fallo(async () => validarCvDeLiga({ files: [] })),
      await fallo(async () => validarCvDeLiga({ files: [{ file_base64: PNG }] })),
      await fallo(async () => validarCvDeLiga({ files: [{ file_base64: PDF }, { file_base64: PNG }] })),
      await fallo(async () => validarCvDeLiga({ files: [{ file_base64: PNG }, { file_base64: PNG }, { file_base64: PNG }] })),
      validarCvDeLiga({ files: [{ file_base64: PDF }] }).length,
      validarCvDeLiga({ files: [{ file_base64: PNG }, { file_base64: PNG }] }).length,
    ];

    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const bucket = new Map<string, Buffer>();
        let seq = 0;
        const storage = {
          putBuffer: async (buf: Buffer, _ct: string, carpeta: string, nombre: string) => { const key = `${carpeta}/${++seq}-${nombre}`; bucket.set(key, buf); return { key }; },
          remove: async (key: string) => { bucket.delete(key); },
        };
        const ctx = { get: () => ({ tenantId: TENANT, userId: null, username: 'rh_prueba' }), requireTenantId: () => TENANT };
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const svc = new HrTalentLinksService(tk as never, ctx as never, storage as never, jwt);
        process.env['APP_PUBLIC_URL'] = 'https://suite.prueba';

        const [c] = await trx('talent.candidates').insert({ tenant_id: TENANT, full_name: 'Ana Prueba López', phone: '5213511234567', position_interest: 'Cajera',
          rfc: 'XAXX010101000', nss: '12345678901' }).returning('id');
        const id = c.id ?? c;

        // ── RH genera la liga ───────────────────────────────────────────────────────────────
        const liga = await svc.crear(id, 'cv');
        const token = liga.url.split('/empleo/liga/')[1];
        r['liga'] = [liga.url.startsWith('https://suite.prueba/empleo/liga/'), liga.whatsapp_url?.startsWith('https://wa.me/523511234567?text='),
          /vence en 7 días/.test(liga.mensaje), Math.round((new Date(liga.expires_at).getTime() - Date.now()) / 86_400_000)];
        r['ligaMala'] = [await fallo(() => svc.crear(id, 'otra-cosa')), await fallo(() => svc.crear('no-es-uuid', 'cv'))];
        const notas = await trx('talent.candidate_events').where({ candidate_id: id }).pluck('note');
        r['notaRh'] = notas.some((t: string) => /Se generó la liga para subir su CV/.test(t));

        // ── Lo que ve la página: lo mínimo, nada del expediente ───────────────────────────
        const ctxPublico = await svc.contexto(token) as unknown as Record<string, unknown>;
        r['contexto'] = [ctxPublico['form'], ctxPublico['nombre'], ctxPublico['puesto'], ctxPublico['ya_tiene_cv'],
          JSON.stringify(ctxPublico).includes('XAXX') || JSON.stringify(ctxPublico).includes('351')];

        // ── ⛔ Lo que NO debe abrir ─────────────────────────────────────────────────────────
        const alterado = token.slice(0, -3) + (token.endsWith('aaa') ? 'bbb' : 'aaa');
        const conSecretoDeSesion = sesion.sign({ t: 'talent_link', cid: id, f: 'cv', tid: TENANT });
        const sinTipo = jwt.sign({ cid: id, f: 'cv', tid: TENANT });
        const vencido = jwt.sign({ t: 'talent_link', cid: id, f: 'cv', tid: TENANT, exp: Math.floor(Date.now() / 1000) - 60 });
        const otroForm = jwt.sign({ t: 'talent_link', cid: id, f: 'inventado', tid: TENANT }); // un formulario que no existe
        r['noAbre'] = [
          await fallo(() => svc.contexto(alterado)), await fallo(() => svc.contexto(conSecretoDeSesion)),
          await fallo(() => svc.contexto(sinTipo)), await fallo(() => svc.contexto(vencido)),
          await fallo(() => svc.contexto(otroForm)), await fallo(() => svc.contexto('basura')),
        ];

        // ── El CV: una foto sola no; las dos sí; queda en su expediente ─────────────────────
        r['unaFoto'] = [await fallo(() => svc.subirCv(token, { files: [{ file_base64: PNG }] })), bucket.size];
        const subida = await svc.subirCv(token, { files: [{ file_base64: PNG, file_name: 'frente.png' }, { file_base64: PNG, file_name: 'reverso.png' }] });
        const tras = await trx('talent.candidates').where({ id }).first('documents');
        r['subida'] = [subida.resultado, (tras.documents as Array<{ slot: string; filename: string }>).map((d) => [d.slot, d.filename.split(' — ')[0]]),
          bucket.size, (await svc.contexto(token)).ya_tiene_cv];

        // ── Candidato en la papelera: la liga deja de servir aunque no haya vencido ────────
        await trx('talent.candidates').where({ id }).update({ deleted_at: trx.fn.now(), deletion_reason: 'manual' });
        r['papelera'] = [await fallo(() => svc.contexto(token)), await fallo(() => svc.subirCv(token, { files: [{ file_base64: PDF }] })), bucket.size];
        r['crearEnPapelera'] = await fallo(() => svc.crear(id, 'cv'));

        // ── Cuestionario de liderazgo ───────────────────────────────────────────────────────
        const nuevo = async (o: Record<string, unknown>) => {
          const [x] = await trx('talent.candidates').insert({ tenant_id: TENANT, full_name: 'Beto Prueba', phone: '3510000000', stage: 'entrevista_rh', ...o }).returning('id');
          return x.id ?? x;
        };
        const ligaDe = async (cid: string) => (await svc.crear(cid, 'liderazgo')).url.split('/empleo/liga/')[1];
        const contestar = async (tok: string, valor: (n: number) => number) => {
          let ultimo: unknown = null;
          for (let n = 1; n <= 12; n++) ultimo = await svc.responderLiderazgo(tok, { num: n, valor: valor(n) });
          return ultimo as { terminado: boolean; contestadas: number };
        };

        // Califica (todo 4 = 80%), tiene CV, va en Entrevista Orientación → pasa SOLO a Aptitudes.
        const bueno = await nuevo({ cv_url: 'https://c/cv.pdf', bot_state: 'completado' });
        const tb = await ligaDe(bueno);
        r['lidMensaje'] = /cuestionario de liderazgo/.test((await svc.crear(bueno, 'liderazgo')).mensaje);
        r['lidMalos'] = [
          await fallo(() => svc.responderLiderazgo(tb, { num: 13, valor: 3 })),
          await fallo(() => svc.responderLiderazgo(tb, { num: 1, valor: 6 })),
          await fallo(() => svc.responderLiderazgo(token, { num: 1, valor: 3 })), // liga de CV (y en papelera)
        ];
        await svc.responderLiderazgo(tb, { num: 1, valor: 2 });
        const ctxLid = await svc.contexto(tb);
        r['lidRetoma'] = [ctxLid.respuestas?.[1], ctxLid.terminado, 'porcentaje' in (ctxLid as object)];
        const fin = await contestar(tb, () => 4);
        const trasLid = await trx('talent.candidates').where({ id: bueno }).first('stage', 'portal_data');
        const paso = await trx('talent.candidate_stage_transitions').where({ candidate_id: bueno }).first('stage_from', 'stage_to', 'changed_by_name');
        const notaB = (await trx('talent.candidate_events').where({ candidate_id: bueno }).pluck('note')).find((t: string) => /Contestó el cuestionario/.test(t));
        r['lidBueno'] = [fin.terminado, trasLid.stage, paso?.stage_from, paso?.stage_to, paso?.changed_by_name,
          Object.keys((trasLid.portal_data as Record<string, Record<string, number>>)['cuestionarioLiderazgo']).length, /80%.*pasó solo a Aptitudes/.test(notaB ?? '')];
        // Cerrado: ya no se cambian respuestas.
        r['lidCerrado'] = [await fallo(() => svc.responderLiderazgo(tb, { num: 1, valor: 1 })), (await svc.contexto(tb)).terminado];

        // No califica (todo 2 = 40%): se queda.
        const flojo = await nuevo({ cv_url: 'https://c/cv.pdf', bot_state: 'completado' });
        await contestar(await ligaDe(flojo), () => 2);
        const notaF = (await trx('talent.candidate_events').where({ candidate_id: flojo }).pluck('note')).find((t: string) => /Contestó el cuestionario/.test(t));
        r['lidFlojo'] = [(await trx('talent.candidates').where({ id: flojo }).first('stage')).stage, /No llegó al 66%/.test(notaF ?? '')];

        // ⛔ Califica pero SIN CV: no avanza solo (el caso que costó en Mega Talento), y RH ve por qué.
        const sinCv = await nuevo({ bot_state: 'completado' });
        await contestar(await ligaDe(sinCv), () => 5);
        const notaS = (await trx('talent.candidate_events').where({ candidate_id: sinCv }).pluck('note')).find((t: string) => /Contestó el cuestionario/.test(t));
        r['lidSinCv'] = [(await trx('talent.candidates').where({ id: sinCv }).first('stage')).stage, /no avanza solo: No tiene CV/.test(notaS ?? '')];

        // Ya va más adelante (psicometría): no se le toca aunque califique.
        const adelante = await nuevo({ cv_url: 'https://c/cv.pdf', stage: 'psicometria' });
        await contestar(await ligaDe(adelante), () => 5);
        r['lidAdelante'] = (await trx('talent.candidates').where({ id: adelante }).first('stage')).stage;

        // ── Evaluación de aptitudes (la abre el jefe) ──────────────────────────────────────
        const [vac] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: 'Vendedor de ruta', competencies_sheet: 'vendedor-a-detalle' }).returning('id');
        const evaluado = await nuevo({ full_name: 'Carla Prueba Ruiz', stage: 'aptitudes', cv_url: 'https://c/cv.pdf', bot_state: 'completado', job_posting_id: vac.id ?? vac });
        const la = await svc.crear(evaluado, 'aptitudes');
        const ta = la.url.split('/empleo/liga/')[1];
        const congelado = await trx('talent.candidates').where({ id: evaluado }).first('portal_data');
        const comps = (congelado.portal_data as { competenciasConfig: Array<{ key: string }>; hojaCompetencias: string });
        r['aptLiga'] = [comps.hojaCompetencias, comps.competenciasConfig.length > 0, la.whatsapp_url?.startsWith('https://wa.me/?text='),
          /Carla Prueba Ruiz/.test(la.mensaje)];
        const ctxA = await svc.contexto(ta);
        r['aptCtx'] = [ctxA.form, ctxA.candidato_nombre, ctxA.competencias?.length === comps.competenciasConfig.length, ctxA.rubrica ?? null];
        const todas = (n: string) => Object.fromEntries(comps.competenciasConfig.map((c) => [c.key, n]));
        r['aptMalos'] = [
          await fallo(() => svc.evaluarAptitudes(ta, { rubrica: todas('supera') as never, evaluador: ' ' })),
          await fallo(() => svc.evaluarAptitudes(ta, { rubrica: { [comps.competenciasConfig[0].key]: 'supera' }, evaluador: 'Jefe Prueba' })),
          await fallo(() => svc.evaluarAptitudes(tb, { rubrica: todas('supera') as never, evaluador: 'Jefe Prueba' })), // liga de liderazgo
        ];
        // Todo «supera»: 100%, aprobado → pasa SOLO a Psicométricas.
        await svc.evaluarAptitudes(ta, { rubrica: todas('supera') as never, evaluador: 'Jefe Prueba', cargo_evaluador: 'Gerente', tiempo: '40 min' });
        const ev1 = await trx('talent.candidates').where({ id: evaluado }).first('stage', 'aptitude_eval');
        r['aptAprobado'] = [ev1.stage, (ev1.aptitude_eval as { pct: number }).pct, (ev1.aptitude_eval as { banda: string }).banda, (ev1.aptitude_eval as { evaluador: string }).evaluador];
        // El jefe corrige a la baja: se guarda, pero NO lo regresa de etapa.
        await svc.evaluarAptitudes(ta, { rubrica: todas('inferior') as never, evaluador: 'Jefe Prueba' });
        const ev2 = await trx('talent.candidates').where({ id: evaluado }).first('stage', 'aptitude_eval');
        r['aptCorrige'] = [ev2.stage, (ev2.aptitude_eval as { banda: string }).banda, (await svc.contexto(ta)).rubrica?.[comps.competenciasConfig[0].key]];
        const notasA = await trx('talent.candidate_events').where({ candidate_id: evaluado, event_type: 'entrevista' }).pluck('note');
        r['aptNotas'] = notasA.length;

        // ⛔ Aprobado pero SIN CV: no avanza solo (el principio de Mega Talento, aplicado también aquí).
        const sinCvA = await nuevo({ full_name: 'Dora Prueba', stage: 'aptitudes', bot_state: 'completado', job_posting_id: vac.id ?? vac });
        const tsa = (await svc.crear(sinCvA, 'aptitudes')).url.split('/empleo/liga/')[1];
        await svc.evaluarAptitudes(tsa, { rubrica: todas('supera') as never, evaluador: 'Jefe Prueba' });
        r['aptSinCv'] = (await trx('talent.candidates').where({ id: sinCvA }).first('stage')).stage;

        // Sin hoja para su puesto: no hay liga.
        const sinHoja = await nuevo({ position_interest: 'Astronauta' });
        r['aptSinHoja'] = await fallo(() => svc.crear(sinHoja, 'aptitudes'));

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); delete process.env['APP_PUBLIC_URL']; }

    expect(r['reglasCv']).toEqual(['400', '400', '400', '400', 1, 2]);
    expect(r['liga']).toEqual([true, true, true, 7]);
    expect(r['ligaMala']).toEqual(['400', '404']);
    expect(r['notaRh']).toBe(true);
    // Sólo el primer nombre y el puesto: ni RFC ni teléfono.
    expect(r['contexto']).toEqual(['cv', 'Ana', 'Cajera', false, false]);
    expect(r['noAbre']).toEqual(Array(6).fill('403'));
    expect(r['unaFoto']).toEqual(['400', 0]);
    expect(r['subida']).toEqual(['recibida', [['cv', 'Frente'], ['cv', 'Reverso']], 2, true]);
    // En la papelera: 403, y lo subido en el intento fallido NO se queda en el bucket.
    expect(r['papelera']).toEqual(['403', '403', 2]);
    expect(r['crearEnPapelera']).toBe('400');
    expect(r['lidMensaje']).toBe(true);
    expect(r['lidMalos']).toEqual(['400', '400', '403']);
    // Retoma donde se quedó, y el candidato nunca ve su puntaje.
    expect(r['lidRetoma']).toEqual([2, false, false]);
    expect(r['lidBueno']).toEqual([true, 'aptitudes', 'entrevista_rh', 'aptitudes', 'sistema (cuestionario de liderazgo)', 12, true]);
    expect(r['lidCerrado']).toEqual(['409', true]);
    expect(r['lidFlojo']).toEqual(['entrevista_rh', true]);
    expect(r['lidSinCv']).toEqual(['entrevista_rh', true]);
    expect(r['lidAdelante']).toBe('psicometria');
    // La hoja de la vacante se congela; el WhatsApp NO va al teléfono del candidato; el mensaje dice a quién evalúa.
    expect(r['aptLiga']).toEqual(['vendedor-a-detalle', true, true, true]);
    expect(r['aptCtx']).toEqual(['aptitudes', 'Carla Prueba Ruiz', true, null]);
    expect(r['aptMalos']).toEqual(['400', '400', '403']);
    expect(r['aptAprobado']).toEqual(['psicometria', 100, 'Altamente Recomendable', 'Jefe Prueba']);
    expect(r['aptCorrige']).toEqual(['psicometria', 'No Recomendable', 'inferior']);
    expect(r['aptNotas']).toBe(2);
    expect(r['aptSinCv']).toBe('aptitudes');
    expect(r['aptSinHoja']).toBe('400');
  }, 60_000);
});
