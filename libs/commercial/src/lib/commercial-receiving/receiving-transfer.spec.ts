import {
  TRANSFER_WINDOW_DAYS,
  classifyShipmentOrigin,
  diasEntre,
  parseTransferRef,
  transferRef,
  transferVisible,
} from './receiving-transfer';

/**
 * `[WMS-REC.17]` — **el traspaso entra al Andén por su EMBARQUE.**
 *
 * Lo que se cuida acá es lo que, si se rompe, vuelve a esconder la mercancía o la cruza con
 * otro documento: la referencia del vale, quién la mandó y qué día se ofrece en el menú.
 */
describe('receiving-transfer', () => {
  describe('la referencia del vale', () => {
    it('va y vuelve sin perder nada', () => {
      const ref = transferRef({ origen: '00', serie: 2, folio: '0001048' });
      expect(ref).toBe('UD41/00/2/0001048');
      expect(parseTransferRef(ref)).toEqual({ origen: '00', serie: 2, folio: '0001048' });
    });

    /**
     * La referencia de una ORDEN DE ENTRADA es `sucursal/folio`. Si se leyera como traspaso,
     * el vale de una compra se buscaría en los embarques y saldría sin renglones.
     */
    it('una referencia de orden de entrada NO es un traspaso', () => {
      expect(parseTransferRef('01/0000412')).toBeNull();
      expect(parseTransferRef('UD41/01/0000412')).toBeNull();
      expect(parseTransferRef(null)).toBeNull();
      expect(parseTransferRef('')).toBeNull();
    });

    it('una serie que no es número no se acepta a medias', () => {
      expect(parseTransferRef('UD41/06/x/0001048')).toBeNull();
      expect(parseTransferRef('UD41//2/0001048')).toBeNull();
    });

    /**
     * ⭐ El primer segmento NO puede ser una sucursal: los lectores viejos parten la
     * referencia como `sucursal/folio`, y con un traspaso tienen que caer en vacío en vez
     * de cruzar con una orden de entrada que casualmente tenga ese folio.
     */
    it('su primer segmento nunca es un código de sucursal', () => {
      const [primero] = transferRef({ origen: '01', serie: 2, folio: '0000412' }).split('/');
      expect(primero).not.toMatch(/^\d{2}$/);
    });
  });

  describe('de dónde viene', () => {
    it('la sucursal 00 es el CEDIS', () => {
      const o = classifyShipmentOrigin('00', 'CEDIS BPIRAPUATO');
      expect(o).toEqual({ kind: 'transfer', isCedis: true, label: 'CEDIS', name: 'CEDIS BPIRAPUATO' });
    });

    it('otra sucursal es un traspaso, con el nombre de su almacén', () => {
      const o = classifyShipmentOrigin('06', 'Canindo');
      expect(o).toEqual({ kind: 'transfer', isCedis: false, label: 'Traspaso', name: 'Canindo' });
    });

    it('sin nombre se dice la sucursal, no se deja vacío', () => {
      expect(classifyShipmentOrigin('06').name).toBe('Sucursal 06');
      expect(classifyShipmentOrigin('00', '  ').name).toBe('CEDIS');
    });

    it('siempre es traspaso: el reclamo va a la sucursal, no a un proveedor', () => {
      for (const s of ['00', '01', '06', '08']) expect(classifyShipmentOrigin(s).kind).toBe('transfer');
    });
  });

  describe('diasEntre', () => {
    it('cuenta días de calendario, sin horario de verano ni hora del servidor', () => {
      expect(diasEntre('2026-10-03', '2026-10-06')).toBe(3);
      expect(diasEntre('2026-10-06', '2026-10-06')).toBe(0);
      expect(diasEntre('2026-10-07', '2026-10-06')).toBe(-1);
      // Cruza el cambio de horario de abril (México ya no lo usa, pero el server sí podría).
      expect(diasEntre('2026-04-04', '2026-04-06')).toBe(2);
    });
  });

  describe('qué embarque se ofrece en el menú', () => {
    const hoy = '2026-10-06';

    it('el que salió hoy, aunque Kepler ya tenga la recepción', () => {
      expect(transferVisible({ fecha: hoy, hoy, recibidoKepler: null })).toBe(true);
      expect(transferVisible({ fecha: hoy, hoy, recibidoKepler: hoy })).toBe(true);
    });

    /**
     * ⭐ El caso del reporte: un camión que salió el sábado y llega el lunes. Con la regla de
     * las compras ("sólo hoy") no aparecería nunca.
     */
    it('el que salió antes y sigue en camino', () => {
      expect(transferVisible({ fecha: '2026-10-03', hoy, recibidoKepler: null })).toBe(true);
      expect(transferVisible({ fecha: '2026-10-05', hoy, recibidoKepler: null })).toBe(true);
    });

    it('el que Kepler recibió HOY aunque haya salido antes', () => {
      expect(transferVisible({ fecha: '2026-10-02', hoy, recibidoKepler: hoy })).toBe(true);
    });

    it('NO el que Kepler ya recibió otro día: ese ya llegó y no es de hoy', () => {
      expect(transferVisible({ fecha: '2026-10-02', hoy, recibidoKepler: '2026-10-03' })).toBe(false);
    });

    it('NO el que lleva más de la ventana sin recibirse', () => {
      const fuera = new Date(Date.parse(`${hoy}T00:00:00Z`) - (TRANSFER_WINDOW_DAYS + 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const borde = new Date(Date.parse(`${hoy}T00:00:00Z`) - TRANSFER_WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(transferVisible({ fecha: borde, hoy, recibidoKepler: null })).toBe(true);
      expect(transferVisible({ fecha: fuera, hoy, recibidoKepler: null })).toBe(false);
    });

    it('uno fechado a futuro (dedazo en Kepler) se ofrece, pero no si es absurdo', () => {
      expect(transferVisible({ fecha: '2026-10-07', hoy, recibidoKepler: null })).toBe(true);
      expect(transferVisible({ fecha: '2026-12-29', hoy, recibidoKepler: null })).toBe(false);
    });
  });
});
