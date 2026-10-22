/**
 * `[CGA-A.48]` — Lo que Control contó y está en la caja fuerte. Las negativas importan más que la
 * positiva: una atribución de más esconde un faltante del cajón detrás de un depósito a CAOS.
 */
import { depositosEnElExceso, excesoDeBilletes, type DepositoCaos } from './caja-cajon-caos.engine';

const dep = (id: string, billetes: Record<string, number>, con_monedas = false): DepositoCaos => ({
  id, dia: '2026-10-19', hora: '14:12', ref: null, con_monedas, billetes,
  total: Object.entries(billetes).reduce((s, [d, n]) => s + Number(d) * n, 0),
});

describe('excesoDeBilletes', () => {
  it('sólo lo que Control contó DE MÁS', () => {
    // Caso real: A23678 contra el cierre CC-2026-00007.
    const e = excesoDeBilletes(
      { '1000': 1, '500': 401, '200': 351, '100': 154, '20': 50 },
      { '500': 1, '200': 350, '100': 154, '20': 50 },
    );
    expect(e).toEqual({ '1000': 1, '500': 400, '200': 1 });
  });
});

describe('depositosEnElExceso', () => {
  it('el caso real: 400 × $500 son el depósito «caja ahorro» #1646, y quedan $1,200 sin explicar', () => {
    const r = depositosEnElExceso({ '1000': 1, '500': 400, '200': 1 }, [dep('1646', { '500': 400 })]);
    expect(r.en_caos.map((d) => d.id)).toEqual(['1646']);
    expect(r.resto).toEqual({ '1000': 1, '200': 1 });
  });

  it('NEGATIVA: un depósito que no cabe ENTERO no se atribuye', () => {
    const r = depositosEnElExceso({ '500': 399 }, [dep('1646', { '500': 400 })]);
    expect(r.en_caos).toEqual([]);
    expect(r.resto).toEqual({ '500': 399 });
  });

  it('NEGATIVA: una denominación que Control no contó de más bloquea el depósito', () => {
    const r = depositosEnElExceso({ '500': 400 }, [dep('9', { '500': 400, '20': 1 })]);
    expect(r.en_caos).toEqual([]);
  });

  it('NEGATIVA: un depósito con monedas no se explica sólo con billetes', () => {
    const r = depositosEnElExceso({ '500': 400 }, [dep('9', { '500': 400 }, true)]);
    expect(r.en_caos).toEqual([]);
  });

  it('sin exceso no hay nada que atribuir', () => {
    expect(depositosEnElExceso({}, [dep('1', { '500': 1 })]).en_caos).toEqual([]);
  });

  it('el grande primero: uno chico no se come los billetes del que explica el exceso entero', () => {
    const r = depositosEnElExceso({ '500': 400 }, [dep('chico', { '500': 10 }), dep('grande', { '500': 400 })]);
    expect(r.en_caos.map((d) => d.id)).toEqual(['grande']);
    expect(r.resto).toEqual({});
  });
});
