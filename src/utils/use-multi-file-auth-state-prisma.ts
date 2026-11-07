import { prismaRepository } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { CacheConf, configService } from '@config/env.config';
import { INSTANCE_DIR } from '@config/path.config';
import { AuthenticationState, BufferJSON, initAuthCreds, WAProto as proto } from 'baileys';
import fs from 'fs/promises';
import path from 'path';

const fixFileName = (file: string): string | undefined => {
  if (!file) {
    return undefined;
  }
  const replacedSlash = file.replace(/\//g, '__');
  const replacedColon = replacedSlash.replace(/:/g, '-');
  return replacedColon;
};

export async function saveKey(sessionId: string, keyJson: string): Promise<void> {
  const creds = JSON.stringify(keyJson);
  await prismaRepository.session.upsert({
    where: { sessionId },
    create: { sessionId, creds },
    update: { creds },
  });
}

export async function getAuthKey(sessionId: string): Promise<string | null> {
  const auth = await prismaRepository.session.findUnique({ where: { sessionId } });
  if (!auth) return null;
  const encoded: unknown = JSON.parse(auth.creds);
  if (typeof encoded !== 'string') throw new Error('Invalid persisted credentials');
  return encoded;
}

export async function removePrismaAuthState(sessionId: string, cache: CacheService): Promise<void> {
  if (configService.get<CacheConf>('CACHE').REDIS.ENABLED) await cache.delete(sessionId);
  await prismaRepository.session.deleteMany({ where: { sessionId } });
}

export default async function useMultiFileAuthStatePrisma(
  sessionId: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}> {
  const localFolder = path.join(INSTANCE_DIR, sessionId);
  const localFile = (key: string) => path.join(localFolder, fixFileName(key) + '.json');
  const redisEnabled = configService.get<CacheConf>('CACHE').REDIS.ENABLED;
  if (!redisEnabled) await fs.mkdir(localFolder, { recursive: true });

  async function readData(key: string): Promise<any> {
    if (key === 'creds') {
      const raw = await getAuthKey(sessionId);
      if (raw === null) return null;
      const value = JSON.parse(raw, BufferJSON.reviver);
      if (!value || typeof value !== 'object') throw new Error('Invalid persisted credentials');
      return value;
    }
    if (redisEnabled) return cache.hGet(sessionId, key);
    try {
      return JSON.parse(await fs.readFile(localFile(key), 'utf8'), BufferJSON.reviver);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await saveKey(sessionId, JSON.stringify(creds, BufferJSON.replacer));
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.create(value);
              }

              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const changes: Record<string, unknown | null> = {};
          for (const [category, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values)) changes[`${category}-${id}`] = value ?? null;
          }
          if (redisEnabled) return cache.hUpdate(sessionId, changes);
          const serialized = Object.entries(changes).map(([key, value]) => [
            key,
            value === null ? null : JSON.stringify(value, BufferJSON.replacer),
          ]);
          for (const [key, value] of serialized) {
            if (value === null) await fs.rm(localFile(key), { force: true });
            else await fs.writeFile(localFile(key), value);
          }
        },
      },
    },
    saveCreds: () => {
      return saveKey(sessionId, JSON.stringify(creds, BufferJSON.replacer));
    },

    removeCreds: () => removePrismaAuthState(sessionId, cache),
  };
}
