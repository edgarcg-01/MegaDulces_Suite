import { dictaminar, dictaminarArchivo, resumenDictamen, type ContextoDictamen, type PolizaADictaminar } from './dictamen';

/**
 * `[CP.8.95]` Candado del dictamen. Puro: sin base, sin Nest.
 *
 * ⭐ El primer caso es el CONTROL POSITIVO: una póliza limpia con todo el contexto tiene que salir `lista` y sin
 * hallazgos. Sin él, un dictamen que bloqueara TODO pasaría cada caso de abajo y se vería igual de verde.
 *
 * Después, cada regla se dispara con UNA mutación de la póliza limpia, y las que dependen de una ventana o un
 * umbral llevan también el caso que NO debe dispararlas. Los RFC y UUID son de mentira (el repo es público).
 */
const U1 = 'AAAAAAAA-1111-4111-8111-000000000001';
const U2 = 'BBBBBBBB-2222-4222-8222-000000000002';
const EMPRESA = 'EMP010101AB1';
const PROV = 'PRO010101AB2';
const BANCO = '1020020000';
const CTA_PROV = '2120000413';
const GASTO = '5200800000';

type Asiento = PolizaADictaminar['asiento'];
const mov = (cuenta: string, abono: boolean, importe: number) => ({ cuenta, abono, importe, concepto: 'X', seg_negocio: 0 });

const poliza = (cambios: Partial<Asiento> = {}, uuids: string[] = [U1], clave = 'pago|1'): PolizaADictaminar => ({
  clave,
  uuids,
  asiento: {
    tipo_poliza: 2,
    fecha: '2026-09-15',
    concepto: 'PAGO PROVEEDOR DE PRUEBA',
    total: 1160,
    movimientos: [mov(CTA_PROV, false, 1160), mov(BANCO, true, 1160)],
    ...cambios,
  },
});

const cfdi = (cambios: Record<string, unknown> = {}) => ({
  tipo: 'I', emisor_rfc: PROV, receptor_rfc: EMPRESA, total: 1160, fecha: '2026-09-01', moneda: 'MXN', retenidos: 0,
  estatus_sat: 'vigente', sustituto: null, mixta: false, relacion: null, ...cambios,
});

const contexto = (cambios: Partial<ContextoDictamen> = {}): ContextoDictamen => ({
  periodo: '2026-09',
  hoy: '2026-10-29',
  rfcEmpresa: EMPRESA,
  catalogo: new Map([CTA_PROV, BANCO, '5020000413', GASTO].map((c) => [c, { afectable: true, baja: false }])),
  cfdis: new Map([[U1, cfdi()]]),
  polizasDeElla: [],
  uuidEnEgresos: new Map(),
  provisiones: new Map(),
  anticipos: new Map(),
  rfcDeCuenta: new Map([[CTA_PROV, new Set([PROV])]]),
  efos: new Set(),
  ...cambios,
});

const reglas = (d: { hallazgos: { regla: string }[] }) => d.hallazgos.map((x) => x.regla);
const sev = (d: { hallazgos: { regla: string; severidad: string }[] }, regla: string) =>
  d.hallazgos.find((x) => x.regla === regla)?.severidad;

