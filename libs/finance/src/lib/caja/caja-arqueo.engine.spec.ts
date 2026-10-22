import { validarArqueo, totalArqueo, puedeRecontarCorte } from './caja-arqueo.engine';

/** `[CGS.42]` El arqueo completo, con el último arqueo de Control (A23706, 21-oct 17:47) como caso. */
describe('validarArqueo', () => {
  const A23706 = {
    tipo: 'intermedio' as const,
    // 23,756.50 en efectivo: 31 de 200 + 150 de 100 + 2 de 50 + 37 de 20 + 2,016.50 de morralla.
    piezas: [{ denom_key: '200', piezas: 31 }, { denom_key: '100', piezas: 150 }, { denom_key: '50', piezas: 2 }, { denom_key: '20', piezas: 37 }],
    morralla: 1716.5,
    caja_fuerte: 502640, caja_fuerte_fuente: 'pantalla de la máquina',
    cheques: 10121, papeles: 20782, usd: 12059, tipo_cambio: 19.101, tipo_cambio_fuente: 'Control A23706',
  };

  it('suma el efectivo de las piezas más la morralla y guarda los cinco rubros', () => {
    const r = validarArqueo(A23706);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.arqueo.efectivo).toBe(6200 + 15000 + 100 + 740 + 1716.5);
    expect(totalArqueo(r.arqueo)).toBe(Math.round((r.arqueo.efectivo + 502640 + 10121 + 20782 + 12059 * 19.101) * 100) / 100);
  });

  it('[negativa] un rubro vacío es «no se contó»: queda null y el total NO se suma', () => {
    const r = validarArqueo({ ...A23706, cheques: null, papeles: '' as unknown as number });
    expect(r.ok && r.arqueo.cheques).toBeNull();
    expect(r.ok && r.arqueo.papeles).toBeNull();
    expect(r.ok && totalArqueo(r.arqueo)).toBeNull();
  });

  it('cero es «se contó y no hay», distinto de vacío', () => {
    const r = validarArqueo({ ...A23706, cheques: 0 });
    expect(r.ok && r.arqueo.cheques).toBe(0);
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
    expect(validarArqueo({ ...A23706, cheques: -5 })).toEqual({ ok: false, motivo: 'monto' });
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
