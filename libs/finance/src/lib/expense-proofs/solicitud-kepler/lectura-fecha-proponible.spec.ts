import 'reflect-metadata';
import { todayMx } from '@megadulces/platform-core';
import { ExpenseCaptureLinksService } from '../expense-capture-links.service';
import { SolicitudGastoService } from './solicitud-gasto.service';

/**
 * `[PGP.122.13]` Las dos primeras usuarias (2026-11-21) recibieron la fecha del ticket con el AÑO mal y la escribieron
 * a mano. La lectura sólo se propone si es de los últimos 30 días (`fechaLeidaProponible`) en las dos pantallas que la
 * usan —«Pedir un gasto» y la liga de captura—, y con un año mal no se busca la factura del SAT: con un importe que se
 * repite cada mes encontraría la del año pasado.
 */
const haceDias = (n: number): string => {
  const t = new Date(`${todayMx()}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};
/** Lo que devuelve el lector: la fecha ya convertida (puede venir con el año mal) y lo que leyó impreso. */
const lectura = (fecha: string | null, impresa: string | null) => ({
  total: 200, subtotal: null, iva: null, fecha, fecha_impresa: impresa, comercio: 'RECOLECTORA', rfc: 'AAA010101AAA', folio: '112772', legible: true,
});

function pedirGasto(fecha: string | null, impresa: string | null) {
  const sql: Array<{ q: string; b: unknown[] }> = [];
  const trx = {
    raw: async (q: string, b: unknown[] = []) => { sql.push({ q, b }); return { rows: [] }; },
    transaction: async <T>(fn: (sp: unknown) => Promise<T>) => fn(trx),
  };
  const tk = { run: async <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const ocr = { extractExpenseReceipt: async () => lectura(fecha, impresa) };
  const storage = { getDataUri: async () => 'data:image/jpeg;base64,AAAA' };
  const svc = new SolicitudGastoService(tk as never, {} as never, {} as never, {} as never, undefined, undefined, ocr as never, storage as never);
  (svc as unknown as { base: () => Promise<string> }).base = async () => '01';
  return { leer: () => svc.leerComprobante('01', { public_id: 'ticket.jpeg', kind: 'image' }), sql };
}

describe('[PGP.122.13] «Pedir un gasto»: la fecha leída con el año mal no se propone', () => {
  it('⭐ un año atrás: no se propone, lo leído se conserva para compararlo y NO se busca la factura del SAT', async () => {
    const { leer, sql } = pedirGasto(haceDias(365), '21/11/25');
    const r = await leer();
    expect(r.legible).toBe(true);
    expect(r.leido?.fecha).toBeNull();
    expect(r.leido?.fecha_impresa).toBe('21/11/25');
    expect(r.leido?.total).toBe(200);
    expect(sql.some((s) => s.q.includes('fiscal.cfdis'))).toBe(false);
  });

  it('de hace 10 días sí se propone, y con esa fecha se busca la factura (±5 días)', async () => {
    const f = haceDias(10);
    const { leer, sql } = pedirGasto(f, 'x');
    expect((await leer()).leido?.fecha).toBe(f);
    expect(sql.find((s) => s.q.includes('fiscal.cfdis'))?.b).toEqual(['AAA010101AAA', 200, f, f]);
  });

  it('a 31 días ya no (ésos además piden motivo: DS6)', async () => {
    expect((await pedirGasto(haceDias(31), 'x').leer()).leido?.fecha).toBeNull();
  });
});

function ligaDeCaptura(fecha: string | null) {
  const ocr = { extractExpenseReceipt: async () => lectura(fecha, 'x') };
  const svc = new ExpenseCaptureLinksService({} as never, {} as never, {} as never, {} as never, ocr as never);
  (svc as unknown as { resolveLink: () => Promise<unknown> }).resolveLink = async () => ({ persona: 'prueba' });
  return () => svc.leerTicketPreview('token', 'data:image/jpeg;base64,AAAA');
}

describe('[PGP.122.13] la liga de captura: la misma regla', () => {
  const llave = process.env['ANTHROPIC_API_KEY'];
  beforeAll(() => { process.env['ANTHROPIC_API_KEY'] = 'prueba'; });
  afterAll(() => { if (llave === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = llave; });

  it('⭐ con el año mal no se propone fecha (la pantalla se queda con cualquiera que no sea futura)', async () => {
    const r = await ligaDeCaptura(haceDias(365))();
    expect(r.legible).toBe(true);
    expect(r.fecha).toBeNull();
  });

  it('de hace 3 días, sí', async () => {
    const f = haceDias(3);
    expect((await ligaDeCaptura(f)()).fecha).toBe(f);
  });
});
