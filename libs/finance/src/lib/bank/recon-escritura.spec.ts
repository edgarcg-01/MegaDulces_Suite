import { describe, expect, it } from 'vitest';
import { huellaPareos, llavePareo, planEscritura, type PareoFila } from './recon-escritura';

const p = (mov: string, folio: string, extra: Partial<PareoFila> = {}): PareoFila => ({
  bank_movement_id: mov, kepler_sucursal: '01', kepler_doc_tipo: 'X-D-26', kepler_doc_folio: folio,
  kepler_cuenta: 'BBVA', kepler_amount: 100, match_type: 'inferred', match_confidence: 0.95, matched_by: 'motor-tes', ...extra,
});

describe('[CB.74] la conciliación escribe sólo lo que cambió', () => {
  it('⛔ una corrida idéntica a lo guardado no escribe NADA (el ciclo del aviso)', () => {
    const guardados = [{ ...p('m1', 'F1'), id: 'r1' }, { ...p('m2', 'F2'), id: 'r2' }];
    const nuevos = [p('m1', 'F1'), p('m2', 'F2')];
    const estados = new Map([['m1', 'matched'], ['m2', 'matched'], ['m3', 'unmatched']]);
    const plan = planEscritura(guardados, nuevos, estados, new Set(['m1', 'm2']));
    expect(plan).toEqual({ borrar: [], insertar: [], aMatched: [], aUnmatched: [], intactos: 2 });
  });

  it('pg manda numeric como texto: «100.00» y 100 son el mismo pareo', () => {
    const guardados = [{ ...p('m1', 'F1', { kepler_amount: '100.00', match_confidence: '0.95' }), id: 'r1' }];
    const plan = planEscritura(guardados, [p('m1', 'F1')], new Map([['m1', 'matched']]), new Set(['m1']));
    expect(plan.borrar).toEqual([]);
    expect(plan.insertar).toEqual([]);
  });

  it('un pareo que cambia de documento se borra y se inserta; el resto no se toca', () => {
    const guardados = [{ ...p('m1', 'F1'), id: 'r1' }, { ...p('m2', 'F2'), id: 'r2' }];
    const nuevos = [p('m1', 'F1'), p('m2', 'F9')];
    const plan = planEscritura(guardados, nuevos, new Map([['m1', 'matched'], ['m2', 'matched']]), new Set(['m1', 'm2']));
    expect(plan.borrar).toEqual(['r2']);
    expect(plan.insertar.map((x) => x.kepler_doc_folio)).toEqual(['F9']);
    expect(plan.aMatched).toEqual([]);
    expect(plan.intactos).toBe(1);
  });

  it('cambia la confianza o el pase = cambia el pareo (la llave es completa)', () => {
    const guardados = [{ ...p('m1', 'F1'), id: 'r1' }];
    const plan = planEscritura(guardados, [p('m1', 'F1', { match_confidence: 0.7, matched_by: 'motor-tes-tol' })],
      new Map([['m1', 'matched']]), new Set(['m1']));
    expect(plan.borrar).toEqual(['r1']);
    expect(plan.insertar).toHaveLength(1);
  });

  it('estados: sólo se escriben los que cambian; pending e ignored pasan a unmatched como antes', () => {
    const estados = new Map<string, string | null>([['a', 'matched'], ['b', 'unmatched'], ['c', 'pending'], ['d', 'ignored'], ['e', 'unmatched']]);
    const plan = planEscritura([], [p('e', 'F1')], estados, new Set(['a', 'e']));
    expect(plan.aMatched).toEqual(['e']);
    expect(plan.aUnmatched.sort()).toEqual(['c', 'd']);
  });

  it('un pareo guardado de un movimiento que ya no casa se borra', () => {
    const plan = planEscritura([{ ...p('m1', 'F1'), id: 'r1' }], [], new Map([['m1', 'matched']]), new Set());
    expect(plan.borrar).toEqual(['r1']);
    expect(plan.aUnmatched).toEqual(['m1']);
  });

  it('control: la llave distingue sucursal (dos plazas con el mismo folio son dos documentos)', () => {
    expect(llavePareo(p('m1', 'F1', { kepler_sucursal: '01' }))).not.toBe(llavePareo(p('m1', 'F1', { kepler_sucursal: '08' })));
  });

  it('la huella no depende del orden y sí del contenido', () => {
    const a = [p('m1', 'F1'), p('m2', 'F2')];
    expect(huellaPareos(a)).toBe(huellaPareos([a[1], a[0]]));
    expect(huellaPareos(a)).not.toBe(huellaPareos([p('m1', 'F1'), p('m2', 'F3')]));
  });
});
