import type { DecisionCostoGuardada, RenglonCostoAplicado } from '@megadulces/contracts/http/application-cost';
import { maximoReclamable, mismoCosto, redondear2, validarDecision, yaDecididoAntes } from './application-cost.domain';

/** Un renglón que SUBE: la OC a $21.60, aplicado a $23.00, 24 piezas → $33.60 de diferencia. */
const sube: RenglonCostoAplicado = {
  sucursal: '03', subtipo: '1', folio: '0001139', renglon: 1, fecha_aplicacion: '2026-11-25',
  supplier_code: 'PRV1', sku: '59019', unit: 'PAQ', quantity: 24, applied_price: 23, oc_price: 21.6, cost_state: 'sube',
};
const baja: RenglonCostoAplicado = { ...sube, renglon: 2, applied_price: 20, cost_state: 'baja' };
const MOTIVO = 'El proveedor subió su lista el 1-nov';

describe('[PQ.157] mismoCosto — el corte de la vista C0', () => {
  it('a un centavo o a 0.5 % es el mismo costo', () => {
    expect(mismoCosto(10, 10.01)).toBe(true);
    expect(mismoCosto(1000, 1004.9)).toBe(true);
  });
  it('control: fuera de los dos cortes no es el mismo', () => {
    // 10.02 sí sería «igual»: 2 centavos, pero 0.2 %. A 10.06 son 6 centavos y 0.6 %.
    expect(mismoCosto(10, 10.02)).toBe(true);
    expect(mismoCosto(10, 10.06)).toBe(false);
    expect(mismoCosto(1000, 1005.1)).toBe(false);
  });
  it('sin precio no hay comparación', () => {
    expect(mismoCosto(0, 0)).toBe(false);
    expect(mismoCosto(-1, -1)).toBe(false);
  });
});

describe('[PQ.157] maximoReclamable', () => {
  it('la diferencia contra la OC por la cantidad, redondeada al centavo', () => {
    expect(maximoReclamable(sube)).toBe(33.6);
  });
  it('cero si el costo bajó o no hay OC', () => {
    expect(maximoReclamable(baja)).toBe(0);
    expect(maximoReclamable({ ...sube, oc_price: null })).toBe(0);
  });
  it('redondear2 no se come el centavo de 1.005', () => {
    expect(redondear2(1.005)).toBe(1.01);
  });
});

describe('[PQ.157] validarDecision', () => {
  it('aceptar con motivo se puede, suba o baje', () => {
    expect(validarDecision(sube, { decision: 'accept', reason: MOTIVO })).toEqual([]);
    expect(validarDecision(baja, { decision: 'accept', reason: MOTIVO })).toEqual([]);
  });

  it('sólo se decide lo que difiere de la OC', () => {
    for (const cost_state of ['igual', 'sin_oc', 'sin_precio', 'otra_escala_ambigua']) {
      expect(validarDecision({ ...sube, cost_state }, { decision: 'accept', reason: MOTIVO })[0]).toMatch(/no hay nada que decidir/);
    }
    expect(validarDecision({ ...sube, oc_price: null }, { decision: 'accept', reason: MOTIVO })[0]).toMatch(/no hay nada que decidir/);
  });

  it('una decisión fuera de la lista no pasa', () => {
    expect(validarDecision(sube, { decision: 'borrar' as never, reason: MOTIVO })[0]).toMatch(/desconocida/);
  });

  it('el motivo pide al menos 10 letras sin contar espacios de las orillas', () => {
    expect(validarDecision(sube, { decision: 'accept', reason: '   ok      ' })).toEqual(['Escribe por qué, con al menos 10 letras.']);
    expect(validarDecision(sube, { decision: 'accept', reason: '0123456789' })).toEqual([]);
  });

  it('las letras se cuentan como Postgres: 5 emoji son 5 letras, no 10 (si no, la base rechazaba lo que aquí pasaba)', () => {
    const cinco = '\u{1F4E6}'.repeat(5);
    expect(cinco.length).toBe(10); // CONTROL: en UTF-16 suman 10 y la regla ingenua las dejaba pasar
    expect(validarDecision(sube, { decision: 'accept', reason: cinco })).toEqual(['Escribe por qué, con al menos 10 letras.']);
    expect(validarDecision(sube, { decision: 'accept', reason: '\u{1F4E6}'.repeat(10) })).toEqual([]);
  });

  it('sin cantidad o sin precio no se decide (la tabla lo rechazaría)', () => {
    expect(validarDecision({ ...sube, quantity: 0 }, { decision: 'accept', reason: MOTIVO })[0]).toMatch(/no tiene cantidad o precio/);
    expect(validarDecision({ ...sube, quantity: 0.00004 }, { decision: 'accept', reason: MOTIVO })[0]).toMatch(/no tiene cantidad o precio/);
  });

  describe('reclamar', () => {
    it('la diferencia completa o una parte', () => {
      expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount: 33.6 })).toEqual([]);
      expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount: 10 })).toEqual([]);
      // Un centavo de holgura por el redondeo de la base.
      expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount: 33.61 })).toEqual([]);
    });
    it('nunca más que la diferencia', () => {
      expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount: 33.62 })[0]).toMatch(/más que la diferencia contra la OC \(\$33\.60\)/);
    });
    it('el tope sale de la cantidad y los precios COMO LOS GUARDA la tabla (4 y 6 decimales)', () => {
      // 0.00015 KG se guarda como 0.0002 (numeric(16,4)): el CHECK calcula 999 × 0.0002 = 0.1998 → 0.20, mientras que la
      // cuenta con la cantidad cruda daba 999 × 0.00015 = 0.15 y rechazaba un reclamo que la base sí acepta.
      const kg = { ...sube, quantity: 0.00015, applied_price: 1000, oc_price: 1 };
      expect(maximoReclamable(kg)).toBe(0.2);
    });

    it('un monto que al centavo es cero no pasa (0.004 se guardaría como 0.00)', () => {
      expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount: 0.004 })[0]).toMatch(/cuánto esperas/);
    });

    it('sin monto, en cero o negativo no pasa', () => {
      for (const claim_amount of [undefined, null, 0, -5, Number.NaN]) {
        expect(validarDecision(sube, { decision: 'claim', reason: MOTIVO, claim_amount })[0]).toMatch(/cuánto esperas/);
      }
    });
    it('si el costo bajó no hay nota que pedir', () => {
      expect(validarDecision(baja, { decision: 'claim', reason: MOTIVO, claim_amount: 5 })[0]).toMatch(/Sólo se reclama cuando el costo sube/);
    });
    it('el monto no va en otra decisión', () => {
      expect(validarDecision(sube, { decision: 'accept', reason: MOTIVO, claim_amount: 5 })).toEqual(['El monto de la nota sólo va al reclamar.']);
    });
  });

  describe('promoción', () => {
    it('con fecha de fin vigente el día de la aplicación', () => {
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO, valid_until: '2026-12-31' })).toEqual([]);
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO, valid_until: '2026-11-25' })).toEqual([]);
    });
    it('sin fecha, con fecha imposible o vencida antes de aplicar no pasa', () => {
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO })[0]).toMatch(/hasta cuándo/);
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO, valid_until: '2026-02-30' })[0]).toMatch(/hasta cuándo/);
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO, valid_until: '31/12/2026' })[0]).toMatch(/hasta cuándo/);
      expect(validarDecision(baja, { decision: 'promotion', reason: MOTIVO, valid_until: '2026-11-24' })[0]).toMatch(/vigente el día de la aplicación/);
    });
    it('la fecha de fin no va en otra decisión', () => {
      expect(validarDecision(baja, { decision: 'accept', reason: MOTIVO, valid_until: '2026-12-31' })).toEqual(['La fecha de fin sólo va en una promoción.']);
    });
  });
});

