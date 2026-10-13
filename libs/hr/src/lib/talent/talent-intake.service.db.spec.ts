/**
 * `[RH.2.4]` La entrada de candidatos contra Postgres: las reglas de David (un proceso a la vez, 90 días para volver
 * a la misma vacante, la persona por su teléfono), el CV que se completa, la lista negra y lo que se contesta.
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
const MIGS = ['20261012155411_talent_reclutamiento_datos', '20261012172246_talent_fusion_y_motivo_papelera']
  .map((n) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.4] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la bolsa de trabajo contra la base.');

suite('[RH.2.4] bolsa de trabajo contra la base', () => {
  it('reglas de postulación, CV que se completa, lista negra y respuestas que no revelan nada', async () => {
    const { HrTalentIntakeService } = await import('./talent-intake.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) await m.up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        let n = 0;
        const fallo = async (fn: () => Promise<unknown>): Promise<string> => {
          const sp = `sp${++n}`;
          await trx.raw(`SAVEPOINT ${sp}`);
          try { await fn(); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return 'sin error'; } catch (e) {
            await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
            const x = e as { getStatus?: () => number; code?: string };
            return String(x.getStatus?.() ?? x.code ?? 'error');
          }
        };
        const bucket = new Map<string, Buffer>();
        let seq = 0;
        const storage = {
          putBuffer: async (buf: Buffer, _ct: string, carpeta: string, nombre: string) => { const key = `${carpeta}/${++seq}-${nombre}`; bucket.set(key, buf); return { key }; },
          remove: async (key: string) => { bucket.delete(key); },
          signedUrl: async (k: string) => `https://firmada/${k}`,
        };
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const svc = new HrTalentIntakeService(tk as never, storage as never);
        const C = 'talent.candidates';

        const sello = Date.now();
        const [cajera] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: `Cajera ${sello}`, extra: JSON.stringify({ interno: 1 }) }).returning('id');
        const [almacen] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: `Almacenista ${sello}` }).returning('id');
        const [cerrada] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: `Vieja ${sello}`, is_active: false }).returning('id');
        // Sólo en Morelia, y una de Chofer (pide licencia).
        const [morelia] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: `Sólo Morelia ${sello}`, branch_codes: ['morelia-figaredo'] }).returning('id');
        const [chofer] = await trx('talent.job_postings').insert({ tenant_id: TENANT, name: 'Chofer' }).returning('id');
        const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.7\n' + ' '.repeat(40)).toString('base64')}`;
        const tel = `44${String(sello).slice(-8)}`;
        const base = (o: Record<string, unknown> = {}) => ({
          full_name: 'Ana Prueba López', phone: tel, city_branch: 'Zamora', job_posting_id: cajera.id ?? cajera,
          heard_from: 'Facebook / Redes Sociales', cv_base64: PDF, cv_file_name: 'cv.pdf', privacy_accepted: true, ...o,
        });
        const cuantos = async () => Number((await trx(C).where({ phone_key: tel }).count('* as n'))[0]['n']);

        // ── Vacantes públicas: sólo las activas, sin lo interno ───────────────────────────────
        const pub = await svc.vacantesPublicas();
        const v = pub.find((x) => x.id === (cajera.id ?? cajera)) as unknown as Record<string, unknown>;
        r['publicas'] = [!!v, 'extra' in v, 'created_by' in v, pub.some((x) => x.id === (cerrada.id ?? cerrada))];

        // ── Lo que no entra: 400, y NADA llega al bucket ─────────────────────────────────────
        r['malos'] = [
          await fallo(() => svc.postularWeb(base({ phone: '12345' }) as never)),
          await fallo(() => svc.postularWeb(base({ full_name: 'Ana' }) as never)),
          await fallo(() => svc.postularWeb(base({ city_branch: ' ' }) as never)),
          await fallo(() => svc.postularWeb(base({ privacy_accepted: false }) as never)),
          await fallo(() => svc.postularWeb(base({ cv_base64: '' }) as never)),
          await fallo(() => svc.postularWeb(base({ cv_base64: `data:image/png;base64,${Buffer.from('<html>x</html>').toString('base64')}` }) as never)),
          await fallo(() => svc.postularWeb(base({ job_posting_id: cerrada.id ?? cerrada }) as never)),
          await fallo(() => svc.postularWeb(base({ city_branch: 'Guadalajara' }) as never)),            // fuera del catálogo
          await fallo(() => svc.postularWeb(base({ heard_from: '' }) as never)),                          // ¿dónde te enteraste?
          await fallo(() => svc.postularWeb(base({ heard_from: 'TikTok' }) as never)),                    // fuera de la lista
          await fallo(() => svc.postularWeb(base({ job_posting_id: morelia.id ?? morelia }) as never)),   // no está en Zamora
          await fallo(() => svc.postularWeb(base({ job_posting_id: chofer.id ?? chofer }) as never)),     // Chofer sin licencia
        ];
        r['bucketTrasMalos'] = bucket.size;

        // ── El campo trampa: «recibida», y no se guarda nada ────────────────────────────────
        r['robot'] = [(await svc.postularWeb(base({ website: 'http://spam' }) as never)).resultado, await cuantos(), bucket.size];

        // ── Primera postulación ─────────────────────────────────────────────────────────────
        const uno = await svc.postularWeb(base() as never);
        const c = await trx(C).where({ phone_key: tel }).first();
        r['primera'] = [uno.resultado, c.stage, c.source, c.origin, c.position_interest === `Cajera ${sello}`, (c.documents as unknown[]).length, bucket.size];

        // ── ⭐ La misma vacante otra vez (con +52 y espacios): se bota, sin decir para qué vacante ──
        const dos = await svc.postularWeb(base({ phone: `+52 1 ${tel}` }) as never);
        r['duplicado'] = [dos.resultado, dos.mensaje.includes('Cajera'), await cuantos(), bucket.size];
        const notas = await trx('talent.candidate_events').where({ candidate_id: c.id }).pluck('note');
        r['notaIntento'] = notas.some((t: string) => /Intentó postularse otra vez por la web/.test(t));

        // ── Si a su proceso le falta el CV o el correo, el intento lo completa (aunque se rechace) ──
        await trx(C).where({ id: c.id }).update({ documents: JSON.stringify([]) });
        const tres = await svc.postularWeb(base({ email: 'ana@correo.test' }) as never);
        const c3 = await trx(C).where({ id: c.id }).first('email', 'documents');
        r['completa'] = [tres.resultado, c3.email, (c3.documents as Array<{ slot: string }>).map((d) => d.slot), await cuantos()];

        // ── ⭐ Otra vacante mientras sigue en proceso: también se rechaza ─────────────────────
        r['otraVacante'] = [(await svc.postularWeb(base({ job_posting_id: almacen.id ?? almacen }) as never)).resultado, await cuantos()];

        // ── Se cierra su proceso (rechazado hace 30 días) ───────────────────────────────────
        await trx(C).where({ id: c.id }).update({ stage: 'rechazado' });
        await trx('talent.candidate_stage_transitions').insert({ tenant_id: TENANT, candidate_id: c.id, stage_from: 'filtro_inicial', stage_to: 'rechazado',
          changed_at: trx.raw(`now() - interval '30 days'`) });
        const cuatro = await svc.postularWeb(base() as never);
        r['antesDe90'] = [cuatro.resultado, /a partir del/.test(cuatro.mensaje), await cuantos()];
        // A otra vacante, ya cerrado su proceso, sí.
        const cinco = await svc.postularWeb(base({ job_posting_id: almacen.id ?? almacen }) as never);
        r['otraTrasCerrar'] = [cinco.resultado, await cuantos()];

        // ── Pasados los 90 días, la misma vacante sí (con un número nuevo, para no chocar con el de arriba) ──
        const tel2 = `55${String(sello).slice(-8)}`;
        const [viejo] = await trx(C).insert({ tenant_id: TENANT, phone: tel2, stage: 'rechazado', job_posting_id: cajera.id ?? cajera }).returning('id');
        await trx('talent.candidate_stage_transitions').insert({ tenant_id: TENANT, candidate_id: viejo.id ?? viejo, stage_from: 'aptitudes', stage_to: 'rechazado',
          changed_at: trx.raw(`now() - interval '100 days'`) });
        r['tras90'] = (await svc.postularWeb(base({ phone: tel2 }) as never)).resultado;

        // ── ⛔ Lista negra: se recibe, RH lo ve, y a la persona no se le dice ───────────────────
        const tel3 = `33${String(sello).slice(-8)}`;
        await trx(C).insert({ tenant_id: TENANT, phone: tel3, stage: 'rechazado', no_rehire: true, no_rehire_reason: 'abandonó el puesto', no_rehire_at: trx.fn.now(),
          created_at: trx.raw(`now() - interval '400 days'`) });
        const negra = await svc.postularWeb(base({ phone: tel3 }) as never);
        const nuevaNegra = await trx(C).where({ phone_key: tel3 }).whereNot({ no_rehire: true }).first('id');
        const avisoRh = await trx('talent.candidate_events').where({ candidate_id: nuevaNegra.id }).pluck('note');
        r['listaNegra'] = [negra.resultado, /negra|recontrat/i.test(negra.mensaje), avisoRh.some((t: string) => /NO RECONTRATABLE/.test(t))];

        // ── Chofer con licencia: entra con los dos documentos ───────────────────────────────
        const tel4 = `22${String(sello).slice(-8)}`;
        const ch = await svc.postularWeb(base({ phone: tel4, job_posting_id: chofer.id ?? chofer, license_base64: PDF, license_file_name: 'licencia.pdf' }) as never);
        const cch = await trx(C).where({ phone_key: tel4 }).first('documents');
        r['chofer'] = [ch.resultado, (cch.documents as Array<{ slot: string }>).map((d) => d.slot).sort()];

        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; } finally { await knex.destroy(); }

    expect(r['publicas']).toEqual([true, false, false, false]);
    expect(r['malos']).toEqual(Array(12).fill('400'));
    expect(r['bucketTrasMalos']).toBe(0);
    expect(r['robot']).toEqual(['recibida', 0, 0]);
    // `source` = dónde se enteró (el «fuente» de Mega Talento); `origin` = por dónde entró.
    expect(r['primera']).toEqual(['recibida', 'filtro_inicial', 'Facebook / Redes Sociales', 'web', true, 1, 1]);
    // Rechazada, el mensaje NO nombra la vacante, no se creó a nadie y el CV repetido se borró del bucket.
    expect(r['duplicado']).toEqual(['rechazada', false, 1, 1]);
    expect(r['notaIntento']).toBe(true);
    expect(r['completa']).toEqual(['rechazada', 'ana@correo.test', ['cv'], 1]);
    expect(r['otraVacante']).toEqual(['rechazada', 1]);
    expect(r['antesDe90']).toEqual(['rechazada', true, 1]);
    expect(r['otraTrasCerrar']).toEqual(['recibida', 2]);
    expect(r['tras90']).toBe('recibida');
    expect(r['listaNegra']).toEqual(['recibida', false, true]);
    expect(r['chofer']).toEqual(['recibida', ['cv', 'licencia']]);
  }, 60_000);
});
