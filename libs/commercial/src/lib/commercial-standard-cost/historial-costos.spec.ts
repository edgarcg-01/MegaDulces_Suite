import { describe, expect, it } from 'vitest';
import { EntradaCruda, MuestraEstandar, cambiosEstandar, estandarEn, limpiarPicos, trazarEntradas } from './historial-costos';

const m = (sucursal: string, fecha: string, costo: number): MuestraEstandar => ({ sucursal, fecha, costo });
const e = (over: Partial<EntradaCruda>): EntradaCruda => ({
  fecha: '2026-09-01',
  sucursal_registro: '01',
  plaza: '01',
  folio: 'XA2001-1',
  proveedor: 'Proveedor A',
  unidad: 'CJA',
  cantidad: 2,
  costo: 1436.8,
  factor: 20,
  ...over,
});

describe('[CAT-COSTO.5] historial de costos', () => {
  describe('cambios del costo estándar (derivado de la venta)', () => {
    it('detecta el escalón y su fecha por sucursal', () => {
      const r = cambiosEstandar([
        m('01', '2026-06-01', 69.9),
        m('01', '2026-06-10', 69.9),
        m('01', '2026-06-14', 71.84),
        m('03', '2026-06-14', 69.9),
      ]);
      expect(r).toEqual([{ sucursal: '01', fecha: '2026-06-14', antes: 69.9, despues: 71.84, cambio_pct: 2.78 }]);
    });

    it('[negativa] un pico de un solo día (A, B, A) NO es un cambio de ficha', () => {
      const serie = [m('01', '2026-06-01', 50), m('01', '2026-06-02', 500), m('01', '2026-06-03', 50)];
      expect(limpiarPicos(serie)).toHaveLength(2);
      expect(cambiosEstandar(serie)).toEqual([]);
    });

    it('diferencias dentro de 0.5 % no son cambio', () => {
      expect(cambiosEstandar([m('01', '2026-06-01', 100), m('01', '2026-06-02', 100.3)])).toEqual([]);
    });

    it('el estándar vigente en una fecha es el de la última venta en o antes de ese día', () => {
      const s = [m('01', '2026-03-03', 69.9), m('01', '2026-06-14', 71.84)];
      expect(estandarEn(s, '01', '2026-06-10')).toBe(69.9);
      expect(estandarEn(s, '01', '2026-06-14')).toBe(71.84);
      expect(estandarEn(s, '01', '2026-01-01')).toBeNull();
      expect(estandarEn(s, '02', '2026-06-14')).toBeNull();
    });
  });

  describe('entradas contra el estándar de ese día', () => {
    const ventas = [m('01', '2026-03-03', 69.9), m('01', '2026-06-14', 71.84)];

    it('convierte la caja a pieza y compara contra el estándar que tenía la plaza ESE día', () => {
      const [t] = trazarEntradas([e({ fecha: '2026-06-10', costo: 1398, factor: 20 })], ventas);
      expect(t.costo_base).toBe(69.9);
      expect(t.estandar_vigente).toBe(69.9);
      expect(t.veredicto).toBe('apegada');
    });

    it('arriba y abajo con su porcentaje', () => {
      const [a, b] = trazarEntradas(
        [e({ fecha: '2026-09-22', folio: 'A', costo: 1511.6 }), e({ fecha: '2026-09-23', folio: 'B', costo: 1300 })],
        ventas,
      );
      expect(a.veredicto).toBe('arriba');
      expect(a.vs_estandar_pct).toBe(5.21); // 75.58 / 71.84
      expect(b.veredicto).toBe('abajo');
    });

    it('el cambio de entrada se mide contra la entrada anterior de la MISMA plaza', () => {
      const t = trazarEntradas(
        [
          e({ fecha: '2026-08-30', folio: '1', plaza: '01', costo: 1473.4 }),
          e({ fecha: '2026-09-02', folio: '2', plaza: '03', costo: 1497 }),
          e({ fecha: '2026-09-22', folio: '3', plaza: '01', costo: 1511.6 }),
        ],
        ventas,
      );
      expect(t[0].antes).toBeUndefined();
      expect(t[0].cambio).toBe(true);
      expect(t[1].antes).toBeUndefined();
      expect(t[2].antes).toBe(73.67);
      expect(t[2].cambio_pct).toBe(2.59); // 75.58 / 73.67
    });

    it('una entrada igual a la anterior no es cambio', () => {
      const t = trazarEntradas(
        [e({ fecha: '2026-09-01', folio: '1' }), e({ fecha: '2026-09-12', folio: '2' })],
        ventas,
      );
      expect(t[1].cambio).toBe(false);
    });

    it('sin cargo: costo 0 se declara aparte y no se vuelve la referencia de la siguiente', () => {
      const t = trazarEntradas(
        [e({ fecha: '2026-09-01', folio: '1' }), e({ fecha: '2026-09-02', folio: '2', costo: 0 }), e({ fecha: '2026-09-03', folio: '3' })],
        ventas,
      );
      expect(t[1].veredicto).toBe('sin_cargo');
      expect(t[2].antes).toBe(71.84);
      expect(t[2].cambio).toBe(false);
    });

    it('[negativa] lo que no se puede comparar se declara con su motivo, nunca como apegada', () => {
      const [sinPlaza] = trazarEntradas([e({ fecha: '2026-09-01', plaza: null })], ventas);
      const [sinUnidad] = trazarEntradas([e({ fecha: '2026-09-02', factor: null, unidad: 'BULTO' })], ventas);
      const [sinPrevio] = trazarEntradas([e({ fecha: '2026-01-01' })], ventas);
      expect(sinPlaza.motivo).toBe('sin_plaza');
      expect(sinUnidad.motivo).toBe('unidad_sin_resolver');
      expect(sinPrevio.motivo).toBe('sin_estandar_previo');
      for (const x of [sinPlaza, sinUnidad, sinPrevio]) expect(x.veredicto).toBe('no_comparable');
    });
  });
});
