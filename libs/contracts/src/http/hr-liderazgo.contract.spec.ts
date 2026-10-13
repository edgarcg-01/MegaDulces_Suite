/**
 * `[RH.2.4]` El cuestionario de liderazgo: el mismo cálculo que Mega Talento (Grid de Blake y Mouton, umbral 66%).
 */
import { HR_CUESTIONARIO_LIDERAZGO, hrCalificaLiderazgo, hrClasificarEstilo, hrResultadoLiderazgo } from './hr-liderazgo.contract';

const todas = (v: number) => Object.fromEntries(HR_CUESTIONARIO_LIDERAZGO.map((p) => [p.num, v]));

describe('[RH.2.4] cuestionario de liderazgo', () => {
  it('12 preguntas, 6 de tarea y 6 de relaciones (cada eje de 6 a 30)', () => {
    expect(HR_CUESTIONARIO_LIDERAZGO.length).toBe(12);
    expect(HR_CUESTIONARIO_LIDERAZGO.filter((p) => p.dimension === 'tarea').length).toBe(6);
  });

  it('todo «Siempre» = 100%, destacado, Liderazgo de Equipo; todo «Nunca» = 20%, empobrecido', () => {
    expect(hrResultadoLiderazgo(todas(5))).toMatchObject({ porcentaje: 100, nivel: 'destacado', estilo: 'equipo', puntajeTarea: 30, puntajeRelaciones: 30 });
    expect(hrResultadoLiderazgo(todas(1))).toMatchObject({ porcentaje: 20, nivel: 'requiere-desarrollo', estilo: 'empobrecido' });
  });

  it('los cortes de nivel: 83 destacado, 66 sólido, 50 en desarrollo', () => {
    // 40/60 = 67% → sólido; 39/60 = 65% → en desarrollo.
    const r40 = { ...todas(3), 1: 4, 2: 4, 3: 4, 4: 4 };
    expect(hrResultadoLiderazgo(r40)).toMatchObject({ puntaje: 40, porcentaje: 67, nivel: 'solido' });
    const r39 = { ...todas(3), 1: 4, 2: 4, 3: 4 };
    expect(hrResultadoLiderazgo(r39)).toMatchObject({ puntaje: 39, porcentaje: 65, nivel: 'en-desarrollo' });
  });

  it('⛔ NEGATIVA — incompleto no califica aunque lo contestado sea perfecto', () => {
    const casi = todas(5);
    delete casi[12];
    const r = hrResultadoLiderazgo(casi);
    expect([r.contestadas, r.nivel, hrCalificaLiderazgo(r)]).toEqual([11, 'sin-evaluar', false]);
  });

  it('califica con 66% o más, y valores fuera de 1-5 no cuentan', () => {
    expect(hrCalificaLiderazgo(hrResultadoLiderazgo(todas(4)))).toBe(true); // 80%
    expect(hrCalificaLiderazgo(hrResultadoLiderazgo(todas(3)))).toBe(false); // 60%
    expect(hrResultadoLiderazgo({ ...todas(5), 1: 9 }).contestadas).toBe(11);
  });

  it('estilos del Grid', () => {
    expect(hrClasificarEstilo(30, 6)).toBe('autocratico');
    expect(hrClasificarEstilo(6, 30)).toBe('club-campestre');
    expect(hrClasificarEstilo(18, 18)).toBe('punto-medio');
  });
});
