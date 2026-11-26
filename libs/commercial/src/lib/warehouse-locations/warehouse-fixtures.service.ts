import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import {
  CROQUIS_FILAS_MAX,
  RACKS_DE_CARA,
  acomodarCara,
  carasCoherentes,
  carasPorOmision,
  FIXTURE_KINDS,
  cabeEnElCroquis,
  defaultPickSequence,
  expandFixture,
  formatLocationCode,
  nombrePieza,
  piezasDerivadas,
  type AcomodoBody,
  type AcomodoCarasBody,
  type CaraBody,
  type PiezaBody,
  type RacksDeCara,
  type CrearPiezaBody,
  type FixtureFace,
  type MiraHacia,
  type CroquisResponse,
  type FixtureKind,
  type LocationZone,
  type MoverPiezaBody,
  type WarehouseFixture,
} from '@megadulces/contracts';
import { almacenDeUbicaciones, contextoDeAlcance } from './warehouse-locations-scope';

// Los tipos del contrato HTTP viven en `contracts`, no acá: la pantalla los necesita y una app de
// Angular no puede importar del backend.

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
        caras: (await this.leerCaras(trx, wh.id, zona)).map(aCara),
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
        // [UB.PL.11] Toda pieza viva tiene sus caras, tambien las que ya existian antes de la
        // migracion: se piden SIEMPRE, no solo al crearla, y el ON CONFLICT las hace idempotentes.
        await this.darleCaras(trx, { id: fixtureId, warehouse_id: wh.id, zona: s.zona, tipo: s.tipo });
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
      // [UB.PL.11] La pieza nace con sus caras, sin lugar: donde esta el mueble lo dice la tienda.
      await this.darleCaras(trx, aPieza(row));
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

  // ── `[UB.PL.11]` Las caras: lo que de verdad se acomoda ──────────────────────────────────────

  /** Las caras de un almacén y zona. Vive aparte porque la usan `croquis` y `acomodo`. */
  private leerCaras(trx: Knex.Transaction, warehouseId: string, zona: LocationZone) {
    return trx('commercial.warehouse_fixture_faces')
      .where({ warehouse_id: warehouseId, zona })
      .whereNull('deleted_at')
      .orderBy(['fila', 'columna', 'mira'])
      .select(...COLUMNAS_CARA);
  }

  /**
   * `[UB.PL.11]` Le da a una pieza las caras que le tocan por su tipo (dos si es anaquel de
   * pasillo, una si no), **sin lugar**: dónde está cada mueble sólo lo sabe quien mira la tienda.
   * Idempotente — `ON CONFLICT DO NOTHING` sobre el índice de «una cara por pieza».
   */
  private async darleCaras(trx: Knex.Transaction, pieza: Pick<WarehouseFixture, 'id' | 'warehouse_id' | 'zona' | 'tipo'>): Promise<void> {
    const filas = carasPorOmision(pieza.tipo).map((modo, i) => ({
      tenant_id: trx.raw('public.current_tenant_id()'),
      fixture_id: pieza.id,
      warehouse_id: pieza.warehouse_id,
      zona: pieza.zona,
      slot: i + 1,
      racks_modo: modo,
    }));
    if (!filas.length) return;
    await trx('commercial.warehouse_fixture_faces').insert(filas).onConflict(['tenant_id', 'fixture_id', 'slot']).ignore();
  }

  /**
   * `[UB.PL.11]` **Soltar una cara en una celda de la planta.** Un gesto, una petición: el lugar
   * nuevo lo calcula `acomodarCara` del contrato y acá se valida contra lo que hay en la base.
   *
   * ⭐ No hace falta escribir en dos pasadas como `[UB.PL.8]`: el índice único incluye `mira`, y un
   * gesto mueve **una sola cara** a una celda que la validación ya comprobó libre de ese lado.
   *
   * ⭐ No toca ninguna ubicación ni ningún código: acomodar la tienda no puede invalidar una
   * etiqueta ya pegada.
   */
  async acomodoDeCaras(body: AcomodoCarasBody): Promise<{ movidas: number; caras: FixtureFace[] }> {
    this.tenantCtx.requireTenantId();
    const zona = this.zonaValida(body?.zona);
    const gesto = body?.gesto;
    if (!gesto?.id) throw new BadRequestException('Falta decir qué cara se mueve.');

    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(body.warehouse_id ?? '').toLowerCase(), true);
      const caras: FixtureFace[] = (await this.leerCaras(trx, wh.id, zona)).map(aCara);
      // ⭐ El control de pertenencia: la cara tiene que ser de ESTE almacén y ESTA zona. Se mide
      // contra lo que la base devolvió, no contra lo que mandó la pantalla.
      if (!caras.some((c) => c.id === gesto.id)) throw new NotFoundException('Esa cara no es de este croquis.');

      const r = acomodarCara(caras, gesto);
      if (!r.ok) throw new ConflictException(r.motivo);

      const usuario = this.tenantCtx.get()?.userId || null;
      for (const c of r.cambios) {
        await trx('commercial.warehouse_fixture_faces')
          .where({ id: c.id })
          .update({ fila: c.fila, columna: c.columna, mira: c.mira, updated_at: trx.fn.now(), updated_by: usuario });
      }
      const despues: FixtureFace[] = (await this.leerCaras(trx, wh.id, zona)).map(aCara);
      if (r.cambios.length) this.logger.log(`[UB.PL.11] croquis de ${wh.code}/${zona}: 1 cara acomodada`);
      return { movidas: r.cambios.length, caras: despues };
    });
  }


  // ── `[UB.PL.12]` La cara y la pieza se configuran desde la pantalla ──────────────────────────

  /** Las caras vivas de una pieza, con su almacén verificado contra el alcance de quien pide. */
  private async piezaYsusCaras(trx: Knex.Transaction, fixtureId: string, ctx: Awaited<ReturnType<typeof contextoDeAlcance>>) {
    const pieza = await trx('commercial.warehouse_fixtures').where({ id: fixtureId }).whereNull('deleted_at').first(...COLUMNAS);
    if (!pieza) throw new NotFoundException('Esa pieza no existe.');
    const wh = await almacenDeUbicaciones(trx, this.scope, ctx, String(pieza.warehouse_id).toLowerCase(), true);
    const caras: FixtureFace[] = (
      await trx('commercial.warehouse_fixture_faces').where({ fixture_id: fixtureId }).whereNull('deleted_at').select(...COLUMNAS_CARA)
    ).map(aCara);
    return { pieza: aPieza(pieza), caras, wh };
  }

  /**
   * `[UB.PL.12]` **Agrega una cara a un mueble.** Hasta cuatro: una isla se ve por los cuatro
   * costados. Nace sin lugar — ponerla en la planta es otro acto.
   */
  async agregarCara(body: CaraBody): Promise<FixtureFace[]> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const { pieza, caras } = await this.piezaYsusCaras(trx, String(body?.fixture_id ?? ''), ctx);
      const nueva = this.caraValida(body, pieza, caras, null);
      const usados = new Set(caras.map((c) => c.slot));
      const slot = [1, 2, 3, 4].find((s) => !usados.has(s));
      if (!slot) throw new ConflictException('Un mueble tiene cuatro costados como mucho.');
      await trx('commercial.warehouse_fixture_faces').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        fixture_id: pieza.id,
        warehouse_id: pieza.warehouse_id,
        zona: pieza.zona,
        slot,
        ...nueva,
        created_by: this.tenantCtx.get()?.userId || null,
        updated_by: this.tenantCtx.get()?.userId || null,
      });
      return (await trx('commercial.warehouse_fixture_faces').where({ fixture_id: pieza.id }).whereNull('deleted_at').select(...COLUMNAS_CARA)).map(aCara);
    });
  }

  /** `[UB.PL.12]` Cambia qué racks lleva una cara, o cómo se llama. No la mueve de lugar. */
  async cambiarCara(id: string, body: CaraBody): Promise<FixtureFace[]> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const cara = await trx('commercial.warehouse_fixture_faces').where({ id }).whereNull('deleted_at').first('fixture_id');
      if (!cara) throw new NotFoundException('Esa cara no existe.');
      const { pieza, caras } = await this.piezaYsusCaras(trx, String(cara.fixture_id), ctx);
      const cambios = this.caraValida(body, pieza, caras, id);
      await trx('commercial.warehouse_fixture_faces').where({ id }).update({
        ...cambios,
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      });
      return (await trx('commercial.warehouse_fixture_faces').where({ fixture_id: pieza.id }).whereNull('deleted_at').select(...COLUMNAS_CARA)).map(aCara);
    });
  }

  /**
   * `[UB.PL.12]` Quita una cara del mueble. ⭐ Se RETIRA (`deleted_at`), no se borra: su lugar en
   * la planta es trabajo de alguien y conviene poder saber que existió.
   */
  async quitarCara(id: string): Promise<FixtureFace[]> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const cara = await trx('commercial.warehouse_fixture_faces').where({ id }).whereNull('deleted_at').first('fixture_id');
      if (!cara) throw new NotFoundException('Esa cara no existe.');
      const { pieza, caras } = await this.piezaYsusCaras(trx, String(cara.fixture_id), ctx);
      if (caras.length <= 1) throw new ConflictException('Un mueble necesita al menos una cara: si sobra el mueble entero, quítalo del croquis.');
      await trx('commercial.warehouse_fixture_faces').where({ id }).update({
        deleted_at: trx.fn.now(),
        deleted_by: this.tenantCtx.get()?.userId || null,
      });
      return (await trx('commercial.warehouse_fixture_faces').where({ fixture_id: pieza.id }).whereNull('deleted_at').select(...COLUMNAS_CARA)).map(aCara);
    });
  }

  /**
   * `[UB.PL.12]` Renombra una pieza o le cambia el tipo, los racks o los niveles.
   *
   * ⛔ **NO crea ni borra ubicaciones.** Subir los racks de 17 a 20 dice cómo es el mueble; dar de
   * alta los códigos que faltan sigue siendo la captura, que es donde se ve cuántos se crean.
   */
  async editarPieza(id: string, body: PiezaBody): Promise<WarehouseFixture> {
    this.tenantCtx.requireTenantId();
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations');
    return this.tk.run(async (trx) => {
      const { pieza, caras } = await this.piezaYsusCaras(trx, id, ctx);
      const tipo = body.tipo === undefined ? pieza.tipo : body.tipo;
      if (!FIXTURE_KINDS[tipo]) throw new BadRequestException('Ese tipo de mueble no existe.');
      const racks = body.racks === undefined ? pieza.racks : Number(body.racks);
      const niveles = body.niveles === undefined ? pieza.niveles : Number(body.niveles);
      const forma = FIXTURE_KINDS[tipo];
      if (!(Number.isInteger(racks) && racks >= 0 && racks <= forma.racksMax)) {
        throw new BadRequestException(`${forma.label}: de 0 a ${forma.racksMax} racks.`);
      }
      if (!(Number.isInteger(niveles) && niveles >= 0 && niveles <= forma.nivelesMax)) {
        throw new BadRequestException(`${forma.label}: de 0 a ${forma.nivelesMax} niveles.`);
      }
      // ⭐ El control que importa: bajar los racks puede dejar dos caras pisándose, porque los
      // tramos se recortan. Se mide contra los racks NUEVOS, no contra los que tenía.
      const coherentes = carasCoherentes(caras, racks);
      if (!coherentes.ok) throw new ConflictException(coherentes.motivo);

      const [row] = await trx('commercial.warehouse_fixtures').where({ id }).update({
        tipo,
        racks,
        niveles,
        ...(body.label === undefined ? {} : { label: (body.label ?? '').trim() || null }),
        updated_at: trx.fn.now(),
        updated_by: this.tenantCtx.get()?.userId || null,
      }).returning([...COLUMNAS]);
      this.logger.log(`[UB.PL.12] ${nombrePieza(aPieza(row))}: tipo ${tipo}, ${racks} rack(s), ${niveles} nivel(es)`);
      return aPieza(row);
    });
  }

  /** Lo que se puede escribir de una cara, ya validado contra su pieza y sus hermanas. */
  private caraValida(body: CaraBody, pieza: WarehouseFixture, caras: FixtureFace[], excepto: string | null) {
    const modo = body?.racks_modo;
    if (!RACKS_DE_CARA.some((m) => m.modo === modo)) throw new BadRequestException('Falta decir qué racks lleva esta cara.');
    const desde = modo === 'rango' ? Number(body.rack_desde) : null;
    const hasta = modo === 'rango' ? Number(body.rack_hasta) : null;
    if (modo === 'rango') {
      if (!Number.isInteger(desde) || !Number.isInteger(hasta) || (desde as number) < 1 || (hasta as number) < (desde as number)) {
        throw new BadRequestException('Un tramo va de un rack a otro, y el primero no puede pasar al segundo.');
      }
    }
    const propuesta = { id: excepto ?? 'nueva', racks_modo: modo, rack_desde: desde, rack_hasta: hasta };
    const juntas = [...caras.filter((c) => c.id !== excepto), propuesta];
    const coherentes = carasCoherentes(juntas, pieza.racks);
    if (!coherentes.ok) throw new ConflictException(coherentes.motivo);
    return {
      racks_modo: modo,
      rack_desde: desde,
      rack_hasta: hasta,
      ...(body.label === undefined ? {} : { label: (body.label ?? '').trim() || null }),
    };
  }

}

const COLUMNAS_CARA = ['id', 'fixture_id', 'slot', 'racks_modo', 'rack_desde', 'rack_hasta', 'label', 'fila', 'columna', 'mira'] as const;

function aCara(r: Record<string, unknown>): FixtureFace {
  return {
    id: String(r.id),
    fixture_id: String(r.fixture_id),
    slot: Number(r.slot) || 1,
    racks_modo: (r.racks_modo as RacksDeCara) ?? 'todos',
    rack_desde: r.rack_desde == null ? null : Number(r.rack_desde),
    rack_hasta: r.rack_hasta == null ? null : Number(r.rack_hasta),
    label: (r.label as string | null) ?? null,
    fila: r.fila == null ? null : Number(r.fila),
    columna: r.columna == null ? null : Number(r.columna),
    mira: (r.mira as MiraHacia | null) ?? null,
  };
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
