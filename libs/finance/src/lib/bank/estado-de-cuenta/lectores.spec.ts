import * as ExcelJS from 'exceljs';
import { aCentavos, controlarSaldo, describirArchivo, detectarBanco, leerEstadoDeCuenta, type MovimientoBanco } from './lectores';

/**
 * `[CB.57]` — Los cuatro formatos de banco, con archivos FABRICADOS.
 *
 * Cada fixture copia la forma exacta de la muestra real del 2026-11-05 (encabezado, separador,
 * codificación, fin de línea, orden, formato de fecha e importe), con nombres, cuentas, RFC e
 * importes INVENTADOS: el repo es público y los estados de cuenta reales no entran aquí.
 *
 * Las pruebas negativas no son decoración: un lector que «siempre cuadra» o que se salta el
 * renglón que no entiende es exactamente el defecto que se está retirando (CB.23 tiró ~82
 * movimientos del libro en silencio).
 */

const SANTANDER_ENC = 'Cuenta,Fecha,Hora,Sucursal,Descripcion,Cargo/Abono,Importe,Saldo,Referencia,Concepto,Banco Participante,Clabe Beneficiario,Nombre Beneficiario,Cta Ordenante,Nombre Ordenante,Codigo Devolucion,Causa Devolucion,RFC Beneficiario,RFC Ordenante,Clave de Rastreo,Descripcion Larga';
const santanderRenglon = (o: { hora: string; desc: string; signo: '+' | '-'; imp: string; saldo: string; ref?: string; ctaOrd?: string; nomOrd?: string; rfcOrd?: string; rastreo?: string }) =>
  [`'11112222333'`, `'03112026'`, o.hora, `'0560'`, o.desc.padEnd(40), o.signo, o.imp, o.saldo, (o.ref ?? '').padEnd(15), ' '.repeat(20), ''.padEnd(40),
    `'${''.padEnd(20)}'`, ''.padEnd(40), `'${(o.ctaOrd ?? '').padEnd(20)}'`, (o.nomOrd ?? '').padEnd(40), '  ', ''.padEnd(30), ''.padEnd(15),
    (o.rfcOrd ?? '').padEnd(15), (o.rastreo ?? '').padEnd(30), o.desc.padEnd(130)].join(',');

const santander = (renglones: string[]) => Buffer.from([SANTANDER_ENC, ...renglones].join('\n'), 'ascii');

const S1 = santanderRenglon({ hora: '03:04', desc: 'COMISION MANEJO DE CUENTA', signo: '-', imp: '500.00', saldo: '9500.00' });
const S2 = santanderRenglon({ hora: '09:15', desc: 'ABONO TRANSFERENCIA SPEI', signo: '+', imp: '1250.50', saldo: '10750.50', ref: '000111222', ctaOrd: '012345678901234567', nomOrd: 'CLIENTE DE PRUEBA SA DE CV', rfcOrd: 'XAXX010101000', rastreo: 'PRUEBA0000000001' });
const S3 = santanderRenglon({ hora: '11:40', desc: 'DEPOSITO EN EFECTIVO', signo: '+', imp: '3000.00', saldo: '13750.50', ref: '0000099999' });

