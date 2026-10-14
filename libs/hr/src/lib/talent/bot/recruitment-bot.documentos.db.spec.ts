/**
 * `[RH.3.3.4]` Los documentos del expediente por WhatsApp, contra Postgres:
 *
 *   · RH le pide sus documentos a alguien que se postuló por la WEB (no tiene conversación): se le crea, con la lista de
 *     los obligatorios que le faltan (sin el CV, que ya mandó).
 *   · Manda su INE: la visión (falsa) la reconoce y va a su casillero, con lo que falta en el acuse. Lo que no reconoce
 *     entra como «otro». «hola» le recuerda qué falta; «listo» cierra la etapa y lo anota en su bitácora.
 *   · Ya cerrada, «hola» NO retoma el registro (un estado que el registro no conoce lo devolvía a pedir datos).
 *   · Se le pedía el CV y mandó su INE: se APARTA (una por casillero: la segunda reemplaza y borra la primera del bucket)
 *     y viaja a su expediente al mandar el CV.
 *   · En la papelera no se archiva (y el archivo se borra del bucket). El CHECK no deja una etapa de documentos sin candidato.
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
const MIGS = ['20261012155411_talent_reclutamiento_datos', '20261012172246_talent_fusion_y_motivo_papelera',
  '20261013150116_talent_bot_conversaciones', '20261014083512_talent_bot_solicitud', '20261014141356_talent_bot_documentos']
  .map((n) => require(path.resolve(__dirname, '../../../../../../database/migrations-newdb', `${n}.js`)));

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.3.3.4] NO MEDIDO: sin HR_DB_TEST_URL no se prueban los documentos del bot contra la base.');

const PDF = Buffer.from('%PDF-1.7\n' + ' '.repeat(40));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const OBLIGATORIOS_SIN_CV = ['ine', 'curp', 'rfc', 'nss', 'comprobante', 'acta', 'banco', 'avisoPrivacidad'];

suite('[RH.3.3.4] documentos del expediente por WhatsApp contra la base', () => {
  it('pedir → recibir y acomodar → listo; apartar al pedir el CV; papelera; CHECK', async () => {
    const { HrTalentIntakeService } = await import('../talent-intake.service');
    const { HrRecruitmentBotService } = await import('./recruitment-bot.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) { await m.up(trx); }
        await MIGS[4].up(trx); // idempotente
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
          putBuffer: async (buf: Buffer, _ct: string, carpeta: string, nombre: string) => {
            const key = `${carpeta}/${++n}-${nombre}`; bucket.set(key, buf); return { key };
          },
          remove: async (key: string) => { bucket.delete(key); },
          getDataUri: async () => null,
        };
        const tk = { run: async (t: string, cb: (x: Knex.Transaction) => Promise<unknown>) => { await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [t]); return cb(trx); } };
        const intake = new HrTalentIntakeService(tk as never, storage as never);
        // La visión, falsa: dice lo que la prueba le pide en `siguiente`.
        let siguiente: { slot: string | null; motivo: string; clasificado: boolean } = { slot: 'ine', motivo: 'una INE', clasificado: true };
        const clasificador = { clasificar: async () => siguiente };
        // El validador de CV, falso: un PNG «es una identificación»; un PDF es un CV.
        const validador = { validar: async (buf: Buffer) => (buf[0] === 0x89
          ? { valido: false, tipo: 'identificacion', motivo: 'es el frente de una credencial del INE', revisar: false }
          : { valido: true, tipo: 'cv', motivo: '', revisar: false }) };
        const bot = new HrRecruitmentBotService(tk as never, intake, undefined, undefined, validador as never, storage as never, clasificador as never);

        const sello = Date.now();
        const tel10 = `36${String(sello).slice(-8)}`;
        const tel = `521${tel10}`;
        const msg = (o: Partial<RecruitmentInbound>): RecruitmentInbound => ({
          tenantId: TENANT, phone: tel, phoneNumberId: 'rh-num', waMessageId: `w${++n}`, type: 'text', text: null,
          profileName: 'Ana', media: null, descargar: null, ...o,
        });
        const decir = async (texto: string, phone = tel) => (await bot.handleMessage(msg({ phone, text: texto }))).map((x) => x.body).join('\n');
        const mandar = async (buf: Buffer, phone = tel) => (await bot.handleMessage(msg({
          phone, type: buf === PDF ? 'document' : 'image', media: { id: `m${++n}`, mimeType: buf === PDF ? 'application/pdf' : 'image/png', filename: null },
          descargar: async () => ({ buffer: buf, mime: buf === PDF ? 'application/pdf' : 'image/png' }),
        }))).map((x) => x.body).join('\n');

        // ── Se postuló por la WEB (sin conversación) y RH le pide sus documentos ───────────────────────────────
        const d = await intake.postular({
          phone: tel, full_name: 'Ana Prueba López', email: null, city_branch: 'zamora-canindo', job_posting_id: null,
          position_interest: 'Cajero(a)', relative_in_company: null, rehire_note: null, heard_from: 'Facebook',
          cv: { adjunto: { buffer: PDF, contentType: 'application/pdf', sizeBytes: PDF.length } as never, file_name: 'cv.pdf' }, license: null,
        }, 'web', TENANT);
        const candId = String(d.candidato_id);
        const p = await bot.pedirDocumentos(TENANT, candId);
        r['peticion'] = [p.solicitados, p.mensaje?.includes('Hola Ana'), p.mensaje?.includes('escribe *listo*'), p.ultimo_mensaje_en];
        const c0 = await trx('talent.bot_conversations').where({ phone_key: tel10 }).first('state', 'outcome', 'candidate_id', 'documents');
        r['convCreada'] = [c0.state, c0.outcome, c0.candidate_id === candId, c0.documents?.solicitados?.length];

        // ── Manda su INE: va a su casillero y se le dice qué falta ─────────────────────────────────────────────
        r['acuseIne'] = await mandar(PNG);
        siguiente = { slot: null, motivo: 'no se distingue', clasificado: true };
        r['acuseOtro'] = await mandar(PNG);
        const docs1 = (await trx('talent.candidates').where({ id: candId }).first('documents')).documents as Array<Record<string, unknown>>;
        r['expediente'] = docs1.map((x) => [x['slot'], x['origen']]);
        r['recordatorio'] = await decir('hola');
        r['listo'] = await decir('listo');
        const c1 = await trx('talent.bot_conversations').where({ phone_key: tel10 }).first('state', 'outcome');
        r['cerrada'] = [c1.state, c1.outcome];
        // (en una transacción todas las notas tienen la misma hora: se busca por su texto)
        r['nota'] = (await trx('talent.candidate_events').where({ candidate_id: candId }).where('note', 'like', 'Terminó%').first('note'))?.note;
        // Ya cerrada: «hola» NO retoma el registro.
        r['despues'] = await decir('hola');
        r['estadoDespues'] = (await trx('talent.bot_conversations').where({ phone_key: tel10 }).first('state')).state;
        // Un documento después de cerrar también se archiva (sin lista: «sigue en revisión»).
        siguiente = { slot: 'curp', motivo: 'la CURP', clasificado: true };
        r['tardio'] = await mandar(PNG);

        // ── [RH.3.3.4b] Postulado por la web con 10 dígitos: la conversación nace así, y al escribir por WhatsApp guarda la lada ──
        const telW10 = `37${String(sello).slice(-8)}`;
        r['telW10'] = telW10;
        const dW = await intake.postular({
          phone: telW10, full_name: 'Carla Prueba Vega', email: null, city_branch: 'zamora-canindo', job_posting_id: null,
          position_interest: 'Cajero(a)', relative_in_company: null, rehire_note: null, heard_from: 'Facebook',
          cv: { adjunto: { buffer: PDF, contentType: 'application/pdf', sizeBytes: PDF.length } as never, file_name: 'cv.pdf' }, license: null,
        }, 'web', TENANT);
        const pW = await bot.pedirDocumentos(TENANT, String(dW.candidato_id));
        r['telWeb'] = [pW.telefono_wa, pW.ultimo_mensaje_en];
        await decir('hola', `521${telW10}`);
        const pW2 = await bot.pedirDocumentos(TENANT, String(dW.candidato_id));
        r['telWeb2'] = [pW2.telefono_wa, !!pW2.ultimo_mensaje_en];

        // ── Con todo lo obligatorio, no hay nada que pedir ─────────────────────────────────────────────────────
        const todos = OBLIGATORIOS_SIN_CV.map((slot) => ({ slot, storage_key: `k-${slot}`, origen: 'suite' }));
        await trx('talent.candidates').where({ id: candId }).update({ documents: JSON.stringify([...docs1, ...todos]) });
        r['nadaQuePedir'] = (await bot.pedirDocumentos(TENANT, candId)).mensaje;

        // ── Se le pedía el CV y mandó su INE (dos veces): se aparta UNA y viaja al expediente con el CV ─────────
        const telB = `521${String(sello + 3).slice(-10)}`;
        const telBk = telB.slice(-10);
        await trx('talent.bot_conversations').insert({
          tenant_id: TENANT, phone: telB, state: 'esperando_cv',
          data: JSON.stringify({ full_name: 'Bea Prueba Ruiz', position_interest: 'Cajero(a)', city_branch: 'Zamora' }),
        });
        siguiente = { slot: 'ine', motivo: 'una INE', clasificado: true };
        r['apartado'] = await mandar(PNG, telB);
        const primera = ((await trx('talent.bot_conversations').where({ phone_key: telBk }).first('documents')).documents.apartados as Array<Record<string, unknown>>)[0]['storage_key'];
        await mandar(PNG, telB);
        const apartados = (await trx('talent.bot_conversations').where({ phone_key: telBk }).first('documents')).documents.apartados as Array<Record<string, unknown>>;
        r['unaPorCasillero'] = [apartados.length, bucket.has(String(primera))];
        // Escribe algo antes de mandar el CV: lo apartado NO se pierde (un turno que no habla de documentos no los borra).
        await decir('ahorita te lo mando', telB);
        r['sigueApartado'] = ((await trx('talent.bot_conversations').where({ phone_key: telBk }).first('documents')).documents?.apartados ?? []).length;
        r['sinCandidatoAun'] = Number((await trx('talent.candidates').where({ phone_key: telBk }).count('* as n'))[0]['n']);
        r['conCv'] = (await mandar(PDF, telB)).includes('postulación queda completa');
        const candB = await trx('talent.candidates').where({ phone_key: telBk }).first('documents');
        r['expedienteB'] = (candB.documents as Array<Record<string, unknown>>).map((x) => x['slot']);
        r['apartadosLimpios'] = (await trx('talent.bot_conversations').where({ phone_key: telBk }).first('documents')).documents.apartados;

        // ── En la papelera no se archiva, y el archivo se borra del bucket ─────────────────────────────────────
        await trx('talent.candidates').where({ id: candId }).update({ deleted_at: trx.fn.now(), deletion_reason: 'manual' });
        const antes = bucket.size;
        r['papelera'] = await mandar(PNG);
        r['bucketIgual'] = bucket.size === antes;

        // ── CHECK: una etapa de documentos sin candidato no entra ──────────────────────────────────────────────
        r['ckSinCandidato'] = await fallo(() => trx('talent.bot_conversations').insert({
          tenant_id: TENANT, phone: `521${String(sello + 5).slice(-10)}`, state: 'pidiendo_documentos', outcome: 'postulada',
        }));
        r['ckSinCierre'] = await fallo(() => trx('talent.bot_conversations').insert({
          tenant_id: TENANT, phone: `521${String(sello + 6).slice(-10)}`, state: 'documentos_completos',
        }));
        r['ckDocsMal'] = await fallo(() => trx('talent.bot_conversations').insert({
          tenant_id: TENANT, phone: `521${String(sello + 8).slice(-10)}`, documents: JSON.stringify({ solicitados: 'ine' }),
        }));
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(r['peticion']).toEqual([OBLIGATORIOS_SIN_CV, true, true, null]);
    expect(r['convCreada']).toEqual(['pidiendo_documentos', 'postulada', true, 8]);
    expect(r['acuseIne']).toContain('Recibí tu *INE*');
    expect(r['acuseIne']).toContain('Aún me faltan');
    expect(r['acuseIne']).not.toContain('. INE');
    expect(r['acuseOtro']).toContain('no identifiqué cuál es');
    expect(r['expediente']).toEqual([['cv', 'suite'], ['ine', 'whatsapp'], ['otro', 'whatsapp']]);
    expect(r['recordatorio']).toContain('1. CURP');
    expect(r['listo']).toContain('Recibimos tus documentos');
    expect(r['cerrada']).toEqual(['documentos_completos', 'postulada']);
    expect(r['nota']).toContain('Faltan: curp');
    expect(r['despues']).toContain('la está *revisando*');
    expect(r['estadoDespues']).toBe('documentos_completos');
    expect(r['tardio']).toContain('Recibí tu *CURP*');
    expect(r['tardio']).toContain('sigue en revisión');
    // Nunca escribió: la conversación nace con su teléfono de la web y sin ventana; al escribir, guarda el de WhatsApp.
    expect(r['telWeb']).toEqual([r['telW10'], null]);
    expect(r['telWeb2']).toEqual([`521${String(r['telW10'])}`, true]);
    expect(r['nadaQuePedir']).toBeNull();
    expect(r['apartado']).toContain('guardé tu *INE*');
    expect(r['unaPorCasillero']).toEqual([1, false]);
    expect(r['sigueApartado']).toBe(1);
    expect(r['sinCandidatoAun']).toBe(0);
    expect(r['conCv']).toBe(true);
    expect(r['expedienteB']).toEqual(['cv', 'ine']);
    expect(r['apartadosLimpios']).toEqual([]);
    expect(r['papelera']).toContain('un reclutador te escribe');
    expect(r['bucketIgual']).toBe(true);
    expect(r['ckSinCandidato']).toBe('23514');
    expect(r['ckSinCierre']).toBe('23514');
    expect(r['ckDocsMal']).toBe('23514');
  }, 60_000);
});
