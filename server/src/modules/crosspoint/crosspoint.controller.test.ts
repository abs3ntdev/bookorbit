import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { KoreaderAuthGuard } from '../koreader/koreader-auth.guard';
import { CrosspointController } from './crosspoint.controller';

describe('CrosspointController', () => {
  const service = {
    saveProgress: vi.fn().mockResolvedValue({ document: 'h', timestamp: 1 }),
    getProgress: vi.fn().mockResolvedValue({}),
    getClippings: vi.fn().mockResolvedValue({ sync_version: 2 }),
    putClippings: vi.fn().mockResolvedValue({ accepted: 1 }),
  };
  const controller = new CrosspointController(service as never);
  const user = { id: 3 } as RequestUser;

  it('is public to the JWT guard and protected by the KOReader guard', () => {
    expect(new Reflector().get(IS_PUBLIC_KEY, CrosspointController)).toBe(true);
    expect(Reflect.getMetadata('__guards__', CrosspointController)).toEqual([KoreaderAuthGuard]);
  });

  it('answers the kosync auth probe and refuses registration', () => {
    expect(controller.authenticate('reader')).toEqual({ authorized: 'OK', username: 'reader' });
    expect(() => controller.register()).toThrow(ForbiddenException);
  });

  it('defaults the clipping cursor to zero', async () => {
    await controller.getClippings(user, 'h', { limit: 1, format: 'reader' });
    expect(service.getClippings).toHaveBeenCalledWith(3, 'h', 0, 1);
  });

  it('passes uploads and progress through for the device user', async () => {
    await controller.putClippings(user, 'h', { items: [{ id: 'a', deleted: 1 }] });
    expect(service.putClippings).toHaveBeenCalledWith(3, 'h', [{ id: 'a', deleted: 1 }]);
    await controller.getProgress(user, 'h');
    expect(service.getProgress).toHaveBeenCalledWith(3, 'h');
  });
});
