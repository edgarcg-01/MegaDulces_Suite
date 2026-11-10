// Sin `import ... from 'vitest'`: la config usa `globals: true` (con el import el spec no carga: compuerta spec-vivo).
import { validarDecisionTemporada, validarFechasTemporada, type FechasTemporada, type TemporadaResumen } from '@megadulces/contracts';
import { decisionAplica, momentoDe, ordenarTemporadas } from './temporadas.repo';
import { CACHE_ABIERTA_MS, CACHE_CERRADA_MS, llaveCandidatos, vigente } from './temporadas.service';

/** `[PQ.94]` Las reglas puras de Temporadas. El SQL se prueba contra base real en `test-newdb-pq94-temporadas-api.js`. */

const f = (year: number, sale_from: string, sale_to: string, hoy: string): FechasTemporada => ({
  id: `${year}-${sale_from}`, year, sale_from, sale_to, buy_by: null, cutoff: null, clearance_from: null,
  status: 'propuesta', proposal_source: 'x', confirmed_by_name: null, confirmed_at: null, momento: momentoDe(hoy, sale_from, sale_to),
});
const t = (key: string, fechas: FechasTemporada[]): TemporadaResumen => ({
  id: key, key, name: key, date_rule: 'fija', fechas, productos: { confirmados: 0, descartados: 0 },
});

describe('momentoDe', () => {
  it('antes, dentro (incluye los dos bordes) y después de la ventana', () => {
    expect(momentoDe('2026-08-31', '2026-09-01', '2026-11-02')).toBe('por_iniciar');
    expect(momentoDe('2026-09-01', '2026-09-01', '2026-11-02')).toBe('en_venta');
    expect(momentoDe('2026-11-02', '2026-09-01', '2026-11-02')).toBe('en_venta');
    expect(momentoDe('2026-11-03', '2026-09-01', '2026-11-02')).toBe('terminada');
  });
});

describe('ordenarTemporadas (PQ.UI.T8: lo que sigue va primero)', () => {
  const hoy = '2026-11-10';
  it('en venta → por iniciar (la más cercana) → terminadas (la más reciente) → sin fechas', () => {
    const orden = ordenarTemporadas([
      t('san_valentin', [f(2026, '2026-01-05', '2026-02-14', hoy)]),
      t('sin_fechas', []),
      t('muertos', [f(2026, '2026-09-01', '2026-11-02', hoy), f(2025, '2025-09-01', '2025-11-02', hoy)]),
      t('reyes_2027', [f(2027, '2027-01-02', '2027-01-06', hoy)]),
      t('navidad', [f(2026, '2026-10-20', '2026-12-24', hoy)]),
      t('valentin_2027', [f(2027, '2027-01-05', '2027-02-14', hoy)]),
    ]).map((x) => x.key);
    expect(orden).toEqual(['navidad', 'reyes_2027', 'valentin_2027', 'muertos', 'san_valentin', 'sin_fechas']);
  });
});

describe('vigente (caché de candidatos)', () => {
  it('una ventana cerrada dura 6 h; una abierta, 10 min; sin nada guardado, no', () => {
    expect(vigente(undefined, 0)).toBe(false);
    expect(vigente({ cerrada: true, at: 0 }, CACHE_CERRADA_MS - 1)).toBe(true);
    expect(vigente({ cerrada: true, at: 0 }, CACHE_CERRADA_MS)).toBe(false);
    expect(vigente({ cerrada: false, at: 0 }, CACHE_ABIERTA_MS - 1)).toBe(true);
    expect(vigente({ cerrada: false, at: 0 }, CACHE_ABIERTA_MS)).toBe(false);
  });
});

describe('llaveCandidatos (2 réplicas: corregir fechas no puede dejar viva la ventana vieja)', () => {
  it('la llave cambia si cambian las fechas, y separa tenants y temporadas-año', () => {
    const base = { season_date_id: 'X', sale_from: '2026-09-01', sale_to: '2026-11-02' };
    expect(llaveCandidatos('T', base)).not.toBe(llaveCandidatos('T', { ...base, sale_from: '2026-08-25' }));
    expect(llaveCandidatos('T', base)).not.toBe(llaveCandidatos('T', { ...base, sale_to: '2026-11-03' }));
    expect(llaveCandidatos('T', base)).not.toBe(llaveCandidatos('U', base));
    expect(llaveCandidatos('T', base)).not.toBe(llaveCandidatos('T', { ...base, season_date_id: 'Y' }));
    expect(llaveCandidatos('T', base)).toBe(llaveCandidatos('T', { ...base }));
  });
});

