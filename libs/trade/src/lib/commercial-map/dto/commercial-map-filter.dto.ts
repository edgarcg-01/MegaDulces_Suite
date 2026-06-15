import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Filtros del mapa comercial. Query params en English snake_case (convención
 * del proyecto): `date_from`, `date_to`, `zone_id`, `route_id`, `presence`.
 * `zone_id`/`route_id` se validan como string libre (pueden venir "null") y el
 * service revalida el formato UUID antes de usarlos.
 */
export class CommercialMapStoresFilterDto {
  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_to?: string;

  @ApiProperty({ required: false, description: 'UUID de la zona' })
  @IsOptional()
  @IsString()
  zone_id?: string;

  @ApiProperty({ required: false, description: 'UUID de la ruta (catalogs)' })
  @IsOptional()
  @IsString()
  route_id?: string;

  @ApiProperty({
    required: false,
    enum: ['any', 'own', 'competitor', 'both'],
    description: 'Filtra por presencia: propio / competencia / ambas / todas',
  })
  @IsOptional()
  @IsIn(['any', 'own', 'competitor', 'both'])
  presence?: 'any' | 'own' | 'competitor' | 'both';
}

export class CommercialMapHistoryFilterDto {
  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_to?: string;
}

/**
 * Superbuscador de productos: `q` (contains ILIKE) O `product_ids` (CSV de UUIDs
 * ya resueltos, ej. del matcher IA). Devuelve tiendas + visitas donde aparecen.
 */
export class ProductPresenceFilterDto {
  @ApiProperty({ required: false, description: 'Texto a buscar en nombre/sku/código de barras' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiProperty({ required: false, description: 'UUIDs de producto separados por coma' })
  @IsOptional()
  @IsString()
  product_ids?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_from?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  date_to?: string;
}
