import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtMoney(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return v.toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

@Injectable()
export class LogisticsReportsService {
  constructor(private readonly tk: TenantKnexService) {}

  /**
   * Reporte PDF resumen del shipment. Incluye: header, datos generales,
   * guías y destinatarios, expenses y comisiones.
   *
   * Retorna un Buffer Node (binario) listo para enviar como response octet-stream.
   */
  async shipmentSummaryPdf(shipmentId: string): Promise<Buffer> {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipment_id inválido');

    const data = await this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments as s')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .leftJoin('logistics.routes as r', 'r.id', 's.route_id')
        .leftJoin('commercial.orders as o', 'o.id', 's.order_id')
        .where('s.id', shipmentId)
        .whereNull('s.deleted_at')
        .select(
          's.*',
          'v.plate as vehicle_plate',
          'v.model as vehicle_model',
          'r.name as route_name',
          'o.code as order_code',
        )
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${shipmentId} no encontrado`);

      const guides = await trx('logistics.delivery_guides as g')
        .leftJoin('logistics.drivers as d', 'd.id', 'g.driver_id')
        .leftJoin('logistics.drivers as h1', 'h1.id', 'g.helper1_id')
        .leftJoin('logistics.drivers as h2', 'h2.id', 'g.helper2_id')
        .where('g.shipment_id', shipmentId)
        .whereNull('g.deleted_at')
        .select(
          'g.*',
          'd.full_name as driver_name',
          'h1.full_name as helper1_name',
          'h2.full_name as helper2_name',
        )
        .orderBy('g.created_at', 'asc');

      const recipients = await trx('logistics.guide_recipients as r')
        .innerJoin('logistics.delivery_guides as g', 'g.id', 'r.guide_id')
        .where('g.shipment_id', shipmentId)
        .whereNull('g.deleted_at')
        .select('r.*', 'g.number as guide_number')
        .orderBy('r.created_at', 'asc');

      const expenses = await trx('logistics.shipment_expenses').where({ shipment_id: shipmentId }).first();

      return { shipment, guides, recipients, expenses };
    });

    return this.buildShipmentPdf(data);
  }

  private buildShipmentPdf(data: any): Buffer {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const { shipment, guides, recipients, expenses } = data;

    // ── Header ───────────────────────────────────────────────────────────────
    doc.setFontSize(18);
    doc.text('Resumen de Embarque', 40, 50);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Folio: ${shipment.folio}`, 40, 70);
    doc.text(`Fecha: ${fmtDate(shipment.shipment_date)}`, 200, 70);
    doc.text(`Estado: ${shipment.status}`, 360, 70);
    doc.setTextColor(0);

    // ── Datos generales ──────────────────────────────────────────────────────
    autoTable(doc, {
      startY: 90,
      head: [['Campo', 'Valor']],
      body: [
        ['Tipo', shipment.type],
        ['Origen', shipment.origin || '—'],
        ['Destino', shipment.destination || shipment.route_name || '—'],
        ['Vehículo', shipment.vehicle_plate ? `${shipment.vehicle_plate} — ${shipment.vehicle_model || ''}` : '—'],
        ['Pedido', shipment.order_code || '—'],
        ['Valor mercancía', fmtMoney(shipment.cargo_value)],
        ['Flete cobrado', fmtMoney(shipment.freight_revenue)],
        ['Cajas', String(shipment.boxes_count || 0)],
        ['Peso total (kg)', String(shipment.total_weight_kg || 0)],
        ['Km reales', shipment.actual_km ? String(shipment.actual_km) : '—'],
        ['Salida', shipment.departure_at ? fmtDate(shipment.departure_at) : '—'],
        ['Llegada', shipment.arrival_at ? fmtDate(shipment.arrival_at) : '—'],
      ],
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [245, 166, 35], textColor: 255 },
      columnStyles: { 0: { cellWidth: 150, fontStyle: 'bold' } },
    });

    // ── Guías ────────────────────────────────────────────────────────────────
    if (guides.length) {
      const startY = (doc as any).lastAutoTable.finalY + 20;
      doc.setFontSize(12);
      doc.text('Guías de entrega', 40, startY);
      autoTable(doc, {
        startY: startY + 8,
        head: [['Número', 'Chofer', 'Ayudante 1', 'Ayudante 2', 'Comis. chofer', 'Comis. h1', 'Comis. h2', 'Viáticos', 'Estado']],
        body: guides.map((g: any) => [
          g.number,
          g.driver_name || '—',
          g.helper1_name || '—',
          g.helper2_name || '—',
          fmtMoney(g.driver_commission),
          fmtMoney(g.helper1_commission),
          fmtMoney(g.helper2_commission),
          fmtMoney(g.per_diem_total),
          g.status,
        ]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [60, 60, 60], textColor: 255 },
      });
    }

    // ── Destinatarios ────────────────────────────────────────────────────────
    if (recipients.length) {
      const startY = (doc as any).lastAutoTable.finalY + 20;
      doc.setFontSize(12);
      doc.text('Destinatarios', 40, startY);
      autoTable(doc, {
        startY: startY + 8,
        head: [['Guía', 'Cliente', 'Dirección', 'Cajas', 'Valor', 'Estado', 'Entregado a']],
        body: recipients.map((r: any) => [
          r.guide_number,
          r.customer_name,
          r.address || '—',
          String(r.boxes_count || 0),
          fmtMoney(r.value),
          r.status,
          r.delivered_to || '—',
        ]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [60, 60, 60], textColor: 255 },
      });
    }

    // ── Costos ───────────────────────────────────────────────────────────────
    if (expenses) {
      const startY = (doc as any).lastAutoTable.finalY + 20;
      doc.setFontSize(12);
      doc.text('Costos del viaje', 40, startY);
      autoTable(doc, {
        startY: startY + 8,
        head: [['Concepto', 'Monto']],
        body: [
          ['Combustible', fmtMoney(expenses.fuel)],
          ['Casetas', fmtMoney(expenses.tolls)],
          ['Hospedaje', fmtMoney(expenses.lodging)],
          ['Pensiones', fmtMoney(expenses.parking)],
          ['Permisos', fmtMoney(expenses.permits)],
          ['Reparaciones', fmtMoney(expenses.repairs)],
          ['Ayudantes externos', fmtMoney(expenses.external_helpers)],
          ['Maniobras', fmtMoney(expenses.handling)],
          ['Viáticos chofer', fmtMoney(expenses.driver_per_diem)],
          ['Otros', fmtMoney(expenses.other)],
          ['Subtotal operativo', fmtMoney(expenses.operating_subtotal)],
          ['TOTAL', fmtMoney(expenses.total_cost)],
        ],
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [245, 166, 35], textColor: 255 },
        columnStyles: { 0: { cellWidth: 200, fontStyle: 'bold' }, 1: { halign: 'right' } },
      });
    }

    // Footer
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(
        `Generado ${new Date().toLocaleString('es-MX')} — pág ${i}/${pages}`,
        40,
        doc.internal.pageSize.height - 20,
      );
    }

    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
  }

  /**
   * KPIs operativos del período (entre from/to). JSON, no PDF.
   * Devuelve: total embarques, completados (cerrados), cancelados, revenue flete,
   * total costos, margen, costo promedio por km, comisiones pagadas.
   */
  async kpiSummary(from?: string, to?: string) {
    return this.tk.run(async (trx) => {
      const f = from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const t = to || new Date().toISOString().slice(0, 10);

      const ship = await trx('logistics.shipments')
        .whereBetween('shipment_date', [f, t])
        .whereNull('deleted_at')
        .select(
          trx.raw('count(*)::int as total'),
          trx.raw(`count(*) filter (where status = 'cerrado')::int as cerrados`),
          trx.raw(`count(*) filter (where status = 'cancelado')::int as cancelados`),
          trx.raw(`count(*) filter (where status not in ('cerrado','cancelado'))::int as activos`),
          trx.raw('coalesce(sum(freight_revenue),0)::numeric as revenue'),
          trx.raw('coalesce(sum(actual_km),0)::int as km_total'),
          trx.raw('coalesce(sum(boxes_count),0)::int as cajas'),
        )
        .first();

      const exp = await trx('logistics.shipment_expenses as e')
        .innerJoin('logistics.shipments as s', 's.id', 'e.shipment_id')
        .whereBetween('s.shipment_date', [f, t])
        .whereNull('s.deleted_at')
        .select(
          trx.raw('coalesce(sum(e.total_cost),0)::numeric as total_costos'),
          trx.raw('coalesce(sum(e.fuel),0)::numeric as combustible'),
          trx.raw('coalesce(sum(e.tolls),0)::numeric as casetas'),
        )
        .first();

      const com = await trx('logistics.delivery_guides as g')
        .innerJoin('logistics.shipments as s', 's.id', 'g.shipment_id')
        .whereBetween('s.shipment_date', [f, t])
        .whereNull('s.deleted_at')
        .select(
          trx.raw(`coalesce(sum(g.driver_commission + g.helper1_commission + g.helper2_commission),0)::numeric as comisiones`),
          trx.raw('coalesce(sum(g.per_diem_total),0)::numeric as viaticos'),
        )
        .first();

      const revenue = Number(ship?.revenue || 0);
      const costos = Number(exp?.total_costos || 0);
      const comisiones = Number(com?.comisiones || 0);
      const margen = revenue - costos - comisiones;
      const kmTotal = Number(ship?.km_total || 0);
      const costoKm = kmTotal > 0 ? costos / kmTotal : 0;

      return {
        period: { from: f, to: t },
        shipments: {
          total: Number(ship?.total || 0),
          cerrados: Number(ship?.cerrados || 0),
          cancelados: Number(ship?.cancelados || 0),
          activos: Number(ship?.activos || 0),
        },
        operations: {
          km_total: kmTotal,
          cajas: Number(ship?.cajas || 0),
        },
        financial: {
          revenue,
          total_costos: costos,
          combustible: Number(exp?.combustible || 0),
          casetas: Number(exp?.casetas || 0),
          comisiones,
          viaticos: Number(com?.viaticos || 0),
          margen,
          costo_promedio_km: Number(costoKm.toFixed(2)),
        },
      };
    });
  }

  /** KPIs como PDF descargable. */
  async kpiSummaryPdf(from?: string, to?: string): Promise<Buffer> {
    const k = await this.kpiSummary(from, to);
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    doc.setFontSize(18);
    doc.text('KPIs Operativos — Logística', 40, 50);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Período: ${k.period.from}  →  ${k.period.to}`, 40, 70);
    doc.setTextColor(0);

    autoTable(doc, {
      startY: 90,
      head: [['Embarques', '#']],
      body: [
        ['Total', String(k.shipments.total)],
        ['Cerrados', String(k.shipments.cerrados)],
        ['Cancelados', String(k.shipments.cancelados)],
        ['Activos', String(k.shipments.activos)],
      ],
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [245, 166, 35], textColor: 255 },
      columnStyles: { 0: { cellWidth: 200, fontStyle: 'bold' }, 1: { halign: 'right' } },
    });

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 20,
      head: [['Operación', 'Valor']],
      body: [
        ['Km totales', String(k.operations.km_total)],
        ['Cajas movidas', String(k.operations.cajas)],
      ],
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [60, 60, 60], textColor: 255 },
      columnStyles: { 0: { cellWidth: 200, fontStyle: 'bold' }, 1: { halign: 'right' } },
    });

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 20,
      head: [['Financiero', 'Monto']],
      body: [
        ['Revenue flete', fmtMoney(k.financial.revenue)],
        ['Total costos', fmtMoney(k.financial.total_costos)],
        ['  · Combustible', fmtMoney(k.financial.combustible)],
        ['  · Casetas', fmtMoney(k.financial.casetas)],
        ['Comisiones pagadas', fmtMoney(k.financial.comisiones)],
        ['Viáticos', fmtMoney(k.financial.viaticos)],
        ['MARGEN', fmtMoney(k.financial.margen)],
        ['Costo promedio / km', fmtMoney(k.financial.costo_promedio_km)],
      ],
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [60, 60, 60], textColor: 255 },
      columnStyles: { 0: { cellWidth: 200, fontStyle: 'bold' }, 1: { halign: 'right' } },
    });

    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Generado ${new Date().toLocaleString('es-MX')}`,
      40,
      doc.internal.pageSize.height - 20,
    );

    return Buffer.from(doc.output('arraybuffer'));
  }
}
