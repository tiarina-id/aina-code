import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type OpenAI from 'openai';

// Session persistence: each session is stored as its own file under
// ~/.ainacode/sessions/<uuid>.json so it can be resumed later with
// `aina --resume <uuid>` or the `/resume` slash command. A small pointer file
// records the most recent session id so a bare `/resume` reopens the latest one.
const SESSION_DIR = path.join(os.homedir(), '.ainacode');
const SESSIONS_DIR = path.join(SESSION_DIR, 'sessions');
const LAST_POINTER_FILE = path.join(SESSION_DIR, 'last-session.json');

export interface SavedSession {
  id: string;
  title: string;
  model: string;
  savedAt: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
}

// Generate a fresh session id (UUID v4).
export function newSessionId(): string {
  return randomUUID();
}

// Persist a session to its own file and update the "last session" pointer.
// Fails silently (like saveConfig) so it never disrupts the main flow.
export function saveSession(session: SavedSession): void {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    const payload: SavedSession = { ...session, savedAt: new Date().toISOString() };
    fs.writeFileSync(sessionPath(session.id), JSON.stringify(payload), 'utf8');
    fs.writeFileSync(LAST_POINTER_FILE, JSON.stringify({ id: session.id }), 'utf8');
  } catch {
    // Ignore session save failures.
  }
}

// Load a session by id, or — when no id is given — the most recent session.
// Returns null when nothing valid is found.
export function loadSession(id?: string): SavedSession | null {
  try {
    const targetId = id ?? readLastSessionId();
    if (!targetId) return null;
    const file = sessionPath(targetId);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.messages)) return null;
    return data as SavedSession;
  } catch {
    return null;
  }
}

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function readLastSessionId(): string | null {
  try {
    if (!fs.existsSync(LAST_POINTER_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LAST_POINTER_FILE, 'utf8'));
    return typeof data?.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}

// Build a short, human-friendly title from the first user message. Used as a
// fallback when the LLM title call fails.
export function fallbackTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled session';
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

// Ask the model for a concise title for this session. Best-effort: on any error
// it falls back to a truncated slice of the first user message.
export async function generateSessionTitle(
  client: OpenAI,
  model: string,
  firstUserMessage: string
): Promise<string> {
  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 20,
      messages: [
        {
          role: 'system',
          content:
            'Generate a short 3-6 word title summarizing a coding session that starts with the user request below. Reply with only the title, no quotes, no punctuation at the end.',
        },
        { role: 'user', content: firstUserMessage.slice(0, 2000) },
      ],
    });
    const raw = res.choices?.[0]?.message?.content ?? '';
    const title = raw.replace(/["'\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) return fallbackTitle(firstUserMessage);
    return title.length > 60 ? `${title.slice(0, 57)}...` : title;
  } catch {
    return fallbackTitle(firstUserMessage);
  }
}
