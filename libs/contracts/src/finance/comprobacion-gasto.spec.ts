import {
  comprobacionDelVale, montoDelAviso, montoLeidoDelVale, QUIEN_RESUELVE_TEXTO, totalParaComprobar, type SolicitudAComprobar, type ValeAComprobar,
} from './comprobacion-gasto.contract';

/**
 * `[PGP.123]` G.5 — Candado de «cuándo se comprueba» (anexo G §5.1). Cada condición tiene su caso con su motivo y a
 * quién le toca, y el caso feliz trae la fecha del gasto (DG1). Datos sintéticos (repo público).
 */
const HOY = '2026-11-15';
const vale = (over: Partial<ValeAComprobar> = {}): ValeAComprobar => ({
  status: 'validada', sucursal: '05', folio_solicitud: '0000420', total: 116, cfdi: null, ...over,
});
const sol = (over: Partial<SolicitudAComprobar> = {}): SolicitudAComprobar => ({
  estado: 'A', total: 116, saldo: 116, retencion: 0, fecha: '2026-11-10', acreedor_rfc: 'QZA991231AA1', gasto_vivo: false, ...over,
});
const motivo = (v: Partial<ValeAComprobar>, s: Partial<SolicitudAComprobar> | null = {}) => {
  const r = comprobacionDelVale(vale(v), s === null ? null : sol(s), HOY);
  return r.listo ? 'listo' : `${r.motivo}/${r.quien}`;
};

