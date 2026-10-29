/**
 * `[CGA-A.62]` ¿Se aprobó antes de pagarse? Pago X-D-26 → solicitud X-A-15-1 → vale → firma.
 * Casos con la forma de los reales del 23–28/10/26 (la nómina de Yurécuaro: solicitud del 23/10,
 * pago del 28/10 a las 09:52). Cada regla lleva la negativa que la rompe.
 */
import { aprobacionDePagos, juzgarVale, type PagoParaAprobar, type SolicitudKepler, type ValeDeGasto } from './pago-aprobado.engine';

const mx = (diaHora: string) => new Date(`${diaHora}:00-06:00`).toISOString();
const pago = (clave: string, importe: number, pagado: string, beneficiario = 'NOMINA', sucursal = '04'): PagoParaAprobar => ({
  clave, sucursal, importe, beneficiario, pagado_at: mx(pagado), fecha_pago: pagado.slice(0, 10),
});
const sol = (folio: string, importe: number, capturada: string, beneficiario = 'NOMINA', estado = 'F', sucursal = '04'): SolicitudKepler => ({
  sucursal, folio, importe, beneficiario, estado, capturado_at: mx(capturada), fecha: capturada.slice(0, 10),
});
const vale = (folio: string, status: string, creado: string, extra: Partial<ValeDeGasto> = {}): ValeDeGasto => ({
  id: `v-${folio}`, sucursal: '04', folio_solicitud: folio, status, created_at: mx(creado),
  aprobado_at: null, aprobado_por: null, validated_at: null, validated_by: null, evidencia_at: null, ...extra,
});
const NOMINA_28 = pago('04|X-D-26|0000088|0011', 493, '2026-10-28T09:52');
const SOL_23 = sol('0000077', 493, '2026-10-23T10:15');

describe('[CGA-A.62] el pago casa con SU solicitud', () => {
  it('nómina de Yurécuaro: la solicitud del 23/10 ampara el pago del 28/10', () => {
    const r = aprobacionDePagos([NOMINA_28], [SOL_23], [vale('0000077', 'validada', '2026-10-23T11:00', { aprobado_at: mx('2026-10-24T08:30') })]);
    expect(r.get(NOMINA_28.clave)).toMatchObject({ estado: 'aprobado_antes', solicitud_folio: '0000077', firma_exacta: true, bloquea: false, alerta: false });
  });

  it('la nómina repite importe cada semana: cada pago toma la solicitud más reciente ANTES de él, una vez', () => {
    const p21 = pago('04|X-D-26|0000080|0011', 493, '2026-10-21T09:40');
    const r = aprobacionDePagos([NOMINA_28, p21], [SOL_23, sol('0000070', 493, '2026-10-16T10:00')], []);
    expect(r.get(NOMINA_28.clave)?.solicitud_folio).toBe('0000077');
    expect(r.get(p21.clave)?.solicitud_folio).toBe('0000070');
  });

  it('NEGATIVA: una solicitud ampara UN pago; el segundo pago del mismo importe queda sin solicitud', () => {
    const p29 = pago('04|X-D-26|0000089|0011', 493, '2026-10-29T09:50');
    const r = aprobacionDePagos([p29, NOMINA_28], [SOL_23], []);
    expect(r.get(NOMINA_28.clave)?.solicitud_folio).toBe('0000077');
    expect(r.get(p29.clave)?.estado).toBe('sin_solicitud');
  });

  it('PLACEBO: con $1 de diferencia no hay solicitud', () => {
    expect(aprobacionDePagos([NOMINA_28], [sol('0000077', 494, '2026-10-23T10:15')], []).get(NOMINA_28.clave)?.estado).toBe('sin_solicitud');
  });

  it('NEGATIVA: otra sucursal, otro beneficiario o una solicitud cancelada no amparan', () => {
    for (const s of [sol('0000077', 493, '2026-10-23T10:15', 'NOMINA', 'F', '05'), sol('0000077', 493, '2026-10-23T10:15', 'BBVA MEXICO SA'),
      sol('0000077', 493, '2026-10-23T10:15', 'NOMINA', 'C')]) {
      expect(aprobacionDePagos([NOMINA_28], [s], []).get(NOMINA_28.clave)?.estado).toBe('sin_solicitud');
    }
  });

  it('el beneficiario se compara normalizado: «Nómina» = «NOMINA»', () => {
    expect(aprobacionDePagos([NOMINA_28], [sol('0000077', 493, '2026-10-23T10:15', 'Nómina')], []).get(NOMINA_28.clave)?.estado).toBe('sin_vale');
  });

  it('⚠️ la solicitud FECHADA el día del pago pero capturada después: se regularizó tarde, y se dice', () => {
    const tarde = { ...sol('0000090', 493, '2026-10-29T10:00'), fecha: '2026-10-28' };
    const r = aprobacionDePagos([NOMINA_28], [tarde], []).get(NOMINA_28.clave);
    expect(r).toMatchObject({ estado: 'solicitud_despues', alerta: true, bloquea: false });
  });

  it('NEGATIVA: capturada después y FECHADA después es de otro pago (caja chica repite importe)', () => {
    expect(aprobacionDePagos([NOMINA_28], [sol('0000090', 493, '2026-10-29T10:00')], []).get(NOMINA_28.clave)?.estado).toBe('sin_solicitud');
  });

  it('NEGATIVA: una solicitud de hace más de 30 días es de otro pago', () => {
    expect(aprobacionDePagos([NOMINA_28], [sol('0000010', 493, '2026-09-20T10:00')], []).get(NOMINA_28.clave)?.estado).toBe('sin_solicitud');
  });
});

