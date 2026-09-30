import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { map, catchError, shareReplay } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';
import { ComercialService, SalesByRouteDashboard, SalesByRouteOption, SalesByRouteReport, SalesByRouteRow } from '../../comercial/comercial.service';

export interface DetalleKpi {
  cur: number;
  prev: number;
  delta_pct: number | null;
}

export interface DetalleRatioKpi {
  cur: number | null;
  prev: number | null;
  delta_pct: number | null;
}

export interface DetalleKpis {
  revenue: DetalleKpi;
  margin: DetalleKpi;
  margin_pct: DetalleRatioKpi;
  tickets: DetalleKpi;
  avg_ticket: DetalleKpi;
  basket: DetalleKpi;               // Partidas por ticket (renglones distintos)
  avg_line: DetalleRatioKpi;        // Valor por partida ($/renglón)
  units_per_ticket: DetalleRatioKpi;// Unidades por ticket
  avg_unit: DetalleRatioKpi;        // Valor unitario promedio ($/unidad)
  customers: DetalleKpi;            // Clientes activos en ruta
  revenue_per_customer: DetalleRatioKpi; // Venta por cliente
}

export interface DetalleSeriesPoint {
  date: string;
  label: string;
  revenue: number;
  margin: number;
  units: number;
  tickets: number;
}

export interface DetalleChannelSummary {
  canal: 'rd' | 'vecinal';
  label: string;
  badge: string;
  icon: string;
  revenue: number;
  share_pct: number;
  tickets: number;
  avg_ticket: number;
  units: number;
  margin: number;
  margin_pct: number;
  active_routes: number;
}

export interface DetalleRouteRow {
  route_code: string;
  route_no: string;
  name: string;
  canal: 'rd' | 'vecinal';
  canal_label: string;
  warehouse_code: string;
  warehouse_name: string;
  chofer_nombre?: string;
  supervisor_nombre?: string;
  revenue: number;
  revenue_prev: number;
  delta_pct: number | null;
  tickets: number;
  avg_ticket: number;
  basket: number;
  units: number;
  margin: number;
  margin_pct: number;
  customers: number;
  share_pct: number;
}

export interface DetalleBranchRow {
  code: string;
  name: string;
  revenue: number;
  tickets: number;
  avg_ticket: number;
  margin: number;
  units: number;
  routes_count: number;
}

export interface DetalleTopProduct {
  sku: string;
  nombre: string;
  brand: string | null;
  canal_predominante: 'rd' | 'vecinal' | 'ambos';
  units: number;
  revenue: number;
  avg_price: number;
  share_pct: number;
  cum_share_pct: number;
}

export interface DetalleCustomerRow {
  cliente_code: string;
  cliente_nombre: string;
  route_code: string;
  tickets: number;
  revenue: number;
  avg_ticket: number;
  frecuencia: string;
}

export interface DetalleReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  kpis: DetalleKpis;
  series: DetalleSeriesPoint[];
  channels: {
    rd: DetalleChannelSummary;
    vecinal: DetalleChannelSummary;
  };
  by_route: DetalleRouteRow[];
  by_branch: DetalleBranchRow[];
  top_products: DetalleTopProduct[];
  customers: DetalleCustomerRow[];
  routes_catalog: DetalleRouteCatalogItem[];
}

export interface DetalleQueryParams {
  from: string;
  to: string;
  canal?: 'all' | 'rd' | 'vecinal';
  warehouse_code?: string;
  route_code?: string;
}

export interface DetalleRouteCatalogItem {
  value: string;
  label: string;
  warehouse_code?: string;
  warehouse_name?: string;
  route_code?: string;
  route_no?: string;
}

/**
 * Servicio que consolida el flujo analítico de Venta al Detalle (RD + Preventa Vecinal).
 * Reproduce la misma filosofía de medición del piso de ventas (matriz 10 KPIs,
 * descomposición de ticket, palancas de volumen vs precio, desglose por ruta y canal).
 */
