// Owner-scoped chat conversation and message persistence.
import type {
  ChatConversation,
  ChatMessage,
  ChatModel,
  ChatPart,
  ChatReasoning,
} from "@aurora/shared";
import { notFound } from "../errors.js";
import { query } from "../db/pool.js";
import { getProject } from "../library/projects.js";

type ConversationRow = {
  id: string;
  project_id: string;
  title: string;
  model: ChatModel;
  reasoning: ChatReasoning;
  created_at: Date;
  updated_at: Date;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: ChatMessage["role"];
  parts: ChatPart[];
  created_at: Date;
};

function mapConversation(row: ConversationRow): ChatConversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    model: row.model,
    reasoning: row.reasoning,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    parts: row.parts,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listConversations(
  ownerId: string,
  projectId?: string,
): Promise<ChatConversation[]> {
  const result = projectId
    ? await query<ConversationRow>(
        `SELECT id, project_id, title, model, reasoning, created_at, updated_at
         FROM chat_conversations
         WHERE owner_id = $1 AND project_id = $2
         ORDER BY updated_at DESC`,
        [ownerId, projectId],
      )
    : await query<ConversationRow>(
        `SELECT id, project_id, title, model, reasoning, created_at, updated_at
         FROM chat_conversations
         WHERE owner_id = $1
         ORDER BY updated_at DESC`,
        [ownerId],
      );
  return result.rows.map(mapConversation);
}

export async function createConversation(
  ownerId: string,
  projectId: string,
  title = "New chat",
): Promise<ChatConversation> {
  await getProject(ownerId, projectId);
  const result = await query<ConversationRow>(
    `INSERT INTO chat_conversations (owner_id, project_id, title)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, title, model, reasoning, created_at, updated_at`,
    [ownerId, projectId, title],
  );
  return mapConversation(result.rows[0]!);
}

export async function getConversation(
  ownerId: string,
  conversationId: string,
): Promise<ChatConversation> {
  const result = await query<ConversationRow>(
    `SELECT id, project_id, title, model, reasoning, created_at, updated_at
     FROM chat_conversations WHERE owner_id = $1 AND id = $2`,
    [ownerId, conversationId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Conversation");
  return mapConversation(row);
}

export async function patchConversation(
  ownerId: string,
  conversationId: string,
  patch: {
    title?: string | undefined;
    model?: ChatModel | undefined;
    reasoning?: ChatReasoning | undefined;
  },
): Promise<ChatConversation> {
  const result = await query<ConversationRow>(
    `UPDATE chat_conversations SET
       title = COALESCE($3, title), model = COALESCE($4, model),
       reasoning = COALESCE($5, reasoning), updated_at = now()
     WHERE owner_id = $1 AND id = $2
     RETURNING id, project_id, title, model, reasoning, created_at, updated_at`,
    [
      ownerId,
      conversationId,
      patch.title ?? null,
      patch.model ?? null,
      patch.reasoning ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw notFound("Conversation");
  return mapConversation(row);
}

export async function deleteConversation(
  ownerId: string,
  conversationId: string,
): Promise<void> {
  const result = await query(
    `DELETE FROM chat_conversations WHERE owner_id = $1 AND id = $2`,
    [ownerId, conversationId],
  );
  if (result.rowCount === 0) throw notFound("Conversation");
}

export async function listMessages(
  ownerId: string,
  conversationId: string,
): Promise<ChatMessage[]> {
  await getConversation(ownerId, conversationId);
  const result = await query<MessageRow>(
    `SELECT id, conversation_id, role, parts, created_at FROM chat_messages
     WHERE owner_id = $1 AND conversation_id = $2
     ORDER BY created_at ASC, id ASC`,
    [ownerId, conversationId],
  );
  return result.rows.map(mapMessage);
}

export async function insertMessage(
  ownerId: string,
  conversationId: string,
  role: ChatMessage["role"],
  parts: ChatPart[],
): Promise<ChatMessage> {
  const result = await query<MessageRow>(
    `INSERT INTO chat_messages (owner_id, conversation_id, role, parts)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, conversation_id, role, parts, created_at`,
    [ownerId, conversationId, role, JSON.stringify(parts)],
  );
  await query(
    `UPDATE chat_conversations SET updated_at = now() WHERE owner_id = $1 AND id = $2`,
    [ownerId, conversationId],
  );
  return mapMessage(result.rows[0]!);
}

export async function countMessages(
  ownerId: string,
  conversationId: string,
): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM chat_messages
     WHERE owner_id = $1 AND conversation_id = $2`,
    [ownerId, conversationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
