import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import {
  CORTE_SUCURSALES, HORAS_SIN_LLEGADAS, MOTIVO_OTRA_SUCURSAL, VENTANA_REFERENCIA, avisosSinRegistro, diasEntre, fueraDeLaBandeja,
  laVeLaSucursal, motivoSinRegistro, pistasDeLaBandeja, registroDeFacturas, rfcCompatible, serieFolio, sucursalPropuesta, sucursalesQueLaVen,
  type AcreedorDeLaFactura, type AlcanceDelDescarte, type BandejaDeFacturasSat, type DescartarFacturaSatDto, type DetalleDeFacturaSat,
  type DocumentoDeGasto, type FacturaDescartada, type FacturaPorRegistrar, type FacturaSat, type FacturaYaRegistrada,
  type FuentesDelRegistro, type PagoDeGasto, type RegistroDeLaFactura, type ValeConFactura, type ValeSinFactura, type ViaRfcDelAcreedor,
} from '@megadulces/contracts';

import { construirPadron, resolverRfcAcreedor, type ViaRfc } from '../../contpaqi/rfc-acreedor';
import { conceptosDelCfdi } from '../../goods-receipt-proofs/fuente-renglones';
import { sqlDiaDelCfdi } from '../../shared/dia-del-cfdi.sql';

/** La vía del contrato y la del primitivo CP.8.71 son la misma: si una cambia, esto deja de compilar. */
const _mismaVia: ViaRfcDelAcreedor = '' as ViaRfc;
void _mismaVia;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUCURSALES: readonly string[] = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
/** Lo pesado (Kepler y las facturas) se lee una vez por minuto; vales y descartes, en cada petición. */
const VIGENCIA_MS = 60_000;
/** El padrón de emisores: 540 días de facturas recibidas (lo que usó la medición). */
const DIAS_DEL_PADRON = 540;

/**
 * El día de la factura. ⚠️ `fiscal.cfdis.fecha` tiene DOS convenciones, medidas en prod (2026-11-15, 2,005 de 2,005
 * contra el atributo `Fecha` del XML): la descarga de ContPAQi guarda la hora LOCAL como si fuera UTC, y la descarga
 * masiva del SAT guarda el instante real. Leerla siempre en hora de México corría un día las de 00:00 a 05:59.
 * La lectura vive en `shared/dia-del-cfdi.sql.ts` (`[PGP.225]` la necesitó también para el freno de la PUE).
 */
const SQL_DIA_DEL_CFDI = sqlDiaDelCfdi('c');
/**
 * El IVA trasladado. La descarga de ContPAQi lo trae resumido (`iva_trasladado`); la descarga masiva guarda el nodo
 * crudo del XML (`Traslados.Traslado`, un objeto o una lista): ahí es la suma de los traslados del impuesto 002.
 * Nunca `total_trasladados`, que incluye el IEPS.
 */
const SQL_IVA_DEL_CFDI = `COALESCE(nullif(c.impuestos ->> 'iva_trasladado', '')::float8,
  (SELECT sum(nullif(t ->> '@_Importe', '')::float8)
     FROM jsonb_array_elements(CASE jsonb_typeof(c.impuestos #> '{Traslados,Traslado}')
                                 WHEN 'array' THEN c.impuestos #> '{Traslados,Traslado}'
                                 WHEN 'object' THEN jsonb_build_array(c.impuestos #> '{Traslados,Traslado}')
                                 ELSE '[]'::jsonb END) t
    WHERE t ->> '@_Impuesto' = '002'))`;

interface ClaveDeAcreedor {
  rfc: string;
  /** El RFC tal como lo tiene Kepler (`kdxd.c10`): con él valida «Mandar a firma». */
  rfcKepler: string | null;
  via: ViaRfc;
  nombre: string | null;
  sucursales: Set<string>;
}

/** Lo que se lee de Kepler y del SAT, igual para todas las sucursales. */
interface Lectura {
  /** RFC del emisor → claves de acreedor de gasto (la escalera ya aplicada). */
  acreedoresDe: Map<string, Set<string>>;
  claves: Map<string, ClaveDeAcreedor>;
  /** El universo de la bandeja (DS18). */
  facturas: FacturaSat[];
  /** De esos acreedores, las que quedaron fuera por mercancía, activo, retención o moneda. */
  fuera: number;
  /** Los X-A-15 y X-A-10 vivos de TODOS los acreedores desde 30 días antes del corte. */
  documentos: DocumentoDeGasto[];
  pagos: PagoDeGasto[];
  /** RFC del emisor → sucursal → documentos vivos desde el corte. */
  historia: Map<string, Map<string, number>>;
  ultimaLlegada: string | null;
}

