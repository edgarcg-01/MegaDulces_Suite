import { avisoCuentasDelBanco, avisoHojasSinCuenta } from './finanzas-bancos.component';

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

describe('[CB.60b] avisoCuentasDelBanco — lo que el libro ya no mete en una cuenta que usa el banco se dice', () => {
  it('nombra la hoja, desde cuándo y cuántos renglones no entraron (la nota exacta del servidor)', () => {
    const a = avisoCuentasDelBanco({ accounts: [
      { sheet: 'BB 4166', movs: 3, note: 'usa el banco desde 2026-11-10: 12 renglón(es) del libro no entraron' },
      { sheet: 'BBVA 4176', movs: 40 },
    ] });
    expect(a?.summary).toBe('1 cuenta ya usa el banco');
    expect(a?.detail).toBe('«BB 4166» desde el 10/11: 12 renglón(es) del libro no entraron: esos movimientos los trae la descarga del banco.');
  });

  it('[negativa] sin cuentas que usen el banco no hay aviso, ni por otra nota', () => {
    expect(avisoCuentasDelBanco({ accounts: [{ sheet: 'BB 366', note: 'cuenta no registrada — omitido' }, { sheet: 'BB 4166', movs: 10 }] })).toBeNull();
  });
});
