import { SIN_COLAS, TODAS_LAS_COLAS, accesoATicket, colasDeLectura, construirAcceso, esMiembroDeCola, puedeAdministrarCola, puedeLiberarConfidencialHuerfana, puedeMarcarConfidencial, puedeAtenderCola, puedeCoordinarCola } from './queue-access';

const TI = 'q-ti';
const MTO = 'q-mto';
const yo = (colas = SIN_COLAS) => ({ userId: 'u-1', colas });
const ticket = (queue_id: string, requester_id = 'u-otro', confidential?: boolean) => ({ queue_id, requester_id, confidential });

describe('`[MS.7.6]` construirAcceso — capacidad ∩ pertenencia', () => {
  it('⭐ un técnico de Mantenimiento atiende Mantenimiento y NO TI', () => {
    const a = construirAcceso({ god: false, esAgente: true, esCoordinador: false, membresias: [{ queue_id: MTO, role: 'tecnico' }] });
    expect(puedeAtenderCola(a, MTO)).toBe(true);
    expect(puedeAtenderCola(a, TI)).toBe(false);
  });
  it('coordina sólo donde es miembro con rol coordinador Y tiene la clave de coordinar', () => {
    const m = [{ queue_id: TI, role: 'coordinador' as const }, { queue_id: MTO, role: 'tecnico' as const }];
    const a = construirAcceso({ god: false, esAgente: true, esCoordinador: true, membresias: m });
    expect(puedeCoordinarCola(a, TI)).toBe(true);
    expect(puedeCoordinarCola(a, MTO)).toBe(false); // miembro, pero técnico
    expect(puedeAtenderCola(a, MTO)).toBe(true);
  });
  it('⛔ la pertenencia SOLA no basta: sin la clave de atender no se atiende nada', () => {
    const a = construirAcceso({ god: false, esAgente: false, esCoordinador: false, membresias: [{ queue_id: TI, role: 'coordinador' }] });
    expect(puedeAtenderCola(a, TI)).toBe(false);
    expect(puedeCoordinarCola(a, TI)).toBe(false);
  });
  it('⛔ la clave SOLA no basta: sin pertenencia no se ve ninguna cola (el cambio de fondo)', () => {
    const a = construirAcceso({ god: false, esAgente: true, esCoordinador: true, membresias: [] });
    expect(puedeAtenderCola(a, TI)).toBe(false);
    expect(colasDeLectura(a)).toEqual([]);
  });
  it('⛔ rol coordinador sin la clave de coordinar tampoco coordina (la clave manda)', () => {
    const a = construirAcceso({ god: false, esAgente: true, esCoordinador: false, membresias: [{ queue_id: TI, role: 'coordinador' }] });
    expect(puedeCoordinarCola(a, TI)).toBe(false);
  });
  it('el god-mode puede todo y su lectura no se acota', () => {
    const a = construirAcceso({ god: true, esAgente: true, esCoordinador: true, membresias: [] });
    expect(a).toBe(TODAS_LAS_COLAS);
    expect(puedeAtenderCola(a, MTO) && puedeCoordinarCola(a, TI)).toBe(true);
    expect(colasDeLectura(a)).toBeNull();
  });
  it('colasDeLectura devuelve las colas de la persona', () => {
    const a = construirAcceso({ god: false, esAgente: true, esCoordinador: true, membresias: [{ queue_id: TI, role: 'coordinador' }, { queue_id: MTO, role: 'tecnico' }] });
    expect(colasDeLectura(a)?.sort()).toEqual([MTO, TI]);
    expect(colasDeLectura(a, 'coordina')).toEqual([TI]);
  });
});

describe('`[MS.7.6]` accesoATicket', () => {
  const tecnicoMto = construirAcceso({ god: false, esAgente: true, esCoordinador: false, membresias: [{ queue_id: MTO, role: 'tecnico' }] });
  it('⭐ quien atiende la cola del ticket lo ve completo; el de otra cola, nada', () => {
    expect(accesoATicket(yo(tecnicoMto), ticket(MTO))).toBe('completo');
    expect(accesoATicket(yo(tecnicoMto), ticket(TI))).toBe('ninguno');
  });
  it('el solicitante ve SU ticket aunque no atienda nada', () => {
    expect(accesoATicket(yo(), ticket(TI, 'u-1'))).toBe('completo');
    expect(accesoATicket(yo(), ticket(TI, 'u-2'))).toBe('ninguno');
  });
  it('el god-mode ve todo lo no confidencial', () => {
    expect(accesoATicket(yo(TODAS_LAS_COLAS), ticket(MTO))).toBe('completo');
  });
  it('⛔ (hueco de RH) un ticket confidencial: el god-mode sólo ve lo BÁSICO, el miembro lo ve completo, el resto nada', () => {
    const miembro = construirAcceso({ god: false, esAgente: true, esCoordinador: true, membresias: [{ queue_id: 'q-rh', role: 'coordinador' }] });
    expect(accesoATicket(yo(TODAS_LAS_COLAS), ticket('q-rh', 'u-9', true))).toBe('basico');
    expect(accesoATicket(yo(miembro), ticket('q-rh', 'u-9', true))).toBe('completo');
    expect(accesoATicket(yo(tecnicoMto), ticket('q-rh', 'u-9', true))).toBe('ninguno');
    expect(accesoATicket(yo(), ticket('q-rh', 'u-1', true))).toBe('completo'); // su propio ticket
  });
});

