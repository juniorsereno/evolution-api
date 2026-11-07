export function isReactionRemoval(message: unknown): boolean {
  if (!message || typeof message !== 'object' || !('reactionMessage' in message)) return false;
  const reaction = message.reactionMessage;
  if (!reaction || typeof reaction !== 'object' || !('key' in reaction)) return false;
  const key = reaction.key;
  return (
    key !== null &&
    typeof key === 'object' &&
    'id' in key &&
    typeof key.id === 'string' &&
    key.id.length > 0 &&
    (!('text' in reaction) || reaction.text === '')
  );
}
