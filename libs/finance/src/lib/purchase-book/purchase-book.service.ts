import { Injectable, BadRequestException, NotFoundException, Logger, Optional, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput,
} from '@megadulces/contracts';
import {
  TIPO_POLIZA_DIARIO, r2, construirTxt, parsearTxt, vigenciaArchivo, vigenciaPorBanderas, REGEX_LINEA_LEGADA,
  type Movimiento, type PolizaTxtParseada,
} from './poliza-txt';

/** Las columnas de la corrida que ve la pantalla: todas menos el TXT (`archivo_contenido`). */
const COLUMNAS_RUN = [
  'id', 'tenant_id', 'anio_mes', 'tipo', 'estado', 'folio_poliza', 'fecha_poliza', 'concepto',
  'facturas', 'renglones', 'total_cargos', 'total_abonos', 'subtotal_exento', 'subtotal_gravado',
  'total_iva', 'total_ieps', 'archivo_hash', 'archivo_nombre', 'impuestos_modo', 'incluye_uuid',
  'asocia_cfdi', 'generado_at', 'generado_by', 'entregado_at', 'entregado_by', 'entregado_a',
  'aplicado_at', 'aplicado_by', 'notas', 'created_at', 'created_by', 'updated_at', 'updated_by',
];

export { type Movimiento, type PolizaTxtParseada } from './poliza-txt';

/**
 * Fase LC (ADR-052) — El trámite mensual del libro de compras.
 *
 * Antes: la contadora armaba un Excel a mano, lo convertía a TXT y lo subía a ContPAQi.
 * No quedaba registro de qué se entregó ni cuándo, y por eso julio y agosto de 2026 se
 * cayeron sin que nadie lo notara hasta mirar la balanza.
 *
 * Ahora el trámite se lleva aquí y a ContPAQi solo va el TXT:
 *   1. se ve el mes con sus facturas y su cuadre
 *   2. se decide qué entra (mientras LC.2 siga abierto, lo decide una persona)
 *   3. se genera el archivo, que queda firmado por su hash
 *   4. se marca entregado y, cuando se confirma contra la póliza real, aplicado
 *
 * **No escribimos en ContPAQi** (ADR-040): esto produce un archivo, el trámite de subirlo
 * lo sigue haciendo contabilidad.
 */

/** Cuentas de impuesto acreditable — son fijas, no dependen del proveedor. */
const CTA_IVA = '1470040000';
const CTA_IEPS = '1470110000';

export type ImpuestosModo = 'global' | 'por-cuenta';
export type EstadoRun = 'borrador' | 'generado' | 'entregado' | 'aplicado' | 'cancelado';

/**
 * `[LC.17]` — A qué estado se puede mover el trámite desde cada uno (por `marcar`; volver a
 * `generado` sólo lo hace `generar`).
 *
 * ⛔ Antes `marcar` aceptaba cualquier salto: `aplicado` desde `generado` (nadie lo entregó),
 * `entregado` desde `aplicado` (el trámite retrocedía) y `cancelado` desde `aplicado`. Lo
 * último es el caro: cancelar saca las facturas de la puerta exacta (`v_purchase_book_uuids`
 * sólo cuenta entregado/aplicado) y el mes las vuelve a ofrecer — un asiento que ContPAQi YA
 * tiene, entregado otra vez.
 */
export const TRANSICIONES_RUN: Readonly<Record<EstadoRun, readonly EstadoRun[]>> = {
  borrador: ['cancelado'],
  generado: ['entregado', 'cancelado'],
  entregado: ['aplicado', 'cancelado'],
  aplicado: [],
  cancelado: [],
};

/** Las facturas que `generar` deja registradas: alimentan la puerta exacta, no deciden. */
const ORIGEN_GENERADO = 'generado';

/**
 * `[LC.18]` — Cómo reparte una factura la contadora entre `502` (gravado), `501` (exento) y el
 * IEPS acreditable. **Medido al centavo en 763 de 763 facturas** de los libros de jul, ago y
 * sep-2026 armados a mano (`test-newdb-libro-compras-replica.js`):
 *
 *   · `502 = IVA ÷ 0.16`, con tope en lo que queda tras quitar IVA e IEPS: en una factura 100 %
 *     gravada el IVA redondeado por concepto hace que `IVA ÷ 0.16` se pase del neto por
 *     centavos, y ahí todo va al `502` y no hay renglón `501` (40 de las 763).
 *   · Sólo se acredita el IEPS a **tasa 8 %**. El de 26.5 % y el de cuota se quedan en el costo
 *     (`502`/`501`), como en el libro manual — decisión de Edgar del 2026-10-21: el TXT tiene
 *     que salir igual al que se armaba a mano. Lo no acreditado se declara como aviso.
 *   · `501` = lo que resta. Cuadra por construcción: `501 + 502 + IVA + IEPS = total`.
 *
 * ⛔ Antes se usaba el subtotal de los conceptos gravados (`subtotal_iva_16`) y todo el IEPS:
 * fiscalmente defendible, pero sólo coincidía con lo manual en 678 de las 763.
 */
export function repartirFactura(total: number, iva: number, ieps8: number): { subtotal16: number; base_exenta: number } {
  // ⛔ En CENTAVOS ENTEROS, no en flotante: `4196.78 / 0.16` da 26229.8749999… y redondea a
  // .87, cuando lo exacto es 26229.875 → .88 (lo que hace la contadora). Medido: 5 de 765
  // facturas salían con un centavo de diferencia. `cent × 625 / 100` es `cent ÷ 0.16` exacto.
  const cent = (n: number) => Math.round(Number(n) * 100);
  const neto = cent(total) - cent(iva) - cent(ieps8);
  const s16 = Math.min(Math.round((cent(iva) * 625) / 100), neto);
  return { subtotal16: s16 / 100, base_exenta: (neto - s16) / 100 };
}

/**
 * `[LC.18]` — El IEPS que el libro ACREDITA: sólo el de tasa 8 %. Fragmento de SQL sobre un
 * `fiscal.cfdis f`; sin signos de interrogación (knex los cuenta como placeholders).
 */
const IEPS8_SQL = `coalesce((
    SELECT sum((x->>'importe')::numeric)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.impuestos->'traslados') = 'array'
                                     THEN f.impuestos->'traslados' ELSE '[]'::jsonb END) x
     WHERE x->>'impuesto' = '003' AND x->>'tipo_factor' = 'Tasa' AND (x->>'tasa')::numeric = 0.08
  ), 0)`;

/** ¿La cuenta existe en ContPAQi? Catálogo (foto del importer) O ya usada en una póliza (feed vivo). */
const cuentaExisteSql = (col: string) => `(
    EXISTS (SELECT 1 FROM analytics.contpaqi_accounts ca
             WHERE ca.tenant_id = current_tenant_id() AND ca.codigo = ${col})
    OR EXISTS (SELECT 1 FROM analytics.gl_poliza_lines gx
                WHERE gx.tenant_id = current_tenant_id() AND gx.source = 'contpaqi' AND gx.cuenta = ${col}))`;

/**
 * `[LC.18]` — El mapa RFC → cuenta del proveedor, UNO para el tablero, el mes y el respaldo.
 *
 * ⛔ Antes cada consulta leía `finance.gl_supplier_accounts` sola, que se sembró UNA vez desde
 * la hoja `DATOS` el 2026-09-01. Los proveedores dados de alta después no existían para el
 * módulo: en los libros manuales de jul/ago/sep son **2 + 5 + 4 facturas por $3.2M** que el
 * generador no podía armar. Ahora:
 *   1. lo que el libro ya tiene (gana siempre: está validado y se puede corregir a mano), y
 *   2. lo que ContPAQi mismo resolvió (`contpaqi.supplier_accounts`, `[CP.8.20]`) con veredicto
 *      firme: UUID asociado y nombre coinciden, o UUID sólido. **Nunca sólo por nombre.**
 * La existencia de cada cuenta se mira EN VIVO (`cuentaExisteSql`) además del dato sembrado:
 * el flag del sembrado es una foto del 1-sep y una cuenta creada después salía «inexistente».
 */
const MAPA_PROVEEDORES_CTE = `mapa_base AS (
    SELECT DISTINCT ON (u.rfc) u.*
      FROM (
        SELECT a.rfc, a.account_suffix, a.supplier_name, a.cuenta_proveedor,
               a.cuenta_compra_exenta, a.cuenta_compra_iva,
               a.proveedor_existe AS p_ok, a.compra_exenta_existe AS e_ok, a.compra_iva_existe AS i_ok,
               a.usado_en_asiento, 1 AS prioridad, 'libro' AS origen_mapa
          FROM finance.gl_supplier_accounts a
         WHERE a.tenant_id = current_tenant_id() AND a.deleted_at IS NULL AND a.rfc IS NOT NULL
        UNION ALL
        SELECT s.rfc, substr(s.cuenta, 4), s.cuenta_nombre, s.cuenta,
               '501' || substr(s.cuenta, 4), '502' || substr(s.cuenta, 4),
               NULL, NULL, NULL, false, 2, 'contpaqi'
          FROM contpaqi.supplier_accounts s
         WHERE s.tenant_id = current_tenant_id() AND s.rfc IS NOT NULL AND s.cuenta LIKE '212%'
           AND s.veredicto IN ('confirmado', 'uuid_solido')
      ) u
     ORDER BY u.rfc, u.prioridad, u.usado_en_asiento DESC, u.account_suffix
  ), mapa AS (
    SELECT m.rfc, m.account_suffix, m.supplier_name, m.cuenta_proveedor,
           m.cuenta_compra_exenta, m.cuenta_compra_iva, m.usado_en_asiento, m.origen_mapa,
           (m.p_ok IS TRUE OR ${cuentaExisteSql('m.cuenta_proveedor')}) AS proveedor_existe,
           (m.e_ok IS TRUE OR ${cuentaExisteSql('m.cuenta_compra_exenta')}) AS compra_exenta_existe,
           (m.i_ok IS TRUE OR ${cuentaExisteSql('m.cuenta_compra_iva')}) AS compra_iva_existe
      FROM mapa_base m
  )`;

const MESES_ES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
/** `2026-10` → `REGISTRO DE COMPRAS DEL MES DE OCTUBRE 2026`, la forma que más usa el libro manual. */
export const conceptoLibro = (anioMes: string): string =>
  `REGISTRO DE COMPRAS DEL MES DE ${MESES_ES[Number(anioMes.slice(5, 7)) - 1] ?? anioMes.slice(5, 7)} ${anioMes.slice(0, 4)}`;

/** `[LC.18]` — Cuántos meses hacia atrás se mira si el proveedor ya entró al libro. */
const MESES_HISTORIAL = 6;

/**
 * `[LC.18.2]` — La puerta exacta mira los UUID del libro en `mes ± VENTANA_PRUEBA_MESES`. Un CFDI
 * entra al libro de su mes o, a veces, del siguiente (medido: con ventana 0 se pierden 24 de
 * 77,712); 12 meses de cada lado no pierde ninguno.
 */
const VENTANA_PRUEBA_MESES = 12;

/**
 * La prioridad entre pruebas de `finance.v_purchase_book_uuid_prueba` (migración
 * `20260903120000`), repetida acá para poder aplicarla DESPUÉS de filtrar por mes. ⛔ Si una
 * cambia, la otra también: `test-newdb-libro-compras-replica.js` las cruza y se pone rojo.
 */
const ORDEN_PRUEBA_SQL = `CASE u.source
    WHEN 'contpaqi_asoccfdi' THEN 1 WHEN 'contpaqi_concepto' THEN 2 WHEN 'run_aplicado' THEN 3
    WHEN 'historico_xlsx' THEN 4 WHEN 'run_entregado' THEN 5 ELSE 9 END`;

/** Palabras que no distinguen a un proveedor de otro al comparar nombres. */
const RUIDO_NOMBRE = new Set(['S.A.', 'SA', 'DE', 'CV', 'RL', 'SAPI', 'SRL', 'LAS', 'LOS', 'DEL', 'SPR', 'SC', 'SAS', 'MEXICO', 'COMERCIALIZADORA', 'DISTRIBUIDORA', 'GRUPO']);

const tokensNombre = (s: string): Set<string> => new Set(
  String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter((t) => t.length > 2 && !RUIDO_NOMBRE.has(t)),
);

/** `[LC.18]` Qué tanto se parecen dos razones sociales (0–1), sin acentos ni «SA DE CV». */
export function parecidoNombre(a: string, b: string): number {
  return parecidoTokens(tokensNombre(a), tokensNombre(b));
}

function parecidoTokens(x: Set<string>, y: Set<string>): number {
  if (!x.size || !y.size) return 0;
  let comunes = 0;
  for (const t of y) if (x.has(t)) comunes++;
  return comunes / Math.max(x.size, y.size);
}

/** Desde cuánto parecido de nombre se ofrece una cuenta como sugerencia en el diálogo. */
const PARECIDO_MINIMO = 0.5;
/**
 * En el RENGLÓN (sin abrir el diálogo) se exige más: medido en oct-2026, con 0.5 salían personas
 * que sólo comparten nombre de pila («VICTOR MANUEL VELAZQUEZ» → «VICTOR MANUEL SANCHEZ»).
 */
const PARECIDO_FILA = 0.8;
const CANDIDATAS_TTL_MS = 5 * 60 * 1000;

export interface SugerenciasCuenta {
  rfc: string;
  /** Como lo escribe el CFDI más reciente del RFC. */
  nombre: string;
  candidatas: {
    cuenta: string; nombre: string; parecido: number; razon: string;
    /** Si la cuenta ya es de OTRO RFC en el libro: asignarla se rechaza. */
    asignada_a: string | null;
    /** ContPAQi le asoció un CFDI de este RFC: la prueba más fuerte que hay. */
    fuerte: boolean;
  }[];
}

/** `[LC.18]` — Las cuentas de impuesto del asiento y de qué libro se tomaron (`null` = las fijas). */
export interface CuentasImpuesto {
  iva: { cuenta: string; nombre: string };
  ieps: { cuenta: string; nombre: string };
  desde: string | null;
}

/**
 * Las dos corridas que puede tener un mes:
 *   `libro`       → la póliza completa del mes (folio 1). Se usa cuando el mes no se subió.
 *   `complemento` → SOLO los CFDIs que quedaron sin asociar a ninguna póliza. Es el
 *                   sub-módulo "Movimientos no asociados" y es el caso normal: la póliza
 *                   del mes ya existe y se le quedaron facturas fuera.
 */
export type TipoCorrida = 'libro' | 'complemento';

/** Folio 1 del Diario es siempre el registro de compras; el 2 está libre en todos los meses. */
const FOLIO_LIBRO = 1;
const FOLIO_COMPLEMENTO = 2;

/**
 * LC.7 — las reglas del cuadre post-entrega, para la bandeja de hallazgos de Maat.
 *
 * Se registran antes de insertar (la FK `(tenant_id, rule_key)` lo exige) y son
 * idempotentes: si ya existen se preserva la calibración humana.
 */
const REGLAS_CUADRE: FinanceRuleInput[] = [
  {
    rule_key: 'libro_compras_descuadre_contpaqi', clase: 'error_captura',
    nombre: 'La póliza en ContPAQi no es la que entregamos',
    descripcion: 'El multiset (cuenta, cargo/abono, importe) del TXT guardado en la corrida no coincide '
      + 'con la póliza real. Alguien editó renglones al importar, o el archivo se subió a otro folio.',
    params: { tolerancia_pesos: 1000 },
  },
  {
    rule_key: 'libro_compras_poliza_ausente', clase: 'riesgo',
    nombre: 'Entregado y sin póliza en ContPAQi',
    descripcion: 'La corrida está entregada o aplicada y ContPAQi no tiene la póliza del mes. '
      + 'Es el modo de falla que tiró julio y agosto de 2026 sin que nadie lo notara.',
    params: {},
  },
  {
    rule_key: 'libro_compras_entrega_sin_asociar', clase: 'error_captura',
    nombre: 'Entrega aplicada y sin asociar en ContPAQi',
    descripcion: 'Pasaron los días de gracia desde que se aplicó y los UUID entregados siguen sin marca '
      + 'de asociación. El layout del TXT no tiene campo de UUID: si nadie usa el Asociador de CFDI, el '
      + 'flag miente y el anti-duplicado se queda sin su señal buena.',
    params: { dias_gracia: 7 },
  },
];

/**
 * Una factura del respaldo. Se resuelve desde los UUID que lleva el TXT ENTREGADO, no desde
 * los datos del mes: si entre generar y bajar el respaldo entró un CFDI nuevo, tomarlo del
 * mes haría que la hoja deje de cuadrar contra el archivo.
 */
export interface FacturaRespaldo {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  serie: string | null;
  folio: string | null;
  fecha: string;
  base_exenta: number;
  subtotal16: number;
  ieps: number;
  iva: number;
  total: number;
  supplier_name: string | null;
  cuenta_proveedor: string | null;
  cuenta_compra_exenta: string | null;
  cuenta_compra_iva: string | null;
}

