import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FILTRO_HISTORIAL_VACIO, pasaFiltroHistorial, type FiltroHistorial } from '@megadulces/contracts';
import { facetasDelMes, type GrupoDelMes } from './calendario-gastos';
import { ExpenseProofsController } from './expense-proofs.controller';
import { ExpenseProofsService } from './expense-proofs.service';

/**
 * `[GX.78]` Candado de los **filtros del Historial**.
 *
 * Tres cosas:
 *  · las opciones del filtro cuentan bien (y cada una sin su propio filtro);
 *  · el endpoint no convierte un filtro roto en «sin filtro», ni el filtro en llave del alcance;
 *  · la consulta del calendario pone las MISMAS tres igualdades que la pantalla usa en la lista
 *    del día — si no, la casilla dice 3 y la lista muestra 5.
 */

const G = (status: string, sucursal: string, created_by: string, n: number, monto: number): GrupoDelMes =>
  ({ status, sucursal, created_by, n, monto });

const GRUPOS: GrupoDelMes[] = [
  G('recibida', '00', 'capturista_a', 10, 1000),
  G('recibida', '08', 'capturista_b', 4, 400.4),
  G('validada', '00', 'capturista_a', 20, 2000),
  G('validada', '06', 'capturista_c', 5, 500),
  G('rechazada', '08', 'capturista_b', 1, 100),
];

const f = (o: Partial<FiltroHistorial>): FiltroHistorial => ({ ...FILTRO_HISTORIAL_VACIO, ...o });

describe('[GX.78] facetasDelMes', () => {
  it('sin filtro cuenta todo, en el orden del trámite y por clave de sucursal', () => {
    const r = facetasDelMes(GRUPOS, FILTRO_HISTORIAL_VACIO, true);
    expect(r.estados).toEqual([
      { valor: 'recibida', n: 14, monto: 1400.4 },
      { valor: 'validada', n: 25, monto: 2500 },
      { valor: 'rechazada', n: 1, monto: 100 },
    ]);
    expect(r.sucursales.map((s) => [s.valor, s.n])).toEqual([['00', 30], ['06', 5], ['08', 5]]);
    // Personas: por cuántos levantaron.
    expect(r.personas?.map((p) => [p.valor, p.n])).toEqual([['capturista_a', 30], ['capturista_b', 5], ['capturista_c', 5]]);
  });

  /**
   * ⭐ Cada lista se cuenta SIN su propio filtro: con la 08 elegida, las sucursales siguen todas
   * (para poder cambiar de una a otra) y los estados son los de la 08.
   */
  it('⭐ con una sucursal elegida, los estados son los de esa sucursal y las sucursales siguen todas', () => {
    const r = facetasDelMes(GRUPOS, f({ sucursal: '08' }), true);
    expect(r.estados.map((e) => [e.valor, e.n])).toEqual([['recibida', 4], ['rechazada', 1]]);
    expect(r.sucursales.map((s) => s.valor)).toEqual(['00', '06', '08']);
    expect(r.personas?.map((p) => p.valor)).toEqual(['capturista_b']);
  });

  it('con estados elegidos, las sucursales y las personas se cuentan sobre esos estados', () => {
    const r = facetasDelMes(GRUPOS, f({ estados: ['recibida'] }), true);
    expect(r.sucursales.map((s) => [s.valor, s.n])).toEqual([['00', 10], ['08', 4]]);
    // Los estados siguen todos: se puede sumar otro sin quitar el primero.
    expect(r.estados.map((e) => e.valor)).toEqual(['recibida', 'validada', 'rechazada']);
  });

  it('en «Míos» no se ofrece filtrar por persona', () => {
    expect(facetasDelMes(GRUPOS, FILTRO_HISTORIAL_VACIO, false).personas).toBeNull();
  });

  it('un estado que la regla no conoce va al final, no se esconde', () => {
    const r = facetasDelMes([...GRUPOS, G('archivada', '00', 'capturista_a', 2, 1)], FILTRO_HISTORIAL_VACIO, true);
    expect(r.estados.at(-1)?.valor).toBe('archivada');
  });

  /** La suma de una lista cuadra con el universo que filtra: no se pierde ni se duplica nada. */
  it('la suma de cada lista es el total del universo que cuenta', () => {
    const r = facetasDelMes(GRUPOS, f({ sucursal: '00' }), true);
    const totalSuc00 = GRUPOS.filter((g) => pasaFiltroHistorial(g, f({ sucursal: '00' }))).reduce((a, g) => a + g.n, 0);
    expect(r.estados.reduce((a, e) => a + e.n, 0)).toBe(totalSuc00);
    expect(r.personas?.reduce((a, p) => a + p.n, 0)).toBe(totalSuc00);
  });
});

