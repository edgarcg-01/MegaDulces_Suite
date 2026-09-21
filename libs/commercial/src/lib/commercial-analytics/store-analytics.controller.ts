import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import { WeeklyAnalyticsService } from './weekly-analytics.service';

/**
 * Análisis semanal para el proyecto Tienda (/tienda/analisis-semanal).
 *
 * `[ID.4]` — Primer dominio migrado al alcance de datos (Fase ID / ADR-050).
 * `[ID.5]` — Y primero en usar el contrato canónico de params.
 *
 * Antes acá vivía el patrón fail-OPEN que se repetía en 41 módulos:
 *
 *     const effective = user?.warehouse_code || warehouseCode || undefined;
 *
 * o sea: al que tenía sucursal se le forzaba, y **al que no la tenía se le
 * respetaba el query param** — con 83 de 117 usuarios sin sucursal en prod, el
 * default real era "ve toda la red". Y no había forma de decir "ve la 01 y la 03".
 *
 * Ahora `ScopeService.readParam()` hace las tres cosas de una: lee el nombre
 * (canónico o cualquiera de los alias viejos), normaliza la llave (acepta
 * código y uuid) y recorta lo pedido al alcance del usuario:
 *   - alcance `all` sin filtro pedido → sin filtro (igual que antes);
 *   - alcance `all` con `?warehouse_codes=03` → esa;
 *   - alcance `own`/`listed` → sus sucursales, y si pide otra se le **recorta**
 *     en silencio (lista vacía → series en cero) en vez de 403: este endpoint
 *     alimenta un tablero de varios widgets y un 403 rompe la pantalla entera.
 */

const WH = CANONICAL_PARAM.warehouse; // 'warehouse_codes'
const DESC_WH = `Sucursal o CSV de sucursales. Se recorta a lo que tu alcance permite. Acepta los nombres viejos (warehouse_code, sucursal, branch…) y valores en código o uuid.`;

@ApiTags('store')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/analytics')
export class StoreAnalyticsController {
  constructor(
    private readonly weeklySvc: WeeklyAnalyticsService,
    private readonly scope: ScopeService,
  ) {}