/**
 * `[MSH.2]` H1: el god-mode NO administra una cola confidencial (podría agregarse como miembro y leerlo todo). Sólo su coordinación.
 */
describe('MSH.2 · puedeAdministrarCola', () => {
  const COLA = 'q-rh';
  const god = { todas: true, atiende: new Set<string>(), coordina: new Set<string>() };
  const coord = { todas: false, atiende: new Set([COLA]), coordina: new Set([COLA]) };
  const tecnico = { todas: false, atiende: new Set([COLA]), coordina: new Set<string>() };
  const otra = { todas: false, atiende: new Set(['q-ti']), coordina: new Set(['q-ti']) };

  it('⭐ una cola NORMAL la administra su coordinación o el god-mode (como siempre)', () => {
    expect(puedeAdministrarCola(coord, COLA, false)).toBe(true);
    expect(puedeAdministrarCola(god, COLA, false)).toBe(true);
  });
  it('⛔ NEGATIVA — una cola CONFIDENCIAL NO la administra el god-mode (H1)', () => {
    expect(puedeAdministrarCola(god, COLA, true)).toBe(false);
  });
  it('⭐ CONTROL: una cola confidencial SÍ la administra su coordinación', () => {
    expect(puedeAdministrarCola(coord, COLA, true)).toBe(true);
  });
  it('⛔ ni un técnico de la cola ni la coordinación de OTRA cola, normal o confidencial', () => {
    for (const c of [tecnico, otra]) for (const conf of [false, true]) expect(puedeAdministrarCola(c, COLA, conf)).toBe(false);
  });
});

/** `[MS.8.2]` Una cola confidencial sin coordinación quedaba trabada para siempre (Mantenimiento, 2026-11-10). */
describe('MS.8.2 · cola confidencial huérfana', () => {
  const god = { todas: true, atiende: new Set<string>(), coordina: new Set<string>() };
  const coord = { todas: false, atiende: new Set(['q']), coordina: new Set(['q']) };
  const huerfana = { coordinadores: 0, solicitudes: 0 };

  it('⭐ el god-mode puede QUITAR la marca de una confidencial sin coordinación ni solicitudes', () => {
    expect(puedeLiberarConfidencialHuerfana(god, huerfana, { confidential: false })).toBe(true);
  });
  it('⛔ NEGATIVA — con solicitudes NO (hay contenido confidencial que proteger)', () => {
    expect(puedeLiberarConfidencialHuerfana(god, { coordinadores: 0, solicitudes: 1 }, { confidential: false })).toBe(false);
  });
  it('⛔ NEGATIVA — con coordinación NO (la administra ella, como siempre)', () => {
    expect(puedeLiberarConfidencialHuerfana(god, { coordinadores: 1, solicitudes: 0 }, { confidential: false })).toBe(false);
  });
  it('⛔ NEGATIVA — sólo quitar la marca: ni ponerla, ni cambiar otra cosa junto', () => {
    expect(puedeLiberarConfidencialHuerfana(god, huerfana, { confidential: true })).toBe(false);
    expect(puedeLiberarConfidencialHuerfana(god, huerfana, { active: true })).toBe(false);
    expect(puedeLiberarConfidencialHuerfana(god, huerfana, { confidential: false, active: true })).toBe(false);
  });
  it('⛔ NEGATIVA — quien no es god-mode, no', () => {
    expect(puedeLiberarConfidencialHuerfana(coord, huerfana, { confidential: false })).toBe(false);
  });
  it('⭐ marcar confidencial exige coordinación; CONTROL: con coordinación sí', () => {
    expect(puedeMarcarConfidencial({ coordinadores: 0 })).toBe(false);
    expect(puedeMarcarConfidencial({ coordinadores: 1 })).toBe(true);
  });
});

/** `[MSH.2]` H7 — levantar a nombre de OTRA persona hacia una cola confidencial: sólo un MIEMBRO de esa cola. */
describe('MSH.2 · esMiembroDeCola', () => {
  const COLA = 'q-rh';
  const god = { todas: true, atiende: new Set<string>(), coordina: new Set<string>() };
  const coord = { todas: false, atiende: new Set([COLA]), coordina: new Set([COLA]) };
  const tecnico = { todas: false, atiende: new Set([COLA]), coordina: new Set<string>() };
  const otra = { todas: false, atiende: new Set(['q-ti']), coordina: new Set(['q-ti']) };
  it('⭐ el técnico y la coordinación de la cola son miembros', () => {
    expect(esMiembroDeCola(tecnico, COLA)).toBe(true);
    expect(esMiembroDeCola(coord, COLA)).toBe(true);
  });
  it('⛔ NEGATIVA — el god-mode NO es miembro de nada (a diferencia de puedeAtenderCola)', () => {
    expect(esMiembroDeCola(god, COLA)).toBe(false);
    expect(puedeAtenderCola(god, COLA)).toBe(true);
  });
  it('⛔ NEGATIVA — quien coordina OTRA cola tampoco', () => {
    expect(esMiembroDeCola(otra, COLA)).toBe(false);
  });
});
