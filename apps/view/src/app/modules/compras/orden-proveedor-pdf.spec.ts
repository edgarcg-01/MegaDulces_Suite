import { hayParciales, nombreArchivo, textoDestinos, textoEntregas } from './orden-proveedor-pdf';

/**
 * `[OC.3]` Lo puro del pedido consolidado a proveedor. No se prueba el dibujo del PDF —eso
 * necesita jsPDF y no diría nada— sino las decisiones que cambian lo que el proveedor LEE.
 */
describe('[OC.3] pedido consolidado a proveedor', () => {
  describe('la columna «Falta» sólo aparece si hay algo a medias', () => {
    const f = (cantidad: number, pendiente: number) =>
      ({ sku: 'A', nombre: 'x', cantidad, pendiente, unit_cost: 1, importe: 1, costo_varia: false, destinos: [] });

    it('órdenes abiertas sin recibir: pedido y pendiente son lo mismo → no se duplica la columna', () => {
      expect(hayParciales([f(10, 10), f(4, 4)])).toBe(false);
    });

    it('⭐ con una recibida a medias SÍ aparece: es la única forma de ver qué falta', () => {
      expect(hayParciales([f(10, 10), f(8, 3)])).toBe(true);
    });

    it('acepta el numeric como TEXTO, que es como llega de node-pg', () => {
      // Sin la conversión, '10' !== 10 marcaría parcial SIEMPRE y el papel llevaría una columna
      // de más en todos los pedidos.
      expect(hayParciales([{ ...f(0, 0), cantidad: '10.000', pendiente: '10.000' }])).toBe(false);
      expect(hayParciales([{ ...f(0, 0), cantidad: '10.000', pendiente: '3.000' }])).toBe(true);
    });

    it('no revienta con entrada vacía', () => {
      expect(hayParciales([])).toBe(false);
      expect(hayParciales(undefined as never)).toBe(false);
    });
  });

  describe('destinos', () => {
    it('une los almacenes del renglón', () => {
      expect(textoDestinos(['00', '01'])).toBe('00, 01');
    });

    it('⭐ sin destino dice «—», no una celda en blanco que parezca un olvido', () => {
      expect(textoDestinos([])).toBe('—');
      expect(textoDestinos(null)).toBe('—');
      expect(textoDestinos(['', '  '])).toBe('—');
    });
  });

  describe('entregas esperadas', () => {
    it('lista fecha y almacén, sin repetir', () => {
      expect(textoEntregas([
        { warehouse_code: '00', expected_date: '2026-10-24' },
        { warehouse_code: '01', expected_date: '2026-10-25' },
        { warehouse_code: '00', expected_date: '2026-10-24' },
      ])).toBe('24/10 (00), 25/10 (01)');
    });

    it('⭐ ninguna con fecha lo DICE, no se queda vacío', () => {
      expect(textoEntregas([{ warehouse_code: '00', expected_date: null }])).toBe('sin fecha comprometida');
      expect(textoEntregas([])).toBe('sin fecha comprometida');
    });

    it('ignora las que no tienen fecha pero conserva las que sí', () => {
      expect(textoEntregas([
        { warehouse_code: '00', expected_date: null },
        { warehouse_code: '01', expected_date: '2026-11-03' },
      ])).toBe('03/11 (01)');
    });
  });

  describe('nombre del archivo', () => {
    it('lleva proveedor y fecha, sin acentos', () => {
      const f = nombreArchivo('DULCES MONTAÑÉS', new Date(2026, 9, 19, 14, 30));
      expect(f).toMatch(/^pedido-/);
      expect(f).toMatch(/\.pdf$/);
      expect(f).not.toMatch(/[ÑÉñé]/);
    });
  });
});
