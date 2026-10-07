/**
 * `[RH.1.5]` El motor de alertas (`reglas.ts`) y su configuración. Mega Talento no tenía prueba
 * de estas reglas: éstas fijan el comportamiento que se trasladó, una por regla, con su caso
 * negativo (un gate sin prueba negativa es una intención, ADR-056).
 */
import { analizarDia } from './reglas';
import { CONFIG_DEFAULT, configEfectiva, fusionar } from './config-reglas';
import type { ChecadaMin, EntradaDia, HorarioMin, ReglaConfig } from './tipos';

const horario: HorarioMin = { nombre: 'General', dias: [1, 2, 3, 4, 5, 6], entrada: '09:00', salida: '18:00', toleranciaMin: 10 };
const marcas = (fecha: string, ...horas: string[]): ChecadaMin[] =>
  horas.map((h) => ({ fechaHora: `${fecha}T${h}:00`, hora: `${h}:00`, tipo: null }));
const conTipo = (fecha: string, ...pares: Array<[string, number]>): ChecadaMin[] =>
  pares.map(([h, t]) => ({ fechaHora: `${fecha}T${h}:00`, hora: `${h}:00`, tipo: t }));

function entrada(p: Partial<EntradaDia> & { checadas: ChecadaMin[] }): EntradaDia {
  return {
    empleado: { sucursalId: 'prueba', codigo: '15', nombre: 'Ana' },
    fecha: '2026-07-07', diaSemana: 2, cerrado: true,
    horario, config: CONFIG_DEFAULT, empleadoConActividadRango: true,
    ...p,
  };
}
const reglas = (e: EntradaDia): string[] => analizarDia(e).map((i) => i.regla).sort();

describe('retardo (contra el horario configurado + tolerancia)', () => {
  it('entrar 09:25 con 09:00 y 10 de tolerancia es retardo de 25 min, severidad media', () => {
    const r = analizarDia(entrada({ checadas: conTipo('2026-07-07', ['09:25', 0], ['18:00', 1]) }));
    const ret = r.find((x) => x.regla === 'retardo');
    expect(ret?.severidad).toBe('media');
    expect(ret?.evidencia['minutosRetardo']).toBe(25);
  });
  it('dentro de la tolerancia no hay retardo; y con medirRetardo=false tampoco', () => {
    expect(reglas(entrada({ checadas: conTipo('2026-07-07', ['09:08', 0], ['18:00', 1]) }))).not.toContain('retardo');
    const sinHora: ReglaConfig = { ...CONFIG_DEFAULT, medirRetardo: false };
    expect(reglas(entrada({ config: sinHora, checadas: conTipo('2026-07-07', ['10:30', 0], ['18:00', 1]) })))
      .not.toContain('retardo');
  });
});

describe('falta', () => {
  it('día laborable, cerrado y sin checadas: falta alta', () => {
    const r = analizarDia(entrada({ checadas: [] }));
    expect(r.map((x) => [x.regla, x.severidad])).toEqual([['falta', 'alta']]);
  });
  it('no es falta: si no checó NADA en todo el rango, si el día no ha cerrado, o si no le tocaba', () => {
    expect(reglas(entrada({ checadas: [], empleadoConActividadRango: false }))).toEqual([]);
    expect(reglas(entrada({ checadas: [], cerrado: false }))).toEqual([]);
    expect(reglas(entrada({ checadas: [], diaSemana: 0 }))).toEqual([]);
  });
});