describe('decisionAplica (lo de «sólo un año» no cuenta en otro año)', () => {
  it('descartar y «anual» valen todos los años; «sólo un año», únicamente el suyo', () => {
    expect(decisionAplica({ decision: 'descartada', recurrence: null, only_year: null }, 2026)).toBe(true);
    expect(decisionAplica({ decision: 'confirmada', recurrence: 'anual', only_year: null }, 2026)).toBe(true);
    expect(decisionAplica({ decision: 'confirmada', recurrence: 'solo_un_anio', only_year: 2026 }, 2026)).toBe(true);
    expect(decisionAplica({ decision: 'confirmada', recurrence: 'solo_un_anio', only_year: 2025 }, 2026)).toBe(false);
  });
});

describe('validarDecisionTemporada (la misma regla que los CHECK)', () => {
  const ok = { sku: '22008', decision: 'confirmada' as const, recurrence: 'anual' as const, replenishment: 'compra_unica' as const, origin: 'propuesta_del_sistema' as const };
  it('acepta una confirmación completa y un descarte con motivo', () => {
    expect(validarDecisionTemporada(ok)).toBeNull();
    expect(validarDecisionTemporada({ sku: '22008', decision: 'descartada', reason: 'vende todo el año', origin: 'manual' })).toBeNull();
    expect(validarDecisionTemporada({ ...ok, recurrence: 'solo_un_anio', only_year: 2026 })).toBeNull();
  });
  it('rechaza, con el motivo en llano, cada forma de una decisión a medias', () => {
    expect(validarDecisionTemporada({ ...ok, replenishment: undefined })).toMatch(/compra única o se repone/);
    expect(validarDecisionTemporada({ ...ok, recurrence: undefined })).toMatch(/vuelve cada año/);
    expect(validarDecisionTemporada({ ...ok, recurrence: 'solo_un_anio' })).toMatch(/de cuál/);
    expect(validarDecisionTemporada({ ...ok, only_year: 2026 })).toMatch(/no lleva año/);
    expect(validarDecisionTemporada({ sku: '22008', decision: 'descartada', reason: '  ', origin: 'manual' })).toMatch(/por qué/);
    expect(validarDecisionTemporada({ ...ok, sku: ' 22008' })).toMatch(/clave/);
    expect(validarDecisionTemporada({ ...ok, origin: undefined })).toMatch(/propuesta o se agregó/);
    expect(validarDecisionTemporada(null)).not.toBeNull();
  });
});

describe('validarFechasTemporada (la misma regla que los CHECK)', () => {
  const base = { sale_from: '2026-10-20', sale_to: '2026-12-24' };
  it('acepta la ventana sola y con compra, corte y remate bien puestos', () => {
    expect(validarFechasTemporada(base)).toBeNull();
    expect(validarFechasTemporada({ ...base, buy_by: '2026-10-01', cutoff: '2026-12-05', clearance_from: '2026-12-26' })).toBeNull();
  });
  it('rechaza cada fecha fuera de su lugar', () => {
    expect(validarFechasTemporada({ sale_from: '2026-12-24', sale_to: '2026-10-20' })).toMatch(/antes de empezar/);
    expect(validarFechasTemporada({ ...base, buy_by: '2026-11-01' })).toMatch(/antes de que empiece/);
    expect(validarFechasTemporada({ ...base, cutoff: '2027-01-02' })).toMatch(/dentro de la venta/);
    expect(validarFechasTemporada({ ...base, clearance_from: '2026-12-24' })).toMatch(/después de que termina/);
    expect(validarFechasTemporada({ sale_from: '2026-13-40', sale_to: '2026-12-24' })).toMatch(/Faltan las fechas/);
    expect(validarFechasTemporada(null)).toMatch(/Faltan las fechas/);
  });
  it('una fecha que no existe (30 de febrero) no pasa: Postgres la rechazaría con 500', () => {
    expect(validarFechasTemporada({ sale_from: '2026-02-01', sale_to: '2026-02-30' })).toMatch(/Faltan las fechas/);
    expect(validarFechasTemporada({ sale_from: '2028-02-01', sale_to: '2028-02-29' })).toBeNull(); // 2028 es bisiesto
  });
  it('con el año de la temporada, la venta tiene que empezar en ese año (Reyes cruza a enero y vale)', () => {
    expect(validarFechasTemporada({ ...base, sale_from: '2027-10-20', sale_to: '2027-12-24' }, 2026)).toMatch(/tiene que empezar en 2026/);
    expect(validarFechasTemporada(base, 2026)).toBeNull();
    expect(validarFechasTemporada({ sale_from: '2026-12-26', sale_to: '2027-01-06' }, 2026)).toBeNull();
  });
});
