import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { todayMx } from '@megadulces/platform-core';
import { BandejaTicketsService } from './bandeja-tickets.service';

/**
 * TK.12 — Sólo el rango: es lo que protege a la vista de facturas de un escaneo de meses.
 * La consulta NO se prueba acá con un doble de Knex — un doble no ejecuta SQL y ya dio verde
 * con el login de prod en 500. La consulta queda NO MEDIDA hasta correrla contra datos reales.
 */
const svc = new BandejaTicketsService({} as never, {} as never);

describe('rango de la bandeja', () => {
  it('sin fechas es HOY en México, no el día UTC del servidor', () => {
    expect(svc.rango({})).toEqual({ desde: todayMx(), hasta: todayMx() });
  });

  it('con una sola fecha, es ese día', () => {
    expect(svc.rango({ from: '2026-09-01' })).toEqual({ desde: '2026-09-01', hasta: '2026-09-01' });
    expect(svc.rango({ to: '2026-09-02' })).toEqual({ desde: '2026-09-02', hasta: '2026-09-02' });
  });

  it('31 días entra; 32 no', () => {
    expect(svc.rango({ from: '2026-08-01', to: '2026-08-31' })).toEqual({ desde: '2026-08-01', hasta: '2026-08-31' });
    expect(() => svc.rango({ from: '2026-08-01', to: '2026-09-01' })).toThrow(BadRequestException);
  });

  it('rechaza el rango invertido y el formato que no es AAAA-MM-DD', () => {
    expect(() => svc.rango({ from: '2026-09-10', to: '2026-09-01' })).toThrow(BadRequestException);
    expect(() => svc.rango({ from: '01/09/2026' })).toThrow(BadRequestException);
    expect(() => svc.rango({ from: "2026-09-01' OR 1=1 --" })).toThrow(BadRequestException);
  });
});
