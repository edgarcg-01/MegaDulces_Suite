import { classifyReceivingOrigin } from './receiving-origin';
import {
  isClaimableDiscrepancy,
  claimQtyFor,
  claimAmount,
  responsibleFor,
  nextClaimStatus,
  penalizesFulfillment,
  claimDedupKey,
} from './receiving-claim';

describe('isClaimableDiscrepancy — qué renglón se le reclama a alguien', () => {
  it('faltante, dañado y producto_incorrecto sí', () => {
    expect(isClaimableDiscrepancy('faltante')).toBe(true);
    expect(isClaimableDiscrepancy('dañado')).toBe(true);
    expect(isClaimableDiscrepancy('producto_incorrecto')).toBe(true);
  });

  it('sobrante NO: llegó de más, no de menos', () => {
    expect(isClaimableDiscrepancy('sobrante')).toBe(false);
  });

  it('ok y pending tampoco (pending ya no existe después del cierre)', () => {
    expect(isClaimableDiscrepancy('ok')).toBe(false);
    expect(isClaimableDiscrepancy('pending')).toBe(false);
    expect(isClaimableDiscrepancy(null)).toBe(false);
    expect(isClaimableDiscrepancy(undefined)).toBe(false);
  });
});

describe('claimQtyFor — cuánto se reclama', () => {
  it('el faltante es expected − received', () => {
    expect(claimQtyFor(100, 60)).toBe(40);
  });

  it('acepta los numeric de Postgres, que llegan como STRING', () => {
    expect(claimQtyFor('100.000', '60.500')).toBe(39.5);
  });

  it('sin hueco devuelve null, no 0: un reclamo de cero no es un reclamo', () => {
    expect(claimQtyFor(100, 100)).toBeNull();
    // dañado con todo recibido: el hueco es 0 y la cantidad se captura en la bandeja.
    expect(claimQtyFor(50, 50)).toBeNull();
  });

  it('un sobrante nunca da cantidad negativa', () => {
    expect(claimQtyFor(100, 130)).toBeNull();
  });

  it('tolera nulos y basura sin explotar', () => {
    expect(claimQtyFor(null, null)).toBeNull();
    expect(claimQtyFor('x', 'y')).toBeNull();
    expect(claimQtyFor(10, undefined)).toBe(10);
  });
});

describe('claimAmount — el monto es estimación, y sin costo es null (no $0)', () => {
  it('cantidad × costo por unidad del documento, a 2 decimales', () => {
    expect(claimAmount(40, 74.94)).toBe(2997.6);
    expect(claimAmount('10.000', '20.4600')).toBe(204.6);
  });

  it('sin costo del documento devuelve null: $0 se leería como "no cuesta nada"', () => {
    expect(claimAmount(40, null)).toBeNull();
    expect(claimAmount(40, 0)).toBeNull();
    expect(claimAmount(40, undefined)).toBeNull();
  });

  it('sin cantidad todavía capturada tampoco inventa monto', () => {
    expect(claimAmount(null, 74.94)).toBeNull();
    expect(claimAmount(0, 74.94)).toBeNull();
  });
});

describe('responsibleFor — proveedor vs sucursal que embarcó', () => {
  it('un C### se le reclama al proveedor', () => {
    const r = responsibleFor(classifyReceivingOrigin('CD015', 'DISTRIBUIDORA DE LA ROSA SA DE CV'), 'CD015');
    expect(r.responsible_kind).toBe('supplier');
    expect(r.responsible_label).toBe('DISTRIBUIDORA DE LA ROSA SA DE CV');
  });

  it('un TI### es traspaso: responsable = sucursal, y el label es el del DOCUMENTO', () => {
    const r = responsibleFor(classifyReceivingOrigin('TI005', 'SUCURSAL ABASTOS LP'), 'TI005');
    expect(r.responsible_kind).toBe('branch');
    // El mismo TI005 sale en el ERP como "ZAMORA CANINDO" en otros documentos: acá se
    // conserva el nombre de ESTE documento y NO se deduce la sucursal.
    expect(r.responsible_label).toBe('SUCURSAL ABASTOS LP');
  });

  it('el CEDIS también es traspaso (la merma es de la casa)', () => {
    expect(responsibleFor(classifyReceivingOrigin('TI000', 'CENTRO DE DISTRIBUCIÓN ( CEDIS)')).responsible_kind).toBe('branch');
  });

  it('sin nombre en el documento cae al código, nunca a un nombre inventado', () => {
    expect(responsibleFor(classifyReceivingOrigin('TI001', null), 'TI001').responsible_label).toBe('TI001');
    expect(responsibleFor(classifyReceivingOrigin(null, null), null).responsible_label).toBeNull();
  });
});

describe('nextClaimStatus — máquina de estados del reclamo', () => {
  it('open → claimed cuando se le pasa al responsable', () => {
    expect(nextClaimStatus('open', 'claim')).toBe('claimed');
  });

  it('se puede cerrar desde open o desde claimed', () => {
    expect(nextClaimStatus('open', 'accepted')).toBe('accepted');
    expect(nextClaimStatus('claimed', 'accepted')).toBe('accepted');
    expect(nextClaimStatus('claimed', 'discarded')).toBe('discarded');
    expect(nextClaimStatus('open', 'written_off')).toBe('written_off');
  });

  it('no se reclama dos veces', () => {
    expect(nextClaimStatus('claimed', 'claim')).toBeNull();
  });

  it('un reclamo cerrado no se reabre ni se re-cierra en silencio', () => {
    for (const st of ['accepted', 'discarded', 'written_off'] as const) {
      expect(nextClaimStatus(st, 'claim')).toBeNull();
      expect(nextClaimStatus(st, 'accepted')).toBeNull();
      expect(nextClaimStatus(st, 'discarded')).toBeNull();
    }
  });
});

describe('penalizesFulfillment — qué le pega al fill rate', () => {
  it('descartado NO penaliza: el error de conteo era nuestro', () => {
    expect(penalizesFulfillment('discarded')).toBe(false);
  });

  it('abierto SÍ penaliza: si no, desatender la bandeja protegería al proveedor', () => {
    expect(penalizesFulfillment('open')).toBe(true);
    expect(penalizesFulfillment('claimed')).toBe(true);
  });

  it('aceptado y no recuperado penalizan', () => {
    expect(penalizesFulfillment('accepted')).toBe(true);
    expect(penalizesFulfillment('written_off')).toBe(true);
  });
});

describe('claimDedupKey — un reclamo por renglón aunque el cierre se reintente', () => {
  it('la llave es el renglón, no el vale', () => {
    expect(claimDedupKey('11111111-1111-1111-1111-111111111111'))
      .toBe('recv-line:11111111-1111-1111-1111-111111111111');
    expect(claimDedupKey('a')).not.toBe(claimDedupKey('b'));
  });
});
