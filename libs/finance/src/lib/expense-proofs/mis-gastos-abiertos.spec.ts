import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESTADOS_ABIERTOS, TOPE_ABIERTOS, unirAbiertosYCerrados } from './mis-gastos-abiertos';

/**
 * `[GX.65]` — Candado de **«un vale abierto nunca se queda fuera de Mis gastos por el limit»**.
 *
 * Antes, `list()` cortaba en los últimos 200 por fecha de creación: un vale devuelto o con la
 * factura pendiente, más viejo que eso, desaparecía de la lista sin aviso.
 */
const dia = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString();
const fila = (id: string, d: number, status: string) => ({ id, created_at: dia(d), status });

describe('[GX.65] unirAbiertosYCerrados', () => {
  it('el abierto más viejo que todo el recorte sigue en la lista', () => {
    // 1 abierto de hace un año + 200 cerrados recientes = el caso que antes se perdía.
    const abierto = fila('viejo', 0, 'rechazada');
    const cerrados = Array.from({ length: 200 }, (_, i) => fila(`c${i}`, 300 + i, 'validada'));
    const { filas, abiertos_truncados } = unirAbiertosYCerrados([abierto], cerrados);
    expect(filas.map((f) => f.id)).toContain('viejo');
    expect(filas).toHaveLength(201);
    expect(abiertos_truncados).toBe(false);
  });

  /**
   * ⛔ Prueba NEGATIVA: reproduce el corte viejo (ordenar todo y quedarse con 200) y demuestra
   * que ahí el abierto SÍ se perdía. Si esta prueba deja de fallar al revés —o sea, si el
   * corte viejo también lo conservara— el candado de arriba no estaría probando nada.
   */
  it('con el corte viejo (top 200 por fecha) el abierto se perdía', () => {
    const todas = [fila('viejo', 0, 'rechazada'),
      ...Array.from({ length: 200 }, (_, i) => fila(`c${i}`, 300 + i, 'validada'))];
    const corteViejo = [...todas]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 200);
    expect(corteViejo.map((f) => f.id)).not.toContain('viejo');
  });

  it('ordena lo más reciente primero, mezclando abiertos y cerrados', () => {
    const { filas } = unirAbiertosYCerrados(
      [fila('a1', 5, 'recibida'), fila('a2', 1, 'aprobada')],
      [fila('c1', 3, 'validada'), fila('c2', 9, 'validada')],
    );
    expect(filas.map((f) => f.id)).toEqual(['c2', 'a1', 'c1', 'a2']);
  });

  it('no duplica una fila que llegue por los dos lados', () => {
    const { filas } = unirAbiertosYCerrados([fila('x', 2, 'recibida')], [fila('x', 2, 'recibida')]);
    expect(filas).toHaveLength(1);
  });

  it('si los abiertos rebasan el tope, se DECLARA en vez de cortar callado', () => {
    const abiertos = Array.from({ length: 4 }, (_, i) => fila(`a${i}`, i, 'recibida'));
    const r = unirAbiertosYCerrados(abiertos, [], 3);
    expect(r.abiertos_truncados).toBe(true);
    expect(r.filas).toHaveLength(3);
  });

  it('justo en el tope no se declara corte', () => {
    const abiertos = Array.from({ length: 3 }, (_, i) => fila(`a${i}`, i, 'recibida'));
    expect(unirAbiertosYCerrados(abiertos, [], 3).abiertos_truncados).toBe(false);
  });

  it('una fecha ilegible no rompe el orden ni tira la fila', () => {
    const { filas } = unirAbiertosYCerrados([{ id: 'raro', created_at: 'no-es-fecha' }], [fila('ok', 1, 'validada')]);
    expect(filas.map((f) => f.id).sort()).toEqual(['ok', 'raro']);
  });
});

describe('[GX.65] qué cuenta como abierto', () => {
  it('validada es el único estado cerrado', () => {
    expect([...ESTADOS_ABIERTOS].sort()).toEqual(['aprobada', 'rechazada', 'recibida', 'revision']);
    expect(ESTADOS_ABIERTOS as readonly string[]).not.toContain('validada');
  });

  it('el tope duro existe y es holgado', () => {
    expect(TOPE_ABIERTOS).toBeGreaterThanOrEqual(500);
  });
});

/** Que el servicio de verdad USE la regla en el camino de «lo mío», y sólo ahí. */
describe('[GX.65] list() aplica la regla', () => {
  const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.service.ts'), 'utf8'));
  const CONTROLLER = soloCodigo(readFileSync(join(__dirname, 'expense-proofs.controller.ts'), 'utf8'));

  it('en «lo mío» pide los abiertos sin el limit y une con los cerrados', () => {
    expect(SERVICIO).toContain('if (q.mine && !q.status)');
    expect(SERVICIO).toContain("whereIn('status', [...ESTADOS_ABIERTOS]).limit(TOPE_ABIERTOS + 1)");
    expect(SERVICIO).toContain("whereNotIn('status', [...ESTADOS_ABIERTOS])");
    expect(SERVICIO).toContain('unirAbiertosYCerrados(');
  });

  it('el filtro de persona se sigue aplicando ANTES de partir en abiertos y cerrados', () => {
    // Los dos clones salen de `b`, que ya pasó por `filtros(b)` (donde vive el `mine`).
    const i = SERVICIO.indexOf('filtros(b);');
    const j = SERVICIO.indexOf('b.clone().whereIn(');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });

  it('la respuesta declara el corte, también cuando no hay actor', () => {
    expect(SERVICIO).toContain('abiertos_truncados,');
    expect(CONTROLLER).toContain('abiertos_truncados: false');
  });
});
