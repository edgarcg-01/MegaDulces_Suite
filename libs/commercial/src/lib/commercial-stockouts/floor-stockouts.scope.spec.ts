import { ForbiddenException } from '@nestjs/common';
import { FloorStockoutsService } from './floor-stockouts.service';

/**
 * `[ZN.3]` — El alcance decide SOBRE QUÉ SUCURSAL, no sólo si se abre la pantalla.
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * `GET /faltantes/sucursal/:code` aceptaba **cualquier** código en la ruta. El permiso que la
 * abre (`STORE_STOCKOUT_CAPTURAR`) lo tienen **30 personas con alcance acotado** —cajeros,
 * auxiliares de tienda, encargados, verificadores—, así que quien trabaja en Padre Hidalgo podía
 * pedir `/sucursal/05` y leer lo reportado en Zamora. El permiso decía «puede abrir la pantalla»;
 * faltaba el otro eje: **sobre qué filas** (ADR-050).
 *
 * ── Por qué se prueba con dobles y no por HTTP ───────────────────────────────────────────────
 * ADR-044 manda probar por HTTP **lo que toca Postgres**, porque un test que reimplementa la
 * consulta se pone verde con la ruta caída. Acá el sujeto es otro: la **decisión de cortar**, que
 * es TypeScript puro y ocurre ANTES de la consulta. Justamente por eso el candado central es que
 * **no se llegue a la base**: si el gate deja pasar, `tk.run` se llama y el test lo ve.
 *
 * El smoke HTTP del módulo sigue siendo el que prueba la consulta, y queda declarado.
 */

/** Doble del alcance resuelto, con la forma mínima que usa el servicio. */
const scopeDoble = (modo: 'all' | 'none' | 'listed', values: string[] = []) => {
  const llamadas = { current: 0 };
  return {
    llamadas,
    servicio: {
      current: async () => {
        llamadas.current++;
        return { dims: { warehouse: { mode: modo, values } } };
      },
      canRead: (sc: any, dim: string, valor: string) => {
        const d = sc.dims[dim];
        if (d.mode === 'all') return true;
        if (d.mode === 'none') return false;
        return d.values.includes(String(valor));
      },
    },
  };
};

/**
 * Doble de `TenantKnexService`: **no ejecuta** el callback. Lo único que interesa saber es si el
 * servicio llegó a pedirle la base, que es lo que el gate tiene que impedir.
 */
const tkDoble = () => {
  const estado = { corridas: 0 };
  return { estado, servicio: { run: async () => { estado.corridas++; return []; } } };
};

const armar = (modo: 'all' | 'none' | 'listed', values: string[] = []) => {
  const tk = tkDoble();
  const scope = scopeDoble(modo, values);
  const svc = new FloorStockoutsService(
    tk.servicio as never,
    { requireTenantId: () => 'tenant-de-prueba' } as never,
    scope.servicio as never,
  );
  return { svc, tk, scope };
};

describe('[ZN.3] FloorStockoutsService · el alcance corta por sucursal', () => {
  it('⭐ NEGATIVA: con alcance a la 01, pedir la 05 da 403 y NO toca la base', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await expect(svc.listarPorSucursal('05')).rejects.toBeInstanceOf(ForbiddenException);
    // Lo importante no es sólo el 403: es que el corte pasó ANTES de la consulta.
    expect(tk.estado.corridas).toBe(0);
  });

  it('CONTROL POSITIVO: la sucursal propia sí pasa y llega a la base', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await svc.listarPorSucursal('01');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `all` (corporativo) pasa con cualquiera — no se le recorta a nadie que ya veía todo', async () => {
    const { svc, tk } = armar('all');
    await svc.listarPorSucursal('05');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `none` no pasa con ninguna', async () => {
    const { svc, tk } = armar('none');
    await expect(svc.listarPorSucursal('01')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('la herramienta de caja (códigos que fallan) corta con el MISMO criterio', async () => {
    // Si el gate viviera sólo en la lista, esta otra puerta quedaría abierta: es el mismo
    // descuido que `expiry-reviews` documenta cuando el filtro estaba sólo en `listReviews`.
    const { svc, tk } = armar('listed', ['03']);
    await expect(svc.codigosQueFallan('07')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tk.estado.corridas).toBe(0);
    await svc.codigosQueFallan('03');
    expect(tk.estado.corridas).toBe(1);
  });

  it('la sucursal vacía sigue siendo 400, no 403: es un request mal armado, no un permiso', async () => {
    const { svc, scope } = armar('all');
    await expect(svc.listarPorSucursal('')).rejects.toThrow();
    // Y no se gasta una resolución de alcance para rechazar un parámetro faltante.
    expect(scope.llamadas.current).toBe(0);
  });
});
