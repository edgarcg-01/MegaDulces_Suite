import type { PriceChangeRow } from '@megadulces/contracts';
import { PriceChangeNoticesService } from './price-change-notices.service';

/**
 * `[ETQ-AVISOS.1–3]` El generador de avisos y el envío de Compras, con dobles (sin base de datos).
 *
 * Lo que se prueba es la DECISIÓN —a quién se avisa, qué se declara y qué no se afirma—, que es lo
 * que se puede romper sin que nada cambie de aspecto. La tabla hace cumplir lo suyo con CHECK
 * (`productos >= 1`, cuadre, autoría) y eso lo prueba la propia migración, con prueba negativa.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const ACTOR = '11111111-1111-1111-1111-111111111111';
const FECHA = '2026-10-08';

const fila = (sku: string, unidad: string, antes: number, ahora: number, hora: string | null = '10:00:00'): PriceChangeRow => ({
  sku, name: `P ${sku}`, unidad, precio_anterior: antes, precio_nuevo: ahora,
  delta: Math.round((ahora - antes) * 100) / 100, es_baja: ahora === 0, hora,
});

interface Mundo {
  plazas: { sucursal: string; nombre: string | null; ultimo_dia: string }[];
  filas: Record<string, PriceChangeRow[]>;
  destinatarios: Record<string, number>;
  yaMando?: boolean;
  falla?: string[];
}

function armar(m: Mundo) {
  const llamadas: { sql: string; params: unknown[] }[] = [];
  const inserts: unknown[][] = [];
  const trx = {
    raw: vi.fn(async (sql: string, params: unknown[] = []) => {
      llamadas.push({ sql, params });
      if (/INSERT INTO commercial\.price_change_notices/.test(sql)) {
        inserts.push(params);
        return { rows: [{ nuevo: true, id: `n-${inserts.length}` }] };
      }
      if (/FROM identity\.users u/.test(sql)) {
        return { rows: Object.entries(m.destinatarios).map(([plaza, n]) => ({ plaza, n })) };
      }
      if (/FROM commercial\.price_change_notices\s+WHERE tenant_id/.test(sql)) {
        return { rows: m.yaMando ? [{ '?column?': 1 }] : [] };
      }
      if (/current_tenant_id/.test(sql)) return { rows: [{ t: T }] };
      return { rows: [] }; // SAVEPOINT / ROLLBACK / RELEASE
    }),
  };
  const labels = {
    branchesIn: vi.fn(async () => m.plazas),
    filasDelDia: vi.fn(async (_t: unknown, plaza: string) => {
      if (m.falla?.includes(plaza)) throw new Error('boom');
      return m.filas[plaza] ?? [];
    }),
  };
  const tk = { run: vi.fn(async (a: unknown, b?: unknown) => (typeof a === 'function' ? a(trx) : (b as (t: unknown) => unknown)(trx))) };
  const cron: Record<string, unknown>[] = [];
  const knexFn: any = vi.fn((tabla: string) => {
    if (tabla === 'public.tenants') return { where: () => ({ select: async () => [{ id: T }] }) };
    const q: any = {
      insert: (o: Record<string, unknown>) => { cron.push(o); return q; },
      onConflict: () => q,
      merge: async () => undefined,
    };
    return q;
  });
  knexFn.fn = { now: () => 'now()' };
  const svc = new PriceChangeNoticesService(knexFn, tk as any, labels as any);
  return { svc, trx, labels, inserts, llamadas, cron };
}

describe('PriceChangeNoticesService · el generador', () => {
  const mundo = (): Mundo => ({
    plazas: [
      { sucursal: '00', nombre: 'CEDIS', ultimo_dia: FECHA },
      { sucursal: '01', nombre: 'PH', ultimo_dia: FECHA },
      { sucursal: '02', nombre: 'Piedad', ultimo_dia: FECHA },
      { sucursal: '03', nombre: '8 Esq', ultimo_dia: '2026-10-05' }, // la bitácora no llega a FECHA
    ],
    filas: {
      '01': [fila('91059', 'CJA', 100, 120), fila('91059', '500', 5, 4), fila('77', 'PAQ', 10, 0)],
      '02': [],
    },
    destinatarios: { '01': 3 },
  });

  it('⭐ cuenta por PRODUCTO con la misma regla de la pantalla, y escribe una fila por plaza con cambios', async () => {
    const { svc, inserts } = armar(mundo());
    const r = await svc.generarParaTenant(T, 'manana', FECHA);
    // 91059 son dos presentaciones de UN producto (sube: la caja cambió 20%); 77 quedó sin precio
    expect(inserts).toHaveLength(1);
    const [tenant, plaza, fecha, corte, productos, suben, bajan, sinPrecio] = inserts[0];
    expect([tenant, plaza, fecha, corte]).toEqual([T, '01', FECHA, 'manana']);
    expect([productos, suben, bajan, sinPrecio]).toEqual([2, 1, 0, 1]);
    expect(r.creados).toBe(1);
  });

  it('⛔ la plaza 00 (CEDIS, sin anaquel al público) no recibe aviso', async () => {
    const { svc, labels } = armar(mundo());
    await svc.generarParaTenant(T, 'manana', FECHA);
    const consultadas = (labels.filasDelDia.mock.calls as unknown[][]).map((c) => c[1]);
    expect(consultadas).not.toContain('00');
  });

  it('D4: un día sin cambios NO genera aviso', async () => {
    const { svc, inserts } = armar(mundo());
    const r = await svc.generarParaTenant(T, 'manana', FECHA);
    expect(inserts.map((i) => i[1])).not.toContain('02');
    expect(r.sin_cambios).toBe(1);
  });

  it('D4: lo que se movió y terminó el día en su mismo precio tampoco avisa', async () => {
    const m = mundo();
    m.filas['02'] = [fila('9', 'PAQ', 10, 12, '09:00:00'), fila('9', 'PAQ', 12, 10, '10:00:00')];
    const { svc, inserts } = armar(m);
    await svc.generarParaTenant(T, 'manana', FECHA);
    expect(inserts.map((i) => i[1])).toEqual(['01']);
  });

  it('⭐ SIN DATO no es cero: si la bitácora de la plaza no llega a ese día no se avisa y se DECLARA', async () => {
    const { svc, inserts } = armar(mundo());
    const r = await svc.generarParaTenant(T, 'manana', FECHA);
    expect(r.sin_dato).toEqual(['03']);
    expect(inserts.map((i) => i[1])).not.toContain('03');
    expect(r.sin_cambios).toBe(1); // sólo la 02: la 03 NO se cuenta como «sin cambios»
  });

  it('D5: una plaza con aviso y NADIE con tienda asignada se declara, pero el aviso se escribe igual', async () => {
    const m = mundo();
    m.destinatarios = {}; // la 01 no tiene a nadie con warehouse_code
    const { svc, inserts } = armar(m);
    const r = await svc.generarParaTenant(T, 'manana', FECHA);
    expect(r.sin_destinatarios).toEqual(['01']);
    expect(inserts).toHaveLength(1);
  });

  it('una plaza que falla no tira a las demás (y se rebobina su savepoint)', async () => {
    const m = mundo();
    m.filas['02'] = [fila('5', 'PAQ', 1, 2)];
    m.falla = ['01'];
    const { svc, inserts, llamadas } = armar(m);
    const r = await svc.generarParaTenant(T, 'manana', FECHA);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toContain('01');
    expect(inserts.map((i) => i[1])).toEqual(['02']);
    expect(llamadas.some((c) => /ROLLBACK TO SAVEPOINT/.test(c.sql))).toBe(true);
  });

  it('el corte de la mañana resume AYER y el de la tarde HOY', () => {
    expect(PriceChangeNoticesService.fechaDelCorte('manana')).not.toBe(PriceChangeNoticesService.fechaDelCorte('tarde'));
    const dia = (s: string) => Date.parse(`${s}T00:00:00Z`);
    expect(dia(PriceChangeNoticesService.fechaDelCorte('tarde')) - dia(PriceChangeNoticesService.fechaDelCorte('manana'))).toBe(86_400_000);
  });
});

describe('PriceChangeNoticesService · el latido (ADR-053: mide entrega, no intención)', () => {
  const sinFuente = (): Mundo => ({
    plazas: [{ sucursal: '01', nombre: 'PH', ultimo_dia: '2026-10-01' }, { sucursal: '02', nombre: 'P', ultimo_dia: '2026-10-01' }],
    filas: {}, destinatarios: {},
  });

  it('⭐ NINGUNA plaza con dato de ese día = ERROR (la ingesta de la bitácora está caída), no un «0 cambios» verde', async () => {
    const { svc, cron } = armar(sinFuente());
    await svc.generarTodos('manana', FECHA);
    expect(cron[0].status).toBe('error');
    expect(String(cron[0].error)).toContain('NINGUNA plaza');
    expect(cron[0].job_key).toBe('price_change_notices');
  });

  it('un día tranquilo en plazas CON dato es ok: no avisar es lo normal', async () => {
    const m: Mundo = { plazas: [{ sucursal: '01', nombre: 'PH', ultimo_dia: FECHA }], filas: { '01': [] }, destinatarios: {} };
    const { svc, cron } = armar(m);
    await svc.generarTodos('manana', FECHA);
    expect(cron[0].status).toBe('ok');
  });

  it('cero plazas con bitácora también es falla, no éxito silencioso', async () => {
    const { svc, cron } = armar({ plazas: [], filas: {}, destinatarios: {} });
    await svc.generarTodos('tarde', FECHA);
    expect(cron[0].status).toBe('error');
  });

  it('el SIN DATO viaja en la nota del latido, con las plazas', async () => {
    const m = sinFuente();
    m.plazas.push({ sucursal: '03', nombre: 'X', ultimo_dia: FECHA });
    const { svc, cron } = armar(m);
    await svc.generarTodos('manana', FECHA);
    expect(String(cron[0].note)).toContain('SIN DATO: 01,02');
  });
});

describe('PriceChangeNoticesService · Compras comparte', () => {
  const mundo = (): Mundo => ({
    plazas: [
      { sucursal: '01', nombre: 'PH', ultimo_dia: FECHA },
      { sucursal: '02', nombre: 'Piedad', ultimo_dia: FECHA },
      { sucursal: '03', nombre: '8 Esq', ultimo_dia: '2026-10-01' },
    ],
    filas: { '01': [fila('1', 'PAQ', 10, 12)], '02': [] },
    destinatarios: { '01': 2 },
  });
  const estado = (r: { plaza: string; estado: string }[], p: string) => r.find((x) => x.plaza === p)?.estado;

  it('⭐ cada plaza devuelve SU estado con el motivo', async () => {
    const { svc, inserts } = armar(mundo());
    const r = await svc.share({ plazas: ['01', '02', '03', '99', '00'], fecha: FECHA, nota: ' Ojo con las galletas ' }, ACTOR, null);
    expect(estado(r, '01')).toBe('enviado');
    expect(estado(r, '02')).toBe('sin_cambios');
    expect(estado(r, '03')).toBe('sin_dato');
    expect(estado(r, '99')).toBe('plaza_invalida'); // no existe
    expect(estado(r, '00')).toBe('plaza_invalida'); // CEDIS no recibe
    expect(inserts).toHaveLength(1);
    // la nota se recorta y viaja; el autor es quien mandó
    const p = inserts[0];
    expect(p[p.length - 2]).toBe('Ojo con las galletas');
    expect(p[p.length - 1]).toBe(ACTOR);
    expect(r.find((x) => x.plaza === '01')!.destinatarios).toBe(2);
  });

  it('⛔ quien sólo ve ciertas plazas no puede avisarle a otras (y no se confirma que existen)', async () => {
    const { svc, inserts } = armar(mundo());
    const r = await svc.share({ plazas: ['01', '02'], fecha: FECHA }, ACTOR, ['02']);
    expect(estado(r, '01')).toBe('plaza_invalida');
    expect(inserts).toHaveLength(0);
  });

  it('el reenvío accidental (misma persona, plaza y día) se frena y se dice', async () => {
    const m = mundo();
    m.yaMando = true;
    const { svc, inserts } = armar(m);
    const r = await svc.share({ plazas: ['01'], fecha: FECHA }, ACTOR, null);
    expect(estado(r, '01')).toBe('repetido');
    expect(inserts).toHaveLength(0);
  });

  it('validaciones: sin plazas, demasiadas, fecha futura, fecha vieja, nota larga, formato', async () => {
    const { svc } = armar(mundo());
    await expect(svc.share({ plazas: [] }, ACTOR, null)).rejects.toThrow(/al menos una/i);
    await expect(svc.share({ plazas: Array.from({ length: 21 }, (_, i) => String(i).padStart(2, '0')) }, ACTOR, null)).rejects.toThrow(/20/);
    await expect(svc.share({ plazas: ['01'], fecha: '2999-01-01' }, ACTOR, null)).rejects.toThrow(/todavía no llega/i);
    await expect(svc.share({ plazas: ['01'], fecha: '2020-01-01' }, ACTOR, null)).rejects.toThrow(/últimos/i);
    await expect(svc.share({ plazas: ['01'], fecha: 'ayer' }, ACTOR, null)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(svc.share({ plazas: ['01'], fecha: FECHA, nota: 'x'.repeat(501) }, ACTOR, null)).rejects.toThrow(/500/);
  });

  it('recipients() declara cuántas personas ven cada plaza y hasta qué día llega su bitácora', async () => {
    const m = mundo();
    m.plazas.unshift({ sucursal: '00', nombre: 'CEDIS', ultimo_dia: FECHA });
    const { svc } = armar(m);
    const r = await svc.recipients();
    expect(r.map((x) => x.plaza)).toEqual(['01', '02', '03']);
    expect(r.find((x) => x.plaza === '01')!.destinatarios).toBe(2);
    expect(r.find((x) => x.plaza === '02')!.destinatarios).toBe(0);
    expect(r.find((x) => x.plaza === '03')!.ultimo_dia).toBe('2026-10-01');
  });
});

describe('PriceChangeNoticesService · la campana', () => {
  it('⛔ alcance vacío = no ve NADA, y ni siquiera consulta (no confundir con «sin recorte»)', async () => {
    const { svc, trx } = armar({ plazas: [], filas: {}, destinatarios: {} });
    expect(await svc.list([])).toEqual([]);
    expect(trx.raw).not.toHaveBeenCalled();
  });

  it('alcance null = sin recorte: la consulta recibe null y no filtra por plaza', async () => {
    const { svc, llamadas } = armar({ plazas: [], filas: {}, destinatarios: {} });
    await svc.list(null);
    const q = llamadas.find((c) => /FROM commercial\.price_change_notices n/.test(c.sql))!;
    expect(q.params.slice(1)).toEqual([null, null]);
  });

  it('una fecha `since` inválida se ignora en vez de romper la campana', async () => {
    const { svc, llamadas } = armar({ plazas: [], filas: {}, destinatarios: {} });
    await svc.list(['01'], 'no-es-fecha');
    const q = llamadas.find((c) => /FROM commercial\.price_change_notices n/.test(c.sql))!;
    expect(q.params[0]).toBeNull();
  });
});
