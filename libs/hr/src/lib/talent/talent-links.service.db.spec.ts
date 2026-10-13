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
        const otroForm = jwt.sign({ t: 'talent_link', cid: id, f: 'liderazgo', tid: TENANT });
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
  }, 60_000);
});
