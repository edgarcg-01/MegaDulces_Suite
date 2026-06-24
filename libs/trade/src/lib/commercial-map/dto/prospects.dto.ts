import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProspectListFilterDto {
  @ApiProperty({ required: false, enum: ['candidate', 'covered', 'dismissed', 'converted'] })
  @IsOptional()
  @IsIn(['candidate', 'covered', 'dismissed', 'converted'])
  status?: 'candidate' | 'covered' | 'dismissed' | 'converted';

  @ApiProperty({ required: false, description: 'Prefijo de clase SCIAN' })
  @IsOptional()
  @IsString()
  scian?: string;

  @ApiProperty({ required: false, description: 'Whitespace score mínimo 0..100' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  min_score?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class IngestNearbyDto {
  @ApiProperty()
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiProperty({ required: false, description: 'Radio en metros (≤5000, límite DENUE)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  @Max(5000)
  radius?: number;
}

export class IngestAreaDto {
  @ApiProperty({ required: false, description: 'Código INEGI de entidad (2 díg)' })
  @IsOptional()
  @IsString()
  entidad?: string;

  @ApiProperty({ required: false, description: 'Código de municipio (3 díg)' })
  @IsOptional()
  @IsString()
  municipio?: string;
}

export class ProspectConfigDto {
  @ApiProperty({ required: false, type: [String], description: 'Clases SCIAN objetivo' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scian_codes?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  entidad?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  municipios?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(100)
  @Max(5000)
  default_radius_m?: number;

  @ApiProperty({ required: false, description: 'Centro de la geocerca (lat)' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  center_lat?: number;

  @ApiProperty({ required: false, description: 'Centro de la geocerca (lng)' })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  center_lng?: number;

  @ApiProperty({ required: false, description: 'Radio de la geocerca en km' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  max_radius_km?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ConvertProspectDto {
  @ApiProperty({ required: false, description: 'UUID del cliente creado al dar de alta' })
  @IsOptional()
  @IsString()
  customer_id?: string;
}
