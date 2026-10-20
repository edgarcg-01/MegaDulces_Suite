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
  hayQueFrenar, TOPE_INTENTOS,
  firmaSigueValiendo, VIDA_MS, type SocketEnRoom, type MarcaPc, CLAVE_PASE, esPaseDeFirma,
  avisoAlDesconectar,
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

  /**
   * `[CG.83]` El default SIN inyección tiene que ser el generador criptográfico.
   *
   * ⚠️ No se puede "ver" qué función se usó, así que se mide el EFECTO que distingue a las dos:
   * `Math.random` sembrado no existe en V8, pero sí se puede medir que el default **no es
   * determinista** y que **no repite** — un generador roto (o uno clavado en una constante, que
   * es el error de dedo probable al tocar esta función) falla las dos.
   */
  it('⭐ [CG.83] sin inyectar, el código NO se repite — el default no es un valor fijo', () => {
    const n = 500;
    const vistos = new Set(Array.from({ length: n }, () => nuevoCodigo()));
    // Con 31^6 combinaciones, 500 sorteos repitiendo alguno tiene probabilidad ~1 en 7 millones.
    expect(vistos.size, 'el generador por defecto repitió: no está sorteando').toBe(n);
  });

  it('⛔ [negativa] el azar INYECTADO sigue mandando sobre el default', () => {
    // Si el default pisara a la inyección, las pruebas de los hermanos dejarían de ser
    // deterministas y nadie se enteraría hasta que una fallara al azar.
    expect(nuevoCodigo(() => 0)).toBe('AAAAAA');
  });
});

