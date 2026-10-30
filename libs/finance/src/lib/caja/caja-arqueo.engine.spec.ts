import type { DocumentoEnCaja } from '@megadulces/contracts';
import { validarArqueo, totalArqueo, puedeRecontarCorte, validarDocumentos, resumenDocumentos } from './caja-arqueo.engine';

/** `[CGS.42]` El arqueo completo, con el último arqueo de Control (A23706, 21-oct 17:47) como caso. */
describe('validarArqueo', () => {
  const A23706 = {
    tipo: 'intermedio' as const,
    // 23,756.50 en efectivo: 31 de 200 + 150 de 100 + 2 de 50 + 37 de 20 + 2,016.50 de morralla.
    piezas: [{ denom_key: '200', piezas: 31 }, { denom_key: '100', piezas: 150 }, { denom_key: '50', piezas: 2 }, { denom_key: '20', piezas: 37 }],
    morralla: 1716.5,
    caja_fuerte: 502640, caja_fuerte_fuente: 'pantalla de la máquina',
    usd: 12059, tipo_cambio: 19.101, tipo_cambio_fuente: 'Control A23706',
  };

  it('suma el efectivo de las piezas más la morralla y guarda los cinco rubros', () => {
    const r = validarArqueo(A23706);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arqueo.efectivo).toBe(6200 + 15000 + 100 + 740 + 1716.5);
    // Los cheques y los papeles los pone el servicio con la suma de sus renglones.
    const conDocumentos = { ...r.arqueo, cheques: 10121, papeles: 20782 };
    expect(totalArqueo(conDocumentos)).toBe(Math.round((r.arqueo.efectivo + 502640 + 10121 + 20782 + 12059 * 19.101) * 100) / 100);
  });

  it('[negativa] un rubro vacío es «no se contó»: queda null y el total NO se suma', () => {
    const r = validarArqueo({ ...A23706, cheques: null, papeles: '' as unknown as null });
    expect(r.ok && r.arqueo.cheques).toBeNull();
    expect(r.ok && r.arqueo.papeles).toBeNull();
    expect(r.ok && totalArqueo(r.arqueo)).toBeNull();
  });

  it('⛔ `[CGS.59]` [negativa] un importe de cheques o papeles tecleado, sin sus renglones, se rechaza (también el 0)', () => {
    expect(validarArqueo({ ...A23706, cheques: 10121 as unknown as null })).toEqual({ ok: false, motivo: 'documentos_sin_detalle' });
    expect(validarArqueo({ ...A23706, papeles: 20782 as unknown as null })).toEqual({ ok: false, motivo: 'documentos_sin_detalle' });
    expect(validarArqueo({ ...A23706, cheques: 0 as unknown as null })).toEqual({ ok: false, motivo: 'documentos_sin_detalle' });
  });

  it('[negativa] dólares sin tipo de cambio o sin fuente se rechazan', () => {
    expect(validarArqueo({ ...A23706, tipo_cambio: null })).toEqual({ ok: false, motivo: 'dolares_sin_cambio' });
    expect(validarArqueo({ ...A23706, tipo_cambio_fuente: '  ' })).toEqual({ ok: false, motivo: 'dolares_sin_cambio' });
  });

  it('[negativa] caja fuerte sin decir de dónde salió la cifra', () => {
    expect(validarArqueo({ ...A23706, caja_fuerte_fuente: null })).toEqual({ ok: false, motivo: 'caja_fuerte_sin_fuente' });
  });

  it('[negativa] piezas que no existen, con decimales o negativas, y montos negativos', () => {
    expect(validarArqueo({ ...A23706, piezas: [{ denom_key: '300', piezas: 1 }] })).toEqual({ ok: false, motivo: 'denominacion' });
    expect(validarArqueo({ ...A23706, piezas: [{ denom_key: '500', piezas: 1.5 }] })).toEqual({ ok: false, motivo: 'piezas' });
    expect(validarArqueo({ ...A23706, piezas: [{ denom_key: '500', piezas: -1 }] })).toEqual({ ok: false, motivo: 'piezas' });
    expect(validarArqueo({ ...A23706, usd: -5 })).toEqual({ ok: false, motivo: 'monto' });
    expect(validarArqueo({ ...A23706, piezas: [] })).toEqual({ ok: false, motivo: 'piezas_vacias' });
  });

  it('[negativa] el recuento sin corte no es testigo de nada', () => {
    expect(validarArqueo({ ...A23706, tipo: 'recuento' })).toEqual({ ok: false, motivo: 'sin_corte' });
    expect(validarArqueo({ ...A23706, tipo: 'recuento', corte_id: 'c-8' }).ok).toBe(true);
  });

  it('el cajón vacío se declara con un renglón en 0', () => {
    const r = validarArqueo({ tipo: 'intermedio', piezas: [{ denom_key: '500', piezas: 0 }] });
    expect(r.ok && r.arqueo.efectivo).toBe(0);
  });
});

