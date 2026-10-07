// [CDRP.2] El clasificador de KPIs — con las NEGATIVAS que justifican que exista.
//
// «Un gate sin prueba negativa es una intención» (ADR-056). La compuerta que este archivo
// defiende es una sola: **sin umbral registrado, un KPI NO se pinta verde**. Ése es el
// `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional a las 3 matvistas del
// sell-out, y el defecto que el contrato §12 del documento CDRP repetiría con sus 3 estados.

import {
  clasificarKpi,
  umbralPara,
  ORDEN_KPI_ESTADO,
  type KpiUmbral,
} from './kpi-threshold.contract';

/** Ventas del mes: más es mejor. Meta 28.50 MDP, amarillo a 27.07, escala por debajo de 25. */
const VENTAS: KpiUmbral = {
  kpi_key: 'comercial.ventas_consolidadas',
  position_code: null,
  period: 'mes',
  target: 28.5,
  warn_at: 27.07,
  escalate_at: 25,
  direction: 'higher_is_better',
  escalate_to: 'direccion',
  source: 'presupuesto 2026 (ejemplo de prueba, no es una meta real)',
  manual_lock: true,
  auto_tuned_at: null,
};

/** Cartera vencida: MENOS es mejor. Es el caso que invierte las tres comparaciones. */
const CARTERA: KpiUmbral = {
  ...VENTAS,
  kpi_key: 'finanzas.cartera_vencida',
  target: 5_000_000,
  warn_at: 8_000_000,
  escalate_at: 20_000_000,
  direction: 'lower_is_better',
  escalate_to: 'direccion',
};

describe('[CDRP.2] clasificarKpi', () => {
  describe('⛔ las dos ausencias, que no son la misma', () => {
    it('sin CIFRA devuelve sin_medir, NUNCA ok', () => {
      const v = clasificarKpi(null, VENTAS);
      expect(v.estado).toBe('sin_medir');
      expect(v.estado).not.toBe('ok');
      expect(v.motivo).toContain('No hay cifra');
      expect(v.avance).toBeNull();
    });

    it('⛔ NEGATIVA — sin UMBRAL devuelve sin_meta, NUNCA ok (el `cfg ? classify : "ok"`)', () => {
      const v = clasificarKpi(26.8, null);
      expect(v.estado).toBe('sin_meta');
      expect(v.estado).not.toBe('ok');
      expect(v.escala_a).toBeNull();
      // Y el motivo dice QUÉ falta: sin esto la pantalla imprimiría "sin datos" sobre una cifra
      // que sí existe, que es la confusión exacta que el quinto estado vino a deshacer.
      expect(v.motivo).toContain('no hay meta registrada');
    });

    it('sin cifra Y sin umbral gana sin_medir: no se puede juzgar lo que no se midió', () => {
      expect(clasificarKpi(null, null).estado).toBe('sin_medir');
    });

    it('un valor no finito es ausencia, no un número (NaN / Infinity de una división)', () => {
      expect(clasificarKpi(NaN, VENTAS).estado).toBe('sin_medir');
      expect(clasificarKpi(Infinity, VENTAS).estado).toBe('sin_medir');
    });
  });

  describe('higher_is_better', () => {
    it('en la meta o arriba → ok', () => {
      expect(clasificarKpi(28.5, VENTAS).estado).toBe('ok');
      expect(clasificarKpi(31.0, VENTAS).estado).toBe('ok');
    });
    it('debajo de la meta pero sobre el amarillo → warn', () => {
      expect(clasificarKpi(27.07, VENTAS).estado).toBe('warn');
      expect(clasificarKpi(28.49, VENTAS).estado).toBe('warn');
    });
    it('debajo del amarillo → bad', () => {
      expect(clasificarKpi(26.8, VENTAS).estado).toBe('bad');
    });
  });

  describe('⛔ lower_is_better invierte las TRES comparaciones, no una', () => {
    it('cartera por DEBAJO de la meta es lo bueno', () => {
      expect(clasificarKpi(4_000_000, CARTERA).estado).toBe('ok');
    });
    it('cartera por ENCIMA del amarillo es lo malo', () => {
      expect(clasificarKpi(9_000_000, CARTERA).estado).toBe('bad');
    });
    it('⛔ el mismo valor que en ventas sería ok, acá es bad — la dirección manda', () => {
      // Sin `direction`, un registro de umbrales pintaría en verde una cartera disparada.
      const alto = 49_000_000;
      expect(clasificarKpi(alto, CARTERA).estado).toBe('bad');
      expect(clasificarKpi(alto, { ...CARTERA, direction: 'higher_is_better' }).estado).toBe('ok');
    });
  });

  describe('escalamiento', () => {
    it('cruzar la línea de escalamiento agrega destinatario, no cambia el color', () => {
      const cerca = clasificarKpi(26.0, VENTAS); // bad, arriba de escalate_at
      const lejos = clasificarKpi(24.0, VENTAS); // bad, debajo de escalate_at
      expect(cerca.estado).toBe('bad');
      expect(lejos.estado).toBe('bad');
      expect(cerca.escala_a).toBeNull();
      expect(lejos.escala_a).toBe('direccion');
    });
    it('sin destinatario declarado no escala, aunque cruce la línea', () => {
      expect(clasificarKpi(24.0, { ...VENTAS, escalate_to: null }).escala_a).toBeNull();
    });
    it('en ok nunca escala', () => {
      expect(clasificarKpi(30, VENTAS).escala_a).toBeNull();
    });
  });

  describe('avance', () => {
    it('es la fracción contra la meta', () => {
      expect(clasificarKpi(26.8, VENTAS).avance).toBeCloseTo(26.8 / 28.5, 10);
    });
    it('⛔ con meta 0 se DECLARA null, no se divide entre cero ni se dibuja 0%', () => {
      // «Cartera vencida, meta 0» es un objetivo real de este negocio.
      const metaCero: KpiUmbral = { ...CARTERA, target: 0, warn_at: 1000, escalate_at: 5000 };
      const v = clasificarKpi(500, metaCero);
      expect(v.avance).toBeNull();
      expect(Number.isNaN(v.avance as unknown as number)).toBe(false);
      expect(v.estado).toBe('warn'); // 500 > 0 (meta) pero ≤ 1000 (amarillo)
    });
  });
});

