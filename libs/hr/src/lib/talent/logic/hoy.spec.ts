/**
 * `[RH.17.1]` La regla de «Hoy» (pura, corre en CI sin base): en qué pendiente cae cada candidato, el orden y la cuota.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CUOTA_DIA, DIAS_APARTADO, DIAS_LIGA_VIGENTE, NOTA_LIGA_APTITUDES, VENTANA_NUEVOS_H, armarHoy, pendienteDe, type FilaHoy,
} from './hoy';

const AHORA = new Date('2026-11-19T15:00:00Z');
const hace = (h: number) => new Date(AHORA.getTime() - h * 3_600_000).toISOString();
let n = 0;
const fila = (o: Partial<FilaHoy>): FilaHoy => ({
  id: `c${++n}`, stage: 'filtro_inicial', created_at: hace(2), last_activity_at: null, contactado: false, faltantes: 4,
  tiene_eval: false, liga_aptitudes_vigente: false, ...o,
});

describe('[RH.17.1] pendienteDe', () => {
  it('nuevo: en Filtro, sin contacto de RH y con ≤ 48 h de alta', () => {
    expect(pendienteDe(fila({ created_at: hace(1) }), AHORA)).toBe('nuevos');
    expect(pendienteDe(fila({ created_at: hace(VENTANA_NUEVOS_H) }), AHORA)).toBe('nuevos');
    expect(pendienteDe(fila({ stage: null, created_at: hace(3) }), AHORA)).toBe('nuevos');   // stage vacío = Filtro
  });

  it('un nuevo que ya tuvo contacto de RH deja de ser nuevo (y si rebasa su meta, es seguimiento)', () => {
    expect(pendienteDe(fila({ created_at: hace(30), last_activity_at: hace(30), contactado: true }), AHORA)).toBe('seguimiento');
    expect(pendienteDe(fila({ created_at: hace(5), last_activity_at: hace(5), contactado: true }), AHORA)).toBeNull();
  });

  it('pasadas las 48 h sin contacto ya no es «nuevo»: es seguimiento (su meta en Filtro es 24 h)', () => {
    expect(pendienteDe(fila({ created_at: hace(VENTANA_NUEVOS_H + 1) }), AHORA)).toBe('seguimiento');
  });

  it('expediente completo en Conductual gana a seguimiento', () => {
    expect(pendienteDe(fila({ stage: 'entrevista_rh', faltantes: 0, last_activity_at: hace(200) }), AHORA)).toBe('expediente');
    expect(pendienteDe(fila({ stage: 'entrevista_rh', faltantes: 1, last_activity_at: hace(200) }), AHORA)).toBe('seguimiento');
    expect(pendienteDe(fila({ stage: 'entrevista_rh', faltantes: 1, last_activity_at: hace(10) }), AHORA)).toBeNull();
  });

  it('jefe: en Aptitudes sin evaluación y sin liga vigente', () => {
    expect(pendienteDe(fila({ stage: 'aptitudes', last_activity_at: hace(5) }), AHORA)).toBe('jefe');
    expect(pendienteDe(fila({ stage: 'aptitudes', last_activity_at: hace(5), liga_aptitudes_vigente: true }), AHORA)).toBeNull();
    expect(pendienteDe(fila({ stage: 'aptitudes', last_activity_at: hace(100), tiene_eval: true }), AHORA)).toBe('seguimiento');
  });

  it('una etapa vieja de Mega Talento cae en su etapa vigente («entrevista_jefe» = Aptitudes)', () => {
    expect(pendienteDe(fila({ stage: 'entrevista_jefe', last_activity_at: hace(5) }), AHORA)).toBe('jefe');
  });

  it('más de 30 días sin movimiento: apartado, no pendiente', () => {
    expect(pendienteDe(fila({ stage: 'aptitudes', created_at: hace(2000), last_activity_at: hace(DIAS_APARTADO * 24 + 1) }), AHORA)).toBe('apartado');
    expect(pendienteDe(fila({ stage: 'aptitudes', created_at: hace(2000), last_activity_at: hace(DIAS_APARTADO * 24 - 1) }), AHORA)).toBe('jefe');
  });

  it('contratado y rechazado no son pendientes, aunque estén viejos', () => {
    expect(pendienteDe(fila({ stage: 'contratado', last_activity_at: hace(5000) }), AHORA)).toBeNull();
    expect(pendienteDe(fila({ stage: 'rechazado', last_activity_at: hace(5) }), AHORA)).toBeNull();
  });
});

describe('[RH.17.1] armarHoy', () => {
  it('corta a la cuota pero conserva el total', () => {
    const muchos = Array.from({ length: CUOTA_DIA + 7 }, (_, i) => fila({ stage: 'entrevista_rh', faltantes: 2, last_activity_at: hace(60 + i) }));
    const r = armarHoy(muchos, AHORA);
    const s = r.pendientes.find((p) => p.id === 'seguimiento')!;
    expect(s.total).toBe(CUOTA_DIA + 7);
    expect(s.filas).toHaveLength(CUOTA_DIA);
  });

  it('seguimiento: el de actividad más reciente primero; nuevos: el que más espera primero', () => {
    const a = fila({ stage: 'entrevista_rh', last_activity_at: hace(300) });
    const b = fila({ stage: 'entrevista_rh', last_activity_at: hace(60) });
    const viejo = fila({ created_at: hace(40) });
    const reciente = fila({ created_at: hace(1) });
    const r = armarHoy([a, b, reciente, viejo], AHORA);
    expect(r.pendientes.find((p) => p.id === 'seguimiento')!.filas.map((f) => f.id)).toEqual([b.id, a.id]);
    expect(r.pendientes.find((p) => p.id === 'nuevos')!.filas.map((f) => f.id)).toEqual([viejo.id, reciente.id]);
  });

  it('cada candidato cae en un solo pendiente y los apartados se cuentan aparte', () => {
    const filas = [fila({}), fila({ stage: 'entrevista_rh', faltantes: 0 }), fila({ stage: 'aptitudes', last_activity_at: hace(5) }),
      fila({ stage: 'aptitudes', last_activity_at: hace(DIAS_APARTADO * 24 + 5) }), fila({ stage: 'contratado' })];
    const r = armarHoy(filas, AHORA);
    expect(r.pendientes.map((p) => [p.id, p.total])).toEqual([['nuevos', 1], ['seguimiento', 0], ['expediente', 1], ['jefe', 1]]);
    expect(r.apartados).toBe(1);
  });

  it('lista vacía: cuatro pendientes en cero, sin tronar', () => {
    const r = armarHoy([], AHORA);
    expect(r.pendientes.every((p) => p.total === 0 && p.filas.length === 0)).toBe(true);
    expect(r.apartados).toBe(0);
  });
});

describe('[RH.17.1] los textos y plazos que la regla toma de otros módulos siguen siendo los mismos', () => {
  const ligas = readFileSync(join(__dirname, '..', 'talent-links.service.ts'), 'utf8');
  it('la nota que deja la liga de aptitudes empieza como la regla espera', () => {
    // talent-links.service arma: `Se generó la liga ${… 'de la evaluación de aptitudes (para el jefe que entrevista)' …}`
    expect(ligas).toContain("'de la evaluación de aptitudes (para el jefe que entrevista)'");
    expect(NOTA_LIGA_APTITUDES).toBe('Se generó la liga de la evaluación de aptitudes');
  });
  it('la vigencia de la liga es la misma', () => {
    expect(ligas).toMatch(new RegExp(`VIGENCIA_DIAS = ${DIAS_LIGA_VIGENTE};`));
  });
});