describe('[CB.57] Santander (CSV con apóstrofos, trae la cuenta)', () => {
  it('lee la cuenta, la hora, el rastreo y la contraparte de un abono (quien ORDENA), y cuadra', async () => {
    const r = await leerEstadoDeCuenta(santander([S1, S2, S3]));
    expect(r?.banco).toBe('santander');
    expect(r?.cuenta).toBe('11112222333');
    expect(r?.no_leidos).toEqual([]);
    expect(r?.movimientos).toHaveLength(3);
    const spei = r!.movimientos[1];
    expect(spei).toMatchObject({
      fecha: '2026-11-03', hora: '09:15', abono_centavos: 125050, cargo_centavos: 0, saldo_centavos: 1075050,
      referencia: '000111222', clave_rastreo: 'PRUEBA0000000001', contraparte_cuenta: '012345678901234567',
      contraparte_rfc: 'XAXX010101000', contraparte_nombre: 'CLIENTE DE PRUEBA SA DE CV',
    });
    expect(r?.control).toMatchObject({ orden_original: 'viejo_a_nuevo', saldo_inicial_centavos: 1000000, saldo_final_centavos: 1375050, cuadra: true, eslabones_rotos: [] });
  });

  it('NEGATIVA: si falta un renglón a la mitad, el saldo deja de encadenar y NO cuadra', async () => {
    const r = await leerEstadoDeCuenta(santander([S1, S3]));
    expect(r?.control?.cuadra).toBe(false);
    expect(r?.control?.eslabones_rotos).toEqual([3]);
  });

  it('una coma dentro de un texto que conserva su ancho fijo se devuelve a su columna (STDR 2169, 10-nov)', async () => {
    const S2c = santanderRenglon({ hora: '09:15', desc: 'ABONO TRANSFERENCIA SPEI', signo: '+', imp: '1250.50', saldo: '10750.50', ref: '000111222',
      ctaOrd: '012345678901234567', nomOrd: 'CLIENTE,DE PRUEBA SA DE CV', rfcOrd: 'XAXX010101000', rastreo: 'PRUEBA0000000001' });
    const r = await leerEstadoDeCuenta(santander([S1, S2c, S3]));
    expect(r?.no_leidos).toEqual([]);
    expect(r?.movimientos[1]).toMatchObject({ abono_centavos: 125050, saldo_centavos: 1075050, contraparte_nombre: 'CLIENTE,DE PRUEBA SA DE CV', clave_rastreo: 'PRUEBA0000000001' });
    expect(r?.control?.cuadra).toBe(true);
  });

  it('NEGATIVA: una coma dentro del texto corre las columnas → se REPORTA, no se tira ni se adivina', async () => {
    const corrido = S2.replace('ABONO TRANSFERENCIA SPEI', 'ABONO, TRANSFERENCIA SPEI');
    const r = await leerEstadoDeCuenta(santander([S1, corrido, S3]));
    expect(r?.movimientos).toHaveLength(2);
    expect(r?.no_leidos).toHaveLength(1);
    expect(r?.no_leidos[0]).toMatchObject({ linea: 3 });
    expect(r?.no_leidos[0].motivo).toMatch(/columnas/);
    expect(r?.control?.cuadra).toBe(false);
  });
});

describe('[CB.57] Banorte (Latin-1, fin de línea sólo CR, datos dentro del concepto)', () => {
  const ENC = '"Fecha","Movimiento","Cód. Trans.","Concepto","Retiros","Depósitos","Saldos","Cheque"';
  const spei = '"31/Oct./2026","500001","3","PRUEBA0000000002            SPEI RECIBIDO, BCO:0002 BANAMEX             HR LIQ: 11:54:25 DEL CLIENTE COMERCIAL DE PRUEBA SA DE CV                  DE LA CLABE 002000000000000001   CON RFC CPR010101AB1        CONCEPTO: factura 1 REFERENCIA: 0000001 CVE RAST: PRUEBA0000000002","","$7,949.01","$24,203.01",""';
  const efectivo = '"02/Nov./2026","500002","0","DEP.EFECTIVO                   REF0","","$4,900.00","$29,103.01",""';
  const archivo = Buffer.from([ENC, spei, efectivo].join('\r'), 'latin1');

  it('reconoce el formato aunque el acento venga en Latin-1 y separa por CR', async () => {
    expect(detectarBanco(archivo)).toBe('banorte');
    const r = await leerEstadoDeCuenta(archivo);
    expect(r?.movimientos).toHaveLength(2);
    expect(r?.no_leidos).toEqual([]);
    expect(r?.cuenta).toBeNull();
  });

  it('saca rastreo, CLABE, RFC, referencia, hora y nombre del concepto; fecha con mes en español', async () => {
    const r = await leerEstadoDeCuenta(archivo);
    expect(r!.movimientos[0]).toMatchObject({
      fecha: '2026-10-31', hora: '11:54', abono_centavos: 794901, saldo_centavos: 2420301,
      clave_rastreo: 'PRUEBA0000000002', contraparte_cuenta: '002000000000000001', contraparte_rfc: 'CPR010101AB1',
      referencia: '0000001', contraparte_nombre: 'COMERCIAL DE PRUEBA SA DE CV',
    });
    expect(r!.movimientos[1]).toMatchObject({ fecha: '2026-11-02', referencia: '500002', clave_rastreo: null });
    expect(r?.control).toMatchObject({ saldo_inicial_centavos: 1625400, cuadra: true });
  });
});