describe('[GX.78] el endpoint del calendario y el filtro', () => {
  const montar = () => {
    const llamadas: unknown[][] = [];
    const svc = { calendarioMes: (...a: unknown[]) => { llamadas.push(a); return Promise.resolve({}); } } as unknown as ExpenseProofsService;
    return { ctrl: new ExpenseProofsController(svc), llamadas };
  };
  const ADMIN = { user: { role_name: 'superadmin', permissions: {} } };
  const MIO = { user: { role_name: 'tesoreria', username: 'capturista_a', permissions: { FINANCE_EXPENSES_CAPTURAR: true } } };

  it('pasa el filtro leído al servicio, en «Todos»', async () => {
    const { ctrl, llamadas } = montar();
    await ctrl.calendario('2026-10', 'todos', ADMIN, 'validada,recibida', '08', 'capturista_b');
    expect(llamadas[0]).toEqual(['2026-10', { filtro: { estados: ['recibida', 'validada'], sucursal: '08', persona: 'capturista_b' } }]);
  });

  it('en «Míos» el filtro va DENTRO del alcance, nunca en su lugar', async () => {
    const { ctrl, llamadas } = montar();
    await ctrl.calendario('2026-10', 'mios', MIO, 'recibida', undefined, 'capturista_b');
    expect(llamadas[0]).toEqual(['2026-10', { mine: 'capturista_a', filtro: { estados: ['recibida'], sucursal: null, persona: 'capturista_b' } }]);
  });

  it('sin parámetros de filtro, el filtro va vacío (los llamadores viejos no cambian)', async () => {
    const { ctrl, llamadas } = montar();
    await ctrl.calendario('2026-10', 'todos', ADMIN);
    expect(llamadas[0]).toEqual(['2026-10', { filtro: FILTRO_HISTORIAL_VACIO }]);
  });

  /** ⛔ Un filtro roto NO cae a «sin filtro»: devolvería el mes entero mientras la pantalla cree que filtró. */
  it('⛔ un estado desconocido es 400 y el servicio no se llama', () => {
    const { ctrl, llamadas } = montar();
    expect(() => ctrl.calendario('2026-10', 'todos', ADMIN, 'firmada')).toThrow(BadRequestException);
    expect(llamadas).toHaveLength(0);
  });

  /** ⛔ Filtrar no abre el alcance: sin permiso, «Todos» sigue siendo 403 aunque venga filtrado. */
  it('⛔ con filtro, «Todos» sin permiso sigue siendo 403', () => {
    const { ctrl, llamadas } = montar();
    expect(() => ctrl.calendario('2026-10', 'todos', MIO, 'recibida', '00', 'capturista_a')).toThrow(ForbiddenException);
    expect(llamadas).toHaveLength(0);
  });
});

/**
 * Un knex de mentira que anota cada llamada de cada consulta. No ejecuta SQL: comprueba QUÉ
 * condiciones se ponen y en qué consulta.
 */