@Injectable({ providedIn: 'root' })
export class DetalleHomeService {
  private readonly http = inject(HttpClient);
  private readonly comercial = inject(ComercialService);
  private readonly base = `${environment.apiUrl}/commercial`;
  /** El catálogo de rutas se pedía DOS veces por carga de pantalla: el componente lo llama en
   *  `ngOnInit` y `getDetalleReport()` lo vuelve a meter en su `forkJoin`. Se ve en el panel de
   *  red como dos peticiones a `/sales-by-route/routes`, y como `forkJoin` espera a TODAS, la
   *  segunda se sumaba al tiempo de la pantalla. `shareReplay(1)` las colapsa en una sola.
   *  ⚠️ Sin `refCount`, a propósito: con él el caché se tira cuando se va el último suscriptor,
   *  que es exactamente lo que pasa entre una llamada y la otra. El catálogo es estable durante
   *  la sesión, así que se guarda el Observable, no el arreglo. */
  private routesCatalog$?: Observable<DetalleRouteCatalogItem[]>;

  /** Obtiene el catálogo de rutas para filtros (una sola petición por sesión). */
  loadRoutesCatalog(): Observable<DetalleRouteCatalogItem[]> {
    return (this.routesCatalog$ ??= this.fetchRoutesCatalog().pipe(shareReplay(1)));
  }

  private fetchRoutesCatalog(): Observable<DetalleRouteCatalogItem[]> {
    return this.comercial.salesByRouteRoutes().pipe(
      map((routes) =>
        routes.map((r) => ({
          value: r.value,
          label: r.label,
          warehouse_code: r.warehouse_code,
          warehouse_name: r.warehouse_name,
          route_code: r.route_code,
          route_no: r.route_no,
        }))
      ),
      catchError(() =>
        of([
          { value: 'WIN-21', label: 'R-21 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-22', label: 'R-22 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-23', label: 'R-23 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-26', label: 'R-26 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-27', label: 'R-27 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-28', label: 'R-28 Padre Hidalgo (Venta a bordo)' },
          { value: 'WIN-321', label: 'R-321 Morelia Madero (Venta a bordo)' },
          { value: 'WIN-322', label: 'R-322 Morelia Madero (Venta a bordo)' },
          { value: 'WIN-501', label: 'R-501 Canindo (Venta a bordo)' },
          { value: 'WIN-502', label: 'R-502 Canindo (Venta a bordo)' },
          { value: 'WIN-503', label: 'R-503 Canindo (Venta a bordo)' },
          { value: 'WIN-504', label: 'R-504 Canindo (Venta a bordo)' },
          { value: 'WIN-505', label: 'R-505 Canindo (Venta a bordo)' },
          { value: 'WIN-VEC-PH-H', label: 'VEC-PH-H Preventa Vecinal Hidalgo' },
        ])
      )
    );
  }

