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

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const RAIZ = path.resolve(__dirname, '../../../../..');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.2.5] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la carga del reclutamiento contra la base.');

suite('[RH.2.5] carga única del reclutamiento, contra la base', () => {
  it('mapea, cuadra, declara lo no cargado y es idempotente', async () => {
    const { cargarReclutamiento, MIGRACIONES_TALENT } = require(path.join(RAIZ, 'database/scripts/rh/carga-reclutamiento-mega-talento.js'));
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const VAC = randomUUID(), ANA = randomUUID(), BETO = randomUUID(), CARO = randomUUID(), FANTASMA = randomUUID();
    const ahora = new Date('2026-11-01T12:00:00Z');
    const base = { documentos: [], documentos_solicitados: [], portal_data: {}, creado_en: ahora, deleted_at: null, spam: false, no_recontratable: false };
    const tablas: Record<string, unknown[]> = {
      puestos: [{ id: VAC, nombre: 'Cajera', sucursal_ids: ['sucursal-ph'], sucursales: 'Padre Hidalgo', activo: true, orden: 2, extra: {}, creado_en: ahora }],
      candidatos: [
        { ...base, id: ANA, telefono: '5214431112233', nombre_completo: 'Ana Prueba Uno', portal_status: 'aptitudes', estado: 'completado', semaforo: 'verde', fuente: 'Feria de empleo' },
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
    // Mega Talento simulado: responde las consultas de la carga por el nombre de la tabla.
    const mt = { query: async (sql: string) => {
      const m = /FROM (\w+)/i.exec(sql);
      const filas = tablas[m?.[1] ?? ''];
      if (!filas) throw new Error(`tabla desconocida: ${sql}`);
      return /count\(\*\)/i.test(sql) ? { rows: [{ n: filas.length }] } : { rows: filas };
    } };
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        const aplicadas = new Set((await trx.raw('SELECT name FROM public.knex_migrations')).rows.map((x: { name: string }) => x.name.replace(/\.js$/, '')));
        for (const m of MIGRACIONES_TALENT) if (!aplicadas.has(m)) await require(path.join(RAIZ, 'database/migrations-newdb', `${m}.js`)).up(trx);
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
  }, 60_000);
});
