// Sin import de 'vitest': la config de libs usa globals (describe/it/expect); con el import el
// archivo no carga en el CI y reporta 0 pruebas sin ponerse rojo (check-spec-vivo, CXC.40).
import {
  banderasDeCierre,
  cierresDeVista,
  diasDelRango,
  estadoCelda,
  HISTORICO_DIAS_MAX,
  HistoricoCelda,
  rangoHistorico,
  sumarDias,
  totalDelDia,
} from './existencia-historico.contract';

const celda = (
  code: string,
  estado: HistoricoCelda['estado'],
  valor: number | null,
  extra: Partial<HistoricoCelda> = {},
): HistoricoCelda => ({
  warehouse_code: code,
  estado,
  motivo: null,
  valor_estandar: valor,
  productos_con_existencia: valor == null ? null : 1,
  productos_sin_valuar: 0,
  costo_reconstruido: false,
  productos_costo_posterior: 0,
  ...extra,
});

const HOY = '2026-11-06';
const base = { warehouse_code: '01', stock_source: null, hoy: HOY, foto_desde: '2026-09-24' };

describe('[EX.H1] rangoHistorico', () => {
  it('por defecto: los 30 días que terminan AYER (el cierre de hoy se toma a las 23:50), sin ajuste', () => {
    expect(rangoHistorico({}, HOY)).toEqual({ desde: '2026-10-07', hasta: '2026-11-05', ajustado: false, motivo: null });
  });
  it('hoy se puede pedir explícitamente', () => {
    expect(rangoHistorico({ desde: '2026-11-01', hasta: HOY }, HOY)).toMatchObject({ hasta: HOY, ajustado: false });
  });
  it('NEGATIVA: hasta en el futuro se recorta a hoy y LO DICE', () => {
    const r = rangoHistorico({ desde: '2026-11-01', hasta: '2026-12-31' }, HOY);
    expect(r).toMatchObject({ desde: '2026-11-01', hasta: HOY, ajustado: true });
    expect(r.motivo).toMatch(/futuro/);
  });
  it('NEGATIVA: un desde futuro con hasta pasado NO deja el rango en el futuro (se ordena y luego se recorta)', () => {
    const r = rangoHistorico({ desde: '2027-01-01', hasta: '2026-11-01' }, HOY);
    expect(r.hasta <= HOY).toBe(true);
    expect(r.desde).toBe('2026-11-01');
    expect(r.ajustado).toBe(true);
  });
  it('NEGATIVA: dos fechas futuras terminan en hoy, nunca desde > hasta', () => {
    const r = rangoHistorico({ desde: '2027-02-01', hasta: '2027-01-01' }, HOY);
    expect(r).toMatchObject({ desde: HOY, hasta: HOY, ajustado: true });
  });
  it('al revés se ordena y se declara', () => {
    expect(rangoHistorico({ desde: '2026-11-05', hasta: '2026-11-01' }, HOY))
      .toEqual({ desde: '2026-11-01', hasta: '2026-11-05', ajustado: true, motivo: 'las fechas venían al revés' });
  });
  it('NEGATIVA: una fecha imposible no se toma por buena (2026-02-31) y se declara', () => {
    const r = rangoHistorico({ desde: '2026-02-31', hasta: '2026-03-10' }, HOY);
    expect(r.desde).toBe('2026-02-09');
    expect(r.ajustado).toBe(true);
    expect(r.motivo).toMatch(/2026-02-31/);
  });
  it('NEGATIVA: un rango de más de 400 días se recorta y LO DICE', () => {
    const r = rangoHistorico({ desde: '2024-01-01', hasta: HOY }, HOY);
    expect(r.ajustado).toBe(true);
    expect(r.motivo).toMatch(/400/);
    expect(diasDelRango(r.desde, r.hasta)).toHaveLength(HISTORICO_DIAS_MAX);
  });
});

