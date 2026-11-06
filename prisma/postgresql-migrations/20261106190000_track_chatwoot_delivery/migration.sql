ALTER TABLE "Message" ADD COLUMN "chatwootDeliveryPending" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "chatwootDeliveryTarget" VARCHAR(64);
CREATE INDEX "Message_instanceId_chatwootDeliveryPending_id_idx" ON "Message"("instanceId", "chatwootDeliveryPending", "id");