describe('[PGP.123] comprobacionDelVale', () => {
  it('⭐ validado, con su X-A-15 autorizada y su saldo completo, del mes en curso: listo, con la fecha de la solicitud', () => {
    expect(comprobacionDelVale(vale(), sol(), HOY)).toEqual({ listo: true, fecha: '2026-11-10' });
  });

  it('con un CFDI que casa (total al centavo y RFC con un dedazo de Kepler): listo', () => {
    expect(motivo({ cfdi: { uuid: 'u', total: 116, emisor_rfc: 'QZA991231AA1', retenciones: 0 } })).toBe('listo');
    expect(motivo({ cfdi: { uuid: 'u', total: 116, emisor_rfc: 'QZA991231AA1', retenciones: 0 } }, { acreedor_rfc: 'QZA-991231-AA1' })).toBe('listo');
  });

  it('⛔ el vale trae factura y no se pudo leer (o no está en la Suite): sin_medir, nunca «sin factura»', () => {
    expect(motivo({ cfdi: null, cfdi_declarado: true })).toBe('sin_medir/nadie');
    expect(motivo({ cfdi_declarado: true, cfdi: { uuid: 'u', total: 116, emisor_rfc: 'QZA991231AA1', retenciones: 0 } })).toBe('listo');
    expect(motivo({ cfdi: null, cfdi_declarado: false })).toBe('listo');
    // El orden se respeta: lo que una persona arreglaría antes (la solicitud cancelada) sigue ganando.
    expect(motivo({ cfdi: null, cfdi_declarado: true }, { estado: 'C' })).toBe('cancelada/finanzas');
  });

  it('⛔ GX.9: el vale casado se compara con lo que DECLARÓ quien lo capturó, no con el total que le puso Kepler', () => {
    expect(totalParaComprobar(1000, { importe_declarado: 900, casado_por: 'x' })).toBe(900);
    expect(totalParaComprobar('1000.00', JSON.stringify({ importe_declarado: 1000 }))).toBe(1000);
    expect(totalParaComprobar(116, null)).toBe(116);
    expect(totalParaComprobar(116, '{roto')).toBe(116);
    expect(totalParaComprobar(null, {})).toBeNull();
    // Y con eso, G.5 lo deja en Kepler: un gasto distinto de su solicitud no se escribe solo.
    expect(motivo({ total: totalParaComprobar(116, { importe_declarado: 90 }) })).toBe('total_distinto/sucursal');
  });

  it('el trámite de la Suite: rechazado no se comprueba; sin validar todavía, le toca a la Suite', () => {
    expect(motivo({ status: 'rechazada' })).toBe('rechazado/nadie');
    expect(motivo({ status: 'aprobada' })).toBe('sin_cerrar/suite');
    expect(motivo({ status: 'revision' })).toBe('sin_cerrar/suite');
    expect(motivo({ folio_solicitud: null })).toBe('sin_solicitud/suite');
    expect(motivo({ sucursal: ' ' })).toBe('sin_solicitud/suite');
  });

  it('⛔ si no se pudo leer la solicitud se DICE (sin_medir), no se adivina', () => {
    expect(motivo({}, null)).toBe('sin_medir/nadie');
    expect(motivo({}, { fecha: '10/11/2026' })).toBe('sin_medir/nadie');
  });

  it('el estado en Kepler: con gasto, aplicada, cancelada o sin autorizar', () => {
    expect(motivo({}, { gasto_vivo: true })).toBe('ya_comprobado/nadie');
    expect(motivo({}, { estado: 'F' })).toBe('ya_comprobado/nadie');
    expect(motivo({}, { estado: 'C' })).toBe('cancelada/finanzas');
    expect(motivo({}, { estado: 'N' })).toBe('sin_autorizar/finanzas');
  });

  it('⛔ lo que Kepler deja pasar y la Suite no: saldo usado, retención, total distinto', () => {
    expect(motivo({}, { saldo: 16 })).toBe('saldo_parcial/sucursal');
    expect(motivo({}, { retencion: 1.25 })).toBe('retencion/contabilidad');
    expect(motivo({ total: 116.01 })).toBe('total_distinto/sucursal');
    expect(motivo({ total: null })).toBe('total_distinto/sucursal');
  });

  it('⛔ una factura que no casa: por total, por RFC de otro, o con retenciones', () => {
    expect(motivo({ cfdi: { uuid: 'u', total: 115, emisor_rfc: 'QZA991231AA1', retenciones: 0 } })).toBe('factura_distinta/sucursal');
    expect(motivo({ cfdi: { uuid: 'u', total: 116, emisor_rfc: 'QZB881231BB2', retenciones: 0 } })).toBe('factura_distinta/sucursal');
    expect(motivo({ cfdi: { uuid: 'u', total: 116, emisor_rfc: 'QZA991231AA1', retenciones: 1.25 } })).toBe('retencion/contabilidad');
  });

  it('⭐ DG1: una solicitud de otro mes no se comprueba sola (su póliza caería en un mes ya revisado)', () => {
    const r = comprobacionDelVale(vale(), sol({ fecha: '2026-10-30' }), HOY);
    expect(r).toMatchObject({ listo: false, motivo: 'fecha_otro_mes', quien: 'contabilidad' });
    expect(r.listo ? '' : r.texto).toContain('octubre');
    expect(motivo({}, { fecha: '2026-11-16' })).toBe('fecha_futura/sucursal');
    expect(motivo({}, { fecha: '2026-11-01' })).toBe('listo');
  });

  it('⭐ quién: la comprobación en Kepler es de la sucursal; Finanzas sólo autoriza (Francisco, 2026-11-17)', () => {
    // Todo lo que «se comprueba en Kepler» a mano lo hace la sucursal: el «Alta gasto CFDI» es suyo.
    for (const m of [motivo({}, { saldo: 16 }), motivo({ total: 116.01 }), motivo({}, { fecha: '2026-11-16' }),
      motivo({ cfdi: { uuid: 'u', total: 115, emisor_rfc: 'QZA991231AA1', retenciones: 0 } })]) {
      expect(m.endsWith('/sucursal')).toBe(true);
    }
    // Finanzas autoriza la solicitud (y revisa la cancelada); no comprueba.
    expect(motivo({}, { estado: 'N' })).toBe('sin_autorizar/finanzas');
    expect(QUIEN_RESUELVE_TEXTO).toEqual({
      nadie: 'nadie', suite: 'la Suite', sucursal: 'la sucursal, en Kepler', finanzas: 'Finanzas, en Kepler', contabilidad: 'Contabilidad',
    });
  });

  it('el primer motivo gana, en el orden en que se arreglaría', () => {
    // Rechazado manda sobre todo; con gasto vivo no importa que el total difiera.
    expect(motivo({ status: 'rechazada', total: 1 }, { estado: 'C' })).toBe('rechazado/nadie');
    expect(motivo({ total: 1 }, { gasto_vivo: true })).toBe('ya_comprobado/nadie');
  });

  it('⭐ DG12 (Edgar, 2026-11-20): si la lectura del comprobante dijo otro monto, no se comprueba sola: la sucursal compara', () => {
    const r = comprobacionDelVale(vale({ monto_leido: 6032.48 }), sol(), HOY);
    expect(r).toMatchObject({ listo: false, motivo: 'lectura_distinta', quien: 'sucursal' });
    expect(r.listo ? '' : r.texto).toContain('$6,032.48');
    // Misma tolerancia que el lector: $1 o el 1 % (redondeo e IVA) se da por bueno.
    expect(motivo({ monto_leido: 116.99 })).toBe('listo');
    expect(motivo({ monto_leido: 115.01 })).toBe('listo');
    expect(motivo({ monto_leido: 117.16 })).toBe('listo');               // $116 × 1 % = $1.16
    expect(motivo({ monto_leido: 117.2 })).toBe('lectura_distinta/sucursal');
    expect(motivo({ total: 2000, monto_leido: 2019 }, { total: 2000, saldo: 2000 })).toBe('listo');
    expect(motivo({ total: 2000, monto_leido: 2021 }, { total: 2000, saldo: 2000 })).toBe('lectura_distinta/sucursal');
    // ⛔ NEGATIVA: sin lectura (o cuadró) no frena nada.
    expect(motivo({ monto_leido: null })).toBe('listo');
    expect(motivo({ monto_leido: undefined })).toBe('listo');
    expect(motivo({ monto_leido: Number.NaN })).toBe('listo');
    // El orden: lo de la solicitud y la factura gana; la fecha de otro mes va después (Contabilidad no la ve sin comparar).
    expect(motivo({ monto_leido: 5000 }, { estado: 'N' })).toBe('sin_autorizar/finanzas');
    expect(motivo({ monto_leido: 5000 }, { fecha: '2026-10-30' })).toBe('lectura_distinta/sucursal');
  });

  it('DG12: el monto leído sale de monto_ocr y, si falta, del aviso del lector', () => {
    expect(montoLeidoDelVale('6032.48', null)).toBe(6032.48);
    expect(montoLeidoDelVale(0, 'El comprobante dice $9.00')).toBe(0);
    expect(montoLeidoDelVale(null, '⚠ El comprobante dice $140,007.59 y la solicitud $126.59 (difieren $139,881.00). Revísalo antes de autorizar.')).toBe(140007.59);
    expect(montoLeidoDelVale(null, 'Evidencia subida por quien capturó — falta que alguien la revise · ⚠ El comprobante dice $24.27 y la solicitud $21.00')).toBe(24.27);
    expect(montoDelAviso('⚠ El comprobante dice $1,100 y la solicitud $1,000.00')).toBe(1100);
    // ⛔ NEGATIVA: el aviso de ilegible, una nota cualquiera o nada no inventan un monto.
    expect(montoLeidoDelVale(null, 'No se pudo leer el comprobante automáticamente — revísalo a mano.')).toBeNull();
    expect(montoLeidoDelVale('', 'Evidencia subida por quien capturó — falta que alguien la revise')).toBeNull();
    expect(montoLeidoDelVale(undefined, undefined)).toBeNull();
    expect(montoDelAviso('El comprobante dice $— y la solicitud $5.00')).toBeNull();
  });
});
