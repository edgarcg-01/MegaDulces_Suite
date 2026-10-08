/**
 * `[CG.68]` Candados del emparejamiento PC ↔ teléfono.
 *
 * ⚠️ NO importar nada de `vitest`: los specs hermanos de esta carpeta usan los globales y el
 * import rompe la corrida entera. Ya costó una vez en `caja-caos-ingreso.engine.spec.ts`.
 *
 * ── ⛔⛔ Por qué estas pruebas se reescribieron ──────────────────────────────────────────────
 *
 * La versión anterior probaba un `Map` en memoria y pasaba **18 de 18** — sobre un diseño que en
 * producción estaba roto la mitad de las veces, porque `api` corre con **2 réplicas** y el mapa
 * vive en UN proceso. Las pruebas eran correctas y el diseño no: una suite verde no mide si el
 * sustrato es el que creés.
 *
 * Ahora el emparejamiento vive en las rooms de Socket.IO (compartidas entre pods por el
 * adaptador de Redis) y lo único del servidor es una DECISIÓN. Eso es lo que se prueba: dada la
 * foto de los sockets de la room, qué se puede y qué no. El reloj se inyecta — una prueba que
 * espera tres minutos no la corre nadie.
 */
import {
  decidirTomar, decidirEntregar, nuevoCodigo, normalizarCodigo, roomDeFirma,
  firmaSigueValiendo, VIDA_MS, type SocketEnRoom, type MarcaPc,
} from './caja-firma-remota.engine';
import type { ContextoFirma } from '@megadulces/contracts';

const T1 = '00000000-0000-0000-0000-00000000d01c';
const T2 = '11111111-1111-1111-1111-111111111111';
const AHORA = 1_000_000;
const CTX: ContextoFirma = {
  tipo: 'gasto', monto: 1900, beneficiario: 'JUAN PEREZ', documento: 'X-D-26 0001294',
};

const marca = (codigo: string, creado = AHORA): MarcaPc => ({ codigo, ctx: CTX, creado });
/** La PC esperando en la room. */
const pc = (codigo: string, tenantId = T1, creado = AHORA, id = 'pc-1'): SocketEnRoom =>
  ({ id, tenantId, pc: marca(codigo, creado) });
/** El teléfono que ya reclamó. */
const tel = (codigo: string, tenantId = T1, id = 'tel-1'): SocketEnRoom =>
  ({ id, tenantId, telefono: codigo });

describe('nuevoCodigo y normalizarCodigo · [CG.68]', () => {
  it('usa un alfabeto SIN caracteres ambiguos', () => {
    // Quien lo teclea lo lee de otra pantalla, a veces de lejos. Un 0 leído como O es un código
    // que "no funciona" y nadie sabe por qué.
    const muchos = Array.from({ length: 200 }, () => nuevoCodigo()).join('');
    for (const malo of ['0', 'O', '1', 'I', 'L']) {
      expect(muchos.includes(malo), `el alfabeto trae ${malo}`).toBe(false);
    }
  });

  it('mide 6 y es determinista con un azar dado', () => {
    const cero = () => 0;
    expect(nuevoCodigo(cero)).toBe('AAAAAA');
    expect(nuevoCodigo(cero)).toBe('AAAAAA');
  });

  it('lo tecleado llega como venga: minúsculas, espacios, guiones', () => {
    expect(normalizarCodigo(' p7k-3 mq ')).toBe('P7K3MQ');
    expect(normalizarCodigo(null)).toBe('');
  });
});

describe('roomDeFirma · [CG.68]', () => {
  it('la room es de DOS, no la del tenant', () => {
    // ⛔ Es el punto de todo el emparejamiento. Con la room del tenant, la firma de un cajero
    // aparece en la pantalla del otro — y es evidencia de quién recibió efectivo.
    expect(roomDeFirma(T1, 'P7K3MQ')).toBe(`firma:${T1}:P7K3MQ`);
    expect(roomDeFirma(T1, 'P7K3MQ')).not.toBe(`tenant:${T1}`);
  });

  it('dos cajas a la vez NO comparten room', () => {
    expect(roomDeFirma(T1, 'AAAAAA')).not.toBe(roomDeFirma(T1, 'BBBBBB'));
    // Y el tenant va en el nombre: el mismo código en dos empresas son dos rooms.
    expect(roomDeFirma(T1, 'AAAAAA')).not.toBe(roomDeFirma(T2, 'AAAAAA'));
  });
});

