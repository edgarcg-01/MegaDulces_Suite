import type { EjercicioFila, HuecoDeclarado, PresupuestoDireccion } from '@megadulces/contracts';
import {
  avisoCorridasConError, conteoDeFirma, esperaMasLarga, huecosOrdenados, leyendaCadencia,
  metricasDireccion, montoODeclarado, pesoTexto, respuestaDireccion,
} from './presupuesto-direccion';

/**
 * `[PU.DIR.1]` — Candado de la vista «Dirección».
 *
 * Lo que vigila, y por qué cada cosa se puede romper:
 *
 *  1. ⛔ **Que `null` nunca salga como `$0.00`.** `shared/util/money.util.ts` hace
 *     `Number(v || 0)`: pasarle un monto que no se midió publica **cero pesos**, que es una
 *     afirmación. Es la trampa más barata de pisar en todo este archivo.
 *  2. ⛔ **Que un bloque caído se DECLARE y no se disimule.** Una respuesta armada con dos de
 *     tres cláusulas se lee idéntica a una completa; `sinMedir` es lo único que las distingue.
 *  3. ⭐ **Que el ejercicio de prueba no entre al denominador de la firma.** No se puede firmar
 *     —su propia fila dice «no aplica»—, así que `0 / 3` publica una razón cuyo numerador jamás
 *     podría alcanzar al denominador. Va `0 / 2`.
 *  4. **Que lo que no hay que avisar no avise.** Un bloque que siempre dice algo deja de leerse.
 */

const EJ = (over: Partial<EjercicioFila> = {}): EjercicioFila => ({
  id: 'b1', folio: 'PRE-2026-002', fiscal_year: 2026, status: 'borrador', is_test: false,
  creado_por: 'autopilot', dias_sin_firmar: 4, autorizado_por: null, autorizado_en: null, ...over,
});

const PAYLOAD = (over: Partial<PresupuestoDireccion> = {}): PresupuestoDireccion => ({
  motor: {
    universo: 'corridas del autopiloto', as_of: '2026-10-12', fuente: 'analytics.cron_runs',
    corridas: 29, ok: 22, error: 7, ultima_ok: '2026-10-12 07:30', ultima_error: '2026-10-08 09:30',
    cadencia: 'diaria',
  },
  motor_error: null,
  ejercicios: {
    universo: 'las 3 filas, sin filtrar', as_of: '2026-10-12', fuente: 'budget.budgets',
    filas: [EJ(), EJ({ id: 'b2', folio: 'PRE-2027-002', fiscal_year: 2027, dias_sin_firmar: 5 }),
      EJ({ id: 'b3', folio: null, is_test: true, dias_sin_firmar: 5 })],
  },
  ejercicios_error: null,
  obligaciones: {
    universo: 'obligaciones de gasto', as_of: '2026-10-12', fuente: 'budget.expense_obligations',
    reales: { n: 156, monto: 74_809_091.57 }, prueba: { n: 156, monto: 74_806_967.37 },
  },
  obligaciones_error: null,
  ledger: null, ledger_error: null,
  huecos: [{
    nombre: 'Meta por renglón', porque: 'el registro de umbrales está vacío',
    peso: { valor: 16, unidad: 'indicadores', medido: true, como: 'conteo sobre analytics.kpi_thresholds' },
  }],
  as_of: '2026-10-12',
  ...over,
});