describe('[CB.57] BBVA (.exp con tabuladores, del más nuevo al más viejo)', () => {
  const archivo = Buffer.from([
    'Día\tConcepto / Referencia\tcargo\tAbono\tSaldo',
    '03-11-2026\tIVA TASA DE DESC DEBITO/100000001 TERMINALES PUNTO DE VENTA\t16.00\t\t1,084.00',
    '03-11-2026\tAPLI TASA DE DES DEBITO/100000001 TERMINALES PUNTO DE VENTA\t100.00\t\t1,100.00',
    '03-11-2026\tVENTAS DEBITO/100000002 TERMINALES PUNTO DE VENTA\t\t1,000.00\t1,200.00',
  ].join('\r\n'), 'latin1');

  it('detecta el orden inverso, entrega del más viejo al más nuevo y cuadra', async () => {
    const r = await leerEstadoDeCuenta(archivo);
    expect(r?.banco).toBe('bbva');
    expect(r?.control).toMatchObject({ orden_original: 'nuevo_a_viejo', saldo_inicial_centavos: 20000, saldo_final_centavos: 108400, cuadra: true });
    expect(r!.movimientos.map((m) => m.concepto.slice(0, 5))).toEqual(['VENTA', 'APLI ', 'IVA T']);
    expect(r!.movimientos[0].referencia).toBe('100000002');
  });
});

describe('[CB.57] BanBajío (.xlsx con encabezado y totales declarados)', () => {
  async function bajio(opts: { cargosDeclarados: number; quitarUno?: boolean }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('ConsultaMovimientos');
    ws.getRow(2).values = [null, 'Datos Generales'];
    ws.getRow(3).values = [null, 'Nombre cliente', null, 'CLIENTE DE PRUEBA'];
    ws.getRow(4).values = [null, 'Número cliente', null, '12345678', 'Movimientos', 'Rango de Fechas', 'No. de Movimientos', '2'];
    ws.getRow(5).values = [null, 'Tipo producto', null, 'Conecta BanBajio', 'Tipo de movimiento', 'TODOS', 'Cargos Totales', -opts.cargosDeclarados];
    ws.getRow(6).values = [null, 'Subtipo producto', null, '01', 'Fechas', '01-Nov-2026 al 02-Nov-2026', 'Abonos Totales', 0];
    ws.getRow(9).values = [null, 'Movimientos'];
    ws.getRow(10).values = [null, '#', 'Fecha Movimiento', 'Hora', 'Recibo', 'Descripción', 'Cargos', 'Abonos', 'Saldo'];
    ws.getRow(11).values = [null, 1, new Date(Date.UTC(2026, 10, 2)), new Date(Date.UTC(2026, 10, 2, 12, 4)), '9000000002', 'Compra - Disposicion por POS por (200.00) mxn en GASOLINERA DE PRUEBA | RFC GPR 010101AB1', 200, null, 800];
    const fila = 12 + (opts.quitarUno ? 0 : 1);
    if (!opts.quitarUno) ws.getRow(12).values = [null, 2, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 1, 10, 42)), '9000000001', 'Compra - Disposicion por POS por (100.00) mxn en GASOLINERA DE PRUEBA', 100, null, 1000];
    ws.getRow(fila).values = [null, 'Nota: La información contenida en este archivo es exclusivamente de carácter informativo.'];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('lee el número de cliente, la hora y el RFC; ignora la nota al pie; los totales declarados coinciden', async () => {
    const r = await leerEstadoDeCuenta(await bajio({ cargosDeclarados: 300 }));
    expect(r?.banco).toBe('banbajio');
    expect(r?.cliente).toBe('12345678');
    expect(r?.no_leidos).toEqual([]);
    expect(r?.movimientos).toHaveLength(2);
    expect(r!.movimientos[0]).toMatchObject({ fecha: '2026-11-01', hora: '10:42', cargo_centavos: 10000, referencia: '9000000001' });
    expect(r!.movimientos[1].contraparte_rfc).toBe('GPR010101AB1');
    expect(r?.control).toMatchObject({ orden_original: 'nuevo_a_viejo', saldo_inicial_centavos: 110000, cuadra: true });
    expect(r?.declarado).toMatchObject({ movimientos: 2, cargos_centavos: 30000, abonos_centavos: 0, coinciden: true });
  });

  it('NEGATIVA: si el archivo declara otros totales que los leídos, `coinciden` es false', async () => {
    const r = await leerEstadoDeCuenta(await bajio({ cargosDeclarados: 999 }));
    expect(r?.declarado?.coinciden).toBe(false);
  });

  it('NEGATIVA: con un movimiento de menos, el conteo declarado lo delata', async () => {
    const r = await leerEstadoDeCuenta(await bajio({ cargosDeclarados: 300, quitarUno: true }));
    expect(r?.movimientos).toHaveLength(1);
    expect(r?.declarado?.coinciden).toBe(false);
  });
});

