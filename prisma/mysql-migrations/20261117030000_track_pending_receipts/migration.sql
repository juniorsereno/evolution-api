ALTER TABLE `Message` ADD COLUMN `chatwootReceiptPending` BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX `Message_instanceId_chatwootReceiptPending_id_idx` ON `Message`(`instanceId`, `chatwootReceiptPending`, `id`);