describe('[EX.H1] diasDelRango', () => {
  it('todos los días, el más reciente primero, cruzando mes', () => {
    expect(diasDelRango('2026-10-30', '2026-11-02')).toEqual(['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30']);
  });
  it('sumarDias cruza año', () => {
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('[EX.H1] banderasDeCierre', () => {
  it('31-mar-2026 (martes): cierre de mes y de trimestre, no de semana ni de año', () => {
    expect(banderasDeCierre('2026-03-31')).toEqual({ cierre_semana: false, cierre_mes: true, cierre_trimestre: true, cierre_anio: false });
  });
  it('domingo 01-nov-2026: cierre de semana', () => {
    expect(banderasDeCierre('2026-11-01').cierre_semana).toBe(true);
  });
  it('31-dic: mes, trimestre y año', () => {
    expect(banderasDeCierre('2026-12-31')).toMatchObject({ cierre_mes: true, cierre_trimestre: true, cierre_anio: true });
  });
  it('NEGATIVA: 30-abr cierra mes pero NO trimestre; 28-feb-2026 cierra mes (no bisiesto)', () => {
    expect(banderasDeCierre('2026-04-30')).toMatchObject({ cierre_mes: true, cierre_trimestre: false });
    expect(banderasDeCierre('2026-02-28').cierre_mes).toBe(true);
    expect(banderasDeCierre('2026-02-27').cierre_mes).toBe(false);
  });
});

describe('[EX.H2] cierresDeVista', () => {
  const rango = diasDelRango('2026-10-25', '2026-11-04').map((fecha) => ({ fecha, ...banderasDeCierre(fecha) }));
  it('días: todos, del más viejo al más nuevo (como la hoja)', () => {
    const v = cierresDeVista(rango, 'dias');
    expect(v).toHaveLength(11);
    expect(v[0].fecha).toBe('2026-10-25');
    expect(v[10].fecha).toBe('2026-11-04');
  });
  it('semanas: los domingos y el día más reciente', () => {
    expect(cierresDeVista(rango, 'semanas').map((d) => d.fecha)).toEqual(['2026-10-25', '2026-11-01', '2026-11-04']);
  });
  it('meses: el 31-oct y el día más reciente', () => {
    expect(cierresDeVista(rango, 'meses').map((d) => d.fecha)).toEqual(['2026-10-31', '2026-11-04']);
  });
  it('NEGATIVA: el día más reciente no se duplica si ya es cierre', () => {
    const r = diasDelRango('2026-10-29', '2026-10-31').map((fecha) => ({ fecha, ...banderasDeCierre(fecha) }));
    expect(cierresDeVista(r, 'meses').map((d) => d.fecha)).toEqual(['2026-10-31']);
  });
  it('NEGATIVA: si el último día no tiene valor, el último cierre CON valor no desaparece', () => {
    const r = diasDelRango('2026-10-27', '2026-11-03').map((fecha) => ({
      fecha, ...banderasDeCierre(fecha), total: { valor_estandar: fecha === '2026-11-03' ? null : 1 },
    }));
    expect(cierresDeVista(r, 'meses').map((d) => d.fecha)).toEqual(['2026-10-31', '2026-11-02', '2026-11-03']);
  });
  it('sin días, sin columnas', () => {
    expect(cierresDeVista([], 'semanas')).toEqual([]);
  });
});

describe('[EX.H1] estadoCelda', () => {
  it('NEGATIVA: hoy sin foto es PENDIENTE, no «no se tomó»', () => {
    expect(estadoCelda({ ...base, cubierto: false, fecha: HOY }).estado).toBe('pendiente');
  });
  it('antes del primer día con foto: sin_foto, diciendo desde cuándo hay', () => {
    const r = estadoCelda({ ...base, cubierto: false, fecha: '2026-09-20' });
    expect(r.estado).toBe('sin_foto');
    expect(r.motivo).toMatch(/2026-09-24/);
  });
  it('NEGATIVA: un día pasado sin cobertura es sin_foto, no medido', () => {
    expect(estadoCelda({ ...base, cubierto: false, fecha: '2026-10-18' }).estado).toBe('sin_foto');
  });
  it('NEGATIVA: el CEDIS con la fuente vieja no es confiable', () => {
    expect(estadoCelda({ ...base, cubierto: true, fecha: '2026-11-01', warehouse_code: '00', stock_source: 'commercial.stock' }).estado)
      .toBe('no_confiable');
  });
  it('NEGATIVA: el CEDIS sin fuente declarada (fila vieja) tampoco', () => {
    expect(estadoCelda({ ...base, cubierto: true, fecha: '2026-11-01', warehouse_code: '00', stock_source: null }).estado)
      .toBe('no_confiable');
  });
  it('el CEDIS con la fuente nueva sí es medido', () => {
    expect(estadoCelda({ ...base, cubierto: true, fecha: '2026-11-08', warehouse_code: '00', stock_source: 'analytics.v_erp_stock_on_hand' }))
      .toEqual({ estado: 'medido', motivo: null });
  });
  it('una sucursal con la fuente vieja es medido (en 01–08 las dos fuentes coinciden)', () => {
    expect(estadoCelda({ ...base, cubierto: true, fecha: '2026-11-01', stock_source: 'commercial.stock' }).estado).toBe('medido');
  });
});

describe('[EX.H1] totalDelDia', () => {
  it('suma sólo lo medido y nombra lo que quedó fuera', () => {
    const t = totalDelDia([celda('01', 'medido', 100.5), celda('00', 'no_confiable', 999), celda('02', 'sin_foto', null)]);
    expect(t).toMatchObject({ valor_estandar: 100.5, almacenes_sumados: 1, almacenes_fuera: ['00', '02'], todos_los_almacenes: false });
  });
  it('NEGATIVA: si nada se pudo sumar el total es null, no 0', () => {
    expect(totalDelDia([celda('02', 'sin_foto', null)]).valor_estandar).toBeNull();
  });
  it('NEGATIVA: un medido SIN valor no suma como 0 y deja el total incompleto', () => {
    const t = totalDelDia([celda('01', 'medido', 10), celda('04', 'medido', null)]);
    expect(t.valor_estandar).toBe(10);
    expect(t.todos_los_almacenes).toBe(false);
    expect(t.almacenes_fuera).toEqual(['04']);
  });
  it('NEGATIVA: «todos los almacenes» NO esconde los productos sin valuar ni el costo reconstruido', () => {
    const t = totalDelDia([
      celda('01', 'medido', 10, { productos_sin_valuar: 24, costo_reconstruido: true, productos_costo_posterior: 3 }),
      celda('02', 'medido', 5, { productos_sin_valuar: 16 }),
      celda('00', 'no_confiable', 7, { productos_sin_valuar: 99 }),
    ]);
    expect(t).toMatchObject({ productos_sin_valuar: 40, productos_costo_posterior: 3, costo_reconstruido: true });
  });
  it('todos_los_almacenes sólo si entraron todos', () => {
    expect(totalDelDia([celda('01', 'medido', 1), celda('02', 'medido', 2)]).todos_los_almacenes).toBe(true);
  });
});