interface Descarte {
  uuid: string;
  sucursal: string;
  alcance: AlcanceDelDescarte;
  motivo: string;
  por: string;
  cuando: string;
}

/** Lo que se lee fresco en cada petición: los vales de la Suite y los descartes. */
interface Fresco {
  vales: ValeConFactura[];
  valesSinFactura: ValeSinFactura[];
  descartes: Descarte[];
}

/** El registro y sus pistas, calculados sobre UNA lectura y lo fresco que los alimenta (su `firma`). */
interface RegistroCalculado {
  firma: string;
  registro: Map<string, RegistroDeLaFactura>;
  pistas: ReturnType<typeof pistasDeLaBandeja>;
}

/**
 * Lo fresco que cambia el registro: los vales (con y sin factura) y lo sacado para todas. Ordenado, para que dos
 * lecturas iguales firmen igual aunque la base las devuelva en otro orden. Lo que sólo se ve (motivo, quién, de qué
 * sucursal es un «no es de aquí») no entra: no cambia qué documento cubre a qué factura.
 */
function firmaDelRegistro(fresco: Fresco): string {
  const orden = (xs: string[]) => xs.sort().join('\n');
  return [
    orden(fresco.vales.map((v) => [v.id, v.uuid, v.sucursal, v.folio_solicitud, v.status].join('|'))),
    orden(fresco.valesSinFactura.map((v) => [v.id, v.sucursal, v.folio_solicitud, v.acreedor, v.total, v.fecha].join('|'))),
    orden(fresco.descartes.filter((d) => d.alcance === 'todas').map((d) => d.uuid)),
  ].join('\n§\n');
}

/**
 * `[PGP.122]` S.13 — **La bandeja de facturas del SAT por registrar** (anexo S §14).
 *
 * Junta sus fuentes y deja la regla al contrato (`factura-sat.contract.ts`, DS24): los acreedores de gasto de Kepler
 * con su RFC reparado (la escalera de `resolverRfcAcreedor`, CP.8.71), las facturas recibidas desde el corte, los
 * gastos de Kepler (X-A-15 con sus X-A-10, de todos los acreedores) y los pagos X-D-26, los vales de la Suite (con y
 * sin factura ligada) y los descartes. Sin tablas copiadas ni importers (regla 1): el ODS se lee vivo.
 *
 * ⛔ El alcance lo decide el SERVIDOR (ScopeService, ADR-050): quien sólo ve su sucursal no lee la bandeja de otra
 * ni de 00, ni abre, descarga o descarta sus facturas.
 *
 * Medido en prod (sólo lectura, 2026-11-15): las lecturas tardan ~0.8 s en frío (2,520 claves por sucursal,
 * 699 emisores, 1,808 facturas, 4,564 documentos y 1,269 pagos); por eso lo pesado se guarda un minuto.
 */
@Injectable()
export class FacturasSatService {
  private readonly logger = new Logger(FacturasSatService.name);
  private readonly lecturas = new Map<string, { at: number; datos: Promise<Lectura> }>();
  /** El registro de cada lectura viva, con la firma de lo fresco que lo alimentó (se va con su lectura). */
  private readonly registros = new WeakMap<Lectura, RegistroCalculado>();

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  // ── La bandeja ───────────────────────────────────────────────────────────────────────────────

  async bandeja(sucursal: string): Promise<BandejaDeFacturasSat> {
    const s = await this.permitida(sucursal);
    const lectura = await this.leer();
    return this.tk.run(async (trx) => this.armar(s, lectura, await this.fresco(trx)));
  }

  async detalle(uuid: string, sucursal: string): Promise<DetalleDeFacturaSat> {
    const u = this.uuid(uuid);
    const s = await this.permitida(sucursal);
    const lectura = await this.leer();
    return this.tk.run(async (trx) => {
      const b = this.armar(s, lectura, await this.fresco(trx));
      const por = b.por_registrar.find((f) => f.uuid === u) ?? null;
      const registrada = b.registradas.find((f) => f.uuid === u) ?? null;
      const descartada = b.descartadas.find((f) => f.uuid === u) ?? null;
      if (!por && !registrada && !descartada) throw new NotFoundException('Esa factura no está en la bandeja de esta sucursal');
      const x = (await trx.raw(`SELECT xml FROM fiscal.cfdis WHERE lower(uuid) = ? AND rol = 'recibidas' AND tipo_comprobante = 'I' LIMIT 1`, [u])).rows[0] as { xml: string | null } | undefined;
      const conceptos = conceptosDelCfdi(x?.xml ?? null)
        .map((c) => ({ descripcion: String(c.descripcion ?? ''), cantidad: c.cantidad, unidad: c.unidad, importe: c.importe }));
      return { uuid: u, por_registrar: por, registrada, descartada, conceptos, tiene_xml: !!x?.xml };
    });
  }