describe('decidirTomar · [CG.68]', () => {
  it('con la PC esperando, el teléfono reclama y recibe el contexto MÍNIMO', () => {
    const r = decidirTomar([pc('ABC234')], 'ABC234', T1, AHORA);
    expect(r.ok).toBe(true);
    expect(r.v?.ctx).toEqual(CTX);
  });

  it('acepta el código tecleado sucio', () => {
    expect(decidirTomar([pc('ABC234')], ' abc-234 ', T1, AHORA).ok).toBe(true);
  });

  it('⛔ [negativa] sin PC esperando, no existe', () => {
    // O se tecleó mal, o la caja ya cerró el pedido. Las dos se arreglan igual.
    const r = decidirTomar([], 'ABC234', T1, AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('no_existe');
  });

  it('⛔ [negativa] UN SOLO USO: el segundo teléfono no entra', () => {
    // Si el código siguiera vivo, un segundo teléfono entraría a la misma room y vería el
    // contexto del efectivo.
    const r = decidirTomar([pc('ABC234'), tel('ABC234')], 'ABC234', T1, AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('ya_tomado');
  });

  it('⛔⛔ [negativa] un código de OTRO tenant no se reclama', () => {
    // El JWT ya separa los tenants, pero el código es un identificador global: sin esta
    // comparación bastaría acertar seis caracteres para mirar el efectivo de otra empresa.
    const r = decidirTomar([pc('ABC234', T1)], 'ABC234', T2, AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('otro_tenant');
  });

  it('⭐ [negativa] VENCIDO no es lo mismo que NO EXISTE', () => {
    // Las dos ausencias piden acciones distintas: «pedí uno nuevo» contra «revisá lo que
    // escribiste». La primera versión de este motor las colapsaba en una porque purgaba antes
    // de buscar, y lo encontró su propia prueba.
    const r = decidirTomar([pc('ABC234', T1, AHORA - VIDA_MS - 1)], 'ABC234', T1, AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('vencido');
    expect(r.fallo).not.toBe('no_existe');
  });

  it('justo ANTES de vencer todavía sirve', () => {
    // Sin esta, la vida podría ser cero y la de arriba seguiría pasando.
    const r = decidirTomar([pc('ABC234', T1, AHORA - VIDA_MS + 1)], 'ABC234', T1, AHORA);
    expect(r.ok).toBe(true);
  });

  it('⛔ [negativa] el código de OTRA caja no sirve, aunque esté en la foto', () => {
    // Si la foto trae dos emparejamientos (no debería, pero la decisión no puede confiar en
    // eso), se resuelve por código y no por "el primero que haya".
    const r = decidirTomar([pc('AAAAAA', T1, AHORA, 'pc-A'), pc('BBBBBB', T1, AHORA, 'pc-B')],
      'BBBBBB', T1, AHORA);
    expect(r.ok).toBe(true);
    expect(r.v?.codigo).toBe('BBBBBB');
  });
});

describe('decidirEntregar · [CG.68]', () => {
  const foto = [pc('ABC234'), tel('ABC234')];

  it('el teléfono que reclamó puede entregar', () => {
    const r = decidirEntregar(foto, 'ABC234', T1, 'tel-1', AHORA);
    expect(r.ok).toBe(true);
    expect(r.v?.ctx.monto).toBe(1900);
  });

  it('⛔ [negativa] otro teléfono NO puede entregar', () => {
    const r = decidirEntregar(foto, 'ABC234', T1, 'tel-2', AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('no_es_suyo');
  });

  it('⛔⛔ [negativa] alguien que SÍ está en la room pero no es el teléfono tampoco entrega', () => {
    // ⭐ Esta prueba existe porque la anterior NO alcanzaba, y lo descubrió una mutación: con
    // `tel-2` —que ni está en la foto— cambiar la condición a `if (!yo)` dejaba la suite VERDE
    // y permitía que CUALQUIER socket de la room entregara la firma. El caso peligroso no es el
    // desconocido: es el que ya está adentro.
    expect(decidirEntregar(foto, 'ABC234', T1, 'pc-1', AHORA).fallo).toBe('no_es_suyo');

    // Y un tercero que se colara a la room, tampoco.
    const conMirón: SocketEnRoom[] = [...foto, { id: 'miron', tenantId: T1 }];
    expect(decidirEntregar(conMirón, 'ABC234', T1, 'miron', AHORA).fallo).toBe('no_es_suyo');
  });

  it('⛔ [negativa] entregar sin haber reclamado no se puede', () => {
    const r = decidirEntregar([pc('ABC234')], 'ABC234', T1, 'tel-1', AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('no_es_suyo');
  });

  it('⭐ [negativa] si la CAJA se fue, el fallo es "sin_pc", no "no_existe"', () => {
    // El teléfono hizo todo bien y la caja cerró. Decirle «ese código no existe» lo mandaría a
    // revisar lo que tecleó, que está perfecto. Tres ausencias, tres mensajes.
    const r = decidirEntregar([tel('ABC234')], 'ABC234', T1, 'tel-1', AHORA);
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('sin_pc');
  });

  it('⛔ [negativa] vencido tampoco entrega', () => {
    const viejo = [pc('ABC234', T1, AHORA - VIDA_MS - 1), tel('ABC234')];
    expect(decidirEntregar(viejo, 'ABC234', T1, 'tel-1', AHORA).fallo).toBe('vencido');
  });

  it('⛔ [negativa] el teléfono de OTRA caja no entrega en esta', () => {
    // El escenario que motiva todo: dos cajeros capturando al mismo tiempo.
    const fotoB = [pc('BBBBBB', T1, AHORA, 'pc-B'), tel('BBBBBB', T1, 'tel-B')];
    expect(decidirEntregar(fotoB, 'BBBBBB', T1, 'tel-A', AHORA).fallo).toBe('no_es_suyo');
  });
});

describe('firmaSigueValiendo · [CG.68]', () => {
  it('⭐ si el monto cambió DESPUÉS de firmar, la firma dejó de corresponder', () => {
    // Sin esto, el cajero cambia el importe y la pantalla sigue diciendo «firmado» sobre otra
    // cifra: una firma válida pegada a un número que nadie aceptó. Con lapicera no pasa, porque
    // el papel ya estaba impreso.
    expect(firmaSigueValiendo(1900, 1900)).toBe(true);
    expect(firmaSigueValiendo(1900, 1900.004)).toBe(true);   // al centavo
    expect(firmaSigueValiendo(1900, 1901)).toBe(false);
    expect(firmaSigueValiendo(1900, 0)).toBe(false);
  });

  it('⛔ [negativa] con un monto que no es número, NO vale', () => {
    // Fallar cerrado: ante la duda la firma no cuenta, nunca al revés.
    expect(firmaSigueValiendo(NaN, 1900)).toBe(false);
    expect(firmaSigueValiendo(1900, Number('x'))).toBe(false);
    expect(firmaSigueValiendo(Infinity, Infinity)).toBe(false);
  });
});
