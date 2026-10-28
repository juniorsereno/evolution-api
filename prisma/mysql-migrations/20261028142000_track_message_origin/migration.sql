CREATE TABLE `MessageOrigin` (
    `instanceId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(100) NOT NULL,
    `origin` VARCHAR(20) NOT NULL,
    `chatwootAccountId` VARCHAR(100),
    `chatwootMessageId` INTEGER,
    `chatwootInboxId` INTEGER,
    `chatwootConversationId` INTEGER,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`instanceId`, `messageId`),
    CONSTRAINT `MessageOrigin_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MessageOrigin_origin_check` CHECK (
      (`origin` = 'api' AND `chatwootAccountId` IS NULL AND `chatwootMessageId` IS NULL AND `chatwootInboxId` IS NULL AND `chatwootConversationId` IS NULL)
      OR (`origin` = 'chatwoot' AND `chatwootAccountId` IS NOT NULL AND `chatwootMessageId` IS NOT NULL AND `chatwootInboxId` IS NOT NULL AND `chatwootConversationId` IS NOT NULL)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
