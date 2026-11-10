/**
 * `[RH.2.5]` La carga única del reclutamiento de Mega Talento, contra Postgres, con un Mega Talento SIMULADO que trae los
 * casos que midió el ensayo real (9-nov): la papelera sin motivo, spam y lista negra completos, la etapa de RH en
 * `portal_status` y el punto del bot en `estado`, una etapa huérfana. Se prueba también que correrla dos veces no
 * duplica (idempotente) y que lo no cargado se DECLARA.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts carga-reclutamiento
 *
 * Todo dentro de una transacción que se deshace. Sin `HR_DB_TEST_URL` se declara NO MEDIDO.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import knexLib, { Knex } from 'knex';
import { PASOS } from './bot/registro';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.5] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la carga del reclutamiento contra la base.');
const CARGA = () => require(path.join(RAIZ, 'database/scripts/rh/carga-reclutamiento-mega-talento.js'));

/**
 * Mega Talento simulado: responde las consultas de la carga por el nombre de la tabla. Honra la paginación por llave
 * (`WHERE id > $1 … LIMIT n`) con la que se leen los mensajes, para que la carga recorra más de una página.
 */
function mtSimulado(tablas: Record<string, Record<string, unknown>[]>) {
  return { query: async (sql: string, params: unknown[] = []) => {
    const m = /FROM (\w+)/i.exec(sql);
    let filas = tablas[m?.[1] ?? ''];
    if (!filas) throw new Error(`tabla desconocida: ${sql}`);
    if (/count\(\*\)/i.test(sql)) return { rows: [{ n: filas.length }] };
    if (/WHERE id > \$1/.test(sql)) filas = filas.filter((f) => String(f['id']) > String(params[0]));
    if (/ORDER BY id/.test(sql)) filas = [...filas].sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
    const lim = /LIMIT (\d+)/.exec(sql);
    return { rows: lim ? filas.slice(0, Number(lim[1])) : filas };
  } };
}

/** Aplica dentro de `trx` las migraciones que falten de la lista (la base de prueba puede venir atrás). */
async function migrar(trx: Knex.Transaction, lista: string[]) {
  const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
  for (const m of lista) if (!aplicadas.has(m)) await require(path.join(RAIZ, 'database/migrations-newdb', `${m}.js`)).up(trx);
}

describe('[RH.3.5] el bot de la carga habla el idioma del bot de la Suite', () => {
  it('los pasos son los de la Suite, en el mismo orden, y todo campo de Mega Talento cae en uno', () => {
    const { PASOS_BOT, CAMPO_MT } = CARGA();
    expect(PASOS_BOT).toEqual(PASOS.map((p) => p.campo));
    expect([...new Set(Object.values(CAMPO_MT))].sort()).toEqual([...PASOS_BOT].sort());
  });

  it('traduce cada estado de Mega Talento', () => {
    const { estadoBot } = CARGA();
    const nada = {};
    expect(estadoBot('esperando_correo', nada)).toEqual({ state: 'esperando_email', como: 'traducido' });
    expect(estadoBot('editando_familiar_en_empresa', nada)).toEqual({ state: 'editando_relative_in_company', como: 'traducido' });
    expect(estadoBot('esperando_cv', nada)).toEqual({ state: 'esperando_cv', como: 'igual' });
    expect(estadoBot('pendiente_aprobacion', nada)).toEqual({ state: 'postulada', como: 'terminado' });
    expect(estadoBot('invitado', nada)).toEqual({ state: 'nuevo', como: 'invitado' });
    expect(estadoBot('portal', nada)).toBeNull();
    // Un paso que la Suite no tiene: el siguiente dato que falta (aquí, el correo), o el resumen si no falta nada.
    expect(estadoBot('esperando_midot', { position_interest: 'Cajera', full_name: 'Eva' })).toEqual({ state: 'esperando_email', como: 'siguiente_faltante' });
    const lleno = Object.fromEntries(PASOS.map((p) => [p.campo, 'x']));
    expect(estadoBot('esperando_correo_prueba', lleno)).toEqual({ state: 'confirmando', como: 'siguiente_faltante' });
  });
});