describe('[CB.57] Banamex (CSV Latin-1 con resumen; saldo sólo al cierre del día)', () => {
  // Forma de la muestra real del 2026-11-10; cuenta, nombres, autorizaciones e importes inventados.
  const mov = (fecha: string, desc: string, dep: string, ret: string, saldo = ' ') => `"${fecha}","${desc}","${dep}","${ret}","${saldo}"`;
  const banamex = (o: { inicial?: string; final?: string; quitar?: number; cierre05?: string } = {}) => {
    const renglones = [
      mov('05/11/2026', 'Pago Interbancario Sucursal: 519 Referencia Numérica: 1 Referencia Alfanumérica: S1 Autorización: 00000004', '-', '5,000.00'),
      mov('05/11/2026', 'Abono por cobranza Sucursal: 426 Referencia Numérica:  Referencia Alfanumérica: C1 Autorización: 00000003', '600.00', '-'),
      mov('05/11/2026', 'DEP EN EFECTIVO Sucursal: 426 Referencia Numérica:  Referencia Alfanumérica: 600.00 Autorización: 00000003', '0.00', '-'),
      mov('05/11/2026', 'Abono Interbancario Sucursal: 859 Referencia Numérica: 2 Referencia Alfanumérica: CLIENTE Autorización: 00000002', '400.00', '-', o.cierre05 ?? '6,150.00'),
      mov('04/11/2026', 'Abono Interbancario Sucursal: 519 Referencia Numérica: 3 Referencia Alfanumérica: CLIENTE Autorización: 00000001', '150.00', '-', '10,150.00'),
    ].filter((_, i) => i !== o.quitar);
    const texto = ['Movimiento de cuenta Cheques', '', 'Resumen de cuenta', 'Sucursal,7000,,Nombre,"PERSONA,DE PRUEBA"', 'Cuenta,1234567,,Moneda,MXN', '',
      'Resumen del 04/11/2026 al 05/11/2026', `Saldo inicial,"$ +${o.inicial ?? '10,000.00'}",,Saldo final,"$ +${o.final ?? '6,150.00'}"`,
      'Depósitos (3),"$ 1,150.00"', 'Retiros (1),"$ 5,000.00"', '', 'Detalle de Movimientos - Depósitos y Retiros',
      'Fecha,Descripción,Depósitos,Retiros,Saldo', ...renglones].join('\r\n');
    return Buffer.from(texto, 'latin1');
  };

  it('lee la cuenta del resumen, ignora (y declara) el renglón de $0.00, ordena y cuadra contra el resumen', async () => {
    const r = await leerEstadoDeCuenta(banamex());
    expect(r?.banco).toBe('banamex');
    expect(r?.cuenta).toBe('1234567');
    expect(r?.no_leidos).toEqual([]);
    expect(r?.informativos).toHaveLength(1);
    expect(r?.movimientos.map((m) => m.saldo_centavos)).toEqual([1015000, 1055000, 1115000, 615000]);
    expect(r?.movimientos[3]).toMatchObject({ fecha: '2026-11-05', cargo_centavos: 500000, referencia: '00000004' });
    expect(r?.control).toMatchObject({ orden_original: 'nuevo_a_viejo', saldo_inicial_centavos: 1000000, saldo_final_centavos: 615000, cuadra: true });
    expect(r?.declarado).toMatchObject({ movimientos: 4, abonos_centavos: 115000, cargos_centavos: 500000, coinciden: true });
  });

  it('NEGATIVA: falta un movimiento → el cierre impreso del día no se alcanza, la cadena se rompe y NO cuadra', async () => {
    const r = await leerEstadoDeCuenta(banamex({ quitar: 1 }));
    expect(r?.control?.cuadra).toBe(false);
    expect(r?.control?.eslabones_rotos.length).toBeGreaterThan(0);
    expect(r?.declarado?.coinciden).toBe(false);
  });

  it('NEGATIVA: un saldo inicial que no es el del banco no llega al cierre impreso y se reporta', async () => {
    const r = await leerEstadoDeCuenta(banamex({ inicial: '10,001.00' }));
    expect(r?.no_leidos.map((x) => x.motivo)).toEqual([expect.stringMatching(/saldo inicial del resumen/)]);
  });

  it('NEGATIVA: el saldo final del resumen distinto al del último movimiento se reporta', async () => {
    const r = await leerEstadoDeCuenta(banamex({ final: '6,151.00' }));
    expect(r?.no_leidos.map((x) => x.motivo)).toEqual([expect.stringMatching(/saldo final del resumen/)]);
  });
});

