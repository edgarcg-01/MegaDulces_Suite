import { describe, it, expect } from 'vitest';
import {
  BorradorCotizacion,
  VERSION_BORRADOR,
  VIGENCIA_BORRADOR_MS,
  borrarBorrador,
  claveBorrador,
  guardarBorrador,
  haceCuanto,
  leerBorrador,
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
