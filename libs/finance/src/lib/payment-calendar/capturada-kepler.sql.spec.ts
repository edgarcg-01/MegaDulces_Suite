import { cierreCompleto } from '@megadulces/contracts';
import { armarCierres, idsParaCierre, type FilaCierreKepler, type ItemParaCierre } from './cierre-kepler.sql';
import {
  conLlaveDeKepler, idKeplerDeCapturada, sqlDebeKeplerDeCapturada, sqlDisponibleDeCapturada, type LlaveDeCapturada,
} from './capturada-kepler.sql';

/** La obligación capturada del pago doble de CD031 (CEDIS), con la llave tal como la guarda la tabla (numeric → texto). */
const CD031: LlaveDeCapturada = { id: 'eb277b1b-e39d-4c6b-9873-1deef6987f2e', sucursal: '00', doc_tipo: '20', doc_sub: '1', folio: '0009890' };
/** El id de esa factura calculado EN PROD por la vista (`md5('kepler_payable|'||sucursal||'|'||c4||'|'||c5||'|'||btrim(c6))`). */
const ID_EN_PROD = 'e2561b55-a67e-1678-8d41-266af6c9c64c';

describe('[PGP.197] la obligación capturada se mide como la factura de Kepler que es', () => {
  it('su llave da el MISMO id que la vista en prod (control con la factura real de CD031)', () => {
    expect(idKeplerDeCapturada(CD031)).toBe(ID_EN_PROD);
    // numeric de pg llega como texto; con espacios en el folio o la sucursal tiene que dar lo mismo.
    expect(idKeplerDeCapturada({ ...CD031, doc_tipo: 20, doc_sub: 1, folio: ' 0009890 ', sucursal: '00 ' })).toBe(ID_EN_PROD);
    // Control: otro folio no puede dar el mismo id.
    expect(idKeplerDeCapturada({ ...CD031, folio: '0009891' })).not.toBe(ID_EN_PROD);
  });

  it('sin llave completa no se inventa a qué factura apunta', () => {
    expect(idKeplerDeCapturada({ ...CD031, folio: null })).toBeNull();
    expect(idKeplerDeCapturada({ ...CD031, sucursal: '  ' })).toBeNull();
    expect(idKeplerDeCapturada({ ...CD031, doc_tipo: null })).toBeNull();
    expect(idKeplerDeCapturada({ ...CD031, doc_sub: 'x' })).toBeNull();
  });

  it('el cierre convierte sólo las capturadas con llave; las demás quedan igual', () => {
    const items: ItemParaCierre[] = [
      { allocation_id: 'p1', obligation_source: 'supplier_payable', obligation_id: CD031.id },
      { allocation_id: 'p1', obligation_source: 'supplier_payable', obligation_id: 'sin-llave' },
      { allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: 'k1' },
      { allocation_id: 'p1', obligation_source: 'budget_expense', obligation_id: CD031.id },
    ];
    const out = conLlaveDeKepler(items, [CD031, { id: 'sin-llave', sucursal: '00', doc_tipo: 20, doc_sub: 1, folio: null }]);
    expect(out[0]).toEqual({ allocation_id: 'p1', obligation_source: 'kepler_payable', obligation_id: ID_EN_PROD });
    expect(out[1]).toBe(items[1]);
    expect(out[2]).toBe(items[2]);
    // Otro origen con el mismo id no se toca: la llave es de la obligación capturada, no del número.
    expect(out[3]).toBe(items[3]);
    expect(idsParaCierre(out)).toEqual([ID_EN_PROD, 'k1']);
  });

  it('un pago con una capturada que Kepler ya pagó con dinero queda «pagado» (antes: «sin medir» para siempre)', () => {
    const items: ItemParaCierre[] = [{ allocation_id: 'p1', obligation_source: 'supplier_payable', obligation_id: CD031.id }];
    const filas: FilaCierreKepler[] = [{
      obligation_id: ID_EN_PROD, importe: 1000, psuc: '00', p_tipo: 26, p_sub: 1, p_folio: '0024281', aplicado: 1000,
      fecha: '2026-11-09', cuenta: null, cuenta_nombre: null, comprobante_id: null, comprobante_estado: null,
    }];
    const pagos = [{ id: 'p1', lotDate: '2026-11-13', alta: '2026-11-13' }];
    const antes = armarCierres(pagos, items, filas).get('p1');
    expect(antes?.estado).toBe('sin_medir');
    expect(cierreCompleto(antes)).toBe(false);
    const ahora = armarCierres(pagos, conLlaveDeKepler(items, [CD031]), filas).get('p1');
    expect(ahora?.estado).toBe('pagado');
    expect(cierreCompleto(ahora)).toBe(true);
  });

  it('la consulta del saldo descarta los documentos cancelados y se ata a la llave de la obligación', () => {
    const sql = sqlDebeKeplerDeCapturada('o');
    expect(sql).toMatch(/NOT EXISTS[\s\S]*kepler_ods\.kdm1[\s\S]*m\.c43 = 'C'/);
    expect(sql).toContain('btrim(o.kepler_folio)');
    expect(sql).toContain('e.c4 = o.kepler_doc_tipo');
    expect(sql).toContain("e.c3 = 'A'");
  });

  it('lo disponible se topa con lo que Kepler debe (least), y sin medida queda como antes', () => {
    const sql = sqlDisponibleDeCapturada('o', 'kd');
    expect(sql).toMatch(/WHEN kd\.debe IS NULL THEN \(o\.original_amount - o\.reserved_amount - o\.paid_amount\)/);
    expect(sql).toMatch(/least\(\(o\.original_amount - o\.reserved_amount - o\.paid_amount\), greatest\(kd\.debe - o\.reserved_amount, 0\)\)/);
  });
});
