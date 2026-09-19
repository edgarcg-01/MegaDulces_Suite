import { readFileSync } from 'fs';
import { join } from 'path';
import { AndenState, claveLote } from './anden.state';
import { ReceivingSession } from '../receiving-session.service';
import { UnlocatedLot } from '../bin-location.service';

/**
 * Candados del Andén tras el rediseño **folio → fechas → ubicación**.
 *
 * Los tres que importan, y por qué cada uno:
 *
 *  1. **La cola de fechado se vacía por la marca del SERVER**, no por un flag de
 *     pantalla. Si se derivara de memoria, un renglón cerrado desde otro equipo
 *     seguiría apareciendo pendiente acá.
 *  2. **La cola de ubicación sale de `/unlocated` y se acota a los productos del
 *     vale.** Ese endpoint contesta por ALMACÉN: sin el filtro, el andén
 *     arrastraría pendientes de recepciones de otros días.
 *  3. **El put-away manda lote y caducidad.** Es el defecto que este rediseño
 *     destapó: antes mandaba sólo producto y cantidad, o sea el lote `NA`, y
 *     fechar RECLASIFICA `NA` al lote real — así que con el fechado por delante
 *     el put-away moría con "El lote no existe en stock". Se verifica sobre el
 *     código fuente porque el payload se arma en el orquestador, no en una
 *     función pura, y el defecto es una OMISIÓN: un test de comportamiento que no
 *     mire el payload pasa igual sin los campos.
 */

function vale(lines: Partial<ReceivingSession['lines'][number]>[]): ReceivingSession {
  return {
    id: 'v1', folio: 'PD-1', warehouse_id: 'w1', source_kind: 'erp_receipt', status: 'open',
    lines: lines.map((l, i) => ({
      id: l.id ?? `l${i}`,
      product_id: l.product_id ?? `p${i}`,
      expected_qty: l.expected_qty ?? 0,
      received_qty: l.received_qty ?? 0,
      discrepancy_kind: l.discrepancy_kind ?? 'pending',
      declared_qty: l.declared_qty ?? 0,
      held_qty: l.held_qty ?? 0,
      ...l,
    })),
  } as unknown as ReceivingSession;
}

function unlocated(rows: Partial<UnlocatedLot>[]): UnlocatedLot[] {
  return rows.map((r) => ({
    warehouse_id: 'w1', product_id: r.product_id ?? 'p0', lot_code: r.lot_code ?? 'L1',
    expiry_date: r.expiry_date ?? null, lot_qty: r.lot_qty ?? 0, located: r.located ?? 0,
    to_locate: r.to_locate ?? 0, ...r,
  })) as UnlocatedLot[];
}

describe('Andén · cola de fechado', () => {
  it('un renglón pendiente espera lo que manda Kepler menos lo ya declarado', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([{ expected_qty: 24, declared_qty: 10 }]));
    expect(s.pendientesFechar().length).toBe(1);
    expect(s.lineas()[0].faltaFechar).toBe(14);
  });

  it('lo retenido por un rojo NO vuelve a pedir fecha', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([{ expected_qty: 24, declared_qty: 10, held_qty: 14 }]));
    expect(s.pendientesFechar()).toEqual([]);
  });

  it('un renglón cerrado sale de la cola aunque se haya declarado de menos', () => {
    // Es el caso "ya no llegó más": Kepler manda 24, llegaron 10, el renglón se
    // cierra con 10 y queda faltante. Si siguiera en la cola, el vale no cerraría
    // nunca y el reclamo del faltante no se levantaría.
    const s = new AndenState();
    s.cargarDesdeVale(vale([
      { expected_qty: 24, declared_qty: 10, received_qty: 10, discrepancy_kind: 'faltante' },
    ]));
    expect(s.pendientesFechar()).toEqual([]);
    expect(s.lineas()[0].faltaFechar).toBe(0);
    expect(s.diferencias()).toBe(1);
  });

  it('un renglón que cuadra con Kepler no cuenta como diferencia', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([
      { expected_qty: 24, declared_qty: 24, received_qty: 24, discrepancy_kind: 'ok' },
    ]));
    expect(s.diferencias()).toBe(0);
    expect(s.unidades()).toBe(24);
  });
});

describe('Andén · cola de ubicación', () => {
  it('sólo entran los lotes de los productos de ESTE vale', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([{ product_id: 'pA' }]));
    s.cargarLotes(unlocated([
      { product_id: 'pA', lot_code: 'L1', to_locate: 12 },
      // De otra recepción del mismo almacén: no es trabajo de este vale.
      { product_id: 'pZ', lot_code: 'L9', to_locate: 99 },
    ]));
    expect(s.pendientesUbicar().map((l) => l.product_id)).toEqual(['pA']);
  });

  it('un lote sin nada por acomodar no es cola', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([{ product_id: 'pA' }]));
    s.cargarLotes(unlocated([{ product_id: 'pA', lot_code: 'L1', to_locate: 0 }]));
    expect(s.pendientesUbicar()).toEqual([]);
  });

  it('la caducidad es parte de la identidad del lote', () => {
    // Dos tarimas del mismo producto y el mismo código de lote, con fechas
    // distintas, son DOS lotes: ubicarlas como una sola manda la cantidad al lote
    // equivocado y el auxiliar de ubicaciones queda mintiendo.
    const a = { product_id: 'p', lot_code: 'L1', expiry_date: '2027-03-31' };
    const b = { product_id: 'p', lot_code: 'L1', expiry_date: '2027-09-30' };
    expect(claveLote(a)).not.toBe(claveLote(b));
  });

  it('el rack sugerido sobrevive a recargar la cola', () => {
    const s = new AndenState();
    s.cargarDesdeVale(vale([{ product_id: 'pA' }]));
    const filas = unlocated([{ product_id: 'pA', lot_code: 'L1', to_locate: 12 }]);
    s.cargarLotes(filas);
    s.parchearLote(claveLote(s.lotes()[0]), { binSugerido: 'R-12' });
    s.cargarLotes(filas);
    expect(s.lotes()[0].binSugerido).toBe('R-12');
  });
});

describe('Andén · el put-away lleva el lote exacto', () => {
  const FUENTE = readFileSync(join(__dirname, 'anden.component.ts'), 'utf8');

  it('el payload incluye lot_code y expiry_date del lote', () => {
    // Sin estos dos campos el backend cae en el lote NA, que ya no existe después
    // de fechar: el guardado devuelve "El lote no existe en stock".
    const bloque = FUENTE.slice(FUENTE.indexOf('putAway({'));
    expect(bloque).toMatch(/lot_code:\s*u\.lote\.lot_code/);
    expect(bloque).toMatch(/expiry_date:\s*u\.lote\.expiry_date/);
  });

  it('la cantidad recibida se escribe en el renglón, o el cierre reclama lo que sí llegó', () => {
    // Sin paso de cotejo, si nadie escribe `received_qty` el cierre del vale marca
    // TODO como faltante y levanta reclamos por mercancía que sí llegó.
    expect(FUENTE).toMatch(/setLine\([^)]*received_qty/s);
  });
});
