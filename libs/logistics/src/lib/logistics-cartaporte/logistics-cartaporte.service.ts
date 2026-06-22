import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { PacService } from './pac.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_GENERICO = 'XAXX010101000';

export interface EmisorProfileDto {
  rfc: string;
  legal_name: string;
  regimen_fiscal: string;
  cp_expedicion: string;
  sct_permit_type?: string;
  sct_permit_number?: string;
  fiscal_address?: Record<string, unknown>;
}

export interface DataGap {
  field: string;
  detail: string;
}

/**
 * J12.0 — Carta Porte 3.1. CFDI tipo Traslado, un complemento por embarque.
 * Arma el complemento desde shipment → guías → destinatarios → order_lines →
 * productos (claves SAT) + vehículo + figura (chofer) + perfil del emisor.
 */
@Injectable()
export class LogisticsCartaporteService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly pac: PacService,
  ) {}

  // ── Perfil fiscal del emisor (1 fila/tenant) ──────────────────────────────
  async getEmisorProfile() {
    return this.tk.run(async (trx) =>
      trx('logistics.carrier_fiscal_profile').first(),
    );
  }

  async upsertEmisorProfile(dto: EmisorProfileDto) {
    if (!dto?.rfc || !dto?.legal_name || !dto?.regimen_fiscal || !dto?.cp_expedicion) {
      throw new BadRequestException('rfc, legal_name, regimen_fiscal y cp_expedicion son requeridos');
    }
    return this.tk.run(async (trx) => {
      const existing = await trx('logistics.carrier_fiscal_profile').first();
      const payload = {
        rfc: dto.rfc.toUpperCase(),
        legal_name: dto.legal_name,
        regimen_fiscal: dto.regimen_fiscal,
        cp_expedicion: dto.cp_expedicion,
        sct_permit_type: dto.sct_permit_type || null,
        sct_permit_number: dto.sct_permit_number || null,
        fiscal_address: dto.fiscal_address ? JSON.stringify(dto.fiscal_address) : null,
        updated_at: trx.fn.now(),
      };
      if (existing) {
        const [row] = await trx('logistics.carrier_fiscal_profile')
          .where({ id: existing.id })
          .update(payload)
          .returning('*');
        return row;
      }
      const [row] = await trx('logistics.carrier_fiscal_profile')
        .insert({ tenant_id: trx.raw('public.current_tenant_id()'), ...payload })
        .returning('*');
      return row;
    });
  }

  // ── Reunir todos los datos del embarque para el complemento ───────────────
  private async gather(trx: any, shipmentId: string) {
    const shipment = await trx('logistics.shipments')
      .where({ id: shipmentId })
      .whereNull('deleted_at')
      .first();
    if (!shipment) throw new NotFoundException(`Embarque ${shipmentId} no encontrado`);

    const profile = await trx('logistics.carrier_fiscal_profile').first();
    const vehicle = shipment.vehicle_id
      ? await trx('logistics.vehicles').where({ id: shipment.vehicle_id }).first()
      : null;
    const originWarehouse = await trx('commercial.warehouses')
      .where({ is_default: true })
      .whereNull('deleted_at')
      .first();

    const guides = await trx('logistics.delivery_guides')
      .where({ shipment_id: shipmentId })
      .whereNull('deleted_at');
    const guideIds = guides.map((g: any) => g.id);
    const recipients = guideIds.length
      ? await trx('logistics.guide_recipients').whereIn('guide_id', guideIds)
      : [];

    // Figuras: choferes/ayudantes de las guías
    const driverIds = [
      ...new Set(
        guides.flatMap((g: any) => [g.driver_id, g.helper1_id, g.helper2_id]).filter(Boolean),
      ),
    ];
    const drivers = driverIds.length
      ? await trx('logistics.drivers').whereIn('id', driverIds as string[])
      : [];

    // Mercancías: itemizar desde las órdenes de los destinatarios (multi-drop,
    // J12.0.x). Fallback a la orden ligada al embarque (1:1) si los destinatarios
    // aún no traen order_id.
    const orderIds = [
      ...new Set(
        [...recipients.map((r: any) => r.order_id), shipment.order_id].filter(Boolean),
      ),
    ] as string[];
    let lines: any[] = [];
    if (orderIds.length) {
      lines = await trx('commercial.order_lines as ol')
        .join('catalog.products as p', 'p.id', 'ol.product_id')
        .whereIn('ol.order_id', orderIds)
        .select(
          'ol.quantity',
          'p.nombre',
          'p.sat_clave_prod_serv',
          'p.sat_clave_unidad',
          'p.sat_material_peligroso',
        );
    }

    return { shipment, profile, vehicle, originWarehouse, guides, recipients, drivers, lines };
  }

  /** Lista de datos faltantes para timbrar. Vacía = listo para timbrar. */
  async validateShipment(shipmentId: string): Promise<DataGap[]> {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const d = await this.gather(trx, shipmentId);
      return this.collectGaps(d);
    });
  }

  private collectGaps(d: any): DataGap[] {
    const gaps: DataGap[] = [];
    const { shipment, profile, vehicle, originWarehouse, recipients, drivers, lines } = d;

    if (!profile) gaps.push({ field: 'emisor', detail: 'Falta el perfil fiscal del emisor (carrier_fiscal_profile)' });
    else {
      if (!profile.sct_permit_type || !profile.sct_permit_number)
        gaps.push({ field: 'emisor.permiso_sct', detail: 'Falta permiso SCT del transportista' });
      if (!profile.fiscal_address) gaps.push({ field: 'emisor.domicilio', detail: 'Falta domicilio fiscal del emisor' });
    }

    if (!vehicle) gaps.push({ field: 'vehiculo', detail: 'El embarque no tiene unidad asignada' });
    else {
      if (!vehicle.sat_config_vehicular) gaps.push({ field: 'vehiculo.config', detail: `Unidad ${vehicle.plate}: falta config vehicular SAT` });
      if (!vehicle.insurance_carrier || !vehicle.insurance_policy)
        gaps.push({ field: 'vehiculo.seguro', detail: `Unidad ${vehicle.plate}: falta aseguradora/póliza` });
    }

    if (!originWarehouse?.fiscal_address)
      gaps.push({ field: 'origen.domicilio', detail: 'El almacén de origen (default) no tiene domicilio fiscal' });

    if (shipment.actual_km == null)
      gaps.push({ field: 'distancia', detail: 'Falta actual_km (DistanciaRecorrida)' });

    if (!recipients.length)
      gaps.push({ field: 'destinos', detail: 'El embarque no tiene destinatarios en sus guías' });
    recipients.forEach((r: any) => {
      if (!r.fiscal_address) gaps.push({ field: 'destino.domicilio', detail: `Destinatario "${r.customer_name}": falta domicilio fiscal` });
    });

    if (!drivers.length)
      gaps.push({ field: 'figura', detail: 'Ninguna guía tiene chofer asignado' });
    drivers.forEach((dr: any) => {
      if (!dr.rfc) gaps.push({ field: 'figura.rfc', detail: `Chofer ${dr.full_name}: falta RFC` });
      if (!dr.federal_license) gaps.push({ field: 'figura.licencia', detail: `Chofer ${dr.full_name}: falta licencia federal` });
    });

    if (!lines.length)
      gaps.push({ field: 'mercancias', detail: 'No hay líneas de mercancía (embarque sin orden ligada o sin order_lines)' });
    lines.forEach((l: any) => {
      if (!l.sat_clave_prod_serv) gaps.push({ field: 'mercancia.clave_sat', detail: `Producto "${l.nombre}": falta ClaveProdServ SAT` });
      if (!l.sat_clave_unidad) gaps.push({ field: 'mercancia.clave_unidad', detail: `Producto "${l.nombre}": falta ClaveUnidad SAT` });
    });

    return gaps;
  }

  /** jsonb fiscal_address (street/neighborhood/...) → Domicilio SAT (Facturama). */
  private mapDomicilio(a: any) {
    if (!a) return undefined;
    const addr = typeof a === 'string' ? JSON.parse(a) : a;
    return {
      Calle: addr.street,
      NumeroExterior: addr.exterior_number,
      Colonia: addr.neighborhood,
      Municipio: addr.city,
      Estado: addr.state,
      Pais: addr.country || 'MEX',
      CodigoPostal: addr.zip,
    };
  }

  /** Date → 'YYYY-MM-DDTHH:mm:ss' (formato CFDI). */
  private fmtDate(v: any): string {
    const d = v ? new Date(v) : new Date();
    return d.toISOString().slice(0, 19);
  }

  /** Arma el complemento CartaPorte31 con el shape exacto de Facturama. */
  private buildComplement(d: any) {
    const { shipment, profile, vehicle, originWarehouse, recipients, drivers, lines } = d;

    const ubicaciones = [
      {
        TipoUbicacion: 'Origen',
        RFCRemitenteDestinatario: profile?.rfc,
        FechaHoraSalidaLlegada: this.fmtDate(shipment.departure_at || shipment.shipment_date),
        Domicilio: this.mapDomicilio(originWarehouse?.fiscal_address),
      },
      ...recipients.map((r: any) => ({
        TipoUbicacion: 'Destino',
        RFCRemitenteDestinatario: r.rfc || RFC_GENERICO,
        FechaHoraSalidaLlegada: this.fmtDate(shipment.arrival_at || shipment.shipment_date),
        DistanciaRecorrida: String(shipment.actual_km ?? 0),
        Domicilio: this.mapDomicilio(r.fiscal_address),
      })),
    ];

    const mercancias = {
      PesoBrutoTotal: Number(shipment.total_weight_kg || 0),
      UnidadPeso: 'KGM',
      NumTotalMercancias: lines.length,
      Mercancia: lines.map((l: any) => ({
        BienesTransp: l.sat_clave_prod_serv,
        Descripcion: l.nombre,
        Cantidad: Number(l.quantity),
        ClaveUnidad: l.sat_clave_unidad,
        PesoEnKg: 1,
        MaterialPeligroso: l.sat_material_peligroso ? 'Sí' : 'No',
      })),
      Autotransporte: {
        PermSCT: profile?.sct_permit_type,
        NumPermisoSCT: profile?.sct_permit_number,
        IdentificacionVehicular: {
          ConfigVehicular: vehicle?.sat_config_vehicular,
          PlacaVM: vehicle?.plate,
          AnioModeloVM: vehicle?.year,
        },
        Seguros: {
          AseguraRespCivil: vehicle?.insurance_carrier,
          PolizaRespCivil: vehicle?.insurance_policy,
        },
      },
    };

    return {
      TranspInternac: 'No',
      TotalDistRec: Number(shipment.actual_km || 0),
      Ubicaciones: ubicaciones,
      Mercancias: mercancias,
      FiguraTransporte: drivers.map((dr: any) => ({
        TipoFigura: '01',
        RFCFigura: dr.rfc,
        NombreFigura: dr.full_name,
        NumLicencia: dr.federal_license,
      })),
    };
  }

  /** Valida → arma CFDI Traslado + complemento → timbra → persiste. */
  async stampShipment(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const d = await this.gather(trx, shipmentId);
      const gaps = this.collectGaps(d);
      if (gaps.length) {
        throw new UnprocessableEntityException({
          message: 'Faltan datos para timbrar la Carta Porte',
          gaps,
        });
      }

      const complement = this.buildComplement(d);
      // CFDI 4.0 tipo Traslado con Carta Porte 3.1 (shape Facturama single-emisor):
      //   - NameId '36' identifica Carta Porte · CfdiType 'T' · valor 0.
      //   - El emisor es la cuenta de Facturama (no se manda Issuer); Receiver = Mega Dulces.
      //   - Complemento.CartaPorte31 (no 'CartaPorte').
      const cfdi = {
        NameId: '36',
        CfdiType: 'T',
        ExpeditionPlace: d.profile.cp_expedicion,
        Receiver: {
          Rfc: d.profile.rfc,
          Name: d.profile.legal_name,
          CfdiUse: 'S01',
          FiscalRegime: d.profile.regimen_fiscal,
          TaxZipCode: d.profile.cp_expedicion,
        },
        Items: [
          {
            ProductCode: '01010101',
            Quantity: '1',
            UnitCode: 'H87',
            Description: `Traslado de mercancía — embarque ${d.shipment.folio}`,
            UnitPrice: '0',
            Subtotal: '0',
            Total: '0',
            TaxObject: '01',
          },
        ],
        Complemento: { CartaPorte31: complement },
      };

      let stamped;
      try {
        stamped = await this.pac.stamp(cfdi);
      } catch (e: any) {
        await trx('logistics.cartaporte_documents').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          shipment_id: shipmentId,
          cfdi_type: 'traslado',
          status: 'error',
          pac_provider: this.pac.provider,
          pac_request: JSON.stringify(cfdi),
          error_message: e?.message || 'error PAC',
        });
        throw e;
      }

      const [row] = await trx('logistics.cartaporte_documents')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          shipment_id: shipmentId,
          cfdi_type: 'traslado',
          status: 'timbrado',
          uuid_fiscal: stamped.uuid,
          serie: stamped.serie || null,
          folio: stamped.folio || null,
          total_distance_km: d.shipment.actual_km,
          pac_provider: this.pac.provider,
          pac_request: JSON.stringify(cfdi),
          pac_response: JSON.stringify(stamped.raw),
          stamped_at: trx.fn.now(),
        })
        .returning('*');
      return row;
    });
  }

  async findByShipment(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) =>
      trx('logistics.cartaporte_documents')
        .where({ shipment_id: shipmentId })
        .orderBy('created_at', 'desc'),
    );
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.cartaporte_documents').where({ id }).first();
      if (!row) throw new NotFoundException(`Documento ${id} no encontrado`);
      return row;
    });
  }
}
