import { cuadreDeLaDescarga, type ArchivoParaCuadre } from './cuadre-de-la-descarga';

/**
 * `[CB.73]` El cuadre de la descarga, sin el libro. Casos con la forma de los de prod del 2026-11-17 (importes
 * inventados donde no hace falta el real: el repo es público).
 */
const HOY = '2026-11-17';
const arch = (desde: string, hasta: string, abre: number, cierra: number, subido = `${hasta}T15:00:00`): ArchivoParaCuadre => ({ desde, hasta, abre, cierra, subido });

describe('[CB.73] el cuadre de la descarga: el banco se juzga por sus saldos, no contra el libro', () => {
  it('días sin movimientos entre dos archivos (BB 506): el saldo sigue igual y cuadra', () => {
    const r = cuadreDeLaDescarga([arch('2026-11-03', '2026-11-07', 5470.58, 9.66), arch('2026-11-11', '2026-11-13', 9.66, 2494.79)], [],
      { fecha: '2026-10-30', saldo: 5470.58 }, HOY);
    expect(r).toMatchObject({ cuadra: true, desde: '2026-11-03', hasta: '2026-11-13', archivos: 2, entrada: 'cuadra', rotura: null, motivo: null });
  });

  it('[negativa] falta un día (BB 854): el saldo no sigue, se niega y dice desde dónde bajar', () => {
    const r = cuadreDeLaDescarga([
      arch('2026-11-03', '2026-11-09', 5848.6, 33810.97), arch('2026-11-10', '2026-11-10', 33810.97, 54067.52),
      arch('2026-11-12', '2026-11-12', 120284.42, 4218.58), arch('2026-11-12', '2026-11-14', 120284.42, 218.58, '2026-11-17T08:34:00'),
    ], [], { fecha: '2026-10-31', saldo: 5848.6 }, HOY);
    expect(r.cuadra).toBe(false);
    expect(r.rotura).toEqual({ despues_de: '2026-11-10', antes_de: '2026-11-12', cierra: 54067.52, abre: 120284.42 });
    expect(r.motivo).toBe('el saldo no sigue entre el 10/11 y el 12/11 (cerró en $54,067.52 y abre en $120,284.42): baja un solo archivo del 10/11 a hoy');
  });

  it('[negativa] la descarga abre en otro saldo que el último conocido de la cuenta (BB 3660): se niega', () => {
    const r = cuadreDeLaDescarga([arch('2026-11-03', '2026-11-06', 5714.58, 1085.08)], [], { fecha: '2026-07-31', saldo: 1911.34 }, HOY);
    expect(r).toMatchObject({ cuadra: false, entrada: 'no_cuadra', rotura: null });
    expect(r.motivo).toBe('la descarga abre el 03/11 en $5,714.58 y la cuenta cerró el 31/07 en $1,911.34: baja un solo archivo del 31/07 a hoy');
  });

  it('sin saldo anterior con que compararla, cuadra y lo declara (`sin_testigo`)', () => {
    expect(cuadreDeLaDescarga([arch('2026-11-03', '2026-11-06', 100, 200)], [], null, HOY)).toMatchObject({ cuadra: true, entrada: 'sin_testigo', testigo: null });
  });

  it('el primer día es la fecha más vieja de sus renglones, no el primer renglón del archivo (BBVA 5712)', () => {
    // BBVA pone primero un cargo fechado el 03 y después los abonos del 02: el archivo «empieza» el 03.
    const r = cuadreDeLaDescarga([arch('2026-11-03', '2026-11-16', 8433.92, 1000)],
      [{ fecha: '2026-11-03', saldo: 7013.95 }, { fecha: '2026-11-02', saldo: 13628.96 }, { fecha: '2026-11-02', saldo: 21007.82 }],
      { fecha: '2026-10-31', saldo: 8433.92 }, HOY);
    expect(r).toMatchObject({ cuadra: true, desde: '2026-11-02', entrada: 'cuadra' });
  });

  it('un archivo encimado que abre en un saldo por el que la cuenta ya pasó: cuadra', () => {
    const saldos = [{ fecha: '2026-11-10', saldo: 300 }, { fecha: '2026-11-10', saldo: 450 }];
    const r = cuadreDeLaDescarga([arch('2026-11-09', '2026-11-10', 100, 300, '2026-11-10T09:00:00'), arch('2026-11-10', '2026-11-12', 300, 900)], saldos, null, HOY);
    expect(r).toMatchObject({ cuadra: true, hasta: '2026-11-12' });
  });

  it('[negativa] un archivo encimado que abre en un saldo por el que la cuenta nunca pasó: se niega', () => {
    const saldos = [{ fecha: '2026-11-10', saldo: 300 }];
    const r = cuadreDeLaDescarga([arch('2026-11-09', '2026-11-10', 100, 300), arch('2026-11-10', '2026-11-12', 777, 900)], saldos, null, HOY);
    expect(r.cuadra).toBe(false);
    expect(r.rotura).toMatchObject({ antes_de: '2026-11-10', abre: 777 });
  });

  it('dos archivos que terminan el mismo día: manda el cierre del que se subió después (el día completo)', () => {
    const r = cuadreDeLaDescarga([
      arch('2026-11-09', '2026-11-12', 100, 400, '2026-11-12T09:00:00'), // bajado a media mañana del 12
      arch('2026-11-12', '2026-11-12', 300, 650, '2026-11-13T09:00:00'), // el 12 completo
      arch('2026-11-13', '2026-11-13', 650, 700),
    ], [{ fecha: '2026-11-11', saldo: 300 }], null, HOY);
    expect(r).toMatchObject({ cuadra: true, hasta: '2026-11-13' });
    // [negativa] si mandara el cierre del primero ($400), el 13 no abriría donde cerró la cuenta.
    const sinElCompleto = cuadreDeLaDescarga([arch('2026-11-09', '2026-11-12', 100, 400), arch('2026-11-13', '2026-11-13', 650, 700)], [], null, HOY);
    expect(sinElCompleto.cuadra).toBe(false);
  });

  it('sin descarga no hay cuadre; con saldo conocido dice desde dónde bajar', () => {
    expect(cuadreDeLaDescarga([], [], { fecha: '2026-08-03', saldo: 10 }, HOY)).toMatchObject({ cuadra: false, desde: null, archivos: 0,
      motivo: 'no hay ninguna descarga subida: baja un solo archivo del 03/08 a hoy' });
    expect(cuadreDeLaDescarga([], [], null, HOY).motivo).toBe('no hay ninguna descarga subida');
  });

  it('una fecha de otro año lleva su año', () => {
    expect(cuadreDeLaDescarga([arch('2026-01-02', '2026-01-05', 5, 9)], [], { fecha: '2025-12-30', saldo: 4 }, '2026-01-05').motivo)
      .toBe('la descarga abre el 02/01 en $5.00 y la cuenta cerró el 30/12/2025 en $4.00: baja un solo archivo del 30/12/2025 a hoy');
  });
});