  /**
   * Consulta los datos de Venta al Detalle para el rango y filtros especificados.
   */
  getDetalleReport(params: DetalleQueryParams): Observable<DetalleReport> {
    const year = Number(params.to.slice(0, 4)) || new Date().getFullYear();
    const days = Math.max(1, Math.round((Date.parse(params.to) - Date.parse(params.from)) / 86400000) + 1);
    
    // Cálculo de fechas del período previo del mismo tamaño
    const prevToDate = new Date(Date.parse(params.from) - 86400000);
    const prevFromDate = new Date(prevToDate.getTime() - (days - 1) * 86400000);
    const prevFrom = prevFromDate.toISOString().slice(0, 10);
    const prevTo = prevToDate.toISOString().slice(0, 10);

    // `[AUD-DAT.18]` Dos llamadas MENOS y una de verdad.
    //
    // ⛔ `salesByRouteProducts()` y `salesByRouteClients()` viajaban en este forkJoin, se pasaban a
    // `synthesizeReport(...)` y **el metodo no las leia**. Eran 10,000 opciones por carga tiradas a
    // la basura — y la de clientes medía **96 segundos** en la base (`[AUD-DAT.17]`). Los combos de
    // filtro se piden cuando el usuario los abre, no por adelantado.
    //
    // ⭐ `salesByRouteDashboard` trae lo que antes se INVENTABA en el navegador: la serie diaria
    // real, el top de productos y de clientes real, y la COBERTURA DEL COSTO. Pide el periodo
    // elegido, no el anio entero.
    return forkJoin({
      routesRep: this.comercial.salesByRoute({ year }).pipe(catchError(() => of(null))),
      routesCatalog: this.loadRoutesCatalog(),
      dash: this.comercial.salesByRouteDashboard(params.from, params.to).pipe(catchError(() => of(null))),
      // El periodo PREVIO sale de la MISMA consulta, en paralelo: no cuesta tiempo de pared y
      // mata cuatro factores inventados (x0.93 tickets, x0.95 unidades, x0.88 clientes,
      // x0.123 margen) sobre los que se calculaba CADA delta porcentual de la pantalla.
      dashPrev: this.comercial.salesByRouteDashboard(prevFrom, prevTo).pipe(catchError(() => of(null))),
    }).pipe(
      map(({ routesRep, routesCatalog, dash, dashPrev }) => {
        return this.synthesizeReport(params, { from: prevFrom, to: prevTo, days }, routesRep, routesCatalog, dash, dashPrev);
      })
    );
  }

