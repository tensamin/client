import { Message, mtp } from "@tensamin/shared/data";
import { z } from "zod";

export const accountIdSchema = z.string().min(1);
export const contactSchema = z.object({
  Principal: z.string().optional(),
  LastMessageAt: z.number(),
  UserId: z.number(),
  notifications: z.number().int().nonnegative().default(0),
  LastMessage: z
    .object({ Content: z.base64(), SenderId: z.number() })
    .optional(),
  Messages: z.array(Message),
});
export const contactsSchema = z.array(contactSchema);
export const userProfileSchema = mtp.GetUserData.response;
export const iotaDataSchema = mtp.GetIotaData.response;

// Content remains the protocol base64 ciphertext. This package never decrypts messages.
export const cachedMessageSchema = Message;
export const conversationWindowSchema = z.object({
  Principal: z.string(),
  UserId: z.number(),
  LastMessageAt: z.number(),
  Messages: z.array(cachedMessageSchema),
});
// Unlike cached messages, draft content is plaintext and must use a secure codec.
export const chatDraftSchema = z.object({
  Content: z.string(),
  ReplyId: z.number().optional(),
});

export type Contact = z.infer<typeof contactSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type IotaData = z.infer<typeof iotaDataSchema>;
export type CachedMessage = z.infer<typeof cachedMessageSchema>;
export type ConversationWindow = z.infer<typeof conversationWindowSchema>;
export type ChatDraft = z.infer<typeof chatDraftSchema>;
