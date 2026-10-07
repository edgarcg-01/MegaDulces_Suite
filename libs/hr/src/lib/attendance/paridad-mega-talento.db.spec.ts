/**
 * `[RH.1.8]` (preparación) PARIDAD contra Mega Talento con DATOS REALES.
 *
 * Lo que valida: que la carga única + la lógica trasladada dan, persona por persona y día por día,
 * el MISMO número que Mega Talento le muestra hoy a RH. Las pruebas de la lógica usan casos
 * armados; ésta usa las 214 mil checadas reales y el resultado del código real de Mega Talento.
 *
 *   1. `mt-exportar-asistencia.ts` corre el código de Mega Talento sobre su base (sólo lectura)
 *      y guarda el resultado de cada (sitio, semana, planta/promotoras) en un JSON.
 *   2. Esta prueba, en UNA transacción que se deshace: aplica las migraciones de la fase, corre la
 *      carga única con la misma hora de corte del JSON, simula `[RH.1.4]` (una persona de la Suite
 *      por ficha de Mega Talento, con su estado y si es promotora) y calcula con la Suite.
 *   3. Compara campo por campo. Lo que difiera se reporta con su persona, su día y su campo.
 *
 *   HR_DB_TEST_URL=… MT_DATABASE_URL=… MT_PARIDAD_JSON=… [PARIDAD_REPORTE=…] JWT_SECRET=… \
 *     npx vitest run -c libs/hr/vitest.config.ts paridad
 *
 * Sin las tres variables se declara NO MEDIDO (se salta). La base de Mega Talento sólo se lee.
 *
 * ── Medido el 2026-10-07 (foto de Mega Talento de las 09:57 MX) ──
 *   · Asistencia: 72 cálculos (12 sitios × 3 semanas de nómina × planta/promotoras), 1,464
 *     personas, 5,464 días → 0 diferencias, nadie de más ni de menos. La primera corrida se puso
 *     ROJA (37 personas en un solo lado) y destapó dos cosas: el padrón debe ser lo LIGADO a una
 *     persona (no todo código enrolado) y una lápida de depurado no cuenta si la ficha está activa.
 *   · Alertas (se informan, no se exigen: dependen de cuándo corrió el corredor de MT): 4,296 de
 *     MT en la ventana, 3 diferencias, las 3 explicadas — dos lecturas que llegaron después de su
 *     última corrida; un día de CEDIS que MT nunca revisó al cerrar (su huella no llevaba el día:
 *     corregido aquí); y la cuenta "Admin" depurada de PH, cuyas checadas aquí se ignoran.
 */
import fs from 'fs';
import path from 'path';
import knexLib, { Knex } from 'knex';

