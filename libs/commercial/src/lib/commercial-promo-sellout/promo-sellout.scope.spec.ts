import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PromoSelloutService } from './promo-sellout.service';

/**
 * `[MKT.6]` — **El alcance decide sobre QUÉ plaza, no sólo si se abre la pantalla.**
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * `GET /promo-sellout/sucursal/:code` la puede abrir quien tiene
 * `MKT_AGREEMENT_EVIDENCE_SUBIR` — que es, por diseño de `[MKT.1]`, **la gente de plaza**. Sin el
 * corte, quien trabaja en Padre Hidalgo pide `/sucursal/05` y lee el resultado comercial de
 * Zamora: qué se negoció ahí, cuánto vendió y con qué proveedor. El permiso dice "puede abrir la
 * pantalla"; falta el otro eje, **sobre qué filas** (ADR-050).
 *
 * Es el mismo descuido que `[ZN.3]` corrigió en la Lista de faltantes, donde 30 personas con
 * alcance acotado podían leer lo reportado en cualquier sucursal.
 *
 * ── Por qué con dobles y no por HTTP ────────────────────────────────────────────────────────
 * ADR-044 manda probar por HTTP lo que toca Postgres, porque un test que reimplementa la
 * consulta se pone verde con la ruta caída. Acá el sujeto es la **decisión de cortar**, que es
 * TypeScript puro y ocurre ANTES de consultar. Por eso el candado central de cada caso no es el
 * 403: es que **no se llegue a la base**. Si el gate deja pasar, el doble de `tk.run` lo ve.
 */

/**
 * Doble del alcance con la forma de `ScopeService`. Reproduce su CONTRATO (resolver, preguntar,
 * lanzar 403) y no una copia de su regla: lo que se vigila es que el servicio LO LLAME antes de
 * consultar, no cómo decide adentro.
 */
const scopeDoble = (modo: 'all' | 'none' | 'listed', values: string[] = []) => {
  const llamadas = { current: 0 };
  const puede = (v: string) =>
    modo === 'all' ? true : modo === 'none' ? false : values.includes(String(v));
  return {
    llamadas,
    servicio: {
      assertCanRead: async (_dim: string, valor: string) => {
        llamadas.current++;
        if (!puede(String(valor ?? '').trim())) {
          throw new ForbiddenException(`Tu alcance no incluye la sucursal "${valor}".`);
        }
      },
    },
  };
};

/** Doble de `TenantKnexService`: **no ejecuta** el callback. Sólo cuenta si se le pidió la base. */
const tkDoble = () => {
  const estado = { corridas: 0 };
  return { estado, servicio: { run: async () => { estado.corridas++; return []; } } };
};

const armar = (modo: 'all' | 'none' | 'listed', values: string[] = []) => {
  const tk = tkDoble();
  const scope = scopeDoble(modo, values);
  const svc = new PromoSelloutService(tk.servicio as never, scope.servicio as never);
  return { svc, tk, scope };
};

describe('[MKT.6] PromoSelloutService · el alcance corta por plaza', () => {
  it('⭐ NEGATIVA: con alcance a la 01, pedir la 05 da 403 y NO toca la base', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await expect(svc.porSucursal('05')).rejects.toBeInstanceOf(ForbiddenException);
    // Lo importante no es sólo el 403: es que el corte pasó ANTES de la consulta.
    expect(tk.estado.corridas).toBe(0);
  });

  it('CONTROL POSITIVO: la plaza propia sí pasa y llega a la base', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await svc.porSucursal('01');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `all` (corporativo) pasa con cualquiera — no se le recorta a quien ya veía todo', async () => {
    const { svc, tk } = armar('all');
    await svc.porSucursal('05');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `none` no pasa con ninguna', async () => {
    const { svc, tk } = armar('none');
    await expect(svc.porSucursal('01')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('el código se compara sin espacios sobrantes: " 01 " es la 01, no una plaza ajena', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await svc.porSucursal('  01  ');
    expect(tk.estado.corridas).toBe(1);
  });

  it('la sucursal vacía es 400, no 403: es un request mal armado, no un permiso', async () => {
    const { svc, scope, tk } = armar('all');
    await expect(svc.porSucursal('')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.porSucursal('   ')).rejects.toBeInstanceOf(BadRequestException);
    // Y no se gasta una resolución de alcance —ni una consulta— para rechazar un parámetro vacío.
    expect(scope.llamadas.current).toBe(0);
    expect(tk.estado.corridas).toBe(0);
  });

  it('las rutas SIN plaza en el path no consultan el alcance: ahí corta el permiso', async () => {
    // `listar()` y `porAcuerdo()` exigen MKT_AGREEMENTS_VER en el controller (Mercadotecnia, que
    // ve todo). Meterles un `assertCanRead` sin dimensión sería un gate que no gatea nada.
    const { svc, scope, tk } = armar('none');
    await svc.listar();
    expect(scope.llamadas.current).toBe(0);
    expect(tk.estado.corridas).toBe(1);
  });

  it('un acuerdo sin id es 400 y no llega a la base', async () => {
    const { svc, tk } = armar('all');
    await expect(svc.porAcuerdo('')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.coberturaDeCodigos('')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.conciliacion('')).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });
});
