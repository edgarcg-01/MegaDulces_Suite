import {
  agruparParaAprobacion, departamentoDeAgrupacion, fechaDeAgrupacion, type ExpedientePendiente,
} from './aprobacion-agrupar';

/**
 * `[GX.17]` Esta agrupación es lo que ve quien FIRMA. Si el monto de un grupo no cuadra con
 * la suma de sus renglones, o si un grupo junta cosas que no van juntas, alguien autoriza
 * dinero mirando una cifra equivocada.
 */

const E = (over: Partial<ExpedientePendiente> = {}): ExpedientePendiente => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  folio_solicitud: '0009678',
  sucursal: '00',
  fecha_gasto: '2026-09-22',
  created_at: '2026-09-23T10:00:00.000Z',
  importe: 100,
  departamento: 'LOGISTICA',
  solicitante: 'LEONARDO CAZARES',
  proveedor: 'ARRENDAMEX',
  clasificacion: 'fiscal',
  forma_pago: 'efectivo',
  evidencia_en_vivo: true,
  ...over,
});

describe('[GX.17] agrupar lo que espera luz verde', () => {
  it('sin pendientes devuelve ceros, no revienta', () => {
    const r = agruparParaAprobacion([]);
    expect(r).toEqual({ total: 0, monto_total: 0, por_fecha: [], por_departamento: [] });
  });

  it('el total y el monto cuadran con los renglones', () => {
    const r = agruparParaAprobacion([E({ importe: 100 }), E({ importe: 250.5 }), E({ importe: 0.25 })]);
    expect(r.total).toBe(3);
    expect(r.monto_total).toBe(350.75);
  });

  /**
   * ⭐ El monto de cada grupo tiene que ser EXACTAMENTE la suma de sus renglones. Redondear
   * en cada paso corre el total unos centavos, y quien firma ve una cifra que no cuadra con
   * lo que tiene enfrente.
   */
  it('la suma de los grupos es igual al total, al centavo', () => {
    const items = [E({ importe: 33.33 }), E({ importe: 33.33 }), E({ importe: 33.34 })];
    const r = agruparParaAprobacion(items);
    expect(r.monto_total).toBe(100);
    expect(r.por_fecha.reduce((a, g) => a + g.monto, 0)).toBe(100);
    expect(r.por_departamento.reduce((a, g) => a + g.monto, 0)).toBe(100);
  });

  describe('por fecha', () => {
    it('agrupa por día y pone lo más nuevo primero', () => {
      const r = agruparParaAprobacion([
        E({ fecha_gasto: '2026-09-20' }), E({ fecha_gasto: '2026-09-22' }), E({ fecha_gasto: '2026-09-20' }),
      ]);
      expect(r.por_fecha.map((g) => g.clave)).toEqual(['2026-09-22', '2026-09-20']);
      expect(r.por_fecha[1].n).toBe(2);
    });

    it('sin fecha de gasto cae a la de captura, no a «sin fecha»', () => {
      // Pasa de verdad: `fecha_gasto` es opcional en el expediente.
      expect(fechaDeAgrupacion(E({ fecha_gasto: null, created_at: '2026-09-23T10:00:00Z' }))).toBe('2026-09-23');
    });

    it('recorta un timestamp completo al día', () => {
      expect(fechaDeAgrupacion(E({ fecha_gasto: '2026-09-22T06:00:00.000Z' }))).toBe('2026-09-22');
    });

    it('sin ninguna de las dos fechas lo dice, no lo esconde en el día de hoy', () => {
      expect(fechaDeAgrupacion(E({ fecha_gasto: null, created_at: '' }))).toBe('sin_fecha');
    });

    /**
     * ⭐ El caso que mis propias pruebas NO cubían y que apareció al correr la pantalla en
     * local: `pg` devuelve las fechas como objeto `Date`, no como texto ISO. Con `String()`
     * eso da «Thu Sep 24», que no es una fecha y además corre el día por zona horaria.
     * Yo alimenté el spec con cadenas ISO y pasó en verde mientras la pantalla mostraba
     * nombres de día. Es la misma trampa de la Fase LC.16.
     */
    it('un objeto Date de pg NO se acepta como fecha: se declara sin_fecha', () => {
      const comoDate = new Date('2026-09-22T06:00:00.000Z') as unknown as string;
      expect(fechaDeAgrupacion(E({ fecha_gasto: comoDate, created_at: comoDate }))).toBe('sin_fecha');
    });

    it('si la del gasto no sirve pero la de captura sí, usa la de captura', () => {
      const comoDate = new Date('2026-09-22T06:00:00.000Z') as unknown as string;
      expect(fechaDeAgrupacion(E({ fecha_gasto: comoDate, created_at: '2026-09-23' }))).toBe('2026-09-23');
    });
  });

  describe('por departamento', () => {
    it('ordena por monto: lo que más pesa, arriba', () => {
      const r = agruparParaAprobacion([
        E({ departamento: 'CHICO', importe: 10 }),
        E({ departamento: 'GRANDE', importe: 5000 }),
        E({ departamento: 'MEDIO', importe: 300 }),
      ]);
      expect(r.por_departamento.map((g) => g.etiqueta)).toEqual(['GRANDE', 'MEDIO', 'CHICO']);
    });

    it('junta el mismo departamento escrito con distinta caja', () => {
      const r = agruparParaAprobacion([E({ departamento: 'Logistica' }), E({ departamento: 'LOGISTICA' })]);
      expect(r.por_departamento).toHaveLength(1);
      expect(r.por_departamento[0].n).toBe(2);
    });

    /**
     * ⭐ Las tres procedencias son distintas y se DECLARAN. `Sucursal 00` no es un
     * departamento —es una plaza, la pone `create()` cuando nadie capturó uno— y sin
     * marcarla conviviría con `LOGISTICA` como si fueran lo mismo.
     */
    it('dice de dónde salió la etiqueta', () => {
      expect(departamentoDeAgrupacion(E({ departamento: 'LOGISTICA' })).origen).toBe('capturado');
      expect(departamentoDeAgrupacion(E({ departamento: 'Sucursal 00' })).origen).toBe('capturado');
      expect(departamentoDeAgrupacion(E({ departamento: null })).origen).toBe('solicitud');
      expect(departamentoDeAgrupacion(E({ departamento: '  ' })).origen).toBe('solicitud');
      expect(departamentoDeAgrupacion(E({ departamento: null, solicitante: null })).origen).toBe('sin_clasificar');
    });

    it('cae al solicitante de Kepler cuando no hay departamento capturado', () => {
      const r = agruparParaAprobacion([E({ departamento: null, solicitante: 'LEONARDO CAZARES' })]);
      expect(r.por_departamento[0].etiqueta).toBe('LEONARDO CAZARES');
      expect(r.por_departamento[0].origen).toBe('solicitud');
    });

    it('sin ninguno de los dos, «Sin clasificar» — nunca se lo cuelga a otro grupo', () => {
      const r = agruparParaAprobacion([
        E({ departamento: null, solicitante: null }), E({ departamento: 'LOGISTICA' }),
      ]);
      expect(r.por_departamento.map((g) => g.etiqueta).sort()).toEqual(['LOGISTICA', 'Sin clasificar']);
    });
  });

  it('cada grupo trae los ids, para poder actuar sobre el grupo entero', () => {
    const r = agruparParaAprobacion([E({ id: 'a' }), E({ id: 'b' })]);
    expect(r.por_fecha[0].ids.sort()).toEqual(['a', 'b']);
  });

  it('un importe nulo o basura cuenta como 0 y no rompe la suma', () => {
    const r = agruparParaAprobacion([
      E({ importe: 100 }),
      E({ importe: null as unknown as number }),
      E({ importe: NaN }),
    ]);
    expect(r.total).toBe(3);
    expect(r.monto_total).toBe(100);
  });
});
