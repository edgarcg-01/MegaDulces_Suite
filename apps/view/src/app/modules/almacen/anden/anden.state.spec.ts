import { readFileSync } from 'fs';
import { join } from 'path';
import { AndenState, claveLote } from './anden.state';
import { ReceivingSession } from '../receiving-session.service';

/**
 * Candados del estado del Andén.
 *
 *  1. **La cola de fechado se vacía por la marca del SERVER**, no por un flag de
 *     pantalla. Si se derivara de memoria, un renglón cerrado desde otro equipo
 *     seguiría apareciendo pendiente acá.
 *  2. **Lo declarado se escribe en el renglón** (`received_qty`), o el cierre del
 *     vale reclama mercancía que sí llegó.
 *
 * `[WMS-REC.21]` La cola de ubicación y el put-away salieron del Andén: viven en
 * Ubicaciones (`pages/almacen-ubicaciones.component.ts`), sección «Por acomodar».
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

describe('Andén · identidad del lote', () => {
  it('la caducidad es parte de la identidad del lote', () => {
    // Dos tarimas del mismo producto y el mismo código de lote, con fechas
    // distintas, son DOS lotes: ubicarlas como una sola manda la cantidad al lote
    // equivocado y el auxiliar de ubicaciones queda mintiendo.
    const a = { product_id: 'p', lot_code: 'L1', expiry_date: '2027-03-31' };
    const b = { product_id: 'p', lot_code: 'L1', expiry_date: '2027-09-30' };
    expect(claveLote(a)).not.toBe(claveLote(b));
  });
});

describe('Andén · la cantidad recibida llega al renglón', () => {
  const FUENTE = readFileSync(join(__dirname, 'anden.component.ts'), 'utf8');

  it('la cantidad recibida se escribe en el renglón, o el cierre reclama lo que sí llegó', () => {
    // Sin paso de cotejo, si nadie escribe `received_qty` el cierre del vale marca
    // TODO como faltante y levanta reclamos por mercancía que sí llegó.
    expect(FUENTE).toMatch(/setLine\([^)]*received_qty/s);
  });
});