  @Get('weekly')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'week', required: false, description: "Cualquier día de la semana objetivo (ISO 'YYYY-MM-DD'). Default: semana actual." })
  @ApiQuery({ name: 'weeks', required: false, description: 'Nº de semanas de la tendencia (4–26, default 12).' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — análisis semanal: KPIs semana vs anterior + tendencia + desglose por sucursal y producto. Acotado por tu alcance de sucursales.' })
  async weekly(@Query() query: Record<string, unknown>) {
    const weeks = query['weeks'];
    return this.weeklySvc.weekly({
      week: query['week'] as string | undefined,
      weeks: weeks ? Number(weeks) : undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/weekly'),
    });
  }

  @Get('range')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiQuery({ name: 'with_products', required: false, description: '`0` omite el top de productos (la consulta cara). Default `1` — contrato viejo intacto.' })
  @ApiOperation({ summary: 'Tienda — análisis por rango personalizado: venta, tickets, ticket promedio, partidas por ticket, valor por partida, unidades por ticket, valor unitario promedio, margen, unidades + serie diaria y top productos (vs período previo). Las razones sin denominador medido vuelven en null (no en 0). Acotado por tu alcance de sucursales.' })
  async range(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.range({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      with_products: !esCero(query['with_products']),
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/range'),
    });
  }

  /**
   * `[TDA.A1]` La cascada de la sección «Tráfico»: el MISMO rango partido en buckets.
   *
   * Comparte el control de tiempo con `/range` a propósito (un solo rango manda en la
   * pantalla; el grano sólo agrupa), así que comparte también el tope de días.
   */
  @Get('breakdown')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'grain', required: false, description: 'week · weekday · month · quarter · year (default month). Cualquier otro valor cae a month.' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiQuery({ name: 'supplier_code', required: false, description: 'Acota la cascada a una LÍNEA (proveedor del catálogo), o `__SIN_LINEA__`.' })
  @ApiQuery({ name: 'product_id', required: false, description: 'Acota la cascada a UN producto. Gana sobre `supplier_code` si vienen los dos. Igual que la línea, prende el modo acotado: tickets, partidas, ticket promedio, $/partida, unidades por ticket y clientes vuelven en null porque NO son atribuibles (un ticket lleva varios productos y varias líneas).' })
  @ApiOperation({ summary: 'Tienda — cascada por período: el mismo rango partido en semanas / días de la semana / meses / trimestres / años, con el juego completo de indicadores por bucket y un segundo nivel desplegable. Δ% contra el bucket anterior; las razones sin cobertura medida EN ESE BUCKET vuelven en null. Acotado por tu alcance de sucursales.' })
  async breakdown(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.breakdown({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      grain: query['grain'] as string | undefined,
      supplier_code: query['supplier_code'] as string | undefined,
      product_id: query['product_id'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/breakdown'),
    });
  }

  /**
   * `[TDA.A4]` CLIENTES — la cartera con su ficha del ERP, y **el techo que la enmarca**:
   * la facturación a nombre es una fracción chica de la venta de la tienda, y una parte
   * grande de esa fracción son cuentas del propio piso. Ver el servicio.
   */
  @Get('customers')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'segmento', required: false, description: '`externos` (default) · `internos` · `todos`. Los internos son los pisos de venta y las cuentas de vendedores: facturan más que todos los clientes juntos.' })
  @ApiQuery({ name: 'q', required: false, description: 'Texto libre sobre nombre y clave del cliente.' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — cartera de clientes con su ficha del ERP (Grupo · Zona · Vendedor · Límite de crédito · Plazo) + venta, Δ%, compras, ticket promedio, primera y última compra, días sin comprar y estado (nuevo/activo/dormido). Incluye los que NO compraron en el período pero sí en el anterior: son la única señal de fuga. Devuelve además el TECHO (qué parte de la venta real de la tienda está a nombre de alguien) y la segmentación por Grupo con los internos marcados. Acotado por tu alcance de sucursales.' })
  async customers(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.customers({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      segmento: query['segmento'] as string | undefined,
      q: query['q'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/customers'),
    });
  }

  /**
   * `[TDA.A3]` PRODUCTOS TOP — el producto con sus tres etiquetas del ERP (Línea ·
   * Tipo · Grupo) y la lectura de Pareto. Tipo y Grupo salen de
   * `analytics.v_product_taxonomy`, vista derivada del ODS.
   */
  @Get('top-products')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'tipo', required: false, description: 'Código de Tipo (categoría, catálogo `kdie`).' })
  @ApiQuery({ name: 'grupo', required: false, description: 'Código de Grupo (subcategoría, catálogo `kdif`).' })
  @ApiQuery({ name: 'supplier_code', required: false, description: 'Código de línea/proveedor, o `__SIN_LINEA__`.' })
  @ApiQuery({ name: 'q', required: false, description: 'Texto libre sobre nombre y SKU. Va en el servidor para que el acumulado siga siendo el del universo filtrado.' })
  @ApiQuery({ name: 'mode', required: false, description: '`pareto` (default) corta al llegar al 80% acumulado; `all` devuelve hasta el tope de 1,500.' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — productos TOP con Línea (proveedor), Tipo (categoría) y Grupo (subcategoría): venta, Δ%, participación y ACUMULADO (Pareto), margen, margen%, unidades, $/unidad y días con venta. Devuelve el universo completo y el corte 50/80/95% aunque sirva menos filas. Acotado por tu alcance de sucursales.' })
  async topProducts(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.topProducts({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      tipo: query['tipo'] as string | undefined,
      grupo: query['grupo'] as string | undefined,
      supplier_code: query['supplier_code'] as string | undefined,
      q: query['q'] as string | undefined,
      mode: query['mode'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/top-products'),
    });
  }

  /**
   * `[TDA.A2]` Las LÍNEAS — la venta repartida por proveedor del catálogo
   * (`catalog.products.supplier_id`). Ver el bloque «Línea = el proveedor del catálogo»
   * del servicio para por qué ésta es la atribución correcta y por qué la de «quién
   * entregó» se descartó con medición.
   */
  @Get('suppliers')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — venta por LÍNEA (proveedor del catálogo): venta, Δ% vs período previo del mismo tamaño, participación, margen, unidades y SKUs con venta, más la concentración medida (cuántas líneas explican el 50% y el 80%). Los productos sin línea salen en su propia fila, no se descartan. Acotado por tu alcance de sucursales.' })
  async suppliers(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.suppliers({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/suppliers'),
    });
  }

  /** `[TDA.A2]` El detalle del master-detail: los productos de UNA línea. */
  @Get('supplier-products')
  @RequirePermissions(Permission.STORE_ANALYTICS_VER)
  @ApiQuery({ name: 'from', required: true, description: "Inicio del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'to', required: true, description: "Fin del rango (ISO 'YYYY-MM-DD', inclusivo)." })
  @ApiQuery({ name: 'supplier_code', required: true, description: 'Código de la línea, o `__SIN_LINEA__` para los productos sin línea asignada.' })
  @ApiQuery({ name: WH, required: false, description: DESC_WH })
  @ApiOperation({ summary: 'Tienda — productos de una LÍNEA: venta, Δ% vs período previo, participación DENTRO de la línea, margen, margen% y unidades (tope 300 por venta). Acotado por tu alcance de sucursales.' })
  async supplierProducts(@Query() query: Record<string, unknown>) {
    return this.weeklySvc.supplierProducts({
      from: query['from'] as string | undefined,
      to: query['to'] as string | undefined,
      supplier_code: query['supplier_code'] as string | undefined,
      warehouse_codes: await this.scope.readParam(query, 'warehouse', 'store/analytics/supplier-products'),
    });
  }
}

/**
 * ¿El query param dice explícitamente que NO? Sólo `0` y `false` apagan; ausente o
 * cualquier otra cosa deja el default encendido. Un `!!query[x]` no servía: el valor
 * llega como STRING y `'0'` es verdadero en JS.
 */
function esCero(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '0' || s === 'false';
}
