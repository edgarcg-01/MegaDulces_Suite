import {
  esRfcPropio, folioNucleo, masGrave, mensajeDuplicado, mismoEmisor, veredictoDuplicado, type PapelProveedor,
} from './documento-duplicado';

const PROPIO = 'LOGL851014AQ5';
const opts = { rfcPropio: PROPIO, tolerancia: 1 };

// Los dos papeles reales del caso de prod (2026-10-20), tal como están guardados / se leyeron.
const dulcelicias: PapelProveedor = {
  sha256: 'ef3a5846d7d4', folio: '0666', rfc: 'MEAM8008293J4', nombre: 'DULCELICIAS', total: 1150,
  proveedorCode: 'CD43', proveedorNombre: 'DULCELICIAS',
};
const farolito: PapelProveedor = {
  sha256: 'otro-hash', folio: '0666', rfc: 'CUMG660606M75', nombre: 'GEORGINA CUELLAR MARTINEZ', total: 22500,
};

describe('[RE.42] identidad de un papel del proveedor = emisor + folio', () => {
  describe('el caso de prod: nota 0666 de EL FAROLITO contra la 0666 de DULCELICIAS', () => {
    it('sin entrada destino (vista previa): RFC distinto en el papel → no es duplicado', () => {
      expect(veredictoDuplicado(farolito, dulcelicias, opts)).toEqual({ nivel: 'distinto', motivo: 'otro_emisor', emisor: 'rfc_papel' });
    });
    it('con entrada destino: proveedor de Kepler distinto (CE011 vs CD43) → no es duplicado', () => {
      const v = veredictoDuplicado({ ...farolito, rfc: null, proveedorCode: 'CE011' }, dulcelicias, opts);
      expect(v).toEqual({ nivel: 'distinto', motivo: 'otro_emisor', emisor: 'proveedor_kepler' });
    });
    it('sin RFC ni proveedor (nota a mano): el importe distinto basta para saber que es otro papel', () => {
      const v = veredictoDuplicado({ folio: '0666', total: 22500 }, { folio: '0666', total: 1150 }, opts);
      expect(v).toEqual({ nivel: 'distinto', motivo: 'otro_importe', emisor: null });
    });
  });

  describe('lo que SÍ tiene que seguir bloqueando (prueba negativa del arreglo)', () => {
    it('el mismo PDF (mismo hash) bloquea aunque todo lo demás falte', () => {
      expect(veredictoDuplicado({ sha256: 'ef3a5846d7d4' }, dulcelicias, opts).nivel).toBe('bloquea');
    });
    it('mismo proveedor de Kepler + mismo folio, aunque el otro escaneo lea "666" sin ceros', () => {
      const v = veredictoDuplicado({ folio: '666', proveedorCode: 'cd43', total: 1150 }, dulcelicias, opts);
      expect(v).toEqual({ nivel: 'bloquea', motivo: 'mismo_emisor_mismo_folio', emisor: 'proveedor_kepler' });
    });
    it('mismo RFC de emisor + mismo folio, sin proveedor de Kepler', () => {
      const v = veredictoDuplicado({ folio: 'No. 0666', rfc: 'MEAM-800829-3J4' }, { folio: '0666', rfc: 'MEAM8008293J4' }, opts);
      expect(v.nivel).toBe('bloquea');
      expect(v.emisor).toBe('rfc_papel');
    });
    it('proveedor dado de alta con dos códigos (MY FEST CM038/CM043) pero mismo RFC: bloquea', () => {
      const a = { folio: '1234', rfc: 'MFE010101AB1', proveedorCode: 'CM038' };
      const b = { folio: '1234', rfc: 'MFE010101AB1', proveedorCode: 'CM043' };
      expect(veredictoDuplicado(a, b, opts).nivel).toBe('bloquea');
    });
  });

  describe('lo que no se puede probar se AVISA, nunca se bloquea ni se calla', () => {
    it('mismo folio, sin emisor de ningún lado y sin importes: avisa', () => {
      expect(veredictoDuplicado({ folio: '0666' }, { folio: '0666' }, opts))
        .toEqual({ nivel: 'avisa', motivo: 'emisor_sin_confirmar', emisor: null });
    });
    it('nuestro RFC leído en los dos papeles NO cuenta como emisor (es el receptor)', () => {
      const v = veredictoDuplicado({ folio: '0666', rfc: PROPIO }, { folio: '0666', rfc: 'LOGL851014AG5' }, opts);
      expect(v.nivel).toBe('avisa');
      expect(v.emisor).toBeNull();
    });
    it('sólo parecido de nombre: avisa, no bloquea (el nombre falla 1 de cada 4)', () => {
      const v = veredictoDuplicado({ folio: '5501', nombre: 'AZTECA CONFITERIA' }, { folio: '5501', proveedorNombre: 'AZTECA CONFITERIA SA DE CV' }, opts);
      expect(v).toEqual({ nivel: 'avisa', motivo: 'emisor_sin_confirmar', emisor: 'nombre' });
    });
    it('mismo proveedor y folio pero otro importe: avisa (puede ser el OCR del total)', () => {
      const v = veredictoDuplicado({ folio: '0666', proveedorCode: 'CD43', total: 1500 }, dulcelicias, opts);
      expect(v).toEqual({ nivel: 'avisa', motivo: 'mismo_folio_otro_importe', emisor: 'proveedor_kepler' });
    });
  });

  it('folios distintos o triviales no comparan', () => {
    expect(veredictoDuplicado({ folio: '0667' }, { folio: '0666' }, opts).nivel).toBe('distinto');
    expect(veredictoDuplicado({ folio: '07' }, { folio: '7' }, opts).nivel).toBe('distinto');
  });

  it('folioNucleo: los casos que el SQL (ltrim(regexp_replace(x, \'\\D\', \'\', \'g\'), \'0\')) replica', () => {
    expect(folioNucleo('0666')).toBe('666');
    expect(folioNucleo('A-0666')).toBe('666');
    expect(folioNucleo('No. 0006668')).toBe('6668');
    expect(folioNucleo('000')).toBeNull();
    expect(folioNucleo('12')).toBeNull();
    expect(folioNucleo(null)).toBeNull();
  });

  it('esRfcPropio tolera UN carácter mal leído y no dos', () => {
    expect(esRfcPropio('LOGL-851014-AQ5', PROPIO)).toBe(true);
    expect(esRfcPropio('LOGL851014AG5', PROPIO)).toBe(true);
    expect(esRfcPropio('LOGL851014XG5', PROPIO)).toBe(false);
    expect(esRfcPropio('CUMG660606M75', PROPIO)).toBe(false);
  });

  it('mismoEmisor devuelve null (no false) cuando no hay con qué comparar', () => {
    expect(mismoEmisor({}, {}, PROPIO)).toEqual({ igual: null, fuente: null });
  });

  it('masGrave: bloquea gana sobre avisa; distinto no cuenta', () => {
    const r = masGrave([{ nivel: 'distinto' as const, i: 1 }, { nivel: 'avisa' as const, i: 2 }, { nivel: 'bloquea' as const, i: 3 }]);
    expect(r?.i).toBe(3);
    expect(masGrave([{ nivel: 'distinto' as const }])).toBeNull();
  });

  it('el mensaje dice dónde vive el otro papel', () => {
    const m = mensajeDuplicado({ motivo: 'emisor_sin_confirmar', sucursal: '01', folio: '0000589', proveedor: 'DULCELICIAS', folioPapel: '0666', monto: 1150 });
    expect(m).toContain('01/0000589');
    expect(m).toContain('DULCELICIAS');
    expect(m).toContain('No se pudo confirmar');
  });
});
