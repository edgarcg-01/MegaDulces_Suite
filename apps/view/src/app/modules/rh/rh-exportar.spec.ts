import { dia, persona } from '../../../testing/rh.fixture';
import { filasExportacion, latin1 } from './rh-exportar';
import { columnasDelRango, porDepartamento } from './reporte-formato';

/**
 * `[RH.1.7c]` Lo que sale en el PDF y el Excel. Regla de RH: lo que se ve es lo que sale. Lo que se defiende: sale lo
 * filtrado, el subtotal es del departamento COMPLETO (igual que en pantalla) y el texto cabe en las fuentes del PDF.
 */
const ctx = { plaza: 'Padre Hidalgo', periodo: 'jue 1 – mié 7', parcial: '', columnas: columnasDelRango('2026-10-05', '2026-10-06', '2026-10-08'), hoy: '2026-10-08', mideRetardo: true };

describe('[RH.1.7c] filasExportacion', () => {
  const a = persona({
    codigo: '1', nombreCompleto: 'Alfa', departamento: 'Sistemas · s', minutosTrabajados: 600, atrasoBrutoMin: 7,
    semanas: [{ ...persona().semanas[0], dias: [dia({ fecha: '2026-10-05', entrada: '07:56', salida: '17:04', comida: '14:01 – 15:00', comidaMin: 59 })] }],
  });
  const b = persona({ codigo: '2', nombreCompleto: 'Beta', departamento: 'Sistemas · s', minutosTrabajados: 300, atrasoBrutoMin: 3, semanas: [] });

  it('un renglón de departamento, uno por persona y el subtotal del departamento COMPLETO', () => {
    const { encabezado, filas } = filasExportacion(porDepartamento([a, b], [a]), [a, b], ctx, true);
    expect(encabezado).toEqual(['Clv', 'Nombre', 'Horario', 'Lun 5', 'Mar 6', 'Horas', 'Min. retardo']);
    expect(filas.map((f) => f.tipo)).toEqual(['depto', 'persona', 'subtotal']);
    expect(filas[0].titulo).toBe('SISTEMAS (1 de 2)');
    expect(filas[1].celdas.slice(0, 4)).toEqual(['1', 'Alfa', 'Deducido · 8:00 am', '07:56 - 17:04\n14:01–15:00\nC 59']);
    // 600 + 300 minutos: Beta no se ve, pero el subtotal es del departamento entero.
    expect(filas[2].celdas.slice(-2)).toEqual(['15h 00m', '10']);
  });

  it('⛔ con búsqueda puesta no hay subtotales', () => {
    expect(filasExportacion(porDepartamento([a, b], [a]), [a, b], ctx, false).filas.map((f) => f.tipo)).toEqual(['depto', 'persona']);
  });

  it('el PDF sólo lleva Latin-1: guiones largos, puntos suspensivos y comillas se reemplazan', () => {
    expect(latin1('08:01 - … · 14:01–15:00 «hoy» −5')).toBe('08:01 - ... · 14:01-15:00 "hoy" -5');
  });
});
