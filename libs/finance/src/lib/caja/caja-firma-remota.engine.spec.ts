/**
 * `[CG.68]` Candados del emparejamiento PC ↔ teléfono.
 *
 * ⚠️ NO importar nada de `vitest`: los specs hermanos de esta carpeta usan los globales y el
 * import rompe la corrida entera. Ya costó una vez en `caja-caos-ingreso.engine.spec.ts`.
 *
 * El reloj y el azar se INYECTAN. Una prueba que sortea no prueba lo mismo dos veces, y una que
 * espera tres minutos no la corre nadie.
 */
import {
  VinculosFirma, nuevoCodigo, firmaSigueValiendo, VIDA_MS, type ContextoFirma,
} from './caja-firma-remota.engine';

const T1 = '00000000-0000-0000-0000-00000000d01c';
const T2 = '11111111-1111-1111-1111-111111111111';
const CTX: ContextoFirma = { tipo: 'gasto', monto: 1900, beneficiario: 'JUAN PEREZ', documento: 'X-D-26 0001294' };

/** Un reloj que se puede empujar. */
function reloj(t = 1_000_000) {
  const r = { t };
  return { ahora: () => r.t, avanzar: (ms: number) => { r.t += ms; } };
}

/** Un "azar" determinista que recorre el alfabeto. */
function azarSerie(valores: number[]) {
  let i = 0;
  return () => valores[i++ % valores.length];
}

describe('nuevoCodigo · [CG.68]', () => {
  it('usa un alfabeto SIN caracteres ambiguos', () => {
    // Quien lo teclea lo lee de otra pantalla, a veces de lejos. Un 0 leído como O es un código
    // que "no funciona" y nadie sabe por qué.
    const muchos = Array.from({ length: 200 }, () => nuevoCodigo()).join('');
    for (const malo of ['0', 'O', '1', 'I', 'L']) {
      expect(muchos.includes(malo), `el alfabeto trae ${malo}`).toBe(false);
    }
  });

  it('mide 6 y es determinista con un azar dado', () => {
    const c = nuevoCodigo(azarSerie([0, 0, 0, 0, 0, 0]));
    expect(c).toBe('AAAAAA');
    expect(nuevoCodigo(azarSerie([0, 0, 0, 0, 0, 0]))).toBe(c);
  });
});