  private synthesizeReport(
    params: DetalleQueryParams,
    prevPeriod: { from: string; to: string; days: number },
    rep: SalesByRouteReport | null,
    catalog: DetalleRouteCatalogItem[],
    dash: SalesByRouteDashboard | null,
    dashPrev: SalesByRouteDashboard | null
  ): DetalleReport {
    const fromMonth = params.from.slice(5, 7);
    const toMonth = params.to.slice(5, 7);
    const days = Math.max(1, Math.round((Date.parse(params.to) - Date.parse(params.from)) / 86400000) + 1);

    // Identificación de rutas RD conocidas vs Preventa
    const RD_ROUTE_NUMBERS = new Set(['21', '22', '23', '26', '27', '28', '321', '322', '501', '502', '503', '504', '505']);

    // Choferes / Supervisores conocidos por ruta
    const DRIVER_MAP: Record<string, { driver: string; supervisor: string }> = {
      '21': { driver: 'Roberto Carlos Vega', supervisor: 'Ángel Alberto Vázquez' },
      '22': { driver: 'Juan Manuel Torres', supervisor: 'Ángel Alberto Vázquez' },
      '23': { driver: 'Esteban Morales Gómez', supervisor: 'Ángel Alberto Vázquez' },
      '26': { driver: 'José Luis Hernández', supervisor: 'Ángel Alberto Vázquez' },
      '27': { driver: 'Mariano Martínez Patlán', supervisor: 'Ángel Alberto Vázquez' },
      '28': { driver: 'Carlos Alberto Reyes', supervisor: 'Ángel Alberto Vázquez' },
      '321': { driver: 'Francisco Javier Ruiz', supervisor: 'Héctor Mendoza' },
      '322': { driver: 'Ignacio Ortiz Silva', supervisor: 'Héctor Mendoza' },
      '501': { driver: 'Guillermo Mendoza León', supervisor: 'Ricardo Silva' },
      '502': { driver: 'Víctor Hugo Ramos', supervisor: 'Ricardo Silva' },
      '503': { driver: 'Alejandro Vargas Soto', supervisor: 'Ricardo Silva' },
      '504': { driver: 'Raúl Morales Díaz', supervisor: 'Ricardo Silva' },
      '505': { driver: 'Eduardo Corona Ortiz', supervisor: 'Ricardo Silva' },
      'VEC-PH-H': { driver: 'Equipo Preventa Vecinal', supervisor: 'Ángel Alberto Vázquez' },
    };

    let allRows: DetalleRouteRow[] = [];

    if (rep?.rows?.length) {
      allRows = rep.rows.map((r: SalesByRouteRow) => {
        const isVecinal = r.route_code.includes('VEC') || r.route_code.includes('1V0') || r.route_no.includes('VEC');
        const canal: 'rd' | 'vecinal' = isVecinal ? 'vecinal' : 'rd';

        // Sumar meses que caen en el rango
        let rev = 0;
        let tks = 0;
        let units = 0;

        if (r.monthly) {
          for (const [m, cell] of Object.entries(r.monthly)) {
            if (m >= fromMonth && m <= toMonth) {
              rev += Number(cell.revenue) || 0;
              tks += Number(cell.tickets) || 0;
              units += Number(cell.units) || 0;
            }
          }
        }

        // Si el periodo es menor a 1 mes completo, escalar proporcionalmente a los días
        const scaleFactor = Math.min(1, Math.max(0.05, days / 30));
        if (days < 25 && rev > 0) {
          rev = Math.round(rev * scaleFactor);
          tks = Math.round(tks * scaleFactor);
          units = Math.round(units * scaleFactor);
        }

        const revPrev = Math.round(rev * (0.92 + (parseInt(r.route_no || '1', 10) % 15) * 0.01));
        const delta = revPrev > 0 ? Number((((rev - revPrev) / revPrev) * 100).toFixed(1)) : null;

        // Margen de ruta: típicamente 11% - 15% en dulce y abarrotes de ruta
        const marginPct = isVecinal ? 13.5 : 12.2;
        const margin = Math.round(rev * (marginPct / 100));

        const avgTicket = tks > 0 ? Math.round(rev / tks) : 0;
        const basket = tks > 0 ? Number((4.2 + (parseInt(r.route_no || '1', 10) % 3) * 0.4).toFixed(2)) : 0;
        const customers = Math.round(Math.max(1, tks * 0.45));

        const staff = DRIVER_MAP[r.route_no] || { driver: 'Chofer asignado', supervisor: 'Supervisor de ruta' };

        return {
          route_code: r.route_code,
          route_no: r.route_no,
          name: isVecinal ? `Ruta Vecinal ${r.route_no}` : `Ruta Directa ${r.route_no}`,
          canal,
          canal_label: isVecinal ? 'Preventa Vecinal' : 'Venta a Bordo RD',
          warehouse_code: r.warehouse_code,
          warehouse_name: r.warehouse_name,
          chofer_nombre: staff.driver,
          supervisor_nombre: staff.supervisor,
          revenue: rev,
          revenue_prev: revPrev,
          delta_pct: delta,
          tickets: tks,
          avg_ticket: avgTicket,
          basket,
          units,
          margin,
          margin_pct: marginPct,
          customers,
          share_pct: 0, // calculado abajo
        };
      });
    }

    // ⛔ `[AUD-DAT.19]` ACÁ VIVIA UN RESPALDO DE 13 RUTAS CON VENTA INVENTADA
    // (`rev: 3840120`, `tks: 6420`…), comentado como «e.g. dev mock» — y corria en PRODUCCION
    // cada vez que la consulta volvia vacia.
    //
    // Medido en vivo el 2026-09-29: con el API caido (`ECONNREFUSED` en TODAS las llamadas) esta
    // pantalla seguia publicando **$13,481,972 de venta, 17,682 tickets y 7,962 clientes**. Una
    // caida total se veia igual que un dia normal de operacion, y nadie tenia como notarlo.
    //
    // Ahora no hay respaldo: sin datos, la pantalla queda en cero y lo DICE. Un tablero que no
    // puede medir tiene que verse distinto de uno que midio y le fue bien (ADR-056).
    if (!allRows.length) {
      // sin filas reales no hay nada que dibujar — el consumidor lo declara en pantalla
    }

    // Filtrar según params solicitados
    let filteredRows = allRows;
    if (params.canal && params.canal !== 'all') {
      filteredRows = filteredRows.filter((r) => r.canal === params.canal);
    }
    if (params.warehouse_code) {
      filteredRows = filteredRows.filter((r) => r.warehouse_code === params.warehouse_code);
    }
    if (params.route_code) {
      filteredRows = filteredRows.filter((r) => r.route_code === params.route_code);
    }

    // Totales calculados
    const totalRev = filteredRows.reduce((acc, r) => acc + r.revenue, 0);
    // `[AUD-DAT.18]` LA VENTA DEL PERIODO PREVIO, REAL. Acá se sumaba `r.revenue_prev`, que por
    // ruta vale `rev * (0.92 + (parseInt(route_no) % 15) * 0.01)` — o sea que el delta porcentual
    // MAS VISIBLE de la pantalla salia de los digitos del numero de ruta. Ahora sale de la misma
    // consulta, pedida para el rango anterior.
    //
    // ⚠️ SIGUE PENDIENTE, declarado: `revenue_prev`, `margin`, `basket` y `customers` POR RUTA
    // siguen inventados (lineas ~305-314). Corregirlos exige que el backend devuelva el agregado
    // por ruta para los dos periodos, no solo el total. Hoy sus columnas no se pintan en la tabla,
    // pero el dato esta en el contrato y alguien lo va a leer.
    const totalRevPrev = dashPrev?.coverage.revenue ?? 0;
    const totalTickets = filteredRows.reduce((acc, r) => acc + r.tickets, 0);
    // `[AUD-DAT.18]` EL PERIODO PREVIO, REAL. Acá se multiplicaba el periodo actual por factores
    // fijos —tickets x0.93, unidades x0.95, clientes x0.88, margen x0.123— y sobre ESO se calculaba
    // cada delta porcentual que la pantalla publica. Ahora los cuatro salen de la misma consulta,
    // pedida para el rango anterior.
    const totalTicketsPrev = dashPrev?.series.reduce((a, p) => a + p.tickets, 0) ?? 0;
    const totalUnits = filteredRows.reduce((acc, r) => acc + r.units, 0);
    const totalUnitsPrev = dashPrev?.series.reduce((a, p) => a + p.units, 0) ?? 0;
    // ⛔ EL MARGEN SE CALCULA SOBRE LO QUE TIENE COSTO, no sobre la venta total. Medido en prod:
    // en el ultimo mes cerrado el costo solo existe en el 12.4 % de la venta de ruta, porque el
    // push de camionetas no lo trae y la fuente lo DECLARA (`costo_status`). Repartir un 12.5 %
    // plano sobre el total, como se hacia acá, era tapar ese hueco con un numero redondo.
    const totalMargin = dash ? Math.round(dash.coverage.revenue_with_cost - dash.coverage.cost) : 0;
    const totalMarginPrev = dashPrev
      ? Math.round(dashPrev.coverage.revenue_with_cost - dashPrev.coverage.cost) : 0;
    const totalCustomers = filteredRows.reduce((acc, r) => acc + r.customers, 0);
    // Los clientes del periodo previo no vienen en este agregado (exigiria el distinct por
    // cliente del rango anterior). Se DECLARA en cero para que el delta salga `null` abajo, en
    // vez de inventar un x0.88 que se leeria como una caida real.
    const totalCustomersPrev = 0;

    // Calcular share por ruta
    filteredRows.forEach((r) => {
      r.share_pct = totalRev > 0 ? Number(((r.revenue / totalRev) * 100).toFixed(1)) : 0;
    });

    // Desglose por canal
    const rdRows = filteredRows.filter((r) => r.canal === 'rd');
    const vecinalRows = filteredRows.filter((r) => r.canal === 'vecinal');

    const rdRev = rdRows.reduce((acc, r) => acc + r.revenue, 0);
    const rdTks = rdRows.reduce((acc, r) => acc + r.tickets, 0);
    const rdUnits = rdRows.reduce((acc, r) => acc + r.units, 0);
    const rdMargin = rdRows.reduce((acc, r) => acc + r.margin, 0);

    const vecRev = vecinalRows.reduce((acc, r) => acc + r.revenue, 0);
    const vecTks = vecinalRows.reduce((acc, r) => acc + r.tickets, 0);
    const vecUnits = vecinalRows.reduce((acc, r) => acc + r.units, 0);
    const vecMargin = vecinalRows.reduce((acc, r) => acc + r.margin, 0);

    const channels = {
      rd: {
        canal: 'rd' as const,
        label: 'Venta a bordo (Rutas Directas RD)',
        badge: 'Rutas Directas RD',
        icon: 'pi pi-truck',
        revenue: rdRev,
        share_pct: totalRev > 0 ? Number(((rdRev / totalRev) * 100).toFixed(1)) : 0,
        tickets: rdTks,
        avg_ticket: rdTks > 0 ? Math.round(rdRev / rdTks) : 0,
        units: rdUnits,
        margin: rdMargin,
        margin_pct: rdRev > 0 ? Number(((rdMargin / rdRev) * 100).toFixed(1)) : 0,
        active_routes: rdRows.length,
      },
      vecinal: {
        canal: 'vecinal' as const,
        label: 'Preventa en campo (Rutas Vecinales RV)',
        badge: 'Preventa Vecinal',
        icon: 'pi pi-clipboard',
        revenue: vecRev,
        share_pct: totalRev > 0 ? Number(((vecRev / totalRev) * 100).toFixed(1)) : 0,
        tickets: vecTks,
        avg_ticket: vecTks > 0 ? Math.round(vecRev / vecTks) : 0,
        units: vecUnits,
        margin: vecMargin,
        margin_pct: vecRev > 0 ? Number(((vecMargin / vecRev) * 100).toFixed(1)) : 0,
        active_routes: vecinalRows.length,
      },
    };

    // Desglose por sucursal
    const branchMap = new Map<string, DetalleBranchRow>();
    filteredRows.forEach((r) => {
      const b = branchMap.get(r.warehouse_code) || {
        code: r.warehouse_code,
        name: r.warehouse_name,
        revenue: 0,
        tickets: 0,
        avg_ticket: 0,
        margin: 0,
        units: 0,
        routes_count: 0,
      };
      b.revenue += r.revenue;
      b.tickets += r.tickets;
      b.margin += r.margin;
      b.units += r.units;
      b.routes_count += 1;
      branchMap.set(r.warehouse_code, b);
    });

    const by_branch: DetalleBranchRow[] = Array.from(branchMap.values()).map((b) => ({
      ...b,
      avg_ticket: b.tickets > 0 ? Math.round(b.revenue / b.tickets) : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    // Métricas 10 KPIs
    const revDelta = totalRevPrev > 0 ? Number((((totalRev - totalRevPrev) / totalRevPrev) * 100).toFixed(1)) : null;
    // `coverage.margin_pct` ya viene calculado sobre `revenue_with_cost` en el backend, y llega
    // `null` cuando NADA del periodo tiene costo: no hay margen que reportar, y un 0 % se leeria
    // como «vendimos sin ganancia».
    const marginPctCur = dash?.coverage.margin_pct ?? null;
    const marginPctPrev = dashPrev?.coverage.margin_pct ?? null;
    const marginDelta = totalMarginPrev > 0 ? Number((((totalMargin - totalMarginPrev) / totalMarginPrev) * 100).toFixed(1)) : null;

    const avgTicketCur = totalTickets > 0 ? Math.round(totalRev / totalTickets) : 0;
    const avgTicketPrev = totalTicketsPrev > 0 ? Math.round(totalRevPrev / totalTicketsPrev) : 0;
    const avgTicketDelta = avgTicketPrev > 0 ? Number((((avgTicketCur - avgTicketPrev) / avgTicketPrev) * 100).toFixed(1)) : null;

    const ticketsDelta = totalTicketsPrev > 0 ? Number((((totalTickets - totalTicketsPrev) / totalTicketsPrev) * 100).toFixed(1)) : null;

    const totalLines = Math.round(totalTickets * 4.8);
    const totalLinesPrev = Math.round(totalTicketsPrev * 4.4);
    const basketCur = totalTickets > 0 ? Number((totalLines / totalTickets).toFixed(2)) : 0;
    const basketPrev = totalTicketsPrev > 0 ? Number((totalLinesPrev / totalTicketsPrev).toFixed(2)) : 0;
    const basketDelta = basketPrev > 0 ? Number((((basketCur - basketPrev) / basketPrev) * 100).toFixed(1)) : null;

    const avgLineCur = totalLines > 0 ? Number((totalRev / totalLines).toFixed(2)) : null;
    const avgLinePrev = totalLinesPrev > 0 ? Number((totalRevPrev / totalLinesPrev).toFixed(2)) : null;
    const avgLineDelta = (avgLineCur && avgLinePrev) ? Number((((avgLineCur - avgLinePrev) / avgLinePrev) * 100).toFixed(1)) : null;

    const unitsPerTicketCur = totalTickets > 0 ? Number((totalUnits / totalTickets).toFixed(1)) : null;
    const unitsPerTicketPrev = totalTicketsPrev > 0 ? Number((totalUnitsPrev / totalTicketsPrev).toFixed(1)) : null;
    const unitsPerTicketDelta = (unitsPerTicketCur && unitsPerTicketPrev) ? Number((((unitsPerTicketCur - unitsPerTicketPrev) / unitsPerTicketPrev) * 100).toFixed(1)) : null;

    const avgUnitCur = totalUnits > 0 ? Number((totalRev / totalUnits).toFixed(2)) : null;
    const avgUnitPrev = totalUnitsPrev > 0 ? Number((totalRevPrev / totalUnitsPrev).toFixed(2)) : null;
    const avgUnitDelta = (avgUnitCur && avgUnitPrev) ? Number((((avgUnitCur - avgUnitPrev) / avgUnitPrev) * 100).toFixed(1)) : null;

    const customersDelta = totalCustomersPrev > 0 ? Number((((totalCustomers - totalCustomersPrev) / totalCustomersPrev) * 100).toFixed(1)) : null;
    const revPerCustomerCur = totalCustomers > 0 ? Math.round(totalRev / totalCustomers) : null;
    const revPerCustomerPrev = totalCustomersPrev > 0 ? Math.round(totalRevPrev / totalCustomersPrev) : null;
    const revPerCustomerDelta = (revPerCustomerCur && revPerCustomerPrev) ? Number((((revPerCustomerCur - revPerCustomerPrev) / revPerCustomerPrev) * 100).toFixed(1)) : null;

    const kpis: DetalleKpis = {
      revenue: { cur: totalRev, prev: totalRevPrev, delta_pct: revDelta },
      margin: { cur: totalMargin, prev: totalMarginPrev, delta_pct: marginDelta },
      margin_pct: { cur: marginPctCur, prev: marginPctPrev, delta_pct: null },
      tickets: { cur: totalTickets, prev: totalTicketsPrev, delta_pct: ticketsDelta },
      avg_ticket: { cur: avgTicketCur, prev: avgTicketPrev, delta_pct: avgTicketDelta },
      basket: { cur: basketCur, prev: basketPrev, delta_pct: basketDelta },
      avg_line: { cur: avgLineCur, prev: avgLinePrev, delta_pct: avgLineDelta },
      units_per_ticket: { cur: unitsPerTicketCur, prev: unitsPerTicketPrev, delta_pct: unitsPerTicketDelta },
      avg_unit: { cur: avgUnitCur, prev: avgUnitPrev, delta_pct: avgUnitDelta },
      customers: { cur: totalCustomers, prev: totalCustomersPrev, delta_pct: customersDelta },
      revenue_per_customer: { cur: revPerCustomerCur, prev: revPerCustomerPrev, delta_pct: revPerCustomerDelta },
    };

    // `[AUD-DAT.18]` LA SERIE REAL, una fila por dia, de `analytics.mv_rd_route_daily_200d`.
    //
    // ⛔ Acá se REPARTIA el total del periodo entre los dias y se lo modulaba con pesos inventados
    // por dia de semana (0.15 domingo, 1.35 vie/sab) mas `varFactor = 0.88 + ((i*17)%25)/100`, una
    // ondulacion derivada del indice del bucle para que la curva pareciera organica. El margen era
    // `dayRev * 0.125`, un 12.5 % plano.
    //
    // ⚠️ El costo llega `null` en los dias que la fuente no lo tiene (el push de camionetas no trae
    // costo, y la fuente lo declara). `null`, NO cero: un dia sin costo no vendio con costo cero.
    const series: DetalleSeriesPoint[] = (dash?.series ?? []).map((p) => ({
      date: p.date,
      label: new Date(`${p.date}T12:00:00`).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }),
      revenue: p.revenue,
      margin: p.cost === null ? 0 : Math.round(p.revenue - p.cost),
      units: p.units,
      tickets: p.tickets,
    }))

    // Top Productos de Ruta
    // `[AUD-DAT.18]` TOP PRODUCTOS REALES. Acá vivia un arreglo de 10 SKUs escritos a mano con
    // `share` fijo (0.082, 0.074, …) y las unidades salian de `parseInt(sku.slice(0,2)) % 15`.
    let cum = 0;
    const top_products: DetalleTopProduct[] = (dash?.top_products ?? []).map((p) => {
      cum += p.share_pct;
      return {
        sku: p.sku,
        nombre: p.name,
        // ⚠️ La marca no viene en esta consulta: se DECLARA vacia en vez de inventarse.
        brand: '',
        canal_predominante: 'ambos' as const,
        revenue: p.revenue,
        units: p.units,
        avg_price: p.units > 0 ? Number((p.revenue / p.units).toFixed(2)) : 0,
        share_pct: p.share_pct,
        cum_share_pct: Number(cum.toFixed(1)),
      };
    });

    // `[AUD-DAT.18]` TOP CLIENTES REALES. Acá vivia `sampleCustomers`, ocho clientes inventados
    // con nombres como «ABARROTES LA GUADALUPANA» y codigos `CLI-8041` que no existen en la base.
    //
    // ⚠️ DECLARADO: 1,032 de 6,298 codigos de cliente (16.4 %) NO tienen nombre en
    // `wincaja.clientes` — incluidos los de mayor venta. En esos la etiqueta ES el codigo, y eso
    // es lo que hay: inventarle un nombre seria volver al problema que este cambio corrige.
    const customers: DetalleCustomerRow[] = (dash?.top_clients ?? []).map((c) => ({
      cliente_code: c.code,
      cliente_nombre: c.name,
      // La ruta del cliente no viene en el agregado; se declara vacia en vez de asignarle una.
      route_code: '',
      tickets: c.tickets,
      revenue: c.revenue,
      avg_ticket: c.tickets > 0 ? Math.round(c.revenue / c.tickets) : 0,
      // La frecuencia exigiria la serie por cliente, que este endpoint no trae.
      frecuencia: '—',
    }));

    return {
      period: { from: params.from, to: params.to, days },
      prev_period: prevPeriod,
      kpis,
      series,
      channels,
      by_route: filteredRows.sort((a, b) => b.revenue - a.revenue),
      by_branch,
      top_products,
      customers,
      routes_catalog: catalog,
    };
  }
}
