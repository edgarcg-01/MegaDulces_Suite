import { describe, expect, it } from 'vitest';
import { ajustar, cambiosDe, cuentaDe, deshacer, motivoSugerido, quitar, renglonEditable, type Edicion } from './editar-pedido';

const PAQ = renglonEditable({ id: 'a', product_name: 'MAZAPAN', quantity: 24, qty_unit: 'PAQ', qty_factor: 12 }); // 2 PAQ
const KG = renglonEditable({ id: 'b', product_name: 'ALTOS CAM', quantity: 1, qty_unit: 'KG', qty_factor: 1 });
const BASE = renglonEditable({ id: 'c', product_name: 'SUELTO', quantity: 5, qty_unit: null, qty_factor: null });
const RARO = renglonEditable({ id: 'd', product_name: 'FUERA DE REJILLA', quantity: 7, qty_unit: 'CJA', qty_factor: 12 });

describe('[MCP.21] editar un pedido desde su tarjeta', () => {
  it('la cantidad se edita en la unidad en que se tomó, con su sello', () => {
    expect(PAQ).toMatchObject({ original: 2, unidad: 'PAQ', sello: { qty_unit: 'PAQ', qty_factor: 12 }, editable: true });
    expect(BASE).toMatchObject({ original: 5, unidad: 'PZA', sello: null, editable: true });
  });

  it('negativa: 7 piezas de una CJA de 12 no caen enteras: no se edita aquí (mandarlo en base borraría su unidad)', () => {
    expect(RARO.editable).toBe(false);
    expect(cambiosDe([RARO], { d: { cuenta: 1 } })).toEqual([]);
  });

  it('sube y baja de uno en uno, y nunca baja de 1 (para 0 está «Quitar»)', () => {
    let e: Edicion = {};
    e = ajustar(e, PAQ, 1);
    expect(cuentaDe(PAQ, e)).toBe(3);
    e = ajustar(ajustar(ajustar(e, PAQ, -1), PAQ, -1), PAQ, -1);
    expect(cuentaDe(PAQ, e)).toBe(1);
  });

  it('manda sólo lo que cambió: la cuenta EN su unidad con el sello, quitar como quitar; lo que volvió a su valor no viaja', () => {
    const e: Edicion = { a: { cuenta: 3 }, b: 'quitar', c: { cuenta: 5 } };
    expect(cambiosDe([PAQ, KG, BASE], e)).toEqual([
      { line_id: 'a', quantity: 3, qty_unit: 'PAQ', qty_factor: 12 },
      { line_id: 'b', remove: true },
    ]);
    expect(cambiosDe([BASE], { c: { cuenta: 6 } })).toEqual([{ line_id: 'c', quantity: 6 }]);
  });

  it('el motivo sugerido sale de lo que cambió', () => {
    expect(motivoSugerido([PAQ, KG], { a: { cuenta: 3 } })).toBe('agregar');
    expect(motivoSugerido([PAQ, KG], { b: 'quitar' })).toBe('quitar');
    expect(motivoSugerido([PAQ, KG], { a: { cuenta: 3 }, b: 'quitar' })).toBe('cantidad');
    expect(motivoSugerido([PAQ, KG], {})).toBeNull();
  });

  it('deshacer devuelve el renglón a lo que tiene el pedido', () => {
    const e = deshacer(quitar({}, KG), KG);
    expect(cuentaDe(KG, e)).toBe(1);
    expect(cambiosDe([KG], e)).toEqual([]);
  });
});
