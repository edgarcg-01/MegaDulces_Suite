import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ExhibicionDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @IsNotEmpty() conceptoId!: string;
  @IsString() @IsNotEmpty() ubicacionId!: string;
  @IsOptional() @IsString() nivelEjecucion?: string;
  @IsOptional() @IsString() nivelEjecucionId?: string;
  @IsOptional() @IsString() nivel_ejecucion_id?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) productosMarcados?: string[];
  @IsOptional() @IsString() rangoCompra?: string;
  @IsOptional() @IsNumber() ventaAdicional?: number;
  @IsOptional() @IsString() fotoBase64?: string;
  @IsOptional() @IsString() fotoUrl?: string | null;
  @IsOptional() @IsString() fotoPublicId?: string | null;
  @IsOptional() @IsNumber() puntuacionCalculada?: number;
  @IsOptional() @IsString() horaRegistro?: string;

  // ── Fase V: vendedor sube ticket (separado del exhibidor) ──────────────
  // Estos campos se persisten en el JSONB de la exhibición. Antes vivían
  // como casts `as any` en el frontend — formalizados acá para validation
  // y para que `whitelist: true` no los descarte si en el futuro se endurece
  // el ValidationPipe. `ticket_skipped:true` señala que el vendedor saltó
  // el paso por red mala — útil para reporting de cobertura.
  @IsOptional() @IsString() ticket_foto_url?: string | null;
  @IsOptional() @IsString() ticket_foto_public_id?: string | null;
  @IsOptional() @IsBoolean() ticket_skipped?: boolean;
}

export class StatsDto {
  @IsOptional() @IsNumber() totalExhibiciones?: number;
  @IsOptional() @IsNumber() totalProductosMarcados?: number;
  @IsOptional() @IsNumber() puntuacionTotal?: number;
  @IsOptional() @IsNumber() ventaTotal?: number;
  @IsOptional() @IsNumber() ventaAdicional?: number;
}

export class CreateDailyCaptureDto {
  @ApiProperty({ description: 'Identificador único de la captura, ej. J-31-153045' })
  @IsString() @IsNotEmpty()
  folio!: string;

  @ApiProperty({ description: 'Fecha de la captura diaria en formato YYYY-MM-DD', example: '2026-03-31' })
  @IsOptional() @IsString()
  fechaCaptura?: string;

  @ApiProperty({ description: 'Hora de inicio de la auditoría en formato ISO' })
  @IsString() @IsNotEmpty()
  horaInicio!: string;

  @ApiProperty({ description: 'Hora de fin de la auditoría en formato ISO' })
  @IsString() @IsNotEmpty()
  horaFin!: string;

  @ApiProperty({ description: 'Array de exhibidores reportados con base64 opcional', type: [ExhibicionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExhibicionDto)
  exhibiciones!: ExhibicionDto[];

  @ApiProperty({ description: 'Estructura en formato JSONB con el resumen estadístico de esta captura', type: StatsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => StatsDto)
  stats!: StatsDto;

  @ApiProperty({ description: 'Latitud de la captura diaria', required: false })
  @IsOptional() @IsNumber()
  latitud?: number;

  @ApiProperty({ description: 'Longitud de la captura diaria', required: false })
  @IsOptional() @IsNumber()
  longitud?: number;

  @ApiProperty({ description: 'ID de la tienda asociada (FK stores)', required: false })
  @IsOptional() @IsString()
  store_id?: string;

  @ApiProperty({ description: 'ID de la ruta activa (FK catalogs rutas) en la que se hizo la captura', required: false })
  @IsOptional() @IsString()
  route_id?: string;

  @ApiProperty({
    description: 'UUID generado en el cliente para idempotencia offline→server. Si llega duplicado, el server retorna la fila existente sin re-procesar.',
    required: false,
  })
  @IsOptional() @IsString()
  sync_uuid?: string;

  @ApiProperty({
    description: 'true = visita sin ponderación (no cuenta para scoring de auditoría). Usado por la captura del vendedor.',
    required: false,
  })
  @IsOptional() @IsBoolean()
  skip_scoring?: boolean;
}
