import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Un breadcrumb GPS de la cola offline del vendedor. */
export class RoutePingDto {
  @ApiProperty({ description: 'client_uuid (dedup idempotente)' })
  @IsUUID()
  client_uuid!: string;

  @ApiProperty({ required: false, description: 'UUID de la ruta activa' })
  @IsOptional()
  @IsUUID()
  route_id?: string;

  @ApiProperty({ description: 'ISO del fix GPS en el dispositivo' })
  @IsISO8601()
  captured_at!: string;

  @ApiProperty()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  accuracy_m?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  speed_mps?: number;

  @ApiProperty({ required: false, enum: ['foreground', 'background'] })
  @IsOptional()
  @IsIn(['foreground', 'background'])
  source?: string;
}

/** Lote de pings sincronizados de una vez (bulk). */
export class RoutePingsBatchDto {
  @ApiProperty({ type: [RoutePingDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RoutePingDto)
  pings!: RoutePingDto[];
}
