import {
  CfdiCandidato, EntradaVeredicto, LlavesLiga, cuadra, diferenciasUuid, extraerUuid, hallazgosDe, ligarCfdi, notaQueExplica,
  promoverRfcImporte, proveedorEnContpaqi, veredictoExpediente,
} from './expediente-verdict';

const UUID = '6F2C1A9E-0B3D-4C55-9A10-7E21B44C09A1';

function cfdi(p: Partial<CfdiCandidato> = {}): CfdiCandidato {
  return {
    id: 'c1', uuid: UUID, serie: 'A', folio: '5521', fecha: '2026-09-21', fecha_timbrado: '2026-09-21',
    emisor_rfc: 'ACO101112411', emisor_nombre: 'AZTECA CONFITERIA', emisor_regimen: '601',
    receptor_rfc: 'LOGL851014AQ5', receptor_regimen: '612', uso_cfdi: 'G01', metodo_pago: 'PPD', forma_pago: '99',
    moneda: 'MXN', tipo_cambio: 1, subtotal: 48210.5, descuento: 0, total: 48210.5,
    total_trasladados: 0, total_retenidos: 0, iva_trasladado: 0, ieps_trasladado: 0, ieps_por_cuota: false,
    lugar_expedicion: '58000', estatus_sat: 'desconocido', ...p,
  };
}

function base(p: Partial<EntradaVeredicto> = {}): EntradaVeredicto {
  const c = p.cfdi === undefined ? cfdi() : p.cfdi;
  return {
    docTipo: 'factura',
    entrada: {
      monto: 48210.5, oc_folio: '0000291', fecha_recepcion: '2026-09-22', fecha_recepcion_usuario: 'USR-A',
      receipt_date: '2026-09-21', proveedor_nombre: 'AZTECA CONFITERIA, S.A. DE C.V.', interno: false,
    },
    cfdi: c,
    liga: c ? { metodo: 'uuid', exacta: true, candidatos: 1 } : null,
    ambiguos: 0,
    totalLeido: 48210.5,
    fechaDocumento: '2026-09-21',
    historial: { regimenes: { '601': 20 }, metodos: { PPD: 20 }, nombres: { 'AZTECA CONFITERIA': 20 } },
    ctx: { receptorRfc: 'LOGL851014AQ5', receptorRegimen: '612', listasSat: [] },
    hoy: '2026-10-06',
    ...p,
  };
}
const check = (v: ReturnType<typeof veredictoExpediente>, clave: string) => v.checks.find((c) => c.clave === clave);

describe('cuadra (< 0.25% Y < $200)', () => {
  it('pasa por debajo de las dos', () => expect(cuadra(199.99, 100000)).toBe(true));
  it('prueba negativa: exactamente $200 no pasa', () => expect(cuadra(200, 1000000)).toBe(false));
  it('prueba negativa: exactamente 0.25% no pasa', () => expect(cuadra(25, 10000)).toBe(false));
  it('en factura chica manda el porcentaje', () => expect(cuadra(150, 20000)).toBe(false));
  it('vale para los dos signos', () => expect(cuadra(-150, 100000)).toBe(true));
});

