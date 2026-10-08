// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { filtrarDestinatarios, type TicketParaAvisos } from './destinatarios';

/**
 * `[MS.7.13]` «Nadie fuera de la cola recibe el aviso». Lo que se defiende:
 *  · ⛔ alguien que no es de la cola, ni reportó el ticket, ni lo tiene asignado, NO recibe el aviso;
 *  · quien reportó SIEMPRE puede recibirlo (aunque no sea de la cola), y quien lo tiene asignado también (aunque entre por god-mode);
 *  · un miembro de la cola sí;
 *  · lo descartado se devuelve aparte (un descarte es un cálculo de destinatarios que falló: debe dejar rastro).
 */
const T = (over: Partial<TicketParaAvisos> = {}): TicketParaAvisos => ({ requesterId: 'u-ana', assignedTo: 'u-tec', miembrosDeLaCola: new Set(['u-jefe', 'u-tec']), ...over });

describe('MS.7.13 · filtrarDestinatarios', () => {
  it('⭐ los miembros de la cola, quien reportó y quien lo tiene asignado pasan', () => {
    const r = filtrarDestinatarios(['u-jefe', 'u-tec', 'u-ana'], T());
    expect(r.permitidos).toEqual(['u-jefe', 'u-tec', 'u-ana']);
    expect(r.descartados).toEqual([]);
  });

  it('⛔ NEGATIVA — alguien de OTRA cola (que no reportó ni tiene asignado) NO recibe el aviso', () => {
    const r = filtrarDestinatarios(['u-jefe', 'u-de-ti'], T());
    expect(r.permitidos).toEqual(['u-jefe']);
    expect(r.descartados).toEqual(['u-de-ti']);
  });

  it('⭐ quien reportó recibe su aviso aunque NO sea de la cola (así es como se entera de que se resolvió)', () => {
    expect(filtrarDestinatarios(['u-ana'], T({ miembrosDeLaCola: new Set() })).permitidos).toEqual(['u-ana']);
  });

  it('⭐ quien lo tiene asignado lo recibe aunque no sea miembro (god-mode asignándose el ticket)', () => {
    expect(filtrarDestinatarios(['u-dios'], T({ assignedTo: 'u-dios', miembrosDeLaCola: new Set(['u-jefe']) })).permitidos).toEqual(['u-dios']);
  });

  it('⛔ NEGATIVA — sin asignado, «null» no se confunde con una persona: nadie pasa por ser «el asignado»', () => {
    const r = filtrarDestinatarios(['null', 'undefined', ''], T({ assignedTo: null, miembrosDeLaCola: new Set() }));
    expect(r.permitidos).toEqual([]);
    expect(r.descartados).toHaveLength(3);
  });

  it('⛔ NEGATIVA — una cola sin miembros no avisa a nadie del equipo (sólo a quien reportó)', () => {
    const r = filtrarDestinatarios(['u-jefe', 'u-tec', 'u-ana'], T({ assignedTo: null, miembrosDeLaCola: new Set() }));
    expect(r.permitidos).toEqual(['u-ana']);
    expect(r.descartados).toEqual(['u-jefe', 'u-tec']);
  });

  it('conserva el orden y no inventa ni repite destinatarios', () => {
    const r = filtrarDestinatarios(['u-tec', 'u-x', 'u-jefe'], T());
    expect(r.permitidos).toEqual(['u-tec', 'u-jefe']);
    expect([...r.permitidos, ...r.descartados].sort()).toEqual(['u-jefe', 'u-tec', 'u-x']);
  });
});