export interface FacturaMes {
  uuid: string;
  emisor_rfc: string;
  emisor_nombre: string;
  serie: string | null;
  folio: string | null;
  fecha: string;
  total: number;
  iva: number;
  /** `[LC.18]` El IEPS que se ACREDITA (tasa 8 %). Es el que va al renglón de IEPS del asiento. */
  ieps: number;
  /** `[LC.18]` Todo el IEPS del CFDI, y lo que de él se queda en el costo (26.5 %, cuota). */
  ieps_total: number;
  ieps_no_acreditable: number;
  /** Lo que va a la `502`: `IVA ÷ 0.16` con tope (ver `repartirFactura`). */
  subtotal16: number;
  /** Lo que va a la `501`, por diferencia contra el total. */
  base_exenta: number;
  ieps_por_cuota: boolean;
  /**
   * `[LC.18]` El proveedor apareció en el libro (Diario folio 1) de alguno de los últimos
   * `MESES_HISTORIAL` meses. Sin historial no entra por default: medido, ~115 facturas al mes
   * sin asociar de proveedores del catálogo nunca entraron al libro manual, y ningún campo del
   * CFDI ni de Kepler las distingue. Decisión de Edgar del 2026-10-21.
   */
  en_libro_reciente: boolean;
  /** De dónde salió la cuenta: el mapa del libro, o lo que ContPAQi resolvió por UUID. */
  origen_mapa: 'libro' | 'contpaqi' | null;
  /** `[LC.18]` Sin cuenta: la 212 libre de ContPAQi cuyo nombre se parece al del emisor. Sugerencia, no decisión. */
  cuenta_sugerida: { cuenta: string; nombre: string; parecido: number } | null;
  account_suffix: string | null;
  supplier_name: string | null;
  cuenta_proveedor: string | null;
  cuenta_compra_exenta: string | null;
  cuenta_compra_iva: string | null;
  /**
   * ⚠️ Los tres `*_existe` son lo único que dice si la cuenta EXISTE en el catálogo de
   * ContPAQi. Los `cuenta_*` de arriba son strings **precalculados** (`212`/`501`/`502` +
   * sufijo) que están poblados para todo proveedor que tenga sufijo, así que preguntar por
   * ellos no frena nada: 14 proveedores sin cuenta `502` pasaban derecho al archivo, y un
   * renglón con la cuenta vacía tumba el import entero sin verse en ninguna pantalla.
   */
  cuenta_existe: boolean;
  compra_exenta_existe: boolean;
  compra_iva_existe: boolean;
  incluida: boolean;
  motivo_exclusion: string | null;
  /**
   * `Documento.IsAsoContabilidad` del ADD: ContPAQi la tiene atada a una póliza.
   * `false` = **movimiento no asociado**, que es el universo del sub-módulo.
   * `null` = no se sabe (CFDI cargado antes de LC.6).
   */
  aso_contabilidad: boolean | null;
  /**
   * Su importe ya aparece como abono a proveedor en la póliza de compras del mes, aunque no
   * tenga marca de asociación. Pasa porque nuestro propio TXT no lleva UUID: ContPAQi la
   * contabiliza y nadie la asocia. Es **heurístico por importe**, no prueba — pero alcanza
   * para no re-meterla: son 271 facturas por $32.6M en 2026 (jul solo, 150 por $17.9M).
   */
  ya_en_poliza: boolean;
  /**
   * QUÉ prueba dice que ya está en el libro, y con qué fuerza. La distinción es la
   * diferencia entre certeza y sospecha, y decide si el humano puede pasar por encima:
   *
   *  · `uuid_*`    → **exacta**: es el mismo folio fiscal. No hay nada que juzgar.
   *  · `importe_*` → **por importe**: dos facturas del mismo monto casan igual. Es una
   *                  sospecha razonable, y quien lleva el libro es quien sabe.
   */
  prueba_en_libro:
    | 'uuid_libro_historico' | 'uuid_entregado' | 'uuid_concepto_contpaqi'
    | 'importe_abono_212' | 'importe_cargo_501_502' | null;
  prueba_certeza: 'exacta' | 'por_importe' | null;
  /** Para que un humano pueda juzgar un falso positivo: qué se encontró, exactamente. */
  prueba_detalle: string | null;
  /**
   * `vigente | cancelado | desconocido` según el ADD. **Casi todo es `desconocido`**
   * (167,053 de 167,135): el ADD trae `CancelStatus` vacío y nadie valida contra el SAT.
   * Por eso NO se filtra por `= vigente` — eso vaciaría el módulo. Se bloquea lo que se
   * sabe malo (`cancelado`) y la ignorancia se declara en un aviso, no se esconde.
   */
  estatus_sat: string;
}

@Injectable()
export class PurchaseBookService {
  private readonly logger = new Logger(PurchaseBookService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
    // Best-effort: la bandeja unificada vive en Maat. Sin binding el módulo sigue
    // funcionando, sólo que el cuadre no consolida hallazgos.
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly findingsSink?: FinanceFindingsSinkPort,
  ) {}

  private mesValido(anioMes: string) {
    if (!/^\d{4}-\d{2}$/.test(anioMes || '')) throw new BadRequestException('mes inválido, se espera YYYY-MM');
    return anioMes;
  }

