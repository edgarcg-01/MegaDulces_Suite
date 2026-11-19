import knexFactory, { Knex } from 'knex';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { fechaKepler, type BoxLabelPrintRequest } from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { BoxLabelsService } from './box-labels.service';

/**
 * `[RE.ETQ.2.3]` `POST commercial/receiving/box-labels/prints` (`imprimir`) contra Postgres REAL, con el payload que
 * manda la pantalla. Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base
 * real. Lo que un doble de Knex no ve: la RLS forzada, el índice único parcial de la primera, el CHECK de los
 * consecutivos y que la vista `analytics.v_box_label_lines` lea lo sembrado en el ODS.
 *
 *     BOX_LABELS_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5442/postgres_platform \
 *     BOX_LABELS_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5442/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/commercial-receiving/box-labels.servicio-real.spec.ts
 *
 * La URL admin sólo siembra y limpia (sucursal `93`, que no existe en ninguna base real). Requiere las migraciones
 * 20261119100324 y 20261119101651 aplicadas. ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.BOX_LABELS_TEST_DB_URL;
const ADMIN = process.env.BOX_LABELS_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const SUC = '93';
const FOLIO = `P${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
const VALE = `V${FOLIO.slice(1)}`;

if (!URL || !ADMIN) {
  // eslint-disable-next-line no-console
  console.warn('[RE.ETQ.2.3] NO MEDIDO: faltan BOX_LABELS_TEST_DB_URL y/o BOX_LABELS_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('[RE.ETQ.2.3] imprimir etiquetas de caja (Postgres real)', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: BoxLabelsService;

  /** El payload de la pantalla: «Imprimir» de una orden = todos sus renglones, vía navegador. */
  const pedido = (p: Partial<BoxLabelPrintRequest> = {}): BoxLabelPrintRequest => ({
    sucursal: SUC, serie: 1, folio: FOLIO, via: 'navegador', renglones: [{ linea: 1 }], ...p,
  });
  const bitacora = () => admin('commercial.box_label_prints').where({ sucursal: SUC, folio: FOLIO }).orderBy('created_at');

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null, username: 'prueba_etiquetas' }) } as unknown as TenantContextService;
    const tk = new TenantKnexService(knex, ctx);
    // Alcance: sólo la sucursal 93, para lectura y escritura.
    const scope = {
      readParam: async () => [SUC],
      assertCanWrite: async (_dim: string, v: string) => {
        if (v !== SUC) throw new ForbiddenException(`warehouse ${v} fuera de tu alcance`);
      },
    } as unknown as ScopeService;
    svc = new BoxLabelsService(tk, ctx, scope);

    const ocupado = await admin('kepler_ods.kdm1').where({ sucursal: SUC }).first();
    if (ocupado) throw new Error(`La base ya tiene datos de la sucursal ${SUC}: esta prueba necesita ese código libre.`);
    const hoy = new Date();
    await admin('kepler_ods.kdms').insert({ sucursal: SUC, c1: SUC, c2: 'Sucursal de Prueba' });
    await admin('kepler_ods.kdii').insert([
      { sucursal: SUC, c1: '70106', c2: 'LA ROSA BOTA GRANDE 418GR', c11: 'PZA', c83: 'CJA', c84: 18, c85: 'C70106' },
      { sucursal: SUC, c1: '40045', c2: 'PRODUCTO SIN CODIGO DE CAJA', c11: 'PAQ', c83: '', c84: 0, c85: '' },
    ]);
    await admin('kepler_ods.kdm1').insert([
      { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 37, c5: 1, c6: VALE, c9: hoy, c68: hoy, c69: '09:00', c43: 'F' },
      { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 40, c5: 1, c6: FOLIO, c9: hoy, c68: hoy, c69: '10:15', c43: 'F', c37: 37, c39: VALE },
    ]);
    await admin('kepler_ods.kdm2').insert([
      // 2.5 cajas de 18: 2 completas y una con 9 piezas sueltas → 3 etiquetas.
      { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 40, c5: 1, c6: FOLIO, c7: 1, c8: '70106', c9: 45, c10: 'LA ROSA BOTA', c11: 'PZA', c55: 'CJA', c56: '2.5', c58: '18', c32: hoy },
      // Una caja de 100 PAQ de un producto sin código de caja ni factor en Kepler.
      { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 40, c5: 1, c6: FOLIO, c7: 2, c8: '40045', c9: 100, c10: 'PRODUCTO', c11: 'PAQ', c55: 'CJA', c56: '1', c58: '100', c32: hoy },
      // Un renglón en PZA: no lleva etiqueta (Kepler sólo etiqueta CJA/BTO/CUB).
      { sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4: 40, c5: 1, c6: FOLIO, c7: 3, c8: '70106', c9: 6, c10: 'LA ROSA BOTA', c11: 'PZA', c55: 'PZA', c56: '6', c58: '1', c32: hoy },
    ]);
  });

  afterAll(async () => {
    if (admin) {
      await admin('commercial.box_label_prints').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdm2').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdm1').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdii').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdms').where({ sucursal: SUC }).del();
    }
    await knex?.destroy();
    await admin?.destroy();
  });

  it('la cola lee lo sembrado: 2 renglones con etiqueta (el de PZA no), 4 etiquetas, por etiquetar', async () => {
    const r = await svc.ordenes({});
    const o = r.ordenes.find((x) => x.folio === FOLIO);
    expect(o).toMatchObject({ estado: 'por_etiquetar', etiquetas_total: 4, etiquetas_enviadas: 0, vale_folio: VALE, sucursal_nombre: 'Sucursal de Prueba' });
    expect(o!.renglones.map((l) => [l.linea, l.total_etiquetas])).toEqual([[1, 3], [2, 1]]);
    expect(o!.renglones[1].avisos.map((a) => a.tipo)).toEqual(['kepler_no_lee_codigo', 'catalogo_factor_0', 'kepler_caja_otra_unidad']);
    expect(r.ods_ultima_captura).not.toBeNull();
  });

  let fechaPrimera = '';
  it('⭐ primera vez: registra «primera» con la fecha de HOY en CDMX (D6) y devuelve las 3 etiquetas', async () => {
    const r = await svc.imprimir(pedido());
    fechaPrimera = fechaKepler(new Date()) as string;
    expect(r.registros).toEqual([{ linea: 1, motivo: 'primera', fecha_etiqueta: fechaPrimera, consecutivos: [1, 2, 3] }]);
    expect(r.etiquetas.map((e) => [e.consecutivo, e.contenido, e.fecha])).toEqual([
      ['1:3', 'UXC 18', fechaPrimera], ['2:3', 'UXC 18', fechaPrimera], ['3:3', '9 PZA', fechaPrimera],
    ]);
    expect(r.etiquetas[0]).toMatchObject({ codigo: 'C70106', pie: `Suc ${SUC} Sucursal de Prueba`, nombre: 'LA ROSA BOTA GRANDE 418GR' });
    const b = await bitacora();
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ motivo: 'primera', via: 'navegador', consecutivos: [1, 2, 3], enviada_por: 'prueba_etiquetas', vale_folio: VALE });
  });

  it('⭐ reimprimir la 2 sale idéntica aunque Kepler cambie después la UXC del renglón (datos congelados)', async () => {
    await admin('kepler_ods.kdm2').where({ sucursal: SUC, c6: FOLIO, c7: 1 }).update({ c58: '1' }); // el defecto «UXC 1» de Kepler
    const r = await svc.imprimir(pedido({ renglones: [{ linea: 1, consecutivos: [2] }], via: 'tspl' }));
    expect(r.registros).toEqual([{ linea: 1, motivo: 'reimpresion', fecha_etiqueta: fechaPrimera, consecutivos: [2] }]);
    expect(r.etiquetas).toHaveLength(1);
    expect(r.etiquetas[0]).toMatchObject({ consecutivo: '2:3', contenido: 'UXC 18', fecha: fechaPrimera });
    const b = await bitacora();
    expect(b.map((x) => [x.motivo, x.via])).toEqual([['primera', 'navegador'], ['reimpresion', 'tspl']]);
    await admin('kepler_ods.kdm2').where({ sucursal: SUC, c6: FOLIO, c7: 1 }).update({ c58: '18' });
  });

  it('la cola refleja la bitácora: 3 de 4 enviadas, parcial, 1 reimpresión', async () => {
    const o = (await svc.ordenes({})).ordenes.find((x) => x.folio === FOLIO)!;
    expect(o).toMatchObject({ estado: 'parcial', etiquetas_enviadas: 3 });
    expect(o.renglones[0]).toMatchObject({ enviadas: 3, reimpresiones: 1, primera: { fecha_etiqueta: fechaPrimera, usuario: 'prueba_etiquetas' } });
  });

  it('⭐ dos «Imprimir» simultáneos del mismo renglón: UNA sola «primera»', async () => {
    const [a, b] = await Promise.all([svc.imprimir(pedido({ renglones: [{ linea: 2 }] })), svc.imprimir(pedido({ renglones: [{ linea: 2 }] }))]);
    expect([a.registros[0].motivo, b.registros[0].motivo].sort()).toEqual(['primera', 'reimpresion']);
    const filas = await admin('commercial.box_label_prints').where({ sucursal: SUC, folio: FOLIO, linea: 2 });
    expect(filas.filter((f) => f.motivo === 'primera')).toHaveLength(1);
    expect(filas).toHaveLength(2);
  });

  it('la orden queda enviada', async () => {
    const o = (await svc.ordenes({})).ordenes.find((x) => x.folio === FOLIO)!;
    expect(o).toMatchObject({ estado: 'enviada', etiquetas_enviadas: 4, etiquetas_total: 4 });
  });

  it('⛔ NEGATIVA — otra sucursal: 403, y no escribe', async () => {
    const antes = (await bitacora()).length;
    await expect(svc.imprimir(pedido({ sucursal: '08' }))).rejects.toBeInstanceOf(ForbiddenException);
    expect((await bitacora()).length).toBe(antes);
  });

  it('⛔ NEGATIVA — un renglón sin etiqueta (el de PZA) o inexistente: 404', async () => {
    await expect(svc.imprimir(pedido({ renglones: [{ linea: 3 }] }))).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.imprimir(pedido({ renglones: [{ linea: 99 }] }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('⛔ NEGATIVA — consecutivo fuera de rango o pedido mal formado: 400', async () => {
    await expect(svc.imprimir(pedido({ renglones: [{ linea: 1, consecutivos: [9] }] }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.imprimir(pedido({ via: 'zpl' as never }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('⛔ NEGATIVA — y si se saltara el servicio, la BASE rechaza una segunda «primera» (índice único parcial)', async () => {
    const [p] = await admin('commercial.box_label_prints').where({ sucursal: SUC, folio: FOLIO, linea: 1, motivo: 'primera' });
    const { id: _id, created_at: _c, updated_at: _u, ...copia } = p;
    await expect(admin('commercial.box_label_prints').insert({ ...copia, fecha_etiqueta: '0-26' })).rejects.toThrow(/ux_box_label_prints_primera/);
  });

  it('⛔ NEGATIVA — la BASE rechaza consecutivos vacíos (CHECK)', async () => {
    const [p] = await admin('commercial.box_label_prints').where({ sucursal: SUC, folio: FOLIO, linea: 1, motivo: 'primera' });
    const { id: _id, created_at: _c, updated_at: _u, ...copia } = p;
    await expect(admin('commercial.box_label_prints').insert({ ...copia, motivo: 'reimpresion', consecutivos: [] })).rejects.toThrow(/check/i);
  });
});