describe('checada duplicada, entrada sin salida y múltiples entradas', () => {
  it('dos marcas a 3 min son duplicada; a 6 min no', () => {
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '09:00', '09:03', '18:00', '18:30') }))).toContain('checada_duplicada');
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '09:00', '09:06', '18:00', '18:30') }))).not.toContain('checada_duplicada');
  });
  it('sin tipo, un número impar de marcas es entrada sin salida (inferido)', () => {
    const r = analizarDia(entrada({ checadas: marcas('2026-07-07', '09:00', '14:00', '15:00') }));
    const es = r.find((x) => x.regla === 'entrada_sin_salida');
    expect(es?.evidencia['inferido']).toBe(true);
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '09:00', '18:00') }))).not.toContain('entrada_sin_salida');
  });
  it('con tipos: salida sin entrada se distingue', () => {
    expect(reglas(entrada({ checadas: conTipo('2026-07-07', ['18:00', 1]) }))).toContain('salida_sin_entrada');
  });
  it('dos ENTRADAS (tipo 0) separadas más de 4 h son múltiples entradas; la comida (2/3) no cuenta', () => {
    expect(reglas(entrada({ checadas: conTipo('2026-07-07', ['08:00', 0], ['14:00', 2], ['15:00', 3], ['18:00', 1]) })))
      .not.toContain('multiples_entradas');
    expect(reglas(entrada({ checadas: conTipo('2026-07-07', ['08:00', 0], ['10:00', 1], ['13:30', 0], ['18:00', 1]) })))
      .toContain('multiples_entradas');
    expect(reglas(entrada({ checadas: conTipo('2026-07-07', ['08:00', 0], ['09:00', 1], ['10:00', 0], ['18:00', 1]) })))
      .not.toContain('multiples_entradas');
  });
});

describe('desayuno excedido (política de RH del 27/08/2026)', () => {
  // Corporativo: desayuno ~10:00 y comida ~15:00.
  it('50 min de desayuno con tope 30 → exceso 20, severidad media', () => {
    const r = analizarDia(entrada({ checadas: marcas('2026-07-07', '08:00', '10:00', '10:50', '15:00', '15:30', '18:00') }));
    const d = r.find((x) => x.regla === 'desayuno_excedido');
    expect([d?.evidencia['excesoMin'], d?.severidad]).toEqual([20, 'media']);
  });
  it('un exceso de 5 min se ve en pantalla pero NO alerta (umbral 10)', () => {
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '08:00', '10:00', '10:35', '15:00', '15:30', '18:00') })))
      .not.toContain('desayuno_excedido');
  });
  it('una pausa de más de 2 h no es desayuno: es una marca perdida, y no se cobra', () => {
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '08:00', '09:00', '11:30', '18:00') }))).not.toContain('desayuno_excedido');
  });
  it('quien sólo comió (primera pausa después de las 13:00) no tiene desayuno que medir', () => {
    expect(reglas(entrada({ checadas: marcas('2026-07-07', '08:00', '14:00', '15:30', '18:00') }))).not.toContain('desayuno_excedido');
  });
});

describe('configuración: código → global → política del sitio → fila del sitio', () => {
  it('la fila del sitio manda sobre la global, y una regla apagada se queda apagada', () => {
    const c = configEfectiva('morelia-abastos',
      { desayunoTopeMin: 30, reglasActivas: { retardo: false } },
      { reglasActivas: { desayuno_excedido: false } });
    expect([c.reglasActivas.retardo, c.reglasActivas.desayuno_excedido, c.reglasActivas.falta]).toEqual([false, false, true]);
  });
  it('corporativo paga el desayuno por política aunque su fila no lo diga; su fila puede cambiarlo', () => {
    expect(configEfectiva('corporativo', null, null).desayunoCuentaComoJornada).toBe(true);
    expect(configEfectiva('corporativo', null, { desayunoCuentaComoJornada: false }).desayunoCuentaComoJornada).toBe(false);
    expect(configEfectiva('cedis', null, null).desayunoCuentaComoJornada).toBe(false);
  });
  it('salida_sin_entrada sigue a entrada_sin_salida si nadie la declara', () => {
    expect(fusionar(CONFIG_DEFAULT, { reglasActivas: { entrada_sin_salida: false, salida_sin_entrada: undefined } })
      .reglasActivas.salida_sin_entrada).toBe(false);
  });
  it('basura en la columna no rompe: se queda el respaldo', () => {
    expect(fusionar(CONFIG_DEFAULT, 'no es objeto')).toBe(CONFIG_DEFAULT);
  });
});