suite('[RH.2.5] carga única del reclutamiento, contra la base', () => {
  it('mapea, cuadra, declara lo no cargado y es idempotente', async () => {
    const { cargarReclutamiento, MIGRACIONES_TALENT } = CARGA();
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const VAC = randomUUID(), ANA = randomUUID(), BETO = randomUUID(), CARO = randomUUID(), FANTASMA = randomUUID();
    const ahora = new Date('2026-11-01T12:00:00Z');
    const base = { documentos: [], documentos_solicitados: [], portal_data: {}, creado_en: ahora, deleted_at: null, spam: false, no_recontratable: false };
    const tablas: Record<string, Record<string, unknown>[]> = {
      puestos: [{ id: VAC, nombre: 'Cajera', sucursal_ids: ['sucursal-ph'], sucursales: 'Padre Hidalgo', activo: true, orden: 2, extra: {}, creado_en: ahora }],
      candidatos: [
        { ...base, id: ANA, telefono: '5214431112233', nombre_completo: 'Ana Prueba Uno', portal_status: 'aptitudes', estado: 'completado', semaforo: 'verde', fuente: 'Feria de empleo',
          creado_en: new Date('2026-10-01T12:00:00Z'), ultima_actividad: null },
        { ...base, id: BETO, telefono: '4431112233', nombre_completo: 'Beto Prueba Dos', portal_status: null, estado: 'esperando_rfc', semaforo: 'amarillo',
          spam: true, spam_motivo: 'número de prueba', spam_por: 'rh@x', spam_en: ahora },
        { ...base, id: CARO, telefono: '4439998877', nombre_completo: 'Caro Prueba Tres', portal_status: 'entrevista_rh', estado: 'pendiente_aprobacion', semaforo: 'rojo',
          deleted_at: ahora, no_recontratable: true, no_recontratable_motivo: 'abandono', no_recontratable_por: 'rh@x', no_recontratable_en: ahora },
      ],
      candidatos_transiciones: [
        { id: randomUUID(), candidato_id: ANA, etapa_origen: 'entrevista_rh', etapa_destino: 'aptitudes', horas_en_origen: 30, cambiado_en: ahora },
        { id: randomUUID(), candidato_id: FANTASMA, etapa_origen: null, etapa_destino: 'aptitudes', horas_en_origen: null, cambiado_en: ahora },
      ],
      candidatos_eventos: [{ id: randomUUID(), candidato_id: ANA, tipo: 'contacto', canal: 'llamada', nota: 'le llamé', por: 'rh@x', ocurrido_en: ahora, creado_en: ahora }],
      mensajes: [{}, {}, {}],
      requisiciones: [],
    };
    const mt = mtSimulado(tablas);
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await migrar(trx, MIGRACIONES_TALENT);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const c1 = await cargarReclutamiento(trx, mt, { tenantId: TENANT });
        r['cuadre'] = Object.fromEntries(['job_postings', 'candidates', 'candidate_stage_transitions', 'candidate_events']
          .map((k) => [k, [c1[k].origen, c1[k].cargadas, Object.values(c1[k].descartes).reduce((a: number, b) => a + (b as number), 0)]]));
        r['noCargado'] = [c1.no_cargado.mensajes_del_bot.filas, c1.no_cargado.requisiciones.filas];
        const fila = async (id: string) => trx('talent.candidates').where({ id }).first(
          'stage', 'bot_state', 'traffic_light', 'phone_key', 'source', 'is_spam', 'spam_reason', 'no_rehire', 'deleted_at', 'deletion_reason');
        const a = await fila(ANA), b = await fila(BETO), c = await fila(CARO);
        r['ana'] = [a.stage, a.bot_state, a.traffic_light, a.phone_key, a.source];
        r['beto'] = [b.stage, b.bot_state, b.is_spam, b.spam_reason, b.phone_key];
        r['caro'] = [c.no_rehire, !!c.deleted_at, c.deletion_reason];
        r['mismoTel'] = c1.candidates.mismo_telefono_que_otro >= 2;   // Ana y Beto: 52 1 443… y 443… son el mismo número
        r['vacante'] = await trx('talent.job_postings').where({ id: VAC }).first('name', 'branch_codes', 'sort_order');
        // La última actividad de Ana sale de su bitácora (cambio de etapa y evento del 1-nov), no queda vacía.
        r['ultimaAna'] = new Date((await trx('talent.candidates').where({ id: ANA }).first('last_activity_at')).last_activity_at).toISOString();
        r['derivadas'] = c1.candidates.ultima_actividad_derivada >= 1;
        // Idempotente: la segunda vez todo «ya estaba».
        const c2 = await cargarReclutamiento(trx, mt, { tenantId: TENANT });
        r['segunda'] = [c2.candidates.cargadas, c2.candidates.ya_estaban, c2.candidate_events.cargadas, c2.candidate_events.ya_estaban];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['cuadre']).toEqual({ job_postings: [1, 1, 0], candidates: [3, 3, 0], candidate_stage_transitions: [2, 1, 1], candidate_events: [1, 1, 0] });
    expect(r['noCargado']).toEqual([3, 0]);
    expect(r['ana']).toEqual(['aptitudes', 'completado', 'verde', '4431112233', 'Feria de empleo']);
    expect(r['beto']).toEqual([null, 'esperando_rfc', true, 'número de prueba', '4431112233']);
    expect(r['caro']).toEqual([true, true, 'manual']);
    expect(r['mismoTel']).toBe(true);
    expect(r['vacante']).toEqual({ name: 'Cajera', branch_codes: ['sucursal-ph'], sort_order: 2 });
    expect(r['segunda']).toEqual([0, 3, 0, 1]);
    expect(r['ultimaAna']).toBe('2026-11-01T12:00:00.000Z');
    expect(r['derivadas']).toBe(true);
  }, 60_000);

  it('[RH.3.5] --con-bot: los mensajes por páginas y una conversación por teléfono, donde se quedó', async () => {
    const { cargarReclutamiento, MIGRACIONES_TALENT, MIGRACIONES_BOT } = CARGA();
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const id = () => randomUUID();
    const [ANA, BETO, DANI, DANI_VIEJO, EVA, FER, GABY, IVAN] = [id(), id(), id(), id(), id(), id(), id(), id()];
    const t = (d: string) => new Date(`2026-10-${d}T12:00:00Z`);
    // Teléfonos que no chocan con nada de la base de prueba (prefijo 999).
    const tel = (n: number) => `521999000${String(n).padStart(4, '0')}`;
    const base = { documentos: [], documentos_solicitados: [], portal_data: {}, deleted_at: null, spam: false, no_recontratable: false,
      portal_status: null, ultima_actividad: null, puesto_interes: 'Cajera', nombre_completo: 'Prueba' };
    const solicitud = { iniciadaEn: '2026-10-05T10:00:00Z', respuestas: { padece_enfermedad: 'no', deudas: 'sí' } };
    const tablas: Record<string, Record<string, unknown>[]> = {
      puestos: [],
      candidatos: [
        { ...base, id: ANA, telefono: tel(1), estado: 'completado', creado_en: t('01') },                  // → postulada
        { ...base, id: BETO, telefono: tel(2), estado: 'esperando_rfc', spam: true, creado_en: t('01') },  // spam: sin conversación
        { ...base, id: DANI_VIEJO, telefono: tel(3), estado: 'esperando_nss', creado_en: t('01') },        // mismo tel, más viejo
        { ...base, id: DANI, telefono: tel(3), estado: 'esperando_correo', creado_en: t('04'), portal_data: { solicitud } },
        { ...base, id: EVA, telefono: tel(4), estado: 'esperando_midot', correo: null, creado_en: t('02') },
        { ...base, id: FER, telefono: tel(5), estado: 'portal', creado_en: t('02') },                     // web: sin conversación
        { ...base, id: GABY, telefono: tel(6), estado: 'invitado', creado_en: t('02') },
        { ...base, id: IVAN, telefono: tel(7), estado: 'esperando_rfc', creado_en: t('02') },              // la Suite ya le habló
      ],
      candidatos_transiciones: [], candidatos_eventos: [], requisiciones: [],
      mensajes: [
        { id: id(), telefono: tel(3), direccion: 'in', tipo: 'text', texto: 'hola', media_url: null, creado_en: t('04') },
        { id: id(), telefono: tel(3), direccion: 'in', tipo: 'image', texto: null, media_url: 'https://mt/x.jpg', creado_en: t('06') },
        { id: id(), telefono: tel(3), direccion: 'out', tipo: 'text', texto: '¿tu correo?', media_url: null, creado_en: t('07') },
        { id: id(), telefono: tel(1), direccion: 'in', tipo: 'text', texto: 'listo', media_url: null, creado_en: t('03') },
        { id: id(), telefono: tel(1), direccion: 'out', tipo: 'template', texto: null, media_url: null, creado_en: t('03') },
        { id: id(), telefono: tel(4), direccion: 'sistema', tipo: 'text', texto: '?', media_url: null, creado_en: t('03') },
        { id: id(), telefono: null, direccion: 'in', tipo: 'text', texto: 'sin número', media_url: null, creado_en: t('03') },
      ],
    };
    const mt = mtSimulado(tablas);
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        await migrar(trx, [...MIGRACIONES_TALENT, ...MIGRACIONES_BOT]);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        await trx('talent.bot_conversations').insert({ tenant_id: TENANT, phone: tel(7), state: 'esperando_nss', data: JSON.stringify({}) });
        const c = await cargarReclutamiento(trx, mt, { tenantId: TENANT, conBot: true, paginaMensajes: 2 });
        r['msgs'] = [c.messages.origen, c.messages.cargadas, c.messages.descartes];
        r['conv'] = [c.bot_conversations.origen, c.bot_conversations.cargadas, c.bot_conversations.ya_estaban, c.bot_conversations.como];
        r['noCargado'] = Object.keys(c.no_cargado).sort();
        const conv = async (n: number) => trx('talent.bot_conversations').where({ tenant_id: TENANT, phone: tel(n) })
          .first('state', 'outcome', 'candidate_id', 'data', 'application', 'last_inbound_at');
        const ana = await conv(1), dani = await conv(3), eva = await conv(4), gaby = await conv(6), ivan = await conv(7);
        r['ana'] = [ana.state, ana.outcome, ana.candidate_id === ANA, new Date(ana.last_inbound_at).toISOString()];
        r['dani'] = [dani.state, dani.candidate_id === DANI, dani.application, new Date(dani.last_inbound_at).toISOString(), dani.data.full_name];
        r['eva'] = eva.state;
        r['gaby'] = [gaby.state, gaby.last_inbound_at];
        r['ivan'] = ivan.state;
        r['sinConv'] = Number((await trx('talent.bot_conversations').whereIn('phone', [tel(2), tel(5)]).count({ n: '*' }))[0].n);
        r['imagen'] = (await trx('whatsapp.messages').where({ tenant_id: TENANT, phone: tel(3), type: 'image' }).first('payload', 'flow', 'thread_id'));
        const c2 = await cargarReclutamiento(trx, mt, { tenantId: TENANT, conBot: true, paginaMensajes: 2 });
        r['segunda'] = [c2.messages.cargadas, c2.messages.ya_estaban, c2.bot_conversations.cargadas, c2.bot_conversations.ya_estaban];
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect(r['msgs']).toEqual([7, 5, { direccion_desconocida: 1, sin_telefono: 1 }]);
    // 5 con conversación (spam, web y el teléfono repetido más viejo, no); la de Iván ya existía en la Suite y manda ésa.
    expect(r['conv']).toEqual([5, 4, 1, { terminado: 1, traducido: 1, siguiente_faltante: 1, invitado: 1 }]);
    expect(r['noCargado']).toEqual(['archivos_del_expediente', 'requisiciones']);
    expect(r['ana']).toEqual(['postulada', 'postulada', true, '2026-10-03T12:00:00.000Z']);
    // La solicitud a medias viaja tal cual, con lo sensible (decisión del 9-nov); la ventana de 24 h, del último ENTRANTE.
    expect(r['dani']).toEqual(['esperando_email', true, { respuestas: solicitud.respuestas, iniciada_en: solicitud.iniciadaEn },
      '2026-10-06T12:00:00.000Z', 'Prueba']);
    expect(r['eva']).toBe('esperando_email');
    expect(r['gaby']).toEqual(['nuevo', null]);
    expect(r['ivan']).toBe('esperando_nss');
    expect(r['sinConv']).toBe(0);
    expect(r['imagen']).toEqual({ payload: { media_url: 'https://mt/x.jpg', origen: 'mega_talento' }, flow: 'recruitment', thread_id: null });
    expect(r['segunda']).toEqual([0, 5, 0, 5]);
  }, 60_000);
});
