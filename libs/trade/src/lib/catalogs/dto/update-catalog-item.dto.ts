import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateCatalogItemDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  value?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orden?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  puntuacion?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  icono?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiProperty({
    required: false,
    description: 'Estado activo/inactivo (para reactivar un ítem soft-deleted)',
  })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
