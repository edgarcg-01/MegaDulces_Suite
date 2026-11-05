import { casaNombre, ligasAutomaticas, palabrasDeNombre } from './vendedor-auto-liga';

/**
 * `[COT.25]` Los casos son los de prod (2026-11-04): los que tienen que ligarse y, sobre todo,
 * los que NO — una liga equivocada le atribuye la venta a otra persona.
 */
describe('[COT.25] liga automática usuario ↔ vendedor de Kepler', () => {
  describe('casaNombre', () => {
    it('quita prefijos de Kepler y no le importa el orden', () => {
      expect(palabrasDeNombre('TLMKT MOR ALBERTO AYALA')).toEqual(['ALBERTO', 'AYALA']);
      expect(casaNombre('RD Urbano Olivares Victorino', 'VICTORINO URBANO OLIVARES')).toBe(true);
    });

    it('acepta el nombre cortado a 30 caracteres y una última letra distinta', () => {
      expect(casaNombre('JOSE ANTONIO ESPINOZA CASTELLA', 'JOSE ANTONIO ESPINOZA CASTELLANOS')).toBe(true);
      expect(casaNombre('VMPH01 CINTHIA YARET DEL VALLE', 'Cinthia Yared Del Valle')).toBe(true);
      expect(casaNombre('RD Daniel Padilla Rojano', 'DANIEL ROJAÑO PADILLA')).toBe(true);
    });

    it('NO liga si falta una palabra del vendedor (otra persona con apellido parecido)', () => {
      expect(casaNombre('RD Jose Luis Mota Muñoz', 'Luis Fernando Munoz Herrera')).toBe(false);
    });

    it('NO liga con una sola palabra ni con nombres de plaza', () => {
      expect(casaNombre('HUMBERTO', 'Humberto Placencia Bravo')).toBe(false);
      expect(casaNombre('SUCURSAL ZAMORA CENTRO PISO', 'Etiquetas - Zamora Centro')).toBe(false);
      expect(casaNombre('TLMKT PADRE HIDALGO', 'Checador - Padre Hidalgo')).toBe(false);
      expect(casaNombre('PV MORELIA MADERO', 'Etiquetas - Almacén Morelia Madero (32)')).toBe(false);
      expect(casaNombre('RUTA VECINAL ZAMORA CENTRO', 'Juan Ruta Zamora Centro')).toBe(false);
    });

    it('un apellido que también es plaza no estorba si hay nombre de persona', () => {
      expect(casaNombre('JUAN HIDALGO PEREZ', 'Juan Carlos Hidalgo Perez')).toBe(true);
    });
  });

  describe('ligasAutomaticas', () => {
    const daniel = { user_id: 'u-daniel', nombre: 'Daniel Francisco Franco Martinez' };
    const francisco = { user_id: 'u-francisco', nombre: 'FRANCISCO DE JESUS MARTINEZ RAZO' };
    const sergio = { user_id: 'u-sergio', nombre: 'SERGIO FRANCISCO MENDOZA PEREZ' };

    it('un código que casa con dos personas no se liga a ninguna', () => {
      const r = ligasAutomaticas([daniel, francisco], [{ sucursal: '06', code: '505', name: 'FRANCISCO MARTINEZ' }], new Set());
      expect(r.size).toBe(0);
    });

    it('con dos códigos en la sucursal gana el único con pedidos; sin actividad, ninguno', () => {
      const vendedores = [
        { sucursal: '01', code: '10002', name: 'VMPH01 SERGIO FRANCISCO MENDOZ' },
        { sucursal: '01', code: '10M01', name: 'TLMK Sergio Francisco Mendoza' },
      ];
      expect(ligasAutomaticas([sergio], vendedores, new Set(['01|10002'])).get('u-sergio')).toEqual({
        '01': { code: '10002', name: 'VMPH01 SERGIO FRANCISCO MENDOZ' },
      });
      expect(ligasAutomaticas([sergio], vendedores, new Set()).size).toBe(0);
    });

    it('Daniel se liga a su código aunque también case con el 505 compartido', () => {
      const r = ligasAutomaticas(
        [daniel, francisco],
        [
          { sucursal: '06', code: '30003', name: 'TLMKT CAN DANIEL FRANCO M' },
          { sucursal: '06', code: '505', name: 'FRANCISCO MARTINEZ' },
        ],
        new Set(['06|30003']),
      );
      expect(r.get('u-daniel')).toEqual({ '06': { code: '30003', name: 'TLMKT CAN DANIEL FRANCO M' } });
      expect(r.has('u-francisco')).toBe(false);
    });

    it('un código ya ligado a mano no se reparte por nombre', () => {
      const r = ligasAutomaticas([sergio], [{ sucursal: '01', code: '10002', name: 'VMPH01 SERGIO FRANCISCO MENDOZ' }], new Set(), new Set(['01|10002']));
      expect(r.size).toBe(0);
    });
  });
});
