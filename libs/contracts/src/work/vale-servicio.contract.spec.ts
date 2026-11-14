// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { folioVale, motivoNoPuede, puedeEditarTrabajo, validarNuevoVale, type QuienActua, type ValeParaReglas } from './vale-servicio.contract';

const YO = 'u-yo', OTRO = 'u-otro';
const vale = (p: Partial<ValeParaReglas>): ValeParaReglas => ({ status: 'open', requested_by: OTRO, assigned_to: null, work_detail: null, ...p });
const quien = (p: Partial<QuienActua> = {}): QuienActua => ({ user_id: YO, puede_atender: false, puede_gestionar: false, ...p });

describe('[MDT.1.5] motivoNoPuede — quién hace qué sobre un vale (D8b)', () => {
  it('tomar: sólo abierto y sólo quien atiende o coordina', () => {
    expect(motivoNoPuede('take', vale({}), quien({ puede_atender: true }))).toBeNull();
    expect(motivoNoPuede('take', vale({}), quien())).toMatch(/atiende/);
    expect(motivoNoPuede('take', vale({ status: 'in_progress', assigned_to: OTRO }), quien({ puede_atender: true }))).toMatch(/abierto/);
  });
  it('asignar: sólo quien coordina, con el vale vivo', () => {
    expect(motivoNoPuede('assign', vale({}), quien({ puede_gestionar: true }))).toBeNull();
    expect(motivoNoPuede('assign', vale({}), quien({ puede_atender: true }))).toMatch(/coordina/);
    expect(motivoNoPuede('assign', vale({ status: 'completed' }), quien({ puede_gestionar: true }))).toMatch(/abierto o en proceso/);
  });
  it('completar: el asignado o quien coordina, y EXIGE el trabajo escrito; ninguna firma (D8b)', () => {
    const mio = vale({ status: 'in_progress', assigned_to: YO });
    expect(motivoNoPuede('complete', mio, quien())).toMatch(/trabajo/);
    expect(motivoNoPuede('complete', { ...mio, work_detail: '   ' }, quien())).toMatch(/trabajo/);
    expect(motivoNoPuede('complete', { ...mio, work_detail: 'Se cambió la chapa' }, quien())).toBeNull();
    expect(motivoNoPuede('complete', vale({ status: 'in_progress', assigned_to: OTRO, work_detail: 'x' }), quien({ puede_atender: true })))
      .toMatch(/atiende o quien coordina/);
    expect(motivoNoPuede('complete', vale({ status: 'in_progress', assigned_to: OTRO, work_detail: 'x' }), quien({ puede_gestionar: true }))).toBeNull();
    expect(motivoNoPuede('complete', vale({ status: 'cancelled', assigned_to: YO, work_detail: 'x' }), quien())).toMatch(/cerrado/);
  });
  it('cancelar: quien coordina siempre; quien lo pidió sólo mientras sigue abierto', () => {
    expect(motivoNoPuede('cancel', vale({ requested_by: YO }), quien())).toBeNull();
    expect(motivoNoPuede('cancel', vale({ requested_by: YO, status: 'in_progress', assigned_to: OTRO }), quien())).toMatch(/abierto/);
    expect(motivoNoPuede('cancel', vale({ status: 'in_progress', assigned_to: OTRO }), quien({ puede_gestionar: true }))).toBeNull();
    expect(motivoNoPuede('cancel', vale({}), quien({ puede_atender: true }))).toMatch(/coordina/);
  });
  it('reabrir: sólo cerrado y sólo quien coordina', () => {
    expect(motivoNoPuede('reopen', vale({ status: 'completed' }), quien({ puede_gestionar: true }))).toBeNull();
    expect(motivoNoPuede('reopen', vale({ status: 'completed' }), quien({ puede_atender: true }))).toMatch(/coordina/);
    expect(motivoNoPuede('reopen', vale({}), quien({ puede_gestionar: true }))).toMatch(/cerrado/);
  });
});

describe('[MDT.1.5] puedeEditarTrabajo', () => {
  it('el asignado o quien coordina, con el vale vivo; nadie más', () => {
    expect(puedeEditarTrabajo(vale({ status: 'in_progress', assigned_to: YO }), quien())).toBe(true);
    expect(puedeEditarTrabajo(vale({ status: 'in_progress', assigned_to: OTRO }), quien({ puede_atender: true }))).toBe(false);
    expect(puedeEditarTrabajo(vale({ status: 'in_progress', assigned_to: OTRO }), quien({ puede_gestionar: true }))).toBe(true);
    expect(puedeEditarTrabajo(vale({ status: 'completed', assigned_to: YO }), quien())).toBe(false);
  });
});

describe('[MDT.1.5] folioVale y validarNuevoVale', () => {
  it('el folio va a seis dígitos, como el talonario', () => {
    expect(folioVale(513)).toBe('000513');
    expect(folioVale(1234567)).toBe('1234567');
  });
  it('un vale nuevo pide área y lo que se necesita (negativas incluidas)', () => {
    expect(validarNuevoVale({ requesting_area: 'Sucursal Plaza', activity: 'Fuga en el baño' })).toBeNull();
    expect(validarNuevoVale({ requesting_area: ' ', activity: 'x' })).toMatch(/área/);
    expect(validarNuevoVale({ requesting_area: 'x', activity: '' })).toMatch(/necesita/);
    expect(validarNuevoVale({ requesting_area: 'x'.repeat(121), activity: 'y' })).toMatch(/120/);
    expect(validarNuevoVale(null)).toMatch(/área/);
  });
});
