import { CommercialAnalyticsService } from './commercial-analytics.service';

/**
 * `[VEC.38]` La llave del ticket de ruta: lo que la lista EMITE, el detalle lo tiene que ACEPTAR.
 *
 * El defecto que la motiva: `salesByRouteTickets` emitía llaves `kepler_vecinal|…` y
 * `parseTicketKey` sólo aceptaba `wincaja` y `push`, así que todo ticket vecinal daba 400 al
 * abrirse. La prueba es de ida y vuelta: se arma la llave con `ticketKey` y se lee con
 * `parseTicketKey`, para que una fuente nueva en un lado no vuelva a quedar huérfana del otro.
 */
const svc = Object.create(CommercialAnalyticsService.prototype) as {
  ticketKey(r: { source: string; source_branch: string; date: string; consecutivo: string }): string;
  parseTicketKey(key: string): { source: string; sourceBranch: string; date: string; consecutivo: string };
};

describe('VEC.38 · llave del ticket de ruta', () => {
  it.each([
    ['wincaja', '25', '2026-10-08', '000123'],
    ['push', '501', '2026-10-08', '0001824'],
    ['kepler_vecinal', '2V005', '2026-10-08', '9-0000033'],
  ])('ida y vuelta para %s', (source, source_branch, date, consecutivo) => {
    const key = svc.ticketKey({ source, source_branch, date, consecutivo });
    expect(svc.parseTicketKey(key)).toEqual({ source, sourceBranch: source_branch, date, consecutivo });
  });

  it('el consecutivo puede traer el separador', () => {
    expect(svc.parseTicketKey('push|501|2026-10-08|a|b').consecutivo).toBe('a|b');
  });

  it.each([['otra|25|2026-10-08|1'], ['push|25|08-10-2026|1'], ['push|25|2026-10-08']])(
    '⛔ NEGATIVA — %p se rechaza', (key) => {
      expect(() => svc.parseTicketKey(key)).toThrow('key de ticket inválida');
    },
  );
});