describe('PU.DIR.1 · la lógica de la vista Dirección', () => {
  describe('⛔ montoODeclarado — la trampa de money()', () => {
    it('`null` NO se convierte en $0.00: sale el motivo', () => {
      const r = montoODeclarado(null, 'no se pudo medir');
      expect(r).toBe('no se pudo medir');
      expect(r).not.toContain('0.00');
    });

    it('`undefined` tampoco', () => {
      expect(montoODeclarado(undefined)).toBe('sin medir');
    });

    it('⛔ NEGATIVA — un cero REAL sí se publica como cero: es un dato, no una ausencia', () => {
      expect(montoODeclarado(0)).toContain('0.00');
    });

    it('un monto normal pasa a pesos', () => {
      expect(montoODeclarado(1234.5)).toContain('1,234.50');
    });
  });

  describe('⭐ conteoDeFirma — el ejercicio de prueba fuera del denominador', () => {
    it('tres filas con una de prueba dan 0 de 2, no 0 de 3', () => {
      const f = conteoDeFirma(PAYLOAD().ejercicios!.filas);
      expect(f).toEqual({ reales: 2, firmados: 0, prueba: 1 });
    });

    it('cuenta las firmas reales', () => {
      const f = conteoDeFirma([EJ({ autorizado_en: '2026-10-01', dias_sin_firmar: null }), EJ()]);
      expect(f.firmados).toBe(1);
      expect(f.reales).toBe(2);
    });

    it('la espera más larga ignora al de prueba y a los ya firmados', () => {
      expect(esperaMasLarga(PAYLOAD().ejercicios!.filas)).toBe(5);
      expect(esperaMasLarga([EJ({ autorizado_en: '2026-10-01', dias_sin_firmar: null })])).toBeNull();
    });
  });

  describe('la respuesta de la página', () => {
    it('sin payload no inventa respuesta', () => {
      expect(respuestaDireccion(null)).toBeNull();
    });

    it('con todo medido arma las tres cláusulas y no declara nada faltante', () => {
      const r = respuestaDireccion(PAYLOAD())!;
      expect(r.titular).toContain('29 corridas');
      expect(r.titular).toContain('ninguno de los 2 ejercicios tiene firma');
      expect(r.titular).toContain('no hay meta');
      expect(r.sinMedir).toEqual([]);
    });

    it('⛔ un bloque caído se DECLARA en sinMedir y su cláusula no se inventa', () => {
      const r = respuestaDireccion(PAYLOAD({ motor: null, motor_error: 'timeout' }))!;
      expect(r.sinMedir).toContain('el motor');
      expect(r.titular).not.toContain('corrida');
    });

    it('⛔ los ejercicios caídos también, y por su propio campo de error', () => {
      const r = respuestaDireccion(PAYLOAD({ ejercicios: null, ejercicios_error: 'boom' }))!;
      expect(r.sinMedir).toContain('los ejercicios');
      expect(r.titular).not.toContain('firma');
    });

    it('⛔ y un bloque nulo SIN error tampoco se inventa: el servidor falló en declarar', () => {
      // `null` sin motivo es un defecto del servidor, pero la pantalla no puede resolverlo
      // inventando el dato. Se declara igual que si hubiera venido el motivo.
      const r = respuestaDireccion(PAYLOAD({ ejercicios: null, ejercicios_error: null }))!;
      expect(r.sinMedir).toContain('los ejercicios');
    });

    it('sin el hueco de meta NO se afirma que falte meta', () => {
      const r = respuestaDireccion(PAYLOAD({ huecos: [] }))!;
      expect(r.titular).not.toContain('meta');
    });

    it('⭐ el detalle avisa del ejercicio de prueba con su monto', () => {
      const r = respuestaDireccion(PAYLOAD())!;
      expect(r.detalle).toContain('74,806,967.37');
      expect(r.detalle).toContain('no entran a ningun total');
    });

    it('⛔ NEGATIVA — sin ejercicio de prueba no hay detalle que dar', () => {
      const p = PAYLOAD();
      const r = respuestaDireccion(PAYLOAD({
        obligaciones: { ...p.obligaciones!, prueba: { n: 0, monto: 0 } },
      }))!;
      expect(r.detalle).toBeNull();
    });

    it('si las obligaciones fallan, el detalle lo dice en vez de callarse', () => {
      const r = respuestaDireccion(PAYLOAD({ obligaciones: null, obligaciones_error: 'sin permiso' }))!;
      expect(r.detalle).toContain('sin permiso');
    });
  });

  describe('avisos', () => {
    it('⛔ NEGATIVA — sin corridas con error NO se pinta aviso', () => {
      const p = PAYLOAD();
      expect(avisoCorridasConError({ ...p.motor!, error: 0 })).toBeNull();
      expect(avisoCorridasConError(null)).toBeNull();
    });

    it('con errores dice cuántos de cuántos y cuándo fue el último', () => {
      const a = avisoCorridasConError(PAYLOAD().motor)!;
      expect(a).toContain('7 de las 29');
      expect(a).toContain('2026-10-08 09:30');
    });

    it('la cadencia no derivable se declara, no se calla', () => {
      const p = PAYLOAD();
      expect(leyendaCadencia({ ...p.motor!, cadencia: null })).toContain('no derivable');
      expect(leyendaCadencia(null)).toBe('sin medir');
    });
  });

  describe('las métricas', () => {
    it('sin payload no hay métricas', () => {
      expect(metricasDireccion(null)).toEqual([]);
    });

    it('⭐ la razón de firma es 0 / 2 y el de prueba va en su propia métrica', () => {
      const m = metricasDireccion(PAYLOAD());
      expect(m.find((x) => x.label === 'Ejercicios firmados')?.value).toBe('0 / 2');
      expect(m.find((x) => x.label === 'Del ejercicio de prueba')?.sub).toContain('no entran a ningun total');
    });

    it('⛔ un bloque caído sale como no_medido con su motivo, NUNCA como cero', () => {
      const m = metricasDireccion(PAYLOAD({ obligaciones: null, obligaciones_error: 'timeout' }));
      const reales = m.find((x) => x.label === 'Obligaciones reales')!;
      expect(reales.state).toBe('no_medido');
      expect(reales.value).toBe('sin medir');
      expect(reales.stateNote).toBe('timeout');
      expect(String(reales.value)).not.toMatch(/\d/);
    });

    it('⛔ un bloque nulo SIN motivo se denuncia como defecto del servidor', () => {
      const m = metricasDireccion(PAYLOAD({ motor: null, motor_error: null }));
      expect(m[0].stateNote).toContain('defecto del servidor');
    });
  });

  describe('⭐ el peso de un hueco — las dos ausencias no se pintan igual', () => {
    const HUECO = (peso: HuecoDeclarado['peso']): HuecoDeclarado => ({ nombre: 'x', porque: 'y', peso });

    it('medido y con cifra sale como cifra con su unidad', () => {
      expect(pesoTexto(HUECO({ valor: 14, unidad: 'familias', medido: true, como: 'conteo' }))).toBe('14 familias');
    });

    it('⛔ NO medible sale con su MOTIVO, nunca con un número', () => {
      const t = pesoTexto(HUECO({ valor: null, unidad: 'tickets', medido: false, como: 'no existe conteo de tickets por canal en ninguna fuente' }));
      expect(t).toBe('no existe conteo de tickets por canal en ninguna fuente');
      expect(t).not.toMatch(/\d/);
    });

    it('⛔ medido pero SIN cifra es una tercera cosa, y se dice', () => {
      // Una consulta que corrió y no devolvió nada no es lo mismo que no tener consulta.
      // Si las dos se pintaran igual, nadie sabría a quién reclamarle.
      expect(pesoTexto(HUECO({ valor: null, unidad: 'familias', medido: true, como: 'la consulta no devolvió filas' })))
        .toBe('sin cifra: la consulta no devolvió filas');
    });

    it('⛔ un peso en CERO se publica como cero: es un dato medido, no una ausencia', () => {
      expect(pesoTexto(HUECO({ valor: 0, unidad: 'días futuros', medido: true, como: 'conteo' }))).toBe('0 días futuros');
    });

    it('el orden pone adelante lo dimensionado y al final lo que no se puede medir', () => {
      const h = huecosOrdenados([
        { nombre: 'no medible', porque: 'x', peso: { valor: null, unidad: 'u', medido: false, como: 'no hay fuente' } },
        { nombre: 'medido sin cifra', porque: 'y', peso: { valor: null, unidad: 'u', medido: true, como: 'vacío' } },
        { nombre: 'dimensionado', porque: 'z', peso: { valor: 14, unidad: 'familias', medido: true, como: 'conteo' } },
      ]);
      expect(h.map((x) => x.nombre)).toEqual(['dimensionado', 'medido sin cifra', 'no medible']);
    });
  });
});
