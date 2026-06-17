import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class ListExecution360Dto {
  @IsOptional()
  @IsString()
  @IsIn(['collaborator', 'route', 'store'])
  subject_type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 30])
  window_days?: number;
}
