import { buildClaimIndex, claimFueraDeAlcance, claimVerdict } from './recon-claim-key';

// El caso real (prod, 2026-11-23): el cheque de nómina de noviembre, sucursal 01, X-D-25 folio 27, cuenta 2169, quedaba
// apartado por un pareo de ENERO sin sucursal con el mismo tipo, folio y cuenta (otro documento, otro importe).
const cheque = { sucursal: '01', doc_tipo: 'X-D-25', folio: '0000027', clave: '2169', fecha: '2026-11-11' };
const deEnero = { suc: null, dt: 'X-D-25', folio: '0000027', cuenta: '2169', period: '2026-01' };

describe('[BFU.7.5] el candado sólo aparta dentro del alcance de la corrida que reclamó', () => {
  it('⛔ un pareo de enero sin sucursal ya NO aparta el documento de noviembre, y se declara', () => {
    const idx = buildClaimIndex([deEnero]);
    expect(claimVerdict(idx, cheque)).toBeNull();
    expect(claimFueraDeAlcance(idx, cheque)).toBe(true);
  });
  it('[positiva] dentro del alcance sigue bloqueando, con y sin sucursal', () => {
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: '2026-11' }]), cheque)).toBe('parcial');
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: '2026-10' }]), cheque)).toBe('parcial');
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, suc: '01', period: '2026-10' }]), cheque)).toBe('exacta');
    expect(claimFueraDeAlcance(buildClaimIndex([{ ...deEnero, period: '2026-11' }]), cheque)).toBe(false);
  });
  it('la ventana es [día 1 − 45, día 1 del mes siguiente + 45): bordes exactos', () => {
    const idx = buildClaimIndex([{ ...deEnero, period: '2026-10' }]);
    const en = (fecha: string) => claimVerdict(idx, { ...cheque, fecha });
    expect(en('2026-08-17')).toBe('parcial'); // 1-oct − 45
    expect(en('2026-08-16')).toBeNull();
    expect(en('2026-12-15')).toBe('parcial'); // 1-nov + 45 = 16-dic, abierto
    expect(en('2026-12-16')).toBeNull();
  });
  it('con varias corridas sobre la misma llave, basta una que alcance', () => {
    expect(claimVerdict(buildClaimIndex([deEnero, { ...deEnero, period: '2026-11' }]), cheque)).toBe('parcial');
  });
  it('⛔ ante la duda se bloquea: reclamación sin periodo, o documento sin fecha', () => {
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: null }]), cheque)).toBe('parcial');
    expect(claimVerdict(buildClaimIndex([deEnero]), { ...cheque, fecha: null })).toBe('parcial');
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: 'basura' }]), cheque)).toBe('parcial');
  });
  it('la fecha puede llegar como Date (pg) sin correrse por la zona horaria', () => {
    const idx = buildClaimIndex([{ ...deEnero, period: '2026-10' }]);
    expect(claimVerdict(idx, { ...cheque, fecha: new Date(2026, 11, 15) })).toBe('parcial');
    expect(claimVerdict(idx, { ...cheque, fecha: new Date(2026, 11, 16) })).toBeNull();
  });
  it('el alcance es un parámetro (el servicio pasa su OVERLAP_DAYS)', () => {
    // agosto: con 45 días llega al 15-oct; con 90, al 29-nov.
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: '2026-08' }], 45), cheque)).toBeNull();
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, period: '2026-08' }], 90), cheque)).toBe('parcial');
  });
  it('[CB.51] lo de antes no cambia: otra sucursal u otra cuenta no bloquean', () => {
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, suc: '00', period: '2026-11' }]), cheque)).toBeNull();
    expect(claimVerdict(buildClaimIndex([{ ...deEnero, cuenta: '4166', period: '2026-11' }]), cheque)).toBeNull();
    expect(claimFueraDeAlcance(buildClaimIndex([{ ...deEnero, cuenta: '4166' }]), cheque)).toBe(false);
  });
});
