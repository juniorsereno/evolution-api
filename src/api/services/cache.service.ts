import { ICache } from '@api/abstract/abstract.cache';
import { Logger } from '@config/logger.config';
import { BufferJSON } from 'baileys';

export class CacheService {
  private readonly logger = new Logger('CacheService');

  constructor(
    private readonly cache: ICache,
    private readonly failureMode: 'ignore' | 'throw' = 'ignore',
  ) {
    if (!cache && failureMode === 'throw') throw new Error('Persistent cache is not configured');
    if (cache) {
      this.logger.verbose(`cacheservice created using cache engine: ${cache.constructor?.name}`);
    } else {
      this.logger.verbose(`cacheservice disabled`);
    }
  }

  async get(key: string): Promise<any> {
    if (!this.cache) {
      return;
    }
    return this.cache.get(key);
  }

  public async hGet(key: string, field: string) {
    if (!this.cache) {
      return null;
    }
    try {
      const data = await this.cache.hGet(key, field);

      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      if (this.failureMode === 'throw') throw error;
      this.logger.error(error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number) {
    if (!this.cache) {
      return;
    }
    await this.cache.set(key, value, ttl);
  }

  public async hSet(key: string, field: string, value: any) {
    if (!this.cache) {
      return;
    }
    try {
      const json = JSON.stringify(value, BufferJSON.replacer);

      await this.cache.hSet(key, field, json);
    } catch (error) {
      if (this.failureMode === 'throw') throw error;
      this.logger.error(error);
    }
  }

  async hUpdate(key: string, changes: Record<string, unknown | null>): Promise<void> {
    if (!this.cache) throw new Error('Persistent cache is not configured');
    const serialized = Object.fromEntries(
      Object.entries(changes).map(([field, value]) => [
        field,
        value === null ? null : JSON.stringify(value, BufferJSON.replacer),
      ]),
    );
    await this.cache.hUpdate(key, serialized);
  }

  async has(key: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.has(key);
  }

  async delete(key: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.delete(key);
  }

  async hDelete(key: string, field: string) {
    if (!this.cache) {
      return false;
    }
    try {
      await this.cache.hDelete(key, field);
      return true;
    } catch (error) {
      if (this.failureMode === 'throw') throw error;
      this.logger.error(error);
      return false;
    }
  }

  async deleteAll(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.deleteAll(appendCriteria);
  }

  async keys(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    return this.cache.keys(appendCriteria);
  }
}