  /**
   * El XML tal cual, sólo de facturas que la bandeja de ESA sucursal muestra (no abre el `/fiscal/cfdi` a quien no
   * tiene ese permiso, ni las facturas de otras sucursales).
   */
  async xml(uuid: string, sucursal: string): Promise<{ nombre: string; xml: string }> {
    const u = this.uuid(uuid);
    const s = await this.permitida(sucursal);
    const lectura = await this.leer();
    const f = lectura.facturas.find((x) => x.uuid === u);
    if (!f) throw new NotFoundException('Esa factura no es de la bandeja de gastos');
    return this.tk.run(async (trx) => {
      const b = this.armar(s, lectura, await this.fresco(trx));
      if (![...b.por_registrar, ...b.registradas, ...b.descartadas].some((x) => x.uuid === u)) throw new NotFoundException('Esa factura no está en la bandeja de esta sucursal');
      const x = (await trx.raw(`SELECT xml FROM fiscal.cfdis WHERE lower(uuid) = ? AND rol = 'recibidas' AND tipo_comprobante = 'I' LIMIT 1`, [u])).rows[0] as { xml: string | null } | undefined;
      if (!x?.xml) throw new NotFoundException('La factura no tiene su XML guardado');
      return { nombre: nombreDelXml(f), xml: x.xml };
    });
  }

  // ── Sacar de la bandeja y deshacer (DS23) ────────────────────────────────────────────────────

