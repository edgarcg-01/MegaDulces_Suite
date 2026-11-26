import type { PlantillaComisiones } from './comisiones-kepler.armador';
import { AREA_COMISIONES, CONCEPTO_COMISION, entregasDelDia, marcaDeComisiones, referenciaDelCargo } from './comisiones-kepler.escritor';
import type { CargoPropuesta, DiaPropuesta } from './comisiones-kepler.query';

/**
 * `[CB.62.4]` El traductor del día de comisiones a las tres entregas de PGP. El control es el caso real de
 * Morelia Madero medido en el ODS (gasto `0000063`: $771.09 con IVA $106.35) y la forma medida el 2026-11-26
 * sobre las 442 solicitudes de comisión vivas de oct–nov.
 */

const PLANTILLA: PlantillaComisiones = {
  acreedor: 'GB004',
  nombre: 'BBVA MEXICO SA',
  domicilio: ['AV PASEO DE LA REFORMA 510', 'JUAREZ', 'CIUDAD DE MEXICO'],
  referenciaGasto: '42',
  areaGasto: AREA_COMISIONES,
  proyecto: '1',
  departamento: '1-02-32-00',
  conceptoPago: '018',
  sucursalTexto: 'MORELIA MADERO',
  sucursalNombre: 'M.M.',
  cuentaAcreedor: '201',
};

const CAPTURA = { fecha: '2026-11-26', hora: '09:30' };

const cargo = (x: Partial<CargoPropuesta> = {}): CargoPropuesta => ({
  id: 'l1', cuenta: '4885', concepto: 'APLI TASA DE DES CREDITO/175096809', fecha: '2026-11-20',
  importe: 664.73, tipo: 'comision', kepler_pago: null, kepler_sucursal: null, kepler_ajuste_centavos: null,
  kepler_gasto: null, ...x,
});

const dia = (cargos: CargoPropuesta[]): Pick<DiaPropuesta, 'sucursal' | 'dia_venta' | 'acreedor' | 'banco' | 'cargos'> =>
  ({ sucursal: '04', dia_venta: '2026-11-19', acreedor: 'GB004', banco: 'BBVA', cargos });

/** El día real: una comisión de $664.73 y su IVA de $106.36 (la suma del caso de Madero). */
const DIA_BUENO = dia([cargo(), cargo({ id: 'l2', importe: 106.36, tipo: 'iva', concepto: 'IVA TASA DE DESC CREDITO/175096809' })]);

const ok = (r: ReturnType<typeof entregasDelDia>) => {
  if (!r.ok) throw new Error(`se esperaba ok, motivos: ${r.motivos.join(' · ')}`);
  return r.entregas;
};

describe('[CB.62.4] entregasDelDia', () => {
  it('⭐ la solicitud nace AUTORIZADA (A), no aplicada: la deja en F su gasto (medido: 16 vivas en A con su saldo entero)', () => {
    expect(ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA)).solicitud.estado).toBe('A');
  });

  it('un renglón por COMISIÓN y el IVA aparte en c14: el IVA no hace renglón', () => {
    const e = ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA));
    expect(e.solicitud.renglones).toHaveLength(1);
    expect(e.solicitud.renglones[0].importe).toBe(664.73);
    expect(e.solicitud.iva).toBe(106.36);
    expect(e.total).toBe(771.09);
  });

  it('el renglón lleva el concepto 199 y NO la cuenta: 611-003 la pone el catálogo del servidor (kdco, 9 de 9)', () => {
    const r = ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA)).solicitud.renglones[0] as Record<string, unknown>;
    expect(r['concepto']).toBe(CONCEPTO_COMISION);
    expect(r['concepto']).toBe('199');
    expect(r['cuenta']).toBeUndefined();
  });

  it('un pago por CARGO del banco —la comisión y su IVA aparte— con su referencia y su cuenta', () => {
    const e = ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA));
    expect(e.pagos.map((p) => [p.referencia, p.importe, p.cuenta])).toEqual([['COMISIONES', 664.73, '4885'], ['IVA', 106.36, '4885']]);
    expect(referenciaDelCargo('iva')).toBe('IVA');
  });

  it('el gasto se entrega con lo esperado (total, acreedor y fecha): el escritor no arma a ciegas', () => {
    const e = ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA));
    expect(e.gasto).toEqual({ fecha: '2026-11-19', esperado: { total: 771.09, acreedor: 'GB004', fecha: '2026-11-19' } });
  });

  it('la solicitud no trae comprobante: c25 queda vacío (439 de 442) y c11 lleva la referencia de la plantilla', () => {
    const c = ok(entregasDelDia(DIA_BUENO, PLANTILLA, CAPTURA)).solicitud.comprobante;
    expect(c.fecha).toBeNull();
    expect(c.folio).toBe('42');
  });
});