describe('veredictoExpediente', () => {
  it('factura perfecta pasa sola', () => {
    const v = veredictoExpediente(base());
    expect(v.cubo).toBe('auto');
    expect(v.motivos).toEqual([]);
    // F8 se declara sin medir (ContPAQi no trae el estatus), pero no bloquea.
    expect(check(v, 'F8_estatus')?.estado).toBe('sin_medir');
  });

  it('diferencia de $279 cae a revisar con el motivo dicho', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 - 279.15 }) }));
    expect(v.cubo).toBe('revisar');
    expect(v.diferencia).toBe(-279.15);
    expect(v.motivos[0]).toMatch(/menor/);
  });

  it('sin OC no hay excepción y dice quién capturó', () => {
    const v = veredictoExpediente(base({ entrada: { ...base().entrada, oc_folio: null } }));
    expect(v.cubo).toBe('revisar');
    expect(check(v, 'E2_oc')?.nota).toMatch(/USR-A/);
  });

  it('PUE con forma 99 no pasa', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ metodo_pago: 'PUE', forma_pago: '99' }), historial: null }));
    expect(check(v, 'F5_metodo_forma')?.estado).toBe('falla');
    expect(v.cubo).toBe('revisar');
  });

  it('PPD sin forma 99 no pasa', () => {
    expect(check(veredictoExpediente(base({ cfdi: cfdi({ forma_pago: '03' }) })), 'F5_metodo_forma')?.estado).toBe('falla');
  });

  it('método distinto del habitual del emisor no pasa', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ metodo_pago: 'PUE', forma_pago: '03' }) }));
    expect(check(v, 'F6_metodo')?.estado).toBe('falla');
  });

  it('emisor que usa los dos métodos acepta cualquiera', () => {
    const v = veredictoExpediente(base({
      cfdi: cfdi({ metodo_pago: 'PUE', forma_pago: '03' }),
      historial: { regimenes: { '601': 10 }, metodos: { PPD: 6, PUE: 4 }, nombres: { 'AZTECA CONFITERIA': 10 } },
    }));
    expect(check(v, 'F6_metodo')?.estado).toBe('ok');
  });

  it('régimen que no corresponde al tipo de persona no pasa', () => {
    expect(check(veredictoExpediente(base({ cfdi: cfdi({ emisor_regimen: '612' }) })), 'F4_regimen_emisor')?.estado).toBe('falla');
  });

  it('régimen alterno ya usado por el emisor sí pasa (612/621)', () => {
    const v = veredictoExpediente(base({
      cfdi: cfdi({ emisor_rfc: 'PFPF800101AB1', emisor_regimen: '612' }),
      historial: { regimenes: { '621': 11, '612': 9 }, metodos: { PPD: 20 }, nombres: { 'AZTECA CONFITERIA': 20 } },
    }));
    expect(check(v, 'F4_regimen_emisor')?.estado).toBe('ok');
  });

  it('nombre distinto en Kepler pasa si es el que ese RFC usa siempre', () => {
    const v = veredictoExpediente(base({
      entrada: { ...base().entrada, proveedor_nombre: 'TRESMONTES LUCHETTI (NUTRESA)' },
      cfdi: cfdi({ emisor_nombre: 'TRESMONTES LUCCHETTI MEXICO' }),
      historial: { regimenes: { '601': 9 }, metodos: { PPD: 9 }, nombres: { 'TRESMONTES LUCCHETTI MEXICO': 9 } },
    }));
    expect(check(v, 'F7_nombre')?.estado).toBe('ok');
  });

  it('prueba negativa: un emisor distinto sin historia no pasa por nombre', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ emisor_nombre: 'BOLSAS DE LOS ALTOS' }), historial: null }));
    expect(check(v, 'F7_nombre')?.estado).toBe('falla');
  });

  it('receptor distinto, uso distinto de G01, moneda extranjera y retenciones no pasan', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ receptor_rfc: 'XAXX010101000', uso_cfdi: 'G03', moneda: 'USD', total_retenidos: 50 }) }));
    for (const k of ['F1_receptor', 'F3_uso', 'F10_moneda', 'F11_retenciones']) expect(check(v, k)?.estado).toBe('falla');
  });

  it('factura cancelada nunca pasa sola', () => {
    expect(veredictoExpediente(base({ cfdi: cfdi({ estatus_sat: 'cancelado' }) })).cubo).toBe('revisar');
  });

  it('emisor en lista 69-B bloquea; en lista 69 sólo avisa', () => {
    const efos = veredictoExpediente(base({ ctx: { ...base().ctx, listasSat: [{ lista: '69-B', situacion: 'Definitivo' }] } }));
    expect(efos.cubo).toBe('revisar');
    const l69 = veredictoExpediente(base({ ctx: { ...base().ctx, listasSat: [{ lista: '69', situacion: 'FIRMES' }] } }));
    expect(l69.cubo).toBe('auto');
    expect(check(l69, 'F9_listas_sat')?.estado).toBe('aviso');
  });

  it('IEPS por cuota avisa pero no bloquea', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ ieps_trasladado: 120, ieps_por_cuota: true }) }));
    expect(v.cubo).toBe('auto');
    expect(check(v, 'F12_ieps_cuota')?.estado).toBe('aviso');
  });

  it('liga sugerida obliga a confirmar', () => {
    const v = veredictoExpediente(base({ liga: { metodo: 'total_fecha', exacta: false, candidatos: 1 } }));
    expect(v.cubo).toBe('revisar');
  });

  it('factura sin CFDI: reciente espera, vieja se revisa, ambigua se revisa', () => {
    expect(veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-10-05' })).cubo).toBe('sin_cfdi_aun');
    expect(veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-09-01' })).cubo).toBe('revisar');
    expect(veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-10-05', ambiguos: 3 })).cubo).toBe('revisar');
  });

  it('remisión: sólo cuadre, OC y fecha', () => {
    const ok = veredictoExpediente(base({ docTipo: 'remision', cfdi: null, totalLeido: 48210.5 }));
    expect(ok.cubo).toBe('auto');
    expect(ok.checks.every((c) => c.grupo === 'entrada')).toBe(true);
    expect(veredictoExpediente(base({ docTipo: 'remision', cfdi: null, totalLeido: null })).cubo).toBe('revisar');
  });

  it('sin documento y proveedor interno tienen su propio cubo', () => {
    expect(veredictoExpediente(base({ docTipo: 'ninguno' })).cubo).toBe('sin_documento');
    expect(veredictoExpediente(base({ entrada: { ...base().entrada, interno: true } })).cubo).toBe('fuera_de_alcance');
  });

  it('sin fecha de recepción (Wincaja) no pasa sola: se declara sin medir', () => {
    const v = veredictoExpediente(base({ entrada: { ...base().entrada, fecha_recepcion: null } }));
    expect(check(v, 'E3_recepcion')?.estado).toBe('sin_medir');
    expect(v.cubo).toBe('revisar');
  });
});

describe('ligarCfdi', () => {
  const llaves = (p: Partial<LlavesLiga> = {}): LlavesLiga => ({
    uuidLeido: null, folioLeido: null, rfcLeido: null, totalLeido: null, fechaLeida: null,
    rfcKepler: null, montoEntrada: 48210.5, fechaEntrada: '2026-09-21', asignadoId: null, ...p,
  });
  const otro = cfdi({ id: 'c2', uuid: '11111111-2222-3333-4444-555555555555', folio: '9000', total: 1000, emisor_rfc: 'BAL020930EL9' });

  it('la asignación ya confirmada gana', () => {
    const r = ligarCfdi(llaves({ asignadoId: 'c2', uuidLeido: UUID }), [cfdi(), otro]);
    expect(r.cfdi?.id).toBe('c2');
    expect(r.liga?.metodo).toBe('asignado');
  });

  it('UUID exacto', () => {
    const r = ligarCfdi(llaves({ uuidLeido: UUID.toLowerCase() }), [cfdi(), otro]);
    expect(r.liga).toEqual({ metodo: 'uuid', exacta: true, candidatos: 1 });
  });

  it('UUID con 2 caracteres mal leídos se corrige', () => {
    const mal = '6F2C1A9E-0B3D-4C55-9A10-7E21B44C0941'.replace('B44', '844');
    expect(diferenciasUuid(mal, UUID)).toBeLessThanOrEqual(3);
    const r = ligarCfdi(llaves({ uuidLeido: mal }), [cfdi(), otro]);
    expect(r.liga?.metodo).toBe('uuid_corregido');
  });

  it('prueba negativa: UUID corregible a DOS candidatos no elige', () => {
    const gemelo = cfdi({ id: 'c3', uuid: UUID.slice(0, 35) + 'F', folio: null, total: 1 });
    const mal = UUID.slice(0, 34) + 'ZZ';
    const r = ligarCfdi(llaves({ uuidLeido: mal }), [cfdi({ folio: null, total: 2 }), gemelo]);
    expect(r.cfdi).toBeNull();
    expect(r.ambiguos).toBe(2);
  });

  it('RFC con glifo del OCR + folio liga como exacta (dos llaves impresas)', () => {
    const r = ligarCfdi(llaves({ rfcLeido: 'ACO1011124I1', folioLeido: 'No. 5521' }), [cfdi(), otro]);
    expect(r.liga).toEqual({ metodo: 'rfc_folio', exacta: true, candidatos: 1 });
  });

  it('RFC de Kepler + importe de la entrada es sólo sugerencia', () => {
    const r = ligarCfdi(llaves({ rfcKepler: 'ACO101112411' }), [cfdi(), otro]);
    expect(r.liga).toEqual({ metodo: 'rfc_importe', exacta: false, candidatos: 1 });
  });

  it('total + fecha cercana cuando no hay RFC', () => {
    const r = ligarCfdi(llaves({ totalLeido: 48210.5, fechaLeida: '2026-09-22' }), [cfdi(), otro]);
    expect(r.liga?.metodo).toBe('total_fecha');
  });

  it('sin llaves no inventa', () => {
    expect(ligarCfdi(llaves(), [cfdi(), otro]).cfdi).toBeNull();
  });
});

describe('extraerUuid', () => {
  it('saca el UUID de la lectura cruda', () => expect(extraerUuid(`{"x":"folio fiscal ${UUID.toLowerCase()}"}`)).toBe(UUID));
  it('sin UUID devuelve null', () => expect(extraerUuid('sin nada')).toBeNull());
});

describe('[RE.35.2] liga RFC + importe, nota de crédito y vía remisión', () => {
  const liga = { metodo: 'rfc_importe' as const, exacta: false, candidatos: 1 };

  it('RFC + importe único de los dos lados pasa a exacta', () => {
    expect(promoverRfcImporte(liga, 1)).toEqual({ ...liga, exacta: true });
  });
  it('prueba negativa: si el proveedor entregó dos veces lo mismo, sigue sugerida', () => {
    expect(promoverRfcImporte(liga, 2)?.exacta).toBe(false);
  });
  it('prueba negativa: con dos CFDI candidatos no se promueve', () => {
    expect(promoverRfcImporte({ ...liga, candidatos: 2 }, 1)?.exacta).toBe(false);
  });
  it('no toca otras ligas', () => {
    const l = { metodo: 'total_fecha' as const, exacta: false, candidatos: 1 };
    expect(promoverRfcImporte(l, 1)).toBe(l);
  });

  it('proveedor en ContPAQi por RFC de Kepler o por nombre', () => {
    const c = [{ emisor_rfc: 'ACO101112411', emisor_nombre: 'AZTECA CONFITERIA' }];
    expect(proveedorEnContpaqi('OTRO NOMBRE', 'ACO101112411', c)).toBe(true);
    expect(proveedorEnContpaqi('AZTECA CONFITERIA SA DE CV', null, c)).toBe(true);
    expect(proveedorEnContpaqi('BOTANAS PAU', null, c)).toBe(false);
  });

  it('la nota de crédito que hace cuadrar explica la factura mayor', () => {
    const n = { uuid: 'NC-1', total: 738.26, fecha: '2026-09-30' };
    expect(notaQueExplica(738.26, 135772.88, '2026-09-25', [n])).toBe(n);
  });
  it('prueba negativa: una nota que no hace cuadrar no explica nada', () => {
    expect(notaQueExplica(738.26, 135772.88, '2026-09-25', [{ uuid: 'NC-1', total: 300, fecha: '2026-09-30' }])).toBeNull();
  });
  it('prueba negativa: con dos notas que cuadran no elige', () => {
    const n = { uuid: 'NC', total: 738.26, fecha: '2026-09-30' };
    expect(notaQueExplica(738.26, 135772.88, '2026-09-25', [n, { ...n, uuid: 'NC2' }])).toBeNull();
  });
  it('prueba negativa: una factura MENOR no se explica con nota de crédito', () => {
    expect(notaQueExplica(-738.26, 135772.88, '2026-09-25', [{ uuid: 'NC', total: 738.26, fecha: '2026-09-30' }])).toBeNull();
  });

  it('con la nota de crédito, la factura mayor pasa sola y la nota queda dicha', () => {
    const nota = { uuid: 'NC-1', total: 279.15, fecha: '2026-09-25' };
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 + 279.15 }), notaCredito: nota }));
    expect(v.cubo).toBe('auto');
    expect(v.notaCredito).toBe(nota);
    expect(check(v, 'E1_cuadre')?.nota).toMatch(/NC-1/);
  });

  it('factura sin CFDI de proveedor que no factura en ContPAQi: vía remisión, pasa con el total del papel', () => {
    const v = veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-09-01', proveedorEnContpaqi: false, totalLeido: 48210.5 }));
    expect(v.via).toBe('remision');
    expect(v.cubo).toBe('auto');
    expect(check(v, 'I1_liga')?.estado).toBe('aviso');
    expect(v.checks.some((c) => c.grupo === 'fiscal')).toBe(false);
  });
  it('vía remisión sin OC sigue sin pasar', () => {
    const v = veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-09-01', proveedorEnContpaqi: false, entrada: { ...base().entrada, oc_folio: null } }));
    expect(v.cubo).toBe('revisar');
  });
  it('prueba negativa: si el proveedor SÍ factura en ContPAQi, no se vuelve remisión', () => {
    const v = veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-09-01', proveedorEnContpaqi: true }));
    expect(v.via).toBe('factura');
    expect(v.cubo).toBe('revisar');
  });
  it('mientras se espera el CFDI no se manda a remisión', () => {
    expect(veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-10-05', proveedorEnContpaqi: false })).cubo).toBe('sin_cfdi_aun');
  });

  it('sin CFDI el motivo no se repite', () => {
    const v = veredictoExpediente(base({ cfdi: null, fechaDocumento: '2026-09-01' }));
    expect(v.motivos).toEqual(['No se encontró su CFDI en ContPAQi.']);
  });
  it('el uso CFDI distinto dice cuál trae y cuál se esperaba', () => {
    expect(veredictoExpediente(base({ cfdi: cfdi({ uso_cfdi: 'G03' }) })).motivos[0]).toMatch(/G03.*G01/);
  });
});

