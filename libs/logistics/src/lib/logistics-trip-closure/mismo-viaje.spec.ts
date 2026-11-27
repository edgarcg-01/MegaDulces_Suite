import type { RenglonDelReparto } from '@megadulces/contracts';
import { consolidarMismoViaje } from './trip-closure.service';

// [CML.J] D17 opción A: el MISMO viaje físico (confirmado) se paga UNA vez.

const r = (persona_id: string, concepto: RenglonDelReparto['concepto'], importe: number, fuente: RenglonDelReparto['fuente'] = 'captura'): RenglonDelReparto => ({
  persona_id, persona: persona_id.toUpperCase(), rol: concepto === 'carga' ? 'cargador' : persona_id.startsWith('ch') ? 'chofer' : 'ayudante',
  concepto, codigo: '054', nombre_concepto: 'PRUEBA', importe, fuente, calculo: 'CALCULO',
});

describe('[CML.J] consolidarMismoViaje', () => {
  it('cada persona cobra la comisión MAYOR y un solo viático; la carga sigue por guía', () => {
    const out = consolidarMismoViaje([
      // El par real de prod 06/0001695 + 0001696 (montos de prueba): la 1696 tiene la ruta mayor.
      { clave: '06|0001695', liga: null, renglones: [r('ch1', 'comision', 100), r('ch1', 'viatico', 80), r('ay1', 'comision', 60), r('ay1', 'viatico', 80), r('c1', 'carga', 30)] },
      { clave: '06|0001696', liga: '06|0001695', renglones: [r('ch1', 'comision', 150), r('ch1', 'viatico', 80), r('ay1', 'comision', 90), r('ay1', 'viatico', 80), r('c1', 'carga', 12)] },
    ]);
    const a = out.get('06|0001695')!;
    const b = out.get('06|0001696')!;
    // Comisión: sólo la mayor (la 1696), con su porqué.
    expect(a.renglones.filter((x) => x.concepto === 'comision')).toEqual([]);
    expect(b.renglones.filter((x) => x.concepto === 'comision').map((x) => [x.persona_id, x.importe])).toEqual([['ch1', 150], ['ay1', 90]]);
    expect(b.renglones.find((x) => x.persona_id === 'ch1' && x.concepto === 'comision')!.calculo)
      .toBe('CALCULO · Mismo viaje que la guía 0001695: se paga una sola vez (la ruta mayor)');
    // Viático: uno solo (empate → la primera guía).
    expect(a.renglones.filter((x) => x.concepto === 'viatico').map((x) => x.persona_id)).toEqual(['ch1', 'ay1']);
    expect(b.renglones.filter((x) => x.concepto === 'viatico')).toEqual([]);
    // Carga: intacta en las dos.
    expect(a.renglones.filter((x) => x.concepto === 'carga').map((x) => x.importe)).toEqual([30]);
    expect(b.renglones.filter((x) => x.concepto === 'carga').map((x) => x.importe)).toEqual([12]);
    // Total del viaje: 150 + 90 (comisiones) + 160 (viáticos) + 42 (carga) = 442, no 642.
    const total = [...out.values()].flatMap((x) => x.renglones).reduce((s, x) => s + x.importe, 0);
    expect(total).toBe(442);
    expect(a.con).toEqual(['06|0001696']);
    expect(b.con).toEqual(['06|0001695']);
  });

  it('tres guías ligadas en cadena son un solo grupo; la comisión de Kepler (sin capturar) también cuenta', () => {
    const out = consolidarMismoViaje([
      { clave: '00|0001057', liga: null, renglones: [r('ch1', 'comision', 98, 'kepler')] },
      { clave: '00|0001060', liga: '00|0001057', renglones: [r('ch1', 'comision', 120, 'kepler')] },
      { clave: '00|0001061', liga: '00|0001060', renglones: [r('ch1', 'comision', 110, 'kepler')] },
    ]);
    const comisiones = [...out.entries()].map(([k, v]) => [k, v.renglones.map((x) => x.importe)]);
    expect(comisiones).toEqual([['00|0001057', []], ['00|0001060', [120]], ['00|0001061', []]]);
    expect(out.get('00|0001060')!.con).toEqual(['00|0001057', '00|0001061']);
  });

  it('NEGATIVA: sin liga, o con liga a una guía que no está en el reporte, nada cambia', () => {
    const ops = [
      { clave: '01|0000001', liga: null, renglones: [r('ch1', 'comision', 100), r('ch1', 'viatico', 80)] },
      { clave: '01|0000002', liga: '09|9999999', renglones: [r('ch1', 'comision', 100), r('ch1', 'viatico', 80)] },
    ];
    const out = consolidarMismoViaje(ops);
    expect(out.get('01|0000001')!.renglones).toEqual(ops[0].renglones);
    expect(out.get('01|0000002')!.renglones).toEqual(ops[1].renglones);
    expect(out.get('01|0000002')!.con).toEqual([]);
  });

  it('una persona que sólo va en una de las guías conserva lo suyo', () => {
    const out = consolidarMismoViaje([
      { clave: '06|0000010', liga: null, renglones: [r('ch1', 'comision', 100)] },
      { clave: '06|0000011', liga: '06|0000010', renglones: [r('ch1', 'comision', 100), r('ay9', 'comision', 50)] },
    ]);
    expect(out.get('06|0000010')!.renglones.map((x) => x.persona_id)).toEqual(['ch1']);
    expect(out.get('06|0000011')!.renglones.map((x) => x.persona_id)).toEqual(['ay9']);
  });
});