  /** Último día del mes: el asiento siempre va fechado ahí. */
  private finDeMes(anioMes: string): Date {
    const [y, m] = anioMes.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0));
  }

  /**
   * Los dos extremos del mes, para filtrar `fecha` por RANGO en vez de por
   * `to_char(fecha, 'YYYY-MM')`. Envolver la columna en una función anula el índice
   * `(tenant_id, fecha)` y fuerza un seq scan de la tabla entera.
   */
  private inicioDeMes(anioMes: string): string {
    return `${anioMes}-01`;
  }

  private inicioDelSiguiente(anioMes: string): string {
    const [y, m] = anioMes.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }

  /** `2026-03` menos 6 → `2025-09`. */
  private mesMenos(anioMes: string, n: number): string {
    const [y, m] = anioMes.split('-').map(Number);
    const t = y * 12 + (m - 1) - n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  }

  /**
   * `[LC.18]` — A qué cuentas van el IVA y el IEPS del asiento: **las del último libro** (Diario
   * folio 1) de este mes o de uno anterior, no unas fijas.
   *
   * ⛔ Medido: de ene a ago-2026 el libro usó `1470040000 IVA POR ACREDITAR` / `1470110000 IEPS
   * POR ACREDITAR`, y en **sep-2026 la contadora cambió** a `1060000000 IVA ACREDITABLE` /
   * `1470100000 IEPS ACREDITABLE`. Con las cuentas fijas en el código, el TXT de octubre habría
   * salido con las de antes. Se clasifican por el NOMBRE de la cuenta (dice IVA o IEPS); si no
   * hay libro previo, quedan las constantes y se declara.
   */
  async cuentasImpuesto(knex: Knex, anioMes: string): Promise<CuentasImpuesto> {
    const { rows } = await knex.raw(
      `WITH ultimo AS (
         SELECT max(anio_mes) AS anio_mes
           FROM analytics.gl_poliza_lines
          WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
            AND tipo_pol = ? AND folio = ? AND anio_mes <= ?
            AND cuenta LIKE '212%' AND cargo_abono = 'A'
       )
       SELECT l.anio_mes, l.cuenta, max(l.cuenta_nombre) AS nombre, sum(l.importe) AS importe
         FROM analytics.gl_poliza_lines l JOIN ultimo u ON u.anio_mes = l.anio_mes
        WHERE l.tenant_id = current_tenant_id() AND l.source = 'contpaqi'
          AND l.tipo_pol = ? AND l.folio = ? AND l.cargo_abono = 'C'
          AND l.cuenta NOT LIKE '212%' AND l.cuenta NOT LIKE '501%' AND l.cuenta NOT LIKE '502%'
        GROUP BY 1, 2
        ORDER BY 4 DESC`,
      [TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), anioMes, TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO)],
    );
    const de = (re: RegExp) => rows.find((r: Record<string, unknown>) => re.test(String(r['nombre'] ?? '').toUpperCase()));
    const iva = de(/\bIVA\b/);
    const ieps = de(/\bIEPS\b/);
    return {
      iva: iva ? { cuenta: String(iva['cuenta']).trim(), nombre: String(iva['nombre'] ?? '') } : { cuenta: CTA_IVA, nombre: 'IVA POR ACREDITAR' },
      ieps: ieps ? { cuenta: String(ieps['cuenta']).trim(), nombre: String(ieps['nombre'] ?? '') } : { cuenta: CTA_IEPS, nombre: 'IEPS POR ACREDITAR' },
      desde: iva || ieps ? String((iva ?? ieps)!['anio_mes']) : null,
    };
  }

  // ── El tablero: en qué va cada mes ────────────────────────────────────────────────────
  /**
   * Un renglón por mes con CFDIs recibidos, aunque nunca se haya armado la póliza. Así
   * un mes sin trámite se ve como hueco en vez de desaparecer de la lista, que es
   * justamente lo que pasó con julio y agosto.
   */
  async listMeses(limit = 24) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH meses AS (
           SELECT to_char(fecha, 'YYYY-MM') AS anio_mes,
                  count(*)      AS cfdis,
                  sum(total)    AS total_cfdis
             FROM fiscal.cfdis
            WHERE tenant_id = current_tenant_id()
              AND source = 'contpaqi_add' AND tipo_comprobante = 'I'
              -- (IG.14) FILTRO DE ROL EXPLICITO. La tabla fiscal.cfdis fue, hasta 2026-10-05, solo CFDI
              -- RECIBIDO, asi que este filtro era implicito y nadie lo escribio. Ahora el ADD
              -- tambien puede traer los EMITIDOS (213,520 facturas de VENTA por $4,680 M, que
              -- siempre estuvieron ahi y nunca se pidieron). Sin esta linea, el LIBRO DE COMPRAS
              -- empezaria a tratar nuestras propias facturas de venta como compras: un documento
              -- fiscal corrompido, y en silencio.
              AND rol = 'recibidas'
            GROUP BY 1
         )
         SELECT m.anio_mes, m.cfdis, m.total_cfdis,
                r.id AS run_id, r.estado, r.facturas, r.renglones, r.total_cargos,
                r.generado_at, r.entregado_at, r.aplicado_at, r.archivo_hash,
                p.patas_en_contpaqi, p.total_en_contpaqi
           FROM meses m
           LEFT JOIN finance.purchase_book_runs r
             ON r.tenant_id = current_tenant_id() AND r.anio_mes = m.anio_mes
                AND r.tipo = 'libro' AND r.deleted_at IS NULL
           LEFT JOIN LATERAL (
             SELECT count(*) AS patas_en_contpaqi,
                    sum(importe) FILTER (WHERE cargo_abono = 'A') AS total_en_contpaqi
               FROM analytics.gl_poliza_lines l
              WHERE l.tenant_id = current_tenant_id() AND l.source = 'contpaqi'
                AND l.tipo_pol = ? AND l.folio = '1' AND l.anio_mes = m.anio_mes
           ) p ON true
          ORDER BY m.anio_mes DESC
          LIMIT ?`,
        [TIPO_POLIZA_DIARIO, limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        anio_mes: r['anio_mes'],
        cfdis: Number(r['cfdis']),
        total_cfdis: r2(r['total_cfdis']),
        estado: (r['estado'] as string) ?? 'sin_iniciar',
        run_id: r['run_id'],
        facturas: r['facturas'] ? Number(r['facturas']) : null,
        renglones: r['renglones'] ? Number(r['renglones']) : null,
        total_cargos: r['total_cargos'] ? r2(r['total_cargos']) : null,
        generado_at: r['generado_at'], entregado_at: r['entregado_at'], aplicado_at: r['aplicado_at'],
        // Lo que ContPAQi tiene HOY para ese mes. Si está en cero y el mes tiene CFDIs,
        // la póliza no existe — es la señal que faltaba.
        patas_en_contpaqi: Number(r['patas_en_contpaqi'] ?? 0),
        total_en_contpaqi: r2(r['total_en_contpaqi']),
      }));
    });
  }

  // ── El sub-módulo: movimientos no asociados ───────────────────────────────────────────
  /**
   * El tablero del sub-módulo. Un renglón por mes con los tres números que importan:
   * cuántos CFDIs no están asociados a ninguna póliza, cuántos de esos ya se postearon (y
   * por eso NO hay que volver a mandarlos) y cuántos faltan de verdad.
   *
   * La señal de "no asociado" es `Documento.IsAsoContabilidad` del ADD. Verificada
   * 2026-09-02 contra `AsocCFDIs`, que es donde ContPAQi guarda la asociación de verdad:
   * coinciden dentro del 1% en jun/jul/ago-2026. Lo que NO se usa —y hay que no volver a
   * intentarlo— es `analytics.gl_poliza_lines.cfdi_uuid`: ese espejo tiene 18,979 de los
   * 504,365 UUID asociados (3.8%), así que reportaría miles de "no asociados" falsos.
   */
  async listNoAsociados(limit = 24) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        // Las patas de proveedor de todas las pólizas de compras, deduplicadas por
        // (mes, importe). Se pre-agregan a propósito: con un EXISTS correlacionado por
        // CFDI el tablero tardaba 4.3 s, y el GROUP BY evita que el LEFT JOIN multiplique
        // filas cuando dos proveedores casan el mismo importe en el mes.
        `WITH patas AS (
           SELECT anio_mes, round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ?
              AND cuenta_mayor LIKE '212%' AND cargo_abono = 'A'
            GROUP BY 1, 2
         ), cargos AS (
           -- La segunda puerta: compras cargadas a 501/502 desde CUALQUIER póliza del mes
           -- (típicamente la de egresos al pagar, sin pasar por 212). El importe ahí es el
           -- NETO sin impuestos. Ver la nota en getMes.
           SELECT anio_mes, round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND (cuenta LIKE '501%' OR cuenta LIKE '502%') AND cargo_abono = 'C'
              -- LC.18: sólo los meses del tablero. El join pide g.anio_mes = mes del CFDI, que
              -- ya está acotado abajo: recorrer todos los años no cambiaba ni una fila.
              AND anio_mes >= to_char(date_trunc('month', now()) - make_interval(months => ?), 'YYYY-MM')
            GROUP BY 1, 2
         ), ${MAPA_PROVEEDORES_CTE}, ctas AS (
           -- Los RFC que SÍ tienen cuenta de compras usable. Se resuelve acá para que el
           -- tablero muestre lo accionable (lo que entra al TXT) y no un total que incluye
           -- gasto y servicio, que nunca van a entrar. LC.18: del mapa unificado, el mismo
           -- que usa el detalle del mes (una fila por RFC).
           SELECT rfc, cuenta_proveedor FROM mapa WHERE proveedor_existe
         ), libros_hist AS (
           -- LC.18: para qué meses cuenta cada proveedor como «con historial»: si entró al
           -- libro en el mes M, cuenta para M+1 .. M+6. Se EXPANDE acá y se cruza por igualdad:
           -- con un EXISTS por CFDI contra esta lista el tablero tardaba 7.3 s.
           SELECT DISTINCT to_char(to_date(l.anio_mes, 'YYYY-MM') + make_interval(months => k), 'YYYY-MM') AS anio_mes,
                  l.cuenta
             FROM (SELECT DISTINCT anio_mes, cuenta
                     FROM analytics.gl_poliza_lines
                    WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
                      AND tipo_pol = ? AND folio = ? AND cuenta LIKE '212%' AND cargo_abono = 'A'
                      AND anio_mes >= to_char(date_trunc('month', now()) - make_interval(months => ?), 'YYYY-MM')) l
            CROSS JOIN generate_series(1, ${MESES_HISTORIAL}) AS k
         ), libro_uuid AS (
           -- La tercera puerta, exacta. DISTINCT obligatorio: la vista trae una fila por
           -- (source, source_key) y el libro histórico repite algún UUID; sin dedup el LEFT
           -- JOIN multiplicaría filas y el agregado de abajo sobrecontaría el mes.
           SELECT DISTINCT cfdi_uuid FROM finance.v_purchase_book_uuids
            -- LC.18.2: solo los meses que pueden tocar al tablero (su ventana + 12, la misma
            -- holgura medida en getMes). El filtro baja a las dos ramas de la vista.
            WHERE anio_mes >= to_char(date_trunc('month', now()) - make_interval(months => ?), 'YYYY-MM')
         ), base AS (
           SELECT to_char(f.fecha, 'YYYY-MM') AS anio_mes, f.total,
                  (f.aso_contabilidad IS NOT TRUE) AS sin_asociar,
                  (p.importe IS NOT NULL OR g.importe IS NOT NULL OR lu.cfdi_uuid IS NOT NULL) AS ya_en_poliza,
                  (lu.cfdi_uuid IS NOT NULL) AS por_uuid,
                  (c.rfc IS NOT NULL) AS con_cuenta,
                  (lh.cuenta IS NOT NULL) AS con_historial
             FROM fiscal.cfdis f
             LEFT JOIN libro_uuid lu ON lu.cfdi_uuid = upper(f.uuid)
             LEFT JOIN patas p
               ON p.anio_mes = to_char(f.fecha, 'YYYY-MM') AND p.importe = round(f.total, 2)
             LEFT JOIN cargos g
               ON g.anio_mes = to_char(f.fecha, 'YYYY-MM')
              AND g.importe = round(f.total
                    - coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)
                    - coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0), 2)
             LEFT JOIN ctas c ON c.rfc = f.emisor_rfc
             LEFT JOIN libros_hist lh ON lh.cuenta = c.cuenta_proveedor AND lh.anio_mes = to_char(f.fecha, 'YYYY-MM')
            WHERE f.tenant_id = current_tenant_id()
              AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I'
              -- (IG.14) FILTRO DE ROL EXPLICITO. La tabla fiscal.cfdis fue, hasta 2026-10-05, solo CFDI
              -- RECIBIDO, asi que este filtro era implicito y nadie lo escribio. Ahora el ADD
              -- tambien puede traer los EMITIDOS (213,520 facturas de VENTA por $4,680 M, que
              -- siempre estuvieron ahi y nunca se pidieron). Sin esta linea, el LIBRO DE COMPRAS
              -- empezaria a tratar nuestras propias facturas de venta como compras: un documento
              -- fiscal corrompido, y en silencio.
              AND f.rol = 'recibidas'
              -- Acotado a los meses que el tablero va a mostrar. Sin esto se escanean los
              -- 167 mil CFDIs del ADD para tirar 24 renglones.
              AND f.fecha >= date_trunc('month', now()) - make_interval(months => ?)
              -- LC.18: los cruces sólo hacen falta para lo NO asociado (todas las cifras de
              -- abajo filtran por eso). Hacerlos sobre los 31 mil CFDIs costaba ~300 ms; el
              -- total del mes sale aparte, de un conteo sin cruces.
              AND f.aso_contabilidad IS NOT TRUE
         ), totales AS (
           SELECT to_char(f.fecha, 'YYYY-MM') AS anio_mes, count(*) AS cfdis
             FROM fiscal.cfdis f
            WHERE f.tenant_id = current_tenant_id()
              AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I' AND f.rol = 'recibidas'
              AND f.fecha >= date_trunc('month', now()) - make_interval(months => ?)
            GROUP BY 1
         ), agg AS (
           SELECT t.anio_mes,
                  max(t.cfdis)                                          AS cfdis,
                  count(*) FILTER (WHERE sin_asociar)                   AS no_asociados,
                  sum(total) FILTER (WHERE sin_asociar)                 AS monto_no_asociado,
                  count(*) FILTER (WHERE sin_asociar AND ya_en_poliza)  AS ya_posteados,
                  sum(total) FILTER (WHERE sin_asociar AND ya_en_poliza) AS monto_ya_posteados,
                  -- Partidos por la FUERZA de la prueba: "ya está en el libro" es asunto
                  -- cerrado; "un importe igual ya está posteado" es trabajo por revisar.
                  count(*) FILTER (WHERE sin_asociar AND por_uuid)              AS ya_en_libro_exacto,
                  sum(total) FILTER (WHERE sin_asociar AND por_uuid)            AS monto_exacto,
                  count(*) FILTER (WHERE sin_asociar AND ya_en_poliza AND NOT por_uuid)   AS ya_por_importe,
                  sum(total) FILTER (WHERE sin_asociar AND ya_en_poliza AND NOT por_uuid) AS monto_por_importe,
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza)   AS faltan,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza) AS monto_faltan,
                  -- Lo que de verdad entra al TXT: sin asociar, sin postear y con cuenta.
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta AND con_historial)       AS entran,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta AND con_historial)     AS monto_entran,
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta AND NOT con_historial)   AS sin_historial,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND con_cuenta AND NOT con_historial) AS monto_sin_historial,
                  count(*) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND NOT con_cuenta)   AS fuera_catalogo,
                  sum(total) FILTER (WHERE sin_asociar AND NOT ya_en_poliza AND NOT con_cuenta) AS monto_fuera
             FROM totales t LEFT JOIN base b ON b.anio_mes = t.anio_mes
            GROUP BY t.anio_mes
         ), libro AS (
           SELECT anio_mes, count(*) AS patas
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ?
            GROUP BY 1
         )
         SELECT a.*, r.id AS run_id, r.estado, r.folio_poliza, r.facturas AS run_facturas,
                r.total_cargos, r.generado_at, r.entregado_at, r.aplicado_at,
                coalesce(lb.patas, 0) AS patas_libro
           FROM agg a
           LEFT JOIN libro lb ON lb.anio_mes = a.anio_mes
           LEFT JOIN finance.purchase_book_runs r
             ON r.tenant_id = current_tenant_id() AND r.anio_mes = a.anio_mes
                AND r.tipo = 'complemento' AND r.deleted_at IS NULL
          ORDER BY a.anio_mes DESC
          LIMIT ?`,
        [TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), limit,
          TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), limit + MESES_HISTORIAL,
          limit + VENTANA_PRUEBA_MESES, limit, limit,
          TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), limit],
      );
      return rows.map((r: Record<string, unknown>) => ({
        anio_mes: r['anio_mes'],
        cfdis: Number(r['cfdis']),
        no_asociados: Number(r['no_asociados']),
        monto_no_asociado: r2(r['monto_no_asociado']),
        ya_posteados: Number(r['ya_posteados']),
        monto_ya_posteados: r2(r['monto_ya_posteados']),
        // Certeza vs sospecha, separadas: la primera es asunto cerrado y la segunda es
        // trabajo. Juntarlas en un solo número esconde cuál de las dos hay que mirar.
        ya_en_libro_exacto: Number(r['ya_en_libro_exacto'] ?? 0),
        monto_exacto: r2(r['monto_exacto']),
        ya_por_importe: Number(r['ya_por_importe'] ?? 0),
        monto_por_importe: r2(r['monto_por_importe']),
        faltan: Number(r['faltan']),
        monto_faltan: r2(r['monto_faltan']),
        // Lo accionable: es lo que la tarjeta del mes debe mostrar, para que no contradiga
        // al encabezado del detalle (que también cuenta solo lo que entra al TXT).
        entran: Number(r['entran']),
        monto_entran: r2(r['monto_entran']),
        sin_historial: Number(r['sin_historial'] ?? 0),
        monto_sin_historial: r2(r['monto_sin_historial']),
        fuera_catalogo: Number(r['fuera_catalogo']),
        monto_fuera: r2(r['monto_fuera']),
        // Sin patas del libro, el mes entero está sin contabilizar (caso ago-2026).
        existe_libro: Number(r['patas_libro'] ?? 0) > 0,
        estado: (r['estado'] as string) ?? 'sin_iniciar',
        run_id: r['run_id'],
        // LC.18: sin corrida, el folio que tendría — el 1 si ContPAQi no tiene libro del mes.
        folio_poliza: r['folio_poliza'] ? Number(r['folio_poliza'])
          : (Number(r['patas_libro'] ?? 0) > 0 ? FOLIO_COMPLEMENTO : FOLIO_LIBRO),
        run_facturas: r['run_facturas'] ? Number(r['run_facturas']) : null,
        total_cargos: r['total_cargos'] ? r2(r['total_cargos']) : null,
        generado_at: r['generado_at'], entregado_at: r['entregado_at'], aplicado_at: r['aplicado_at'],
      }));
    });
  }

  /**
   * Hasta dónde llega el anti-duplicado EXACTO por UUID, y desde dónde el control vuelve a
   * ser el cruce por importe.
   *
   * Existe porque el límite tiene que estar **en pantalla**, no en un `.md`. La fuente del
   * histórico es un workbook mutable: si nadie corre el sembrado, o la contadora agrega un
   * mes que no se cargó, la puerta exacta simplemente no cubre — y un no-op se ve
   * exactamente igual que "no hay duplicados". Es el modo de falla de
   * `analytics.customer_receivables`, que estuvo en prod como tabla vacía.
   */
  async coberturaUuid() {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `SELECT source,
                count(*)::int                    AS renglones,
                count(DISTINCT cfdi_uuid)::int   AS uuids,
                min(anio_mes)                    AS desde,
                max(anio_mes)                    AS hasta,
                count(*) FILTER (WHERE nota IS NOT NULL)::int AS reparados,
                max(observado_at)                AS observado_at
           FROM finance.purchase_book_history
          WHERE deleted_at IS NULL
          GROUP BY source
          ORDER BY source`,
      );
      const total = rows.reduce((a: number, r: Record<string, unknown>) => a + Number(r['uuids']), 0);
      const hasta = rows.map((r: Record<string, unknown>) => String(r['hasta'] ?? '')).sort().pop() ?? null;
      return {
        cargado: total > 0,
        uuids: total,
        cubre_hasta: hasta,
        fuentes: rows,
      };
    });
  }

  // ── El mes: sus facturas y su cuadre ──────────────────────────────────────────────────
  /**
   * En modo `libro` devuelve TODOS los CFDIs del mes. En modo `complemento` devuelve solo
   * los **no asociados** — el universo del sub-módulo. Los que ya aparecen en la póliza
   * vienen marcados y excluidos por default, para no postearlos dos veces.
   *
   * ⚠️ Nada de signos de interrogación DENTRO del SQL de abajo, ni siquiera en un comentario
   * `--`: knex cuenta los placeholders con un escaneo de texto plano, sin distinguir
   * comentarios ni literales, así que un `¿...?` en español agrega bindings fantasma y tira
   * `Expected N bindings, saw N+1` en runtime. El build NO lo atrapa y una validación
   * DB-direct con `$1` tampoco, porque no pasa por el formateador de knex. Vivido acá el
   * 2026-09-02: la pantalla dio 500 en prod por un `-- ¿...?` de tres palabras.
   */
  async getMes(anioMes: string, tipo: TipoCorrida = 'libro'): Promise<{ mes: string; tipo: TipoCorrida; run: Record<string, unknown> | null; facturas: FacturaMes[]; resumen: Record<string, number>; bloqueantes: string[]; avisos: string[]; cuentas_impuesto: CuentasImpuesto }> {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      // [LC.18 · e2e] Sin `archivo_contenido`: son ~160 KB que la pantalla no usa, y bajarlos
      // costaba 150 ms de cada apertura. Lo único que hace falta del archivo son dos banderas.
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at')
        // ⚠️ `as unknown as string`: `Array<string>.concat` no acepta un `Knex.Raw` aunque el
        // `select` de Knex sí lo reciba en runtime. Misma forma y mismo motivo que
        // `cash-cut.service.ts:1439`. Sin esto el build sale `TS2769` — medido en CI, no supuesto.
        .first(COLUMNAS_RUN.map((c) => `finance.purchase_book_runs.${c}`).concat([
          knex.raw('(archivo_contenido IS NOT NULL) AS tiene_archivo') as unknown as string,
          knex.raw('coalesce(archivo_contenido ~ ?, false) AS archivo_legado', [REGEX_LINEA_LEGADA]) as unknown as string,
        ]));

      // Un RFC puede tener más de una cuenta en el mapa; DISTINCT ON evita duplicar la
      // factura por el join. Se prefiere la cuenta que ya se usó en pólizas reales.
      const { rows } = await knex.raw(
        `WITH patas AS (
           -- Prueba (a) del anti-duplicado, PRE-AGREGADA por importe. Correlacionar un
           -- EXISTS por cada CFDI hacía que abrir un mes de 722 facturas tardara 11.8 s.
           SELECT round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ? AND anio_mes = ?
              AND cuenta_mayor LIKE '212%' AND cargo_abono = 'A'
            GROUP BY 1
         ), cargos AS (
           -- Prueba (b), el mismo pre-agregado. Acá el importe es el NETO sin impuestos.
           SELECT round(importe, 2) AS importe
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND anio_mes = ?
              AND (cuenta LIKE '501%' OR cuenta LIKE '502%') AND cargo_abono = 'C'
            GROUP BY 1
         ), ${MAPA_PROVEEDORES_CTE}, hist AS (
           -- LC.18: las cuentas de proveedor que entraron al libro (Diario folio 1) en los
           -- meses ANTERIORES de la ventana. Sin historial, la factura no entra por default.
           SELECT DISTINCT cuenta
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ? AND cuenta LIKE '212%' AND cargo_abono = 'A'
              AND anio_mes >= ? AND anio_mes < ?
         ), prueba AS (
           -- LC.18.2: la puerta exacta, sobre una VENTANA de meses alrededor del mes. Unida a la
           -- vista entera (v_purchase_book_uuid_prueba) se ordenaban los 15,121 UUID del
           -- historico para cruzar ~600: ~75 % del tiempo de abrir el mes. El filtro de mes
           -- baja a las dos ramas de v_purchase_book_uuids (que no deduplica), y el DISTINCT ON
           -- con la misma prioridad se hace aca. Equivalencia medida: 0 diferencias en 77,712
           -- CFDIs de 58 meses contra la vista; con ventana de 0 meses difieren 24 (control).
           SELECT DISTINCT ON (u.cfdi_uuid) u.cfdi_uuid, u.source, u.anio_mes, u.referencia
             FROM finance.v_purchase_book_uuids u
            WHERE u.anio_mes >= ? AND u.anio_mes <= ?
            ORDER BY u.cfdi_uuid, ${ORDEN_PRUEBA_SQL}, u.anio_mes
         )
         SELECT DISTINCT ON (upper(f.uuid))
                (h.cuenta IS NOT NULL) AS en_libro_reciente, a.origen_mapa,
                ${IEPS8_SQL} AS ieps8,
                pu.source AS prueba_source, pu.referencia AS prueba_ref, pu.anio_mes AS prueba_mes,
                upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio,
                -- ⚠️ SIN BACKTICKS ACÁ: este comentario va dentro de un template literal de JS
                -- (rompía el build de api con "Expected ',', got 'ident'").
                -- to_char y no la columna cruda: pg devuelve date como Date de JS, y el
                -- String(...).slice(0,10) de abajo lo convertía en "Tue Sep 01" — el
                -- weekday en INGLÉS, no la fecha. Salía en la tabla, en el respaldo XLSX
                -- (columna declarada date recibiendo texto), en el CSV del asociador, y
                -- ordenaba los renglones del TXT alfabéticamente por día de la semana
                -- (Fri < Mon < Sat < Tue < Wed). Acá to_char es gratis: envolver la columna
                -- sólo anula el índice en el WHERE, no en la lista de selección.
                to_char(f.fecha, 'YYYY-MM-DD') AS fecha, f.total,
                coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                coalesce((f.impuestos->>'subtotal_iva_16')::numeric, 0) AS subtotal16,
                (f.impuestos->'traslados' @> '[{"tipo_factor":"Cuota"}]') AS ieps_por_cuota,
                a.account_suffix, a.supplier_name, a.cuenta_proveedor,
                a.cuenta_compra_exenta, a.cuenta_compra_iva,
                coalesce(a.proveedor_existe, false)     AS cuenta_existe,
                coalesce(a.compra_exenta_existe, false) AS compra_exenta_existe,
                coalesce(a.compra_iva_existe, false)    AS compra_iva_existe,
                f.aso_contabilidad, coalesce(f.estatus_sat, 'desconocido') AS estatus_sat,
                -- Defensa contra el doble registro mientras el TXT no lleve UUID. Hay DOS
                -- formas de que una compra ya esté contabilizada, y hay que mirar las dos:
                --
                --  a) patrón libro de compras: abono al proveedor 212 por el TOTAL,
                --     en el Diario folio 1.
                --  b) patrón compra pagada directo: cargo a 501/502 por el NETO (sin
                --     impuestos) desde la póliza de EGRESOS del pago, sin pasar por 212.
                --
                -- (b) se descubrió el 2026-09-03: en ago-2026 no hay UN SOLO abono a 212, y
                -- aun así había $7.2M cargados a 501/502 desde pólizas tipo 2 "PAGO FACT
                -- ...". Con sólo la prueba (a), 33 facturas por $2,095,889 se habrían
                -- posteado dos veces — una de ellas era el primer renglón del TXT de agosto.
                (p.importe IS NOT NULL OR g.importe IS NOT NULL OR pu.cfdi_uuid IS NOT NULL) AS ya_en_poliza,
                (p.importe IS NOT NULL) AS por_abono_212,
                i.incluida, i.motivo
           FROM fiscal.cfdis f
           -- LC.18: el mapa unificado (libro + ContPAQi), una fila por RFC.
           LEFT JOIN mapa a ON a.rfc = f.emisor_rfc
           LEFT JOIN hist h ON h.cuenta = a.cuenta_proveedor
           LEFT JOIN finance.purchase_book_run_items i
             ON i.tenant_id = f.tenant_id AND i.run_id = ? AND i.cfdi_uuid = upper(f.uuid)
            -- LC.17: lo que dejo registrado generar NO es una decision de una persona. Si
            -- contara como tal, el default del mes quedaria congelado en lo de la primera
            -- generacion aunque despues aparezca la poliza en ContPAQi.
            AND i.origen <> 'generado'
           -- La tercera puerta, EXACTA por UUID. Unívoca por CFDI (la vista hace
           -- DISTINCT ON), así que este join no puede multiplicar filas. Y va SIN join de
           -- mes a propósito: el corte del libro es por captura, no por fecha del CFDI —
           -- una factura de marzo capturada en la hoja de abril sólo se ve así.
           LEFT JOIN prueba pu ON pu.cfdi_uuid = upper(f.uuid)
           LEFT JOIN patas  p ON p.importe = round(f.total, 2)
           LEFT JOIN cargos g ON g.importe = round(
                 f.total
                 - coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)
                 - coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0), 2)
          WHERE f.tenant_id = current_tenant_id()
            AND f.source = 'contpaqi_add' AND f.tipo_comprobante = 'I'
            AND f.rol = 'recibidas'   -- (IG.14) ver la nota de arriba: sin esto el TXT lleva nuestras ventas
            -- Rango sobre la columna, NO to_char(fecha, 'YYYY-MM'): envolver la columna en
            -- una función anula el índice (tenant_id, fecha) y obliga a un seq scan de los
            -- 167k CFDIs — 4.6 s de los 11.8 s que tardaba abrir agosto. Equivalencia
            -- verificada contra el to_char en 5 meses: mismo conteo exacto.
            AND f.fecha >= ? AND f.fecha < ?
            -- El sub-módulo solo mira lo no asociado. IS NOT TRUE y no = false a
            -- propósito: NULL es "no sabemos" y también hay que mirarlo, no esconderlo.
            AND (? = 'libro' OR f.aso_contabilidad IS NOT TRUE)
          ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
        [TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), anioMes, anioMes,
          TIPO_POLIZA_DIARIO, String(FOLIO_LIBRO), this.mesMenos(anioMes, MESES_HISTORIAL), anioMes,
          this.mesMenos(anioMes, VENTANA_PRUEBA_MESES), this.mesMenos(anioMes, -VENTANA_PRUEBA_MESES),
          run?.id ?? null, this.inicioDeMes(anioMes), this.inicioDelSiguiente(anioMes), tipo],
      );

      const facturas: FacturaMes[] = rows.map((r: Record<string, unknown>) => {
        const total = r2(r['total']), iva = r2(r['iva']), iepsTotal = r2(r['ieps']);
        // [LC.18] Lo que se acredita es el IEPS al 8 %; el resto queda en el costo, como en el
        // libro manual. El reparto 501/502 es el de la contadora (`repartirFactura`).
        const ieps = r2(r['ieps8']);
        const { subtotal16, base_exenta: baseExenta } = repartirFactura(total, iva, ieps);
        const enLibroReciente = r['en_libro_reciente'] === true;
        const conCuenta = r['cuenta_existe'] === true;
        const yaEnPoliza = r['ya_en_poliza'] === true;
        const estatusSat = String(r['estatus_sat'] ?? 'desconocido');
        const cancelado = estatusSat === 'cancelado';

        // Qué prueba dice que ya está, y de qué fuerza. La exacta gana sobre la de importe.
        const src = r['prueba_source'] ? String(r['prueba_source']) : null;
        const ref = r['prueba_ref'] ? String(r['prueba_ref']) : '';
        const mesPrueba = r['prueba_mes'] ? String(r['prueba_mes']) : '';
        let prueba: FacturaMes['prueba_en_libro'] = null;
        let certeza: FacturaMes['prueba_certeza'] = null;
        let detalle: string | null = null;
        if (src === 'historico_xlsx') {
          prueba = 'uuid_libro_historico'; certeza = 'exacta';
          detalle = `mismo folio fiscal: renglón ${ref} del libro de ${mesPrueba}`;
        } else if (src === 'contpaqi_concepto' || src === 'contpaqi_asoccfdi') {
          prueba = 'uuid_concepto_contpaqi'; certeza = 'exacta';
          detalle = `mismo folio fiscal: ContPAQi lo tiene en ${ref} de ${mesPrueba}`;
        } else if (src && src.startsWith('run_')) {
          prueba = 'uuid_entregado'; certeza = 'exacta';
          detalle = `mismo folio fiscal: ya se entregó en el ${ref} de ${mesPrueba}`;
        } else if (yaEnPoliza) {
          const porAbono = r['por_abono_212'] === true;
          prueba = porAbono ? 'importe_abono_212' : 'importe_cargo_501_502';
          certeza = 'por_importe';
          detalle = porAbono
            ? `un abono a proveedor por ${total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} ya está en la póliza de compras del mes`
            : `un cargo a compras por el neto de esta factura ya está en alguna póliza del mes`;
        }
        // Entra si su proveedor está en el catálogo de compras, no está ya posteada (si no
        // la duplicamos) y no es un CFDI que el SAT dio de baja. El anti-duplicado aplica en
        // los dos modos: en `libro` el riesgo es MAYOR, porque abarca el mes entero.
        // [LC.18] Y en `complemento` el proveedor tiene que haber entrado al libro en los
        // últimos meses: lo que no, queda para que una persona lo revise (ver en_libro_reciente).
        const sinHistorial = tipo === 'complemento' && !enLibroReciente;
        const porDefault = conCuenta && !yaEnPoliza && !cancelado && !sinHistorial;
        return {
          uuid: String(r['uuid']),
          emisor_rfc: String(r['emisor_rfc'] ?? ''),
          emisor_nombre: String(r['emisor_nombre'] ?? ''),
          serie: (r['serie'] as string) ?? null,
          folio: (r['folio'] as string) ?? null,
          fecha: String(r['fecha']).slice(0, 10),
          total, iva, ieps, subtotal16,
          base_exenta: baseExenta,
          ieps_total: iepsTotal,
          ieps_no_acreditable: r2(iepsTotal - ieps),
          ieps_por_cuota: r['ieps_por_cuota'] === true,
          en_libro_reciente: enLibroReciente,
          origen_mapa: (r['origen_mapa'] as FacturaMes['origen_mapa']) ?? null,
          cuenta_sugerida: null,
          account_suffix: (r['account_suffix'] as string) ?? null,
          supplier_name: (r['supplier_name'] as string) ?? null,
          cuenta_proveedor: (r['cuenta_proveedor'] as string) ?? null,
          cuenta_compra_exenta: (r['cuenta_compra_exenta'] as string) ?? null,
          cuenta_compra_iva: (r['cuenta_compra_iva'] as string) ?? null,
          cuenta_existe: conCuenta,
          compra_exenta_existe: r['compra_exenta_existe'] === true,
          compra_iva_existe: r['compra_iva_existe'] === true,
          // La decisión guardada manda; si no hay, el default del modo. En `complemento` el
          // default es además el criterio que LC.2 buscaba y no encontraba en el CFDI: lo
          // que falta por contabilizar es lo que ContPAQi mismo dice que no está asociado.
          // [LC.18 · e2e] La prueba EXACTA gana también sobre la decisión guardada: una factura
          // marcada a mano que ya se entregó (mismo folio fiscal) seguía contando como «entra»
          // y el chip decía «Entran al TXT 1» con el mes ya entregado.
          incluida: certeza === 'exacta'
            ? false
            : r['incluida'] === null || r['incluida'] === undefined
              ? porDefault
              : r['incluida'] === true,
          motivo_exclusion: (r['motivo'] as string)
            ?? (cancelado ? 'CFDI cancelado en el SAT' : null)
            ?? detalle
            ?? (conCuenta && sinHistorial
              ? `el proveedor no entró al libro en los últimos ${MESES_HISTORIAL} meses: revísala y márcala si va`
              : null),
          prueba_en_libro: prueba, prueba_certeza: certeza, prueba_detalle: detalle,
          estatus_sat: estatusSat,
          aso_contabilidad: r['aso_contabilidad'] === null || r['aso_contabilidad'] === undefined
            ? null
            : r['aso_contabilidad'] === true,
          ya_en_poliza: yaEnPoliza,
        };
      });

      // [LC.18 · e2e] Para las facturas sin cuenta: ¿hay una 212 de ContPAQi, libre, cuyo nombre
      // sea el del emisor? Medido en oct-2026: 262 «sin cuenta», casi todas de GASTO (gasolineras,
      // inmobiliarias), y TODAS ofrecían «Asignar cuenta». Con esto la pantalla sólo destaca la
      // acción donde hay una candidata real; el resto se lee como lo que es.
      if (tipo === 'complemento') await this.sugerirCuentasDelMes(knex, facturas);

      const dentro = facturas.filter((f) => f.incluida);
      const resumen = {
        cfdis_del_mes: facturas.length,
        incluidas: dentro.length,
        excluidas: facturas.length - dentro.length,
        total: r2(dentro.reduce((a, f) => a + f.total, 0)),
        subtotal_exento: r2(dentro.reduce((a, f) => a + f.base_exenta, 0)),
        subtotal_gravado: r2(dentro.reduce((a, f) => a + f.subtotal16, 0)),
        iva: r2(dentro.reduce((a, f) => a + f.iva, 0)),
        ieps: r2(dentro.reduce((a, f) => a + f.ieps, 0)),
        total_todas: r2(facturas.reduce((a, f) => a + f.total, 0)),
        // Los tres números del sub-módulo: cuántas no están asociadas, cuántas de esas ya
        // se postearon (y por eso NO van), y cuántas faltan de verdad.
        no_asociadas: facturas.filter((f) => f.aso_contabilidad !== true).length,
        ya_posteadas: facturas.filter((f) => f.ya_en_poliza).length,
        monto_ya_posteadas: r2(facturas.filter((f) => f.ya_en_poliza).reduce((a, f) => a + f.total, 0)),
      };

      // Dos listas distintas, y la diferencia importa: los BLOQUEANTES son renglones que
      // ContPAQi rechazaría, así que apagan el botón de generar. Los AVISOS son cosas que
      // merecen una mirada pero se postean sin problema. Mezclarlos deja el mes trabado
      // por una nota informativa, que es justo lo que pasó con "IEPS por cuota" en julio.
      const bloqueantes: string[] = [];
      const avisos: string[] = [];
      const sinMapa = dentro.filter((f) => !f.account_suffix);
      const ctaMala = dentro.filter((f) => f.account_suffix && !f.cuenta_existe);
      // Se pregunta por `*_existe`, NO por el string de la cuenta: ese está precalculado y
      // nunca falta, así que el freno viejo (`!f.cuenta_compra_iva`) no frenaba nada.
      const sinCta502 = dentro.filter((f) => f.subtotal16 > 0.004 && (!f.cuenta_compra_iva || !f.compra_iva_existe));
      const sinCta501 = dentro.filter((f) => f.base_exenta > 0.004 && (!f.cuenta_compra_exenta || !f.compra_exenta_existe));
      const negativas = dentro.filter((f) => f.base_exenta < -0.004);
      const cuota = dentro.filter((f) => f.ieps_por_cuota);
      const cancelados = dentro.filter((f) => f.estatus_sat === 'cancelado');
      if (cancelados.length) {
        // Bloqueante, no aviso: un cancelado posteado es un asiento que hay que reversar.
        bloqueantes.push(`${cancelados.length} factura(s) canceladas en el SAT — no se pueden postear`);
      }
      if (sinMapa.length) bloqueantes.push(`${sinMapa.length} factura(s) de un RFC que no está en el mapa de cuentas`);
      if (ctaMala.length) bloqueantes.push(`${ctaMala.length} factura(s) con una cuenta de proveedor que no existe en ContPAQi`);
      if (sinCta502.length) bloqueantes.push(`${sinCta502.length} factura(s) con base gravada pero sin cuenta de compras c/IVA en ContPAQi`);
      if (sinCta501.length) bloqueantes.push(`${sinCta501.length} factura(s) con base exenta pero sin cuenta de compras al 0% en ContPAQi`);
      if (negativas.length) bloqueantes.push(`${negativas.length} factura(s) con base exenta negativa — revisar descuentos`);
      // [LC.18] Lo que el libro NO acredita se declara con su monto: es una decisión contable
      // que hoy se toma por omisión, y así queda a la vista de quien la quiera revisar.
      const noAcred = dentro.filter((f) => f.ieps_no_acreditable > 0.004);
      if (noAcred.length) {
        const monto = r2(noAcred.reduce((a, f) => a + f.ieps_no_acreditable, 0));
        avisos.push(
          `${noAcred.length} factura(s) con IEPS que no es al 8 % (cuota o 26.5 %): `
          + `${monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} quedan en el costo y no se acreditan, igual que en el libro manual`,
        );
      } else if (cuota.length) {
        avisos.push(`${cuota.length} factura(s) con IEPS por cuota`);
      }

      // Declarar la ignorancia en vez de esconderla. El ADD trae `CancelStatus` vacío en
      // casi todo (167,053 de 167,135 CFDIs), así que "no cancelado" acá significa "no nos
      // consta", no "vigente". Lo que se pierde si una resultó cancelada es el
      // acreditamiento de IVA+IEPS, no la compra — por eso el monto que se declara es ése.
      const sinVerificar = dentro.filter((f) => f.estatus_sat === 'desconocido');
      if (sinVerificar.length) {
        const pct = Math.round((sinVerificar.length / Math.max(dentro.length, 1)) * 100);
        const enRiesgo = r2(sinVerificar.reduce((a, f) => a + f.iva + f.ieps, 0));
        avisos.push(
          `${sinVerificar.length} de ${dentro.length} facturas (${pct}%) sin estatus verificado contra el SAT: `
          + `no se valida cancelación. Acreditan ${enRiesgo.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} de IVA e IEPS.`,
        );
      }

      if (tipo === 'complemento') {
        const yaPost = facturas.filter((f) => f.ya_en_poliza);
        if (yaPost.length) {
          avisos.push(`${yaPost.length} factura(s) sin marca pero con su importe ya en la póliza del mes — excluidas para no duplicarlas`);
        }
        const sinDato = facturas.filter((f) => f.aso_contabilidad === null);
        if (sinDato.length) avisos.push(`${sinDato.length} factura(s) sin dato de asociación: corre el feed del ADD`);
        const fuera = facturas.filter((f) => !f.incluida && !f.ya_en_poliza && !f.motivo_exclusion);
        if (fuera.length) avisos.push(`${fuera.length} factura(s) no asociadas de proveedores fuera del catálogo de compras (gasto o servicio)`);
        const sinHist = facturas.filter((f) => f.cuenta_existe && !f.ya_en_poliza && f.estatus_sat !== 'cancelado' && !f.en_libro_reciente);
        if (sinHist.length) {
          const monto = r2(sinHist.reduce((a, f) => a + f.total, 0));
          avisos.push(
            `${sinHist.length} factura(s) por ${monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} de proveedores que no entraron al libro `
            + `en los últimos ${MESES_HISTORIAL} meses: no entran solas, revísalas en «Sin libro reciente»`,
          );
        }
      }

      const cuentasImpuesto = await this.cuentasImpuesto(knex, anioMes);
      return { mes: anioMes, tipo, run: this.runParaPantalla(run), facturas, resumen, bloqueantes, avisos, cuentas_impuesto: cuentasImpuesto };
    });
  }

  // ── Decidir qué entra ─────────────────────────────────────────────────────────────────
  /** Excluye (o vuelve a incluir) facturas del mes. Mientras LC.2 esté abierto, esto es
   *  el criterio: lo pone una persona y queda registrado con su motivo. */
  async setInclusion(anioMes: string, uuids: string[], incluida: boolean, motivo?: string, tipo: TipoCorrida = 'libro') {
    this.mesValido(anioMes);
    if (!Array.isArray(uuids) || !uuids.length) throw new BadRequestException('sin facturas que marcar');
    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      // `entregado` cuenta igual que `aplicado`: el archivo ya salió de nuestras manos, así
      // que cambiarle la inclusión separa en silencio la decisión registrada de lo que se
      // entregó. Si de verdad hay que corregir, se cancela la corrida y se hace otra.
      if (run.estado === 'aplicado' || run.estado === 'entregado') {
        throw new BadRequestException(
          `la corrida de ${anioMes} ya está ${run.estado}; no se puede cambiar qué entra. Cancélala si hay que corregir.`,
        );
      }
      const filas = uuids.map((u) => ({
        tenant_id: run.tenant_id, run_id: run.id, cfdi_uuid: String(u).toUpperCase(),
        incluida, motivo: incluida ? null : (motivo ?? null), origen: 'manual', created_by: userId,
      }));
      await knex('finance.purchase_book_run_items').insert(filas)
        .onConflict(['tenant_id', 'run_id', 'cfdi_uuid'])
        .merge(['incluida', 'motivo', 'origen']);
      await this.invalidar(knex, run, userId);
      return { ok: true, afectadas: filas.length };
    });
  }

  /**
   * Cambió lo que va en el archivo, así que lo generado antes ya no corresponde: vuelve a
   * `borrador` y se tira el artefacto.
   *
   * ⚠️ Se borra `archivo_contenido` junto con el hash. Limpiar sólo el hash dejaba el TXT
   * viejo descargable — `obtenerArchivo` sólo miraba que el contenido existiera — y lo
   * servía con `X-Archivo-Hash` vacío: un archivo sin firma que ya no era el del mes.
   */
  private async invalidar(knex: any, run: Record<string, unknown>, userId: string | null) {
    if (run['estado'] !== 'generado') return;
    await knex('finance.purchase_book_runs').where({ id: run['id'] }).update({
      estado: 'borrador', archivo_hash: null, archivo_contenido: null,
      updated_at: knex.fn.now(), updated_by: userId,
    });
    // Lo que registró la generación describía ese archivo, que ya no existe.
    await knex('finance.purchase_book_run_items').where({ run_id: run['id'], origen: ORIGEN_GENERADO }).del();
  }

  /**
   * `[LC.17]` — La corrida como la ve la pantalla: sin el TXT (son ~77 KB que la pantalla no
   * usa) y con lo que sí necesita saber de él, si se puede entregar y, si no, por qué.
   */
  private runParaPantalla(run: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
    if (!run) return null;
    const { tiene_archivo: tiene, archivo_legado: legado, ...resto } = run;
    const conArchivo = resto['estado'] === 'generado' || resto['estado'] === 'entregado' || resto['estado'] === 'aplicado';
    const v = conArchivo ? vigenciaPorBanderas(tiene === true, legado === true) : { vigente: false, motivo: null };
    return { ...resto, archivo_vigente: v.vigente, archivo_motivo: v.motivo };
  }

  /** `[LC.17]` — Agrega un renglón a `notas` sin borrar lo que ya había. */
  private sumarNota(knex: Knex, nota: string): Knex.Raw {
    return knex.raw(`concat_ws(chr(10), nullif(notas, ''), ?::text)`, [nota]);
  }

  /** `[LC.17]` — ¿ContPAQi ya tiene ese folio del Diario en el mes? (la misma guarda de generar) */
  private async folioOcupado(knex: Knex, anioMes: string, folio: number): Promise<{ patas: number; cargos: number } | null> {
    const { rows } = await knex.raw(
      `SELECT coalesce(num_lines, 0) AS patas, round(coalesce(cargos, 0), 2) AS cargos
         FROM analytics.gl_polizas
        WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
          AND tipo_pol = ? AND folio = ? AND anio_mes = ?
        LIMIT 1`,
      [TIPO_POLIZA_DIARIO, String(folio), anioMes],
    );
    return rows.length ? { patas: Number(rows[0].patas), cargos: Number(rows[0].cargos) } : null;
  }

  /**
   * Cambia la carátula de la corrida: con qué folio y con qué concepto entra la póliza.
   *
   * Existe por los meses que NO tienen libro. ago-2026 es el caso: cero abonos a 212 y sin
   * póliza folio 1, así que "todo lo no asociado" ES el mes — el alcance del complemento es
   * el correcto, pero tiene que entrar como folio 1 "REGISTRO DE COMPRAS DEL MES", no como
   * folio 2 "COMPLEMENTO".
   *
   * Editar el folio a secas sería peor que no editarlo, así que va con guarda: se rechaza si
   * ContPAQi YA tiene ese folio ocupado en el Diario de ese mes. ago-2026 folio 1 está libre
   * (el mes arranca en el 3) y pasa; jul-2026 folio 1 tiene 597 renglones y se rechaza —
   * julio necesita un complemento en folio 2, que es exactamente lo correcto.
   */
  async setCaratula(anioMes: string, datos: { folio_poliza?: number; concepto?: string }, tipo: TipoCorrida = 'complemento') {
    this.mesValido(anioMes);
    const folio = datos.folio_poliza === undefined || datos.folio_poliza === null ? null : Number(datos.folio_poliza);
    const concepto = typeof datos.concepto === 'string' ? datos.concepto.trim() : null;
    if (folio === null && concepto === null) throw new BadRequestException('nada que cambiar');
    if (folio !== null && (!Number.isInteger(folio) || folio < 1 || folio > 999999)) {
      throw new BadRequestException('el folio de la póliza tiene que ser un entero entre 1 y 999999');
    }
    if (concepto !== null && !concepto) throw new BadRequestException('el concepto no puede quedar vacío');

    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      if (run.estado === 'aplicado' || run.estado === 'entregado') {
        throw new BadRequestException(`la corrida de ${anioMes} ya está ${run.estado}; no se puede cambiar la carátula.`);
      }

      if (folio !== null && folio !== run.folio_poliza) {
        const { rows } = await knex.raw(
          `SELECT coalesce(num_lines, 0) AS patas, round(coalesce(cargos, 0), 2) AS cargos
             FROM analytics.gl_polizas
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND folio = ? AND anio_mes = ?
            LIMIT 1`,
          [TIPO_POLIZA_DIARIO, String(folio), anioMes],
        );
        if (rows.length) {
          throw new BadRequestException(
            `ContPAQi ya tiene el folio ${folio} del Diario en ${anioMes} `
            + `(${rows[0].patas} renglones por ${rows[0].cargos}). Elige otro folio.`,
          );
        }
      }

      const patch: Record<string, unknown> = { updated_at: knex.fn.now(), updated_by: userId };
      if (folio !== null) patch['folio_poliza'] = folio;
      if (concepto !== null) patch['concepto'] = concepto;
      try {
        await knex.transaction((sp: Knex.Transaction) => sp('finance.purchase_book_runs').where({ id: run.id }).update(patch));
      } catch (e) {
        // [LC.18 · B6] Otra corrida nuestra del mismo mes ya usa ese folio: era un 500.
        if ((e as { code?: string })?.code === '23505') {
          throw new BadRequestException(`otra corrida de ${anioMes} ya usa el folio ${folio}. Elige otro.`);
        }
        throw e;
      }
      // Cambió la carátula: el archivo firmado ya no corresponde.
      await this.invalidar(knex, run, userId);
      return {
        ok: true, anio_mes: anioMes, tipo,
        folio_poliza: folio ?? run.folio_poliza,
        concepto: concepto ?? run.concepto,
      };
    });
  }

  // ── Proveedor nuevo: su cuenta 212 ────────────────────────────────────────────────────
  /**
   * `[LC.18]` — Para un RFC que no está en el mapa: las cuentas de proveedor de ContPAQi que
   * pueden ser la suya, con la razón de cada una.
   *
   * Existe porque cada mes entran proveedores nuevos (en jul/ago/sep-2026: 2, 5 y 4 facturas
   * de cuentas creadas después de sembrar el mapa) y sin esto la contadora no tiene cómo
   * decirle al módulo cuál es la cuenta. **Sugiere, no decide**: la cuenta la confirma una
   * persona en `asignarCuenta` — el nombre solo no alcanza para asentar (`[CP.8.20]`: «PASCUAL»
   * casaba con una persona física distinta).
   */
  async sugerirCuenta(rfc: string): Promise<SugerenciasCuenta> {
    const r = this.rfcValido(rfc);
    return this.tk.run(async (knex) => {
      const { rows: em } = await knex.raw(
        `SELECT emisor_nombre FROM fiscal.cfdis
          WHERE tenant_id = current_tenant_id() AND rol = 'recibidas' AND upper(emisor_rfc) = ?
          ORDER BY fecha DESC LIMIT 1`, [r]);
      const nombre = String(em[0]?.emisor_nombre ?? '');
      const { rows } = await knex.raw(
        `WITH cands AS (
           SELECT s.cuenta, s.cuenta_nombre AS nombre,
                  (upper(coalesce(s.rfc, '')) = ? OR upper(coalesce(s.rfc_por_uuid, '')) = ?) AS por_uuid,
                  (upper(coalesce(s.rfc_por_nombre, '')) = ?) AS por_nombre_contpaqi
             FROM contpaqi.supplier_accounts s
            WHERE s.tenant_id = current_tenant_id() AND s.cuenta LIKE '212%'
           UNION ALL
           SELECT ca.codigo, ca.nombre, false, false
             FROM analytics.contpaqi_accounts ca
            WHERE ca.tenant_id = current_tenant_id() AND ca.codigo LIKE '212%'
           UNION ALL
           SELECT DISTINCT gl.cuenta, gl.cuenta_nombre, false, false
             FROM analytics.gl_poliza_lines gl
            WHERE gl.tenant_id = current_tenant_id() AND gl.source = 'contpaqi' AND gl.cuenta LIKE '212%'
              AND gl.anio_mes >= to_char(now() - interval '6 months', 'YYYY-MM')
         )
         SELECT c.cuenta, max(c.nombre) AS nombre, bool_or(c.por_uuid) AS por_uuid,
                bool_or(c.por_nombre_contpaqi) AS por_nombre_contpaqi,
                max(a.rfc) AS asignada_a
           FROM cands c
           LEFT JOIN finance.gl_supplier_accounts a
             ON a.tenant_id = current_tenant_id() AND a.deleted_at IS NULL AND a.account_suffix = substr(c.cuenta, 4)
          WHERE length(c.cuenta) = 10
          GROUP BY c.cuenta`,
        [r, r, r]);
      const parecido = (s: string) => parecidoNombre(nombre, s);
      const candidatas = rows
        .map((c: Record<string, unknown>) => {
          const score = r2(parecido(String(c['nombre'] ?? '')));
          const porUuid = c['por_uuid'] === true;
          const porNombre = c['por_nombre_contpaqi'] === true;
          const asignadaA = c['asignada_a'] ? String(c['asignada_a']) : null;
          return {
            cuenta: String(c['cuenta']).trim(),
            nombre: String(c['nombre'] ?? ''),
            parecido: score,
            razon: porUuid ? 'ContPAQi le asoció un CFDI de este RFC'
              : porNombre ? 'ContPAQi la relaciona con este RFC por el nombre'
                : `el nombre se parece (${Math.round(score * 100)} %)`,
            asignada_a: asignadaA && asignadaA.toUpperCase() !== r ? asignadaA : null,
            fuerte: porUuid,
          };
        })
        .filter((c: { fuerte: boolean; parecido: number; razon: string }) => c.fuerte || c.razon.startsWith('ContPAQi') || c.parecido >= PARECIDO_MINIMO)
        .sort((a: { fuerte: boolean; parecido: number }, b: { fuerte: boolean; parecido: number }) =>
          Number(b.fuerte) - Number(a.fuerte) || b.parecido - a.parecido)
        .slice(0, 6);
      return { rfc: r, nombre, candidatas };
    });
  }

  /**
   * `[LC.18]` — Asienta la cuenta 212 de un RFC (y con ella sus 501/502) en el mapa del libro.
   *
   * Frenos, todos ANTES de escribir:
   *  · la cuenta tiene que **existir en ContPAQi** (catálogo o ya usada en una póliza): un TXT
   *    que cita una cuenta inexistente se rechaza entero al importarlo;
   *  · un RFC tiene UNA cuenta en el mapa: si ya tiene otra, se dice cuál y no se pisa;
   *  · una cuenta es de UN proveedor: si ya es de otro RFC, no se reasigna en silencio.
   * Si la cuenta ya estaba en el mapa SIN RFC (los 24 del catálogo original), se le pone.
   */
  async asignarCuenta(rfc: string, cuenta: string): Promise<{ ok: true; rfc: string; cuenta_proveedor: string; cuenta_compra_exenta: string; cuenta_compra_iva: string; compra_exenta_existe: boolean; compra_iva_existe: boolean; accion: 'alta' | 'rfc_puesto' }> {
    const r = this.rfcValido(rfc);
    const c = String(cuenta ?? '').trim();
    if (!/^212\d{7}$/.test(c)) throw new BadRequestException('la cuenta de proveedor es de 10 dígitos y empieza con 212');
    const suf = c.slice(3);
    const userId = this.ctx.get()?.userId ?? null;
    return this.tk.run(async (knex) => {
      const existe = async (codigo: string) => {
        const { rows } = await knex.raw(
          `SELECT (EXISTS (SELECT 1 FROM analytics.contpaqi_accounts WHERE tenant_id = current_tenant_id() AND codigo = ?)
                OR EXISTS (SELECT 1 FROM analytics.gl_poliza_lines WHERE tenant_id = current_tenant_id() AND source = 'contpaqi' AND cuenta = ?)) AS ok,
                  (SELECT nombre FROM analytics.contpaqi_accounts WHERE tenant_id = current_tenant_id() AND codigo = ? LIMIT 1) AS nombre`,
          [codigo, codigo, codigo]);
        return { ok: rows[0]?.ok === true, nombre: (rows[0]?.nombre as string | null) ?? null };
      };
      const p = await existe(c);
      if (!p.ok) {
        throw new BadRequestException(
          `la cuenta ${c} no existe en ContPAQi (o todavía no aparece en ninguna póliza ni en el catálogo). Dala de alta en ContPAQi y vuelve a intentar.`,
        );
      }
      const delRfc = await knex('finance.gl_supplier_accounts')
        .whereRaw('upper(rfc) = ?', [r]).whereNull('deleted_at').first();
      if (delRfc && delRfc.account_suffix !== suf) {
        throw new BadRequestException(`el RFC ${r} ya tiene la cuenta ${delRfc.cuenta_proveedor} en el libro; no se cambia desde aquí.`);
      }
      const e501 = await existe(`501${suf}`);
      const e502 = await existe(`502${suf}`);
      const deCuenta = await knex('finance.gl_supplier_accounts')
        .where({ account_suffix: suf }).whereNull('deleted_at').first();
      if (deCuenta && deCuenta.rfc && String(deCuenta.rfc).toUpperCase() !== r) {
        throw new BadRequestException(`la cuenta ${c} ya es del RFC ${deCuenta.rfc} (${deCuenta.supplier_name}).`);
      }
      const flags = {
        proveedor_existe: true, compra_exenta_existe: e501.ok, compra_iva_existe: e502.ok,
        verificado_at: knex.fn.now(), updated_at: knex.fn.now(), updated_by: userId,
      };
      let accion: 'alta' | 'rfc_puesto';
      if (deCuenta) {
        await knex('finance.gl_supplier_accounts').where({ id: deCuenta.id }).update({ ...flags, rfc: r });
        accion = 'rfc_puesto';
      } else {
        const { rows: em } = await knex.raw(
          `SELECT emisor_nombre FROM fiscal.cfdis WHERE tenant_id = current_tenant_id() AND rol = 'recibidas'
              AND upper(emisor_rfc) = ? ORDER BY fecha DESC LIMIT 1`, [r]);
        await knex('finance.gl_supplier_accounts').insert({
          tenant_id: knex.raw('current_tenant_id()'),
          supplier_name: p.nombre || String(em[0]?.emisor_nombre ?? r),
          rfc: r, account_suffix: suf, cuenta_proveedor: c,
          cuenta_compra_exenta: `501${suf}`, cuenta_compra_iva: `502${suf}`,
          source: 'manual_lc', notas: 'LC.18: asignada desde Movimientos no asociados',
          created_by: userId, ...flags,
        });
        accion = 'alta';
      }
      this.logger.log(`Cuenta ${c} asignada a ${r} (${accion})`);
      // La cuenta dejó de estar libre: que no se siga sugiriendo a otro emisor.
      this.candidatasCache.clear();
      return {
        ok: true as const, rfc: r, cuenta_proveedor: c,
        cuenta_compra_exenta: `501${suf}`, cuenta_compra_iva: `502${suf}`,
        compra_exenta_existe: e501.ok, compra_iva_existe: e502.ok, accion,
      };
    });
  }

  /**
   * `[LC.18 · e2e]` Una consulta para todo el mes: las cuentas 212 que no son de nadie en el
   * mapa, y la mejor por nombre para cada emisor sin cuenta. Pone `cuenta_sugerida` en sitio.
   */
  private async sugerirCuentasDelMes(knex: Knex, facturas: FacturaMes[]): Promise<void> {
    const sinCuenta = facturas.filter((f) => !f.account_suffix);
    if (!sinCuenta.length) return;
    const cands = await this.cuentasCandidatas(knex);
    const porNombre = new Map<string, FacturaMes['cuenta_sugerida']>();
    for (const f of sinCuenta) {
      if (!porNombre.has(f.emisor_nombre)) {
        const propios = tokensNombre(f.emisor_nombre);
        let mejor: FacturaMes['cuenta_sugerida'] = null;
        for (const c of cands) {
          const p = parecidoTokens(propios, c.tokens);
          if (p >= PARECIDO_FILA && (!mejor || p > mejor.parecido)) mejor = { cuenta: c.cuenta, nombre: c.nombre, parecido: r2(p) };
        }
        porNombre.set(f.emisor_nombre, mejor);
      }
      f.cuenta_sugerida = porNombre.get(f.emisor_nombre) ?? null;
    }
  }

  /**
   * Las 212 libres (de nadie en el mapa), con sus tokens. Cambian cuando se da de alta una cuenta
   * en ContPAQi o se asigna una aquí — no a cada clic: se guardan unos minutos por tenant
   * (medido: 70–90 ms de los ~500 de abrir el mes) y `asignarCuenta` las invalida.
   */
  private candidatasCache = new Map<string, { at: number; cands: { cuenta: string; nombre: string; tokens: Set<string> }[] }>();

  private async cuentasCandidatas(knex: Knex): Promise<{ cuenta: string; nombre: string; tokens: Set<string> }[]> {
    const tenant = this.ctx.get()?.tenantId ?? '';
    const hit = tenant ? this.candidatasCache.get(tenant) : undefined;
    if (hit && Date.now() - hit.at < CANDIDATAS_TTL_MS) return hit.cands;
    const { rows } = await knex.raw(
      `WITH cands AS (
         SELECT ca.codigo AS cuenta, ca.nombre
           FROM analytics.contpaqi_accounts ca
          WHERE ca.tenant_id = current_tenant_id() AND ca.codigo LIKE '212%'
         UNION
         SELECT DISTINCT gl.cuenta, gl.cuenta_nombre
           FROM analytics.gl_poliza_lines gl
          WHERE gl.tenant_id = current_tenant_id() AND gl.source = 'contpaqi' AND gl.cuenta LIKE '212%'
            AND gl.anio_mes >= to_char(now() - interval '6 months', 'YYYY-MM')
       )
       SELECT c.cuenta, max(c.nombre) AS nombre
         FROM cands c
        WHERE length(c.cuenta) = 10 AND c.cuenta <> '2120000000'
          AND NOT EXISTS (SELECT 1 FROM finance.gl_supplier_accounts a
                           WHERE a.tenant_id = current_tenant_id() AND a.deleted_at IS NULL
                             AND a.rfc IS NOT NULL AND a.account_suffix = substr(c.cuenta, 4))
        GROUP BY c.cuenta`,
    );
    // Tokens de cada cuenta UNA vez: el mes trae ~100 emisores sin cuenta contra ~1,000 cuentas.
    const cands = rows.map((r: Record<string, unknown>) => {
      const nombre = String(r['nombre'] ?? '');
      return { cuenta: String(r['cuenta']).trim(), nombre, tokens: tokensNombre(nombre) };
    });
    if (tenant) this.candidatasCache.set(tenant, { at: Date.now(), cands });
    return cands;
  }

  private rfcValido(rfc: string): string {
    const r = String(rfc ?? '').trim().toUpperCase();
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(r)) throw new BadRequestException('RFC inválido');
    return r;
  }

  private async ensureRun(knex: any, anioMes: string, tipo: TipoCorrida = 'libro') {
    const existente = await knex('finance.purchase_book_runs')
      .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
    if (existente) return existente;
    // [LC.18] Lo normal cada mes es que ContPAQi todavía NO tenga el libro: entonces lo no
    // asociado ES el libro y entra como folio 1 con el concepto de siempre. Sólo si el folio 1
    // ya existe es un complemento en el 2. Antes nacía siempre en 2 y había que acordarse de
    // cambiar la carátula — el modo normal dependía de un paso manual.
    // Una corrida `libro` vieja (la pantalla del libro completo crea una al marcar facturas)
    // puede tener tomado el folio 1 aunque ContPAQi no: entonces va al 2 y se avisa en la carátula.
    const folio1Nuestro = await knex('finance.purchase_book_runs')
      .where({ anio_mes: anioMes, folio_poliza: FOLIO_LIBRO }).whereNull('deleted_at').first();
    const libroLibre = tipo === 'complemento' && !folio1Nuestro
      && !(await this.folioOcupado(knex, anioMes, FOLIO_LIBRO));
    const esComplemento = tipo === 'complemento' && !libroLibre;
    try {
      // Savepoint: un 23505 aborta la transacción entera y la consulta de abajo fallaría.
      const [creado] = await knex.transaction((sp) => sp('finance.purchase_book_runs')
        .insert({
          tenant_id: knex.raw('current_tenant_id()'), anio_mes: anioMes, estado: 'borrador', tipo,
          folio_poliza: esComplemento ? FOLIO_COMPLEMENTO : FOLIO_LIBRO,
          fecha_poliza: this.finDeMes(anioMes).toISOString().slice(0, 10),
          concepto: esComplemento ? `COMPLEMENTO REGISTRO DE COMPRAS ${anioMes}` : conceptoLibro(anioMes),
          // [LC.18 · e2e] El default de la columna es false, y la pantalla lo leía como la
          // opción elegida: marcar una factura creaba la corrida y DESMARCABA «poner el UUID»
          // sola al recargar. El TXT de oct-2026 salió así, sin UUID. El default del generador
          // es con UUID (`opts.uuid !== false`); la corrida nace igual.
          incluye_uuid: true,
          created_by: this.ctx.get()?.userId ?? null,
        })
        .returning('*'));
      return creado;
    } catch (e) {
      // [LC.18 · B6] Dos clics a la vez, o una corrida `libro` vieja en el mismo folio: el
      // UNIQUE (tenant, mes, folio) responde 23505 y eso salía como 500.
      if ((e as { code?: string })?.code !== '23505') throw e;
      const otra = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (otra) return otra;
      throw new BadRequestException(
        `${anioMes} ya tiene otra corrida en el folio ${esComplemento ? FOLIO_COMPLEMENTO : FOLIO_LIBRO}. Cambia el folio en la carátula.`,
      );
    }
  }

  // ── El archivo ────────────────────────────────────────────────────────────────────────
  /**
   * Arma los movimientos del asiento. Por factura: cargo a compras exentas, cargo a
   * compras c/IVA y abono al proveedor. Los impuestos, global o por cuenta.
   *
   * Cuidado con dos cosas que ya costaron caro:
   *  - lo que va a la cuenta `502` es el SUBTOTAL gravado, no la base fiscal del IVA —
   *    esa base incluye al IEPS y lo contaría dos veces;
   *  - ese subtotal va NETO de descuento, o la base exenta sale negativa.
   */
  construirMovimientos(
    facturas: FacturaMes[], modo: ImpuestosModo, conUuid: boolean,
    /** `[LC.18]` Las del último libro (`cuentasImpuesto`); las fijas sólo si no hay ninguno. */
    cuentas: { iva: string; ieps: string } = { iva: CTA_IVA, ieps: CTA_IEPS },
  ): Movimiento[] {
    const movs: Movimiento[] = [];
    const ivaPorCuenta = new Map<string, number>();
    const iepsPorCuenta = new Map<string, number>();

    /**
     * Invariante del generador: ningún movimiento sale sin cuenta, nunca. Es la última
     * línea de defensa después de los bloqueantes y de `rechazables`, y existe porque el
     * modo de falla es invisible: `padR(null, 30)` produce 30 espacios, el renglón se ve
     * bien en pantalla, y ContPAQi rechaza el archivo entero al importarlo.
     */
    const pata = (cuenta: string | null, m: Omit<Movimiento, 'cuenta'>, quien: string): Movimiento => {
      if (!cuenta || !String(cuenta).trim()) {
        throw new BadRequestException(`${quien}: falta la cuenta contable. No se puede armar el archivo.`);
      }
      return { cuenta: String(cuenta).trim(), ...m };
    };

    for (const f of [...facturas].sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
      // [LC.18] Los últimos 5 caracteres del folio, como el libro manual: medido en las 763
      // facturas de jul/ago/sep-2026 (folio 361750 → 61750, 000806268 → 06268). Con el folio
      // entero, ningún renglón de proveedor coincidía con lo que la contadora sube.
      const ref = String(f.folio ?? '').trim().slice(-5);
      const concepto = conUuid ? f.uuid : '';
      const quien = `${f.emisor_nombre || f.emisor_rfc} folio ${f.folio ?? '(sin folio)'}`;
      if (f.base_exenta > 0.004) {
        movs.push(pata(f.cuenta_compra_exenta, { referencia: ref, abono: false, importe: f.base_exenta, concepto }, `${quien} (compras al 0%)`));
      }
      if (f.subtotal16 > 0.004) {
        movs.push(pata(f.cuenta_compra_iva, { referencia: ref, abono: false, importe: f.subtotal16, concepto }, `${quien} (compras c/IVA)`));
      }
      movs.push(pata(f.cuenta_proveedor, { referencia: ref, abono: true, importe: f.total, concepto }, `${quien} (proveedor)`));
      if (f.iva > 0.004) ivaPorCuenta.set(f.account_suffix!, r2((ivaPorCuenta.get(f.account_suffix!) ?? 0) + f.iva));
      if (f.ieps > 0.004) iepsPorCuenta.set(f.account_suffix!, r2((iepsPorCuenta.get(f.account_suffix!) ?? 0) + f.ieps));
    }

    if (modo === 'por-cuenta') {
      for (const [suf, monto] of [...ivaPorCuenta].sort()) {
        movs.push({ cuenta: cuentas.iva, referencia: suf, abono: false, importe: monto, concepto: 'IVA acreditable' });
      }
      for (const [suf, monto] of [...iepsPorCuenta].sort()) {
        movs.push({ cuenta: cuentas.ieps, referencia: suf, abono: false, importe: monto, concepto: 'IEPS acreditable' });
      }
    } else {
      const iva = r2([...ivaPorCuenta.values()].reduce((a, b) => a + b, 0));
      const ieps = r2([...iepsPorCuenta.values()].reduce((a, b) => a + b, 0));
      if (iva > 0.004) movs.push({ cuenta: cuentas.iva, referencia: '', abono: false, importe: iva, concepto: '' });
      if (ieps > 0.004) movs.push({ cuenta: cuentas.ieps, referencia: '', abono: false, importe: ieps, concepto: '' });
    }
    return movs;
  }

  /**
   * El TXT del mes. El layout vive en `./poliza-txt` — acá sólo se resuelve la fecha de la
   * póliza, que es el último día del mes.
   */
  construirTxt(
    anioMes: string,
    folio: number,
    concepto: string,
    movs: Movimiento[],
    /**
     * `[CP.8.30]` — Los UUID que salen como renglones `AD`, para que **ContPAQi asocie** el
     * comprobante al importar.
     *
     * ⚠️ No confundir con `conUuid` de `construirMovimientos`, que escribe el UUID en el
     * **concepto** del renglón: eso sólo nos deja leerlo de vuelta (`[LC.15]`), no asocia nada.
     * La asociación vive en `AsocCFDIs` y el único registro que la crea es `AD`.
     *
     * ⛔ Default `[]` **a propósito**: sin este argumento el archivo sale idéntico al byte, que
     * es el invariante que `[CP.8.29]` dejó probado sobre un flujo que mueve $30–56M al mes.
     */
    uuids: readonly string[] = [],
  ): string {
    const d = this.finDeMes(anioMes);
    const fecha = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    /**
     * ⚠️ `uuids` es el **noveno** argumento, no el séptimo: entre `guid` y él están `impresa` y
     * `ajuste`. Pasarlo en la posición equivocada no falla — el array se serializa dentro del
     * ENCABEZADO y el archivo sale corrupto en silencio. Lo atrapó el invariante del candado
     * («apagado y lista vacía dan el mismo archivo»), no el compilador.
     */
    return construirTxt(fecha, folio, concepto, movs, undefined, undefined, undefined, undefined, uuids);
  }

  /** Desarma un TXT de póliza. El parser vive en ./poliza-txt, junto al layout. */
  parsearTxt(txt: string): PolizaTxtParseada {
    return parsearTxt(txt);
  }

  /**
   * Genera el archivo del mes y deja la corrida en `generado`, firmada por su hash.
   *
   * **Sólo genera el `complemento`.** El modo `libro` sirve de tablero de lectura, pero su
   * camino de generación es un footgun sin caso de uso: cualquier mes real cae en "la
   * póliza ya existe" (y entonces lo que falta es el complemento) o "no existe" (y entonces
   * el complemento ES el mes, sólo que con folio 1 — ver `setCaratula`). Y el alcance
   * `libro` es estrictamente más peligroso: arrastra los CFDIs que ContPAQi YA tiene
   * asociados, que es una vía de duplicado que ninguna de las dos puertas cubre.
   */
  async generar(anioMes: string, opts: { impuestos?: ImpuestosModo; uuid?: boolean; asociar?: boolean; tipo?: TipoCorrida; forzar_importe?: boolean; motivo?: string } = {}) {
    this.mesValido(anioMes);
    const modo: ImpuestosModo = opts.impuestos === 'por-cuenta' ? 'por-cuenta' : 'global';
    const conUuid = opts.uuid !== false;
    /**
     * `[CP.8.30]` — ⛔ `=== true`, no `!== false`. La bandera de al lado (`uuid`) usa la forma
     * permisiva porque lleva meses probada; ésta **tiene que estar apagada salvo que alguien la
     * pida explícitamente**, porque emite un registro (`AD`) que ningún import real verificó y
     * el archivo que lo llevaría es la póliza del mes.
     */
    const asocia = opts.asociar === true;
    const tipo: TipoCorrida = opts.tipo === 'complemento' ? 'complemento' : 'libro';
    if (tipo === 'libro') {
      throw new BadRequestException(
        'el libro completo del mes ya no se genera: arrastra facturas que ContPAQi ya tiene asociadas y las duplicaría. '
        + 'Usa "Movimientos no asociados"; si el mes no tiene póliza, cámbiale el folio a 1 en la carátula.',
      );
    }
    const { facturas, resumen, bloqueantes, cuentas_impuesto: ctasImp } = await this.getMes(anioMes, tipo);
    const dentro = facturas.filter((f) => f.incluida);
    if (!dentro.length) throw new BadRequestException('no hay movimientos sin asociar por entregar en este mes');

    // Si alguna de las incluidas ya está posteada, el archivo duplicaría un asiento. No es
    // un aviso, es un bloqueo — el daño es irreversible del lado de ContPAQi y nadie lo
    // notaría hasta cuadrar la balanza. Va sin condicionar por tipo: la asimetría anterior
    // (sólo en `complemento`) era un accidente del orden en que se escribió, y dejaba sin
    // freno justo al modo que abarca el mes entero.
    // Certeza: es el MISMO folio fiscal. No hay caso legítimo, no hay override.
    const exactas = dentro.filter((f) => f.prueba_certeza === 'exacta');
    if (exactas.length) {
      throw new BadRequestException(
        `${exactas.length} factura(s) incluidas YA están en el libro por su UUID (${exactas.slice(0, 3).map((f) => f.prueba_detalle).join(' · ')}). `
        + 'Es el mismo folio fiscal: volver a entregarlas duplica el asiento. Exclúyelas.',
      );
    }
    // Sospecha: el cruce por importe tiene falsos positivos por diseño (dos facturas del
    // mismo monto casan igual). Quitarle la salida al humano convierte una molestia en
    // trabajo perdido — son 271 CFDIs por $32.6M en limbo. El override existe, pero deja
    // rastro: sin motivo no pasa, y el motivo se guarda con quién lo puso.
    const sospechosas = dentro.filter((f) => f.prueba_certeza === 'por_importe');
    if (sospechosas.length && !(opts.forzar_importe && opts.motivo?.trim())) {
      throw new BadRequestException(
        `${sospechosas.length} factura(s) incluidas tienen un importe igual ya posteado en el mes: podrían duplicarse. `
        + 'Exclúyelas, o confirma que son distintas explicando por qué.',
      );
    }

    // Frenos duros: mejor no entregar archivo que entregar uno que ContPAQi va a rechazar.
    // Cada pata que el asiento vaya a escribir tiene que tener su cuenta, y esa cuenta
    // tiene que EXISTIR del lado de ContPAQi — ver la nota de los `*_existe` en FacturaMes.
    const rechazables = dentro.filter((f) => !f.account_suffix || !f.cuenta_existe
      || (f.subtotal16 > 0.004 && (!f.cuenta_compra_iva || !f.compra_iva_existe))
      || (f.base_exenta > 0.004 && (!f.cuenta_compra_exenta || !f.compra_exenta_existe))
      || f.base_exenta < -0.004
      || f.estatus_sat === 'cancelado');
    if (rechazables.length) {
      throw new BadRequestException(
        `${rechazables.length} factura(s) no se pueden postear: ${bloqueantes.join(' · ')}. Resuélvelo o exclúyelas.`,
      );
    }

    const movs = this.construirMovimientos(dentro, modo, conUuid, { iva: ctasImp.iva.cuenta, ieps: ctasImp.ieps.cuenta });
    const cargos = r2(movs.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0));
    const abonos = r2(movs.filter((m) => m.abono).reduce((a, m) => a + m.importe, 0));
    if (Math.abs(r2(cargos - abonos)) >= 0.01) {
      throw new BadRequestException(`la póliza no cuadra: cargos ${cargos} vs abonos ${abonos}`);
    }

    return this.tk.run(async (knex) => {
      const run = await this.ensureRun(knex, anioMes, tipo);
      if (run.estado === 'aplicado') throw new BadRequestException('el mes ya está aplicado');
      // `[LC.17]` `entregado` cuenta igual que `aplicado`, como en `setInclusion`: regenerar
      // pisaba el archivo y la firma que ya salieron de nuestras manos, y lo entregado dejaba
      // de tener evidencia. Si ContPAQi lo rechazó, se cancela la entrega y se genera otro.
      if (run.estado === 'entregado') {
        throw new BadRequestException(
          `el archivo de ${anioMes} ya se entregó; no se puede regenerar encima. `
          + 'Si ContPAQi lo rechazó, cancela la entrega y vuelve a generarlo.',
        );
      }

      // Se vuelve a mirar el folio acá y no sólo en `setCaratula`: entre editar la carátula
      // y generar pudo correr el feed y traerse una póliza nueva en ese folio. Es el último
      // momento en que se puede avisar antes de que el archivo salga.
      const ocupado = await this.folioOcupado(knex, anioMes, run.folio_poliza ?? FOLIO_COMPLEMENTO);
      if (ocupado) {
        throw new BadRequestException(
          `ContPAQi ya tiene el folio ${run.folio_poliza} del Diario en ${anioMes} `
          + `(${ocupado.patas} renglones por ${ocupado.cargos}). Cambia el folio de la carátula antes de generar.`,
        );
      }

      const concepto = run.concepto || `REGISTRO DE COMPRAS DEL MES ${anioMes}`;
      /**
       * `[CP.8.30]` — Un `AD` por comprobante incluido. ⚠️ `dentro`, no `movs`: una factura
       * produce **varios** renglones (exento, gravado, IVA, IEPS) y emitir un `AD` por renglón
       * asociaría el mismo comprobante tres o cuatro veces.
       *
       * ⛔ El emisor **se niega** ante un UUID que no mida 36 en vez de rellenarlo: un renglón
       * `AD` de largo correcto con basura adentro asocia el comprobante equivocado, y eso no lo
       * detecta nadie hasta cuadrar la balanza.
       */
      const asociados = asocia
        ? [...new Set(dentro.map((f) => String(f.uuid ?? '').trim()).filter(Boolean))]
        : [];
      const txt = this.construirTxt(anioMes, run.folio_poliza ?? FOLIO_LIBRO, concepto, movs, asociados);
      const hash = createHash('sha256').update(txt, 'latin1').digest('hex');
      // [LC.18 · e2e] El nombre lo decide el FOLIO, no el tipo de corrida: el libro del mes
      // (folio 1) bajaba como «complemento-compras-2026-10.txt».
      const nombre = Number(run.folio_poliza ?? FOLIO_LIBRO) === FOLIO_LIBRO
        ? `poliza-compras-${anioMes}.txt`
        : `complemento-compras-${anioMes}.txt`;
      const userId = this.ctx.get()?.userId ?? null;

      await knex('finance.purchase_book_runs').where({ id: run.id }).update({
        estado: 'generado', facturas: dentro.length, renglones: movs.length + 1,
        total_cargos: cargos, total_abonos: abonos,
        subtotal_exento: resumen['subtotal_exento'], subtotal_gravado: resumen['subtotal_gravado'],
        total_iva: resumen['iva'], total_ieps: resumen['ieps'],
        // El contenido se guarda, no sólo su hash: `fiscal.cfdis` sigue creciendo, así que
        // este archivo no se puede reproducir mañana. Es la evidencia de lo entregado.
        archivo_hash: hash, archivo_nombre: nombre, archivo_contenido: txt,
        impuestos_modo: modo, incluye_uuid: conUuid, asocia_cfdi: asocia,
        generado_at: knex.fn.now(), generado_by: userId,
        // Una corrida cancelada que se vuelve a generar es otro archivo: lo de la entrega
        // anterior no le pertenece.
        entregado_at: null, entregado_by: null, entregado_a: null,
        updated_at: knex.fn.now(), updated_by: userId,
        // Un override sin rastro es un override que nadie audita. Se SUMA a las notas: pisarlas
        // borraba el motivo de un override anterior.
        ...(sospechosas.length && opts.motivo
          ? { notas: this.sumarNota(knex, `${sospechosas.length} factura(s) incluidas pese al cruce por importe. Motivo: ${opts.motivo.trim()}`) }
          : {}),
      });

      /**
       * `[LC.17]` — Qué facturas lleva ESTE archivo, una fila por UUID.
       *
       * ⛔ Antes sólo existían las filas que alguien marcó a mano, así que las incluidas por
       * default —casi todas— no dejaban rastro, y la puerta exacta "ya se entregó"
       * (`v_purchase_book_uuids`, que lee estas filas) nunca las veía: un complemento entregado
       * en folio 2 no lo atrapa la puerta (a), que mira el folio 1, y el mes volvía a ofrecer las
       * mismas facturas. `origen = 'generado'` las distingue de una decisión (ver `getMes`) y
       * no pisa la de una persona (`ignore`): una fila manual ya dice lo mismo o más.
       */
      await knex('finance.purchase_book_run_items').where({ run_id: run.id, origen: ORIGEN_GENERADO }).del();
      const registradas = [...new Set(dentro.map((f) => String(f.uuid).toUpperCase()))].map((u) => ({
        tenant_id: run.tenant_id, run_id: run.id, cfdi_uuid: u,
        incluida: true, motivo: null, origen: ORIGEN_GENERADO, created_by: userId,
      }));
      if (registradas.length) {
        await knex('finance.purchase_book_run_items').insert(registradas)
          .onConflict(['tenant_id', 'run_id', 'cfdi_uuid']).ignore();
      }
      this.logger.log(`Póliza ${tipo} ${anioMes}: ${dentro.length} facturas · ${movs.length} movimientos · ${cargos}`);
      return { anio_mes: anioMes, tipo, nombre, hash, folio: run.folio_poliza ?? FOLIO_LIBRO, facturas: dentro.length, renglones: movs.length + 1, cargos, abonos, txt };
    });
  }

  /**
   * Devuelve el TXT **ya generado**, tal cual quedó guardado. Es sólo lectura a propósito.
   *
   * Antes la descarga llamaba a `generar()`, y eso escribía: bajar un mes que ya estaba en
   * `entregado` lo regresaba a `generado` (el trámite retrocedía solo) y recalculaba el
   * hash, así que si entre generar y descargar entraba un CFDI nuevo el archivo bajado ya
   * no era el firmado — y nadie se enteraba, porque el hash se pisaba junto con él.
   */
  async obtenerArchivo(anioMes: string, tipo: TipoCorrida = 'libro') {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      // El estado se mira además del contenido: en `borrador` no hay archivo vigente aunque
      // haya quedado texto de una corrida anterior. Cinturón redundante con `invalidar()`.
      // `cancelado` igual que `borrador`: `invalidar` sólo limpia corridas en `generado`, así
      // que una cancelada conservaba su archivo y lo seguía sirviendo.
      if (!run || run.estado === 'borrador' || run.estado === 'cancelado' || !run.archivo_contenido) {
        throw new NotFoundException(
          `${anioMes} no tiene archivo generado todavía. Genéralo primero.`,
        );
      }
      // `[LC.17]` Servir un archivo que ContPAQi rechaza es peor que no servir nada: se descubre
      // al importar, con la contadora enfrente. Pasaba con el complemento de 2026-07.
      const vig = vigenciaArchivo(run.archivo_contenido as string);
      if (!vig.vigente) throw new BadRequestException(`${anioMes}: ${vig.motivo}.`);
      const parsed = this.parsearTxt(run.archivo_contenido as string);
      return {
        anio_mes: anioMes,
        tipo,
        nombre: run.archivo_nombre || `${tipo === 'complemento' ? 'complemento' : 'poliza'}-compras-${anioMes}.txt`,
        hash: run.archivo_hash as string,
        txt: run.archivo_contenido as string,
        // Los movimientos del archivo ENTREGADO, no un recálculo. Los consumen el respaldo
        // en Excel y el CSV del asociador de CFDI.
        movimientos: parsed.movimientos,
        invalidos: parsed.invalidos,
      };
    });
  }

  /**
   * El respaldo del archivo entregado: sus movimientos y las facturas que lo componen.
   *
   * A ContPAQi va el TXT **y su respaldo** — nadie sube $48.2M a la contabilidad de la
   * empresa desde un archivo de longitud fija que no puede leer. Esta es la hoja que
   * reemplaza al Excel que se armaba a mano.
   *
   * Todo sale del **archivo entregado**, no de los datos de hoy. Importa: si entre generar
   * y descargar el respaldo entró un CFDI nuevo, tomar las facturas de `getMes()` haría que
   * las dos hojas describan cosas distintas y el respaldo dejaría de cuadrar contra el TXT.
   * Cuando el archivo lleva UUID (el default) las facturas se resuelven desde los conceptos
   * de sus propios renglones; si no, se cae a la decisión registrada y se declara.
   */
  async respaldo(anioMes: string, tipo: TipoCorrida = 'complemento') {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (!run || run.estado === 'borrador' || !run.archivo_contenido) {
        throw new NotFoundException(`${anioMes} no tiene archivo generado todavía. Genéralo primero.`);
      }
      const { movimientos, invalidos, header } = parsearTxt(run.archivo_contenido as string);
      if (invalidos.length) {
        throw new BadRequestException(
          `el archivo guardado de ${anioMes} no cumple el layout (${invalidos[0].motivo}); no se puede armar el respaldo.`,
        );
      }

      const uuids = [...new Set(movimientos.map((m) => m.concepto).filter((c) => /^[0-9A-Fa-f-]{36}$/.test(c)))]
        .map((u) => u.toUpperCase());
      const desdeArchivo = uuids.length > 0;

      const { rows: facturas } = desdeArchivo
        ? await knex.raw(
          `WITH ${MAPA_PROVEEDORES_CTE}
           SELECT DISTINCT ON (upper(f.uuid))
                  upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio,
                  to_char(f.fecha, 'YYYY-MM-DD') AS fecha, f.total,
                  coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                  coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                  ${IEPS8_SQL} AS ieps8,
                  a.account_suffix, a.supplier_name,
                  a.cuenta_proveedor, a.cuenta_compra_exenta, a.cuenta_compra_iva
             FROM fiscal.cfdis f
             LEFT JOIN mapa a ON a.rfc = f.emisor_rfc
            WHERE f.tenant_id = current_tenant_id() AND upper(f.uuid) = ANY (?)
              AND f.rol = 'recibidas'   -- cinturon: el UUID ya acota, pero el rol es la regla
            ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
          [uuids],
        )
        : await knex.raw(
          `WITH ${MAPA_PROVEEDORES_CTE}
           SELECT DISTINCT ON (upper(f.uuid))
                  upper(f.uuid) AS uuid, f.emisor_rfc, f.emisor_nombre, f.serie, f.folio,
                  to_char(f.fecha, 'YYYY-MM-DD') AS fecha, f.total,
                  coalesce((f.impuestos->>'iva_trasladado')::numeric, 0)  AS iva,
                  coalesce((f.impuestos->>'ieps_trasladado')::numeric, 0) AS ieps,
                  ${IEPS8_SQL} AS ieps8,
                  a.account_suffix, a.supplier_name,
                  a.cuenta_proveedor, a.cuenta_compra_exenta, a.cuenta_compra_iva
             FROM finance.purchase_book_run_items i
             JOIN fiscal.cfdis f
               ON f.tenant_id = i.tenant_id AND upper(f.uuid) = i.cfdi_uuid
             LEFT JOIN mapa a ON a.rfc = f.emisor_rfc
            WHERE i.tenant_id = current_tenant_id() AND i.run_id = ? AND i.incluida
              AND f.rol = 'recibidas'   -- cinturon: el run ya acota, pero el rol es la regla
            ORDER BY upper(f.uuid), a.usado_en_asiento DESC NULLS LAST, a.account_suffix`,
          [run.id],
        );

      return {
        anio_mes: anioMes,
        tipo,
        folio_poliza: header?.folio ?? run.folio_poliza,
        concepto: header?.concepto ?? run.concepto,
        estado: run.estado,
        archivo_nombre: run.archivo_nombre,
        archivo_hash: run.archivo_hash,
        generado_at: run.generado_at,
        entregado_at: run.entregado_at,
        entregado_a: run.entregado_a,
        total_cargos: Number(run.total_cargos ?? 0),
        total_abonos: Number(run.total_abonos ?? 0),
        movimientos,
        facturas: facturas.map((f: Record<string, unknown>): FacturaRespaldo => {
          // [LC.18] El mismo reparto que el generador: si difiere, el respaldo no cuadra con el TXT.
          const total = r2(f['total']), iva = r2(f['iva']), ieps = r2(f['ieps8']);
          const { subtotal16, base_exenta } = repartirFactura(total, iva, ieps);
          return {
            uuid: String(f['uuid']), emisor_rfc: String(f['emisor_rfc'] ?? ''),
            emisor_nombre: String(f['emisor_nombre'] ?? ''),
            serie: (f['serie'] as string) ?? null, folio: (f['folio'] as string) ?? null,
            fecha: String(f['fecha']).slice(0, 10),
            base_exenta, subtotal16, ieps, iva, total,
            supplier_name: (f['supplier_name'] as string) ?? null,
            cuenta_proveedor: (f['cuenta_proveedor'] as string) ?? null,
            cuenta_compra_exenta: (f['cuenta_compra_exenta'] as string) ?? null,
            cuenta_compra_iva: (f['cuenta_compra_iva'] as string) ?? null,
          };
        }),
        /** `archivo` = las facturas salen de los UUID del propio TXT. `decision` = del registro. */
        facturas_origen: desdeArchivo ? 'archivo' : 'decision',
      };
    });
  }

  /**
   * LC.15 — el listado `movimiento ↔ UUID` para el **Asociador de CFDI** de ContPAQi.
   *
   * Rompe el círculo vicioso por el lado de la honestidad del flag: el layout del TXT no
   * tiene campo de UUID, así que ContPAQi contabiliza la factura y nadie la asocia →
   * `IsAsoContabilidad` queda en false → nuestro filtro primario dice "no asociada" → el
   * heurístico por importe tiene que cargar toda la decisión. Con este CSV la contadora
   * crea la asociación formal y el flag empieza a decir la verdad.
   *
   * Un renglón por factura, anclado en la pata de ABONO a `212`: es la única que hay
   * exactamente una por factura, su importe es el total del CFDI, y es la que ContPAQi liga.
   *
   * Sale de `parsearTxt(archivo_contenido)`, no de `getMes()`: tiene que describir el
   * archivo ENTREGADO o al primer CFDI nuevo deja de casar con la póliza.
   */
  async asociadorCsv(anioMes: string, tipo: TipoCorrida = 'complemento') {
    const r = await this.respaldo(anioMes, tipo);
    // Tipado explícito: sin él TS infiere el valor del Map como `{}` desde la tupla.
    const porUuid = new Map<string, FacturaRespaldo>(r.facturas.map((f) => [f.uuid, f] as const));

    // `;` y latin1: el Excel es-MX usa punto y coma como separador de lista, y esta máquina
    // vive en Windows-1252 — en UTF-8 los acentos de los proveedores llegan rotos.
    const cab = [
      'renglon_txt', 'poliza_tipo', 'poliza_folio', 'cuenta', 'referencia', 'cargo_abono',
      'importe', 'uuid', 'emisor_rfc', 'emisor_nombre', 'fecha_cfdi', 'serie_folio',
    ];
    const esc = (v: unknown) => String(v ?? '').replace(/[;\r\n]/g, ' ').trim();
    const lineas = [cab.join(';')];
    r.movimientos.forEach((m, i) => {
      // Sólo la pata del proveedor: es la que se asocia. Las de compras e impuestos son
      // contrapartida del mismo asiento y asociarlas duplicaría el vínculo.
      if (!m.abono) return;
      const f = porUuid.get(m.concepto.toUpperCase());
      lineas.push([
        // Se rotula como NUESTRO orden, no como NumMovto: que ContPAQi lo asigne en orden
        // de importación es una suposición sin verificar. Lo que identifica el renglón sin
        // suponer nada es cuenta + referencia + cargo_abono + importe.
        i + 1, TIPO_POLIZA_DIARIO, r.folio_poliza,
        esc(m.cuenta), esc(m.referencia), 'A', m.importe.toFixed(2),
        esc(m.concepto), esc(f?.emisor_rfc), esc(f?.emisor_nombre), esc(f?.fecha),
        esc([f?.serie, f?.folio].filter(Boolean).join(' ')),
      ].join(';'));
    });

    return {
      nombre: `asociador-cfdi-${anioMes}-${tipo}.csv`,
      csv: `${lineas.join('\r\n')}\r\n`,
      renglones: lineas.length - 1,
    };
  }

  /** Mueve el trámite. `entregado` = se le pasó a quien lo sube; `aplicado` = ya está en ContPAQi. */
  async marcar(anioMes: string, estado: Extract<EstadoRun, 'entregado' | 'aplicado' | 'cancelado'>, datos: { entregado_a?: string; notas?: string; tipo?: TipoCorrida } = {}) {
    this.mesValido(anioMes);
    const tipo: TipoCorrida = datos.tipo === 'complemento' ? 'complemento' : 'libro';
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (!run) throw new NotFoundException(`no hay corrida ${tipo} para ${anioMes}`);
      const actual = run.estado as EstadoRun;
      if (!(TRANSICIONES_RUN[actual] ?? []).includes(estado)) {
        if (actual === 'borrador') throw new BadRequestException('genera el archivo antes de mover el trámite');
        if (actual === 'aplicado') {
          throw new BadRequestException(`el complemento de ${anioMes} ya está aplicado en ContPAQi; el trámite terminó.`);
        }
        throw new BadRequestException(`no se puede pasar de ${actual} a ${estado}`);
      }
      // No se entrega un archivo que ContPAQi va a rechazar, ni uno que no se guardó.
      if (estado === 'entregado') {
        const vig = vigenciaArchivo(run.archivo_contenido as string | null);
        if (!vig.vigente) throw new BadRequestException(`no se puede marcar entregado: ${vig.motivo}.`);
      }
      // Cancelar una entrega devuelve sus facturas a "pendientes" (la puerta exacta deja de
      // verlas). Si ContPAQi ya tiene la póliza en ese folio, lo que corresponde es aplicado.
      if (estado === 'cancelado' && actual === 'entregado') {
        const ocupado = await this.folioOcupado(knex, anioMes, run.folio_poliza ?? FOLIO_COMPLEMENTO);
        if (ocupado) {
          throw new BadRequestException(
            `ContPAQi ya tiene el folio ${run.folio_poliza} del Diario en ${anioMes} `
            + `(${ocupado.patas} renglones por ${ocupado.cargos}): márcalo aplicado, no cancelado.`,
          );
        }
      }
      const userId = this.ctx.get()?.userId ?? null;
      const patch: Record<string, unknown> = { estado, updated_at: knex.fn.now(), updated_by: userId };
      if (estado === 'entregado') { patch['entregado_at'] = knex.fn.now(); patch['entregado_by'] = userId; patch['entregado_a'] = datos.entregado_a ?? null; }
      if (estado === 'aplicado') { patch['aplicado_at'] = knex.fn.now(); patch['aplicado_by'] = userId; }
      // Se suma: pisarla borraba el motivo del override que `generar` dejó escrito.
      if (datos.notas?.trim()) patch['notas'] = this.sumarNota(knex, datos.notas.trim());
      await knex('finance.purchase_book_runs').where({ id: run.id }).update(patch);
      return { ok: true, anio_mes: anioMes, estado };
    });
  }

  /**
   * LC.7 — compara **lo que se entregó** contra la póliza que quedó en ContPAQi.
   *
   * Antes re-derivaba los movimientos con `getMes()` + `construirMovimientos()`, o sea
   * comparaba los datos de HOY: si entre entregar y cuadrar entraba un CFDI nuevo al mes,
   * reportaba un descuadre que no existía. Ahora se parsea `archivo_contenido`, que es
   * inmutable — para eso se guarda. Si no hay archivo **no se compara**: la re-derivación
   * silenciosa ES el bug, y el arreglo es negarse, no comparar mejor.
   *
   * El folio sale del encabezado del ARCHIVO y no de `run.folio_poliza`, porque el folio
   * definitivo lo decide quien lo sube.
   */
  async cuadrarContraContpaqi(anioMes: string, tipo: TipoCorrida = 'complemento') {
    this.mesValido(anioMes);
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at')
        .orderByRaw('generado_at DESC NULLS LAST, created_at DESC')
        .first();

      const vacio = {
        anio_mes: anioMes, tipo, comparable: false, motivo: '', estado: run?.estado ?? null,
        folio_esperado: null as number | null, patas_archivo: 0, patas_en_contpaqi: 0,
        casan: 0, solo_nuestro: 0, solo_contpaqi: 0, existe_en_contpaqi: false,
        delta_cargos: 0, delta_abonos: 0,
        muestra_solo_nuestro: [] as unknown[], muestra_solo_contpaqi: [] as unknown[],
        folio_candidato: null as number | null, patas_candidato: 0, espejo_at: null as string | null,
      };
      if (!run) return { ...vacio, motivo: `no hay corrida ${tipo} para ${anioMes}` };
      if (!run.archivo_contenido) return { ...vacio, motivo: 'la corrida no guardó el archivo entregado' };

      const { movimientos, invalidos, header } = parsearTxt(run.archivo_contenido as string);
      if (invalidos.length || !header) {
        return { ...vacio, motivo: `el archivo guardado no cumple el layout (${invalidos[0]?.motivo ?? 'sin encabezado'})` };
      }
      const folio = header.folio;

      // Guarda de frescura. El espejo de pólizas lo alimenta un feed on-prem; si viene más
      // viejo que la entrega, "no está la póliza" sólo significa "todavía no la trajimos".
      // Se mira el LATIDO del feed y no `computed_at`: el importer hace DELETE+INSERT sólo
      // del delta por RowVersion, así que una corrida sin cambios no mueve computed_at y la
      // guarda gritaría "espejo viejo" estando al día.
      // `feed_contpaqi` = "Feed ContPAQi (pólizas+bancos @1min)", verificado contra
      // analytics.cron_runs: es el carril que alimenta gl_poliza_lines. La columna es
      // `last_finish` (la tabla guarda el ÚLTIMO latido por job_key, no un histórico).
      const { rows: latido } = await knex.raw(
        `SELECT last_finish AS ultimo
           FROM analytics.cron_runs
          WHERE tenant_id = ? AND job_key = 'feed_contpaqi' AND status = 'ok'`,
        [this.ctx.get()?.tenantId ?? null],
      );
      const espejoAt: Date | null = latido[0]?.ultimo ?? null;
      const entregadoAt: Date | null = run.entregado_at ?? run.generado_at ?? null;
      if (entregadoAt && espejoAt && new Date(espejoAt) < new Date(entregadoAt)) {
        return {
          ...vacio, folio_esperado: folio, patas_archivo: movimientos.length,
          espejo_at: new Date(espejoAt).toISOString(),
          motivo: 'el espejo de pólizas es más viejo que la entrega: todavía no se puede cuadrar',
        };
      }

      const { rows } = await knex.raw(
        `SELECT cuenta, cargo_abono, round(importe, 2) AS importe
           FROM analytics.gl_poliza_lines
          WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
            AND tipo_pol = ? AND folio = ? AND anio_mes = ?`,
        [TIPO_POLIZA_DIARIO, String(folio), anioMes],
      );

      const clave = (c: string, ab: string, i: number) => `${c}|${ab}|${Math.round(Number(i) * 100)}`;
      const mios = new Map<string, number>(); const suyos = new Map<string, number>();
      for (const m of movimientos) {
        const k = clave(m.cuenta, m.abono ? 'A' : 'C', m.importe);
        mios.set(k, (mios.get(k) ?? 0) + 1);
      }
      for (const m of rows as Record<string, unknown>[]) {
        const k = clave(String(m['cuenta']), String(m['cargo_abono']), Number(m['importe']));
        suyos.set(k, (suyos.get(k) ?? 0) + 1);
      }
      let casan = 0;
      const soloN: { cuenta: string; cargo_abono: string; importe: number; veces: number }[] = [];
      const soloC: { cuenta: string; cargo_abono: string; importe: number; veces: number }[] = [];
      for (const k of new Set([...mios.keys(), ...suyos.keys()])) {
        const g = mios.get(k) ?? 0, s = suyos.get(k) ?? 0;
        casan += Math.min(g, s);
        const [cuenta, ca, cent] = k.split('|');
        const fila = { cuenta, cargo_abono: ca, importe: Number(cent) / 100, veces: Math.abs(g - s) };
        if (g > s) soloN.push(fila); else if (s > g) soloC.push(fila);
      }
      const porImporte = (a: { importe: number }, b: { importe: number }) => b.importe - a.importe;

      // Un delta de UN número se lee mucho mejor que un multiset, y atrapa el caso
      // "editaron un importe a mano al importar".
      const sumar = (ms: { abono: boolean; importe: number }[], abono: boolean) =>
        r2(ms.filter((m) => m.abono === abono).reduce((a, m) => a + m.importe, 0));
      const cargosArchivo = sumar(movimientos, false), abonosArchivo = sumar(movimientos, true);
      const cargosReal = r2((rows as Record<string, unknown>[]).filter((m) => m['cargo_abono'] === 'C').reduce((a, m) => a + Number(m['importe']), 0));
      const abonosReal = r2((rows as Record<string, unknown>[]).filter((m) => m['cargo_abono'] === 'A').reduce((a, m) => a + Number(m['importe']), 0));

      // Si el folio esperado está vacío, se BUSCA el más parecido — pero sólo se informa.
      // Adoptarlo para el veredicto arriesga comparar el complemento contra el libro del
      // mismo mes: los dos son tipo_pol 3.
      let candidato: number | null = null, patasCandidato = 0;
      if (!rows.length) {
        const { rows: cand } = await knex.raw(
          `SELECT folio, count(*)::int AS patas
             FROM analytics.gl_poliza_lines
            WHERE tenant_id = current_tenant_id() AND source = 'contpaqi'
              AND tipo_pol = ? AND anio_mes = ?
            GROUP BY folio ORDER BY 2 DESC LIMIT 1`,
          [TIPO_POLIZA_DIARIO, anioMes],
        );
        if (cand.length) { candidato = Number(cand[0].folio); patasCandidato = Number(cand[0].patas); }
      }

      return {
        anio_mes: anioMes, tipo, comparable: true, motivo: '', estado: run.estado,
        folio_esperado: folio,
        patas_archivo: movimientos.length,
        patas_en_contpaqi: rows.length,
        casan,
        solo_nuestro: soloN.reduce((a, x) => a + x.veces, 0),
        solo_contpaqi: soloC.reduce((a, x) => a + x.veces, 0),
        existe_en_contpaqi: rows.length > 0,
        delta_cargos: r2(cargosArchivo - cargosReal),
        delta_abonos: r2(abonosArchivo - abonosReal),
        muestra_solo_nuestro: soloN.sort(porImporte).slice(0, 10),
        muestra_solo_contpaqi: soloC.sort(porImporte).slice(0, 10),
        folio_candidato: candidato, patas_candidato: patasCandidato,
        espejo_at: espejoAt ? new Date(espejoAt).toISOString() : null,
      };
    });
  }

  /**
   * Empuja el resultado del cuadre a la bandeja de hallazgos de Maat.
   *
   * Va aparte del GET a propósito: un GET que escribe es un GET que se dispara dos veces
   * con un refresh. Lo llama el cron nocturno y el botón manual.
   */
  async sincronizarHallazgos(anioMes: string, tipo: TipoCorrida = 'complemento') {
    const tenantId = this.ctx.get()?.tenantId ?? null;
    if (!tenantId) throw new BadRequestException('sin tenant en contexto');
    if (!this.findingsSink) {
      this.logger.debug('sink de hallazgos no ligado — sincronizarHallazgos no-op.');
      return { pushed: 0, inserted: 0, skipped: 0 };
    }
    const c = await this.cuadrarContraContpaqi(anioMes, tipo);
    if (!c.comparable) {
      this.logger.debug(`cuadre ${anioMes}/${tipo} no comparable: ${c.motivo}`);
      return { pushed: 0, inserted: 0, skipped: 0, motivo: c.motivo };
    }
    if (c.estado !== 'entregado' && c.estado !== 'aplicado') {
      return { pushed: 0, inserted: 0, skipped: 0, motivo: 'la corrida todavía no se entrega' };
    }

    const money = (v: number) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
    const findings: FinanceFindingInput[] = [];

    if (!c.existe_en_contpaqi) {
      findings.push({
        rule_key: 'libro_compras_poliza_ausente', clase: 'riesgo', severity: 'critical', score: 0.95,
        titulo: `${anioMes}: entregado y sin póliza en ContPAQi`,
        resumen: `El ${tipo} de ${anioMes} está ${c.estado} pero ContPAQi no tiene la póliza ${TIPO_POLIZA_DIARIO}-${c.folio_esperado}. `
          + (c.folio_candidato ? `El folio más parecido del mes es el ${c.folio_candidato}, con ${c.patas_candidato} renglones. ` : '')
          + 'Es el modo de falla que tiró julio y agosto de 2026 sin que nadie lo notara.',
        entity: { anio_mes: anioMes, tipo, folio_esperado: c.folio_esperado, folio_candidato: c.folio_candidato },
        periodo: anioMes, importe: Math.abs(c.delta_cargos),
        evidencia: { patas_archivo: c.patas_archivo, espejo_at: c.espejo_at, fuente: 'finance.purchase_book_runs.archivo_contenido ⋈ analytics.gl_poliza_lines' },
        dedup_key: `libro_compras_poliza_ausente|${anioMes}|${tipo}`,
      });
    } else if (c.solo_nuestro || c.solo_contpaqi || Math.abs(c.delta_cargos) >= 0.01) {
      const grave = Math.abs(c.delta_cargos) >= 1000
        || (c.solo_nuestro + c.solo_contpaqi) >= Math.max(1, Math.round(c.patas_archivo * 0.05));
      findings.push({
        rule_key: 'libro_compras_descuadre_contpaqi', clase: 'error_captura',
        severity: grave ? 'critical' : 'warn', score: grave ? 0.85 : 0.6,
        titulo: `${anioMes}: la póliza en ContPAQi no es la que entregamos`,
        resumen: `De ${c.patas_archivo} renglones entregados casan ${c.casan}. Sobran ${c.solo_nuestro} nuestros y `
          + `${c.solo_contpaqi} de ContPAQi; los cargos difieren en ${money(c.delta_cargos)}. `
          + 'Alguien editó renglones al importar, o el archivo se subió a otro folio.',
        entity: { anio_mes: anioMes, tipo, folio_esperado: c.folio_esperado },
        periodo: anioMes,
        // Cuando los totales cuadran pero las patas no, el importe del hallazgo es lo que
        // quedó repartido distinto — si no, un descuadre real saldría con importe cero.
        importe: Math.abs(c.delta_cargos) >= 0.01
          ? Math.abs(c.delta_cargos)
          : (c.muestra_solo_nuestro as { importe: number }[])
            .reduce((a, x) => a + Number(x.importe ?? 0), 0),
        evidencia: {
          patas_archivo: c.patas_archivo, patas_en_contpaqi: c.patas_en_contpaqi, casan: c.casan,
          solo_nuestro: c.solo_nuestro, solo_contpaqi: c.solo_contpaqi,
          delta_cargos: c.delta_cargos, delta_abonos: c.delta_abonos,
          muestra_solo_nuestro: c.muestra_solo_nuestro, muestra_solo_contpaqi: c.muestra_solo_contpaqi,
          espejo_at: c.espejo_at,
        },
        dedup_key: `libro_compras_descuadre_contpaqi|${anioMes}|${tipo}`,
      });
    }

    // El lazo que hoy no existe: si a los 7 días de aplicado los UUID entregados siguen sin
    // marca de asociación, el paso del Asociador de CFDI no está ocurriendo — y sin él el
    // flag miente y el heurístico por importe carga toda la decisión.
    const sinAsociar = await this.medirAsociacion(anioMes, tipo);
    if (sinAsociar && sinAsociar.dias >= 7 && sinAsociar.sin_marca > 0) {
      findings.push({
        rule_key: 'libro_compras_entrega_sin_asociar', clase: 'error_captura', severity: 'warn', score: 0.6,
        titulo: `${anioMes}: ${sinAsociar.sin_marca} de ${sinAsociar.total} facturas entregadas siguen sin asociar`,
        resumen: `Pasaron ${sinAsociar.dias} días desde que se aplicó el ${tipo} de ${anioMes} y `
          + `${sinAsociar.sin_marca} de sus ${sinAsociar.total} CFDIs siguen sin marca de asociación en ContPAQi. `
          + 'El TXT no lleva campo de UUID, así que la asociación se crea aparte; si nadie la hace, el filtro '
          + 'anti-duplicado se queda sin su señal buena.',
        entity: { anio_mes: anioMes, tipo },
        periodo: anioMes, importe: sinAsociar.monto,
        evidencia: { total: sinAsociar.total, sin_marca: sinAsociar.sin_marca, dias: sinAsociar.dias, fuente: 'fiscal.cfdis.aso_contabilidad' },
        dedup_key: `libro_compras_entrega_sin_asociar|${anioMes}|${tipo}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.findingsSink.pushFindings(tenantId, findings, REGLAS_CUADRE);
    this.logger.log(`cuadre ${anioMes}/${tipo}: ${findings.length} hallazgo(s) → Maat (${res.inserted} nuevos).`);
    return { pushed: findings.length, ...res };
  }

  /** Cuántos de los UUID que se entregaron siguen sin marca de asociación, y desde cuándo. */
  private async medirAsociacion(anioMes: string, tipo: TipoCorrida) {
    return this.tk.run(async (knex) => {
      const run = await knex('finance.purchase_book_runs')
        .where({ anio_mes: anioMes, tipo }).whereNull('deleted_at').first();
      if (!run?.archivo_contenido || !run.aplicado_at) return null;
      const { movimientos } = parsearTxt(run.archivo_contenido as string);
      const uuids = [...new Set(movimientos.map((m) => m.concepto).filter((c) => /^[0-9A-Fa-f-]{36}$/.test(c)))]
        .map((u) => u.toUpperCase());
      if (!uuids.length) return null;
      const { rows } = await knex.raw(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE aso_contabilidad IS NOT TRUE)::int AS sin_marca,
                round(coalesce(sum(total) FILTER (WHERE aso_contabilidad IS NOT TRUE), 0), 2) AS monto
           FROM fiscal.cfdis
          WHERE tenant_id = current_tenant_id() AND upper(uuid) = ANY (?)
            AND rol = 'recibidas'`,
        [uuids],
      );
      const dias = Math.floor((Date.now() - new Date(run.aplicado_at as string).getTime()) / 86400000);
      return { total: Number(rows[0].total), sin_marca: Number(rows[0].sin_marca), monto: Number(rows[0].monto), dias };
    });
  }
}
