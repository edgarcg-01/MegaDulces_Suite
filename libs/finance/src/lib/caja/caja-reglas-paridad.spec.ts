/**
 * `[CG.27-B.0]` — **Los dos motores de reglas tienen que dar el MISMO veredicto.**
 *
 * `finance.caja_classify_rules` la leen dos caminos distintos:
 *
 *   · `cuentaPorRegla`  (`caja-lote.engine.ts`)    → la bandeja y el lote
 *   · `classifyByRules` (`caja-autofill.engine.ts`) → `POST /finance/cash-ledger/autofill`
 *
 * Y no se comportaban igual. Medido antes del arreglo:
 *
 *   |                        | cuentaPorRegla        | classifyByRules            |
 *   |------------------------|-----------------------|----------------------------|
 *   | normaliza el texto     | no                    | sí (NFD, sin acentos, MAY) |
 *   | desempate de prioridad | `priority` + `id`     | sólo `priority`            |
 *   | tope de patrón         | `REGLA_MAX_PATRON`    | ninguno                    |
 *
 * La consecuencia es concreta y silenciosa: `declararCuentaDeBeneficiario` ancla `^...$` con el
 * beneficiario **tal como llegó**, sólo escapado. El autofill normalizaba el texto de entrada pero
 * **no el patrón**, así que una regla con acento o espacio doble **matcheaba en la bandeja y no en
 * el autofill**. Declarar 26 reglas sobre esa base multiplica el problema por 26.
 *
 * Esta suite es el candado. Si alguien vuelve a tocar uno de los dos motores sin el otro, se pone
 * roja acá antes de que el dinero se vaya a la cuenta equivocada.
 */
import { cuentaPorRegla, type ReglaGasto } from './caja-lote.engine';
import { classifyByRules, type ClassifyRule } from './caja-autofill.engine';

/** La misma regla, en las dos formas que cada motor pide. */
function reglaEnAmbasFormas(matchBeneficiario: string, priority = 10) {
  const base = {
    id: 'r1', priority,
    match_tipo: null, match_glosa: null, match_beneficiario: matchBeneficiario,
    kepler_cuenta: '601-001', kepler_concepto: '001',
    active: true, suppressed_at: null,
  };
  return { lote: base as ReglaGasto, autofill: base as ClassifyRule };
}

/** ¿A qué par manda cada motor este movimiento? `null` = no clasifica. */
function veredictos(beneficiario: string, r: ReturnType<typeof reglaEnAmbasFormas>) {
  const porLote = cuentaPorRegla(
    { tipo: 'gasto', glosa: 'pago', beneficiario, monto: 100 }, [r.lote]);
  const porAutofill = classifyByRules([r.autofill], { tipo: 'gasto', glosa: 'pago', beneficiario });
  return {
    lote: porLote.ok ? `${porLote.kepler_cuenta}/${porLote.kepler_concepto}` : null,
    autofill: porAutofill.value ? `${porAutofill.value.kepler_cuenta}/${porAutofill.value.kepler_concepto}` : null,
  };
}