describe('VinculosFirma · [CG.68]', () => {
  it('la room es de DOS, no la del tenant', () => {
    // ⛔ Es el punto de todo el emparejamiento. Con la room del tenant, la firma de un cajero
    // aparece en la pantalla del otro — y es evidencia de quién recibió efectivo.
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    expect(v.room(a)).toBe(`firma:${T1}:${a.codigo}`);
    expect(v.room(a)).not.toBe(`tenant:${T1}`);
  });

  it('el teléfono reclama y queda atado', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);

    const r = v.reclamar(a.codigo, T1, 'tel-1');
    expect(r.ok).toBe(true);
    expect(r.v?.telefono).toBe('tel-1');
    // Y el contexto que viaja es el MÍNIMO para saber qué se firma.
    expect(r.v?.ctx).toEqual(CTX);
  });

  it('lo tecleado llega como venga: minúsculas y espacios', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    const sucio = a.codigo.toLowerCase().split('').join(' ');
    expect(v.reclamar(sucio, T1, 'tel-1').ok).toBe(true);
  });

  it('⛔ [negativa] UN SOLO USO: el segundo teléfono no entra', () => {
    // Si el código siguiera vivo, un segundo teléfono entraría a la misma room y vería el
    // contexto del efectivo.
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    expect(v.reclamar(a.codigo, T1, 'tel-1').ok).toBe(true);

    const segundo = v.reclamar(a.codigo, T1, 'tel-2');
    expect(segundo.ok).toBe(false);
    expect(segundo.fallo).toBe('ya_tomado');
  });

  it('⛔⛔ [negativa] un código de OTRO tenant no se reclama', () => {
    // El JWT ya separa los tenants, pero el código es un identificador global: sin esta
    // comparación bastaría acertar seis caracteres para mirar el efectivo de otra empresa.
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    const r = v.reclamar(a.codigo, T2, 'tel-de-otra-empresa');
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('otro_tenant');
    // Y sigue reclamable por quien corresponde: el rechazo no lo consumió.
    expect(v.reclamar(a.codigo, T1, 'tel-1').ok).toBe(true);
  });

  it('⛔ [negativa] un código VENCIDO no sirve', () => {
    const r = reloj();
    const v = new VinculosFirma(r.ahora);
    const a = v.abrir(T1, 'pc-1', CTX);

    r.avanzar(VIDA_MS + 1);
    const x = v.reclamar(a.codigo, T1, 'tel-1');
    expect(x.ok).toBe(false);
    expect(x.fallo).toBe('vencido');
    expect(v.vivos(), 'el vencido se tenía que purgar').toBe(0);
  });

  it('justo ANTES de vencer todavía sirve', () => {
    // Sin esta, la vida podría ser cero y la prueba de arriba seguiría pasando.
    const r = reloj();
    const v = new VinculosFirma(r.ahora);
    const a = v.abrir(T1, 'pc-1', CTX);
    r.avanzar(VIDA_MS - 1);
    expect(v.reclamar(a.codigo, T1, 'tel-1').ok).toBe(true);
  });

  it('⛔ [negativa] sólo el teléfono que RECLAMÓ puede entregar', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    v.reclamar(a.codigo, T1, 'tel-1');

    const intruso = v.entregar(a.codigo, T1, 'tel-2');
    expect(intruso.ok).toBe(false);
    expect(intruso.fallo).toBe('no_es_suyo');

    expect(v.entregar(a.codigo, T1, 'tel-1').ok).toBe(true);
  });

  it('⛔ [negativa] UNA firma por vínculo: la segunda entrega no pisa a la primera', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    v.reclamar(a.codigo, T1, 'tel-1');
    expect(v.entregar(a.codigo, T1, 'tel-1').ok).toBe(true);

    const otra = v.entregar(a.codigo, T1, 'tel-1');
    expect(otra.ok).toBe(false);
    expect(otra.fallo).toBe('no_existe');
  });

  it('entregar sin haber reclamado no se puede', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    const r = v.entregar(a.codigo, T1, 'tel-1');
    expect(r.ok).toBe(false);
    expect(r.fallo).toBe('no_es_suyo');
  });

  it('si se cae un socket, el vínculo se cierra de los DOS lados', () => {
    // Un vínculo con una sola punta no sirve para nada y deja el código reclamable.
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    v.reclamar(a.codigo, T1, 'tel-1');

    const caidos = v.soltarSocket('tel-1');
    expect(caidos.map((x) => x.codigo)).toEqual([a.codigo]);
    expect(v.vivos()).toBe(0);
    expect(v.reclamar(a.codigo, T1, 'tel-9').fallo).toBe('no_existe');
  });

  it('si se cae la PC, también', () => {
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-1', CTX);
    expect(v.soltarSocket('pc-1').length).toBe(1);
    expect(v.vivos()).toBe(0);
  });

  it('⛔ [negativa] dos cajas a la vez NO se cruzan', () => {
    // El escenario que motiva todo: dos cajeros capturando al mismo tiempo.
    const v = new VinculosFirma();
    const a = v.abrir(T1, 'pc-A', { ...CTX, monto: 100 });
    const b = v.abrir(T1, 'pc-B', { ...CTX, monto: 200 });
    expect(a.codigo).not.toBe(b.codigo);

    v.reclamar(a.codigo, T1, 'tel-A');
    v.reclamar(b.codigo, T1, 'tel-B');

    expect(v.room(a)).not.toBe(v.room(b));
    // El teléfono de A no puede entregar en el vínculo de B.
    expect(v.entregar(b.codigo, T1, 'tel-A').fallo).toBe('no_es_suyo');
  });

  it('un código colisionado se reintenta en vez de pisar el vínculo ajeno', () => {
    // Con un azar que SIEMPRE devuelve lo mismo, el segundo `abrir` tendría el mismo código: si
    // no se reintentara, la firma de una caja se iría a la otra.
    const v = new VinculosFirma(() => 1_000_000, azarSerie([0]));
    const a = v.abrir(T1, 'pc-A', CTX);
    // El azar fijo agota los 8 reintentos y avisa, en vez de devolver un código ya usado.
    expect(() => v.abrir(T1, 'pc-B', CTX)).toThrow(/código libre/);
    expect(v.vivos()).toBe(1);
    expect(v.reclamar(a.codigo, T1, 'tel-A').v?.pc).toBe('pc-A');
  });
});

describe('firmaSigueValiendo · [CG.68]', () => {
  it('⭐ si el monto cambió DESPUÉS de firmar, la firma dejó de corresponder', () => {
    // Sin esto, el cajero cambia el importe y la pantalla sigue diciendo "firmado" sobre otra
    // cifra: una firma válida pegada a un número que nadie aceptó.
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
