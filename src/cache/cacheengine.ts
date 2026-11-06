import { ICache } from '@api/abstract/abstract.cache';
import { CacheConf, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

import { LocalCache } from './localcache';
import { RedisCache } from './rediscache';

const logger = new Logger('CacheEngine');

export class CacheEngine {
  private engine: ICache;

  constructor(
    private readonly configService: ConfigService,
    module: string,
    failureMode: 'ignore' | 'throw' = 'ignore',
  ) {
    const cacheConf = configService.get<CacheConf>('CACHE');

    if (failureMode === 'throw' && (!cacheConf?.REDIS?.ENABLED || !cacheConf.REDIS.URI)) {
      throw new Error('Persistent session storage requires a Redis URI');
    }

    if (cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') {
      logger.verbose(`RedisCache initialized for ${module}`);
      this.engine = new RedisCache(configService, module, failureMode);
    } else if (cacheConf?.LOCAL?.ENABLED) {
      logger.verbose(`LocalCache initialized for ${module}`);
      this.engine = new LocalCache(configService, module);
    }
  }

  public getEngine() {
    return this.engine;
  }
}