  async descartar(uuid: string, dto: DescartarFacturaSatDto, quien: string): Promise<FacturaDescartada> {
    this.tenantCtx.requireTenantId();
    const u = this.uuid(uuid);
    const s = await this.permitida(dto?.sucursal);
    const alcance = dto?.alcance;
    if (alcance !== 'todas' && alcance !== 'sucursal') throw new BadRequestException('Di si sale sólo de esta sucursal o de todas');
    if (alcance === 'sucursal' && s === '00') throw new BadRequestException('Desde 00 se ven todas: sólo se puede sacar para todas');
    const motivo = (String(dto?.motivo ?? '').trim().replace(/\s+/g, ' ') || (alcance === 'sucursal' ? MOTIVO_OTRA_SUCURSAL : ''));
    // Caracteres reales, como `length()` de Postgres (un emoji son dos unidades de JavaScript).
    const largo = [...motivo].length;
    if (largo < 3 || largo > 300) throw new BadRequestException('Escribe el motivo (de 3 a 300 letras): queda para todos');
    const actor = String(quien ?? '').trim();
    if (!actor) throw new BadRequestException('No se sabe quién la saca: la sesión no trae usuario');
    const lectura = await this.leer();
    return this.tk.run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasTable('expense_sat_invoice_dismissals'))) {
        throw new ConflictException('Sacar de la bandeja todavía no está habilitado en esta base (falta la migración de S.13)');
      }
      const b = this.armar(s, lectura, await this.fresco(trx));
      const f = b.por_registrar.find((x) => x.uuid === u);
      if (!f) {
        const r = b.registradas.find((x) => x.uuid === u);
        if (r) throw new ConflictException('Esa factura ya está registrada: no hace falta sacarla');
        if (b.descartadas.some((x) => x.uuid === u)) throw new ConflictException('Esa factura ya se sacó de esta bandeja');
        throw new NotFoundException('Esa factura no está en la bandeja de esta sucursal');
      }
      try {
        const [fila] = await trx('finance.expense_sat_invoice_dismissals').insert({
          tenant_id: trx.raw('public.current_tenant_id()'), cfdi_uuid: u, sucursal: s, scope: alcance, reason: motivo,
          created_by: actor, updated_by: actor,
        }).returning(['created_at']);
        return {
          uuid: u, emisor_nombre: f.emisor_nombre, serie_folio: f.serie_folio, fecha: f.fecha, total: f.total, sucursal: s, alcance,
          motivo, por: actor, cuando: new Date(fila.created_at).toISOString(),
        };
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code;
        if (code === '23505') throw new ConflictException('Esa factura ya se sacó de la bandeja');
        if (code === '23514') throw new BadRequestException('El motivo o la sucursal no son válidos');
        throw e;
      }
    });
  }

  /** Regresa a la bandeja lo que ESA sucursal ve en «Descartadas»: el descarte para todas, o el de «no es de aquí» suyo. */
  async restaurar(uuid: string, sucursal: string, quien: string): Promise<{ uuid: string; restaurada: true }> {
    this.tenantCtx.requireTenantId();
    const u = this.uuid(uuid);
    const s = await this.permitida(sucursal);
    const actor = String(quien ?? '').trim();
    if (!actor) throw new BadRequestException('No se sabe quién la regresa: la sesión no trae usuario');
    const lectura = await this.leer();
    return this.tk.run(async (trx) => {
      if (!(await trx.schema.withSchema('finance').hasTable('expense_sat_invoice_dismissals'))) throw new NotFoundException('No hay descartes en esta base');
      const d = this.armar(s, lectura, await this.fresco(trx)).descartadas.find((x) => x.uuid === u);
      if (!d) throw new NotFoundException('Esa factura no está entre las descartadas de esta sucursal');
      const q = trx('finance.expense_sat_invoice_dismissals').where({ cfdi_uuid: u, scope: d.alcance }).whereNull('undone_at');
      if (d.alcance === 'sucursal') q.where({ sucursal: s });
      const n = await q.update({ undone_at: trx.fn.now(), undone_by: actor, updated_at: trx.fn.now(), updated_by: actor });
      if (!n) throw new NotFoundException('Esa factura ya no estaba descartada');
      return { uuid: u, restaurada: true as const };
    });
  }

  // ── El armado (puro sobre lo leído) ─────────────────────────────────────────────────────────

  private armar(s: string, l: Lectura, fresco: Fresco): BandejaDeFacturasSat {
    const hoy = todayMx();
    const globales = new Map<string, Descarte>();
    const deSucursal = new Map<string, Descarte[]>();
    for (const d of fresco.descartes) {
      if (d.alcance === 'todas') globales.set(d.uuid, d);
      else deSucursal.set(d.uuid, [...(deSucursal.get(d.uuid) ?? []), d]);
    }
    const { registro, pistas } = this.registroDe(l, fresco, globales);
    const porRegistrar: FacturaPorRegistrar[] = [];
    const registradas: FacturaYaRegistrada[] = [];
    const descartadas: FacturaDescartada[] = [];
    const comoDescartada = (f: FacturaSat, d: Descarte): FacturaDescartada => ({
      uuid: f.uuid, emisor_nombre: f.emisor_nombre, serie_folio: serieFolio(f), fecha: f.fecha, total: f.total,
      sucursal: d.sucursal, alcance: d.alcance, motivo: d.motivo, por: d.por, cuando: d.cuando,
    });
    let sinClara = 0;
    for (const f of l.facturas) {
      const propuesta = sucursalPropuesta(l.historia.get(f.emisor_rfc) ?? new Map());
      const r = registro.get(f.uuid);
      if (r) {
        const vale = r.vale ? [...fresco.vales, ...fresco.valesSinFactura].find((v) => v.id === r.vale?.id) : undefined;
        const donde = r.documento?.sucursal ?? vale?.sucursal ?? null;
        if (s === '00' || donde === s) registradas.push({ uuid: f.uuid, emisor_nombre: f.emisor_nombre, serie_folio: serieFolio(f), fecha: f.fecha, total: f.total, registro: r });
        continue;
      }
      const g = globales.get(f.uuid);
      if (g) {
        // En «Descartadas» de cada sucursal que la veía (y de la que la sacó): la dueña ve quién y por qué, y la regresa.
        if (s === '00' || g.sucursal === s || laVeLaSucursal(propuesta, s)) descartadas.push(comoDescartada(f, g));
        continue;
      }
      const propias = deSucursal.get(f.uuid) ?? [];
      const mia = propias.find((d) => d.sucursal === s);
      if (mia) { descartadas.push(comoDescartada(f, mia)); continue; }
      if (!laVeLaSucursal(propuesta, s)) continue;
      if (!propuesta.propuesta && s !== '00') sinClara++;
      const claves = [...(l.acreedoresDe.get(f.emisor_rfc) ?? [])].sort();
      const acreedores: AcreedorDeLaFactura[] = claves.map((c) => {
        const k = l.claves.get(c) as ClaveDeAcreedor;
        // La MISMA regla de «Mandar a firma» (`crear`): si el RFC de Kepler es de otra razón social, no pasaría.
        const registrable = rfcCompatible(k.rfcKepler, f.emisor_rfc);
        return {
          clave: c, nombre: k.nombre, via: k.via, en_la_sucursal: k.sucursales.has(s), registrable,
          por_que_no: registrable ? null
            : `Kepler tiene para ${c} el RFC ${k.rfcKepler}, que no es el de la factura (${f.emisor_rfc}): pide a Finanzas que lo corrija en Kepler.`,
        };
      });
      // H11: el aviso de reembolso sólo con documentos de las sucursales que ven la factura (y la 00).
      const p = pistas(f, sucursalesQueLaVen(propuesta));
      const otrasSucursales = propias.filter((d) => d.sucursal !== s)
        .map((d) => `${d.sucursal} dijo que no es de su sucursal (${d.por}, ${d.cuando.slice(0, 10)}).`);
      porRegistrar.push({
        uuid: f.uuid, emisor_rfc: f.emisor_rfc, emisor_nombre: f.emisor_nombre, serie_folio: serieFolio(f), fecha: f.fecha,
        dias: diasEntre(f.fecha, hoy), total: f.total, subtotal: f.subtotal, descuento: f.descuento, iva: f.iva,
        metodo_pago: f.metodo_pago, forma_pago: f.forma_pago, acreedores, sucursal: propuesta, contabilizada: f.contabilizada,
        motivo: motivoSinRegistro(f, claves, p), avisos: [...avisosSinRegistro(p), ...otrasSucursales],
      });
    }
    porRegistrar.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.uuid.localeCompare(b.uuid));
    registradas.sort((a, b) => b.fecha.localeCompare(a.fecha) || a.uuid.localeCompare(b.uuid));
    descartadas.sort((a, b) => b.cuando.localeCompare(a.cuando));
    const horas = l.ultimaLlegada ? Math.max(0, Math.floor((Date.now() - Date.parse(l.ultimaLlegada)) / 3_600_000)) : null;
    const declarado = [
      'Una solicitud que junta varias facturas (por ejemplo, varios tickets de gasolina) no se reconoce todavía: esas facturas aparecen aquí aunque ya estén en Kepler (medido: 0.7 % del universo).',
      // [PGP.123] S.13 (H11): sin cifras fijas (envejecen: eran 219 de 304 y hoy son 44 de 176) y con la regla de hoy.
      'Si una factura se registró en Kepler a nombre de OTRO acreedor (un reembolso) sin su folio ni su UUID en la referencia, la regla no la ve. Cuando en una sucursal que ve la factura (o en la 00) hay un documento de otro acreedor por el mismo importe, la factura lo avisa: es una pista débil, porque muchos importes se repiten por casualidad.',
      'La sucursal se propone con la historia del acreedor desde el corte del 1-oct (acierta 93.1 % cuando propone); cuando no alcanza, la ven sus dos sucursales de historia y 00.',
    ];
    if (l.fuera) declarado.push(`${l.fuera} factura(s) de estos acreedores no entran: mercancía (G01), activo fijo (I0x), con retención o en otra moneda.`);
    if (horas !== null && horas > HORAS_SIN_LLEGADAS) declarado.push(`No ha llegado ninguna factura nueva del SAT en ${horas} horas: la descarga de ContPAQi puede estar detenida.`);
    if (l.ultimaLlegada === null) declarado.push('No se pudo saber cuándo llegó la última factura del SAT.');
    return {
      sucursal: s, desde: CORTE_SUCURSALES, ultima_llegada: l.ultimaLlegada, horas_sin_llegadas: horas,
      por_registrar: porRegistrar, registradas, descartadas, sin_sucursal_clara: sinClara, declarado,
    };
  }

  /**
   * `[PGP.123]` S.13 (H13) — El registro es lo caro de cada petición (~370 ms medidos en local, el 95 % de la bandeja,
   * aunque sea la de una sucursal con 9 facturas) y casi nunca cambia de una petición a otra. Se reusa mientras la
   * lectura (que ya se guarda un minuto) y lo fresco que lo alimenta sean los mismos: un vale nuevo, uno rechazado o
   * un descarte para todas cambian la firma y lo vuelven a calcular. El resultado es el mismo; sólo deja de repetirse.
   */
  private registroDe(l: Lectura, fresco: Fresco, globales: ReadonlyMap<string, Descarte>): RegistroCalculado {
    const firma = firmaDelRegistro(fresco);
    const guardado = this.registros.get(l);
    if (guardado?.firma === firma) return guardado;
    // Una factura que se sacó para todas no compite por gastos ni pagos: no le quita el suyo a una factura real.
    const fuentes: FuentesDelRegistro = {
      acreedoresDe: l.acreedoresDe, documentos: l.documentos, pagos: l.pagos, vales: fresco.vales, valesSinFactura: fresco.valesSinFactura,
    };
    const registro = registroDeFacturas(l.facturas.filter((f) => !globales.has(f.uuid)), fuentes);
    const calculado: RegistroCalculado = { firma, registro, pistas: pistasDeLaBandeja(fuentes, registro) };
    this.registros.set(l, calculado);
    return calculado;
  }

  // ── Las lecturas ─────────────────────────────────────────────────────────────────────────────

  /** Lo pesado, un minuto por tenant. Si la lectura falla no se guarda: la siguiente vuelve a intentar. */
  private leer(): Promise<Lectura> {
    const tenant = this.tenantCtx.requireTenantId();
    const c = this.lecturas.get(tenant);
    if (c && Date.now() - c.at < VIGENCIA_MS) return c.datos;
    const datos = this.tk.run((trx) => this.leerDeLaBase(trx));
    this.lecturas.set(tenant, { at: Date.now(), datos });
    datos.catch((e) => {
      if (this.lecturas.get(tenant)?.datos === datos) this.lecturas.delete(tenant);
      this.logger.warn(`La bandeja de facturas del SAT no se pudo leer: ${(e as Error)?.message ?? e}`);
    });
    return datos;
  }

  private async leerDeLaBase(trx: Knex.Transaction): Promise<Lectura> {
    // 1. Los acreedores de gasto de cada sucursal, con su RFC de Kepler y su nombre.
    const filas = (await trx.raw(`
      SELECT sucursal, btrim(c2) AS clave, max(btrim(c3)) AS nombre, max(nullif(btrim(c10), '')) AS rfc
        FROM kepler_ods.kdxd
       WHERE btrim(c2) ~ '^G' AND btrim(c2) !~ '^GB' AND btrim(c2) <> 'GN001'
       GROUP BY sucursal, btrim(c2)`)).rows as Array<{ sucursal: string; clave: string; nombre: string | null; rfc: string | null }>;
    // 2. Los RFC de los proveedores de compras: una factura suya no es gasto aunque también sea acreedor G.
    const compras = new Set(((await trx.raw(`
      SELECT DISTINCT regexp_replace(upper(coalesce(c10, '')), '[^A-Z0-9&Ñ]', '', 'g') AS rfc
        FROM kepler_ods.kdxd WHERE btrim(c2) ~ '^C' AND length(btrim(coalesce(c10, ''))) >= 12`)).rows as Array<{ rfc: string }>).map((r) => r.rfc));
    // 3. El padrón de emisores (para reparar el RFC de Kepler), sin las autofacturas.
    const padron = construirPadron((await trx.raw(`
      SELECT DISTINCT upper(btrim(emisor_rfc)) AS rfc, emisor_nombre AS nom FROM fiscal.cfdis
       WHERE rol = 'recibidas' AND tipo_comprobante IN ('I', 'E') AND fecha >= now() - (? * interval '1 day')
         AND upper(btrim(emisor_rfc)) <> upper(btrim(coalesce(receptor_rfc, '')))`, [DIAS_DEL_PADRON])).rows as Array<{ rfc: string; nom: string | null }>);
    // 4. La escalera, una vez por clave (ninguna clave tiene RFC distinto entre sucursales, medido).
    const claves = new Map<string, ClaveDeAcreedor>();
    const porClave = new Map<string, { nombre: string | null; rfc: string | null; sucursales: Set<string> }>();
    for (const f of filas) {
      const p = porClave.get(f.clave) ?? { nombre: f.nombre, rfc: f.rfc, sucursales: new Set<string>() };
      p.nombre = p.nombre || f.nombre;
      p.rfc = p.rfc || f.rfc;
      p.sucursales.add(String(f.sucursal).trim());
      porClave.set(f.clave, p);
    }
    const acreedoresDe = new Map<string, Set<string>>();
    for (const [clave, p] of porClave) {
      const r = resolverRfcAcreedor(p.rfc, p.nombre, padron);
      if (!r || compras.has(r.rfc)) continue;
      claves.set(clave, { rfc: r.rfc, rfcKepler: p.rfc, via: r.via, nombre: p.nombre, sucursales: p.sucursales });
      acreedoresDe.set(r.rfc, (acreedoresDe.get(r.rfc) ?? new Set<string>()).add(clave));
    }
    // 5. Las facturas recibidas desde el corte (y, de paso, cuándo llegó la última). El día y el IVA, ver arriba.
    const crudas = (await trx.raw(`
      SELECT lower(c.uuid) AS uuid, upper(btrim(c.emisor_rfc)) AS emisor_rfc, c.emisor_nombre, c.serie, c.folio,
             ${SQL_DIA_DEL_CFDI} AS fecha,
             c.total::float8 AS total, coalesce(c.subtotal, 0)::float8 AS subtotal, coalesce(c.descuento, 0)::float8 AS descuento,
             ${SQL_IVA_DEL_CFDI} AS iva, coalesce(c.total_retenidos, 0)::float8 AS retenido,
             c.moneda, c.receptor_uso_cfdi AS uso, c.metodo_pago, c.forma_pago, c.aso_contabilidad AS contabilizada, c.created_at
        FROM fiscal.cfdis c
       WHERE c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND coalesce(c.estatus_sat, '') NOT ILIKE 'cancel%'
         AND c.fecha >= (?::date - 1)`, [CORTE_SUCURSALES])).rows as Array<FacturaSat & { created_at: Date | string | null }>;
    let ultima: number | null = null;
    let fuera = 0;
    const facturas: FacturaSat[] = [];
    for (const c of crudas) {
      const t = c.created_at ? Date.parse(new Date(c.created_at).toISOString()) : NaN;
      if (Number.isFinite(t) && (ultima === null || t > ultima)) ultima = t;
      if (c.fecha < CORTE_SUCURSALES || !acreedoresDe.has(c.emisor_rfc)) continue;
      if (fueraDeLaBandeja(c)) { fuera++; continue; }
      const { created_at: _c, ...f } = c;
      void _c;
      facturas.push({ ...f, uuid: String(f.uuid).trim().toLowerCase(), total: Number(f.total), subtotal: Number(f.subtotal), descuento: Number(f.descuento),
        iva: f.iva === null || f.iva === undefined ? null : Number(f.iva), retenido: Number(f.retenido) });
    }
    const lista = [...claves.keys()];
    // 6. Los gastos de Kepler (la X-A-15 y sus X-A-10) de TODOS los acreedores —la referencia fuerte se busca también en
    //    los de otro acreedor, y lo que no es de esta factura se avisa— y los pagos X-D-26 de los acreedores de gasto.
    const documentos = ((await trx.raw(`
      SELECT k.sucursal, k.c4::int AS tipo, btrim(k.c6) AS folio,
             CASE WHEN k.c4 = 15 THEN btrim(k.c6)
                  WHEN btrim(coalesce(k.c36, '')) = 'A' AND k.c37 = 15 AND btrim(coalesce(k.c39, '')) <> '' THEN btrim(k.c39)
                  ELSE 'X-A-10 ' || btrim(k.c6) END AS solicitud,
             btrim(k.c10) AS acreedor, k.c16::float8 AS total, to_char(k.c9, 'YYYY-MM-DD') AS fecha,
             concat_ws(' ', k.c11, k.c24) AS referencia
        FROM kepler_ods.kdm1 k
       WHERE k.c2 = 'X' AND k.c3 = 'A' AND k.c4 IN (10, 15) AND k.c5 = 1 AND btrim(k.c1) = k.sucursal
         AND coalesce(btrim(k.c43), '') <> 'C' AND k.c16 > 0 AND k.c9 >= (?::date + ?::int)`,
    [CORTE_SUCURSALES, VENTANA_REFERENCIA.desde])).rows as DocumentoDeGasto[]);
    const pagos = lista.length ? ((await trx.raw(`
      SELECT k.sucursal, btrim(k.c6) AS folio, btrim(k.c10) AS acreedor, k.c16::float8 AS total, to_char(k.c9, 'YYYY-MM-DD') AS fecha
        FROM kepler_ods.kdm1 k
       WHERE k.c2 = 'X' AND k.c3 = 'D' AND k.c4 = 26 AND k.c5 = 1 AND btrim(k.c1) = k.sucursal
         AND coalesce(btrim(k.c43), '') <> 'C' AND k.c16 > 0 AND k.c9 >= ?::date AND btrim(k.c10) = ANY(?::text[])`,
    [CORTE_SUCURSALES, lista])).rows as PagoDeGasto[]) : [];
    // 7. La historia por sucursal desde el corte (DS21): documentos vivos del acreedor en cada servidor.
    const historia = new Map<string, Map<string, number>>();
    for (const d of documentos) {
      if (d.fecha < CORTE_SUCURSALES) continue;
      const rfc = claves.get(d.acreedor)?.rfc;
      if (!rfc) continue;
      const m = historia.get(rfc) ?? new Map<string, number>();
      const suc = String(d.sucursal).trim();
      m.set(suc, (m.get(suc) ?? 0) + 1);
      historia.set(rfc, m);
    }
    return {
      acreedoresDe, claves, facturas, fuera,
      documentos: documentos.map((d) => ({ ...d, sucursal: String(d.sucursal).trim(), tipo: Number(d.tipo) === 10 ? 10 : 15, total: Number(d.total), referencia: String(d.referencia ?? '') })),
      pagos: pagos.map((p) => ({ ...p, sucursal: String(p.sucursal).trim(), total: Number(p.total) })),
      historia, ultimaLlegada: ultima === null ? null : new Date(ultima).toISOString(),
    };
  }

  /** Lo que cambia con cada clic: vales de la Suite (con y sin factura ligada) y descartes. Fresco en cada petición. */
  private async fresco(trx: Knex.Transaction): Promise<Fresco> {
    const conUuid = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'cfdi_uuid');
    const vales = conUuid ? ((await trx.raw(`
      SELECT id::text AS id, lower(btrim(cfdi_uuid)) AS uuid, sucursal, folio_solicitud, status
        FROM finance.expense_proofs WHERE cfdi_uuid IS NOT NULL AND status <> 'rechazada'`)).rows as ValeConFactura[]) : [];
    // Los nacidos en la Suite sin la factura ligada (con ticket o foto): se capturaron antes de que llegara el CFDI.
    const valesSinFactura = conUuid ? ((await trx.raw(`
      SELECT id::text AS id, sucursal, folio_solicitud, btrim(creditor_code) AS acreedor, importe::float8 AS total,
             to_char(coalesce(document_date, requested_on), 'YYYY-MM-DD') AS fecha
        FROM finance.expense_proofs
       WHERE origen = 'solicitud' AND cfdi_uuid IS NULL AND status <> 'rechazada' AND creditor_code IS NOT NULL AND importe > 0
         AND coalesce(document_date, requested_on) >= (?::date - 30)`, [CORTE_SUCURSALES])).rows as ValeSinFactura[])
      .map((v) => ({ ...v, total: Number(v.total) })) : [];
    let descartes: Descarte[] = [];
    if (await trx.schema.withSchema('finance').hasTable('expense_sat_invoice_dismissals')) {
      const filas = (await trx('finance.expense_sat_invoice_dismissals').whereNull('undone_at')
        .select('cfdi_uuid', 'sucursal', 'scope', 'reason', 'created_by', 'created_at')) as Array<{ cfdi_uuid: string; sucursal: string; scope: string; reason: string; created_by: string; created_at: Date | string }>;
      descartes = filas.map((r) => ({ uuid: r.cfdi_uuid, sucursal: r.sucursal, alcance: r.scope === 'sucursal' ? 'sucursal' : 'todas',
        motivo: r.reason, por: r.created_by, cuando: new Date(r.created_at).toISOString() }));
    }
    return { vales, valesSinFactura, descartes };
  }

  /** La sucursal pedida, si quien consulta la puede ver (ScopeService, ADR-050). Fuera de `tk.run`: usa su conexión. */
  private async permitida(s: unknown): Promise<string> {
    const v = String(s ?? '').trim();
    if (!SUCURSALES.includes(v)) throw new BadRequestException(`Sucursal inválida «${v}»: se esperan dos dígitos (00…08)`);
    const visibles = this.scope.intersect(await this.scope.current('finanzas'), 'warehouse', null);
    if (visibles !== null && !visibles.includes(v)) throw new ForbiddenException(`No tienes acceso a la sucursal ${v}`);
    return v;
  }

  private uuid(u: unknown): string {
    const v = String(u ?? '').trim().toLowerCase();
    if (!UUID.test(v)) throw new BadRequestException('Eso no es el UUID de una factura');
    return v;
  }
}

/** «RFC_SERIE-FOLIO.xml», sólo con caracteres seguros para un nombre de archivo y un encabezado HTTP. */
export function nombreDelXml(f: Pick<FacturaSat, 'emisor_rfc' | 'serie' | 'folio' | 'uuid'>): string {
  return `${f.emisor_rfc}_${serieFolio(f) ?? f.uuid}.xml`.replace(/[^\w.-]+/g, '_');
}
