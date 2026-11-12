import { describe, expect, it } from 'vitest';
import { DIAS_A_LA_MANO, diasALaMano, esDia, hoyMx, nombreCorto, nombreLargo, sinVerFuera, sumarDias } from './mis-pedidos-dia';

describe('[MCP.20] Mis pedidos por día', () => {
  it('hoy es el día de México, no el del reloj en UTC', () => {
    // 2026-11-12 03:30 UTC = 2026-11-11 21:30 en México.
    expect(hoyMx(new Date('2026-11-12T03:30:00Z'))).toBe('2026-11-11');
    expect(hoyMx(new Date('2026-11-11T18:00:00Z'))).toBe('2026-11-11');
  });

  it('suma días cruzando mes y año', () => {
    expect(sumarDias('2026-11-01', -1)).toBe('2026-10-31');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('negativa: un día que no existe o vacío no es día', () => {
    expect(esDia('2026-11-11')).toBe(true);
    expect(esDia('2026-02-30')).toBe(false);
    expect(esDia('')).toBe(false);
    expect(esDia(null)).toBe(false);
    expect(esDia('11/11/2026')).toBe(false);
  });

  it('nombres: Hoy, Ayer, el día de la semana y, fuera de la semana, con mes', () => {
    const hoy = '2026-11-11'; // miércoles
    expect(nombreCorto(hoy, hoy)).toBe('Hoy');
    expect(nombreCorto('2026-11-10', hoy)).toBe('Ayer');
    expect(nombreCorto('2026-11-09', hoy)).toMatch(/^lun 9$/);
    expect(nombreCorto('2026-10-28', hoy)).toMatch(/^mié 28 oct$/);
    expect(nombreLargo(hoy, hoy)).toBe('hoy');
    expect(nombreLargo('2026-11-10', hoy)).toBe('ayer');
    expect(nombreLargo('2026-11-09', hoy)).toBe('el lunes 9 de noviembre');
  });

  it('a la mano: una semana, del más nuevo al más viejo, con su marca de reporte nuevo', () => {
    const d = diasALaMano('2026-11-11', '2026-11-11', ['2026-11-09']);
    expect(d).toHaveLength(DIAS_A_LA_MANO);
    expect(d[0]).toEqual({ fecha: '2026-11-11', texto: 'Hoy', nuevo: false });
    expect(d[DIAS_A_LA_MANO - 1].fecha).toBe('2026-11-05');
    expect(d.filter((x) => x.nuevo).map((x) => x.fecha)).toEqual(['2026-11-09']);
  });

  it('un día viejo elegido en el calendario se agrega al final para que se vea cuál es', () => {
    const d = diasALaMano('2026-11-11', '2026-10-28');
    expect(d).toHaveLength(DIAS_A_LA_MANO + 1);
    expect(d[d.length - 1].fecha).toBe('2026-10-28');
    // Negativa: un día futuro o inválido no se agrega.
    expect(diasALaMano('2026-11-11', '2026-11-20')).toHaveLength(DIAS_A_LA_MANO);
    expect(diasALaMano('2026-11-11', 'basura')).toHaveLength(DIAS_A_LA_MANO);
  });

  it('reportes nuevos de días fuera de la semana se avisan aparte, sin repetir, del más nuevo al más viejo', () => {
    expect(sinVerFuera('2026-11-11', ['2026-11-10', '2026-10-30', '2026-11-04', '2026-10-30'])).toEqual(['2026-11-04', '2026-10-30']);
    expect(sinVerFuera('2026-11-11', [])).toEqual([]);
  });
});
