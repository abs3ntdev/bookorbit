import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { KoreaderSaveProgressDto } from '../../koreader/dto';

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
export const CLIPPING_TEXT_MAX_BYTES = 4096;
export const CLIPPING_BATCH_MAX = 50;
export const CLIPPING_PAGE_MAX = 100;

export class CrosspointSaveProgressDto extends KoreaderSaveProgressDto {
  // CrossPoint's rich position (pctQ, spine, page, pages, para, xpath). Only xpath is used, and
  // a malformed object is ignored rather than failing the whole sync.
  @IsObject()
  @ValidateIf((_object, value) => value !== undefined)
  position?: Record<string, unknown>;
}

export class CrosspointClippingsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @IsOptional()
  cursor?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLIPPING_PAGE_MAX)
  @IsOptional()
  limit?: number;

  @IsIn(['reader'])
  @IsOptional()
  format?: 'reader';
}

export class CrosspointClippingItemDto {
  @IsString()
  @Matches(/^[\x21-\x7e]{1,64}$/)
  id!: string;

  @IsIn([0, 1])
  @IsOptional()
  deleted?: 0 | 1;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @ValidateIf((item: CrosspointClippingItemDto) => item.deleted !== 1)
  spine?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  start_page?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  end_page?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  pages?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  start_word?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  end_word?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX)
  @IsOptional()
  words?: number;

  @IsInt()
  @Min(0)
  @Max(UINT16_MAX - 1)
  @IsOptional()
  para?: number;

  @IsString()
  @IsOptional()
  chapter?: string;

  @IsString()
  @MinLength(1)
  @ValidateIf((item: CrosspointClippingItemDto) => item.deleted !== 1)
  text?: string;

  @IsInt()
  @Min(0)
  @Max(UINT32_MAX)
  @IsOptional()
  created_at?: number;

  @IsInt()
  @Min(0)
  @Max(UINT32_MAX)
  @IsOptional()
  layout_signature?: number;

  @IsInt()
  @Min(0)
  @Max(UINT32_MAX - 1)
  @ValidateIf((item: CrosspointClippingItemDto) => item.start_offset != null || item.end_offset != null)
  start_offset?: number;

  @IsInt()
  @Min(1)
  @Max(UINT32_MAX - 1)
  @ValidateIf((item: CrosspointClippingItemDto) => item.start_offset != null || item.end_offset != null)
  end_offset?: number;

  @IsString()
  @MaxLength(CLIPPING_TEXT_MAX_BYTES)
  @IsOptional()
  note?: string | null;

  @IsString()
  @MaxLength(32)
  @IsOptional()
  color?: string | null;
}

export class CrosspointPutClippingsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CLIPPING_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => CrosspointClippingItemDto)
  items!: CrosspointClippingItemDto[];
}
