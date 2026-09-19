import { Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase TK.1 — Tickets de venta: buscar CUALQUIER folio y reimprimirlo.
 *
 * Tres universos, una sola pantalla. Ninguno se copia a una tabla: los dos de Kepler salen de
 * vistas EN VIVO sobre `kepler_ods` (frescura del CDC, ~segundos) y el propio de la plataforma
 * sale de su tabla transaccional.
 *
 *   `mostrador`      `U-D-10`  → `analytics.erp_sale_tickets` / `_lines`   (mig 20260918160000)
 *   `telemarketing`  `U-D-8`   → `analytics.erp_sales_invoices` / `_lines` (mig 20260822140000)
 *   `credito`        `U-D-12`  →  idem
 *   `pedido`         `PD-…`    → `commercial.orders` / `order_lines`
 *
 * ⚠️⚠️ **EL FOLIO NO IDENTIFICA UN DOCUMENTO.** Cada sucursal tiene su propio contador y
 * arranca en 1, y en el mostrador **cada CAJA tiene el suyo** (`kdm1.c5` = la caja; el catálogo
 * `kdmm` lo dice con todas sus letras: "Ticket Contado Caja 3"). Medido: el folio `0018665`
 * existe **7 veces** — sucursales 02, 03 y 04, y dentro de la 03 en las cuatro cajas, con
 * fechas que van de marzo a agosto y totales de $27.50 a $244.20.
 *
 * Por eso `buscar()` devuelve CANDIDATOS y jamás resuelve sola. Elegir "el primero" sería el
 * bug que `docs/ERP_KEPLER.md` §3 documenta como ya pagado en la Fase GX.11: no falla con un
 * error, falla con un número de otra tienda. La identidad completa es `folio_digital`
 * (`03UD1001-0018665` = sucursal + doctipo + caja + folio), y es lo que viaja como `id`.
 *
 * ⚠️ **NO HAY HORA.** Kepler no la guarda (medido: las 10 columnas `timestamp` de `kdm1` y
 * `kdm2.c32` están en 00:00:00 en los 10,716 documentos de la ventana). `hora` viaja en `null`
 * y con su motivo; el papel NO debe imprimir el reloj del navegador en su lugar (ADR-056).
 *
 * Alcance de sucursal: se recorta en el controller con `ScopeService`, igual que la pantalla
 * hermana. Que la búsqueda no se limite POR CANAL —que es lo que se pidió— no la exime de
 * respetar a qué plazas alcanza quien pregunta.
 */

/** De qué universo salió el documento. */
export type TicketOrigen = 'mostrador' | 'telemarketing' | 'credito' | 'pedido';

const ORIGEN_LABEL: Record<TicketOrigen, string> = {
  mostrador: 'Ticket de mostrador',
  telemarketing: 'Factura de telemarketing',
  credito: 'Venta a crédito',
  pedido: 'Pedido de la plataforma',
};

/** Una fila de la lista de resultados. Lo mínimo para que un humano elija sin equivocarse. */
export interface TicketCandidato {
  /** Identidad completa: `03UD1001-0018665` (ERP) o `PD-2026-00012` (plataforma). */
  id: string;
  origen: TicketOrigen;
  origen_label: string;
  sucursal: string | null;
  sucursal_nombre: string | null;
  /** Sólo mostrador: el número de caja que emitió el ticket. */
  caja: number | null;
  folio: string;
  fecha: string | null;
  cliente_nombre: string | null;
  /** `numeric` de Postgres: viaja como string para no perder centavos. */
  total: string | null;
}

export interface TicketLinea {
  linea: number;
  sku: string | null;
  descripcion: string | null;
  unidad: string | null;
  cantidad: number;
  /**
   * Lo que costaba sin descuento. Misma unidad que `precio_pagado`, o la resta miente.
   * Cuando el ERP no lo guarda (ver `lista_conocida`) se iguala al pagado para que la columna
   * sume, pero el renglón NO se imprime como "sin descuento": se imprime como desconocido.
   */
  precio_lista: number;
  /**
   * false ⇒ `kdm2.c66` viene vacío: el ERP **no guarda** con qué precio se comparaba este
   * renglón. No es lo mismo que "no hubo descuento". Kepler empezó a escribirlo el
   * **2026-08-13**, así que todo ticket anterior cae acá.
   */
  lista_conocida: boolean;
  precio_pagado: number;
  descuento_unitario: number;
  descuento_linea: number;
  /** `cantidad × precio_pagado`. Es el número que el cliente suma con la calculadora. */
  importe: number;
  /** "5 CJA" cuando el renglón se cobró en un peldaño distinto al de la aritmética. */
  equivalencia: string | null;
}

/**
 * La cascada. Se lee de arriba a abajo y **cierra exacto** en las dos restas, porque los dos
 * descuentos se definen como diferencias medidas y no como los porcentajes declarados:
 *
 *     importe_lista        Σ (precio_lista × cantidad)
 *   − descuento_precio     Σ descuento_linea            → subtotal  (= Σ importe, exacto)
 *   − descuento_documento  subtotal − total             → total     (exacto por construcción)
 */
export interface TicketCascada {
  importe_lista: number;
  descuento_precio: number;
  subtotal: number;
  descuento_documento: number;
  /**
   * El % que Kepler DECLARA en la cabecera (`kdm1.c19`), sólo como referencia impresa.
   * No se usa para calcular: se midió que el descuento declarado y el gap real del documento
   * no coinciden en 435 de 609 facturas `U-D-8`, con error medio de $183.
   */
  descuento_documento_pct_erp: number | null;
  iva: number | null;
  ieps: number | null;
  total: number;
  descuento_total: number;
  descuento_total_pct: number;
  /**
   * Cobertura del precio de lista, DECLARADA. `sin_lista` > 0 ⇒ para esos renglones el ERP no
   * guarda contra qué comparar, así que el descuento de este documento es un **piso**, no la
   * cifra. Un `descuento_precio` de $0.00 con `sin_lista = lineas` no significa "no hubo
   * descuento": significa "no se puede saber" (ADR-056).
   */
  lineas_con_lista: number;
  lineas_sin_lista: number;
}

export interface TicketDetalle {
  id: string;
  origen: TicketOrigen;
  origen_label: string;
  doc_label: string | null;
  sucursal: string | null;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  /** Siempre `null` en el ERP: Kepler no guarda la hora. Ver `hora_motivo`. */
  hora: string | null;
  hora_motivo: string | null;
  cliente_nombre: string | null;
  cliente_rfc: string | null;
  /** Quien cobró: cajero en mostrador, vendedor en mayoreo. */
  atendio: string | null;
  atendio_rol: string | null;
  /** Kepler cobra con impuestos dentro del precio; los pedidos propios no. Cambia el papel. */
  impuestos_incluidos: boolean;
  lineas: TicketLinea[];
  cascada: TicketCascada;
  /** false ⇒ los renglones no explican el total: el papel no se puede emitir como completo. */
  cuadra: boolean;
  aviso: string | null;
}

/** Los renglones no explican el total si el hueco pasa de esto. Umbral heredado del anexo (AX). */
const GAP_MAX_PCT = 15;
/** Tope de candidatos que se DEVUELVEN. Un folio compartido da ~7; 50 no inunda la pantalla. */
const MAX_CANDIDATOS = 50;

/**
 * Cuántas filas se piden POR UNIVERSO antes de ordenar y recortar en memoria.
 *
 * ⚠️ Esto existe para poder quitar el `ORDER BY` de las consultas al ERP, y el motivo está
 * documentado con medición en el servicio hermano (`commercial-sales-documents.service.ts`):
 *
 *   *"medido en prod, `ORDER BY … LIMIT 50` directo sobre la vista costaba **23,856 ms** y así
 *   cuesta **970 ms** — 24×. El motivo es el `LIMIT`: invita al planner a un nested loop que
 *   re-escanea el CTE de la cartera una vez por fila devuelta."*
 *
 * Y acá ese `ORDER BY` era **redundante**: el arreglo completo se reordena en JS después de unir
 * los tres universos, así que sólo servía para que el recorte fuera "los más recientes".
 *
 * Quitarlo sin más habría roto eso: con `LIMIT 51` y sin orden, Postgres devuelve 51 filas
 * ARBITRARIAS y la pantalla diría "los más recientes" sobre una muestra al azar. Un folio bajo
 * como `0000001` existe en 7 sucursales × 5 cajas = **35 documentos sólo en mostrador**, así que
 * el tope no es teórico. Con 200 el recorte no se activa en ninguna búsqueda por folio real, el
 * orden lo da el JS sobre el conjunto completo, y devolver 200 filas de 8 columnas no le cuesta
 * nada a nadie.
 *
 * ⚠️⚠️ **NO MEDIDO.** Los 23,856 ms son de una consulta por RANGO DE FECHAS; ésta filtra por
 * folio exacto, que es mucho más selectivo, y el plan podría haber estado bien desde antes. El
 * cambio se hizo sobre esa hipótesis y con `platform_test` caído, o sea que **no hay antes/después
 * que enseñar** — contra la regla del repo, y por eso queda escrito acá en vez de supuesto. Lo
 * que sí es seguro es que no empeora: quita trabajo, no lo agrega.
 */
const LIMITE_POR_UNIVERSO = 200;

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Lo que se entendió de lo que el humano tecleó. */
export interface FolioBuscado {
  /** El texto normalizado (sin espacios, en mayúsculas). `''` si no tecleó nada. */
  crudo: string;
  /**
   * Identidad completa reconocida: `03UD1001-0018665` **o** `03UD10010018665`. Cuando viene,
   * la búsqueda va directo por `(sucursal, doc_prefix, folio)` — el camino indexado y sin
   * ambigüedad. `folios` trae las variantes del folio suelto.
   */
  identidad: { sucursal: string; docPrefix: string; folios: string[] } | null;
  /** Variantes del folio a probar cuando NO se reconoció una identidad completa. */
  folios: string[];
  /** Pedido propio de la plataforma: `PD-2026-00012`. */
  code: string | null;
}

/**
 * Normaliza lo que el humano tecleó.
 *
 * ⚠️ **Es tolerante a propósito, y lo es porque no serlo ya costó.** La primera versión exigía
 * el guion de la identidad (`/^(\d{2})(UD\d{4})-(.+)$/`) y, al no reconocer `05UD10050006440`,
 * caía al camino de folio suelto: le arrancaba las letras y terminaba buscando
 * **`0510050006440`**, un número que no existe en ninguna sucursal. La pantalla respondía
 * *"Ningún documento con ese folio · Revisa el número"* sobre un folio que estaba **bien** —
 * echándole la culpa a quien preguntaba.
 *
 * Qué se acepta hoy:
 *   `05UD1005-0006440`  identidad con guion (la que imprime la propia pantalla)
 *   `05UD10050006440`   identidad SIN guion (lo que sale de copiar de un reporte o teclear)
 *   `05UD1005-6440`     identidad con el folio sin los ceros a la izquierda
 *   `0006440` / `6440`  folio suelto, con y sin ceros — busca en todas las plazas y cajas
 *   `PD-2026-00012`     pedido propio de la plataforma
 *
 * `UD\d{4}` toma exactamente 4 dígitos (`doc_prefix` = `UD` + tipo(2) + caja(2)), así que el
 * resto es el folio sin ambigüedad aunque no haya separador.
 *
 * Los ceros a la izquierda se prueban en las dos direcciones porque Kepler los guarda a 7
 * posiciones y la gente dicta el número sin ellos: en la caja dicen "el seis mil cuatrocientos
 * cuarenta" y en el sistema es `0006440`.
 */
export function parseFolioBuscado(termino: string): FolioBuscado {
  // Se quitan TODOS los espacios, no sólo las puntas: un folio copiado de un PDF llega partido.
  const crudo = String(termino || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!crudo) return { crudo: '', identidad: null, folios: [], code: null };

  /** Un folio numérico y sus formas: como se tecleó, a 7 posiciones, y sin ceros de más. */
  const variantesDeFolio = (f: string): string[] => {
    const out = new Set<string>([f]);
    const d = f.replace(/\D/g, '');
    if (d) {
      out.add(d);
      if (d.length < 7) out.add(d.padStart(7, '0'));
      out.add(String(Number(d)));
    }
    return [...out].filter(Boolean);
  };

  // Identidad completa: el guion es OPCIONAL.
  const m = /^(\d{2})(UD\d{4})-?(\d+)$/.exec(crudo);
  if (m) {
    return {
      crudo,
      identidad: { sucursal: m[1], docPrefix: m[2], folios: variantesDeFolio(m[3]) },
      folios: variantesDeFolio(m[3]),
      code: null,
    };
  }

  // Pedido propio.
  if (/^PD-\d{4}-\d+$/.test(crudo)) return { crudo, identidad: null, folios: [crudo], code: crudo };

  // Folio suelto. Sólo se le quitan las letras si el texto es enteramente numérico: si trae
  // letras que no calzaron con ninguna forma conocida, arrancárselas fabrica un número que
  // nadie tecleó — que es exactamente el bug que esta función existe para no repetir.
  return { crudo, identidad: null, folios: /^\d+$/.test(crudo) ? variantesDeFolio(crudo) : [crudo], code: null };
}

@Injectable()
export class CommercialTicketsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Delegado en la función pura de arriba, que es la que tiene el candado. */
  private variantes(termino: string): FolioBuscado {
    return parseFolioBuscado(termino);
  }

  /**
   * Busca un folio en los tres universos y devuelve TODOS los que calzan.
   *
   * Medido en `platform_test`: el lookup por folio suelto cuesta ~15 ms en cada vista de Kepler
   * porque las expresiones del `WHERE` calzan con los índices parciales de la mig
   * 20260822140100. Si alguien cambia `btrim(c6::text)` por otra forma, esto vuelve a segundos.
   */
  async buscar(termino: string, warehouseCodes: string[] | null) {
    const tenantId = this.tenantCtx.requireTenantId();
    const v = this.variantes(termino);
    if (!v.crudo) {
      return { termino: '', candidatos: [] as TicketCandidato[], truncado: false };
    }

    return this.tk.run(async (trx) => {
      const out: TicketCandidato[] = [];
      // true si algun universo devolvio mas filas de las que se leen: ahi el listado no solo
      // esta recortado, ademas NO se puede afirmar que sean las mas recientes (ya no hay
      // ORDER BY en SQL). Se distingue de "hay mas de 50" a proposito.
      let topado = false;

      // ── Mostrador (U-D-10) ────────────────────────────────────────────────
      const tk = trx('analytics.erp_sale_tickets as t')
        .where('t.tenant_id', tenantId)
        .select('t.folio_digital as id', 't.sucursal', 't.warehouse_name as sucursal_nombre',
          't.caja', 't.folio', 't.fecha', 't.cliente_nombre', 't.total')
        // Sin ORDER BY: es redundante (se reordena en JS) y es lo que dispara el mal plan sobre
        // estas vistas. Ver `LIMITE_POR_UNIVERSO`.
        .limit(LIMITE_POR_UNIVERSO + 1);
      // Con identidad reconocida se filtra por los TRES campos: es el camino indexado y no
      // depende de que el humano haya escrito el guion. `folio_digital` es una concatenación,
      // así que compararla como string no puede usar índice.
      if (v.identidad) {
        tk.andWhere('t.sucursal', v.identidad.sucursal)
          .andWhere('t.doc_prefix', v.identidad.docPrefix)
          .whereIn('t.folio', v.identidad.folios);
      } else tk.whereIn('t.folio', v.folios);
      // `[]` ⇒ knex emite `1 = 0`: quien no alcanza ninguna sucursal ve cero filas, nunca todas.
      if (warehouseCodes) tk.whereIn('t.sucursal', warehouseCodes);
      const filas_tk = v.code ? [] : await tk;
      if (filas_tk.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const f of filas_tk.slice(0, LIMITE_POR_UNIVERSO)) {
        out.push({ ...f, origen: 'mostrador', origen_label: ORIGEN_LABEL.mostrador } as TicketCandidato);
      }

      // ── Telemarketing y crédito (U-D-8 / U-D-12) ──────────────────────────
      const fa = trx('analytics.erp_sales_invoices as i')
        .where('i.tenant_id', tenantId)
        .select('i.folio_digital as id', 'i.sucursal', 'i.doc_tipo', 'i.folio', 'i.fecha',
          'i.cliente_nombre', 'i.total')
        // Idem: sin ORDER BY. Ésta es la que el servicio hermano midió en 23,856 ms con él.
        .limit(LIMITE_POR_UNIVERSO + 1);
      if (v.identidad) {
        fa.andWhere('i.sucursal', v.identidad.sucursal)
          .andWhere('i.doc_prefix', v.identidad.docPrefix)
          .whereIn('i.folio', v.identidad.folios);
      } else fa.whereIn('i.folio', v.folios);
      if (warehouseCodes) fa.whereIn('i.sucursal', warehouseCodes);
      const filas_fa = v.code ? [] : await fa;
      if (filas_fa.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const f of filas_fa.slice(0, LIMITE_POR_UNIVERSO)) {
        const origen: TicketOrigen = f.doc_tipo === 'credito' ? 'credito' : 'telemarketing';
        out.push({
          id: f.id, origen, origen_label: ORIGEN_LABEL[origen],
          sucursal: f.sucursal, sucursal_nombre: null, caja: null,
          folio: f.folio, fecha: f.fecha, cliente_nombre: f.cliente_nombre, total: f.total,
        });
      }

      // ── Pedidos de la plataforma (PD-…) ───────────────────────────────────
      // Tabla propia CON RLS: el `tenant_id` lo pone la política, pero se filtra igual —
      // el filtro explícito es gratis y no depende de que la sesión esté bien puesta.
      const pd = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', '=', 'o.tenant_id').andOn('c.id', '=', 'o.customer_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'o.tenant_id').andOn('w.id', '=', 'o.warehouse_id');
        })
        .where('o.tenant_id', tenantId)
        .whereNull('o.deleted_at')
        .select('o.code as id', 'w.code as sucursal', 'w.name as sucursal_nombre', 'o.code as folio',
          trx.raw('o.created_at::date as fecha'), 'c.name as cliente_nombre', 'o.total')
        // Acá el ORDER BY SÍ se queda: `commercial.orders` es una tabla nuestra, chica y con
        // índice, no una vista derivada de 3.4M filas. El problema medido es de las otras dos.
        .orderBy('o.created_at', 'desc')
        .limit(LIMITE_POR_UNIVERSO + 1);
      // Con una identidad del ERP reconocida, ningún `PD-` puede calzar: no se lo consulta.
      if (v.identidad) pd.whereRaw('1 = 0');
      else if (v.code) pd.andWhere('o.code', v.code);
      // Sin prefijo `PD-`, el humano tecleó sólo el consecutivo: se busca por sufijo. `ILIKE`
      // con comodín al inicio no usa índice, pero `commercial.orders` es una tabla nuestra y
      // chica (miles), no las 3.4M líneas de Kepler.
      else pd.where((b) => { for (const f of v.folios) b.orWhere('o.code', 'ilike', `%${f}`); });
      if (warehouseCodes) pd.whereIn('w.code', warehouseCodes);
      const filas_pd = await pd;
      if (filas_pd.length > LIMITE_POR_UNIVERSO) topado = true;
      for (const f of filas_pd.slice(0, LIMITE_POR_UNIVERSO)) {
        out.push({ ...f, caja: null, origen: 'pedido', origen_label: ORIGEN_LABEL.pedido } as TicketCandidato);
      }

      // ⭐ Éste es AHORA el único orden que existe: las dos consultas al ERP ya no ordenan en
      // SQL (ver `LIMITE_POR_UNIVERSO`). Lo más reciente primero, porque quien busca un folio
      // casi siempre quiere el de esta semana.
      //
      // El desempate por `id` NO es cosmético: sin él, dos documentos de la misma fecha salen en
      // el orden que le haya quedado al planner, que ahora no está fijado por ningún ORDER BY —
      // o sea que la misma búsqueda podría listarlos distinto cada vez. Es el mismo criterio que
      // el servicio hermano aplica a su paginación ("el desempate siempre es `folio`").
      out.sort((a, b) => String(b.fecha ?? '').localeCompare(String(a.fecha ?? ''))
        || String(a.id).localeCompare(String(b.id)));
      // `truncado` cubre los DOS motivos por los que el listado puede estar incompleto: que haya
      // más coincidencias de las que se devuelven, o que algún universo haya topado su límite de
      // lectura (y ahí ni siquiera se puede afirmar que sean las más recientes).
      const truncado = out.length > MAX_CANDIDATOS || topado;
      return { termino: v.crudo, candidatos: out.slice(0, MAX_CANDIDATOS), truncado };
    });
  }

  /**
   * ¿Esta instalación ya expone el precio de lista de las FACTURAS (mig `20260918160100`)?
   *
   * Existe por una razón concreta: esa migración **no escribe datos**, así que su ausencia no
   * deja ninguna huella que la delate — ni una tabla vacía, ni una fila faltante. Y la consulta
   * de renglones usa `select *`, con lo cual una columna que no existe llega `undefined` y se
   * confunde con "el ERP no tiene el dato". El resultado sería el peor de los mundos: el papel
   * afirmando algo falso **sobre Kepler** por culpa de un despliegue incompleto nuestro.
   *
   * Se resuelve preguntándole al catálogo, no adivinando por el valor. Cacheado en estático: la
   * respuesta sólo cambia cuando corre una migración, o sea nunca dentro de la vida del proceso.
   * Si la consulta falla se asume `false`, que es el lado seguro: declarar de más nunca hace daño.
   */
  private static soporteListaP: Promise<boolean> | null = null;
  private soporteLista(trx: Knex): Promise<boolean> {
    if (!CommercialTicketsService.soporteListaP) {
      CommercialTicketsService.soporteListaP = trx
        .select(trx.raw('1'))
        .from('information_schema.columns')
        .where({ table_schema: 'analytics', table_name: 'erp_sales_invoice_lines', column_name: 'precio_lista' })
        .first()
        .then((r: unknown) => !!r)
        .catch(() => false);
    }
    return CommercialTicketsService.soporteListaP;
  }

  /** `03UD1001-0018665` → sus partes; null si no calza el molde. */
  private partes(id: string) {
    const m = /^(\d{2})(UD\d{4})-(.+)$/.exec(String(id || '').trim().toUpperCase());
    return m ? { sucursal: m[1], docPrefix: m[2], folio: m[3] } : null;
  }

  /** Documento completo, con la cascada ya resuelta. `id` = `folio_digital` o `code`. */
  async detalle(id: string, warehouseCodes: string[] | null): Promise<TicketDetalle> {
    const limpio = String(id || '').trim().toUpperCase();
    if (/^PD-/.test(limpio)) return this.detallePedido(limpio, warehouseCodes);
    const p = this.partes(limpio);
    if (!p) throw new NotFoundException(`Folio no reconocido: ${id}`);
    // El doctipo va DENTRO del prefijo (`UD10`nn = mostrador, `UD08`nn = telemarketing):
    // es lo que decide de qué vista sale, sin un parámetro extra que se pueda contradecir.
    return p.docPrefix.startsWith('UD10')
      ? this.detalleMostrador(p, warehouseCodes)
      : this.detalleFactura(p, warehouseCodes);
  }

  private noAlcanza(sucursal: string, warehouseCodes: string[] | null) {
    return !!warehouseCodes && !warehouseCodes.includes(sucursal);
  }

  private async detalleMostrador(
    p: { sucursal: string; docPrefix: string; folio: string },
    warehouseCodes: string[] | null,
  ): Promise<TicketDetalle> {
    const tenantId = this.tenantCtx.requireTenantId();
    // Se comprueba ANTES de consultar: un 404 y un 403 se ven igual desde afuera, y así no se
    // filtra por el tiempo de respuesta si el folio de otra plaza existe o no.
    if (this.noAlcanza(p.sucursal, warehouseCodes)) throw new NotFoundException(`Ticket no encontrado: ${p.sucursal}${p.docPrefix}-${p.folio}`);

    return this.tk.run(async (trx) => {
      const cab = await trx('analytics.erp_sale_tickets')
        .where({ tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio })
        .first();
      if (!cab) throw new NotFoundException(`Ticket no encontrado: ${p.sucursal}${p.docPrefix}-${p.folio}`);

      const lineas = await trx('analytics.erp_sale_ticket_lines')
        .where({ tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio })
        .orderBy('linea');

      return this.armar({
        id: cab.folio_digital, origen: 'mostrador', doc_label: cab.doc_label,
        sucursal: cab.sucursal, sucursal_nombre: cab.warehouse_name, caja: cab.caja,
        folio: cab.folio, fecha: cab.fecha,
        cliente_nombre: cab.cliente_nombre, cliente_rfc: cab.cliente_rfc,
        atendio: cab.cajero_nombre, atendio_rol: 'Cajero',
        total: num(cab.total), iva: num(cab.iva), ieps: num(cab.ieps),
        descuento_pct_erp: null, impuestos_incluidos: true,
      }, lineas);
    });
  }

  private async detalleFactura(
    p: { sucursal: string; docPrefix: string; folio: string },
    warehouseCodes: string[] | null,
  ): Promise<TicketDetalle> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (this.noAlcanza(p.sucursal, warehouseCodes)) throw new NotFoundException(`Documento no encontrado: ${p.sucursal}${p.docPrefix}-${p.folio}`);

    return this.tk.run(async (trx) => {
      const cab = await trx('analytics.erp_sales_invoices')
        .where({ tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio })
        .first();
      if (!cab) throw new NotFoundException(`Documento no encontrado: ${p.sucursal}${p.docPrefix}-${p.folio}`);

      const lineas = await trx('analytics.erp_sales_invoice_lines')
        .where({ tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio })
        .orderBy('linea');

      const origen: TicketOrigen = cab.doc_tipo === 'credito' ? 'credito' : 'telemarketing';
      // Sólo acá: el mostrador lee sus PROPIAS vistas, y si le faltan no existen y la consulta
      // truena — falla ruidosa, no hace falta detectarla. La que puede estar a medias es ésta.
      const soporteLista = await this.soporteLista(trx);
      return this.armar({
        id: cab.folio_digital, origen, doc_label: cab.doc_label,
        sucursal: cab.sucursal, sucursal_nombre: null, caja: null,
        folio: cab.folio, fecha: cab.fecha,
        cliente_nombre: cab.cliente_nombre, cliente_rfc: cab.cliente_rfc,
        atendio: cab.vendedor_nombre, atendio_rol: 'Vendedor',
        total: num(cab.total), iva: null, ieps: num(cab.ieps),
        descuento_pct_erp: cab.descuento_pct != null ? num(cab.descuento_pct) : null,
        impuestos_incluidos: true,
      }, lineas, soporteLista);
    });
  }

  private async detallePedido(code: string, warehouseCodes: string[] | null): Promise<TicketDetalle> {
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      const o = await trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', '=', 'o.tenant_id').andOn('c.id', '=', 'o.customer_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'o.tenant_id').andOn('w.id', '=', 'o.warehouse_id');
        })
        .where('o.tenant_id', tenantId).andWhere('o.code', code).whereNull('o.deleted_at')
        .select('o.*', 'c.name as cliente_nombre', 'c.tax_id as cliente_rfc',
          'w.code as sucursal', 'w.name as sucursal_nombre')
        .first();
      if (!o) throw new NotFoundException(`Pedido no encontrado: ${code}`);
      if (this.noAlcanza(o.sucursal, warehouseCodes)) throw new NotFoundException(`Pedido no encontrado: ${code}`);

      const raw = await trx('commercial.order_lines as l')
        .leftJoin('catalog.products as p', function () {
          this.on('p.tenant_id', '=', 'l.tenant_id').andOn('p.id', '=', 'l.product_id');
        })
        .where('l.tenant_id', tenantId).andWhere('l.order_id', o.id)
        .select('l.line_number', 'l.quantity', 'l.unit_price', 'l.discount_percent',
          'l.line_subtotal', 'l.qty_unit', 'p.sku', 'p.name')
        .orderBy('l.line_number');

      // `unit_price` ES el precio de lista (sale de la lista de precios; el descuento se aplica
      // después: `line_subtotal = qty × unit_price × (1 − discount_percent)`). O sea que acá el
      // precio de lista NO hay que derivarlo de nada — está guardado tal cual.
      const lineas = raw.map((l: Record<string, unknown>) => {
        const cant = num(l['quantity']);
        const lista = num(l['unit_price']);
        const pct = num(l['discount_percent']);
        const pagado = r2(lista * (1 - pct));
        return {
          linea: num(l['line_number']),
          sku: (l['sku'] as string) ?? null,
          descripcion: (l['name'] as string) ?? null,
          unidad: (l['qty_unit'] as string) ?? null,
          cantidad: cant,
          precio_lista: lista,
          precio_unitario: pagado,
          descuento_unitario: r2(lista - pagado),
          descuento_linea: r2((lista - pagado) * cant),
          importe: num(l['line_subtotal']),
          cantidad_vendida: null, unidad_vendida: null,
        };
      });

      return this.armar({
        id: o.code, origen: 'pedido', doc_label: 'Pedido',
        sucursal: o.sucursal, sucursal_nombre: o.sucursal_nombre, caja: null,
        folio: o.code, fecha: o.created_at ? String(o.created_at).slice(0, 10) : null,
        cliente_nombre: o.cliente_nombre, cliente_rfc: o.cliente_rfc,
        atendio: null, atendio_rol: null,
        total: num(o.total), iva: num(o.tax_total), ieps: null,
        descuento_pct_erp: null,
        // Los pedidos propios guardan el precio SIN impuesto y suman `tax_total` aparte.
        // Kepler hace lo contrario. El papel tiene que saberlo o el desglose miente.
        impuestos_incluidos: false,
      }, lineas);
    });
  }

  /**
   * Arma la cascada y el papel a partir de la cabecera y los renglones ya normalizados.
   *
   * **Las dos restas cierran exacto, y eso es a propósito.** Lo único que un cliente puede
   * comprobar de un papel es que los números sumen; un desglose que no suma se lee como un
   * error del sistema aunque cada cifra sea defendible por separado. Por eso:
   *
   *   · `descuento_precio`    = Σ de los renglones      → da `Σ importe` por construcción.
   *   · `descuento_documento` = `Σ importe − total`     → da `total` por construcción.
   *
   * El segundo **NO** es el `c13`/`c19` que declara Kepler, y no por descuido: se midió que en
   * 435 de 609 facturas `U-D-8` el descuento declarado y el hueco real difieren, con error
   * medio de $183. El declarado se imprime al lado como referencia (`descuento_documento_pct_erp`);
   * el que entra en la resta es el medido.
   *
   * Si el hueco pasa del 15% el detalle NO explica el total —en el anexo se midió que son
   * documentos con renglones faltantes en Kepler, no descuentos— y el papel sale marcado como
   * incompleto en vez de repartir un descuento inventado entre los pocos renglones que sí están.
   */
  /**
   * Lo que el papel tiene que DECIR cuando no puede afirmar el descuento. Son tres ausencias
   * distintas y se nombran distinto a propósito — la peor de las tres es la que se ve igual que
   * "todo bien": un documento viejo, con su total correcto y su descuento en $0.00, que parece
   * decir "no hubo descuento" cuando en realidad dice "no se puede saber".
   */
  private aviso(
    lineas: number, conLista: number, cuadra: boolean, gapPct: number, soporteLista = true,
  ): string | null {
    if (lineas === 0) {
      return 'Este documento no tiene renglones en el ODS: es un hueco de replicación, no una venta sin productos.';
    }
    if (!cuadra) {
      return `Los renglones no explican el total (hueco de ${r2(gapPct)}%). Falta detalle en el ERP: `
        + 'el desglose de descuento se omite para no repartir entre los renglones que sí están.';
    }
    // ⭐ ANTES que "el ERP no lo guarda": puede que sí lo guarde y seamos NOSOTROS los que no lo
    // estamos leyendo. Sin esta rama, un despliegue a medias —migración 20260918160000 aplicada
    // y 20260918160100 no— imprimía una afirmación FALSA sobre Kepler en cada factura de
    // telemarketing, sin un solo error de por medio: la consulta usa `select *`, así que la
    // columna ausente llega `undefined` y se confunde con "no hay dato". Es el modo de falla que
    // tienen las migraciones que no escriben datos: no dejan una tabla vacía que las delate.
    if (!soporteLista) {
      return 'El módulo está desplegado a medias: falta la migración `20260918160100`, que expone el '
        + 'precio de lista de las facturas. NO es que el ERP no lo tenga — es que esta instalación '
        + 'todavía no lo lee. Avisar a sistemas antes de entregar este papel.';
    }
    if (conLista === 0) {
      return 'Kepler no guarda el precio de lista de este documento: empezó a registrarlo el 13 de agosto de 2026. '
        + 'Los importes son correctos, pero NO se puede afirmar si hubo descuento — un $0.00 acá significa '
        + '"no se sabe", no "no hubo".';
    }
    if (conLista < lineas) {
      return `${lineas - conLista} de ${lineas} renglones no traen precio de lista en el ERP: el descuento `
        + 'mostrado es un piso, puede haber sido mayor.';
    }
    return null;
  }

  private armar(
    h: {
      id: string; origen: TicketOrigen; doc_label: string | null;
      sucursal: string | null; sucursal_nombre: string | null; caja: number | null;
      folio: string; fecha: unknown;
      cliente_nombre: string | null; cliente_rfc: string | null;
      atendio: string | null; atendio_rol: string | null;
      total: number; iva: number | null; ieps: number | null;
      descuento_pct_erp: number | null; impuestos_incluidos: boolean;
    },
    raw: Record<string, unknown>[],
    soporteLista = true,
  ): TicketDetalle {
    const lineas: TicketLinea[] = raw.map((l) => {
      const cant = num(l['cantidad']);
      const pagado = num(l['precio_unitario']);
      // `null` ⇒ el ERP no guarda el precio de lista de este renglón (antes del 2026-08-13 no
      // existe ninguno). Se distingue de "lista = pagado", que sí es una afirmación.
      const listaRaw = l['precio_lista'];
      const listaConocida = listaRaw != null && num(listaRaw) > 0;
      const lista = listaConocida ? num(listaRaw) : 0;
      // Nunca se presume un descuento que no está: donde el renglón no alcanza (o el cobrado
      // supera al de lista, 0.1% de los casos), lista = pagado y sale sin descuento — nunca con
      // uno negativo, y nunca con un precio de lista en $0.00 sobre un cobro que sí ocurrió.
      const listaOk = lista > pagado ? lista : pagado;
      const uv = (l['unidad_vendida'] as string) || null;
      const cv = l['cantidad_vendida'] != null ? num(l['cantidad_vendida']) : null;
      const unidad = (l['unidad'] as string) || null;
      return {
        linea: num(l['linea']),
        sku: (l['sku'] as string) ?? null,
        descripcion: (l['descripcion'] as string) ?? null,
        unidad,
        cantidad: cant,
        precio_lista: r2(listaOk),
        lista_conocida: listaConocida,
        precio_pagado: r2(pagado),
        descuento_unitario: r2(listaOk - pagado),
        descuento_linea: r2((listaOk - pagado) * cant),
        importe: num(l['importe']),
        // Sólo si dice algo distinto de lo que ya está impreso: "5 CJA" cuando el renglón se
        // cobró en cajas pero la aritmética va en piezas. Es DESCRIPTIVO (ver la migración):
        // `cantidad_vendida × precio_vendido` no reproduce el importe en el 4% de los casos.
        equivalencia: uv && cv != null && (uv !== unidad || cv !== cant)
          ? `${Number(cv.toFixed(4))} ${uv}` : null,
      };
    });

    const conLista = lineas.filter((l) => l.lista_conocida).length;
    const importeLista = r2(lineas.reduce((a, l) => a + l.precio_lista * l.cantidad, 0));
    const descuentoPrecio = r2(lineas.reduce((a, l) => a + l.descuento_linea, 0));
    const subtotal = r2(lineas.reduce((a, l) => a + l.importe, 0));
    // Kepler cobra con impuesto dentro del precio; los pedidos propios lo suman aparte, así que
    // ahí el comparable del total es subtotal + impuestos, no el subtotal pelado.
    const base = h.impuestos_incluidos ? subtotal : r2(subtotal + num(h.iva));
    const descuentoDocumento = r2(base - h.total);
    const gapPct = base > 0 ? (descuentoDocumento / base) * 100 : (lineas.length ? 100 : 0);
    const cuadra = lineas.length > 0 && Math.abs(gapPct) <= GAP_MAX_PCT;

    const descuentoTotal = r2(descuentoPrecio + (cuadra ? descuentoDocumento : 0));
    const cascada: TicketCascada = {
      importe_lista: importeLista,
      descuento_precio: descuentoPrecio,
      subtotal,
      descuento_documento: cuadra ? descuentoDocumento : 0,
      descuento_documento_pct_erp: h.descuento_pct_erp,
      iva: h.iva, ieps: h.ieps,
      total: r2(h.total),
      descuento_total: descuentoTotal,
      descuento_total_pct: importeLista > 0 ? r2((descuentoTotal / importeLista) * 100) : 0,
      lineas_con_lista: conLista,
      lineas_sin_lista: lineas.length - conLista,
    };

    return {
      id: h.id, origen: h.origen, origen_label: ORIGEN_LABEL[h.origen], doc_label: h.doc_label,
      sucursal: h.sucursal, sucursal_nombre: h.sucursal_nombre, caja: h.caja,
      folio: h.folio,
      fecha: h.fecha ? String(h.fecha instanceof Date ? h.fecha.toISOString() : h.fecha).slice(0, 10) : null,
      hora: null,
      hora_motivo: h.origen === 'pedido'
        ? null
        : 'Kepler no guarda la hora del documento (medido: las 10 columnas de fecha están en 00:00:00).',
      cliente_nombre: h.cliente_nombre, cliente_rfc: h.cliente_rfc,
      atendio: h.atendio, atendio_rol: h.atendio_rol,
      impuestos_incluidos: h.impuestos_incluidos,
      lineas, cascada, cuadra,
      aviso: this.aviso(lineas.length, conLista, cuadra, gapPct, soporteLista),
    };
  }
}
