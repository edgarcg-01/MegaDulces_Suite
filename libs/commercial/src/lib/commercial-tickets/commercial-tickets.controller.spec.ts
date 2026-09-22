import { CommercialTicketsController } from './commercial-tickets.controller';
import type { ReporteFiltros } from './customer-report.service';

/**
 * Candado del controller de tickets (TK.8) — la **traducción del query string a filtros**.
 *
 * Parece plomería y no lo es: acá un `''` que pasa como filtro, un `caja=abc` que se vuelve
 * `NaN` o un `solo_con_descuento=1` que no se reconoce **no fallan con un error** — devuelven
 * un reporte con otro alcance, y quien lo imprime no tiene cómo notarlo. Es el mismo modo de
 * falla que el resto de esta fase viene persiguiendo: el número equivocado, no la excepción.
 *
 * Y lo que NO se prueba acá, a propósito: el recorte por sucursal. Ése lo hace
 * `ScopeService.readParam()`, que ya interseca lo pedido con lo permitido y traduce UUIDs y los
 * 16 alias viejos. Lo que sí se comprueba es que el controller **le pase el query entero** y no
 * reimplemente el recorte por su cuenta — que fue exactamente el defecto que hubo que sacar.
 */

const filtros = async (raw: Record<string, string>): Promise<ReporteFiltros> => {
  let visto: ReporteFiltros | undefined;
  let queryQueVioElScope: Record<string, unknown> | undefined;

  const ctrl = new CommercialTicketsController(
    {} as never,
    {} as never,
    { reporte: (_code: string, f: ReporteFiltros) => { visto = f; return Promise.resolve(null); } } as never,
    { readParam: (q: Record<string, unknown>) => { queryQueVioElScope = q; return Promise.resolve(null); } } as never,
  );
  await ctrl.reporteCliente('10448', raw);
  // El scope tiene que recibir el query COMPLETO: es quien resuelve la sucursal.
  expect(queryQueVioElScope).toBe(raw);
  return visto as ReporteFiltros;
};

describe('los filtros vacíos no viajan', () => {
  /** ⚠️ Un `''` en el objeto de filtros se lee como "filtro puesto", no como "sin filtro". */
  it('las cadenas vacías llegan como undefined, no como ""', async () => {
    const f = await filtros({ date_from: '', date_to: '', folio: '', atendio: '', brand_id: '', supplier_id: '' });
    for (const k of ['from', 'to', 'folio', 'atendio', 'brand_id', 'supplier_id'] as const) {
      expect(f[k]).toBeUndefined();
    }
  });

  it('un query sin nada no inventa ningún filtro', async () => {
    const f = await filtros({});
    expect(f.from).toBeUndefined();
    expect(f.min).toBeUndefined();
    expect(f.caja).toBeUndefined();
    expect(f.solo_con_descuento).toBe(false);
  });
});

describe('los números', () => {
  it('llegan como número, no como texto', async () => {
    const f = await filtros({ min: '1000', max: '5000.5', caja: '5' });
    expect(f.min).toBe(1000);
    expect(f.max).toBe(5000.5);
    expect(f.caja).toBe(5);
  });

  /**
   * ⚠️ Lo que importa: `Number('abc')` es `NaN`, y un `NaN` en un `WHERE total >= ?` no falla —
   * descarta TODO. El reporte saldría vacío y parecería que el cliente no compró nada.
   */
  it('un número inválido se descarta, NO se manda como NaN', async () => {
    const f = await filtros({ min: 'abc', max: '', caja: 'x' });
    expect(f.min).toBeUndefined();
    expect(f.max).toBeUndefined();
    expect(f.caja).toBeUndefined();
  });

  /** El cero es un importe legítimo (un documento de $0.00 existe): no puede caer como vacío. */
  it('el cero sobrevive', async () => {
    const f = await filtros({ min: '0', caja: '0' });
    expect(f.min).toBe(0);
    expect(f.caja).toBe(0);
  });
});

describe('la bandera de descuento', () => {
  it('sólo el literal "true" la prende', async () => {
    expect((await filtros({ solo_con_descuento: 'true' })).solo_con_descuento).toBe(true);
  });

  /** Si aceptara cualquier cosa, un `?solo_con_descuento=false` prendería el filtro. */
  it('cualquier otra cosa la deja apagada', async () => {
    for (const v of ['false', '1', 'si', '']) {
      expect((await filtros({ solo_con_descuento: v })).solo_con_descuento).toBe(false);
    }
  });
});

describe('lo que el controller NO hace', () => {
  /**
   * ⛔ Hubo un segundo filtro de sucursal acá, reimplementando lo que `ScopeService` ya hace.
   * Este candado impide que vuelva: la sucursal no puede aparecer en los filtros del servicio.
   */
  it('no arma un filtro de sucursal por su cuenta', async () => {
    const f = await filtros({ warehouse_codes: '05' });
    expect(Object.keys(f)).not.toContain('sucursal');
  });

  it('el folio pasa tal cual: el "contiene" lo resuelve el servicio', async () => {
    expect((await filtros({ folio: '6440' })).folio).toBe('6440');
  });
});
