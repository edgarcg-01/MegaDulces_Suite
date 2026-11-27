/**
 * `[PQ.160]` Editar cantidades de una OC de Kepler. Control con respuesta conocida: la OC 00-0007492 (SALSA MAGA)
 * pasó a mano el 2026-11-26 de 120 a 132 cajas en sus 4 renglones, y Kepler quedó en $120,007.80 (verificado como
 * `kepler_push`). La regla tiene que llegar a lo mismo.
 */
import { decidirEdicionOc, permisosEdicion, revisarOcEditable, sentenciasEdicion, type EntradaEdicion, type RenglonOcKepler } from './kepler-oc-edicion';

const ren = (renglon: number, sku: string, costo: number, p: Partial<RenglonOcKepler> = {}): RenglonOcKepler => ({
  renglon, sku, nombre: `SALSA ${sku}`, unidad: 'CJA', cantidad_base: 120, costo_base: costo,
  importe: Math.round(120 * costo * 100) / 100, iva: 0, ieps: 0, pendiente: 120, c31: 120, c51: '', c56: '120', factor: 1, ...p,
});
const oc7492 = (p: Partial<EntradaEdicion['oc']> = {}, renglones?: RenglonOcKepler[]): EntradaEdicion => {
  const rs = renglones ?? [ren(1, '99069', 223.98), ren(2, '99124', 276.01), ren(3, '99125', 204.58), ren(4, '99126', 204.58)];
  return {
    oc: { serie: '1', folio: '0007492', estado: 'N', descuento: 0, iva: 0, ieps: 0, total: 109098, saldo: 109098, renglones: rs, ...p },
    coincidencias: 1, vales_vivos: [],
  };
};
const mas12 = [1, 2, 3, 4].map((renglon) => ({ renglon, cantidad: 132 }));

describe('[PQ.160] editar cantidades de una OC', () => {
  it('CONTROL: la 0007492 de 120 a 132 cajas da lo mismo que quedó en Kepler', () => {
    const d = decidirEdicionOc('00', oc7492(), mas12);
    if (!d.ok) throw new Error(d.motivo);
    expect(d.plan.total).toBe(120007.8);
    expect(d.plan.renglones.map((r) => r.importe_despues)).toEqual([29565.36, 36433.32, 27004.56, 27004.56]);
    expect(d.plan.renglones.every((r) => r.base_despues === 132 && r.c56_despues === '132' && r.con_c31 && !r.con_c51)).toBe(true);
  });

  it('con impuestos: IVA e IEPS se recalculan por renglón, como Kepler', () => {
    const rs = [ren(1, 'A', 100, { iva: 16 }), ren(2, 'B', 50, { ieps: 8 })];
    const d = decidirEdicionOc('00', oc7492({ total: 12000 + 1920 + 6000 + 480, saldo: 20400 }, rs), [{ renglon: 2, cantidad: 60 }]);
    if (!d.ok) throw new Error(d.motivo);
    expect(d.plan.iva).toBe(1920);
    expect(d.plan.ieps).toBe(240);
    expect(d.plan.total).toBe(12000 + 1920 + 3000 + 240);
  });

  it('presentación con empaque: la cantidad va en cajas y c9 en piezas', () => {
    const rs = [ren(1, 'P', 10, { cantidad_base: 240, importe: 2400, pendiente: 240, c31: 240, c56: '20', c51: '20', factor: 12 })];
    const d = decidirEdicionOc('00', oc7492({ total: 2400, saldo: 2400 }, rs), [{ renglon: 1, cantidad: 25 }]);
    if (!d.ok) throw new Error(d.motivo);
    expect(d.plan.renglones[0]).toMatchObject({ antes: 20, despues: 25, base_despues: 300, importe_despues: 3000, con_c51: true, c56_despues: '25' });
  });

  it('NEGATIVAS de la OC: no pendiente, con vale, con algo recibido, saldo ≠ total, descuento, total fuera de fórmula', () => {
    expect(revisarOcEditable(oc7492({ estado: 'R' })).ok).toBe(false);
    expect(revisarOcEditable({ ...oc7492(), vales_vivos: ['0010500'] }).ok).toBe(false);
    expect(revisarOcEditable(oc7492({}, [ren(1, 'X', 10, { pendiente: 100 })])).ok).toBe(false);
    expect(revisarOcEditable(oc7492({ saldo: 1000 })).ok).toBe(false);
    expect(revisarOcEditable(oc7492({ descuento: 50 })).ok).toBe(false);
    expect(revisarOcEditable(oc7492({ total: 109000 })).ok).toBe(false);
    expect(revisarOcEditable(oc7492({}, [ren(1, 'X', 10, { importe: 1100, cantidad_base: 120 })])).ok).toBe(false);
    expect(revisarOcEditable(oc7492({}, [ren(1, 'X', 10, { c56: '10', factor: 1 })])).ok).toBe(false);
    expect(revisarOcEditable({ oc: null, coincidencias: 0, vales_vivos: [] }).ok).toBe(false);
    expect(revisarOcEditable({ ...oc7492(), coincidencias: 2 }).ok).toBe(false);
  });

  it('NEGATIVAS de los cambios: cero, negativa, renglón ajeno, repetido, nada distinto', () => {
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: 0 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: -5 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 9, cantidad: 10 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: 130 }, { renglon: 1, cantidad: 131 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: 120 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), []).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: 132.555 }]).ok).toBe(false);
    expect(decidirEdicionOc('00', oc7492(), [{ renglon: 1, cantidad: 132.5 }]).ok).toBe(true);
  });

  it('las sentencias repiten lo leído en el WHERE y piden sólo los permisos que usan', () => {
    const d = decidirEdicionOc('00', oc7492(), [{ renglon: 2, cantidad: 132 }]);
    if (!d.ok) throw new Error(d.motivo);
    const s = sentenciasEdicion(d.plan);
    expect(s).toHaveLength(2);
    expect(s[0].sql).toMatch(/round\(c9::numeric, 4\) = \$8::numeric/);
    expect(s[0].params).toEqual(['00', '1', '0007492', 2, 132, 36433.32, '132', 120, 33121.2, '120']);
    expect(s[1].sql).toMatch(/btrim\(c43\) = 'N'/);
    expect(s[1].params).toEqual(['00', '1', '0007492', 0, 0, 112410.12, 109098, 109098]);
    expect(permisosEdicion(d.plan).some((x) => x.includes("'c31'"))).toBe(true);
    expect(permisosEdicion(d.plan).some((x) => x.includes("'c51'"))).toBe(false);
  });
});