describe('[CDRP.2] umbralPara — la precedencia vive en UN solo lugar', () => {
  const generico: KpiUmbral = { ...VENTAS, source: 'generico' };
  const delPuesto: KpiUmbral = { ...VENTAS, position_code: 'jefe_zona', source: 'del puesto' };
  const otroGrano: KpiUmbral = { ...VENTAS, period: 'dia', source: 'del dia' };
  const filas = [generico, delPuesto, otroGrano];

  it('la fila del PUESTO gana sobre la genérica', () => {
    expect(umbralPara(filas, VENTAS.kpi_key, 'jefe_zona', 'mes')?.source).toBe('del puesto');
  });
  it('un puesto sin fila propia cae en la genérica', () => {
    expect(umbralPara(filas, VENTAS.kpi_key, 'direccion', 'mes')?.source).toBe('generico');
  });
  it('⛔ una meta MENSUAL no juzga un día: el grano no se aproxima', () => {
    expect(umbralPara(filas, VENTAS.kpi_key, 'jefe_zona', 'dia')?.source).toBe('del dia');
    expect(umbralPara(filas, VENTAS.kpi_key, 'jefe_zona', 'trimestre')).toBeNull();
  });
  it('⛔ NEGATIVA — sin fila devuelve null, y null NO es un umbral permisivo', () => {
    const sin = umbralPara(filas, 'finanzas.ebitda', 'direccion', 'mes');
    expect(sin).toBeNull();
    expect(clasificarKpi(1_000_000, sin).estado).toBe('sin_meta');
  });
});

describe('[CDRP.2] ORDEN_KPI_ESTADO', () => {
  it('lo accionable primero y lo NO medido no se ordena junto a lo sano', () => {
    const orden = (['ok', 'sin_medir', 'bad', 'sin_meta', 'warn'] as const)
      .slice()
      .sort((a, b) => ORDEN_KPI_ESTADO[a] - ORDEN_KPI_ESTADO[b]);
    expect(orden).toEqual(['bad', 'warn', 'sin_meta', 'sin_medir', 'ok']);
    // ⛔ Lo que importa de este orden: `ok` es el ÚLTIMO. Si `sin_meta` empatara con `ok`, un
    // tablero ordenado por estado escondería justo los indicadores que nadie puede juzgar.
    expect(ORDEN_KPI_ESTADO.sin_meta).toBeLessThan(ORDEN_KPI_ESTADO.ok);
    expect(ORDEN_KPI_ESTADO.sin_medir).toBeLessThan(ORDEN_KPI_ESTADO.ok);
  });
});