function knexDeMentira(respuestas: { dias: unknown[]; grupos: unknown[] }) {
  const consultas: { metodo: string; args: unknown[] }[][] = [];
  const trx = ((/* tabla */) => {
    const anotadas: { metodo: string; args: unknown[] }[] = [];
    consultas.push(anotadas);
    const qb: unknown = new Proxy({}, {
      get(_t, metodo: string | symbol) {
        if (metodo === 'then') {
          const filas = anotadas.some((a) => a.metodo === 'groupBy') ? respuestas.grupos : respuestas.dias;
          return (ok: (v: unknown) => unknown, mal: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, mal);
        }
        return (...args: unknown[]) => { anotadas.push({ metodo: String(metodo), args }); return qb; };
      },
    });
    return qb;
  }) as unknown as ((t: string) => unknown) & { raw: (s: string, b?: unknown) => unknown };
  trx.raw = (sql: string, b?: unknown) => ({ sql, b });
  return { trx, consultas };
}

function servicioCon(trx: unknown): ExpenseProofsService {
  const svc = Object.create(ExpenseProofsService.prototype) as ExpenseProofsService;
  Object.assign(svc as object, {
    tenantCtx: { requireTenantId: () => 'tenant-de-prueba' },
    tk: { run: (fn: (t: unknown) => unknown) => fn(trx) },
  });
  return svc;
}

describe('[GX.78] la consulta del calendario', () => {
  const RESP = {
    dias: [{ dia: '2026-10-08', n: 4, monto: '400.40' }],
    grupos: GRUPOS.map((g) => ({ ...g, n: String(g.n), monto: String(g.monto) })),
  };
  const condiciones = (q: { metodo: string; args: unknown[] }[]) =>
    q.filter((a) => a.metodo === 'whereIn' || (a.metodo === 'where' && typeof a.args[0] === 'string'))
      .map((a) => [a.metodo, ...a.args]);

  it('⭐ el filtro va a los DÍAS (mismas tres columnas que la lista del día), no a las opciones', async () => {
    const { trx, consultas } = knexDeMentira(RESP);
    const r = await servicioCon(trx).calendarioMes('2026-10', { filtro: f({ estados: ['recibida'], sucursal: '08', persona: 'capturista_b' }) });
    const [dias, grupos] = consultas;
    expect(condiciones(dias)).toEqual([
      ['whereIn', 'status', ['recibida']],
      ['where', 'sucursal', '08'],
      ['where', 'created_by', 'capturista_b'],
    ]);
    // Las opciones salen del mes SIN filtrar: si no, elegir un estado borraría los demás de la lista.
    expect(condiciones(grupos)).toEqual([]);
    expect(r.total).toEqual({ n: 4, monto: 400.4 });
    expect(r.total_sin_filtro).toEqual({ n: 40, monto: 4000.4 });
    expect(r.filtro).toEqual(f({ estados: ['recibida'], sucursal: '08', persona: 'capturista_b' }));
    expect(r.facetas.estados.map((e) => [e.valor, e.n])).toEqual([['recibida', 4], ['rechazada', 1]]);
  });

  /** ⛔ Prueba negativa: sin filtro, la consulta de los días no se acota. */
  it('⛔ sin filtro, los días no llevan ninguna de las tres condiciones', async () => {
    const { trx, consultas } = knexDeMentira(RESP);
    await servicioCon(trx).calendarioMes('2026-10', {});
    expect(condiciones(consultas[0])).toEqual([]);
  });

  it('en «Míos» las DOS consultas van acotadas a la persona, y no se ofrecen personas', async () => {
    const { trx, consultas } = knexDeMentira(RESP);
    const r = await servicioCon(trx).calendarioMes('2026-10', { mine: 'capturista_a', filtro: f({ estados: ['validada'] }) });
    for (const q of consultas) expect(q.some((a) => a.metodo === 'where' && typeof a.args[0] === 'function')).toBe(true);
    expect(r.facetas.personas).toBeNull();
    expect(r.alcance).toBe('mios');
  });
});