describe('puedeRecontarCorte', () => {
  const corte = { estado: 'cerrado', created_by: 'carmen', closed_by: 'carmen' };
  it('María recuenta el corte de Carmen', () => {
    expect(puedeRecontarCorte(corte, 'maria')).toEqual({ ok: true });
  });
  it('[negativa] quien contó o cerró el corte no lo recuenta', () => {
    expect(puedeRecontarCorte(corte, 'carmen')).toEqual({ ok: false, motivo: 'mismo_que_cerro' });
    expect(puedeRecontarCorte({ ...corte, closed_by: 'mayra' }, 'mayra')).toEqual({ ok: false, motivo: 'mismo_que_cerro' });
  });
  it('[negativa] un corte abierto no se recuenta', () => {
    expect(puedeRecontarCorte({ ...corte, estado: 'borrador' }, 'maria')).toEqual({ ok: false, motivo: 'corte_abierto' });
  });
});

/**
 * ⭐ `[CGS.59]` Cheques y papeles, uno por uno. Edgar, 2026-10-30: «cuando hay un cheque, crédito o
 * papel… cómo agregar esos apartados». El caso que lo motiva: el mismo importe de papeles
 * re-declarado en 383 arqueos de Control, sin que nadie supiera quién debía ni por qué.
 */
