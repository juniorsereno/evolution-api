import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import { AuthenticationCreds, AuthenticationState, initAuthCreds, proto, SignalDataTypeMap } from 'baileys';

export async function useMultiFileAuthStateRedisDb(
  instanceName: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}> {
  const logger = new Logger('useMultiFileAuthStateRedisDb');

  const writeData = (data: any, key: string) => cache.hSet(instanceName, key, data);
  const readData = (key: string) => cache.hGet(instanceName, key);
  const removeData = (key: string) => cache.hDelete(instanceName, key);

  async function removeCreds(): Promise<void> {
    logger.warn({ action: 'redis.delete', instanceName });
    await cache.delete(instanceName);
  }

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids: string[]) => {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const data: { [_: string]: SignalDataTypeMap[type] } = {};
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
        set: async (data: any) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) await writeData(value, key);
              else await removeData(key);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      return await writeData(creds, 'creds');
    },

    removeCreds,
  };
}
