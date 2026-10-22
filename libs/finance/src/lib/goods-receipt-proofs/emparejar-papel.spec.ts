import { desempate, esSufijoDeReferencia, llaveDelFolio, nucleoReferencia, ordenarCandidatas } from './emparejar-papel';
import { folioNucleo } from './documento-duplicado';

const PROPIO = 'LOGL851014AQ5';

// Las dos entradas reales de la sucursal 08 con `referencia = '30-0666'` (prod, 2026-10-21).
const botanas = { folio: '0000039', proveedor_nombre: 'BOTANAS PAU', proveedor_rfc: '', referencia: '30-0666', receipt_date: '2026-09-23', monto: 6825, deposits: 0 };
const farolito = { folio: '0000288', proveedor_nombre: 'EL FAROLITO', proveedor_rfc: '', referencia: '30-0666', receipt_date: '2026-10-19', monto: 22500, deposits: 0 };
// Lo que el OCR leyó de la nota (el total salió mal: leyó el precio por bolsa).
const nota = { rfc: 'CUMG660606M75', proveedor: 'GEORGINA CUELLAR MARTÍNEZ', fecha: '2026-10-19', total: 22.5 };

describe('[RE.43] de qué entrada es un papel', () => {
  describe('llaveDelFolio: el folio de una factura es del PROVEEDOR', () => {
    it('factura / remisión → proveedor, aunque empiece con cero como los nuestros (el caso que falló)', () => {
      expect(llaveDelFolio('factura', '0666')).toBe('proveedor');
      expect(llaveDelFolio('remision', '0666')).toBe('proveedor');
    });
    it('nuestra hoja → nuestro', () => {
      expect(llaveDelFolio('orden_entrada', '0000666')).toBe('nuestro');
      expect(llaveDelFolio('vale', '353')).toBe('nuestro');
    });
    it('XA2001-… leído en una factura es NUESTRO folio impreso', () => {
      expect(llaveDelFolio('factura', 'XA2001-0000140')).toBe('nuestro');
    });
    it('sin rol: se prueban las dos', () => {
      expect(llaveDelFolio(undefined, '0666')).toBe('ambos');
    });
  });

  it('nucleoReferencia quita la plaza y casa con folioNucleo del papel', () => {
    expect(nucleoReferencia('30-0666')).toBe('666');
    expect(nucleoReferencia('30-0666')).toBe(folioNucleo('0666'));
    expect(nucleoReferencia('10-071026')).toBe('71026');
    expect(nucleoReferencia('F-A-12345')).toBe('12345');
    expect(nucleoReferencia('30-07')).toBeNull();
    expect(nucleoReferencia(null)).toBeNull();
  });

  describe('ordenarCandidatas: el caso real de la sucursal 08', () => {
    it('la fecha del papel deja SÓLO a EL FAROLITO (Botanas Pau es de 26 días antes)', () => {
      const r = ordenarCandidatas([botanas, farolito], nota, PROPIO);
      expect(r.map((c) => c.folio)).toEqual(['0000288']);
      expect(r[0].en_ventana).toBe(true);
    });
    it('un nombre distinto NO descarta (la razón social no es el nombre comercial)', () => {
      expect(desempate(farolito, nota, PROPIO).proveedor_ok).toBeNull();
    });
    it('PRUEBA NEGATIVA: sin fecha no se adivina — quedan las dos y la pantalla pregunta', () => {
      const r = ordenarCandidatas([botanas, farolito], { ...nota, fecha: null }, PROPIO);
      expect(r).toHaveLength(2);
    });
    it('si ninguna cae en la ventana (fecha mal leída) no se pierde ninguna', () => {
      const r = ordenarCandidatas([botanas, farolito], { ...nota, fecha: '2025-01-01' }, PROPIO);
      expect(r).toHaveLength(2);
    });
  });

  describe('el proveedor', () => {
    it('RFC distinto ORDENA al final pero NO descarta (el RFC acierta 49% aun con el proveedor bueno)', () => {
      const r = ordenarCandidatas([{ ...farolito, proveedor_rfc: 'MEAM8008293J4' }, { ...botanas, receipt_date: '2026-10-19' }], nota, PROPIO);
      expect(r).toHaveLength(2);
      expect(r[0].folio).toBe('0000039');
      expect(r[1].proveedor_ok).toBe(false);
    });
    it('nuestro RFC leído en el papel no cuenta (es el receptor)', () => {
      expect(desempate({ ...farolito, proveedor_rfc: 'MEAM8008293J4' }, { ...nota, rfc: PROPIO }, PROPIO).proveedor_ok).toBeNull();
    });
    it('el proveedor confirmado va primero aunque otra esté más cerca en fecha', () => {
      const a = { ...botanas, receipt_date: '2026-10-19', proveedor_rfc: '' };
      const b = { ...farolito, receipt_date: '2026-10-25', proveedor_rfc: 'CUMG660606M75' };
      const r = ordenarCandidatas([a, b], nota, PROPIO);
      expect(r[0].folio).toBe('0000288');
      expect(r[0].proveedor_ok).toBe(true);
    });
    it('la que ya tiene comprobante va después', () => {
      const r = ordenarCandidatas([{ ...farolito, deposits: 1 }, { ...farolito, folio: 'X', deposits: 0 }], nota, PROPIO);
      expect(r[0].folio).toBe('X');
    });
  });

  describe('sufijo: Kepler guarda sólo la cola del folio', () => {
    it('casos reales: IC - 3384616 ↔ 10-4616 y AE 244817 ↔ 10-4817', () => {
      expect(esSufijoDeReferencia(folioNucleo('IC - 3384616'), nucleoReferencia('10-4616'))).toBe(true);
      expect(esSufijoDeReferencia(folioNucleo('AE 244817'), nucleoReferencia('10-4817'))).toBe(true);
    });
    it('PRUEBA NEGATIVA: una cola de 3 dígitos no alcanza (666 sería la cola de cualquiera)', () => {
      expect(esSufijoDeReferencia('20666', '666')).toBe(false);
    });
    it('el folio entero no es sufijo (eso ya lo atrapa la igualdad)', () => {
      expect(esSufijoDeReferencia('4616', '4616')).toBe(false);
    });
  });

  it('la fecha de pg llega como Date a medianoche local y se lee bien', () => {
    expect(desempate({ ...farolito, receipt_date: new Date(2026, 9, 19) }, nota).dias).toBe(0);
  });
});