describe('validarDocumentos', () => {
  const cheque = (p: Partial<DocumentoEnCaja> = {}): DocumentoEnCaja => ({
    pieza: 'p-ch-1', tipo: 'cheque', clase: null, monto: 10121, banco: 'Banamex', numero: '0012345',
    de_quien: 'Abarrotes La Luz', concepto: null, fecha: '2026-10-19', visto_desde: '2026-10-23', ...p,
  });
  const vale = (p: Partial<DocumentoEnCaja> = {}): DocumentoEnCaja => ({
    pieza: 'p-pa-1', tipo: 'papel', clase: 'vale', monto: 20782, banco: null, numero: null,
    de_quien: 'Pedro Ramírez', concepto: 'anticipo de viáticos', fecha: null, visto_desde: '2026-10-23', ...p,
  });
  const nuevoCheque = { estado: 'esta' as const, monto: 5000, banco: 'BBVA', numero: '88', de_quien: 'Dulcería Mary' };

  it('`null` es «no se contó»: el importe queda null y lo que había espera al siguiente conteo', () => {
    expect(validarDocumentos('cheque', [cheque()], null)).toEqual({ ok: true, total: null, filas: [] });
  });

  it('`[]` sin nada antes es «se contó y no hay»: importe 0, distinto de null', () => {
    expect(validarDocumentos('papel', [], [])).toEqual({ ok: true, total: 0, filas: [] });
  });

  it('el que sigue conserva su pieza y sus datos; el nuevo entra sin pieza; el importe es la suma de los que están', () => {
    const r = validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'esta' }, nuevoCheque]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(15121);
    expect(r.filas[0]).toMatchObject({ pieza: 'p-ch-1', estado: 'esta', monto: 10121, banco: 'Banamex', numero: '0012345' });
    expect(r.filas[1]).toMatchObject({ pieza: null, estado: 'esta', monto: 5000, banco: 'BBVA', de_quien: 'Dulcería Mary' });
  });

  it('⛔ los datos de uno que ya estaba NO se cambian desde la pantalla: se copian del arqueo anterior', () => {
    const r = validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'esta', monto: 1, banco: 'Otro' }]);
    expect(r.ok && r.filas[0]).toMatchObject({ monto: 10121, banco: 'Banamex' });
    expect(r.ok && r.total).toBe(10121);
  });

  it('el que salió no suma, y dice por qué', () => {
    const r = validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'salio', salida: 'depositado' }]);
    expect(r).toMatchObject({ ok: true, total: 0 });
    expect(r.ok && r.filas[0]).toMatchObject({ estado: 'salio', salida: 'depositado', monto: 10121 });
  });

  it('[negativa] ⭐ un documento que había no puede desaparecer sin marcarse', () => {
    expect(validarDocumentos('cheque', [cheque()], [])).toEqual({ ok: false, motivo: 'falta_anterior' });
    expect(validarDocumentos('papel', [vale(), vale({ pieza: 'p-pa-2' })], [{ pieza: 'p-pa-1', estado: 'esta' }]))
      .toEqual({ ok: false, motivo: 'falta_anterior' });
  });

  it('[negativa] una pieza que no estaba, o la misma dos veces', () => {
    expect(validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'esta' }, { pieza: 'zzz', estado: 'esta' }]))
      .toEqual({ ok: false, motivo: 'pieza_desconocida' });
    expect(validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'esta' }, { pieza: 'p-ch-1', estado: 'salio', salida: 'depositado' }]))
      .toEqual({ ok: false, motivo: 'pieza_repetida' });
    // Un papel no se marca en la lista de cheques.
    expect(validarDocumentos('cheque', [vale()], [{ pieza: 'p-pa-1', estado: 'esta' }])).toEqual({ ok: false, motivo: 'pieza_desconocida' });
  });

  it('[negativa] la salida tiene que ser de su tipo, y «otra cosa» lleva nota', () => {
    expect(validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'salio' }])).toEqual({ ok: false, motivo: 'salida' });
    expect(validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'salio', salida: 'pagado' }])).toEqual({ ok: false, motivo: 'salida' });
    expect(validarDocumentos('papel', [vale()], [{ pieza: 'p-pa-1', estado: 'salio', salida: 'depositado' }])).toEqual({ ok: false, motivo: 'salida' });
    expect(validarDocumentos('papel', [vale()], [{ pieza: 'p-pa-1', estado: 'salio', salida: 'otro', salida_nota: ' ' }]))
      .toEqual({ ok: false, motivo: 'salida_sin_nota' });
    expect(validarDocumentos('papel', [vale()], [{ pieza: 'p-pa-1', estado: 'esta', salida: 'pagado' }])).toEqual({ ok: false, motivo: 'salida' });
    expect(validarDocumentos('papel', [vale()], [{ pieza: 'p-pa-1', estado: 'salio', salida: 'otro', salida_nota: 'se descontó de nómina' }]).ok).toBe(true);
  });

  it('[negativa] un nuevo no «sale», y lleva lo que lo identifica', () => {
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, estado: 'salio', salida: 'depositado' }])).toEqual({ ok: false, motivo: 'nuevo_salio' });
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, banco: ' ' }])).toEqual({ ok: false, motivo: 'cheque_incompleto' });
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, numero: null }])).toEqual({ ok: false, motivo: 'cheque_incompleto' });
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, de_quien: 'yo' }])).toEqual({ ok: false, motivo: 'cheque_incompleto' });
    const papel = { estado: 'esta' as const, clase: 'credito' as const, monto: 1952, de_quien: 'Tienda Lupita', concepto: 'venta ruta 27' };
    expect(validarDocumentos('papel', [], [papel])).toMatchObject({ ok: true, total: 1952 });
    expect(validarDocumentos('papel', [], [{ ...papel, clase: null }])).toEqual({ ok: false, motivo: 'papel_incompleto' });
    expect(validarDocumentos('papel', [], [{ ...papel, concepto: '' }])).toEqual({ ok: false, motivo: 'papel_incompleto' });
  });

  it('[negativa] importes: cero, negativos o con más de dos decimales', () => {
    for (const monto of [0, -1, 10.005, null, Number.NaN]) {
      expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, monto }])).toEqual({ ok: false, motivo: 'monto' });
    }
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, monto: 10.1 }])).toMatchObject({ ok: true, total: 10.1 });
  });

  it('[negativa] el mismo cheque dos veces (banco y número, sin importar mayúsculas ni espacios), o uno que ya estaba', () => {
    expect(validarDocumentos('cheque', [], [nuevoCheque, { ...nuevoCheque, banco: ' bbva ', numero: '88 ' }]))
      .toEqual({ ok: false, motivo: 'cheque_repetido' });
    expect(validarDocumentos('cheque', [cheque()], [{ pieza: 'p-ch-1', estado: 'esta' }, { ...nuevoCheque, banco: 'BANAMEX', numero: '0012345' }]))
      .toEqual({ ok: false, motivo: 'cheque_repetido' });
  });

  it('la fecha tiene que existir; un cheque posfechado se acepta', () => {
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, fecha: '2026-02-30' }])).toEqual({ ok: false, motivo: 'fecha' });
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, fecha: '30/10/2026' }])).toEqual({ ok: false, motivo: 'fecha' });
    expect(validarDocumentos('cheque', [], [{ ...nuevoCheque, fecha: '2027-01-15' }]).ok).toBe(true);
  });

  it('el resumen dice cuántos siguen, cuántos entraron y cuáles salieron', () => {
    const r = validarDocumentos('papel', [vale(), vale({ pieza: 'p-pa-2', de_quien: 'Ana Soto', concepto: 'gasolina', monto: 500 })], [
      { pieza: 'p-pa-1', estado: 'esta' },
      { pieza: 'p-pa-2', estado: 'salio', salida: 'comprobado' },
      { estado: 'esta', clase: 'credito', monto: 1952, de_quien: 'Tienda Lupita', concepto: 'venta ruta 27' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(resumenDocumentos(r.filas, r.total as number)).toEqual({
      total: 22734, siguen: 1, entraron: 1,
      salieron: [{ texto: 'Vale · Ana Soto: gasolina', monto: 500, salida: 'comprobado', nota: null }],
    });
  });
});