describe('hayQueFrenar · [CG.83] el tope de tanteo', () => {
  it('deja pasar mientras queden intentos', () => {
    for (let i = 0; i < TOPE_INTENTOS; i++) {
      expect(hayQueFrenar(i), `con ${i} fallos no debería frenar`).toBe(false);
    }
  });

  it('⛔ frena AL llegar al tope, no después', () => {
    expect(hayQueFrenar(TOPE_INTENTOS)).toBe(true);
    expect(hayQueFrenar(TOPE_INTENTOS + 10)).toBe(true);
  });

  it('un socket nuevo (sin contador) arranca libre', () => {
    // `undefined` es el caso real: `client.data.intentosFirma` no existe hasta el primer fallo.
    // Tratarlo como "ya falló" cortaría a todo el mundo en su primer intento.
    expect(hayQueFrenar(undefined)).toBe(false);
    expect(hayQueFrenar(0)).toBe(false);
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

describe('esPaseDeFirma · [CG.84] el pase que reemplaza al login', () => {
  const bueno = { k: CLAVE_PASE, t: '00000000-0000-0000-0000-00000000d01c', c: 'A2B3C4' };

  it('un pase bien formado pasa', () => {
    expect(esPaseDeFirma(bueno)).toBe(true);
    // El codigo se normaliza antes de medirlo: minusculas y guiones entran igual.
    expect(esPaseDeFirma({ ...bueno, c: 'a2b-3c4' })).toBe(true);
  });

  it('⛔⛔ [negativa] un TOKEN DE SESION valido NO sirve como pase', () => {
    // Esta es LA prueba de la fase. `jwtService.verify()` prueba que la firma es nuestra y que no
    // vencio -- lo que NO prueba es que el payload sea un pase. Sin esta comprobacion, cualquier
    // JWT de sesion valido entraria como invitado a una room de firma, que es exactamente el
    // agujero que el pase viene a cerrar.
    const sesion = {
      sub: 'u1', username: 'edgar', tenant_id: '00000000-0000-0000-0000-00000000d01c',
      role_name: 'superadmin', permissions: { FINANCE_CAJA_GESTIONAR: true },
    };
    expect(esPaseDeFirma(sesion)).toBe(false);
  });

  it('⛔ [negativa] sin la marca, o con otra marca, NO es pase', () => {
    expect(esPaseDeFirma({ t: bueno.t, c: bueno.c })).toBe(false);
    expect(esPaseDeFirma({ ...bueno, k: 'otra-cosa' })).toBe(false);
    expect(esPaseDeFirma({ ...bueno, k: '' })).toBe(false);
  });

  it('⛔ [negativa] sin tenant no hay room que calcular', () => {
    expect(esPaseDeFirma({ ...bueno, t: '' })).toBe(false);
    expect(esPaseDeFirma({ ...bueno, t: undefined })).toBe(false);
    expect(esPaseDeFirma({ ...bueno, t: 123 })).toBe(false);
  });

  it('⛔ [negativa] el codigo tiene que ser un codigo de verdad', () => {
    // Largo distinto = no es uno de los nuestros. Un pase con el codigo vacio entraria a la room
    // `firma:<tenant>:` -- una room que podria compartir con otro pase igual de roto.
    expect(esPaseDeFirma({ ...bueno, c: '' })).toBe(false);
    expect(esPaseDeFirma({ ...bueno, c: 'A2B3C' })).toBe(false);      // 5
    expect(esPaseDeFirma({ ...bueno, c: 'A2B3C4D' })).toBe(false);    // 7
    expect(esPaseDeFirma({ ...bueno, c: '------' })).toBe(false);     // normaliza a vacio
  });

  it('⛔ [negativa] nada que no sea un objeto', () => {
    expect(esPaseDeFirma(null)).toBe(false);
    expect(esPaseDeFirma(undefined)).toBe(false);
    expect(esPaseDeFirma('A2B3C4')).toBe(false);
    expect(esPaseDeFirma(42)).toBe(false);
  });
});

/**
 * ⭐⭐ `[CG.196]` **Bloquear el teléfono no puede perder la firma.**
 *
 * Reportado por Edgar el 2026-10-20: *«el token de la firma caduca muy rápido, o si se bloquea el
 * teléfono se pierde»*. Eran DOS cosas y sólo una era un parámetro.
 */
describe('[CG.196] quién se fue decide si la firma sigue viva', () => {
  it('se va la PC → se corta: su marca se fue con ella', () => {
    expect(avisoAlDesconectar({ firma: { codigo: 'ABC234' } }))
      .toEqual({ evento: 'firma:cortada', codigo: 'ABC234' });
  });

  it('⛔ PRUEBA NEGATIVA: se va el TELÉFONO → NO se corta', () => {
    // Éste es el defecto exacto. El gateway hacía `firma?.codigo ?? firmaTel` y emitía
    // `firma:cortada` para las dos puntas, así que una pantalla bloqueada destruía el
    // emparejamiento: la PC lo oía, desarmaba el panel y mandaba `firma:cerrar` al servidor.
    const r = avisoAlDesconectar({ firmaTel: 'ABC234' });
    expect(r).toEqual({ evento: 'firma:telefono_salio', codigo: 'ABC234' });
    // Lo que de verdad importa, dicho como aserción y no como comentario:
    expect(r?.evento).not.toBe('firma:cortada');
  });

  it('sin firma abierta no se avisa nada', () => {
    expect(avisoAlDesconectar({})).toBeNull();
    expect(avisoAlDesconectar(null)).toBeNull();
    expect(avisoAlDesconectar(undefined)).toBeNull();
    expect(avisoAlDesconectar({ firma: null, firmaTel: null })).toBeNull();
  });

  it('con las dos marcas gana la PC: perder el vínculo es el hecho más grave', () => {
    expect(avisoAlDesconectar({ firma: { codigo: 'PCPC22' }, firmaTel: 'TELTEL' }))
      .toEqual({ evento: 'firma:cortada', codigo: 'PCPC22' });
  });

  it('⭐ el teléfono que vuelve puede reclamar de nuevo: al caer salió de la room', () => {
    // Es lo que hace que «que vuelva a escanear» sea cierto y no una promesa: `ya_tomado` mira
    // los sockets que ESTÁN en la room, y el del teléfono bloqueado no está.
    const pc: SocketEnRoom = {
      id: 'pc', tenantId: 'T', pc: { codigo: 'ABC234', ctx: {} as never, creado: 1000 },
    };
    const telViejo: SocketEnRoom = { id: 'tel', tenantId: 'T', telefono: 'ABC234' };
    // Con el teléfono todavía en la room, un segundo no entra.
    expect(decidirTomar([pc, telViejo], 'ABC234', 'T', 1000).fallo).toBe('ya_tomado');
    // Caído su socket, sale de la room y el MISMO teléfono vuelve a reclamar.
    expect(decidirTomar([pc], 'ABC234', 'T', 1000).ok).toBe(true);
  });

  it('⭐ y le alcanza el reloj: 8 horas, no 3 minutos', () => {
    const pc: SocketEnRoom = {
      id: 'pc', tenantId: 'T', pc: { codigo: 'ABC234', ctx: {} as never, creado: 0 },
    };
    // Con los 3 minutos viejos, un teléfono bloqueado 10 minutos llegaba a un código vencido.
    expect(decidirTomar([pc], 'ABC234', 'T', 10 * 60 * 1000).ok).toBe(true);
    // El tope sigue existiendo: un panel abandonado no sirve al día siguiente.
    expect(decidirTomar([pc], 'ABC234', 'T', VIDA_MS + 1).fallo).toBe('vencido');
  });
});
