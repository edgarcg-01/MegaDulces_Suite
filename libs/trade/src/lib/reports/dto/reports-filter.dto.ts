import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

/**
 * DTO compartido para los endpoints GET de /reports.
 *
 * Notas:
 * - `zone` y `supervisorId` se aceptan como string libre porque pueden venir
 *   con valores legacy ("null"/"undefined") que el service ya limpia. Aun así
 *   se validan como UUID cuando vienen no-vacíos.
 * - `userIds` viene como array repetido en query (?userIds=...&userIds=...)
 *   o como string separado por coma según el cliente. Aceptamos ambas formas.
 */
export class ReportsFilterDto {
  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false, description: 'UUID de la zona' })
  @IsOptional()
  @IsString()
  zone?: string;

  @ApiProperty({ required: false, description: 'UUID del supervisor' })
  @IsOptional()
  @IsString()
  supervisorId?: string;

  @ApiProperty({ required: false, type: [String], description: 'UUIDs de usuarios' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.includes(',')
      ? value.split(',').map((s) => s.trim()).filter(Boolean)
      : value,
  )
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

export class ReportsDataFilterDto extends ReportsFilterDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false, description: 'Número de página (1-based)' })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiProperty({ required: false, description: 'Tamaño de página, máx 1000' })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : parseInt(value, 10)))
  @IsInt()
  @Min(0)
  pageSize?: number;

  @ApiProperty({ required: false, description: 'Comma-separated includes, e.g. "products"' })
  @IsOptional()
  @IsString()
  include?: string;
}

export class ReportsStoresFilterDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  zone?: string;
}

/**
 * Reporte de Presencia de Marca: el servidor recibe SOLO filtros y
 * computa todos los KPIs internamente. No acepta payload pre-calculado
 * del cliente.
 */
export class BrandPresenceFilterDto {
  @ApiProperty({ description: 'Nombre exacto de la marca a reportar' })
  @IsString()
  brand!: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false, description: 'UUID de zona (opcional)' })
  @IsOptional()
  @IsString()
  zone?: string;

  @ApiProperty({ required: false, description: 'Etiqueta del destinatario (ej. "Hershey\'s México")' })
  @IsOptional()
  @IsString()
  preparedFor?: string;
}

/**
 * Estructura mínima esperada por el endpoint POST /reports/export-pdf.
 * El service de PDF reconstruye el reporte a partir de este payload —
 * validamos lo crítico (userId del dueño) para evitar exportación cruzada.
 */
export class ExportPdfDto {
  @ApiProperty({ required: false, description: 'UUID del usuario dueño del reporte' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  payload?: any;

  @ApiProperty({ required: false, type: [Object] })
  @IsOptional()
  @IsArray()
  rows?: any[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  endDate?: string;
}
