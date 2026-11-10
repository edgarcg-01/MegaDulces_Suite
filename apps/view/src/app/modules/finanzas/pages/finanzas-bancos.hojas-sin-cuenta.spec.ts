import { avisoHojasSinCuenta } from './finanzas-bancos.component';

describe('[CB.60] avisoHojasSinCuenta — la hoja del libro que no entró se nombra', () => {
  it('nombra la hoja cuyo nombre no es el de ninguna cuenta', () => {
    const a = avisoHojasSinCuenta({ accounts: [
      { sheet: 'BB 4166', movs: 10 },
      { sheet: 'BB 366', note: 'cuenta no registrada — omitido' },
    ] });
    expect(a?.summary).toBe('1 hoja del libro no entró');
    expect(a?.detail).toContain('«BB 366»: su nombre no es el de ninguna cuenta');
  });

  it('[negativa] sin hojas omitidas por cuenta no hay aviso (ni por una hoja de otro formato)', () => {
    expect(avisoHojasSinCuenta({ accounts: [{ sheet: 'BB 4166', movs: 10 }, { sheet: 'NOTAS', note: 'layout no estándar — omitido' }] })).toBeNull();
  });

  it('varias hojas: las cuenta y las nombra todas', () => {
    const a = avisoHojasSinCuenta({ accounts: [{ sheet: 'BB 366', note: 'cuenta no registrada — omitido' }, { sheet: 'STDR 99', note: 'cuenta no registrada — omitido' }] });
    expect(a?.summary).toBe('2 hojas del libro no entraron');
    expect(a?.detail).toMatch(/^«BB 366», «STDR 99»:/);
  });
});
