import {
  mapearResumen,
  mapearCabecera,
  mapearCanal,
  soloFecha,
  CLAVES_DE_DINERO,
} from './promo-agreements.mapper';

/**
 * `[MKT.1]` — El monto negociado con el proveedor NO sale del servidor para quien no debe verlo.
 *
 * ── Qué defecto vigila ───────────────────────────────────────────────────────────────────────
 * El encargado de plaza abre la misma pantalla que Mercadotecnia (necesita la mecánica para
 * ejecutarla). La tentación es esconder el monto con un `*ngIf`: eso deja el número viajando en
 * el JSON y el JSON se abre con F12. El recorte tiene que pasar en el servidor, y esto lo prueba.
 *
 * ── Por qué se prueba acá y no por HTTP ─────────────────────────────────────────────────────
 * ADR-044 manda probar por HTTP lo que toca Postgres. Acá el sujeto es otro: la **decisión de
 * recortar**, que es TypeScript puro y ocurre después de la consulta. Un test que dependiera de
 * la base para vigilar una fuga de datos sería un test que en la práctica no corre.
 */
describe('[MKT.1] El dinero se recorta en el SERVIDOR', () => {
  const filaCruda = {
    id: 'a-1',
    folio: 'MK-2026-0007',
    proveedor: 'Alteño',
    apoyo: 'sell_out',
    mecanica: '3% de descuento en toda la línea',
    status: 'vigente',
    vigencia_desde: '2026-10-05',
    vigencia_hasta: '2026-10-16',
    vigencia_hasta_texto: null,
    monto: '76946.02',
    presupuesto_tipo: 'topado',
    presupuesto_detalle: '50 cajas para la 1ª compra',
    presupuesto_fecha: '2026-10-16',
    conceptos: 'Agendar reporte de lo vendido',
    empresa: 'Mega Dulces De Los Altos',
    canales_total: 10,
    canales_con_evidencia: 6,
    evidencia_total: 18,
  };

  it('⭐ NEGATIVA: sin permiso de gestión, la clave `monto` NO EXISTE en la salida', () => {
    const r = mapearResumen(filaCruda, false);
    // `toBeUndefined` no alcanza: un `{monto: undefined}` serializado a JSON sí omite la clave,
    // pero deja el campo declarado y el próximo `Object.assign` lo puede revivir. Se exige que
    // la propiedad no esté.
    expect('monto' in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain('76946');
  });

  it('⭐ NEGATIVA: la carátula tampoco lleva NINGUNA de las cinco claves de dinero', () => {
    const c = mapearCabecera(filaCruda, false);
    for (const clave of CLAVES_DE_DINERO) {
      expect(clave in c).toBe(false);
    }
    const json = JSON.stringify(c);
    expect(json).not.toContain('76946');
    expect(json).not.toContain('50 cajas');
    // Lo que sí tiene que llegarle a la plaza: la mecánica, que es lo que va a ejecutar.
    expect(c['mecanica']).toBe('3% de descuento en toda la línea');
  });

  it('CONTROL POSITIVO: con permiso de gestión sí viaja, y como número', () => {
    const r = mapearResumen(filaCruda, true);
    expect(r.monto).toBe(76946.02);              // `numeric` de pg llega string: se convierte
    const c = mapearCabecera(filaCruda, true);
    expect(c['presupuesto_detalle']).toBe('50 cajas para la 1ª compra');
  });

  it('⭐ ausente ≠ null: "no te toca verlo" y "no se pactó monto" son distintos', () => {
    const sinMonto = { ...filaCruda, monto: null };
    // Quien PUEDE ver: recibe la clave en null — el acuerdo no tiene monto pactado.
    const visible = mapearResumen(sinMonto, true);
    expect('monto' in visible).toBe(true);
    expect(visible.monto).toBeNull();
    // Quien NO puede ver: la clave no llega. Si las dos formas fueran iguales, la pantalla no
    // podría distinguir "sin monto" de "sin permiso" y dibujaría $0 en los dos casos (ADR-056).
    const oculto = mapearResumen(sinMonto, false);
    expect('monto' in oculto).toBe(false);
  });

  it('el monto NUNCA se colapsa a 0 cuando no se pactó', () => {
    const r = mapearResumen({ ...filaCruda, monto: null }, true);
    expect(r.monto).not.toBe(0);
    expect(r.monto).toBeNull();
  });
});

describe('[MKT.1] La fecha no se corre un día', () => {
  it('⭐ un `date` de pg a medianoche UTC NO retrocede al día anterior', () => {
    // Éste es el error exacto que la Fase LC pagó: `String(new Date('2026-09-01'))` en hora de
    // México (−06:00) imprime "Aug 31". Se corta el string, no se construye un Date.
    expect(soloFecha('2026-09-01T00:00:00.000Z')).toBe('2026-09-01');
    expect(soloFecha('2026-10-16')).toBe('2026-10-16');
  });

  it('sin fecha devuelve null, no la cadena "null" ni hoy', () => {
    expect(soloFecha(null)).toBeNull();
    expect(soloFecha(undefined)).toBeNull();
  });
});

describe('[MKT.1] La cobertura del expediente se DERIVA', () => {
  const canal = {
    id: 'c-1',
    warehouse_code: '01',
    warehouse_name: 'Padre Hidalgo',
    cajas_texto: '13 cj 20054',
    cajas_lp: null,
    cajas_can: null,
    cajas_mor: null,
    con_cargo: true,
    evidence_required: 3,
    evidence_count: 1,
    evidence_last_at: '2026-10-08T17:20:00.000Z',
  };

  it('con menos evidencia de la pedida, el expediente NO está completo', () => {
    expect(mapearCanal(canal).completo).toBe(false);
  });

  it('con la evidencia justa, completo', () => {
    expect(mapearCanal({ ...canal, evidence_count: 3 }).completo).toBe(true);
  });

  it('⭐ con evidencia DE MÁS sigue completo — `>=`, no `===`', () => {
    // Una plaza que sube cuatro fotos en vez de tres no puede quedar marcada como pendiente.
    expect(mapearCanal({ ...canal, evidence_count: 4 }).completo).toBe(true);
  });

  it('`evidence_required: 0` (no se le pide evidencia) queda completo desde el arranque', () => {
    expect(mapearCanal({ ...canal, evidence_required: 0, evidence_count: 0 }).completo).toBe(true);
  });

  it('el desglose LP/CAN/MOR que no aplica llega NULL, no 0', () => {
    // Un 0 diría "cero cajas a esa plaza"; NULL dice "este canal no se desglosa".
    const c = mapearCanal(canal);
    expect(c.cajas_lp).toBeNull();
    expect(c.cajas_can).toBeNull();
  });

  it('el desglose que SÍ aplica llega como número', () => {
    const c = mapearCanal({ ...canal, cajas_lp: '8', cajas_can: '6', cajas_mor: '10' });
    expect(c.cajas_lp).toBe(8);
    expect(c.cajas_mor).toBe(10);
  });
});
