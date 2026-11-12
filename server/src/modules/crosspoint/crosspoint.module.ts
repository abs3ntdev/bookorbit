import { Module } from '@nestjs/common';

import { CommonModule } from '../../common/common.module';
import { LibraryScopeModule } from '../../common/library-scope/library-scope.module';
import { KoreaderModule } from '../koreader/koreader.module';
import { PositionConverterModule } from '../position-converter/position-converter.module';
import { UserModule } from '../user/user.module';
import { KoreaderAuthGuard } from '../koreader/koreader-auth.guard';
import { CrosspointClippingRepository } from './crosspoint-clipping.repository';
import { CrosspointController } from './crosspoint.controller';
import { CrosspointService } from './crosspoint.service';

@Module({
  imports: [CommonModule, LibraryScopeModule, KoreaderModule, PositionConverterModule, UserModule],
  controllers: [CrosspointController],
  providers: [CrosspointService, CrosspointClippingRepository, KoreaderAuthGuard],
})
export class CrosspointModule {}
