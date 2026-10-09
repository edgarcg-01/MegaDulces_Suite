// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo NO CARGUE.
import { TITULO_CONFIDENCIAL, VIDA_URL_CONFIDENCIAL_S, VIDA_URL_NORMAL_S, contenidoDeAviso, filtrarDestinatarios, sinConfidenciales, vidaDeUrlAdjunto, type TicketParaAvisos } from './destinatarios';

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

/**
 * `[MSH.2]` Lo que NO sale de la Mesa de un ticket confidencial. Lo que se defiende:
 *  · ⛔ el aviso de un ticket confidencial NO lleva el título ni el texto del comentario (se neutraliza al ESCRIBIR);
 *  · ⛔ la URL de un adjunto confidencial vive 60 s, no 10 min;
 *  · ⛔ la Bitácora no recibe el evento de un ticket confidencial; el resto sí.
 */
describe('MSH.2 · contenidoDeAviso (H3)', () => {
  it('⭐ un ticket NORMAL conserva su título y su extracto (nada cambia para TI ni Mantenimiento)', () => {
    expect(contenidoDeAviso(false, { title: 'No abre la caja', extracto: 'ya intenté reiniciar' })).toEqual({ title: 'No abre la caja', extracto: 'ya intenté reiniciar' });
    expect(contenidoDeAviso(false, { title: 'x' })).toEqual({ title: 'x', extracto: null });
  });
  it('⛔ NEGATIVA — un ticket CONFIDENCIAL sale neutro: ni su título ni el texto del comentario', () => {
    const r = contenidoDeAviso(true, { title: 'Queja de acoso contra mi jefe', extracto: 'me amenazó con despedirme' });
    expect(r).toEqual({ title: TITULO_CONFIDENCIAL, extracto: null });
    expect(JSON.stringify(r)).not.toMatch(/acoso|despedir|jefe/i);
  });
});

describe('MSH.2 · vidaDeUrlAdjunto (H4)', () => {
  it('⭐ normal: 10 minutos de siempre', () => expect(vidaDeUrlAdjunto(false)).toBe(600));
  it('⛔ NEGATIVA — confidencial: 60 s, y MENOS que la normal', () => {
    expect(vidaDeUrlAdjunto(true)).toBe(60);
    expect(VIDA_URL_CONFIDENCIAL_S).toBeLessThan(VIDA_URL_NORMAL_S);
  });
});

describe('MSH.2 · sinConfidenciales (H9)', () => {
  const ev = (requestId: string) => ({ requestId, event: 'status' as const });
  it('⛔ NEGATIVA — el evento de un ticket confidencial NO pasa; los demás sí, en su orden', () => {
    const r = sinConfidenciales([ev('a'), ev('conf'), ev('b')], new Set(['conf']));
    expect(r.map((e) => e.requestId)).toEqual(['a', 'b']);
  });
  it('CONTROL: sin confidenciales pasa todo; y todos confidenciales → nada', () => {
    expect(sinConfidenciales([ev('a'), ev('b')], new Set())).toHaveLength(2);
    expect(sinConfidenciales([ev('a')], new Set(['a']))).toEqual([]);
  });
});
