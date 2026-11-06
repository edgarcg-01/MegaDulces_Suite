import { explicacionKepler, lecturaKepler, solicitudKepler, type KeplerDelVale } from './ejercicio.contract';

const k = (estado: KeplerDelVale['estado'], suite: KeplerDelVale['suite'] = null): KeplerDelVale =>
  ({ solicitud: 'XA1501-0010750', estado, suite });
const suite = (resultado: 'escrito' | 'ya_estaba' | 'no_escrito'): KeplerDelVale['suite'] =>
  ({ resultado, at: '2026-11-06T21:00:00Z', nota: null, firmo: 'Ana' });

describe('[PGP.79] solicitudKepler — para ubicarla, en cualquier estado', () => {
  it('XA1501-<folio> aunque esté en N; null sin folio', () => {
    expect(solicitudKepler('0010750')).toBe('XA1501-0010750');
    expect(solicitudKepler('  ')).toBeNull();
    expect(solicitudKepler(null)).toBeNull();
  });
});

describe('[PGP.79] lecturaKepler — lo que dice la pastilla del renglón', () => {
  it('autorizada por la Suite se distingue de la que autorizaron en Kepler', () => {
    expect(lecturaKepler(k('A', suite('escrito')), 'validada')).toEqual({ texto: 'Kepler: autorizada por la Suite', tono: 'ok' });
    expect(lecturaKepler(k('A', suite('ya_estaba')), 'validada')).toEqual({ texto: 'Kepler: autorizada', tono: 'ok' });
    expect(lecturaKepler(k('A'), 'recibida')).toEqual({ texto: 'Kepler: autorizada', tono: 'ok' });
  });
  it('aplicada (el dinero salió) es verde', () => {
    expect(lecturaKepler(k('F'), 'validada').tono).toBe('ok');
  });
  it('⛔ lo que la Suite no pudo escribir manda: rojo, aunque Kepler siga en N', () => {
    expect(lecturaKepler(k('N', suite('no_escrito')), 'validada')).toEqual({ texto: 'Kepler: no se pudo autorizar', tono: 'bad' });
  });
  it('si después la autorizaron allá, el «no se pudo» ya no es lo que importa', () => {
    expect(lecturaKepler(k('A', suite('no_escrito')), 'validada').tono).toBe('ok');
  });
  it('N: neutro mientras espera firma; aviso si ya se aprobó aquí y no llegó a Kepler', () => {
    expect(lecturaKepler(k('N'), 'recibida').tono).toBe('neutro');
    expect(lecturaKepler(k('N'), 'aprobada').tono).toBe('warn');
  });
  it('cancelada en Kepler es rojo', () => {
    expect(lecturaKepler(k('C'), 'recibida')).toEqual({ texto: 'Kepler: cancelada', tono: 'bad' });
  });
  it('el detalle dice quién y cuándo cuando la autorizó la Suite, y qué hacer cuando no pudo', () => {
    expect(explicacionKepler(k('A', suite('escrito')), 'validada', '06/11/26 15:00')).toBe('La Suite la autorizó en Kepler al aprobar el 06/11/26 15:00 · firmó Ana.');
    const fallo = { ...k('N'), suite: { resultado: 'no_escrito' as const, at: null, nota: 'Kepler (00) no respondió', firmo: 'Ana' } };
    expect(explicacionKepler(fallo, 'validada', null)).toMatch(/no pudo autorizarla en Kepler: Kepler \(00\) no respondió\. Autorízala en Kepler/);
    expect(explicacionKepler({ ...k('A'), suite: { resultado: 'ya_estaba', at: null, nota: 'Kepler ya la tenía en F', firmo: null } }, 'validada', null)).toMatch(/ya la tenía aplicada/);
    expect(explicacionKepler(k('N'), 'recibida', null)).toBe('Al aprobar, la Suite la autoriza en Kepler.');
    expect(explicacionKepler(k('C'), 'recibida', null)).toMatch(/aprobar aquí no la autoriza allá/);
    expect(explicacionKepler(k(null), 'recibida', null)).toMatch(/no se puede decir/);
  });
  it('⛔ fuera de la vista NO se dice «sin autorizar»: se dice sin medir', () => {
    expect(lecturaKepler(k(null), 'recibida')).toEqual({ texto: 'Kepler: sin medir', tono: 'neutro' });
    expect(lecturaKepler(null, 'recibida').texto).toBe('Kepler: sin folio');
  });
});
