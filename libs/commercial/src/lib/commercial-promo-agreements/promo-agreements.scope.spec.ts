import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PromoAgreementsService } from './promo-agreements.service';

/**
 * `[MKT.1]` — El alcance decide SOBRE QUÉ PLAZA, no sólo si se abre la pantalla.
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────────
 * `MKT_AGREEMENT_EVIDENCE_SUBIR` lo tienen los encargados, auxiliares, cajeros y verificadores de
 * las once plazas. Si `GET /sucursal/:code` y `POST /canales/:id/evidencia` aceptaran cualquier
 * código, quien trabaja en Padre Hidalgo podría leer el expediente de Zamora —y, peor, **subirle
 * evidencia**, que es firmar que otra plaza ejecutó. El permiso dice «puede abrir la pantalla»;
 * el alcance dice «sobre qué filas» (ADR-050).
 *
 * ── Por qué con dobles y no por HTTP ────────────────────────────────────────────────────────
 * ADR-044 manda probar por HTTP lo que toca Postgres, porque un test que reimplementa la consulta
 * se pone verde con la ruta caída. Acá el sujeto es la **decisión de cortar**, que ocurre ANTES
 * de la consulta. Justamente por eso el candado central de cada caso es que **no se llegue a la
 * base**: si el gate deja pasar, `tk.run` se llama y el test lo ve.
 *
 * El smoke HTTP del módulo prueba la consulta y queda declarado aparte
 * (`database/tests/test-newdb-promo-agreements.js`).
 */

/**
 * Doble del alcance con la forma que usa el servicio. Reproduce el CONTRATO de
 * `ScopeService` (resolver, preguntar, lanzar 403), no una copia de su regla: lo que este spec
 * vigila es que el servicio LO LLAME, no cómo decide adentro.
 */
const scopeDoble = (modo: 'all' | 'none' | 'listed', values: string[] = []) => {
  const llamadas = { assertCanRead: 0, current: 0 };
  const puede = (valor: string) =>
    modo === 'all' ? true : modo === 'none' ? false : values.includes(String(valor).trim());
  return {
    llamadas,
    servicio: {
      assertCanRead: async (_dim: string, valor: string) => {
        llamadas.assertCanRead++;
        if (!puede(String(valor ?? '').trim())) {
          throw new ForbiddenException(`Tu alcance no incluye la sucursal "${valor}".`);
        }
      },
      current: async () => {
        llamadas.current++;
        return { dims: { warehouse: { mode: modo, values, modeWrite: modo, valuesWrite: values } } };
      },
    },
  };
};

/**
 * Doble de `TenantKnexService`. **No ejecuta** el callback por defecto: lo único que interesa es
 * si el servicio llegó a pedirle la base, que es lo que el gate tiene que impedir.
 *
 * `respuestas` permite devolver filas en orden para los flujos de dos pasos (resolver el canal,
 * y después escribir): ahí el primer `run` es lectura legítima y el corte va en medio.
 */
const tkDoble = (respuestas: unknown[] = []) => {
  const estado = { corridas: 0 };
  return {
    estado,
    servicio: {
      run: async () => {
        const i = estado.corridas;
        estado.corridas++;
        // ⚠️ `respuestas[i] ?? []` estaría MAL: convertiría un `undefined` explícito —que es
        // justo como se simula "ese canal no existe"— en un `[]`, que es **truthy**, y el
        // servicio seguiría de largo sin lanzar el 404. El doble tiene que poder devolver
        // `undefined` de verdad, o el caso negativo no se puede escribir.
        return i < respuestas.length ? respuestas[i] : [];
      },
    },
  };
};

const armar = (modo: 'all' | 'none' | 'listed', values: string[] = [], respuestas: unknown[] = []) => {
  const tk = tkDoble(respuestas);
  const scope = scopeDoble(modo, values);
  const svc = new PromoAgreementsService(
    tk.servicio as never,
    { requireTenantId: () => 'tenant-de-prueba' } as never,
    scope.servicio as never,
  );
  return { svc, tk, scope };
};

