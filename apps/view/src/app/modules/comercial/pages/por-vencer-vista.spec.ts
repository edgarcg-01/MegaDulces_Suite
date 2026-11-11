import {
  confianzaLote, juicioPorLote, proponeMover, resumenConfianza, tandasDeProductos, textoConfianza, textoMover,
} from './por-vencer-vista';
import type { LoteCaducidad } from '../../compras/productos-flujo.service';

const J = (over: Partial<LoteCaducidad> = {}): LoteCaducidad => ({
  lot_id: 'lot-a', plaza: '01', nombre: 'Padre Hidalgo', lote: 'L1', caduca: '2026-11-30', dias: 19, registrado: 300,
  en_existencia: 300, se_vende_antes: 200, queda: 100, estado: 'no_alcanza',
  accion: 'Aquí no se alcanza a vender antes de que caduque: moverlo a donde sí se vende', mover_a: [], sin_destino: 0, escalera: null,
  ...over,
});

describe('[CE.1.4] Por vencer: ¿se puede creer la cantidad del lote?', () => {
  it('⭐ con existencia sin fecha (NA) dice que puede estar ya vendido, con cuánto hay sin fecha', () => {
    const l = { dated_may_be_stale: true, na_qty: '1250' };
    expect(confianzaLote(l)).toBe('vendido');
    expect(textoConfianza(l)).toBe(
      'Puede estar ya vendido: hay 1,250 sin fecha de este producto en este almacén y la venta descuenta primero lo sin fecha');
  });

  it('sin NA la cantidad se puede creer: no se dice nada', () => {
    expect(confianzaLote({ dated_may_be_stale: false })).toBe('cierta');
    expect(textoConfianza({ dated_may_be_stale: false, na_qty: 0 })).toBeNull();
  });

  it('⛔ un servidor que no manda la marca (o NA no leído) NUNCA se pinta como cierto', () => {
    expect(confianzaLote({})).toBe('sin_dato');
    expect(confianzaLote({ dated_may_be_stale: null })).toBe('sin_dato');
    expect(textoConfianza({ dated_may_be_stale: null, na_qty: null })).toBe('No se pudo comprobar si ya se vendió');
  });

  it('el resumen cuenta cada situación y el valor que no es seguro', () => {
    const r = resumenConfianza([
      { dated_may_be_stale: true, value_at_cost: '100.5' },
      { dated_may_be_stale: true, value_at_cost: 50 },
      { dated_may_be_stale: false, value_at_cost: 999 },
      { dated_may_be_stale: null, value_at_cost: null as unknown as number },
    ]);
    expect(r).toEqual({ total: 4, vendido: 2, sinDato: 1, valorIncierto: 150.5 });
  });
});

describe('[CE.3.1] Por vencer: qué hacer, con el juicio de juzgarLotes', () => {
  it('pide los productos sin repetir y en tandas de 200', () => {
    const lots = Array.from({ length: 450 }, (_, i) => ({ product_id: `p${i % 401}` }));
    const t = tandasDeProductos(lots);
    expect(t.map((x) => x.length)).toEqual([200, 200, 1]);
    expect(tandasDeProductos([])).toEqual([]);
  });

  it('⭐ casa el juicio con su renglón por el id del lote; sin id no se adivina', () => {
    const m = juicioPorLote([{ productos: [{ product_id: 'p', lotes: [J(), J({ lot_id: null, caduca: '2027-01-01' })] }] }]);
    expect([...m.keys()]).toEqual(['lot-a']);
    expect(m.get('lot-a')?.estado).toBe('no_alcanza');
  });

  it('⛔ mover nombra la sucursal, jamás «02» (y si el servidor no trae nombre, el resolvedor común)', () => {
    expect(textoMover(J({ mover_a: [{ plaza: '02', nombre: 'La Piedad Abastos', cantidad: 100 }] })))
      .toBe('Mover 100 a La Piedad Abastos');
    const t = textoMover(J({ mover_a: [{ plaza: '07', nombre: null, cantidad: 60 }, { plaza: '02', nombre: 'La Piedad Abastos', cantidad: 40 }] }));
    expect(t).toBe('Mover 60 a Morelia Madero y 40 a La Piedad Abastos');
    expect(t).not.toMatch(/\b0\d\b/);
  });

  it('sin destinos no propone mover (promover o devolver lo dice la acción)', () => {
    expect(textoMover(J())).toBeNull();
    expect(proponeMover(J())).toBe(false);
    expect(proponeMover(null)).toBe(false);
    expect(proponeMover(J({ mover_a: [{ plaza: '02', nombre: 'La Piedad Abastos', cantidad: 1 }] }))).toBe(true);
  });
});
