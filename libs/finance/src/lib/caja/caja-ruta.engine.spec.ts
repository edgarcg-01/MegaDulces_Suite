import { leerVentaDeRuta, anioDeVenta, fechaDeVentaDeclarada } from './caja-ruta.engine';

/**
 * CG.20 — El candado del resolvedor de ruta/fecha de la caja general.
 *
 * Los textos de abajo NO son inventados: son los `nombre_cliente` que estaban en produccion en
 * octubre de 2026, con sus erratas (`06//10`, `Vetas`). Un parser de prosa que se prueba con
 * prosa limpia no prueba nada.
 */
describe('caja-ruta.engine — leer la venta de ruta que declara el texto', () => {
  describe('lo que SI declara ruta y dia (corpus real de octubre)', () => {
    const casos: [string, string, number, number][] = [
      ['Ventas 01/10 RD21', '21', 10, 1],
      ['Ventas 02/10 RD 23', '23', 10, 2],
      ['Ventas 03/10 RD22', '22', 10, 3],
      ['Ventas Canindo 01/10 RD 501', '501', 10, 1],
      ['Ventas Canindo 02/10 RD504', '504', 10, 2],
      ['Ventas 30/09 RD Canindo 504', '504', 9, 30],
      ['Ventas 30/09 RD Canindo 502', '502', 9, 30],
      ['Ventas 06//10 RD 21', '21', 10, 6],
      ['Ventas 06/10 RD 23', '23', 10, 6],
    ];
    it.each(casos)('%s', (texto, ruta, mes, dia) => {
      expect(leerVentaDeRuta(texto)).toEqual({ ruta, mes, dia });
    });

    it('quita los ceros a la izquierda para que case con el registro', () => {
      expect(leerVentaDeRuta('Ventas 01/10 RD 021')?.ruta).toBe('21');
    });
  });

  /**
   * ⭐ El MISMO parser lee el lado de Kepler. Estos son los `concepto` reales de los cobros
   * `U-A-5` a la cuenta CAJA GENERAL, medidos en prod: traen la ruta y el día igual que la caja,
   * pero con guiones y CON año. Que sea una sola expresión es el punto — la identidad ruta+día es
   * la misma de los dos lados, y dos parsers divergen (ya pasó con el regex de ruta, que vivía en
   * tres lugares con dos formas distintas).
   */
  describe('el lado KEPLER: el concepto del cobro declara lo mismo, con guiones y con año', () => {
    const casos: [string, string, number, number, number][] = [
      ['VENTA RD 27 01-10-2026', '27', 10, 1, 2026],
      ['VENTA RD 501 29-09-2026', '501', 9, 29, 2026],
      ['VENTA RD 504 30-09-2026', '504', 9, 30, 2026],
      ['VENTA RD 23 01/10/2026', '23', 10, 1, 2026],
    ];
    it.each(casos)('%s', (texto, ruta, mes, dia, anio) => {
      expect(leerVentaDeRuta(texto)).toEqual({ ruta, mes, dia, anio });
    });

    it('⭐ con año en el texto NO se infiere nada: manda el que está escrito', () => {
      // La captura es de 2027 y el concepto dice 2026: gana el concepto.
      expect(fechaDeVentaDeclarada('VENTA RD 27 01-10-2026', '2027-01-15')).toBe('2026-10-01');
    });
    it('el año de cuatro dígitos no se confunde con el día', () => {
      expect(leerVentaDeRuta('VENTA RD 27 01-10-26')).toEqual({ ruta: '27', mes: 10, dia: 1 });
    });
  });

  describe('lo que NO declara ruta — y devolver null es la respuesta correcta', () => {
    // La vecinal entra por nombre de persona. Si esto devolviera una ruta, la caja le aplicaria
    // la venta de un camion a un vendedor que no lo maneja.
    const sinRuta = [
      'Ventas Ruta Vecinal 30/09',
      'Ventas RV 02/10',
      'Vetas Ruta Vecinal 01/10',
      'Ventas RutaVecinal  02/10',
      'VTA 05/10/2026',
      'pago tdc computo',
      '',
      null,
      undefined,
    ];
    it.each(sinRuta)('%s', (texto) => {
      expect(leerVentaDeRuta(texto as string)).toBeNull();
    });

    it('media declaracion no sirve: ruta sin fecha', () => {
      expect(leerVentaDeRuta('Ventas RD 23')).toBeNull();
    });
    it('media declaracion no sirve: fecha sin ruta', () => {
      expect(leerVentaDeRuta('Ventas 01/10 Canindo')).toBeNull();
    });
    it('un mes imposible no se corrige, se rechaza', () => {
      expect(leerVentaDeRuta('Ventas 01/13 RD 23')).toBeNull();
    });
    it('no lee la ruta 501 dentro de un numero mas largo', () => {
      expect(leerVentaDeRuta('Ventas 01/10 RD 5011')).toBeNull();
    });
  });

  describe('el anio que le toca a un dd/mm sin anio', () => {
    const cap = (s: string) => new Date(`${s}T00:00:00Z`);
    it('la venta del mismo mes es del mismo anio', () => {
      expect(anioDeVenta(cap('2026-10-03'), 10, 1)).toBe(2026);
    });
    it('una venta de fin de mes capturada al mes siguiente sigue siendo del mismo anio', () => {
      expect(anioDeVenta(cap('2026-10-02'), 9, 30)).toBe(2026);
    });
    it('⭐ en la frontera de anio la venta es del anio ANTERIOR', () => {
      expect(anioDeVenta(cap('2027-01-02'), 12, 30)).toBe(2026);
    });
    it('⭐ y eso NO se resuelve con "si el mes es diciembre": en marzo, diciembre tambien es del anio anterior', () => {
      expect(anioDeVenta(cap('2026-03-01'), 12, 15)).toBe(2025);
    });
    it('tolera un dia de diferencia por zona horaria sin mandar la venta un anio atras', () => {
      expect(anioDeVenta(cap('2026-10-03'), 10, 4)).toBe(2026);
    });
  });

  describe('fechaDeVentaDeclarada', () => {
    it('arma la fecha completa', () => {
      expect(fechaDeVentaDeclarada('Ventas 01/10 RD21', '2026-10-01')).toBe('2026-10-01');
    });
    it('la captura puede ser dias despues de la venta', () => {
      expect(fechaDeVentaDeclarada('Ventas Canindo 01/10 RD 501', '2026-10-03')).toBe('2026-10-01');
    });
    it('cruza el fin de mes', () => {
      expect(fechaDeVentaDeclarada('Ventas 30/09 RD Canindo 504', '2026-10-02')).toBe('2026-09-30');
    });
    it('⛔ un 31 de febrero NO se corre al 3 de marzo: se rechaza', () => {
      expect(fechaDeVentaDeclarada('Ventas 31/02 RD 23', '2026-03-02')).toBeNull();
    });
    it('sin declaracion, null', () => {
      expect(fechaDeVentaDeclarada('pago tdc computo', '2026-10-03')).toBeNull();
    });

    /**
     * ⛔ ESTE caso no es teorico: asi se rompio en la primera corrida contra prod. El servicio
     * pasaba la fecha de captura por un `String(fecha).slice(0,10)` sobre un `date` de pg -- que
     * es un objeto Date -- y entregaba "Sat Oct 03". La funcion devolvia null en TODAS las filas
     * y la columna Ruta salia vacia, sin un solo error. Que rechace es correcto; lo que estaba
     * mal era quien la llamaba (ver `const key = ymd` en conciliacionDia).
     */
    it('⛔ una fecha que no es ISO se RECHAZA, no se adivina ("Sat Oct 03" de un Date mal serializado)', () => {
      expect(fechaDeVentaDeclarada('Ventas 01/10 RD21', 'Sat Oct 03')).toBeNull();
    });
    it('…y con la fecha bien armada, la misma fila resuelve', () => {
      expect(fechaDeVentaDeclarada('Ventas 01/10 RD21', '2026-10-03')).toBe('2026-10-01');
    });
    it('acepta un Date directo, que es lo que pg entrega', () => {
      expect(fechaDeVentaDeclarada('Ventas 01/10 RD21', new Date(Date.UTC(2026, 9, 3)))).toBe('2026-10-01');
    });
  });
});
