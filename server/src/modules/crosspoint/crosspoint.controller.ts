import { Body, Controller, ForbiddenException, Get, Headers, Param, Post, Put, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KoreaderAuthGuard } from '../koreader/koreader-auth.guard';
import { CrosspointService } from './crosspoint.service';
import { CrosspointClippingsQueryDto, CrosspointPutClippingsDto, CrosspointSaveProgressDto } from './dto/crosspoint.dto';

// CrossPoint firmware's sync server contract: kosync progress plus the v2 clippings protocol,
// authenticated with the same credentials as KOReader.
@Public()
@UseGuards(KoreaderAuthGuard)
@Controller('crosspoint')
export class CrosspointController {
  constructor(private readonly crosspointService: CrosspointService) {}

  @Get('users/auth')
  authenticate(@Headers('x-auth-user') username: string) {
    return { authorized: 'OK', username };
  }

  @Post('users/create')
  register() {
    throw new ForbiddenException('Registration disabled. Create credentials in BookOrbit settings.');
  }

  @Put('syncs/progress')
  saveProgress(@CurrentUser() user: RequestUser, @Body() dto: CrosspointSaveProgressDto) {
    return this.crosspointService.saveProgress(user, dto);
  }

  @Get('syncs/progress/:document')
  getProgress(@CurrentUser() user: RequestUser, @Param('document') document: string) {
    return this.crosspointService.getProgress(user.id, document);
  }

  @Get('api/v1/clippings/:document')
  getClippings(@CurrentUser() user: RequestUser, @Param('document') document: string, @Query() query: CrosspointClippingsQueryDto) {
    return this.crosspointService.getClippings(user.id, document, query.cursor ?? 0, query.limit);
  }

  @Put('api/v1/clippings/:document')
  putClippings(@CurrentUser() user: RequestUser, @Param('document') document: string, @Body() dto: CrosspointPutClippingsDto) {
    return this.crosspointService.putClippings(user.id, document, dto.items);
  }
}
