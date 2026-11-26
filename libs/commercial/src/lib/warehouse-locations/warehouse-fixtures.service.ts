import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import {
  FIXTURE_KINDS,
  cabeEnElCroquis,
  defaultPickSequence,
  expandFixture,
  formatLocationCode,
  nombrePieza,
  piezasDerivadas,
  type FixtureKind,
  type LocationZone,
  type WarehouseFixture,
} from '@megadulces/contracts';
import { almacenDeUbicaciones, contextoDeAlcance } from './warehouse-locations-scope';

/** Lo que la pantalla manda para crear o mover una pieza. */
export interface CrearPiezaBody {
  warehouse_id: string;
  zona: LocationZone;
  tipo: FixtureKind;
  pasillo?: string | null;
  racks: number;
  niveles: number;
  fila?: number | null;
  columna?: number | null;
  label?: string | null;
}

export interface MoverPiezaBody {
  fila?: number | null;
  columna?: number | null;
  label?: string | null;
}

export interface CroquisResponse {
  warehouse: { id: string; code: string; name: string };
  zona: LocationZone;
  piezas: WarehouseFixture[];
  /** Ubicaciones de la zona que todavía NO cuelgan de ninguna pieza: el hueco, dicho (ADR-056). */
  sin_pieza: number;
}

const COLUMNAS = ['id', 'warehouse_id', 'zona', 'tipo', 'pasillo', 'racks', 'niveles', 'fila', 'columna', 'orden', 'label'] as const;

/**
 * `[UB.PL]` El croquis de una sucursal: las **piezas** (muebles) de un almacén y su lugar.
 *
 * Existe porque la captura masiva sólo sabía generar `pasillos × racks × niveles`, y todo lo que no
 * era un pasillo tenía que robarse una letra: medido el 2026-11-26, **60 de 315 ubicaciones de Padre
 * Hidalgo (19 %)** eran cabeceras dadas de alta como «pasillos D a H».
 *
 * ⭐ Crear una pieza **crea sus ubicaciones**; moverla **no toca ninguna**: el lugar en el croquis y
 * los códigos son cosas distintas, y por eso acomodar la tienda nunca puede romper una etiqueta.
 */