describe('[CB.62.4] la marca del día', () => {
  it('cumple la forma que exige el armador de la solicitud y es determinista', () => {
    const m = marcaDeComisiones('04', '2026-11-19', 'GB004');
    expect(m).toMatch(/^SUITE SG-[0-9A-F]{8}$/);
    expect(marcaDeComisiones('04', '2026-11-19', 'GB004')).toBe(m);
  });

  it('dos días, dos sucursales o dos bancos distintos no comparten marca', () => {
    const m = marcaDeComisiones('04', '2026-11-19', 'GB004');
    expect(marcaDeComisiones('04', '2026-11-20', 'GB004')).not.toBe(m);
    expect(marcaDeComisiones('05', '2026-11-19', 'GB004')).not.toBe(m);
    expect(marcaDeComisiones('04', '2026-11-19', 'GB006')).not.toBe(m);
  });
});

describe('[CB.62.4] fail-closed: un motivo basta', () => {
  const motivos = (r: ReturnType<typeof entregasDelDia>): string[] => (r.ok ? [] : r.motivos);

  it('⛔ un cargo que ya tiene su pago en Kepler frena el día entero', () => {
    const r = entregasDelDia(dia([cargo({ kepler_pago: '0000232' }), cargo({ id: 'l2', importe: 106.36, tipo: 'iva' })]), PLANTILLA, CAPTURA);
    expect(r.ok).toBe(false);
    expect(motivos(r).join(' ')).toContain('0000232');
  });

  it('⛔ una comisión que ya es renglón de un gasto de Finanzas frena el día', () => {
    const r = entregasDelDia(dia([cargo({ kepler_gasto: '0000321' }), cargo({ id: 'l2', importe: 106.36, tipo: 'iva' })]), PLANTILLA, CAPTURA);
    expect(r.ok).toBe(false);
    expect(motivos(r).join(' ')).toContain('0000321');
  });

  it('⛔ una plantilla sin departamento no se completa con la de otra sucursal', () => {
    expect(motivos(entregasDelDia(DIA_BUENO, { ...PLANTILLA, departamento: '  ' }, CAPTURA)).join(' ')).toContain('departamento');
  });

  it('⛔ un acreedor que no es un banco (GB…) no escribe comisiones', () => {
    const r = entregasDelDia({ ...DIA_BUENO, acreedor: 'GP010' }, { ...PLANTILLA, acreedor: 'GP010' }, CAPTURA);
    expect(r.ok).toBe(false);
    expect(motivos(r).join(' ')).toContain('no es un banco');
  });

  it('⛔ un día de puro IVA no hace gasto', () => {
    const r = entregasDelDia(dia([cargo({ importe: 106.36, tipo: 'iva' })]), PLANTILLA, CAPTURA);
    expect(r.ok).toBe(false);
    expect(motivos(r).join(' ')).toContain('un IVA solo no hace gasto');
  });

  it('⛔ un cargo sin cuenta de tesorería no se escribe (el pago no sabría de qué cuenta salió)', () => {
    const r = entregasDelDia(dia([cargo({ cuenta: '' }), cargo({ id: 'l2', importe: 106.36, tipo: 'iva' })]), PLANTILLA, CAPTURA);
    expect(r.ok).toBe(false);
    expect(motivos(r).join(' ')).toContain('cuenta de tesorería');
  });
});

/**
 * `[CB.62.4]` La referencia del pago (`c11`) tiene que CABER. Cuarto defecto del canario del
 * 2026-11-26: el servicio mandaba `«COMISIONES 05|2026-11-15|GB004»` —30 caracteres contra un
 * varchar(20)— y el pago reventaba DESPUÉS de que la solicitud y el gasto ya estaban escritos en
 * Kepler, dejando una CxP abierta (gasto 0000116 de la 05).
 *
 * Medido ese día, X-D-26 a acreedor GB% desde septiembre: 1,761 dicen «IVA», 1,713 «COMISIONES», y
 * de los 3,658 el c11 más largo mide 20.
 */
describe('[CB.62.4] la referencia del pago cabe en el c11 de Kepler', () => {
  const LARGO_C11 = 20;
  it('es exactamente lo que capturan los pagos reales', () => {
    expect(referenciaDelCargo('comision')).toBe('COMISIONES');
    expect(referenciaDelCargo('iva')).toBe('IVA');
  });
  it(`y las dos caben en varchar(${LARGO_C11})`, () => {
    for (const t of ['comision', 'iva'] as const) {
      expect(referenciaDelCargo(t).length).toBeLessThanOrEqual(LARGO_C11);
    }
  });
  it('⛔ la llave del día NO cabe: por eso no se le concatena', () => {
    expect(`${referenciaDelCargo('comision')} 05|2026-11-15|GB004`.length).toBeGreaterThan(LARGO_C11);
  });
});