describe('paridad entre los dos motores de reglas de caja', () => {
  it('⛔ [la que estaba rota] un beneficiario con ACENTO da el mismo veredicto en los dos', () => {
    // Así queda el patrón cuando alguien declara "JOSÉ PÉREZ" desde la captura: anclado y escapado,
    // con el acento tal cual vino del ERP.
    const r = reglaEnAmbasFormas('^JOSÉ PÉREZ$');
    const v = veredictos('JOSÉ PÉREZ', r);
    expect(v.lote).toBe('601-001/001');
    expect(v.autofill).toBe(v.lote);
  });

  it('⛔ [la que estaba rota] un ESPACIO DOBLE da el mismo veredicto en los dos', () => {
    const r = reglaEnAmbasFormas('^BOTANAS  PAU$');
    const v = veredictos('BOTANAS  PAU', r);
    expect(v.lote).toBe('601-001/001');
    expect(v.autofill).toBe(v.lote);
  });

  it('acento Y espacio doble juntos: el mismo veredicto', () => {
    const r = reglaEnAmbasFormas('^PIÑATAS  TOÑO$');
    const v = veredictos('PIÑATAS  TOÑO', r);
    expect(v.lote).toBe('601-001/001');
    expect(v.autofill).toBe(v.lote);
  });

  it('el caso simple (sin acentos ni espacios raros) ya coincidía, y tiene que seguir', () => {
    const r = reglaEnAmbasFormas('^BOTANAS PAU$');
    const v = veredictos('BOTANAS PAU', r);
    expect(v.lote).toBe('601-001/001');
    expect(v.autofill).toBe(v.lote);
  });

  it('⛔ [negativa] lo que NO debe matchear no matchea en ninguno de los dos', () => {
    // El anclado es lo que evita que un beneficiario corto clasifique media bandeja.
    const r = reglaEnAmbasFormas('^PAU$');
    const v = veredictos('BOTANAS PAU', r);
    expect(v.lote).toBeNull();
    expect(v.autofill).toBeNull();
  });

  it('⛔ [negativa] una regla DESACTIVADA no clasifica en ninguno de los dos', () => {
    const r = reglaEnAmbasFormas('^BOTANAS PAU$');
    const off = { lote: { ...r.lote, active: false }, autofill: { ...r.autofill, active: false } };
    const v = veredictos('BOTANAS PAU', off);
    expect(v.lote).toBeNull();
    expect(v.autofill).toBeNull();
  });

  it('⛔ [negativa] una regla SUPRIMIDA no clasifica en ninguno de los dos', () => {
    const r = reglaEnAmbasFormas('^BOTANAS PAU$');
    const sup = {
      lote: { ...r.lote, suppressed_at: '2026-09-01T00:00:00Z' },
      autofill: { ...r.autofill, suppressed_at: '2026-09-01T00:00:00Z' },
    };
    const v = veredictos('BOTANAS PAU', sup);
    expect(v.lote).toBeNull();
    expect(v.autofill).toBeNull();
  });

  it('⛔ [negativa] un patrón absurdamente largo no aplica en NINGUNO — el tope es de los dos', () => {
    // El tope existe por ReDoS: un regex de la base corre en nuestro event loop. Si un motor lo
    // acota y el otro no, la protección no existe.
    const r = reglaEnAmbasFormas('^' + 'A'.repeat(500) + '$');
    const v = veredictos('A'.repeat(500), r);
    expect(v.lote).toBeNull();
    expect(v.autofill).toBeNull();
  });

  it('⛔ [negativa] un regex INVÁLIDO no revienta ninguno de los dos', () => {
    const r = reglaEnAmbasFormas('^BOTANAS ( PAU$');
    const v = veredictos('BOTANAS ( PAU', r);
    expect(v.lote).toBeNull();
    expect(v.autofill).toBeNull();
  });

  it('con DOS reglas de la misma prioridad, los dos eligen la MISMA', () => {
    // Sin desempate total, dos reglas de igual prioridad mandan el dinero a cuentas distintas
    // según cómo viniera ordenado el SELECT. `cuentaPorRegla` desempata por `id`; el otro no lo
    // hacía, así que el resultado dependía del orden de llegada.
    const a = {
      id: 'aaa', priority: 10, match_tipo: null, match_glosa: null, match_beneficiario: '^X$',
      kepler_cuenta: '601-001', kepler_concepto: '001', active: true, suppressed_at: null,
    };
    const b = { ...a, id: 'bbb', kepler_cuenta: '602-002', kepler_concepto: '002' };

    for (const orden of [[a, b], [b, a]]) {
      const lote = cuentaPorRegla({ tipo: 'gasto', glosa: 'g', beneficiario: 'X', monto: 1 }, orden as ReglaGasto[]);
      const auto = classifyByRules(orden as ClassifyRule[], { tipo: 'gasto', glosa: 'g', beneficiario: 'X' });
      expect(lote.ok && lote.kepler_cuenta).toBe('601-001');
      expect(auto.value?.kepler_cuenta).toBe('601-001');
    }
  });
});
