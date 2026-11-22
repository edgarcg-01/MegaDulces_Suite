import { describe, it, expect } from 'vitest';
import { PREFIJOS_TRABAJO_SIN_ENVIAR, limpiarRastroDeSesion } from '@megadulces/ui-web';
import {
  BorradorCotizacion,
  PREFIJO_BORRADOR,
  VERSION_BORRADOR,
  VIGENCIA_BORRADOR_MS,
  borrarBorrador,
  claveBorrador,
  guardarBorrador,
  haceCuanto,
  leerBorrador,
  leerBorradores,
  marcarAbierta,
  pestanasAbiertas,
} from './cotizacion-a-medias';
import type { ItemBandeja } from './pages/televenta-quote-new.component';

/** Un Storage de mentira: el de jsdom se comparte entre pruebas y aquí cada caso arranca limpio. */
function memoria(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

const AHORA = 1_762_450_000_000;
const renglon = { id: 'a', sku: '70500', name: 'LA ROSA CERETZZA', quantity: 2, rung: 'pack' } as ItemBandeja;
const borrador = (o: Partial<BorradorCotizacion> = {}): BorradorCotizacion => ({
  v: VERSION_BORRADOR,
  guardado: AHORA,
  modo: 'mayoreo',
  sucursal: '01',
  cliente: null,
  direccion: null,
  vendedor: null,
  contacto: { nombre: '', tel: '', mail: '' },
  origen: 'telemarketing',
  vigencia: null,
  lista: '',
  observaciones: '',
  bandeja: [renglon],
  ...o,
});

describe('[COT.32] cotización a medias en el navegador', () => {
  it('lo que se guarda se recupera igual', () => {
    const s = memoria();
    guardarBorrador('k', borrador({ observaciones: 'cobrar al entregar' }), s);
    const b = leerBorrador('k', AHORA + 60_000, s);
    expect(b?.bandeja[0].sku).toBe('70500');
    expect(b?.observaciones).toBe('cobrar al entregar');
  });

  it('una pantalla vacía no deja aviso: guardar sin trabajo BORRA el anterior', () => {
    const s = memoria();
    guardarBorrador('k', borrador(), s);
    guardarBorrador('k', borrador({ bandeja: [] }), s);
    expect(leerBorrador('k', AHORA, s)).toBeNull();
  });

  it('sólo la lista pegada del cliente, sin renglones, ya es trabajo', () => {
    const s = memoria();
    guardarBorrador('k', borrador({ bandeja: [], lista: '3 cajas de kinder' }), s);
    expect(leerBorrador('k', AHORA, s)?.lista).toBe('3 cajas de kinder');
  });

  it('vencido (más de 7 días) o de otra versión: se descarta y se limpia', () => {
    const s = memoria();
    guardarBorrador('k', borrador(), s);
    expect(leerBorrador('k', AHORA + VIGENCIA_BORRADOR_MS + 1, s)).toBeNull();
    expect(s.getItem('k')).toBeNull();
    s.setItem('k', JSON.stringify({ ...borrador(), v: 99 }));
    expect(leerBorrador('k', AHORA, s)).toBeNull();
  });

  it('basura en el almacén o almacén que truena: no hay borrador, nunca una excepción', () => {
    const s = memoria();
    s.setItem('k', '{no es json');
    expect(leerBorrador('k', AHORA, s)).toBeNull();
    const roto = { ...memoria(), getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('lleno'); } } as Storage;
    expect(leerBorrador('k', AHORA, roto)).toBeNull();
    expect(() => guardarBorrador('k', borrador(), roto)).not.toThrow();
    expect(() => borrarBorrador('k', roto)).not.toThrow();
  });

  it('cada usuario su borrador: en una PC compartida nadie recupera la cotización de otro', () => {
    expect(claveBorrador('u1')).not.toBe(claveBorrador('u2'));
  });

  it('dice hace cuánto se guardó', () => {
    expect(haceCuanto(AHORA, AHORA + 12 * 60_000)).toBe('hace 12 min');
    expect(haceCuanto(AHORA, AHORA + 3 * 3_600_000)).toBe('hace 3 h');
    expect(haceCuanto(AHORA, AHORA + 2 * 86_400_000)).toBe('hace 2 días');
  });
});

