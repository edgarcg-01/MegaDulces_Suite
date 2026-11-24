/**
 * `[RH.15.11]` La firma de la semana desde el celular (QR personal), contra Postgres (regla 13: lo que escribe, ejercido
 * con el payload de la pantalla). Todo dentro de una transacción que se deshace; el bucket se simula.
 *
 * ⚠️ Cada `tk.run` va en su propio SAVEPOINT, como en prod va en su propia transacción: un rechazo no deshace lo anterior.
 *
 *   HR_DB_TEST_URL=postgres://…/platform_local JWT_SECRET=… npx vitest run -c libs/hr/vitest.config.ts
 */
import 'reflect-metadata';
import path from 'path';
import knexLib, { Knex } from 'knex';
import { crearToken, huellaToken, tenantDelToken } from './attendance-firma-digital.service';

const URL = process.env['HR_DB_TEST_URL'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');
const mig = (n: string) => require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${n}.js`));
const MIGS = ['20261007100000_hr_relojes_y_checadas', '20261007110000_hr_horarios_y_alertas', '20261007304401_hr_incidencias_y_cierres',
  '20261117105402_rh15_5_firmas_de_la_semana',
  '20261117105402_rh15_5_firmas_de_la_semana'];   // dos veces: idempotente (papel + QR, una sola migración)
/** El trazo que manda el lienzo: un PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDw+PgplbmRvYmoKdHJhaWxlcgo8PD4+CiUlRU9GCg==';
const ORIGEN = 'https://suite.prueba';

const suite = URL && !/prod|railway|\.222:5434/i.test(URL) ? describe : describe.skip;
if (!URL) console.warn('[RH.15.11] NO MEDIDO: sin HR_DB_TEST_URL no se prueba la firma desde el celular contra la base.');

const dia = (fecha: string, estado: string, netasMin: number | null, entrada: string | null, salida: string | null) =>
  ({ fecha, estado, entrada, salida, netasMin, horasNetas: '', comida: '', atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0, bolsaAntes: 0, bolsaDespues: 0,
    incidencias: estado === 'justificado' ? [{ id: 'x', tipo: 'permiso', codigo: 'P', etiqueta: 'Permiso con goce', nota: '' }] : [] });
const foto = (extra = 0) => ({
  personas: [
    { codigo: '15', nombre: 'Ana', nombreCompleto: 'PRUEBA UNO', departamento: 'ALMACEN', registrado: true, faltas: 1,
      semanas: [{ inicio: '2026-11-05', dias: [
        dia('2026-11-05', 'a_tiempo', 480 + extra, '08:00', '17:00'), dia('2026-11-06', 'falta', null, null, null),
        dia('2026-11-07', 'justificado', 0, null, null), dia('2026-11-04', 'a_tiempo', 480, '08:00', '17:00'),   // 04 = fuera de la semana
      ] }] },
    { codigo: '16', nombre: 'Beto', nombreCompleto: 'PRUEBA DOS', departamento: 'ALMACEN', registrado: true },
    { codigo: '17', nombre: 'Caro', nombreCompleto: 'PRUEBA TRES', departamento: 'CAJAS', registrado: true },
    { codigo: '99', nombre: 'Empleado 99', departamento: null, registrado: false },
  ],
});

describe('[RH.15.11] el token (sin base)', () => {
  it('el token lleva el tenant y 144 bits al azar; uno alterado o corto no da tenant', () => {
    const t = crearToken(TENANT);
    expect(tenantDelToken(t)).toBe(TENANT);
    expect(t).toMatch(/^[A-Za-z0-9_-]{46}$/);
    expect(crearToken(TENANT)).not.toBe(t);
    expect(tenantDelToken(t.slice(0, 40))).toBeNull();
    expect(tenantDelToken('../../etc/passwd')).toBeNull();
    expect(tenantDelToken('')).toBeNull();
    expect(huellaToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

suite('[RH.15.11] la firma desde el celular, contra la base', () => {
  it('QR → su semana → firma (cuenta sola) → hoja del departamento, comprobante y expediente; con cada camino de rechazo', async () => {
    const { HrAttendanceFirmaDigitalService } = await import('./attendance-firma-digital.service');
    const { HrAttendanceSignoffsService } = await import('./attendance-signoffs.service');
    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const r: Record<string, unknown> = {};
    try {
      await knex.transaction(async (trx) => {
        for (const m of MIGS) await mig(m).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        let n = 0;
        const tk = {
          run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => {
            const sp = `r${n++}`;
            await trx.raw(`SAVEPOINT ${sp}`);
            try { const x = await cb(trx); await trx.raw(`RELEASE SAVEPOINT ${sp}`); return x; } catch (e) { await trx.raw(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
          },
          global: trx,
        };
        const ctx = { requireTenantId: () => TENANT, get: () => ({ userId: null, username: 'rh_prueba' }) };
        const guardados: string[] = [];
        const storage = {
          isConfigured: () => true,
          putBuffer: async (_b: Buffer, _ct: string, folder: string, nombre: string) => { const key = `${folder}/${guardados.length}-${nombre}`; guardados.push(key); return { key }; },
          signedUrl: async (k: string) => `https://bucket.prueba/${k}`,
          getDataUri: async (k: string) => (guardados.includes(k) ? PNG : null),
        };
        const svc = new HrAttendanceFirmaDigitalService(tk as never, ctx as never, storage as never);
        const firmas = new HrAttendanceSignoffsService(tk as never, ctx as never, storage as never);
        const falla = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return e as { status?: number; message: string }; } };
        const meta = { ip: '10.0.0.7', userAgent: 'Mozilla/5.0 (prueba)' };

        await trx('hr.attendance_sites').insert({ tenant_id: TENANT, code: 'rh1511-prueba', name: 'Prueba RH.15.11' });
        const semana = { site_code: 'rh1511-prueba', period_start: '2026-11-05' };
        const pedir = { ...semana, department: 'ALMACEN' };

        // Sin cierre no hay QR; sin origen público tampoco; una persona de otro departamento, tampoco.
        r['sinCierre'] = (await falla(() => svc.generar(pedir, ORIGEN)))?.status;
        r['hojaSinCierre'] = (await falla(() => svc.hoja(pedir)))?.status;
        const [c1] = await trx('hr.attendance_closures').insert({ tenant_id: TENANT, ...semana, period_end: '2026-11-11', snapshot: JSON.stringify(foto()) }).returning('id');
        const cierre1 = (c1 as { id: string }).id ?? c1;
        r['sinOrigen'] = (await falla(() => svc.generar(pedir, undefined)))?.status;
        r['ajena'] = (await falla(() => svc.generar({ ...pedir, person_codes: ['17'] }, ORIGEN)))?.status;

        const g1 = await svc.generar(pedir, ORIGEN);
        r['generadas'] = [g1.ligas.map((l) => l.person_code).join(','), g1.period_end, g1.ligas.every((l) => l.url.startsWith(`${ORIGEN}/mi-semana/`))];
        const tok = (codigo: string, g = g1) => g.ligas.find((l) => l.person_code === codigo)!.url.split('/').pop()!;
        // La base guarda la huella, no el token.
        r['soloHuella'] = [
          (await trx('hr.attendance_sign_links').where({ token_sha256: tok('15') }).count<{ count: string }[]>('* as count'))[0].count,
          (await trx('hr.attendance_sign_links').where({ token_sha256: huellaToken(tok('15')) }).count<{ count: string }[]>('* as count'))[0].count,
        ].map(Number);

        // Generar otra vez para Ana revoca la anterior: el QR viejo ya no sirve.
        const viejo = tok('15');
        const g2 = await svc.generar({ ...pedir, person_codes: ['15'] }, ORIGEN);
        const ana = tok('15', g2);
        r['viejo'] = (await falla(() => svc.publica(viejo)))?.status;
        r['vivas15'] = Number((await trx('hr.attendance_sign_links').where({ person_code: '15' }).whereNull('revoked_at').count<{ count: string }[]>('* as count'))[0].count);

        // Abrir el QR: su nombre completo y su semana, sólo los 7 días, en palabras. Sin número de reloj.
        const p = await svc.publica(ana);
        r['publica'] = [p.nombre, p.site_name, p.period_start, p.period_end, p.dias.map((d) => `${d.fecha.slice(8)}:${d.etiqueta}`).join('|'),
          p.horas_semana, p.faltas, p.dias[2]?.incidencias.join(','), Object.keys(p).sort().join(',')];
        r['basura'] = (await falla(() => svc.publica('no-es-un-token')))?.status;

        // Firmar: un PDF en lugar del trazo → no; vacío → no; el trazo → sí, una sola vez.
        r['firmaPdf'] = (await falla(() => svc.firmar(ana, { firma_png: PDF }, meta)))?.status;
        r['firmaVacia'] = (await falla(() => svc.firmar(ana, { firma_png: '' }, meta)))?.status;
        const f = await svc.firmar(ana, { firma_png: PNG }, meta);
        r['firmo'] = [f.ok, typeof f.signed_at];
        const fila = await trx('hr.attendance_digital_signatures').where({ person_code: '15' }).first('id', 'ip', 'user_agent', 'voided_at', 'snapshot_sha256', 'file_key');
        r['fila'] = [fila?.ip, fila?.user_agent, fila?.voided_at, String(fila?.file_key).includes('/celular/'), String(fila?.snapshot_sha256).length];
        r['dosVeces'] = (await falla(() => svc.firmar(ana, { firma_png: PNG }, meta)))?.status;

        // El estado: la firma del celular CUENTA en cuanto se hace (sin jefe). Beto tiene su QR vivo.
        const est1 = await firmas.estado(semana);
        const alm1 = est1.departamentos.find((d) => d.department === 'ALMACEN')!;
        r['estado1'] = [alm1.firmaron, alm1.total, alm1.personas.map((x) => `${x.codigo}:${x.via ?? (x.liga ? 'liga' : '-')}`).join(','),
          alm1.personas.find((x) => x.codigo === '15')?.firma_id === fila?.id];

        // Volver a generar no le da QR a quien ya firmó.
        const g3 = await svc.generar(pedir, ORIGEN);
        r['omitidas'] = g3.omitidas.map((o) => `${o.person_code}:${o.motivo}`).join(',');

        // Beto firma en la hoja de papel.
        await firmas.registrar({ ...pedir, person_codes: ['16'], jefe_nombre: 'JEFE DE PRUEBA', file_data_uri: PDF, file_name: 'hoja.pdf' });

        // La hoja del departamento (el PDF): las dos personas, ordenadas por nombre, con su firma y su semana.
        const h = await svc.hoja(pedir);
        r['hoja'] = [h.department, h.version.length, h.vigente, h.personas.map((x) => `${x.codigo}:${x.firma?.via ?? '-'}:${x.firma?.png ? 'trazo' : '-'}`).join(','),
          h.personas.find((x) => x.codigo === '15')?.firma?.ip, h.personas.find((x) => x.codigo === '15')?.horas_semana];
        r['hojaSinDepto'] = (await falla(() => svc.hoja({ ...semana, department: 'NO EXISTE' })))?.status;

        // El comprobante de Ana: una persona, la versión que firmó.
        const cp = await svc.comprobante(String(fila?.id));
        r['comprobante'] = [cp.personas.length, cp.personas[0]?.codigo, cp.vigente, cp.version === String(fila?.snapshot_sha256).slice(0, 12)];
        r['comprobanteAjeno'] = (await falla(() => svc.comprobante('00000000-0000-0000-0000-000000000000')))?.status;

        // El expediente de cada una.
        r['expAna'] = (await svc.expediente({ site_code: 'rh1511-prueba', person_code: '15' })).firmas.map((x) => `${x.via}:${x.vigente}:${x.period_start}`);
        r['expBeto'] = (await svc.expediente({ site_code: 'rh1511-prueba', person_code: '16' })).firmas.map((x) => `${x.via}:${x.vigente}`);
        r['expSinPersona'] = (await falla(() => svc.expediente({ site_code: 'rh1511-prueba' })))?.status;

        // RH anula la firma de Ana (firmó alguien más): sin motivo no; con motivo deja de contar y puede volver a firmar.
        r['anularSinMotivo'] = (await falla(() => svc.anular(String(fila?.id), 'ok')))?.status;
        await svc.anular(String(fila?.id), 'prueba: firmó otra persona por ella');
        r['anularDosVeces'] = (await falla(() => svc.anular(String(fila?.id), 'prueba: otra vez')))?.status;
        const alm2 = (await firmas.estado(semana)).departamentos.find((d) => d.department === 'ALMACEN')!;
        r['trasAnular'] = [alm2.firmaron, alm2.personas.map((x) => `${x.codigo}:${x.via ?? '-'}`).join(',')];
        const g4 = await svc.generar({ ...pedir, person_codes: ['15'] }, ORIGEN);
        await svc.firmar(tok('15', g4), { firma_png: PNG }, meta);
        r['reFirma'] = (await firmas.estado(semana)).departamentos.find((d) => d.department === 'ALMACEN')!.firmaron;
        r['expAna2'] = (await svc.expediente({ site_code: 'rh1511-prueba', person_code: '15' })).firmas.map((x) => (x.anulada ? 'anulada' : 'vigente')).sort().join(',');

        // Una liga vencida no sirve.
        const g5 = await svc.generar({ ...pedir, department: 'CAJAS' }, ORIGEN);
        await trx('hr.attendance_sign_links').where({ token_sha256: huellaToken(tok('17', g5)) }).update({ expires_at: trx.raw(`now() - interval '1 minute'`) });
        r['vencida'] = (await falla(() => svc.publica(tok('17', g5))))?.message;

        // Se reabre la semana y se cierra distinta: la liga viva ya no sirve, y las firmas son de otra versión.
        const g6 = await svc.generar({ ...pedir, department: 'CAJAS' }, ORIGEN);
        await trx('hr.attendance_closures').where({ id: cierre1 }).update({ reopened_at: trx.fn.now(), reopen_reason: 'prueba: faltaba una incidencia' });
        await trx('hr.attendance_closures').insert({ tenant_id: TENANT, ...semana, period_end: '2026-11-11', snapshot: JSON.stringify(foto(30)) });
        r['cambio'] = /cambió/.test(String((await falla(() => svc.publica(tok('17', g6))))?.message));
        const alm4 = (await firmas.estado(semana)).departamentos.find((d) => d.department === 'ALMACEN')!;
        r['reabierta'] = alm4.firmaron;
        r['expAna3'] = (await svc.expediente({ site_code: 'rh1511-prueba', person_code: '15' })).firmas.filter((x) => !x.anulada).map((x) => x.vigente);
        const cp2 = await svc.comprobante(String(fila?.id));
        r['comprobanteViejo'] = [cp2.vigente, cp2.personas[0]?.horas_semana];   // la versión que firmó, no la nueva

        // El down se niega: hay firmas.
        r['down'] = (await falla(async () => { await trx.raw('SAVEPOINT d'); try { await mig('20261117105402_rh15_5_firmas_de_la_semana').down(trx); } finally { await trx.raw('ROLLBACK TO SAVEPOINT d'); } }))?.message;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await knex.destroy();
    }
    expect([r['sinCierre'], r['hojaSinCierre']]).toEqual([409, 409]);
    expect([r['sinOrigen'], r['ajena']]).toEqual([400, 400]);
    expect(r['generadas']).toEqual(['16,15', '2026-11-11', true]);
    expect(r['soloHuella']).toEqual([0, 1]);
    expect(r['viejo']).toBe(403);
    expect(r['vivas15']).toBe(1);
    expect(r['publica']).toEqual(['PRUEBA UNO', 'Prueba RH.15.11', '2026-11-05', '2026-11-11', '05:Asistió|06:Falta|07:Justificado', '8:00', 1,
      'Permiso con goce', 'dias,expires_at,faltas,horas_semana,nombre,period_end,period_start,site_name']);
    expect(r['basura']).toBe(403);
    expect([r['firmaPdf'], r['firmaVacia']]).toEqual([400, 400]);
    expect(r['firmo']).toEqual([true, 'string']);
    expect(r['fila']).toEqual(['10.0.0.7', 'Mozilla/5.0 (prueba)', null, true, 64]);
    expect(r['dosVeces']).toBe(403);
    expect(r['estado1']).toEqual([1, 2, '16:liga,15:celular', true]);
    expect(r['omitidas']).toBe('15:Ya firmó en su celular');
    expect(r['hoja']).toEqual(['ALMACEN', 12, true, '16:papel:-,15:celular:trazo', '10.0.0.7', '8:00']);
    expect(r['hojaSinDepto']).toBe(400);
    expect(r['comprobante']).toEqual([1, '15', true, true]);
    expect(r['comprobanteAjeno']).toBe(404);
    expect(r['expAna']).toEqual(['celular:true:2026-11-05']);
    expect(r['expBeto']).toEqual(['papel:true']);
    expect(r['expSinPersona']).toBe(400);
    expect([r['anularSinMotivo'], r['anularDosVeces']]).toEqual([400, 409]);
    expect(r['trasAnular']).toEqual([1, '16:papel,15:-']);
    expect(r['reFirma']).toBe(2);
    expect(r['expAna2']).toBe('anulada,vigente');
    expect(r['vencida']).toMatch(/venció/);
    expect(r['cambio']).toBe(true);
    expect(r['reabierta']).toBe(0);
    expect(r['expAna3']).toEqual([false]);
    expect(r['comprobanteViejo']).toEqual([false, '8:00']);
    expect(r['down']).toMatch(/son evidencia/);
  }, 60000);
});

describe('[RH.15.11] los controladores nuevos arrancan (design:paramtypes, por #414)', () => {
  it('Nest les inyecta el servicio de firma digital', async () => {
    const { HrAttendanceFirmaDigitalController } = await import('./attendance-firma-digital.controller');
    const { HrAttendanceFirmaPublicaController } = await import('./attendance-firma-publica.controller');
    const { HrAttendanceFirmaDigitalService } = await import('./attendance-firma-digital.service');
    expect(Reflect.getMetadata('design:paramtypes', HrAttendanceFirmaDigitalController)).toEqual([HrAttendanceFirmaDigitalService]);
    expect(Reflect.getMetadata('design:paramtypes', HrAttendanceFirmaPublicaController)).toEqual([HrAttendanceFirmaDigitalService]);
  });
});
