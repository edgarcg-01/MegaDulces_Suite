/**
 * `[RH.7.4]` Cruces de plaza. Cada caso es uno de los reales que Mega Talento documenta en `cruces-plazas.ts`
 * (20/08/2026), con su negativa: lo que NO debe acusarse (oficinas, una marca que pudo ser un pedido, la ruta de una
 * promotora).
 */
import { clasificarDia, claseMasGrave, crucesEntrePlazas, sedeDe, type FilaEstancia, type PersonaMultisitio } from './cruces';

const e = (site_code: string, primera: string, ultima: string, marcas = 4) => ({ site_code, codigo: '1', primera, ultima, marcas });

describe('[RH.7.4] clasificarDia', () => {
  it('dos jornadas que se pisan en dos ciudades: traslape', () => {
    expect(clasificarDia([e('corporativo', '06:56', '16:56'), e('zamora-canindo', '08:21', '15:06')], false).clase).toBe('traslape');
  });

  it('⛔ una marca SUELTA en la plaza ajena a media jornada propia NO es traslape: marca ajena', () => {
    expect(clasificarDia([e('morelia-vicente-guerrero', '08:07', '17:08'), e('morelia-abastos', '09:23', '09:23', 1)], false).clase).toBe('marca_ajena');
  });

  it('cubrió dos tiendas sin encimarse: jornada partida, con su hueco', () => {
    const r = clasificarDia([e('morelia-vicente-guerrero', '08:06', '12:00', 2), e('morelia-abastos', '13:00', '16:09', 2)], false);
    expect(r).toEqual({ clase: 'jornada_partida', huecoMin: 60 });
  });

  it('hueco de más de 4 h: dos presencias sueltas, sin inventarle una jornada', () => {
    expect(clasificarDia([e('sucursal-ph', '07:00', '08:00', 2), e('8-esquinas', '13:00', '14:00', 2)], false).clase).toBe('sueltas');
  });

  it('la promotora en ruta no se acusa… pero si se encima, sí', () => {
    expect(clasificarDia([e('8-esquinas', '10:00', '11:59', 2), e('sucursal-ph', '12:56', '14:59', 2)], true).clase).toBe('ruta_promotora');
    expect(clasificarDia([e('8-esquinas', '10:00', '13:30', 2), e('sucursal-ph', '12:56', '14:59', 2)], true).clase).toBe('traslape');
  });

  it('⛔ los tres relojes de oficinas son UNA sede: encimarse ahí no es traslape', () => {
    expect(sedeDe('corporativo-comida')).toBe(sedeDe('corporativo'));
    expect(clasificarDia([e('corporativo', '07:45', '18:00'), e('corporativo-comida', '10:07', '15:33')], false).clase).not.toBe('traslape');
  });

  it('la más grave le pone cara a la fila', () => {
    expect(claseMasGrave(['ruta_promotora', 'jornada_partida', 'marca_ajena'])).toBe('marca_ajena');
  });
});

describe('[RH.7.4] crucesEntrePlazas', () => {
  const persona = (user_id: string, nombre: string, sitios: string[], esPromotora = false): PersonaMultisitio =>
    ({ user_id, nombre, esPromotora, altas: sitios.map((site_code) => ({ site_code, codigo: '1' })) });
  const f = (user_id: string, site_code: string, fecha: string, primera: string, ultima: string, marcas = 4): FilaEstancia =>
    ({ user_id, site_code, codigo: '1', fecha, primera, ultima, marcas });

  it('ordena por gravedad, deja fuera oficinas y a quien no cruzó en el periodo, y cuenta el resumen', () => {
    const r = crucesEntrePlazas('2026-11-02', '2026-11-04',
      [
        persona('a', 'Ana', ['morelia-vicente-guerrero', 'morelia-abastos']),
        persona('b', 'Beto', ['corporativo', 'zamora-canindo']),
        persona('c', 'Caro', ['corporativo', 'corporativo-comida']),       // una sola sede: no cuenta
        persona('d', 'Dani', ['8-esquinas', 'sucursal-ph']),               // dos sedes, sin cruce en el periodo
      ],
      [
        f('a', 'morelia-vicente-guerrero', '2026-11-02', '08:06', '12:00', 2), f('a', 'morelia-abastos', '2026-11-02', '13:00', '16:09', 2),
        f('b', 'corporativo', '2026-11-03', '06:56', '16:56'), f('b', 'zamora-canindo', '2026-11-03', '08:21', '15:06'),
        f('c', 'corporativo', '2026-11-03', '07:45', '18:00'), f('c', 'corporativo-comida', '2026-11-03', '10:07', '15:33'),
        f('d', 'sucursal-ph', '2026-11-04', '08:00', '17:00'),
      ]);
    expect(r.enDosSedes).toBe(3);
    expect(r.personas.map((p) => [p.nombre, p.clase])).toEqual([['Beto', 'traslape'], ['Ana', 'jornada_partida']]);
    expect(r.resumen).toEqual({ personas: 2, dias: 2, traslapes: 1, marcasAjenas: 0, jornadasPartidas: 1, rutas: 0 });
  });
});