@Injectable()
export class WarehouseFixturesService {
  private readonly logger = new Logger(WarehouseFixturesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  private zonaValida(z: unknown): LocationZone {
    if (z !== 'T' && z !== 'B') throw new BadRequestException('Elige la zona: T (tienda) o B (bodega).');
    return z;
  }

  /** El croquis de un almacén y una zona. Si nadie acomodó nada todavía, las piezas vienen sin lugar. */
  async croquis(warehouseIdRaw: string, zonaRaw: string): Promise<CroquisResponse> {
    this.tenantCtx.requireTenantId();
    const zona = this.zonaValida(zonaRaw);
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(warehouseIdRaw ?? '').toLowerCase(), false);
      const piezas = await trx('commercial.warehouse_fixtures')
        .where({ warehouse_id: wh.id, zona })
        .whereNull('deleted_at')
        .orderBy(['orden', 'fila', 'columna', 'pasillo'])
        .select(...COLUMNAS);
      const [{ n }] = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: wh.id, zona, familia: 'ubicacion' })
        .whereNull('fixture_id')
        .whereNot('estado', 'baja')
        .count({ n: '*' });
      return {
        warehouse: { id: wh.id, code: wh.code, name: wh.name },
        zona,
        piezas: piezas.map(aPieza),
        sin_pieza: Number(n) || 0,
      };
    });
  }

  /**
   * `[UB.PL.2]` Deriva las piezas de un catálogo que ya existe y cuelga cada ubicación de la suya.
   * **No crea ni borra una sola ubicación** y no toca ninguna asignación: es lo que permite que
   * Padre Hidalgo quede configurado sin que nadie recapture sus 315 ubicaciones.
   *
   * Es idempotente: correrla dos veces deja lo mismo.
   */
  async derivar(warehouseIdRaw: string): Promise<{ piezas: number; ubicaciones: number; ya_tenian: number }> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(warehouseIdRaw ?? '').toLowerCase(), true);
      const ubicaciones = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: wh.id })
        .select('id', 'zona', 'pasillo', 'rack', 'nivel', 'tipo', 'familia', 'fixture_id');
      const yaTenian = ubicaciones.filter((u: { fixture_id: string | null }) => u.fixture_id).length;
      const specs = piezasDerivadas(ubicaciones);
      const userId = this.tenantCtx.get()?.userId || null;

      let creadas = 0;
      let colgadas = 0;
      for (const s of specs) {
        const existente = await trx('commercial.warehouse_fixtures')
          .where({ warehouse_id: wh.id, zona: s.zona, pasillo: s.pasillo })
          .whereNull('deleted_at')
          .first('id');
        let fixtureId = existente?.id as string | undefined;
        if (!fixtureId) {
          const [row] = await trx('commercial.warehouse_fixtures')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              warehouse_id: wh.id,
              zona: s.zona,
              tipo: s.tipo,
              pasillo: s.pasillo,
              racks: s.racks,
              niveles: s.niveles,
              created_by: userId,
              updated_by: userId,
            })
            .returning('id');
          fixtureId = row.id as string;
          creadas++;
        }
        const n = await trx('commercial.warehouse_bins')
          .where({ warehouse_id: wh.id, zona: s.zona, pasillo: s.pasillo, familia: 'ubicacion' })
          .whereNull('fixture_id')
          .update({ fixture_id: fixtureId, updated_by: userId });
        colgadas += Number(n) || 0;
      }
      this.logger.log(`[UB.PL.2] ${wh.name}: ${creadas} pieza(s) derivada(s), ${colgadas} ubicación(es) colgada(s), ${yaTenian} ya tenían`);
      return { piezas: creadas, ubicaciones: colgadas, ya_tenian: yaTenian };
    });
  }

  /**
   * Crea una pieza **y las ubicaciones que le corresponden**. Reemplaza al rango cartesiano: lo que
   * antes era «pasillos A–H × racks × niveles» ahora es una pieza que sabe qué es y qué genera.
   */
  async crear(body: CrearPiezaBody): Promise<WarehouseFixture> {
    this.tenantCtx.requireTenantId();
    const zona = this.zonaValida(body?.zona);
    const forma = FIXTURE_KINDS[body?.tipo];
    if (!forma) throw new BadRequestException(`No conozco una pieza de tipo «${String(body?.tipo)}».`);
    const expandido = expandFixture({ zona, tipo: body.tipo, pasillo: body.pasillo ?? null, racks: body.racks, niveles: body.niveles });
    if (!expandido.ok) throw new BadRequestException(expandido.motivo);

    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(body.warehouse_id ?? '').toLowerCase(), true);
      const existentes: WarehouseFixture[] = (
        await trx('commercial.warehouse_fixtures').where({ warehouse_id: wh.id }).whereNull('deleted_at').select(...COLUMNAS)
      ).map(aPieza);
      const cabe = cabeEnElCroquis(
        { zona, pasillo: body.pasillo ?? null, fila: body.fila ?? null, columna: body.columna ?? null },
        existentes,
      );
      if (!cabe.ok) throw new ConflictException(cabe.motivo);

      const userId = this.tenantCtx.get()?.userId || null;
      const [row] = await trx('commercial.warehouse_fixtures')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          zona,
          tipo: body.tipo,
          pasillo: body.pasillo ?? null,
          racks: body.racks,
          niveles: body.niveles,
          fila: body.fila ?? null,
          columna: body.columna ?? null,
          label: (body.label ?? '').trim() || null,
          created_by: userId,
          updated_by: userId,
        })
        .returning([...COLUMNAS])
        .catch((e: { code?: string }) => {
          // Los índices únicos de la base dicen lo mismo que `cabeEnElCroquis`: son la red por si
          // dos personas crean la misma pieza a la vez.
          if (e?.code === '23505') throw new ConflictException('Esa pieza ya existe en el croquis de este almacén.');
          throw e;
        });

      // Las ubicaciones de la pieza. Las que ya existan se dejan como están y se cuelgan de ella:
      // crear una pieza nunca pisa una ubicación que alguien ya usó.
      let nuevas = 0;
      for (const p of expandido.partes) {
        const code = formatLocationCode(p);
        const ya = await trx('commercial.warehouse_bins').where({ warehouse_id: wh.id }).whereRaw('UPPER(code) = ?', [code]).first('id');
        if (ya) {
          await trx('commercial.warehouse_bins').where({ id: ya.id }).update({ fixture_id: row.id, updated_by: userId });
          continue;
        }
        await trx('commercial.warehouse_bins').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          code,
          familia: 'ubicacion',
          zona: p.zona,
          pasillo: p.pasillo,
          rack: p.rack,
          nivel: p.nivel,
          tipo: tipoDeUso(body.tipo),
          fixture_id: row.id,
          pick_sequence: defaultPickSequence(p),
          created_by: userId,
          updated_by: userId,
        });
        nuevas++;
      }
      this.logger.log(`[UB.PL] ${nombrePieza(aPieza(row))} en ${wh.name}: ${nuevas} ubicación(es) nueva(s) de ${expandido.total}`);
      return aPieza(row);
    });
  }

  /**
   * Mueve o renombra una pieza. ⭐ **No toca una sola ubicación**: acomodar la tienda en el croquis
   * no puede cambiar un código ni invalidar una etiqueta impresa.
   */
  async mover(id: string, body: MoverPiezaBody): Promise<WarehouseFixture> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const pieza = await trx('commercial.warehouse_fixtures').where({ id }).whereNull('deleted_at').first(...COLUMNAS);
      if (!pieza) throw new NotFoundException('Esa pieza no existe.');
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(pieza.warehouse_id).toLowerCase(), true);
      const existentes: WarehouseFixture[] = (
        await trx('commercial.warehouse_fixtures').where({ warehouse_id: wh.id }).whereNull('deleted_at').select(...COLUMNAS)
      ).map(aPieza);
      const cabe = cabeEnElCroquis(
        { id, zona: pieza.zona, pasillo: pieza.pasillo, fila: body.fila ?? null, columna: body.columna ?? null },
        existentes,
      );
      if (!cabe.ok) throw new ConflictException(cabe.motivo);

      const [row] = await trx('commercial.warehouse_fixtures')
        .where({ id })
        .update({
          fila: body.fila ?? null,
          columna: body.columna ?? null,
          ...(body.label === undefined ? {} : { label: (body.label ?? '').trim() || null }),
          updated_at: trx.fn.now(),
          updated_by: this.tenantCtx.get()?.userId || null,
        })
        .returning([...COLUMNAS]);
      return aPieza(row);
    });
  }
}

function aPieza(r: Record<string, unknown>): WarehouseFixture {
  return {
    id: String(r.id),
    warehouse_id: String(r.warehouse_id),
    zona: r.zona as LocationZone,
    tipo: r.tipo as FixtureKind,
    pasillo: (r.pasillo as string | null) ?? null,
    racks: Number(r.racks) || 0,
    niveles: Number(r.niveles) || 0,
    fila: r.fila == null ? null : Number(r.fila),
    columna: r.columna == null ? null : Number(r.columna),
    orden: r.orden == null ? null : Number(r.orden),
    label: (r.label as string | null) ?? null,
  };
}

/**
 * Del tipo de MUEBLE al tipo de USO que lleva cada ubicación que genera. Es la traducción inversa de
 * `tipoDePieza`: una cabecera produce ubicaciones de `tienda_cabecera`, que es lo que ya usaba Padre
 * Hidalgo antes de que existiera la pieza.
 */
function tipoDeUso(tipo: FixtureKind): string | null {
  if (tipo === 'cabecera') return 'tienda_cabecera';
  if (tipo === 'anaquel') return 'tienda_piso';
  return null;
}