describe('[CP.8.95] dictamen de una póliza', () => {
  it('⭐ control positivo: la póliza limpia sale lista y sin hallazgos', () => {
    const [d] = dictaminarArchivo([poliza()], contexto());
    expect(d.hallazgos).toEqual([]);
    expect(d.veredicto).toBe('lista');
  });

  describe('aritmética', () => {
    it('descuadre bloquea', () => {
      const d = dictaminar(poliza({ movimientos: [mov(CTA_PROV, false, 1160), mov(BANCO, true, 1159.99)] }), contexto());
      expect(sev(d, 'descuadre')).toBe('bloquea');
      expect(d.veredicto).toBe('bloqueada');
    });
    it('importe cero o negativo bloquea', () => {
      const p = poliza({ total: 0, movimientos: [mov(CTA_PROV, false, 0), mov(BANCO, true, 0)] });
      expect(sev(dictaminar(p, contexto()), 'importe_invalido')).toBe('bloquea');
    });
    it('fracción de centavo bloquea aunque cuadre al centavo', () => {
      const d = dictaminar(poliza({ movimientos: [mov(CTA_PROV, false, 1160.001), mov(BANCO, true, 1160.001)] }), contexto());
      expect(reglas(d)).not.toContain('descuadre');
      expect(sev(d, 'fraccion_de_centavo')).toBe('bloquea');
    });
    it('un egreso con dos abonos al banco se revisa', () => {
      const p = poliza({ movimientos: [mov(CTA_PROV, false, 1160), mov(BANCO, true, 1000), mov(BANCO, true, 160)] });
      expect(sev(dictaminar(p, contexto()), 'pata_de_banco')).toBe('revisar');
    });
  });

  describe('catálogo', () => {
    it('cuenta no afectable, de baja, inexistente y mal formada bloquean', () => {
      const cat = new Map(contexto().catalogo);
      cat.set(CTA_PROV, { afectable: false, baja: false });
      expect(sev(dictaminar(poliza(), contexto({ catalogo: cat })), 'cuenta_no_afectable')).toBe('bloquea');
      cat.set(CTA_PROV, { afectable: true, baja: true });
      expect(sev(dictaminar(poliza(), contexto({ catalogo: cat })), 'cuenta_de_baja')).toBe('bloquea');
      cat.delete(CTA_PROV);
      expect(sev(dictaminar(poliza(), contexto({ catalogo: cat })), 'cuenta_inexistente')).toBe('bloquea');
      const corta = poliza({ movimientos: [mov('2120', false, 1160), mov(BANCO, true, 1160)] });
      expect(sev(dictaminar(corta, contexto()), 'cuenta_mal_formada')).toBe('bloquea');
    });
    it('⛔ sin catálogo no pasa en verde: se pide revisar', () => {
      const d = dictaminar(poliza(), contexto({ catalogo: null }));
      expect(sev(d, 'catalogo_no_medido')).toBe('revisar');
      expect(d.veredicto).toBe('revisar');
    });
  });

  describe('fecha', () => {
    it('fuera del periodo, futura e inválida bloquean', () => {
      expect(sev(dictaminar(poliza({ fecha: '2026-08-31' }), contexto()), 'fecha_fuera_del_periodo')).toBe('bloquea');
      expect(sev(dictaminar(poliza(), contexto({ hoy: '2026-09-10' })), 'fecha_futura')).toBe('bloquea');
      expect(sev(dictaminar(poliza({ fecha: '2026-09-31' }), contexto()), 'fecha_invalida')).toBe('bloquea');
    });
  });

  describe('formato', () => {
    it('un salto de línea o un carácter fuera de latin1 bloquea', () => {
      expect(sev(dictaminar(poliza({ concepto: 'PAGO\nPROVEEDOR' }), contexto()), 'caracter_invalido')).toBe('bloquea');
      expect(sev(dictaminar(poliza({ concepto: 'PAGO “COMILLAS”' }), contexto()), 'caracter_invalido')).toBe('bloquea');
    });
    it('los acentos y la eñe sí se pueden escribir', () => {
      expect(reglas(dictaminar(poliza({ concepto: 'PAGO DE CAMIÓN A PEÑA' }), contexto()))).not.toContain('caracter_invalido');
    });
    it('un concepto de más de 100 caracteres sólo avisa: no cambia el veredicto', () => {
      const d = dictaminar(poliza({ concepto: 'X'.repeat(101) }), contexto());
      expect(sev(d, 'concepto_recortado')).toBe('aviso');
      expect(d.veredicto).toBe('lista');
    });
  });

  describe('CFDI', () => {
    const conCfdi = (c: Record<string, unknown>) => contexto({ cfdis: new Map([[U1, cfdi(c)]]) });
    it('cancelado bloquea y dice cuál lo sustituye', () => {
      const d = dictaminar(poliza(), conCfdi({ estatus_sat: 'cancelado', sustituto: U2.toLowerCase() }));
      expect(sev(d, 'cfdi_cancelado')).toBe('bloquea');
      expect(d.hallazgos.find((x) => x.regla === 'cfdi_cancelado')?.mensaje).toContain(U2);
    });
    it('emitido a otro RFC bloquea', () => {
      expect(sev(dictaminar(poliza(), conCfdi({ receptor_rfc: 'OTR010101AB3' })), 'cfdi_de_otro_receptor')).toBe('bloquea');
    });
    it('UUID mal formado bloquea; desconocido se revisa', () => {
      expect(sev(dictaminar(poliza({}, ['NO-ES-UUID']), contexto()), 'uuid_mal_formado')).toBe('bloquea');
      expect(sev(dictaminar(poliza({}, [U2]), contexto()), 'cfdi_desconocido')).toBe('revisar');
    });
    it('tipo inesperado, otra moneda, retención y dos emisores se revisan', () => {
      expect(sev(dictaminar(poliza(), conCfdi({ tipo: 'P' })), 'cfdi_tipo_inesperado')).toBe('revisar');
      expect(sev(dictaminar(poliza(), conCfdi({ moneda: 'USD' })), 'cfdi_en_otra_moneda')).toBe('revisar');
      expect(sev(dictaminar(poliza(), conCfdi({ retenidos: 116 })), 'cfdi_con_retencion')).toBe('revisar');
      const dos = contexto({ cfdis: new Map([[U1, cfdi()], [U2, cfdi({ emisor_rfc: 'OTR010101AB3' })]]) });
      expect(sev(dictaminar(poliza({}, [U1, U2]), dos), 'cfdi_de_varios_emisores')).toBe('revisar');
    });
    it('sin estatus del SAT sólo avisa', () => {
      const d = dictaminar(poliza(), conCfdi({ estatus_sat: 'desconocido' }));
      expect(sev(d, 'cfdi_sin_estatus_sat')).toBe('aviso');
      expect(d.veredicto).toBe('lista');
    });
    it('⛔ sin CFDI leídos no pasa en verde', () => {
      expect(dictaminar(poliza(), contexto({ cfdis: null })).veredicto).toBe('revisar');
    });
  });

  describe('proveedor', () => {
    it('emisor en la lista 69-B se revisa', () => {
      expect(sev(dictaminar(poliza(), contexto({ efos: new Set([PROV]) })), 'emisor_en_69b')).toBe('revisar');
    });
    it('la cuenta del proveedor es de otro RFC: se revisa', () => {
      const rc = new Map([[CTA_PROV, new Set(['OTR010101AB3'])]]);
      expect(sev(dictaminar(poliza(), contexto({ rfcDeCuenta: rc })), 'proveedor_rfc_distinto')).toBe('revisar');
    });
  });

  describe('criterio (cómo lo asienta contabilidad)', () => {
    const conNota = (relacion: string | null) =>
      contexto({ cfdis: new Map([[U1, cfdi()], [U2, cfdi({ tipo: 'E', total: 100, relacion })]]) });
    it('un pago con notas se revisa, y dice si el XML no trae la relación', () => {
      const sin = dictaminar(poliza({}, [U1, U2]), conNota(null));
      expect(sev(sin, 'lleva_notas')).toBe('revisar');
      expect(sin.hallazgos.find((x) => x.regla === 'lleva_notas')?.mensaje).toContain('no dicen en su XML');
      const con = dictaminar(poliza({}, [U1, U2]), conNota('01'));
      expect(con.hallazgos.find((x) => x.regla === 'lleva_notas')?.mensaje).not.toContain('no dicen en su XML');
    });
    it('anticipo por aplicar se revisa; un residuo de centavos, no', () => {
      expect(sev(dictaminar(poliza(), contexto({ anticipos: new Map([['000413', 5000]]) })), 'anticipo_por_aplicar')).toBe('revisar');
      expect(reglas(dictaminar(poliza(), contexto({ anticipos: new Map([['000413', 0.5]]) })))).not.toContain('anticipo_por_aplicar');
    });
    describe('doble registro (provisión por cuenta e importe, como el armado)', () => {
      const aCompra = poliza({ movimientos: [mov('5020000413', false, 1160), mov(BANCO, true, 1160)] });
      const prov = (fecha: string, centavos = 116000) => contexto({ provisiones: new Map([[`${CTA_PROV}|${centavos}`, [fecha]]]) });
      it('provisionada y cargada a compra se revisa', () => {
        expect(sev(dictaminar(aCompra, prov('2026-09-05')), 'doble_registro')).toBe('revisar');
      });
      it('una provisión posterior al pago, o de otro importe, no cuenta', () => {
        expect(reglas(dictaminar(aCompra, prov('2026-09-20')))).not.toContain('doble_registro');
        expect(reglas(dictaminar(aCompra, prov('2026-09-05', 99900)))).not.toContain('doble_registro');
      });
      it('si se paga contra 2120, la provisión se está cerrando: nada', () => {
        expect(reglas(dictaminar(poliza(), prov('2026-09-05')))).not.toContain('doble_registro');
      });
      it('⭐ un GASTO (52xx, sin sufijo) encuentra al proveedor por su RFC', () => {
        const gasto = poliza({ movimientos: [mov(GASTO, false, 1160), mov(BANCO, true, 1160)] });
        expect(sev(dictaminar(gasto, prov('2026-09-05')), 'doble_registro')).toBe('revisar');
      });
    });
    it('redondeo: hasta $1 avisa, más se revisa', () => {
      expect(sev(dictaminar(poliza({ redondeo: 0.5 }), contexto()), 'redondeo')).toBe('aviso');
      expect(sev(dictaminar(poliza({ redondeo: -2 }), contexto()), 'redondeo')).toBe('revisar');
    });
    it('falta el traspaso de IVA: se revisa', () => {
      expect(sev(dictaminar(poliza({ iva_traspaso: 'no_emitido' }), contexto()), 'iva_traspaso_pendiente')).toBe('revisar');
    });
    it('⛔ sin provisiones ni anticipos leídos no pasa en verde', () => {
      const d = dictaminar(poliza(), contexto({ provisiones: null, anticipos: null }));
      expect(reglas(d)).toEqual(expect.arrayContaining(['provision_no_medida', 'anticipo_no_medido']));
      expect(d.veredicto).toBe('revisar');
    });
  });

  describe('archivo: duplicados', () => {
    const deElla = (k: string, fecha: string, importe = 1160, cuenta = CTA_PROV) => ({
      k, fecha, renglones: [{ cuenta, abono: false, importe }, { cuenta: BANCO, abono: true, importe }],
    });
    it('ya capturada por contabilidad (±3 días) bloquea', () => {
      const [d] = dictaminarArchivo([poliza()], contexto({ polizasDeElla: [deElla('2026|9|2|77', '2026-09-17')] }));
      expect(sev(d, 'ya_capturada')).toBe('bloquea');
    });
    it('a 4 días ya no es la misma', () => {
      const [d] = dictaminarArchivo([poliza()], contexto({ polizasDeElla: [deElla('2026|9|2|77', '2026-09-19')] }));
      expect(reglas(d)).not.toContain('ya_capturada');
    });
    it('dos candidatas: desempata la cuenta del proveedor; si no desempata, se revisa', () => {
      const una = [deElla('2026|9|2|77', '2026-09-15', 1160, '2120009999'), deElla('2026|9|2|78', '2026-09-15')];
      const [a] = dictaminarArchivo([poliza()], contexto({ polizasDeElla: una }));
      expect(a.hallazgos.find((x) => x.regla === 'ya_capturada')?.mensaje).toContain('78');
      const dos = [deElla('2026|9|2|77', '2026-09-15'), deElla('2026|9|2|78', '2026-09-15')];
      const [b] = dictaminarArchivo([poliza()], contexto({ polizasDeElla: dos }));
      expect(sev(b, 'posible_ya_capturada')).toBe('revisar');
    });
    it('una póliza de contabilidad se usa una sola vez', () => {
      const ds = dictaminarArchivo([poliza({}, [U1], 'pago|1'), poliza({}, [U2], 'pago|2')],
        contexto({ polizasDeElla: [deElla('2026|9|2|77', '2026-09-15')], cfdis: new Map([[U1, cfdi()], [U2, cfdi()]]) }));
      expect(ds.filter((d) => reglas(d).includes('ya_capturada'))).toHaveLength(1);
      expect(ds.every((d) => reglas(d).includes('banco_repetido_en_archivo'))).toBe(true);
    });
    it('el CFDI en otra póliza de egreso se revisa; en la suya propia, no', () => {
      const otra = contexto({ uuidEnEgresos: new Map([[U1, ['2026|8|2|10']]]) });
      expect(sev(dictaminarArchivo([poliza()], otra)[0], 'cfdi_ya_pagado')).toBe('revisar');
      const propia = contexto({ uuidEnEgresos: new Map([[U1, ['2026|9|2|77']]]), polizasDeElla: [deElla('2026|9|2|77', '2026-09-15')] });
      expect(reglas(dictaminarArchivo([poliza()], propia)[0])).not.toContain('cfdi_ya_pagado');
    });
    it('el mismo CFDI en dos pólizas del archivo se revisa (puede ser un pago en parcialidades)', () => {
      const ds = dictaminarArchivo([poliza({}, [U1], 'pago|1'), poliza({ fecha: '2026-09-16' }, [U1], 'pago|2')], contexto());
      expect(ds.every((d) => sev(d, 'uuid_repetido_en_archivo') === 'revisar')).toBe(true);
    });
    it('⛔ sin las pólizas de contabilidad no pasa en verde', () => {
      expect(dictaminarArchivo([poliza()], contexto({ polizasDeElla: null }))[0].veredicto).toBe('revisar');
    });
  });

  it('el resumen cuenta pólizas por veredicto y por regla', () => {
    const ds = dictaminarArchivo([poliza({}, [U1], 'pago|1'), poliza({ fecha: '2026-08-01' }, [U1], 'pago|2')], contexto());
    const r = resumenDictamen(ds);
    expect(r.polizas).toBe(2);
    expect(r.por_veredicto).toEqual({ lista: 0, revisar: 1, bloqueada: 1 });
    expect(r.por_regla.uuid_repetido_en_archivo).toEqual({ severidad: 'revisar', polizas: 2 });
    expect(r.por_regla.fecha_fuera_del_periodo.polizas).toBe(1);
  });
});