const URL = process.env['HR_DB_TEST_URL'];
const MT = process.env['MT_DATABASE_URL'];
const JSON_MT = process.env['MT_PARIDAD_JSON'];
const REPORTE = process.env['PARIDAD_REPORTE'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ROLLBACK = new Error('rollback-intencional');

const listo = !!(URL && MT && JSON_MT && !/prod|railway|\.222:5434/i.test(URL));
if (!listo) console.warn('[RH.1.8] NO MEDIDO: la paridad contra Mega Talento necesita HR_DB_TEST_URL, MT_DATABASE_URL y MT_PARIDAD_JSON.');

/** Lo que se compara de cada persona. El nombre y el departamento no: dependen del mapeo de RH. */
const CAMPOS = [
  'tipo', 'horario', 'turnos', 'horarioConfirmado', 'costumbre', 'desfaseMin', 'salida', 'dispersionMin',
  'diasLaborales', 'diasUsados', 'diasEnRango', 'silencioDias', 'pctUnaMarca', 'retardoRealMin', 'atrasoBrutoMin',
  'absorbidoMin', 'diasConRetardo', 'diasEvaluados', 'faltas', 'faltasJustificadas', 'diasNoMedibles', 'diasAtipicos',
  'horasTrabajadas', 'minutosTrabajados', 'diasConIncidencia', 'desayunoExcesoMin', 'diasDesayunoExcedido',
  'pctATiempo', 'usable', 'bloqueadoPor', 'esPracticante', 'minutosEsperados', 'registrado', 'activo',
] as const;

type Persona = Record<string, unknown> & {
  codigo: string;
  marcas: Array<{ codigo: string }>;
  semanas: Array<{ dias: Array<Record<string, unknown> & { fecha: string }> }>;
};

const igual = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const dias = (p: Persona): Map<string, string> => new Map(p.semanas.flatMap((s) => s.dias).map((d) =>
  [d.fecha, JSON.stringify([d['estado'], d['retardoRealMin'], d['atrasoMin'], d['netasMin'] ?? null, d['referencia'] ?? null, d['justificacion'] ?? null])]));

(listo ? describe : describe.skip)('paridad contra Mega Talento (datos reales)', () => {
  it('la Suite da el mismo número que Mega Talento, persona por persona', async () => {
    const { HrAttendanceReportService } = await import('./attendance-report.service');
    const { HrAttendanceAgentService } = await import('./attendance-agent.service');
    const carga = require(path.resolve(__dirname, '../../../../../database/scripts/rh/carga-unica-mega-talento.js'));
    const mtJson = JSON.parse(fs.readFileSync(String(JSON_MT), 'utf8')) as {
      generado: string;
      resultados: Array<{ sitio: string; desde: string; hasta: string; soloPromotoras: boolean; datos: { personas: Persona[] } }>;
    };

    const knex: Knex = knexLib({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
    const mt = await carga.conectarMegaTalento(MT);
    const informe = { generado: mtJson.generado, cuadre: {} as unknown, calculos: 0, personasComparadas: 0, diasComparados: 0,
      soloEnMt: [] as string[], soloEnSuite: [] as string[], diferencias: [] as Array<Record<string, unknown>>,
      alertas: { sitios: 0, comparadas: 0, soloEnMt: [] as string[], soloEnSuite: [] as string[] } };
    try {
      await knex.transaction(async (trx) => {
        for (const m of carga.MIGRACIONES_FASE) await require(path.resolve(__dirname, '../../../../../database/migrations-newdb', `${m}.js`)).up(trx);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
        informe.cuadre = await carga.cargarMegaTalento(trx, mt, { recibidasHasta: mtJson.generado });

        // ── Simulación de [RH.1.4]: una persona por ficha, con el estado y la promotoría de allá ──
        const { rows: fichas } = await mt.query(`
          SELECT sucursal_id AS sitio, btrim(codigo_checador) AS codigo, coalesce(nombre_completo, nombre) AS nombre, activo,
                 (es_promotora OR coalesce(departamento, '') ~* 'promotor') AS promotora
            FROM empleados WHERE btrim(coalesce(codigo_checador, '')) <> ''`);
        const rol = (await trx('identity.users').first('role_name'))?.role_name ?? 'superadmin';
        await trx('identity.departments').insert({ tenant_id: TENANT, code: 'mt_promotoria_simulada', name: 'Promotoría (simulada para la paridad)' });
        const sello = Date.now();
        const usuarios = await trx('identity.users').insert(fichas.map((f: { sitio: string; codigo: string; nombre: string; activo: boolean; promotora: boolean }, i: number) => ({
          tenant_id: TENANT, username: `paridad_${sello}_${i}`, password_hash: 'x', role_name: rol, nombre: f.nombre || f.codigo,
          status: f.activo ? 'active' : 'terminated', department_code: f.promotora ? 'mt_promotoria_simulada' : null,
        }))).returning('id');
        const ligas = fichas.map((f: { sitio: string; codigo: string }, i: number) => ({ sitio: f.sitio, codigo: f.codigo, user_id: (usuarios[i] as { id: string }).id ?? usuarios[i] }));
        await trx.raw(`
          UPDATE hr.device_enrollments e SET user_id = s.user_id
            FROM hr.attendance_devices d, jsonb_to_recordset(?::jsonb) AS s(sitio text, codigo text, user_id uuid)
           WHERE d.id = e.device_id AND d.site_code = s.sitio AND COALESCE(e.person_code, e.device_user_id) = s.codigo`,
          [JSON.stringify(ligas)]);

        // ── La Suite calcula lo mismo y se compara ──────────────────────────────────────
        const ctx = { get: () => ({ tenantId: TENANT }), requireTenantId: () => TENANT };
        const report = new HrAttendanceReportService({ run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) } as never, ctx as never);
        for (const r of mtJson.resultados) {
          const suite = await report.calcular(trx, r.sitio, r.desde, r.hasta, r.soloPromotoras);
          informe.calculos++;
          const etiqueta = `${r.sitio} ${r.desde}..${r.hasta}${r.soloPromotoras ? ' (promotoras)' : ''}`;
          const deMt = new Map(r.datos.personas.map((p) => [p.codigo, p]));
          const deSuite = new Map((suite.personas as unknown as Persona[]).map((p) => [p.codigo, p]));
          for (const c of deMt.keys()) if (!deSuite.has(c)) informe.soloEnMt.push(`${etiqueta} #${c}`);
          for (const c of deSuite.keys()) if (!deMt.has(c)) informe.soloEnSuite.push(`${etiqueta} #${c}`);
          for (const [c, a] of deMt) {
            const b = deSuite.get(c);
            if (!b) continue;
            informe.personasComparadas++;
            for (const k of CAMPOS) if (!igual(a[k], b[k])) informe.diferencias.push({ calculo: etiqueta, codigo: c, campo: k, mt: a[k], suite: b[k] });
            const ma = a.marcas.map((m) => m.codigo).sort(), mb = b.marcas.map((m) => m.codigo).sort();
            if (!igual(ma, mb)) informe.diferencias.push({ calculo: etiqueta, codigo: c, campo: 'marcas', mt: ma, suite: mb });
            const da = dias(a), db = dias(b);
            for (const f of new Set([...da.keys(), ...db.keys()])) {
              informe.diasComparados++;
              if (da.get(f) !== db.get(f)) informe.diferencias.push({ calculo: etiqueta, codigo: c, campo: `dia ${f}`, mt: da.get(f) ?? null, suite: db.get(f) ?? null });
            }
          }
        }
        // ── El agente de alertas: misma ventana que la última corrida del corredor de MT ──
        // Las alertas de Mega Talento ya están cargadas: si el agente de la Suite detecta lo mismo,
        // no crea ni borra nada. Lo que cree es alerta que MT no tiene; lo que borre, una que sí.
        const agent = new HrAttendanceAgentService({ run: async (_t: string, cb: (t: Knex.Transaction) => Promise<unknown>) => cb(trx) } as never, ctx as never);
        const { rows: corridas } = await mt.query(`SELECT sucursal_id, desde, hasta FROM agente_corridas WHERE error IS NULL ORDER BY 1`);
        const claves = async (sitio: string, desde: string, hasta: string): Promise<Set<string>> => new Set(
          (await trx('hr.attendance_alerts').where({ site_code: sitio, status: 'sugerida_ia' }).whereBetween('work_date', [desde, hasta])
            .select('person_code', 'rule', trx.raw(`to_char(work_date, 'YYYY-MM-DD') AS f`)))
            .map((a: { person_code: string; rule: string; f: string }) => `${sitio}|${a.person_code}|${a.f}|${a.rule}`));
        for (const c of corridas as Array<{ sucursal_id: string; desde: string; hasta: string }>) {
          const antes = await claves(c.sucursal_id, c.desde, c.hasta);
          await agent.analizar({ siteCode: c.sucursal_id, desde: c.desde, hasta: c.hasta });
          const despues = await claves(c.sucursal_id, c.desde, c.hasta);
          informe.alertas.sitios++;
          informe.alertas.comparadas += antes.size;
          for (const k of antes) if (!despues.has(k)) informe.alertas.soloEnMt.push(k);
          for (const k of despues) if (!antes.has(k)) informe.alertas.soloEnSuite.push(k);
        }
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await mt.end();
      await knex.destroy();
    }

    if (REPORTE) fs.writeFileSync(REPORTE, JSON.stringify(informe, null, 1));
    console.log(`[paridad] ${informe.calculos} cálculos · ${informe.personasComparadas} personas · ${informe.diasComparados} días · ` +
      `${informe.diferencias.length} diferencias · sólo en MT ${informe.soloEnMt.length} · sólo en la Suite ${informe.soloEnSuite.length}`);
    console.log(`[paridad] alertas: ${informe.alertas.sitios} sitios · ${informe.alertas.comparadas} de MT · ` +
      `sólo en MT ${informe.alertas.soloEnMt.length} · sólo en la Suite ${informe.alertas.soloEnSuite.length}`);
    expect(informe.calculos).toBe(mtJson.resultados.length);
    expect(informe.personasComparadas).toBeGreaterThan(0);
    expect({ soloEnMt: informe.soloEnMt, soloEnSuite: informe.soloEnSuite, diferencias: informe.diferencias.slice(0, 25) })
      .toEqual({ soloEnMt: [], soloEnSuite: [], diferencias: [] });
  }, 900000);
});
