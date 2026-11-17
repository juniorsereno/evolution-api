import i18next from '@utils/i18n';
import { proto } from 'baileys';

// Keep labels literal: received button text must not manufacture Markdown links or HTML.
function literal(value: string | null | undefined): string {
  return (value ?? '').replace(/[\\`[\]<>]/g, '\\$&');
}

export function receivedContent(message: proto.IMessage): proto.IMessage {
  const template = message?.templateMessage;
  const hydrated = template?.hydratedTemplate ?? template?.hydratedFourRowTemplate;
  if (hydrated) {
    const buttons = (hydrated.hydratedButtons ?? [])
      .map((button) => {
        if (button.quickReplyButton) return literal(button.quickReplyButton.displayText);
        if (button.urlButton) {
          return [literal(button.urlButton.displayText), literal(button.urlButton.url)].filter(Boolean).join(' — ');
        }
        if (button.callButton) {
          return [literal(button.callButton.displayText), literal(button.callButton.phoneNumber)]
            .filter(Boolean)
            .join(' — ');
        }
        return '';
      })
      .filter(Boolean);
    const mediaCaption =
      hydrated.imageMessage?.caption ?? hydrated.videoMessage?.caption ?? hydrated.documentMessage?.caption;
    const sections = [
      hydrated.hydratedTitleText,
      hydrated.hydratedContentText,
      mediaCaption !== hydrated.hydratedContentText ? mediaCaption : undefined,
      hydrated.hydratedFooterText,
    ]
      .map(literal)
      .filter(Boolean);
    if (buttons.length)
      sections.push(
        i18next.t('cw.received.buttons') + '\n' + buttons.map((text, index) => `${index + 1}. ${text}`).join('\n'),
      );
    const text = sections.join('\n\n');
    if (hydrated.imageMessage)
      return {
        imageMessage: {
          ...hydrated.imageMessage,
          caption: text,
          contextInfo: hydrated.imageMessage.contextInfo ?? template.contextInfo,
        },
      };
    if (hydrated.videoMessage)
      return {
        videoMessage: {
          ...hydrated.videoMessage,
          caption: text,
          contextInfo: hydrated.videoMessage.contextInfo ?? template.contextInfo,
        },
      };
    if (hydrated.documentMessage)
      return {
        documentMessage: {
          ...hydrated.documentMessage,
          caption: text,
          contextInfo: hydrated.documentMessage.contextInfo ?? template.contextInfo,
        },
      };
    if (text) return { extendedTextMessage: { text, contextInfo: template.contextInfo } };
  }

  const poll = message?.pollCreationMessageV3 ?? message?.pollCreationMessageV2 ?? message?.pollCreationMessage;
  if (poll?.name && poll.options?.length) {
    const options = poll.options.map((option) => literal(option.optionName));
    if (options.every(Boolean)) {
      return {
        extendedTextMessage: {
          text: [
            i18next.t('cw.received.poll'),
            literal(poll.name),
            ...options.map((text, index) => `${index + 1}. ${text}`),
          ].join('\n'),
          contextInfo: poll.contextInfo,
        },
      };
    }
  }
  return message;
}
