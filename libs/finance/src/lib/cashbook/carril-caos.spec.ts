import type { MovimientoCaos } from './identidad';
import { planDeCaos, puntoDeApertura } from './carril-caos';

/** `[LE.3.3]` El carril toma la máquina en orden y se detiene en el primer hueco (B41). */
const m = (id: number): MovimientoCaos => ({ device: 'AST', external_id: String(id), type_id: 0, type_label: 'Deposito',
  occurred_at: '2026-10-20T10:00:00Z', total: '0', ref: null, user_external: null, piezas: [] });

describe('[LE.3.3] el plan del carril de la máquina', () => {
  it('toma los contiguos después del último procesado, sin importar el orden en que lleguen', () => {
    const p = planDeCaos([m(1610), m(1608), m(1609), m(1607)], 1607);
    expect(p.aAsentar.map((x) => x.external_id)).toEqual(['1608', '1609', '1610']);
    expect(p.hueco).toBeNull();
  });

  it('NEGATIVA: un hueco detiene el plan ANTES del hueco y lo declara', () => {
    const p = planDeCaos([m(1608), m(1609), m(1612)], 1607);
    expect(p.aAsentar.map((x) => x.external_id)).toEqual(['1608', '1609']);
    expect(p.hueco).toEqual({ desde: 1610, hasta: 1611 });
  });

  it('NEGATIVA: si falta el siguiente, no se toma nada', () => {
    expect(planDeCaos([m(1609)], 1607)).toEqual({ aAsentar: [], hueco: { desde: 1608, hasta: 1608 } });
  });

  it('el punto de apertura es «equipo:id»; cualquier otra cosa es no tenerlo', () => {
    expect(puntoDeApertura('AST700-19758:1607')).toEqual({ equipo: 'AST700-19758', desde: 1607 });
    for (const malo of [undefined, '', '1607', 'AST700-19758', 'AST700-19758:abc', 'a b:1']) expect(puntoDeApertura(malo)).toBeNull();
  });
});
