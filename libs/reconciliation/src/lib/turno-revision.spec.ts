import { armarCajasDelDia } from './arqueo-cajas';
import type { ArqueoRevisionTurno } from '@megadulces/contracts/http/arqueo-cajas';
import {
  claveTurno, diasEntre, estadoDe, historialDe, motivosDeRevision, puedeCerrar, resumenCajeras, resumenDias, totalesRetiros,
  sumarDias, turnosCerrados, turnosPorRevisar,
} from './turno-revision';

/**
 * [SM.55] Qué turnos le tocan a la encargada. Los montos son turnos reales de prod
 * (noviembre 2026), con los nombres fuera.
 */
const base = { abierto: false, retiros_estado: 'cuadra' as const, cierres: [{}] as never[], esperado: 17823.96 };

describe('motivosDeRevision', () => {
  it('⭐ Kepler registró retiros y la Suite no tiene ninguno, ni el cajón → dos motivos', () => {
    // Padre Hidalgo, 2-nov, caja 1: $91,500 en sangrías y nadie abrió el arqueo.
    expect(motivosDeRevision({ abierto: false, retiros_estado: 'faltan', cierres: [], esperado: 102216.45 }))
      .toEqual(['retiros_sin_contar', 'cajon_sin_contar']);
  });

  it('retiros contados de más (otra caja, otro concepto) se revisan', () => {
    expect(motivosDeRevision({ ...base, retiros_estado: 'de_mas' })).toEqual(['retiros_de_mas']);
  });

  it('cajón sin contar con retiros que cuadran → solo el cajón', () => {
    expect(motivosDeRevision({ ...base, cierres: [] })).toEqual(['cajon_sin_contar']);
  });

  it('NEGATIVA: un turno que cuadra y tiene su cajón NO le toca a nadie', () => {
    expect(motivosDeRevision(base)).toEqual([]);
    expect(motivosDeRevision({ ...base, retiros_estado: 'sin_retiros' })).toEqual([]);
  });

  it('NEGATIVA: un turno ABIERTO no se revisa aunque le falte todo (la cajera todavía puede contar)', () => {
    expect(motivosDeRevision({ abierto: true, retiros_estado: 'faltan', cierres: [], esperado: 50000 })).toEqual([]);
  });

  it('NEGATIVA: sin esperado (null o 0) el cajón sin contar no se le pide a nadie', () => {
    expect(motivosDeRevision({ ...base, cierres: [], esperado: null })).toEqual([]);
    expect(motivosDeRevision({ ...base, cierres: [], esperado: 0 })).toEqual([]);
  });
});

describe('turnosPorRevisar (con la liga real de Sucursales y sus cajas)', () => {
  // Morelia Abastos, 15-nov: los retiros de la caja 3 se capturaron en la caja 2.
  const turno = (caja: string, folio: string, cajero: string, retirado: number) => ({
    warehouse_code: '08', warehouse_name: 'Morelia Abastos', caja, folio, cajero_code: cajero, cajero_nombre: null,
    hora_apertura: '07:30:00', hora_cierre: '15:00:00', abierto: false,
    efectivo_esperado: retirado + 100, efectivo_contado: retirado + 100, efectivo_diff: 0,
    arqueo_billetes: 100, arqueo_monedas: 0, efectivo_retirado: retirado, cash_limit: 10000,
  });
  const conteo = (id: string, tipo: string, caja: string, folio: string, total: number) => ({
    id, tipo, secuencia: 1, warehouse_code: '08', caja, cash_cut_folio: folio, total, hora: '10:00:00',
    captured_at: '2026-11-15T16:00:00.000Z', denominations: {},
  });
  const dia = armarCajasDelDia('2026-11-15',
    [turno('2', '43', 'C02', 97840), turno('3', '48', 'C03', 156750), turno('4', '56', 'C04', 83080)],
    [
      conteo('a', 'retiro', '2', '43', 237990), conteo('b', 'cierre', '2', '43', 100),
      conteo('c', 'retiro', '3', '48', 16600), conteo('d', 'cierre', '3', '48', 100),
      conteo('e', 'retiro', '4', '56', 83080), conteo('f', 'cierre', '4', '56', 100),
    ]);
  const r = turnosPorRevisar(dia);

  it('salen la caja 2 (de más) y la 3 (sin contar); la 4 cuadra y no sale', () => {
    expect(r.map((t) => [t.caja, t.motivos])).toEqual([
      ['2', ['retiros_de_mas']],
      ['3', ['retiros_sin_contar']],
    ]);
  });

  it('cada turno trae su llave, sus montos y la diferencia con signo', () => {
    const c3 = r.find((t) => t.caja === '3')!;
    expect(c3.clave).toBe('turno_sin_verificar:08:3:2026-11-15:48');
    expect(c3.retirado_kepler).toBe(156750);
    expect(c3.retiros_contados).toBe(16600);
    expect(c3.retiros_diferencia).toBe(-140150);
    expect(c3.cajon_contado).toBe(true);
  });
});