describe('[PQ.157] yaDecididoAntes — «ya se aceptó antes»', () => {
  const guardada = (o: Partial<DecisionCostoGuardada>): DecisionCostoGuardada => ({
    id: 'x', sucursal: '08', subtipo: '1', folio: '0000500', renglon: 3, supplier_code: 'PRV1', sku: '59019', unit: 'PAQ',
    quantity: 10, applied_price: 23, oc_price: 21.6, cost_state: 'sube', decision: 'accept', reason: MOTIVO,
    claim_amount: null, valid_until: null, created_by: 'compras', created_at: '2026-11-10T16:00:00.000Z',
    superseded_by: null, superseded_at: null, ...o,
  });

  it('encuentra la aceptación del mismo costo en otro renglón (aunque sea otra sucursal)', () => {
    const p = guardada({});
    expect(yaDecididoAntes([p], sube)).toBe(p);
  });

  it('a medio centavo y a 0.4 % sigue siendo el mismo costo', () => {
    expect(yaDecididoAntes([guardada({ applied_price: 23.005 })], sube)).not.toBeNull();
    expect(yaDecididoAntes([guardada({ applied_price: 23.09 })], sube)).not.toBeNull();
  });

  it('la más reciente gana', () => {
    const vieja = guardada({ id: 'vieja', created_at: '2026-10-01T16:00:00.000Z' });
    const nueva = guardada({ id: 'nueva', created_at: '2026-11-20T16:00:00.000Z' });
    expect(yaDecididoAntes([vieja, nueva], sube)?.id).toBe('nueva');
  });

  it('controles: otro costo, proveedor, producto o unidad no cuentan', () => {
    expect(yaDecididoAntes([guardada({ applied_price: 24 })], sube)).toBeNull();
    expect(yaDecididoAntes([guardada({ supplier_code: 'OTRO' })], sube)).toBeNull();
    expect(yaDecididoAntes([guardada({ sku: '59250' })], sube)).toBeNull();
    expect(yaDecididoAntes([guardada({ unit: 'CJA' })], sube)).toBeNull();
  });

  it('no cuenta el mismo renglón, una reemplazada ni un reclamo', () => {
    expect(yaDecididoAntes([guardada({ sucursal: '03', folio: '0001139', renglon: 1 })], sube)).toBeNull();
    expect(yaDecididoAntes([guardada({ superseded_at: '2026-11-11T00:00:00Z', superseded_by: 'compras' })], sube)).toBeNull();
    expect(yaDecididoAntes([guardada({ decision: 'claim', claim_amount: 14 })], sube)).toBeNull();
  });

  it('una promoción cuenta sólo si seguía vigente el día de esta aplicación', () => {
    expect(yaDecididoAntes([guardada({ decision: 'promotion', valid_until: '2026-11-30' })], sube)).not.toBeNull();
    expect(yaDecididoAntes([guardada({ decision: 'promotion', valid_until: '2026-11-24' })], sube)).toBeNull();
  });

  it('no distingue mayúsculas ni espacios en las claves', () => {
    expect(yaDecididoAntes([guardada({ supplier_code: ' prv1 ', unit: 'paq' })], sube)).not.toBeNull();
  });
});