describe('[CB.57] lo que no es estado de cuenta', () => {
  it('un formato desconocido devuelve null, no un estado de cuenta vacío', async () => {
    expect(await leerEstadoDeCuenta(Buffer.from('FECHA;IMPORTE\n01/11/2026;100', 'utf8'))).toBeNull();
  });

  it('un CSV guardado con BOM (Excel) se reconoce igual', async () => {
    const r = await leerEstadoDeCuenta(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), santander([S1, S2, S3])]));
    expect(r?.banco).toBe('santander');
  });

  it('lo que no se reconoce se DESCRIBE para el mensaje: cómo empieza, o qué tipo de archivo es', () => {
    expect(describirArchivo(Buffer.from('FECHA;IMPORTE\n01/11/2026;100', 'utf8'))).toBe('empieza con «FECHA;IMPORTE»');
    expect(describirArchivo(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toMatch(/Excel viejo \(\.xls\)/);
    expect(describirArchivo(Buffer.from('%PDF-1.7', 'latin1'))).toBe('es un PDF');
    expect(describirArchivo(Buffer.from(''))).toBe('está vacío');
  });

  it('[negativa] la consulta de BanBajío en .txt NO se lee (duplicaría con el .xlsx) y el mensaje dice qué bajar', async () => {
    // Forma de la muestra real del 2026-11-10; nombre, número e importes inventados.
    const txt = Buffer.from(['PERSONA DE PRUEBA,11112222,Conecta BanBajio,01,10-Nov-2026,09:36:48,Mes Actual,TODOS,01-Nov-2026 al 30-Nov-2026,,1,3175.35,0.00',
      '#,Fecha Movimiento,Hora,Recibo,Descripción,Cargos,Abonos,Saldo',
      '1,10-Nov-2026,08:26:54,100,Compra - Disposicion por POS por (3175.35) mxn en GASOLINERA | Recibo # 100,3175.35,,1000.00'].join('\r\n'), 'utf8');
    expect(await leerEstadoDeCuenta(txt)).toBeNull();
    expect(describirArchivo(txt)).toBe('es la consulta de BanBajío en .txt: bájala en Excel (.xlsx), que es la que se lee');
  });

  it('[negativa] Banamex en .txt (MDAD: sin descripción ni saldo) NO se lee y el mensaje dice bajar el CSV', async () => {
    const mdad = Buffer.from(['0002/MDAD', '', "type='';type=new Array();type['A']='Abono';type['C']='Cargo';", 'EOC',
      '10/11/2026|8:18|1|PERSONA|01|PERSONA|01/11/26|7000|1234567|PERSONA|+|1,000.00|+|1,100.00|0|1|0.00|100.00|Pesos',
      '1|09/11/26|A|11|00|7003|||100.00|00000001'].join('\r\n'), 'ascii');
    expect(await leerEstadoDeCuenta(mdad)).toBeNull();
    expect(describirArchivo(mdad)).toMatch(/^es la consulta de Banamex en \.txt/);
  });

  it('el libro «CUENTAS» (xlsx sin la hoja de BanBajío) se reporta, no se lee como banco', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('BTE 7744').getRow(1).values = [null, 'FECHA', 'M', 'S', 'C', 'PROVEEDOR', 'RETIRO', 'DEPOSITO', 'SALDO'];
    const r = await leerEstadoDeCuenta(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r?.movimientos).toEqual([]);
    expect(r?.no_leidos[0].motivo).toMatch(/Fecha Movimiento/);
  });
});

describe('[CB.57] importes y saldo', () => {
  it('convierte a centavos sin error de flotante', () => {
    expect(aCentavos('$1,234.56')).toBe(123456);
    expect(aCentavos("'520.00")).toBe(52000);
    expect(aCentavos(0.1 + 0.2)).toBe(30);
    expect(aCentavos('')).toBe(0);
    expect(aCentavos('N/A')).toBeNull();
  });

  it('un solo renglón conserva el orden del archivo', () => {
    const m: MovimientoBanco = { linea: 2, fecha: '2026-11-01', hora: null, concepto: 'X', cargo_centavos: 0, abono_centavos: 100, saldo_centavos: 100, referencia: null, clave_rastreo: null, contraparte_cuenta: null, contraparte_rfc: null, contraparte_nombre: null, texto_original: 'x' };
    expect(controlarSaldo([m]).control).toMatchObject({ orden_original: 'viejo_a_nuevo', saldo_inicial_centavos: 0, cuadra: true });
  });
});
