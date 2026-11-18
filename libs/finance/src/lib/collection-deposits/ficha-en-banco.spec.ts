import {
  AbonoCandidato, FichaEnBanco, FilaFichaEnBanco, clasificarFichaEnBanco, marcarDisputas, sqlFichaEnBanco, sumarDias,
} from './ficha-en-banco';

const abono = (id: string, cobros: AbonoCandidato['cobros'] = null, declarado: string | null = null): AbonoCandidato =>
  ({ id, fecha: '2026-11-10', monto: 5000, banco: 'BBVA', cuenta: '4176', cobros, declarado });
const cobro = (cliente: string) => ({ sucursal: '02', folio: '0001234', tipo: 'U-A-5', cliente_code: cliente, cliente_nombre: 'X' });
const fila = (abonos: AbonoCandidato[], cargado = '2026-11-15', cliente = 'C-1'): FilaFichaEnBanco =>
  ({ id: 'f1', cliente_code: cliente, cuenta_id: null, cargado_hasta: cargado, abonos });

describe('[CC.21] clasificarFichaEnBanco', () => {
  it('un abono que CB ligó al cobro del MISMO cliente → aplicado, con el cobro a ligar', () => {
    const b = clasificarFichaEnBanco(fila([abono('m1', [cobro('C-1')])]), '2026-11-10', 5000);
    expect(b.estado).toBe('aplicado');
    expect(b.cobro?.folio).toBe('0001234');
  });

  it('el cobro de OTRO cliente nunca es «aplicado» (el monto solo no valida)', () => {
    const b = clasificarFichaEnBanco(fila([abono('m1', [cobro('C-9')])]), '2026-11-10', 5000);
    expect(b.estado).toBe('de_otro_cliente');
    expect(b.cobro).toBeNull();
  });

  it('el código del cliente se compara sin espacios de Kepler', () => {
    const b = clasificarFichaEnBanco(fila([abono('m1', [cobro(' C-1 ')])]), '2026-11-10', 5000);
    expect(b.estado).toBe('aplicado');
  });

  it('un abono sin cobro en Kepler → sin_aplicar', () => {
    expect(clasificarFichaEnBanco(fila([abono('m1')]), '2026-11-10', 5000).estado).toBe('sin_aplicar');
  });

  it('más de un abono → varios (lo decide una persona)', () => {
    expect(clasificarFichaEnBanco(fila([abono('m1'), abono('m2')]), '2026-11-10', 5000).estado).toBe('varios');
  });

  it('sin abono y el estado de cuenta YA cubre la ventana → no_aparece', () => {
    // depósito 10-nov, ventana hasta el 13; cargado hasta el 13 → sí se puede afirmar
    expect(clasificarFichaEnBanco(fila([], '2026-11-13'), '2026-11-10', 5000).estado).toBe('no_aparece');
  });

  it('sin abono pero el estado de cuenta NO llega a la ventana → banco_sin_cargar, nunca «no aparece»', () => {
    const b = clasificarFichaEnBanco(fila([], '2026-11-12'), '2026-11-10', 5000);
    expect(b.estado).toBe('banco_sin_cargar');
    expect(b.cargado_hasta).toBe('2026-11-12');
  });

  it('sin fecha de carga conocida → banco_sin_cargar (no medido)', () => {
    expect(clasificarFichaEnBanco(fila([], null as unknown as string), '2026-11-10', 5000).estado).toBe('banco_sin_cargar');
  });

  it('la cuenta leída DESEMPATA: de dos abonos, el de esa cuenta', () => {
    const b = clasificarFichaEnBanco(fila([abono('m1', [cobro('C-1')]), { ...abono('m2'), en_cuenta: true }]), '2026-11-10', 5000);
    expect(b.estado).toBe('sin_aplicar');
    expect(b.abonos.map((a) => a.id)).toEqual(['m2']);
  });

  it('la cuenta leída NO filtra: si no hay abono en ella (lectura mal hecha), se miran todos', () => {
    const b = clasificarFichaEnBanco(fila([abono('m1', [cobro('C-1')])]), '2026-11-10', 5000);
    expect(b.estado).toBe('aplicado');
  });

  it('sin monto o sin fecha → sin_dato', () => {
    expect(clasificarFichaEnBanco(fila([abono('m1')]), null, 5000).estado).toBe('sin_dato');
    expect(clasificarFichaEnBanco(fila([abono('m1')]), '2026-11-10', null).estado).toBe('sin_dato');
    expect(clasificarFichaEnBanco(fila([abono('m1')]), '2026-11-10', 0).estado).toBe('sin_dato');
  });
});

describe('[CC.21] marcarDisputas', () => {
  it('dos fichas sobre el mismo abono único quedan marcadas una contra otra', () => {
    const a = clasificarFichaEnBanco(fila([abono('m1')]), '2026-11-10', 5000);
    const b = clasificarFichaEnBanco(fila([abono('m1')]), '2026-11-10', 5000);
    const c = clasificarFichaEnBanco(fila([abono('m2')]), '2026-11-10', 5000);
    const mapa = new Map<string, FichaEnBanco>([['a', a], ['b', b], ['c', c]]);
    marcarDisputas(mapa);
    expect(a.disputado_con).toBe('b');
    expect(b.disputado_con).toBe('a');
    expect(c.disputado_con).toBeNull();
  });
});

describe('[CC.21] sqlFichaEnBanco', () => {
  it('cruza por los DOS montos (declarado y leído) y dentro de la ventana', () => {
    const sql = sqlFichaEnBanco('SELECT 1');
    expect(sql).toContain('fa.monto_alt - 1');
    expect(sql).toContain('fa.fecha - 1 AND fa.fecha + 3');
    // el cliente sale de kdm1 por su índice, no de la vista (60 ms por abono)
    expect(sql).toContain('kepler_ods.kdm1');
    expect(sql).not.toContain('analytics.erp_collections');
  });

  it('sumarDias cruza fin de mes', () => {
    expect(sumarDias('2026-10-30', 3)).toBe('2026-11-02');
  });
});
