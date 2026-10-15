import { describe, expect, it, vi } from 'vitest';
import { FotoSwr } from './foto-swr';

/** Reloj manual: las pruebas mueven el tiempo, no esperan. */
function reloj(inicio = 1_000_000) {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms: number) => { t += ms; } };
}

describe('FotoSwr · servir la foto y recargarla detrás', () => {
  it('⭐ la primera vez espera; después sirve la foto sin volver a armarla', async () => {
    const r = reloj();
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000, ahora: r.ahora });
    const armar = vi.fn().mockResolvedValue(7);
    expect((await c.obtener('k', armar)).valor).toBe(7);
    r.avanzar(30_000);
    expect((await c.obtener('k', armar)).valor).toBe(7);
    expect(armar).toHaveBeenCalledTimes(1);
  });

  it('⭐ pasada la recarga, sirve la vieja AL MOMENTO y la cambia detrás', async () => {
    const r = reloj();
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000, ahora: r.ahora });
    await c.obtener('k', () => Promise.resolve(1));
    r.avanzar(90_000);
    let soltar!: (v: number) => void;
    const lenta = new Promise<number>((res) => { soltar = res; });
    const servida = await c.obtener('k', () => lenta);
    // Prueba negativa: si esperara la recarga, esta línea no se alcanzaría hasta `soltar`.
    expect(servida.valor).toBe(1);
    soltar(2);
    await lenta;
    await Promise.resolve();
    expect((await c.obtener('k', () => Promise.resolve(3))).valor).toBe(2);
  });

  it('vencida, espera la recarga (no publica un dato de edad indefinida)', async () => {
    const r = reloj();
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000, ahora: r.ahora });
    await c.obtener('k', () => Promise.resolve(1));
    r.avanzar(301_000);
    expect((await c.obtener('k', () => Promise.resolve(9))).valor).toBe(9);
  });

  it('⭐ una sola recarga a la vez por clave aunque lleguen muchos', async () => {
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000 });
    const armar = vi.fn(() => new Promise<number>((res) => setTimeout(() => res(5), 5)));
    const todos = await Promise.all([1, 2, 3, 4].map(() => c.obtener('k', armar)));
    expect(todos.map((f) => f.valor)).toEqual([5, 5, 5, 5]);
    expect(armar).toHaveBeenCalledTimes(1);
  });

  it('las claves no se mezclan (una sucursal no ve la foto de otra)', async () => {
    const c = new FotoSwr<string>({ recargarMs: 60_000, venceMs: 300_000 });
    await c.obtener('02', () => Promise.resolve('piedad'));
    expect((await c.obtener('05', () => Promise.resolve('zamora'))).valor).toBe('zamora');
    expect((await c.obtener('02', () => Promise.resolve('x'))).valor).toBe('piedad');
  });

  it('⭐ una recarga de fondo que falla no tumba a quien pidió y avisa', async () => {
    const r = reloj();
    const alFallar = vi.fn();
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000, ahora: r.ahora, alFallar });
    await c.obtener('k', () => Promise.resolve(1));
    r.avanzar(90_000);
    expect((await c.obtener('k', () => Promise.reject(new Error('caída')))).valor).toBe(1);
    await new Promise((res) => setTimeout(res, 0));
    expect(alFallar).toHaveBeenCalledWith('k', expect.any(Error));
  });

  it('sin foto, el error de la primera carga sí sube (no se inventa un vacío)', async () => {
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000 });
    await expect(c.obtener('k', () => Promise.reject(new Error('caída')))).rejects.toThrow('caída');
    // Y no queda trabada: la siguiente vuelve a intentar.
    expect((await c.obtener('k', () => Promise.resolve(4))).valor).toBe(4);
  });

  it('la edad viaja con el valor', async () => {
    const r = reloj(5_000);
    const c = new FotoSwr<number>({ recargarMs: 60_000, venceMs: 300_000, ahora: r.ahora });
    expect((await c.obtener('k', () => Promise.resolve(1))).at).toBe(5_000);
  });

  it('rechaza una política incoherente', () => {
    expect(() => new FotoSwr({ recargarMs: 0, venceMs: 10 })).toThrow();
    expect(() => new FotoSwr({ recargarMs: 100, venceMs: 10 })).toThrow();
  });
});