describe('fechas', () => {
  it('diasEntre incluye los dos extremos y cruza meses', () => {
    expect(diasEntre('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(diasEntre('2026-11-02', '2026-11-01')).toEqual([]);
  });
  it('sumarDias resta y suma sin brincarse el cambio de horario', () => {
    expect(sumarDias('2026-11-01', -1)).toBe('2026-10-31');
    expect(sumarDias('2026-03-31', 1)).toBe('2026-04-01');
  });
  it('claveTurno es estable', () => {
    expect(claveTurno('01', '1', '2026-11-02', '127')).toBe('turno_sin_verificar:01:1:2026-11-02:127');
  });
});

// ── Seguimiento hasta cerrar, control por día y por cajera ────────────────────

const fila = (causa: string, min: number, nota: string | null = 'nota de prueba', por = 'ENC') =>
  ({ causa, nota, created_by: por, nombre: null, created_at: new Date(Date.UTC(2026, 10, 21, 16, min)).toISOString() });

describe('historialDe / estadoDe / puedeCerrar', () => {
  it('ordena por hora y tipa cada fila: causa, acción y cierre; la firma del día no es del turno', () => {
    const h = historialDe([fila('cerrado', 3), fila('no_capturado', 1), fila('accion:hablo_cajera', 2), fila('dia_revisado', 4)]);
    expect(h.map((e) => [e.tipo, e.valor])).toEqual([['causa', 'no_capturado'], ['accion', 'hablo_cajera'], ['cerrado', null]]);
  });

  it('con la MISMA hora (acción y cierre en una sola transacción) el orden es causa → acción → cierre', () => {
    const h = historialDe([fila('cerrado', 2), fila('accion:escalo', 2), fila('no_capturado', 2)]);
    expect(h.map((e) => e.tipo)).toEqual(['causa', 'accion', 'cerrado']);
  });

  it('⭐ el estado avanza: por justificar → en seguimiento → cerrado', () => {
    const m = ['retiros_sin_contar'] as const;
    expect(estadoDe([...m], [])).toBe('por_justificar');
    expect(estadoDe([...m], historialDe([fila('otra_caja', 1)]))).toBe('en_seguimiento');
    expect(estadoDe([...m], historialDe([fila('otra_caja', 1), fila('accion:corrigio_suite', 2)]))).toBe('en_seguimiento');
    expect(estadoDe([...m], historialDe([fila('otra_caja', 1), fila('accion:corrigio_suite', 2), fila('cerrado', 3)]))).toBe('cerrado');
  });

  it('un turno que ya cuadra no se pide (la cajera contó tarde), salvo que ya esté cerrado', () => {
    expect(estadoDe([], historialDe([fila('no_capturado', 1)]))).toBe('cuadra');
    expect(estadoDe([], historialDe([fila('no_capturado', 1), fila('cerrado', 2)]))).toBe('cerrado');
  });

  it('⭐ el cajón sin contar NO se justifica (2026-11-24): un turno con solo eso queda «cuadra» en retiros', () => {
    expect(estadoDe(['cajon_sin_contar'], [])).toBe('cuadra');
    expect(estadoDe(['retiros_de_mas', 'cajon_sin_contar'], [])).toBe('por_justificar');
  });

  it('NEGATIVA: no se cierra sin causa, ni sin acción, ni dos veces', () => {
    expect(puedeCerrar([], true)).toBe(false);
    expect(puedeCerrar(historialDe([fila('no_capturado', 1)]), false)).toBe(false);
    expect(puedeCerrar(historialDe([fila('no_capturado', 1)]), true)).toBe(true);
    expect(puedeCerrar(historialDe([fila('no_capturado', 1), fila('accion:escalo', 2), fila('cerrado', 3)]), true)).toBe(false);
  });
});

describe('resumenDias y resumenCajeras', () => {
  const t = (fecha: string, wh: string, cajero: string, estado: ArqueoRevisionTurno['estado'], motivos: ArqueoRevisionTurno['motivos'], causa?: string): ArqueoRevisionTurno => ({
    clave: `${fecha}${wh}${cajero}${Math.random()}`, fecha, warehouse_code: wh, warehouse_nombre: null, caja: '1', folio: '1',
    cajero_code: cajero, cajero_nombre: null, hora_apertura: null, hora_cierre: null, motivos, retirado_kepler: 0,
    retiros_contados: 0, retiros_diferencia: 0, cajon_contado: true, estado, historial: [],
    justificacion: causa ? { causa, nota: 'x', por: null, por_nombre: null, at: '2026-11-21T00:00:00Z' } : null,
  });
  const turnos = [
    t('2026-11-20', '07', 'C01', 'por_justificar', ['retiros_sin_contar', 'cajon_sin_contar']),
    t('2026-11-20', '07', 'C01', 'en_seguimiento', ['retiros_sin_contar'], 'no_capturado'),
    t('2026-11-20', '07', 'C02', 'cuadra', []),
    t('2026-11-19', '07', 'C02', 'cerrado', ['retiros_de_mas'], 'otra_caja'),
  ];

  it('un renglón por día y sucursal, el más reciente arriba, con la firma si la hay', () => {
    const firma = { por: 'ENC', por_nombre: null, at: '2026-11-20T23:00:00Z', nota: null };
    const d = resumenDias(turnos, new Map([['dia_revisado:07:2026-11-19', firma]]));
    expect(d.map((x) => [x.fecha, x.turnos, x.cuadran, x.por_justificar, x.en_seguimiento, x.cerrados])).toEqual([
      ['2026-11-20', 3, 1, 1, 1, 0],
      ['2026-11-19', 1, 0, 0, 0, 1],
    ]);
    expect(d[0].revisado).toBeNull();
    expect(d[1].revisado).toEqual(firma);
  });

  it('por cajera: cuenta cada error y cada causa; quien solo cuadra no sale', () => {
    const c = resumenCajeras(turnos);
    expect(c.map((x) => x.cajero_code)).toEqual(['C01', 'C02']);
    expect(c[0]).toMatchObject({ turnos: 2, con_problema: 2, por_justificar: 1, causas: { no_capturado: 1 } });
    expect(c[0].motivos).toEqual({ retiros_sin_contar: 2, retiros_de_mas: 0, cajon_sin_contar: 1 });
    expect(c[1]).toMatchObject({ turnos: 2, con_problema: 1, causas: { otra_caja: 1 } });
    expect(resumenCajeras([t('2026-11-20', '07', 'C09', 'cuadra', [])])).toEqual([]);
  });

  it('turnosCerrados incluye los que cuadran, sin los abiertos', () => {
    expect(turnosCerrados({ fecha: '2026-11-20', umbral: 50, sucursales: [] })).toEqual([]);
  });
});

describe('emparejar Suite ↔ Kepler: totales por cajera y de la sucursal', () => {
  const t = (cajero: string, kepler: number, suite: number, motivos: ArqueoRevisionTurno['motivos'], estado: ArqueoRevisionTurno['estado']): ArqueoRevisionTurno => ({
    clave: `${cajero}:${kepler}:${suite}:${Math.random()}`, fecha: '2026-11-20', warehouse_code: '07', warehouse_nombre: null, caja: '1', folio: '1',
    cajero_code: cajero, cajero_nombre: null, hora_apertura: null, hora_cierre: null, motivos, retirado_kepler: kepler,
    retiros_contados: suite, retiros_diferencia: Math.round((suite - kepler) * 100) / 100, cajon_contado: true, estado, historial: [], justificacion: null,
  });
  // El ejemplo de la maqueta: B tiene −5,000 y +2,000 → neta −3,000 pero 7,000 sin empatar.
  const turnos = [
    t('A', 25000, 0, ['retiros_sin_contar'], 'por_justificar'),
    t('A', 18000, 8000, ['retiros_sin_contar'], 'en_seguimiento'),
    t('A', 4000, 4000, [], 'cuadra'),
    t('B', 10000, 5000, ['retiros_sin_contar'], 'por_justificar'),
    t('B', 6000, 8000, ['retiros_de_mas'], 'por_justificar'),
    t('C', 3000, 3000, ['cajon_sin_contar'], 'cuadra'),
  ];

  it('por cajera: Kepler, Suite, neta y sin signo de TODOS sus turnos; la de mayor descuadre primero', () => {
    const c = resumenCajeras(turnos);
    expect(c.map((x) => x.cajero_code)).toEqual(['A', 'B']);
    expect(c[0]).toMatchObject({ retirado_kepler: 47000, retiros_contados: 12000, retiros_diferencia: -35000, retiros_descuadre: 35000, turnos_descuadre: 2 });
    expect(c[1]).toMatchObject({ retirado_kepler: 16000, retiros_contados: 13000, retiros_diferencia: -3000, retiros_descuadre: 7000, turnos_descuadre: 2 });
  });

  it('NEGATIVA: la cajera que solo dejó el cajón sin contar NO sale en la lista (sus retiros empatan)', () => {
    expect(resumenCajeras(turnos).some((x) => x.cajero_code === 'C')).toBe(false);
  });

  it('los totales: la neta deja que un + compense un −; el descuadre sin signo no', () => {
    expect(totalesRetiros(turnos)).toEqual({
      retirado_kepler: 66000, retiros_contados: 28000, retiros_diferencia: -38000, retiros_descuadre: 42000,
      turnos_descuadre: 4, cajeras_descuadre: 2, por_justificar: 3,
    });
  });

  it('centavos: 0.1 + 0.2 no deja basura de punto flotante', () => {
    expect(totalesRetiros([t('A', 0.1, 0, ['retiros_sin_contar'], 'por_justificar'), t('A', 0.2, 0, ['retiros_sin_contar'], 'por_justificar')]).retirado_kepler).toBe(0.3);
  });
});