describe('[MKT.1] PromoAgreementsService · el alcance corta por plaza al LEER', () => {
  it('⭐ NEGATIVA: con alcance a la 01, pedir la 05 da 403 y NO toca la base', async () => {
    const { svc, tk } = armar('listed', ['01']);
    await expect(svc.listarPorSucursal('05')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('CONTROL POSITIVO: la plaza propia pasa y llega a la base', async () => {
    const { svc, tk } = armar('listed', ['01'], [[]]);
    await svc.listarPorSucursal('01');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `all` (Mercadotecnia) pasa con cualquiera — no se le recorta a quien ya veía todo', async () => {
    const { svc, tk } = armar('all', [], [[]]);
    await svc.listarPorSucursal('05');
    expect(tk.estado.corridas).toBe(1);
  });

  it('alcance `none` no pasa con ninguna', async () => {
    const { svc, tk } = armar('none');
    await expect(svc.listarPorSucursal('01')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('sin sucursal es 400, no un listado de todas', async () => {
    const { svc, tk } = armar('all');
    await expect(svc.listarPorSucursal('')).rejects.toBeInstanceOf(BadRequestException);
    // Una cadena vacía NO puede degradar a "tráeme todo": sería abrir el módulo entero.
    expect(tk.estado.corridas).toBe(0);
  });
});

describe('[MKT.1] El alcance corta por plaza al ESCRIBIR evidencia', () => {
  /** El canal que el primer `run` resuelve, ya perteneciente a la sucursal 05. */
  const canalDeZamora = { id: 'canal-05', agreement_id: 'a-1', warehouse_code: '05' };
  const archivo = { file_name: 'exhibicion.jpg', file_url: 'https://x/exhibicion.jpg' };

  it('⭐ NEGATIVA: con alcance a la 01, subir al expediente de la 05 da 403 y NO escribe', async () => {
    const { svc, tk } = armar('listed', ['01'], [canalDeZamora]);
    await expect(svc.subirEvidencia('canal-05', archivo, {})).rejects.toBeInstanceOf(ForbiddenException);
    // El primer `run` es la lectura que resuelve de qué plaza es el canal — legítima.
    // Lo que NO puede haber es un segundo: ése sería el INSERT.
    expect(tk.estado.corridas).toBe(1);
  });

  it('CONTROL POSITIVO: subir al expediente propio sí escribe', async () => {
    const canalPropio = { id: 'canal-01', agreement_id: 'a-1', warehouse_code: '01' };
    const { svc, tk } = armar('listed', ['01'], [canalPropio, { id: 'canal-01', warehouse_code: '01', evidence_required: 1, evidence_count: 1 }]);
    await svc.subirEvidencia('canal-01', archivo, { username: 'maria' });
    expect(tk.estado.corridas).toBe(2);
  });

  it('un canal inexistente es 404 y nunca llega a pedir alcance', async () => {
    const { svc, scope } = armar('listed', ['01'], [undefined]);
    await expect(svc.subirEvidencia('no-existe', archivo, {})).rejects.toThrow();
    // No se consulta el alcance de algo que no existe: se contestaría 403 y el mensaje diría que
    // "no alcanza", cuando el problema es otro.
    expect(scope.llamadas.assertCanRead).toBe(0);
  });

  it('⭐ un archivo sin nombre ni URL es 400 ANTES de tocar nada', async () => {
    const { svc, tk, scope } = armar('all', [], [canalDeZamora]);
    await expect(svc.subirEvidencia('canal-05', { file_name: '', file_url: '' }, {}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
    expect(scope.llamadas.assertCanRead).toBe(0);
  });

  it('⭐ el endpoint de la plaza NO acepta otros tipos de archivo del expediente', async () => {
    // `formato_pdf` y `nota_credito` son documentos del ACUERDO, no evidencia de ejecución.
    // Si se colaran por acá, entrarían con `channel_id` y el CHECK de la tabla los rechazaría —
    // pero con un error de Postgres ilegible en vez de un mensaje. Se corta antes.
    const { svc, tk } = armar('all', [], [canalDeZamora]);
    await expect(
      svc.subirEvidencia('canal-05', { ...archivo, kind: 'nota_credito' }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });
});

describe('[MKT.1] Validación de la carátula antes de escribir', () => {
  const base = {
    empresa: 'Mega Dulces De Los Altos',
    proveedor: 'Alteño',
    mecanica: '3% de descuento',
    fecha_negociacion: '2026-09-22',
    vigencia_desde: '2026-10-05',
    recurso: 'proveedor_sin_cargo' as const,
  };

  it('⭐ la vigencia NO puede terminar en fecha Y texto a la vez', async () => {
    const { svc, tk } = armar('all');
    await expect(
      svc.crear({ ...base, vigencia_hasta: '2026-10-16', vigencia_hasta_texto: 'hasta agotar' }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('⭐ ni quedarse sin ninguna de las dos', async () => {
    const { svc, tk } = armar('all');
    // Sin fin no se puede cerrar el acuerdo ni reportarle al proveedor: el formato queda abierto
    // para siempre y nadie sabe cuándo dejó de aplicar.
    await expect(svc.crear({ ...base }, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('con fecha sola pasa', async () => {
    const { svc, tk } = armar('all', [], [[{ id: 'a-1', status: 'borrador' }]]);
    await svc.crear({ ...base, vigencia_hasta: '2026-10-16' }, {});
    expect(tk.estado.corridas).toBe(1);
  });

  it('con «hasta agotar» solo, también', async () => {
    const { svc, tk } = armar('all', [], [[{ id: 'a-1', status: 'borrador' }]]);
    await svc.crear({ ...base, vigencia_hasta_texto: 'hasta agotar' }, {});
    expect(tk.estado.corridas).toBe(1);
  });

  it('⭐ recurso «otros» sin especificar cuál es 400 — es la línea que el papel deja en blanco', async () => {
    const { svc, tk } = armar('all');
    await expect(
      svc.crear({ ...base, vigencia_hasta: '2026-10-16', recurso: 'otros' }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('⭐ un monto en 0 se rechaza: si no se pactó, va vacío (ADR-056)', async () => {
    const { svc, tk } = armar('all');
    await expect(
      svc.crear({ ...base, vigencia_hasta: '2026-10-16', monto: 0 }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tk.estado.corridas).toBe(0);
  });

  it('sin monto (no se pactó) sí pasa', async () => {
    const { svc, tk } = armar('all', [], [[{ id: 'a-1', status: 'borrador' }]]);
    await svc.crear({ ...base, vigencia_hasta: '2026-10-16', monto: null }, {});
    expect(tk.estado.corridas).toBe(1);
  });
});
