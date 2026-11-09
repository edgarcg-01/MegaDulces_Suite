/**
 * `[RH.3.5b]` La carga de los archivos de Mega Talento al bucket, contra Postgres, con la red y el bucket SIMULADOS. Lo
 * que se defiende: cada liga se baja UNA vez aunque aparezca en el expediente, en su columna y en el chat; la llave es
 * fija por liga; lo que ya tiene llave o no es de Mega Talento no se toca; el CV que sólo estaba en su columna entra al
 * expediente (la ficha no lo mostraba); lo que no se pudo bajar y lo que no tiene liga se DECLARAN; el ensayo no sube
 * nada; y correrla dos veces no repite nada.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts carga-archivos
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
const BOT = 'https://bot-rh-production.up.railway.app/archivo/';
const CLD = 'https://res.cloudinary.com/duher/image/upload/cvs/';

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.3.5b] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la carga de archivos contra la base.');

suite('[RH.3.5b] carga de los archivos de Mega Talento, contra la base', () => {
  it('baja cada liga una vez, escribe la llave, agrega lo que estaba fuera del expediente y declara lo que falta', async () => {
    const { cargarArchivos, llaveDe } = require(path.join(RAIZ, 'database/scripts/rh/carga-archivos-mega-talento.js'));
    const { MIGRACIONES_TALENT, MIGRACIONES_BOT } = require(path.join(RAIZ, 'database/scripts/rh/carga-reclutamiento-mega-talento.js'));
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
    const sufijo = randomUUID().slice(0, 8);   // ligas únicas por corrida: la base de prueba puede traer otras
    const u = (n: string) => `${BOT}${n}-${sufijo}`;
    const archivos: Record<string, { ok: boolean; status: number; body?: Buffer; contentType?: string }> = {
      [u('cv')]: { ok: true, status: 200, body: Buffer.from('%PDF cv'), contentType: 'application/pdf' },
      [u('muerto')]: { ok: false, status: 404 },
      [u('solo-chat')]: { ok: true, status: 200, body: Buffer.from('jpg'), contentType: 'image/jpeg; charset=binary' },
      [`${CLD}frente-${sufijo}.jpg`]: { ok: true, status: 200, body: Buffer.from('frente'), contentType: 'image/jpeg' },
      [`${CLD}reverso-${sufijo}.jpg`]: { ok: true, status: 200, body: Buffer.from('reverso'), contentType: 'image/jpeg' },
    };
    const bajadas: Record<string, number> = {};
    const bajar = async (url: string) => {
      bajadas[url] = (bajadas[url] ?? 0) + 1;
      const a = archivos[url];
      if (!a) throw new Error(`no se esperaba bajar ${url}`);
      return a;
    };
    const subidas: string[] = [];
    const subir = async (key: string) => { subidas.push(key); };
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
        for (const m of [...MIGRACIONES_TALENT, ...MIGRACIONES_BOT]) if (!aplicadas.has(m)) await require(path.join(RAIZ, 'database/migrations-newdb', `${m}.js`)).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        // La base de prueba puede traer ligas de Mega Talento de otras pruebas: se les pone llave para que no estorben.
        await trx.raw(`UPDATE whatsapp.messages SET payload = payload || '{"storage_key":"otra"}' WHERE flow = 'recruitment' AND payload->>'media_url' IS NOT NULL`);
        const otros = await trx('talent.candidates').whereRaw(`documents::text LIKE '%https://%' OR cv_url LIKE 'https://%' OR cv_back_url LIKE 'https://%' OR license_url LIKE 'https://%'`).pluck('id');
        if (otros.length) await trx('talent.candidates').whereIn('id', otros).update({ documents: '[]', cv_url: null, cv_back_url: null, license_url: null });
        const docsA = [
          { url: u('cv'), slot: 'cv', filename: 'cv.pdf' },
          { url: u('muerto'), slot: 'ine' },
          { archivo_local: '/data/media/1/2.jpg', media_id: '2', mime_type: 'image/jpeg' },
          { url: u('ya-tiene'), slot: 'curp', storage_key: 'talent/ya/x.pdf' },
        ];
        await trx('talent.candidates').insert([
          { id: A, tenant_id: TENANT, full_name: 'Ana', documents: JSON.stringify(docsA), cv_url: u('cv'), created_at: new Date('2026-08-01T12:00:00Z') },
          { id: B, tenant_id: TENANT, full_name: 'Beto', documents: '[]', cv_url: `${CLD}frente-${sufijo}.jpg`, cv_back_url: `${CLD}reverso-${sufijo}.jpg`,
            created_at: new Date('2026-08-02T12:00:00Z') },
          { id: C, tenant_id: TENANT, full_name: 'Caro', documents: JSON.stringify([{ url: 'https://otro.sitio/x.pdf', slot: 'midot' }]) },
        ]);
        const msg = (url: string) => ({ id: randomUUID(), tenant_id: TENANT, direction: 'in', type: 'image', flow: 'recruitment', phone: '5219990001111',
          payload: JSON.stringify({ media_url: url, origen: 'mega_talento' }) });
        const [m1, m2] = [msg(u('cv')), msg(u('solo-chat'))];
        // La misma liga, pero ya con su llave (la puso la Suite): no se le cambia.
        const m3 = { ...msg(u('cv')), payload: JSON.stringify({ media_url: u('cv'), storage_key: 'talent/suite/propia.jpg' }) };
        await trx('whatsapp.messages').insert([m1, m2, m3]);

        // El ensayo baja pero NO sube (y lo que escribe se deshace con el savepoint).
        await trx.transaction(async (t2) => {
          const e = await cargarArchivos(t2, { tenantId: TENANT, bajar, subir: null });
          r['ensayo'] = [e.movidas, e.subidas, subidas.length];
          throw ROLLBACK;
        }).catch((e) => { if (e !== ROLLBACK) throw e; });
        for (const k of Object.keys(bajadas)) delete bajadas[k];

        const c1 = await cargarArchivos(trx, { tenantId: TENANT, bajar, subir });
        r['cuadre'] = [c1.ligas, c1.movidas, c1.perdidas, c1.subidas, c1.docsConLlave, c1.docsAgregados, c1.candidatosTocados, c1.mensajes];
        r['sinLiga'] = c1.no_movido.sin_liga;
        r['unaVez'] = Object.values(bajadas).every((n) => n === 1) && Object.keys(bajadas).length === 5;
        const docs = async (id: string) => (await trx('talent.candidates').where({ id }).first('documents')).documents;
        const a = await docs(A), b = await docs(B), c = await docs(C);
        const llaveCv = llaveDe(TENANT, u('cv'), 'application/pdf');
        r['a'] = [a[0].storage_key === llaveCv, a[0].mime_type, a[0].size_bytes, a[0].url === u('cv'), a[1].storage_key ?? null, a[2], a[3].storage_key, a.length];
        r['b'] = b.map((d: Record<string, unknown>) => [d['slot'], d['filename'], String(d['storage_key']).endsWith('.jpg'), d['origen'], d['recibido_en']]);
        r['c'] = c;
        const pay = async (id: string) => (await trx('whatsapp.messages').where({ id }).first('payload')).payload;
        r['m1'] = (await pay(m1.id)).storage_key === llaveCv;
        r['m2'] = [(await pay(m2.id)).storage_key === llaveDe(TENANT, u('solo-chat'), 'image/jpeg'), (await pay(m2.id)).mime_type];
        r['m3'] = (await pay(m3.id)).storage_key;
        r['llave'] = /^talent\/00000000-0000-0000-0000-00000000d01c\/mega-talento\/[0-9a-f]{32}\.pdf$/.test(llaveCv);

        // Otra vez: sólo queda la liga muerta; nada se repite.
        const c2 = await cargarArchivos(trx, { tenantId: TENANT, bajar, subir });
        r['segunda'] = [c2.ligas, c2.movidas, c2.docsConLlave, c2.docsAgregados, c2.mensajes];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['ensayo']).toEqual([4, 0, 0]);
    // 5 ligas (cv, muerta, sólo-chat, frente, reverso); la que ya tenía llave no cuenta.
    expect(r['cuadre']).toEqual([5, 4, { 404: 1 }, 4, 1, 2, 2, 2]);
    expect(r['sinLiga']).toMatchObject({ documentos: 1, candidatos: 1 });
    expect(r['unaVez']).toBe(true);
    // La liga de origen se conserva junto a la llave.
    expect(r['a']).toEqual([true, 'application/pdf', 7, true, null, { archivo_local: '/data/media/1/2.jpg', media_id: '2', mime_type: 'image/jpeg' }, 'talent/ya/x.pdf', 4]);
    expect(r['b']).toEqual([
      ['cv', 'CV (Mega Talento)', true, 'mega_talento', '2026-08-02T12:00:00.000Z'],
      ['cv', 'CV, reverso (Mega Talento)', true, 'mega_talento', '2026-08-02T12:00:00.000Z'],
    ]);
    expect(r['c']).toEqual([{ url: 'https://otro.sitio/x.pdf', slot: 'midot' }]);
    expect(r['m1']).toBe(true);
    expect(r['m2']).toEqual([true, 'image/jpeg']);
    expect(r['m3']).toBe('talent/suite/propia.jpg');
    expect(r['llave']).toBe(true);
    expect(r['segunda']).toEqual([1, 0, 0, 0, 0]);
  }, 60_000);
});
