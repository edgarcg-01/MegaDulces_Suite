import type { IncomeForecastDay } from '@megadulces/contracts';
import { meses, origen, porEntrar, proyectado, semanas } from './presupuesto-ingresos';

const dia = (fecha: string, dia_semana: number, semana: number,
  b: [number | null, number | null], c: [number | null, number | null]): IncomeForecastDay => ({
  fecha, dia_semana, semana, semana_anio: 2026, inhabil: false,
  bancos: { estimado: b[0], real: b[1] }, caja_general: { estimado: c[0], real: c[1] },
});

describe('[PU.13] ingresos: proyectado = real si está cargado, si no estimado', () => {
  it('prefiere lo real, aunque sea cero', () => {
    expect(proyectado({ estimado: 100, real: 0 })).toBe(0);
    expect(origen({ estimado: 100, real: 0 })).toBe('real');
  });
  it('usa el estimado cuando el día no está cargado', () => {
    expect(proyectado({ estimado: 100, real: null })).toBe(100);
    expect(origen({ estimado: 100, real: null })).toBe('estimado');
  });
  it('sin real ni estimado no es cero: es null', () => {
    expect(proyectado({ estimado: null, real: null })).toBeNull();
    expect(origen({ estimado: null, real: null })).toBe('sin_dato');
  });
});

describe('[PU.13] semanas y meses', () => {
  const dias = [
    dia('2026-10-12', 1, 42, [null, 3000], [null, null]),   // lunes: bancos real, caja sin cargar ni estimar
    dia('2026-10-13', 2, 42, [2000, 1500], [300, null]),    // martes: bancos real con estimado, caja estimada
    dia('2026-10-14', 3, 42, [1000, null], [200, null]),    // miércoles: todo estimado
    dia('2026-11-02', 1, 45, [500, null], [0, null]),
  ];

  it('acomoda cada día en su columna y suma lo proyectado por semana', () => {
    const s = semanas(dias);
    expect(s.map((x) => x.etiqueta)).toEqual(['semana 42', 'semana 45']);
    expect(s[0].dias[0]?.fecha).toBe('2026-10-12');
    expect(s[0].dias[6]).toBeNull();
    expect(s[0].total.bancos).toBe(3000 + 1500 + 1000);
    expect(s[0].total.caja_general).toBe(300 + 200);
    expect(s[0].totalAmbos).toBe(6000);
  });

  it('separa lo que ya entró de lo que falta, y mide el desvío sólo donde hay los dos', () => {
    const [oct, nov] = meses(dias);
    expect(oct.etiqueta).toBe('octubre');
    expect(oct.canal.bancos.real).toBe(4500);
    expect(oct.canal.bancos.porEntrar).toBe(1000);
    expect(oct.canal.bancos.proyectado).toBe(5500);
    expect(oct.canal.bancos.desvio).toEqual({ real: 1500, estimado: 2000, pct: -25 });
    expect(oct.canal.caja_general.real).toBeNull();
    expect(oct.canal.caja_general.desvio).toBeNull();
    expect(nov.canal.caja_general.proyectado).toBe(0);
  });

  it('lo que falta por entrar no cuenta los días ya cargados', () => {
    expect(porEntrar(dias)).toBe(300 + 1000 + 200 + 500 + 0);
  });
});
