/**
 * `[RH.1.8]` La carga única no duplica lo que el destino ya tiene en un reloj real.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local npx vitest run -c libs/hr/vitest.config.ts
 *
 * Mega Talento es FALSO a propósito (contesta según la tabla que se le pide y vacío en el resto): lo que
 * se prueba es el SQL del lado de la Suite, que corre de verdad contra Postgres dentro de una transacción
 * que se deshace. La paridad con el Mega Talento real vive en `paridad-mega-talento.db.spec.ts`.
 *
 * Por qué hace falta (medido 2026-10-07): 119,260 checadas de Mega Talento no traen reloj y van al reloj
 * DESCONOCIDO del sitio. Si el destino ya tiene esas mismas checadas en el reloj real (la Fase CH, una
 * ingesta viva que empezó antes, o la carga corrida dos veces), entrarían dos veces.
 */
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.1.8] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la carga única contra la base.');

/** Un Mega Talento mínimo: dos sitios, un reloj real en cada uno y checadas con y sin reloj. */
function megaTalentoFalso(sitio: string, otro: string, serie: string, serieOtro: string) {
  const checadas: Record<string, Array<Record<string, unknown>>> = {
    [sitio]: [
      { codigo: '15', nombre: 'Quince', fecha_hora: '2026-06-01 08:00:07', fecha: '2026-06-01', tipo: null, serie_reloj: null }, // ya en el reloj real
      { codigo: '15', nombre: 'Quince', fecha_hora: '2026-06-01 18:00:00', fecha: '2026-06-01', tipo: null, serie_reloj: null }, // nueva
      { codigo: '16', nombre: 'Dieciséis', fecha_hora: '2026-08-06 08:00:00', fecha: '2026-08-06', tipo: null, serie_reloj: serie },
    ],
    // En el otro sitio la MISMA persona y hora: el puente es por sitio, así que entra.
    [otro]: [
      { codigo: '15', nombre: 'Quince', fecha_hora: '2026-06-01 08:00:07', fecha: '2026-06-01', tipo: null, serie_reloj: null },
    ],
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const tabla = /FROM\s+([a-z_]+)/i.exec(sql)?.[1] || '';
      if (/UNION/i.test(sql)) return { rows: [{ sucursal_id: sitio }, { sucursal_id: otro }] };
      if (tabla === 'relojes') {
        return { rows: [
          { serie, sucursal_id: sitio, alias: 'Real', ip: null, puerto: 4370, modo: 'agente', comm_key: 0, activo: true, pendiente: false, nota: null },
          { serie: serieOtro, sucursal_id: otro, alias: 'Otro', ip: null, puerto: 4370, modo: 'agente', comm_key: 0, activo: true, pendiente: false, nota: null },
        ] };
      }
      if (tabla === 'checadas') return { rows: checadas[String(params[0])] || [] };
      if (tabla === 'empleados' && /codigo_checador,''/.test(sql)) {
        return { rows: [{ sucursal_id: sitio, codigo: '15', nombre: 'Quince' }, { sucursal_id: sitio, codigo: '16', nombre: 'Dieciséis' }] };
      }
      return { rows: [] };
    },
  };
}

suite('carga única contra la base: el reloj desconocido cede ante un reloj real', () => {
  it('no carga dos veces lo que ya está en un reloj real del sitio, y lo cuenta en el cuadre', async () => {
    const carga = require(path.resolve(__dirname, '../../../../../database/scripts/rh/carga-unica-mega-talento.js'));
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of carga.MIGRACIONES_FASE) await require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${m}.js`)).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        const sufijo = Date.now();
        const [sitio, otro] = [`rh-carga-${sufijo}`, `rh-carga-otro-${sufijo}`];
        const [serie, serieOtro] = [`RH-CARGA-${sufijo}`, `RH-CARGA-OTRO-${sufijo}`];

        // El destino YA tiene el reloj real del sitio con una checada (como la tendría si la Fase CH, o la
        // ingesta viva, hubiera escrito antes de la carga).
        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: sitio, name: 'Carga' });
        const [dev] = await trx('hr.attendance_devices').insert({ tenant_id: TENANT, serial_number: serie, site_code: sitio }).returning('id');
        const devId = typeof dev === 'object' ? dev.id : dev;
        await trx('hr.attendance_logs').insert({
          tenant_id: TENANT, device_id: devId, device_user_id: '15', punched_local: '2026-06-01T08:00:07',
          punched_at: trx.raw(`('2026-06-01T08:00:07'::timestamp AT TIME ZONE 'America/Mexico_City')`), source: 'agente' });

        const cuadre = await carga.cargarMegaTalento(trx, megaTalentoFalso(sitio, otro, serie, serieOtro), { tenantId: TENANT });
        r['cuadre'] = cuadre.attendance_logs;

        const filas = await trx('hr.v_site_punches').whereIn('site_code', [sitio, otro])
          .orderBy(['site_code', 'person_code', 'punched_local'])
          .select('site_code', 'person_code', 'serial_number', trx.raw(`to_char(punched_local, 'MM-DD HH24:MI:SS') AS h`));
        r['vista'] = filas.map((f: { site_code: string; person_code: string; serial_number: string; h: string }) =>
          `${f.site_code === sitio ? 'A' : 'B'}|${f.person_code}|${f.serial_number.startsWith('MT-SIN-RELOJ-') ? 'desconocido' : 'real'}|${f.h}`);

        // Correrla otra vez no mete nada (idempotente).
        const otraVez = await carga.cargarMegaTalento(trx, megaTalentoFalso(sitio, otro, serie, serieOtro), { tenantId: TENANT });
        r['otraVez'] = otraVez.attendance_logs.cargadas;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }

    expect(r['cuadre']).toEqual({ origen: 4, cargadas: 3, descartes: { ya_en_un_reloj_del_sitio: 1 } });
    expect(r['vista']).toEqual([
      'A|15|real|06-01 08:00:07',         // la que ya estaba: una sola vez
      'A|15|desconocido|06-01 18:00:00',  // la nueva sin reloj sí entra
      'A|16|real|08-06 08:00:00',
      'B|15|desconocido|06-01 08:00:07',  // misma persona y hora, OTRO sitio: entra
    ]);
    expect(r['otraVez']).toBe(0);
  }, 60000);
});
