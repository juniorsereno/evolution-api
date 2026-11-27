import { isBoom } from '@hapi/boom';

export function isRejectedPreKeyQuery(error: unknown): boolean {
  return isBoom(error) && error.data === 406 && error.message === 'not-acceptable';
}
