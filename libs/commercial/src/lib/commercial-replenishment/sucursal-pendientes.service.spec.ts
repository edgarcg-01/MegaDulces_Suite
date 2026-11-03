import { ConflictException, ForbiddenException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { SucursalPendientesService } from './sucursal-pendientes.service';
import * as Q from './sucursal-pendientes.sql';

/**
 * `[AB.45]`/`[AB.46]` La LÓGICA del servicio: qué ve la sucursal, `puede_abrir`, el alcance, lo no
 * medido, y atribuirse / soltar.
 * ⚠️ Con dobles: el SQL NO se ejerce aquí (un doble de knex no ejecuta SQL). Las consultas de colas se
 * ejercieron contra prod en sólo lectura (`database/scripts/ab45-pendientes-sucursal.js`); atribuir y
 * soltar contra una base real en `database/tests/test-newdb-sucursal-pendientes-atribuir.js`.
 */
const WH = '8eb1a11d-5953-47e4-9d6c-a884c9baf0c5';
const YO = '11111111-1111-4111-8111-111111111111';
const OTRA = '22222222-2222-4222-8222-222222222222';
const N_COLAS = Object.keys(Q).filter((k) => k.startsWith('SQL_')).length;

interface Opts { falla?: string; sinTabla?: boolean; vivo?: { user_id: string; nombre: string } | null; insertOk?: boolean }

function armar(opts: Opts = {}) {
  const corridas: string[] = [];
  const trx = Object.assign(
    (_t: string) => ({ where: () => ({ first: async () => ({ code: '01', kepler_code: '01' }) }) }),
    {
      raw: async (sql: string) => {
        if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql.trim())) return { rows: [] };
        corridas.push(sql);
        if (sql.includes('to_regclass')) return { rows: [{ ok: !opts.sinTabla }] };
        if (sql.includes('INSERT INTO commercial.sucursal_pendiente_responsables')) {
          return { rows: opts.insertOk ? [{ user_id: YO, nombre: 'Yo', created_at: '2026-11-03T10:00:00Z' }] : [] };
        }
        if (sql.includes('FROM commercial.sucursal_pendiente_responsables') && sql.includes(':clave')) {
          return { rows: opts.vivo ? [{ cola: 'olas', clave: 'k1', created_at: '2026-11-03T09:00:00Z', ...opts.vivo }] : [] };
        }
        if (sql.includes('FROM commercial.sucursal_pendiente_responsables')) {
          return { rows: [{ cola: 'olas', clave: 'k1', user_id: OTRA, nombre: 'Ana', created_at: '2026-11-03T09:00:00Z' }] };
        }
        if (sql.includes('UPDATE commercial.sucursal_pendiente_responsables')) return { rows: [] };
        if (opts.falla && sql.includes(opts.falla)) throw new Error('boom');
        return { rows: [{ clave: 'k1', folio: 'F1', detalle: 'd', monto: '10.5', total: 3, dias: 4, sucs: '{01}' }] };
      },
    },
  );
  const tk = { run: async <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const tenantCtx = { requireTenantId: () => 't1' };
  const motor = { almacenes: async () => [{ id: WH, code: '01', name: 'Padre Hidalgo' }] };
  const pedidos = {
    conLlaveDeSucursal: async (ws: Array<{ id: string; name: string }>) => ws.map((w) => ({ id: w.id, name: w.name, sucursal: '01' })),
    viene: async () => ({ almacen: { id: WH, code: '01', name: 'Padre Hidalgo' }, pedidos_medidos: true, ventana_en_camino_dias: 7,
      documentos: [{ tipo: 'embarque', origen: '00', serie: 2, folio: 'E1', estado: 'EMBARCADO', fecha: '2026-11-01', dias: 2, renglones: 3, monto: 5, se_resta: true }] }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new SucursalPendientesService(motor as any, pedidos as any, tk as any, tenantCtx as any);
  return { svc, corridas };
}

const cuerpo = { warehouse_id: WH, cola: 'olas', clave: 'k1' };

describe('[AB.46] Pendientes de sucursal — lectura', () => {
  it('un almacén fuera del alcance se rechaza (no se confía en el query)', async () => {
    const { svc } = armar();
    await expect(svc.pendientes('otro-id', { sub: YO, permissions: {} })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('toda la sucursal ve TODAS las colas, aunque su puesto no abra ninguna pantalla', async () => {
    const { svc, corridas } = armar();
    const r = await svc.pendientes(WH, { sub: YO, permissions: {} });
    expect(corridas.filter((s) => s.includes('AS dias'))).toHaveLength(N_COLAS);
    expect(r.colas.map((c) => c.id)).toContain('traspasos-sin-recibir');
    expect(r.colas.every((c) => c.puede_abrir === false)).toBe(true);
  });

  it('puede_abrir sigue la llave de la pantalla dueña (cotizaciones pide las DOS)', async () => {
    const { svc } = armar();
    const r = await svc.pendientes(WH, { sub: YO, permissions: { STORE_ARQUEO_CAPTURAR: true, COMMERCIAL_QUOTES_VER: true } });
    const de = (id: string) => r.colas.find((c) => c.id === id)!;
    expect(de('turnos-sin-arqueo').puede_abrir).toBe(true);
    expect(de('arqueos-por-validar').puede_abrir).toBe(false);
    expect(de('cotizaciones').puede_abrir).toBe(false);
    const r2 = await svc.pendientes(WH, { sub: YO, permissions: { COMMERCIAL_QUOTES_VER: true, COMMERCIAL_TELEVENTA_OPERATE: true } });
    expect(r2.colas.find((c) => c.id === 'cotizaciones')!.puede_abrir).toBe(true);
  });

  it('el responsable aparece en SU fila, y soy_yo dice si es quien consulta', async () => {
    const { svc } = armar();
    const r = await svc.pendientes(WH, { sub: YO, permissions: {} });
    const fila = r.colas.find((c) => c.id === 'olas')!.filas[0];
    expect(fila.clave).toBe('k1');
    expect(fila.responsable).toMatchObject({ user_id: OTRA, nombre: 'Ana', soy_yo: false });
    expect(r.colas.find((c) => c.id === 'conteos')!.filas[0].responsable).toBeNull();
  });

  it('sin la tabla de responsables (migración sin aplicar) la pantalla se lee igual', async () => {
    const { svc } = armar({ sinTabla: true });
    const r = await svc.pendientes(WH, { sub: YO, permissions: {} });
    expect(r.colas.find((c) => c.id === 'olas')!.filas[0].responsable).toBeNull();
  });

  it('una consulta que falla se declara no_medido; las demás siguen', async () => {
    const { svc } = armar({ falla: 'kdpv_folio_caja' });
    const r = await svc.pendientes(WH, { sub: YO, permissions: {} });
    expect(r.colas.find((c) => c.id === 'turnos-sin-arqueo')!.estado).toBe('no_medido');
    expect(r.colas.find((c) => c.id === 'arqueos-por-validar')!.estado).toBe('ok');
  });
});

describe('[AB.46] atribuirse y soltar', () => {
  it('atribuirse un pendiente libre: queda a mi nombre', async () => {
    const { svc } = armar({ insertOk: true });
    await expect(svc.atribuir(cuerpo, { sub: YO })).resolves.toMatchObject({ user_id: YO, soy_yo: true });
  });

  it('si ya lo tiene otra persona: conflicto con su nombre', async () => {
    const { svc } = armar({ insertOk: false, vivo: { user_id: OTRA, nombre: 'Ana' } });
    await expect(svc.atribuir(cuerpo, { sub: YO })).rejects.toThrow(/Ana/);
    await expect(svc.atribuir(cuerpo, { sub: YO })).rejects.toBeInstanceOf(ConflictException);
  });

  it('atribuírmelo dos veces no falla (ya era mío)', async () => {
    const { svc } = armar({ insertOk: false, vivo: { user_id: YO, nombre: 'Yo' } });
    await expect(svc.atribuir(cuerpo, { sub: YO })).resolves.toMatchObject({ soy_yo: true });
  });

  it('una cola inventada o un almacén ajeno se rechazan', async () => {
    const { svc } = armar({ insertOk: true });
    await expect(svc.atribuir({ ...cuerpo, cola: 'inventada' }, { sub: YO })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.atribuir({ ...cuerpo, warehouse_id: OTRA }, { sub: YO })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('soltar: sólo quien lo tiene (o un administrador de plataforma)', async () => {
    const ajeno = armar({ vivo: { user_id: OTRA, nombre: 'Ana' } });
    await expect(ajeno.svc.soltar(cuerpo, { sub: YO })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ajeno.svc.soltar(cuerpo, { sub: YO, role_name: 'superadmin' })).resolves.toEqual({ ok: true });
    const mio = armar({ vivo: { user_id: YO, nombre: 'Yo' } });
    await expect(mio.svc.soltar(cuerpo, { sub: YO })).resolves.toEqual({ ok: true });
  });

  it('sin la tabla, atribuirse dice que falta la migración (no finge)', async () => {
    const { svc } = armar({ sinTabla: true });
    await expect(svc.atribuir(cuerpo, { sub: YO })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