describe('[RE.35.5] hallazgo', () => {
  const sinAj = { operativo: 0, comercial: 0 };
  it('factura mayor sin nota ni devolución: cobrar nota de crédito', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 + 500 }) }));
    expect(hallazgosDe(v, sinAj)).toEqual(['cobrar_nc']);
  });
  it('con devolución en Kepler es entrega incompleta, no cobro', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 + 500 }) }));
    expect(hallazgosDe(v, { operativo: 500, comercial: 0 })).toEqual(['incompleta']);
  });
  it('prueba negativa: una factura MENOR no es cobro de nota de crédito', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 - 500 }) }));
    expect(hallazgosDe(v, sinAj)).toEqual([]);
  });
  it('fiscal mal + sin OC + ajuste comercial se acumulan', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ uso_cfdi: 'G03' }), entrada: { ...base().entrada, oc_folio: null } }));
    expect(hallazgosDe(v, { operativo: 0, comercial: 120 })).toEqual(['mal_emitida', 'sin_oc', 'comercial']);
  });
  it('nota de crédito ya aplicada se dice', () => {
    const v = veredictoExpediente(base({ cfdi: cfdi({ total: 48210.5 + 279.15 }), notaCredito: { uuid: 'NC', total: 279.15, fecha: '2026-09-25' } }));
    expect(hallazgosDe(v, sinAj)).toEqual(['nc_aplicada']);
  });
  it('sin documento no tiene hallazgo', () => {
    expect(hallazgosDe(veredictoExpediente(base({ docTipo: 'ninguno' })), sinAj)).toEqual([]);
  });
});
