// `describe`/`it`/`expect` son globales (`globals: true` en vitest.config.ts), como en los specs hermanos.
import {
  REGLA_FACTOR_EMBARQUE, REGLA_FACTOR_PEDIDO, REGLA_FACTURA_EMBARQUE,
  cotizacionDe, hallazgoCajaCambiada, hallazgoFacturaDistinta,
  type DocumentoTlmk, type RenglonCaja,
} from './tlmk-revision.reglas';

// Los renglones REALES del embarque 06UD4101-0001823 (Canindo), leídos de prod el 2026-11-12.
const EMB: DocumentoTlmk = {
  sucursal: '06', doc_type: 41, serie: 1, folio: '0001823', folio_digital: '06UD4101-0001823',
  fecha: '2026-11-10', cliente: 'C3025', cotizacion: null,
};
const GARBANZO: RenglonCaja = {
  sku: '95641', captured_unit: 'CJA', captured_qty: 30, captured_factor: 15, base_qty: 450, base_unit: 'PAQ',
  base_unit_price: 53.14, current_factor: 15, status: 'al_dia', qty_in_current_unit: 30, base_qty_at_current_factor: 450,
};
const CHILITO: RenglonCaja = {
  sku: '95644', captured_unit: 'CJA', captured_qty: 10, captured_factor: 40, base_qty: 400, base_unit: 'PAQ',
  base_unit_price: 35.97, current_factor: 25, status: 'factor_cambio', qty_in_current_unit: 16, base_qty_at_current_factor: 250,
};

describe('[AX.22] regla 1 — capturado con una caja que ya cambió', () => {
  it('Canindo: el chilito sale, con las 16 cajas que dirá la factura y los 250 PAQ si eran cajas nuevas', () => {
    const h = hallazgoCajaCambiada(EMB, [GARBANZO, CHILITO])!;
    expect(h.rule_key).toBe(REGLA_FACTOR_EMBARQUE);
    expect(h.titulo).toContain('06UD4101-0001823');
    expect(h.titulo).toContain('1 producto(s)');
    expect(h.resumen).toContain('10 CJA de 40 = 400 PAQ');
    expect(h.resumen).toContain('la factura dirá 16 CJA');
    expect(h.resumen).toContain('250 PAQ');
    // (400 − 250) × 35.97 = 5,395.50 — lo que está en juego si salieron cajas de 25.
    expect(h.importe).toBe(5395.5);
    expect(h.evidencia['importe_medido']).toBe(true);
    expect(h.dedup_key).toBe('tlmk_caja|06|41|1|0001823');
  });

  it('NEGATIVA — un documento con todo al día no produce hallazgo (el garbanzo solo)', () => {
    expect(hallazgoCajaCambiada(EMB, [GARBANZO])).toBeNull();
  });

  it('NEGATIVA — «unidad_base_cambio» no se acusa: la vista no distingue rótulo de cambio real', () => {
    expect(hallazgoCajaCambiada(EMB, [{ ...CHILITO, status: 'unidad_base_cambio' }])).toBeNull();
  });

  it('en un pedido es la regla del pedido y pide corregir antes de surtir', () => {
    const h = hallazgoCajaCambiada({ ...EMB, doc_type: 40, folio_digital: '06UD4001-0001608' }, [CHILITO])!;
    expect(h.rule_key).toBe(REGLA_FACTOR_PEDIDO);
    expect(h.resumen).toContain('antes de surtir');
    expect(h.resumen).not.toContain('la factura dirá');
  });

  it('sin precio el importe NO se inventa: va en 0 y se declara no medido', () => {
    const h = hallazgoCajaCambiada(EMB, [{ ...CHILITO, base_unit_price: null }])!;
    expect(h.importe).toBe(0);
    expect(h.evidencia['importe_medido']).toBe(false);
    expect(h.resumen).toContain('Importe no medido');
  });
});

describe('[AX.22] regla 2 — la factura contra lo embarcado, por producto y en unidad base', () => {
  it('NEGATIVA — Canindo: la factura trae los mismos 400 PAQ que el embarque, esta regla NO lo ve', () => {
    const fac = [
      { factura: '06UD0801-0001350', sku: '95641', cantidad: 450 },
      { factura: '06UD0801-0001350', sku: '95644', cantidad: 400 },
    ];
    expect(hallazgoFacturaDistinta(EMB, [GARBANZO, CHILITO], fac)).toBeNull();
  });

  it('NEGATIVA — un embarque partido en DOS facturas que juntas cuadran no es diferencia', () => {
    const fac = [
      { factura: '06UD0801-0001350', sku: '95641', cantidad: 450 },
      { factura: '06UD0801-0001350', sku: '95644', cantidad: 150 },
      { factura: '06UD0801-0001351', sku: '95644', cantidad: 250 },
    ];
    expect(hallazgoFacturaDistinta(EMB, [GARBANZO, CHILITO], fac)).toBeNull();
  });

  it('factura con menos de lo embarcado: sale el producto, cuánto, y el importe a precio del embarque', () => {
    const fac = [
      { factura: '06UD0801-0001370', sku: '95641', cantidad: 450 },
      { factura: '06UD0801-0001370', sku: '95644', cantidad: 250 },
    ];
    const h = hallazgoFacturaDistinta(EMB, [GARBANZO, CHILITO], fac)!;
    expect(h.rule_key).toBe(REGLA_FACTURA_EMBARQUE);
    expect(h.resumen).toContain('95644: embarcado 400, facturado 250 PAQ');
    expect(h.importe).toBe(5395.5);
    expect(h.severity).toBe('critical');
    expect(h.evidencia['facturas']).toEqual(['06UD0801-0001370']);
  });

  it('un producto facturado que no se embarcó cuenta, y su importe se declara no medido', () => {
    const fac = [
      { factura: 'F1', sku: '95641', cantidad: 450 }, { factura: 'F1', sku: '95644', cantidad: 400 },
      { factura: 'F1', sku: '99999', cantidad: 5 },
    ];
    const h = hallazgoFacturaDistinta(EMB, [GARBANZO, CHILITO], fac)!;
    expect(h.evidencia['diferencias']).toEqual([{ sku: '99999', embarcado: 0, facturado: 5, diferencia: 5, unidad: null }]);
    expect(h.evidencia['importe_medido']).toBe(false);
  });

  it('sin facturas vivas no compara (eso es «embarque sin factura», AX.18)', () => {
    expect(hallazgoFacturaDistinta(EMB, [GARBANZO, CHILITO], [])).toBeNull();
  });
});

describe('[AX.22] la cotización de la Suite en el comentario del pedido', () => {
  it('la encuentra dentro del texto y no inventa una donde no hay', () => {
    expect(cotizacionDe('COT-2026-00412')).toBe('COT-2026-00412');
    expect(cotizacionDe('  COT-2026-00412 ENTREGAR TEMPRANO')).toBe('COT-2026-00412');
    expect(cotizacionDe('40  CAJAS  A-4')).toBeNull();
    expect(cotizacionDe(null)).toBeNull();
  });
});