describe('[CGA-A.62] el vale contra la hora del pago', () => {
  const P = mx('2026-10-28T09:52');

  it('⛔ espera firma o se rechazó: bloquea', () => {
    expect(juzgarVale(vale('1', 'recibida', '2026-10-23T11:00'), P, '1')).toMatchObject({ estado: 'sin_firma', bloquea: true });
    expect(juzgarVale(vale('1', 'rechazada', '2026-10-23T11:00'), P, '1')).toMatchObject({ estado: 'rechazado', bloquea: true });
  });

  it('⚠️ firmado con hora exacta DESPUÉS del pago', () => {
    expect(juzgarVale(vale('1', 'aprobada', '2026-10-23T11:00', { aprobado_at: mx('2026-10-28T10:30') }), P, '1'))
      .toMatchObject({ estado: 'aprobado_despues', alerta: true, firma_exacta: true });
  });

  it('⚠️ el vale se levantó después del pago', () => {
    expect(juzgarVale(vale('1', 'validada', '2026-10-28T12:00', { validated_at: mx('2026-10-28T12:05'), validated_by: 'maria' }), P, '1'))
      .toMatchObject({ estado: 'vale_despues', alerta: true });
  });

  it('sin hora exacta: la evidencia ANTES del pago prueba que la firma fue antes', () => {
    expect(juzgarVale(vale('1', 'validada', '2026-10-23T11:00', { evidencia_at: mx('2026-10-25T09:00'), validated_at: mx('2026-10-29T09:00'), validated_by: 'maria' }), P, '1'))
      .toMatchObject({ estado: 'aprobado_antes', firma_exacta: false });
  });

  it('sin hora exacta y con la evidencia después: NO se afirma ni antes ni después', () => {
    expect(juzgarVale(vale('1', 'revision', '2026-10-23T11:00', { evidencia_at: mx('2026-10-29T09:00') }), P, '1'))
      .toMatchObject({ estado: 'aprobado_sin_hora', alerta: false, bloquea: false });
  });

  it('NEGATIVA: el cierre de Kepler no es una firma, aunque sea anterior al pago', () => {
    const k = vale('1', 'validada', '2026-10-23T11:00', { validated_at: mx('2026-10-24T09:00'), validated_by: 'Kepler: autorizado y aplicado (el dinero salió)' });
    expect(juzgarVale(k, P, '1')).toMatchObject({ estado: 'cerrado_por_kepler', firma_exacta: false });
  });

  it('el vale más reciente de la solicitud es el que cuenta (uno rechazado y luego uno aprobado)', () => {
    const r = aprobacionDePagos([NOMINA_28], [SOL_23], [
      vale('0000077', 'rechazada', '2026-10-23T11:00'),
      { ...vale('0000077', 'aprobada', '2026-10-24T09:00', { aprobado_at: mx('2026-10-24T10:00') }), id: 'v2' },
    ]);
    expect(r.get(NOMINA_28.clave)).toMatchObject({ estado: 'aprobado_antes', vale_id: 'v2' });
  });
});
