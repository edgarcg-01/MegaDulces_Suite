import type { HrHojaFirmaPersona, HrHojaFirmasDto } from '@megadulces/contracts';
import { leyendaFirma, momento, nombreArchivo } from './firma-pdf';

/**
 * `[RH.15.11]` Lo que el PDF de firmas DICE de cada persona. Lo que importa: que «sin firma» nunca parezca firmado, que
 * una firma anulada diga que lo está, y que el archivo se nombre por departamento o por persona.
 */
const persona = (firma: HrHojaFirmaPersona['firma']): HrHojaFirmaPersona => ({
  codigo: '15', nombre: 'PRUEBA UNO', department: 'ALMACEN', dias: [], horas_semana: '8:00', faltas: 0, firma,
});
const celular = { via: 'celular' as const, firmado_at: '2026-11-17T14:03:09', png: 'data:image/png;base64,AAAA', ip: '10.0.0.7', navegador: 'Safari', id: 'f1', anulada: null };

describe('[RH.15.11] el PDF de firmas', () => {
  it('la hora viene ya en hora de México: sólo se le da forma', () => {
    expect(momento('2026-11-17T14:03:09')).toBe('17/11/26 14:03');
    expect(momento('')).toBe('');
  });

  it('cada persona dice cómo firmó; sin firma lo dice en mayúsculas; anulada lo dice primero', () => {
    expect(leyendaFirma(persona(celular))).toBe('Firmó en su celular el 17/11/26 14:03 desde la IP 10.0.0.7.');
    expect(leyendaFirma(persona({ ...celular, ip: null }))).toBe('Firmó en su celular el 17/11/26 14:03.');
    expect(leyendaFirma(persona({ ...celular, via: 'papel', png: null }))).toBe('Firmó en la hoja de papel del departamento (registrada el 17/11/26 14:03).');
    expect(leyendaFirma(persona(null))).toBe('SIN FIRMA en esta versión de la semana.');
    expect(leyendaFirma(persona({ ...celular, anulada: { at: '2026-11-18T09:00:00', motivo: 'firmó otra persona' } })))
      .toMatch(/^ANULADA el 18\/11\/26 09:00: firmó otra persona\./);
  });

  it('el archivo se llama por departamento (hoja) o por persona (comprobante)', () => {
    const h: HrHojaFirmasDto = { site_code: 's', site_name: 'Plaza', period_start: '2026-11-05', period_end: '2026-11-11', department: 'ALMACEN',
      version: 'abcdef123456', vigente: true, personas: [persona(celular)] };
    expect(nombreArchivo(h, 'hoja')).toBe('FIRMAS-ALMACEN-2026-11-05.pdf');
    expect(nombreArchivo(h, 'comprobante')).toBe('FIRMAS-15-PRUEBA-UNO-2026-11-05.pdf');
  });
});