/** Web Locks de mentira: un candado se sostiene hasta que se resuelve la promesa de quien lo pidió. */
function candadosFalsos() {
  const sostenidos = new Set<string>();
  return {
    request: (nombre: string, cb: () => Promise<void>) => {
      sostenidos.add(nombre);
      return cb().then(() => { sostenidos.delete(nombre); });
    },
    query: async () => ({ held: [...sostenidos].map((name) => ({ name })) }),
  };
}

describe('[COT.50] una ranura por pestaña, y la sesión vencida no la borra', () => {
  it('⭐ una pestaña VACÍA no borra lo que la otra lleva capturado', () => {
    const s = memoria();
    guardarBorrador(claveBorrador('u1', 'A'), borrador(), s); // la pestaña A captura
    guardarBorrador(claveBorrador('u1', 'B'), borrador({ bandeja: [] }), s); // la B, vacía, se oculta
    expect(leerBorrador(claveBorrador('u1', 'A'), AHORA, s)?.bandeja).toHaveLength(1);
  });

  it('NEGATIVA: con la ranura única de antes, la vacía sí lo borraba (el defecto que se cierra)', () => {
    const s = memoria();
    guardarBorrador(claveBorrador('u1'), borrador(), s);
    guardarBorrador(claveBorrador('u1'), borrador({ bandeja: [] }), s);
    expect(leerBorrador(claveBorrador('u1'), AHORA, s)).toBeNull();
  });

  it('ofrece los del usuario —también la clave de antes de COT.50—, el más nuevo primero, y no los de otro', () => {
    const s = memoria();
    guardarBorrador(claveBorrador('u1'), borrador({ guardado: AHORA - 3_000 }), s);
    guardarBorrador(claveBorrador('u1', 'A'), borrador({ guardado: AHORA - 1_000 }), s);
    guardarBorrador(claveBorrador('u1', 'B'), borrador({ guardado: AHORA - 2_000 }), s);
    guardarBorrador(claveBorrador('u10', 'C'), borrador(), s); // otro usuario con prefijo parecido
    expect(leerBorradores('u1', new Set(), AHORA, s).map((p) => p.clave)).toEqual([
      claveBorrador('u1', 'A'), claveBorrador('u1', 'B'), claveBorrador('u1'),
    ]);
  });

  it('⭐ no ofrece el de una pestaña que sigue abierta (recuperarlo duplicaría la captura)', () => {
    const s = memoria();
    guardarBorrador(claveBorrador('u1', 'viva'), borrador(), s);
    guardarBorrador(claveBorrador('u1', 'cerrada'), borrador(), s);
    expect(leerBorradores('u1', new Set(['viva']), AHORA, s).map((p) => p.clave)).toEqual([claveBorrador('u1', 'cerrada')]);
  });

  it('la pestaña se sabe abierta mientras sostiene su candado, y deja de estarlo al soltarlo', async () => {
    const l = candadosFalsos();
    const soltar = marcarAbierta('t1', l);
    expect(await pestanasAbiertas(l)).toEqual(new Set(['t1']));
    soltar();
    await Promise.resolve();
    await Promise.resolve();
    expect(await pestanasAbiertas(l)).toEqual(new Set());
  });

  it('sin Web Locks no se sabe cuáles están abiertas: null (se ofrecen todas, como antes)', async () => {
    expect(await pestanasAbiertas(null)).toBeNull();
    expect(() => marcarAbierta('t1', null)()).not.toThrow();
  });

  it('⭐ el prefijo del borrador es trabajo sin enviar para la limpieza de sesión (si alguien lo renombra, esto cae)', () => {
    expect(PREFIJOS_TRABAJO_SIN_ENVIAR.some((p) => PREFIJO_BORRADOR.startsWith(p))).toBe(true);
  });

  it('⭐ de punta a punta: la sesión vence (401) y la cotización sigue ahí al volver a entrar', async () => {
    localStorage.clear();
    guardarBorrador(claveBorrador('u1', 'A'), borrador({ guardado: Date.now() }));
    await limpiarRastroDeSesion({ conservarTrabajoSinEnviar: true });
    expect(leerBorradores('u1').map((p) => p.clave)).toEqual([claveBorrador('u1', 'A')]);
    // Y el cierre voluntario sí la borra.
    await limpiarRastroDeSesion();
    expect(leerBorradores('u1')).toEqual([]);
  });
});
