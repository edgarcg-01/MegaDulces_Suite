import { describe, expect, it } from 'vitest';
import { SIN_COLAS, TODAS_LAS_COLAS, accesoATicket, colasDeLectura, construirAcceso, puedeAtenderCola, puedeCoordinarCola } from './queue-access';

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
