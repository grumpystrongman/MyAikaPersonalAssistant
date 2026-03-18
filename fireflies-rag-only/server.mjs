import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import dotenv from "dotenv";
import {
  isLocalOnlyMode,
  isFirefliesPullAllowed,
  isMicrosoftTodoSyncAllowed,
  shouldBlockExternalUrl,
  makeLocalOnlyError
} from "../apps/server/src/security/localOnlyMode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const repoRoot = path.resolve(__dirname, "..");
const resolvedRepoRoot = process.env.FIREFLIES_REPO_ROOT || repoRoot;
const resolvedDbPath =
  process.env.FIREFLIES_DB_PATH ||
  path.join(repoRoot, "data", "db", "fireflies.sqlite");
process.env.FIREFLIES_REPO_ROOT = resolvedRepoRoot;
process.env.FIREFLIES_DB_PATH = resolvedDbPath;

const localOnlyMode = isLocalOnlyMode();
const firefliesPullAllowed = localOnlyMode && isFirefliesPullAllowed();
const microsoftTodoSyncAllowed = !localOnlyMode || isMicrosoftTodoSyncAllowed();
const insecureTlsRequested = ["1", "true", "yes"].includes(
  String(process.env.FIREFLIES_ALLOW_INSECURE_TLS || "").trim().toLowerCase()
);
if (localOnlyMode) {
  process.env.OPENAI_API_KEY = "";
  if (!firefliesPullAllowed) {
    process.env.FIREFLIES_API_KEY = "";
  }
  process.env.FIREFLIES_AUTO_EMAIL = "0";
  process.env.FIREFLIES_NOTIFY_CHANNELS = "";
  process.env.RAG_REASONING_PROVIDER = "ollama";
  process.env.OLLAMA_FALLBACK_TO_OPENAI = "0";
  process.env.RAG_EMBEDDINGS_PROVIDER = "local";
  process.env.TRANSFORMERS_OFFLINE = process.env.TRANSFORMERS_OFFLINE || "1";
  process.env.HF_HUB_OFFLINE = process.env.HF_HUB_OFFLINE || "1";
  process.env.HF_DATASETS_OFFLINE = process.env.HF_DATASETS_OFFLINE || "1";
  process.env.HF_HUB_DISABLE_TELEMETRY = process.env.HF_HUB_DISABLE_TELEMETRY || "1";
  if (typeof globalThis.fetch === "function") {
    const baseFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const target =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : String(input?.url || "");
      if (shouldBlockExternalUrl(target)) {
        throw makeLocalOnlyError(target);
      }
      return await baseFetch(input, init);
    };
  }
  if (firefliesPullAllowed && microsoftTodoSyncAllowed) {
    console.warn("LOCAL_ONLY_MODE enabled: outbound HTTP(S) blocked except Fireflies pull and Microsoft To-Do endpoints.");
  } else if (firefliesPullAllowed) {
    console.warn("LOCAL_ONLY_MODE enabled: outbound HTTP(S) blocked except Fireflies pull endpoint.");
  } else if (microsoftTodoSyncAllowed) {
    console.warn("LOCAL_ONLY_MODE enabled: outbound HTTP(S) blocked except Microsoft To-Do endpoints.");
  } else {
    console.warn("LOCAL_ONLY_MODE enabled: outbound HTTP(S) requests are blocked.");
  }
}

const insecureTlsEnabled = insecureTlsRequested && (!localOnlyMode || firefliesPullAllowed);
if (insecureTlsEnabled) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("Warning: TLS certificate verification disabled (FIREFLIES_ALLOW_INSECURE_TLS=1).");
}

process.env.RAG_SQLITE_PATH = process.env.RAG_SQLITE_PATH || "apps/server/data/fireflies_rag.sqlite";
process.env.RAG_EMBEDDINGS_PROVIDER = process.env.RAG_EMBEDDINGS_PROVIDER || "local";
process.env.RAG_LOCAL_EMBEDDING_MODEL = process.env.RAG_LOCAL_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const defaultUserId = process.env.FIREFLIES_DEFAULT_USER_ID || "local";
process.env.FIREFLIES_DEFAULT_USER_ID = defaultUserId;
process.env.RAG_MULTIUSER_ENABLED = process.env.RAG_MULTIUSER_ENABLED || "0";
const strictUserScope = process.env.FIREFLIES_STRICT_USER_SCOPE || "0";
process.env.FIREFLIES_STRICT_USER_SCOPE = strictUserScope;

const { syncFireflies, getFirefliesSyncStatus, startFirefliesSyncLoop } = await import("../apps/server/src/rag/firefliesIngest.js");
const { answerRagQuestion } = await import("../apps/server/src/rag/query.js");
const { formatRagAnswer } = await import("../apps/server/src/rag/format.js");
const { ingestTodoToRag } = await import("../apps/server/src/rag/todosIngest.js");
const { initDb } = await import("../apps/server/storage/db.js");
const { runMigrations } = await import("../apps/server/storage/schema.js");
const {
  createTodoRecord,
  getTodoRecord,
  listTodosRecord,
  updateTodoRecord,
  completeTodoRecord,
  deleteTodoRecord,
  createTodoListRecord,
  listTodoListsRecord,
  updateTodoListRecord,
  getTodoListRecord
} = await import("../apps/server/storage/todos.js");
const {
  connectMicrosoft,
  exchangeMicrosoftCode,
  resolveMicrosoftAccount,
  getMicrosoftStatus,
  getMicrosoftAccessToken
} = await import("../apps/server/integrations/microsoft.js");
const { getProvider, setProvider } = await import("../apps/server/integrations/store.js");
const {
  initRagStore,
  getRagCounts,
  getVectorStoreStatus,
  getMeetingCoverage
} = await import("../apps/server/src/rag/vectorStore.js");

const host = process.env.FIREFLIES_RAG_HOST || (localOnlyMode ? "127.0.0.1" : "0.0.0.0");
const port = Number(process.env.FIREFLIES_RAG_PORT || process.env.PORT || 8788);
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(express.json({ limit: "30mb" }));

function toInt(value, fallback = 0, min = 0, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseSyncLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") return 0;
  const n = Number(rawLimit);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

const MICROSOFT_GRAPH_BASE = process.env.MICROSOFT_GRAPH_BASE || "https://graph.microsoft.com/v1.0";
const MICROSOFT_TODO_SCOPE = "https://graph.microsoft.com/Tasks.ReadWrite";
const MICROSOFT_TODO_READ_SCOPE = "https://graph.microsoft.com/Tasks.Read";
const TODO_USER_ID = "local";
const KANBAN_PRIORITY_COLUMNS = [
  { key: "backlog", name: "Backlog / To Be Processed", color: "#64748b", sortOrder: 10 },
  { key: "priority_high", name: "Priority - High", color: "#ef4444", sortOrder: 20 },
  { key: "priority_medium", name: "Priority - Medium", color: "#f59e0b", sortOrder: 30 },
  { key: "priority_low", name: "Priority - Low", color: "#22c55e", sortOrder: 40 },
  { key: "done", name: "Done", color: "#0ea5e9", sortOrder: 90 }
];
const BACKLOG_LIST_FALLBACK_ID = "inbox";
const MANUAL_COLUMN_TAG = "manual-column";
const PRIORITY_TAG_PREFIX = "priority:";
const MS_TODO_IMPORT_COLUMN_NAME = "MS-TODO";
const MS_TODO_IMPORT_COLUMN_COLOR = "#2563eb";
const MS_TODO_SOURCE_TAG = "source:microsoft-todo";
const MS_TODO_ID_TAG_PREFIX = "ms-id:";
const MS_TODO_LIST_TAG_PREFIX = "ms-list:";
const MS_TODO_KIND_TAG_PREFIX = "ms-kind:";
const NOTION_IMPORT_COLUMN_NAME = "NOTION";
const NOTION_IMPORT_COLUMN_COLOR = "#6d28d9";
const NOTION_SOURCE_TAG = "source:notion";
const NOTION_ID_TAG_PREFIX = "notion-id:";
const NOTION_DB_TAG_PREFIX = "notion-db:";
const NOTION_COLUMN_TAG_PREFIX = "notion-column:";
const KANBAN_HIDDEN_TAG = "kanban-hidden";
const SELECTED_FOR_KANBAN_TAG = "selected-for-kanban";
const MEETING_SELECTION_TAG = "meeting-selection";
const PRIORITY_KEYWORDS = {
  high: ["urgent", "asap", "critical", "blocker", "immediately", "today", "eod", "end of day", "p1", "hotfix", "escalate", "must", "deadline", "ship"],
  medium: ["follow up", "review", "schedule", "prepare", "draft", "coordinate", "plan", "send", "check in", "sync", "align", "confirm", "deliverable"],
  low: ["someday", "later", "parking lot", "nice to have", "optional", "low priority"]
};
const TASK_CONTEXT_STOP_WORDS = new Set([
  "the", "and", "with", "that", "this", "from", "have", "will", "your", "about", "meeting",
  "task", "follow", "action", "item", "items", "for", "into", "onto", "then", "than", "also",
  "there", "their", "they", "them", "been", "were", "when", "what", "where", "which", "would",
  "could", "should", "need", "needs", "into", "over", "under", "today", "tomorrow", "yesterday"
]);
const GRAPH_TOPIC_STOP_WORDS = new Set([
  ...TASK_CONTEXT_STOP_WORDS,
  "project", "projects", "team", "teams", "discussion", "discussed", "summary", "meeting",
  "meetings", "review", "update", "updates", "status", "context", "notes", "action",
  "items", "agenda", "next", "step", "steps", "work", "working", "process", "plan",
  "planning", "time", "date", "month", "week", "today", "yesterday", "tomorrow",
  "support", "followup", "follow", "client", "internal", "external"
]);

function parseCsv(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeListLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ensureKanbanPriorityColumns(userId = TODO_USER_ID) {
  const existingLists = listTodoListsRecord({ userId });
  const byNormalizedName = new Map(
    existingLists.map(item => [normalizeListLabel(item.name), item])
  );
  const columns = {};

  for (const spec of KANBAN_PRIORITY_COLUMNS) {
    const key = normalizeListLabel(spec.name);
    let column = byNormalizedName.get(key) || null;

    if (!column && spec.key === "backlog") {
      const inboxColumn = existingLists.find(item => String(item.id || "") === "inbox");
      if (inboxColumn) {
        column = updateTodoListRecord({
          id: inboxColumn.id,
          name: spec.name,
          sortOrder: spec.sortOrder,
          color: String(inboxColumn.color || "").trim() || spec.color,
          userId
        });
      }
    }

    if (!column) {
      column = createTodoListRecord({
        name: spec.name,
        color: spec.color,
        icon: "",
        sortOrder: spec.sortOrder,
        userId
      });
      byNormalizedName.set(key, column);
    } else {
      const desiredColor = String(column.color || "").trim() ? column.color : spec.color;
      const needsSortOrder = Number(column.sortOrder || 0) !== spec.sortOrder;
      const needsColor = String(column.color || "").trim() !== desiredColor;
      if (needsSortOrder || needsColor) {
        column = updateTodoListRecord({
          id: column.id,
          sortOrder: spec.sortOrder,
          color: desiredColor,
          userId
        });
      }
    }
    columns[spec.key] = column;
  }

  return columns;
}

function includesAnyKeyword(text, keywords = []) {
  return keywords.some(keyword => text.includes(keyword));
}

function normalizeTodoTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const normalized = [];
  for (const rawTag of tags) {
    const tag = String(rawTag || "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function hasTodoTag(todo, tagValue) {
  const needle = String(tagValue || "").trim().toLowerCase();
  if (!needle) return false;
  const tags = Array.isArray(todo?.tags) ? todo.tags : [];
  return tags.some(tag => String(tag || "").trim().toLowerCase() === needle);
}

function priorityFromColumnKey(columnKey, fallback = "medium") {
  if (columnKey === "priority_high") return "high";
  if (columnKey === "priority_medium") return "medium";
  if (columnKey === "priority_low") return "low";
  if (columnKey === "backlog") return "low";
  const normalized = String(fallback || "").trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "medium";
}

function withPriorityTag(tags, priority) {
  const cleaned = normalizeTodoTags(tags).filter(tag => !String(tag).toLowerCase().startsWith(PRIORITY_TAG_PREFIX));
  const normalizedPriority = String(priority || "").trim().toLowerCase();
  if (normalizedPriority === "high" || normalizedPriority === "medium" || normalizedPriority === "low") {
    cleaned.push(`${PRIORITY_TAG_PREFIX}${normalizedPriority}`);
  }
  return normalizeTodoTags(cleaned);
}

function sameTagSet(a, b) {
  const aNorm = normalizeTodoTags(a).map(tag => tag.toLowerCase()).sort();
  const bNorm = normalizeTodoTags(b).map(tag => tag.toLowerCase()).sort();
  if (aNorm.length !== bNorm.length) return false;
  for (let i = 0; i < aNorm.length; i += 1) {
    if (aNorm[i] !== bNorm[i]) return false;
  }
  return true;
}

function mergeContextBriefIntoNotes(notes, brief, next = "") {
  const cleaned = String(notes || "")
    .replace(/(?:^|\n)Context Brief:[^\n]*(?:\nContext Next:[^\n]*)?(?=\n|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!brief) return cleaned;
  const lines = [`Context Brief: ${brief}`];
  if (next) lines.push(`Context Next: ${next}`);
  const block = lines.join("\n");
  return cleaned ? `${cleaned}\n\n${block}` : block;
}

function shortenLine(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function isLikelyFirefliesImportedTodo(todo) {
  const tags = Array.isArray(todo?.tags) ? todo.tags : [];
  const normalized = new Set(tags.map(tag => String(tag || "").trim().toLowerCase()));
  return normalized.has("fireflies") || normalized.has("meeting-action-item");
}

function guessKanbanColumnKey(todo) {
  if (String(todo?.status || "open").toLowerCase() === "done") return "done";

  const priority = String(todo?.priority || "").trim().toLowerCase();
  const dueTime = todo?.due ? new Date(todo.due).getTime() : NaN;
  const occurredRaw = parseTodoDetailField(todo?.details, "Occurred");
  const occurredTime = occurredRaw ? new Date(occurredRaw).getTime() : NaN;
  const now = Date.now();
  const tags = Array.isArray(todo?.tags) ? todo.tags.map(tag => String(tag || "").toLowerCase()) : [];
  const hasOwnerTag = tags.some(tag => tag.startsWith("owner:"));
  const hasOwnerJeff = tags.some(tag => tag === "owner:jeff" || tag === "owner:jeffrey" || tag === "owner:jeff-barnes");
  const combinedText = [
    todo?.title || "",
    todo?.details || "",
    todo?.notes || "",
    ...tags
  ].join(" ").toLowerCase();

  let highScore = 0;
  let mediumScore = 0;
  let lowScore = 0;
  let backlogScore = 0;

  if (priority === "high") highScore += 16;
  else if (priority === "medium") mediumScore += 7;
  else if (priority === "low") lowScore += 10;

  if (Number.isFinite(dueTime)) {
    const daysUntilDue = (dueTime - now) / 86400000;
    if (daysUntilDue < 0) {
      highScore += 22;
    } else if (daysUntilDue <= 1) {
      highScore += 18;
    } else if (daysUntilDue <= 3) {
      highScore += 13;
    } else if (daysUntilDue <= 7) {
      mediumScore += 10;
    } else if (daysUntilDue <= 14) {
      mediumScore += 7;
    } else if (daysUntilDue <= 30) {
      mediumScore += 4;
    } else {
      lowScore += 4;
    }
  } else {
    backlogScore += 2;
  }

  const highKeywordHits = PRIORITY_KEYWORDS.high.filter(keyword => combinedText.includes(keyword)).length;
  const mediumKeywordHits = PRIORITY_KEYWORDS.medium.filter(keyword => combinedText.includes(keyword)).length;
  const lowKeywordHits = PRIORITY_KEYWORDS.low.filter(keyword => combinedText.includes(keyword)).length;

  highScore += highKeywordHits * 6;
  mediumScore += mediumKeywordHits * 3;
  lowScore += lowKeywordHits * 5;

  if (Number.isFinite(occurredTime)) {
    const daysSinceMeeting = (now - occurredTime) / 86400000;
    if (daysSinceMeeting <= 7) {
      highScore += 3;
      mediumScore += 2;
    } else if (daysSinceMeeting <= 21) {
      mediumScore += 2;
    } else if (daysSinceMeeting >= 60 && !Number.isFinite(dueTime)) {
      lowScore += 4;
      backlogScore += 5;
    }
  }

  if (hasOwnerTag) {
    mediumScore += 5;
    highScore += 4;
  }
  if (hasOwnerJeff) {
    highScore += 6;
  }

  if (
    combinedText.includes("waiting on") ||
    combinedText.includes("blocked by") ||
    combinedText.includes("at risk") ||
    combinedText.includes("risk")
  ) {
    highScore += 6;
  }

  if (
    combinedText.includes("backlog") ||
    combinedText.includes("to be processed") ||
    combinedText.includes("parking lot")
  ) {
    backlogScore += 8;
    lowScore += 3;
  }

  const maxScore = Math.max(highScore, mediumScore, lowScore, backlogScore);
  if (maxScore < 7) return "backlog";
  if (backlogScore >= highScore && backlogScore >= mediumScore && backlogScore >= lowScore && backlogScore >= 9) {
    return "backlog";
  }
  if (highScore >= mediumScore && highScore >= lowScore && highScore >= 11) return "priority_high";
  if (lowScore >= highScore && lowScore >= mediumScore && lowScore >= 10) return "priority_low";
  if (mediumScore >= 8) return "priority_medium";

  if (priority === "medium" && !isLikelyFirefliesImportedTodo(todo) && mediumScore >= highScore) {
    return "priority_medium";
  }

  return "backlog";
}

function normalizeKanbanListId(value, fallbackListId = BACKLOG_LIST_FALLBACK_ID) {
  const normalized = String(value || "").trim();
  return normalized || fallbackListId;
}

function laneSortComparator(a, b) {
  const aOrder = Number(a?.sortOrder || 0);
  const bOrder = Number(b?.sortOrder || 0);
  if (aOrder !== bOrder) return bOrder - aOrder;
  return new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime();
}

function getMicrosoftOAuthConfigStatus() {
  const clientId = String(process.env.MICROSOFT_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.MICROSOFT_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.MICROSOFT_REDIRECT_URI || "").trim();
  const redirectUris = parseCsv(process.env.MICROSOFT_REDIRECT_URIS || "");
  const hasRedirect = Boolean(redirectUri) || redirectUris.length > 0;
  const missing = [];
  if (!clientId) missing.push("MICROSOFT_CLIENT_ID");
  if (!clientSecret) missing.push("MICROSOFT_CLIENT_SECRET");
  if (!hasRedirect) missing.push("MICROSOFT_REDIRECT_URI (or MICROSOFT_REDIRECT_URIS)");
  return {
    oauthConfigured: missing.length === 0,
    missing
  };
}

function toIsoOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function toGraphDateTime(isoValue) {
  const parsed = toIsoOrNull(isoValue);
  if (!parsed) return null;
  return {
    dateTime: parsed.replace("Z", ""),
    timeZone: "UTC"
  };
}

function normalizeTitleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapPriorityToMicrosoftImportance(priority) {
  const normalized = String(priority || "").trim().toLowerCase();
  if (normalized === "high" || normalized === "urgent" || normalized === "critical") return "high";
  if (normalized === "low") return "low";
  return "normal";
}

function mapMicrosoftImportanceToPriority(importance) {
  const normalized = String(importance || "").trim().toLowerCase();
  if (["high", "urgent", "critical", "p1"].includes(normalized)) return "high";
  if (["low", "minor", "p3", "p4"].includes(normalized)) return "low";
  return "medium";
}

function parseBooleanLike(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "y", "done", "completed", "checked"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "open", "notstarted", "not_started", "unchecked"].includes(normalized)) return false;
  return null;
}

function mapMicrosoftStatusToLocal(status, completedFlag = null, completedAt = null) {
  if (completedFlag === true) return "done";
  const normalized = String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "");
  if (["completed", "done", "closed", "resolved", "checked"].includes(normalized)) return "done";
  if (completedAt) return "done";
  return "open";
}

function toIsoFromMicrosoftDate(value) {
  if (!value) return null;
  if (typeof value === "string" || value instanceof Date) {
    return toIsoOrNull(value);
  }
  if (typeof value !== "object") return null;
  const rawDateTime = String(value.dateTime || value.datetime || value.date || "").trim();
  if (!rawDateTime) return null;
  const timeZone = String(value.timeZone || value.timezone || "").trim();
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(rawDateTime)) {
    return toIsoOrNull(rawDateTime);
  }
  if (!timeZone || timeZone.toLowerCase() === "utc") {
    return toIsoOrNull(`${rawDateTime}Z`);
  }
  return toIsoOrNull(rawDateTime) || toIsoOrNull(`${rawDateTime}Z`);
}

function normalizeMicrosoftItemKind(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!normalized) return "";
  if (
    normalized.includes("checklist")
    || normalized === "todo-item"
    || normalized === "todoitem"
    || normalized === "todo"
  ) {
    return "todo-item";
  }
  if (normalized.includes("task")) return "task";
  return "";
}

function slugifyMicrosoftTagValue(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function splitDelimitedTags(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || "").trim()).filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.values(value)
      .map(item => String(item || "").trim())
      .filter(Boolean);
  }
  if (!value) return [];
  return String(value)
    .split(/[,\n;|]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseChecklistSteps(value) {
  if (Array.isArray(value)) {
    return value
      .map((step) => {
        const title = String(step?.title || step?.displayName || step?.text || "").trim();
        if (!title) return null;
        const doneRaw = step?.done ?? step?.isChecked ?? step?.checked ?? step?.completed;
        const done = parseBooleanLike(doneRaw) === true;
        return { title, done };
      })
      .filter(Boolean);
  }
  if (!value) return [];
  const lines = String(value)
    .split(/\r?\n|;/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const done = /^\[(x|X)\]/.test(line) || /^\s*(x|X)\s*[:-]/.test(line);
    const title = line.replace(/^\[(x|X|\s)\]\s*/, "").replace(/^\s*(x|X)\s*[:-]\s*/, "").trim();
    return {
      title: title || line,
      done
    };
  });
}

function detectCsvDelimiter(firstLine) {
  const line = String(firstLine || "");
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;
  for (const delimiter of candidates) {
    const count = line.split(delimiter).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  return best;
}

function parseDelimitedRows(rawText, delimiter = ",") {
  const text = String(rawText || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  row.push(field);
  if (row.some(cell => String(cell || "").trim()) || !rows.length) {
    rows.push(row);
  }

  return rows;
}

function parseCsvObjectRows(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = detectCsvDelimiter(firstLine);
  const rows = parseDelimitedRows(text, delimiter);
  if (!rows.length) return [];
  const normalizeHeader = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const headers = rows[0].map((value, idx) => normalizeHeader(value) || `col_${idx + 1}`);
  const dataRows = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cols = rows[r];
    if (!cols || !cols.length) continue;
    const item = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c += 1) {
      const cell = String(cols[c] || "").trim();
      if (cell) hasValue = true;
      item[headers[c]] = cell;
    }
    if (hasValue) dataRows.push(item);
  }
  return dataRows;
}

function firstDefinedField(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  const lowerValueByKey = new Map();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key || lowerValueByKey.has(key)) continue;
    lowerValueByKey.set(key, rawValue);
  }
  for (const key of keys) {
    const directHit = Object.prototype.hasOwnProperty.call(source, key);
    const value = directHit ? source[key] : lowerValueByKey.get(String(key || "").trim().toLowerCase());
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    return value;
  }
  return null;
}

function stringField(source, keys = []) {
  const value = firstDefinedField(source, keys);
  return value === null || value === undefined ? "" : String(value).trim();
}

function arrayField(source, keys = []) {
  const value = firstDefinedField(source, keys);
  return splitDelimitedTags(value);
}

function looksLikeMicrosoftTaskRecord(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const title = stringField(candidate, ["title", "subject", "task_title", "tasktitle", "name", "todo", "displayName"]);
  const hasTaskSignals = [
    "status",
    "importance",
    "categories",
    "dueDateTime",
    "due",
    "body",
    "notes",
    "checklistItems",
    "steps",
    "subtasks",
    "createdDateTime",
    "lastModifiedDateTime",
    "completedDateTime",
    "parentTaskId",
    "isChecklistItem",
    "kind",
    "type"
  ].some(key => candidate[key] !== undefined && candidate[key] !== null);
  if (title && hasTaskSignals) return true;
  return Boolean(stringField(candidate, ["displayName"])) && candidate.isChecked !== undefined;
}

function collectMicrosoftTaskRecords(payload) {
  const collected = [];
  const visit = (node, context = {}) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, context);
      return;
    }
    if (typeof node !== "object") return;

    const defaultListName = stringField(node, ["listName", "list_name", "list"]);
    const nextContext = {
      listName: context.listName || defaultListName || "",
      listId: context.listId || stringField(node, ["listId", "list_id"]) || ""
    };

    if (Array.isArray(node.lists)) {
      for (const list of node.lists) {
        const listContext = {
          listName: stringField(list, ["displayName", "name", "listName", "wellknownListName"]) || nextContext.listName,
          listId: stringField(list, ["id", "listId", "list_id"]) || nextContext.listId
        };
        const listChildren = [list.tasks, list.items, list.todos, list.todoItems, list.value, list.Value];
        let handled = false;
        for (const child of listChildren) {
          if (Array.isArray(child)) {
            handled = true;
            visit(child, listContext);
          }
        }
        if (!handled) visit(list, listContext);
      }
    }

    const childKeys = ["tasks", "items", "todos", "todoItems", "value", "Value", "results", "children"];
    let traversedChildren = false;
    for (const key of childKeys) {
      if (!Array.isArray(node[key])) continue;
      traversedChildren = true;
      for (const child of node[key]) {
        const childListName = stringField(child, ["listName", "list_name", "list", "displayName", "name", "wellknownListName"]);
        const childContext = {
          listName: childListName || nextContext.listName,
          listId: stringField(child, ["listId", "list_id"]) || nextContext.listId
        };
        visit(child, childContext);
      }
    }

    if (looksLikeMicrosoftTaskRecord(node)) {
      collected.push({ raw: node, context: nextContext });
    } else if (!traversedChildren && node.task && typeof node.task === "object") {
      visit(node.task, nextContext);
    }
  };

  visit(payload, {});
  return collected;
}

function isMicrosoftTodoHostUrl(url) {
  const raw = String(url || "");
  return /to-do\.office\.com|graph\.microsoft\.com|outlook\.office365\.com|outlook\.office\.com|substrate\.office\.com/i.test(raw);
}

function isLikelyMicrosoftTodoApiUrl(url) {
  const raw = String(url || "").toLowerCase();
  if (/substrate\.office\.com\/todob2\/api\/v1\//.test(raw)) return true;
  if (/to-do\.office\.com\/tasks\/api\/v[0-9.]+\//.test(raw)) return true;
  if (/outlook\.office(365)?\.com\/tasks\/api\/v[0-9.]+\//.test(raw)) return true;
  if (/graph\.microsoft\.com\/(v1\.0|beta)\/(me|users\/[^/]+)\/todo\//.test(raw)) return true;
  return false;
}

function tryParseJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function decodeHarResponseText(content) {
  if (!content || typeof content !== "object") return "";
  const text = String(content.text || "");
  if (!text) return "";
  const encoding = String(content.encoding || "").trim().toLowerCase();
  if (encoding === "base64") {
    try {
      return Buffer.from(text, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return text;
}

function inferListIdFromTasksUrl(url) {
  const raw = String(url || "");
  const match = raw.match(/\/lists\/([^/?#]+)\/tasks(?:[/?#]|$)/i);
  if (!match || !match[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function collectListNameById(payload, seed = new Map()) {
  const map = seed instanceof Map ? seed : new Map();
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const id = stringField(node, ["id", "listId", "list_id"]);
    const name = stringField(node, ["displayName", "name", "title", "listName", "wellknownListName"]);
    const hasTaskSignals = Boolean(
      firstDefinedField(node, ["status", "importance", "dueDateTime", "checklistItems", "isChecklistItem", "completedDateTime"])
    );
    if (id && name && !hasTaskSignals && !map.has(id)) {
      map.set(id, name);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(payload);
  return map;
}

function collectMicrosoftTaskRecordsFromHar(payload, { withStats = false } = {}) {
  const entries = Array.isArray(payload?.log?.entries) ? payload.log.entries : [];
  const stats = {
    entryCount: entries.length,
    matchingHostCount: 0,
    todoApiCount: 0,
    successStatusCount: 0,
    responseBodyCount: 0,
    jsonCandidateCount: 0,
    parsedJsonCount: 0,
    taskRecordCount: 0
  };
  if (!entries.length) {
    if (withStats) return { records: [], stats };
    return [];
  }

  const parsedEntries = [];
  let listNameById = new Map();

  for (const entry of entries) {
    const url = String(entry?.request?.url || "");
    const status = Number(entry?.response?.status || 0);
    if (!isMicrosoftTodoHostUrl(url)) continue;
    stats.matchingHostCount += 1;
    if (!isLikelyMicrosoftTodoApiUrl(url)) continue;
    stats.todoApiCount += 1;
    if (status < 200 || status >= 300) continue;
    stats.successStatusCount += 1;

    const content = entry?.response?.content || {};
    const mimeType = String(content?.mimeType || "").toLowerCase();
    const responseText = decodeHarResponseText(content);
    if (!responseText) continue;
    stats.responseBodyCount += 1;
    if (mimeType.includes("json") || /^\s*[\[{]/.test(responseText)) {
      stats.jsonCandidateCount += 1;
    }
    const parsed = tryParseJsonText(responseText);
    if (!parsed) continue;
    stats.parsedJsonCount += 1;

    if (
      !mimeType.includes("json")
      && !/^\s*[\[{]/.test(responseText)
    ) {
      continue;
    }

    parsedEntries.push({ url, parsed });
    listNameById = collectListNameById(parsed, listNameById);
  }

  const collected = [];
  for (const entry of parsedEntries) {
    const inferredListId = inferListIdFromTasksUrl(entry.url);
    const inferredListName = inferredListId ? String(listNameById.get(inferredListId) || "").trim() : "";
    const items = collectMicrosoftTaskRecords(entry.parsed);
    for (const item of items) {
      const context = item?.context && typeof item.context === "object" ? item.context : {};
      collected.push({
        raw: item.raw,
        context: {
          listId: String(context.listId || inferredListId || "").trim(),
          listName: String(context.listName || inferredListName || "").trim()
        }
      });
    }
  }
  stats.taskRecordCount = collected.length;
  if (withStats) return { records: collected, stats };
  return collected;
}

function normalizeMicrosoftImportRecord(entry, index = 0) {
  const raw = entry?.raw && typeof entry.raw === "object" ? entry.raw : {};
  const context = entry?.context && typeof entry.context === "object" ? entry.context : {};
  const title = stringField(raw, ["title", "subject", "task_title", "tasktitle", "name", "todo", "displayName"]);
  if (!title) return null;

  const sourceIdRaw = stringField(raw, ["id", "task_id", "taskid", "todo_id", "todoid", "source_id", "ms_id"]);
  const sourceId = sourceIdRaw.replace(/\s+/g, " ").trim();

  const listName = stringField(raw, ["list_name", "listname", "list", "column", "bucket"]) || context.listName || "MS Imported";
  const listSlug = slugifyMicrosoftTagValue(listName, "ms-imported");

  const explicitKind = normalizeMicrosoftItemKind(stringField(raw, ["kind", "type", "item_type", "itemtype"]));
  const checklistFlag = parseBooleanLike(firstDefinedField(raw, ["isChecklistItem", "is_checklist_item"])) === true;
  const parentTaskId = stringField(raw, ["parentTaskId", "parent_task_id", "parent_id"]);
  const inferredKind = checklistFlag || parentTaskId
    ? "todo-item"
    : (firstDefinedField(raw, ["isChecked", "is_checked"]) !== null && !stringField(raw, ["status"]) ? "todo-item" : "task");
  const kind = explicitKind || inferredKind;

  const due = toIsoFromMicrosoftDate(firstDefinedField(raw, ["dueDateTime", "due_datetime", "due_date_time", "due", "due_date"]));
  const reminderAt = toIsoFromMicrosoftDate(firstDefinedField(raw, ["reminderDateTime", "reminder_datetime", "reminder", "reminder_at"]));
  const createdAt = toIsoFromMicrosoftDate(firstDefinedField(raw, ["createdDateTime", "created_datetime", "created_at", "created", "created_date"]));
  const updatedAt = toIsoFromMicrosoftDate(firstDefinedField(raw, ["lastModifiedDateTime", "updated_at", "updated", "last_modified"]));
  const completedAt = toIsoFromMicrosoftDate(firstDefinedField(raw, ["completedDateTime", "completed_at", "completionDateTime", "completed"]));
  const completedFlag = parseBooleanLike(firstDefinedField(raw, ["completed", "isCompleted", "is_completed", "done", "isDone", "is_done"]));
  const localStatus = mapMicrosoftStatusToLocal(stringField(raw, ["status", "state"]), completedFlag, completedAt);
  const priority = mapMicrosoftImportanceToPriority(stringField(raw, ["importance", "priority"]));

  const categories = arrayField(raw, ["categories", "tags", "labels", "category"]);
  const notesText = stringField(raw, ["notes", "note", "body_content", "body", "description", "details"]);
  const body = firstDefinedField(raw, ["body"]);
  const bodyContent = body && typeof body === "object"
    ? stringField(body, ["content"])
    : "";
  const combinedNotes = [notesText, bodyContent].filter(Boolean).join("\n\n").trim();

  const checklistItems = firstDefinedField(raw, ["checklistItems", "checklist_items", "subtasks", "steps"]);
  const steps = parseChecklistSteps(checklistItems);
  const webUrl = stringField(raw, ["webUrl", "web_url", "url", "link"]);

  const tags = normalizeTodoTags([
    MS_TODO_SOURCE_TAG,
    `${MS_TODO_KIND_TAG_PREFIX}${kind}`,
    `${MS_TODO_LIST_TAG_PREFIX}${listSlug}`,
    sourceId ? `${MS_TODO_ID_TAG_PREFIX}${sourceId}` : "",
    ...categories
  ]);

  const detailsLines = [
    "Source: Microsoft To Do (local import)",
    `MS List: ${listName}`,
    `MS Kind: ${kind}`,
    sourceId ? `MS ID: ${sourceId}` : "",
    webUrl ? `MS URL: ${webUrl}` : "",
    createdAt ? `Created: ${createdAt}` : "",
    updatedAt ? `Updated: ${updatedAt}` : ""
  ].filter(Boolean);

  const sortBase = new Date(updatedAt || createdAt || due || Date.now()).getTime();
  const sortOrder = Number.isFinite(sortBase) ? (sortBase - index) : (Date.now() - index);

  return {
    title,
    listName,
    kind,
    sourceId,
    status: localStatus,
    priority,
    due,
    reminderAt,
    createdAt,
    updatedAt,
    completedAt,
    notes: combinedNotes,
    details: detailsLines.join("\n"),
    tags,
    steps,
    sortOrder
  };
}

function parseMicrosoftTodoImportPayload(rawText, formatHint = "") {
  const text = String(rawText || "").trim();
  if (!text) {
    const err = new Error("import_payload_empty");
    err.status = 400;
    throw err;
  }

  const lowerHint = String(formatHint || "").trim().toLowerCase();
  const looksJson = lowerHint === "json" || text.startsWith("{") || text.startsWith("[");
  const diagnostics = {
    inputHint: lowerHint || "auto",
    treatedAs: looksJson ? "json" : "csv",
    jsonTaskRecords: 0,
    csvRows: 0,
    har: {
      detected: false,
      entryCount: 0,
      matchingHostCount: 0,
      todoApiCount: 0,
      successStatusCount: 0,
      responseBodyCount: 0,
      jsonCandidateCount: 0,
      parsedJsonCount: 0,
      taskRecordCount: 0
    }
  };

  let records = [];
  let jsonParsed = false;
  if (looksJson) {
    try {
      const parsed = JSON.parse(text);
      jsonParsed = true;
      const isHar = Array.isArray(parsed?.log?.entries);
      diagnostics.har.detected = isHar;
      let entries = [];
      if (isHar) {
        const harResult = collectMicrosoftTaskRecordsFromHar(parsed, { withStats: true });
        entries = Array.isArray(harResult?.records) ? harResult.records : [];
        diagnostics.har = {
          detected: true,
          entryCount: Number(harResult?.stats?.entryCount || 0),
          matchingHostCount: Number(harResult?.stats?.matchingHostCount || 0),
          todoApiCount: Number(harResult?.stats?.todoApiCount || 0),
          successStatusCount: Number(harResult?.stats?.successStatusCount || 0),
          responseBodyCount: Number(harResult?.stats?.responseBodyCount || 0),
          jsonCandidateCount: Number(harResult?.stats?.jsonCandidateCount || 0),
          parsedJsonCount: Number(harResult?.stats?.parsedJsonCount || 0),
          taskRecordCount: Number(harResult?.stats?.taskRecordCount || 0)
        };
      } else {
        entries = collectMicrosoftTaskRecords(parsed);
      }
      records = entries
        .map((entry, idx) => normalizeMicrosoftImportRecord(entry, idx))
        .filter(Boolean);
      diagnostics.jsonTaskRecords = records.length;
    } catch (err) {
      if (lowerHint === "json") {
        const parseErr = new Error(`invalid_json_import: ${err?.message || err}`);
        parseErr.status = 400;
        throw parseErr;
      }
    }
  }

  if (!records.length && (!looksJson || !jsonParsed)) {
    const csvRows = parseCsvObjectRows(text);
    diagnostics.csvRows = csvRows.length;
    records = csvRows
      .map((row, idx) => normalizeMicrosoftImportRecord({ raw: row, context: {} }, idx))
      .filter(Boolean);
  }

  const seen = new Set();
  const deduped = [];
  for (const record of records) {
    const sourceIdKey = record.sourceId ? record.sourceId.toLowerCase() : "";
    const dedupeKey = sourceIdKey
      ? `id:${sourceIdKey}`
      : `title:${normalizeTitleKey(record.title)}|kind:${record.kind}|list:${slugifyMicrosoftTagValue(record.listName)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(record);
  }
  return {
    records: deduped,
    diagnostics
  };
}

function normalizeImportFieldKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeNotionPriority(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "medium";
  if (["high", "urgent", "critical", "asap", "p0", "p1", "blocker"].some(token => raw.includes(token))) return "high";
  if (["low", "minor", "someday", "later", "p3", "p4"].some(token => raw.includes(token))) return "low";
  return "medium";
}

function toIsoFromNotionDate(value) {
  if (!value) return null;
  if (typeof value === "string" || value instanceof Date) {
    return toIsoOrNull(value);
  }
  if (typeof value !== "object") return null;
  const start = String(value.start || value.date || value.dateTime || value.datetime || "").trim();
  const end = String(value.end || "").trim();
  return toIsoOrNull(start) || toIsoOrNull(end);
}

function extractNotionRichText(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(
        item?.plain_text
        || item?.text?.content
        || item?.name
        || item?.title
        || item?.content
        || ""
      ).trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (!value || typeof value !== "object") return String(value || "").trim();
  return String(
    value.plain_text
    || value.text?.content
    || value.name
    || value.title
    || value.content
    || ""
  ).trim();
}

function parseNotionPropertyValue(prop) {
  if (!prop || typeof prop !== "object") return "";
  const type = String(prop.type || "").trim();
  const typed = type ? prop[type] : null;
  const node = typed ?? prop;

  if (type === "title" || type === "rich_text") return extractNotionRichText(node);
  if (type === "select" || type === "status") return String(node?.name || "").trim();
  if (type === "multi_select") return Array.isArray(node) ? node.map(item => String(item?.name || "").trim()).filter(Boolean) : [];
  if (type === "people") return Array.isArray(node)
    ? node.map(item => String(item?.name || item?.person?.email || item?.id || "").trim()).filter(Boolean)
    : [];
  if (type === "date") return String(node?.start || node?.date || "").trim();
  if (type === "checkbox") return Boolean(node);
  if (type === "number") return Number.isFinite(Number(node)) ? Number(node) : "";
  if (type === "url" || type === "email" || type === "phone_number") return String(node || "").trim();
  if (type === "relation") return Array.isArray(node) ? node.map(item => String(item?.id || "").trim()).filter(Boolean) : [];
  if (type === "created_time" || type === "last_edited_time") return String(node || "").trim();
  if (type === "formula" && node && typeof node === "object") {
    if (node.type && node[node.type] !== undefined) return parseNotionPropertyValue({ type: node.type, [node.type]: node[node.type] });
    return "";
  }
  if (type === "rollup" && node && typeof node === "object") {
    if (node.type === "array" && Array.isArray(node.array)) {
      return node.array.map(item => extractNotionRichText(item)).filter(Boolean);
    }
    if (node.type === "number") return Number.isFinite(Number(node.number)) ? Number(node.number) : "";
    if (node.type === "date") return String(node.date?.start || "").trim();
    return "";
  }
  if (Array.isArray(node?.files)) {
    return node.files
      .map(file => String(file?.name || file?.external?.url || file?.file?.url || "").trim())
      .filter(Boolean);
  }
  return extractNotionRichText(node);
}

function parseNotionProperties(rawProperties) {
  if (!rawProperties || typeof rawProperties !== "object") return {};
  const mapped = {};
  for (const [name, prop] of Object.entries(rawProperties)) {
    const key = normalizeImportFieldKey(name);
    if (!key) continue;
    const value = parseNotionPropertyValue(prop);
    if (value === "" || value === null || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    mapped[key] = value;
  }
  return mapped;
}

function isNotionDoneStatus(statusValue = "") {
  const value = String(statusValue || "").trim().toLowerCase();
  if (!value) return false;
  return [
    "done",
    "complete",
    "completed",
    "closed",
    "resolved",
    "finished",
    "archive",
    "archived"
  ].some(token => value.includes(token));
}

function mapNotionStatusToLocal(statusValue = "", completedFlag = false, completedAt = null) {
  if (completedFlag) return "done";
  if (completedAt) return "done";
  if (isNotionDoneStatus(statusValue)) return "done";
  return "open";
}

function looksLikeNotionTaskRecord(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const properties = candidate.properties && typeof candidate.properties === "object" ? candidate.properties : null;
  if (properties) {
    const propertyKeys = Object.keys(properties).map(normalizeImportFieldKey).filter(Boolean);
    const hasTitleProperty = propertyKeys.some(key => ["name", "title", "task", "todo", "item", "action_item"].includes(key));
    const hasTaskSignalProperty = propertyKeys.some(key => [
      "status", "stage", "column", "bucket", "priority", "due", "deadline", "date",
      "assignee", "owner", "people", "tags", "labels", "done", "completed", "checkbox", "subtasks", "checklist"
    ].includes(key));
    if (hasTitleProperty || hasTaskSignalProperty) return true;
  }

  const title = stringField(candidate, ["title", "name", "task", "todo", "item", "action_item"]);
  if (!title) return false;
  return [
    "status",
    "stage",
    "column",
    "priority",
    "due",
    "deadline",
    "assignee",
    "owner",
    "tags",
    "labels",
    "done",
    "completed",
    "checkbox",
    "subtasks",
    "checklist"
  ].some(key => candidate[key] !== undefined && candidate[key] !== null);
}

function collectNotionTaskRecords(payload) {
  const collected = [];
  const visited = new WeakSet();

  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);

    if (looksLikeNotionTaskRecord(node)) {
      collected.push(node);
    }

    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      if (key === "properties") continue;
      visit(value);
    }
  };

  visit(payload);
  return collected;
}

function normalizeNotionImportRecord(entry, index = 0) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const props = parseNotionProperties(raw.properties);

  const title = stringField(raw, ["title", "name", "task", "todo", "item", "action_item"])
    || stringField(props, ["name", "title", "task", "todo", "item", "action_item", "action"]);
  if (!title) return null;

  const sourceId = stringField(raw, ["id", "notion_id", "source_id", "task_id", "page_id"]).replace(/\s+/g, " ").trim();
  const databaseId = stringField(raw, ["database_id"]) || stringField(raw?.parent || {}, ["database_id"]);
  const statusRaw = stringField(raw, ["status", "state"])
    || stringField(props, ["status", "state", "column", "stage", "bucket"]);
  const columnNameRaw = stringField(raw, ["column", "list", "stage", "bucket", "kanban_column", "status", "state"])
    || stringField(props, ["column", "list", "stage", "bucket", "kanban_column", "status", "state"]);
  const columnName = cleanupInlineText(columnNameRaw || NOTION_IMPORT_COLUMN_NAME).slice(0, 80) || NOTION_IMPORT_COLUMN_NAME;

  const completedFlag = parseBooleanLike(
    firstDefinedField(raw, ["done", "completed", "is_done", "is_completed", "checkbox"])
      ?? firstDefinedField(props, ["done", "completed", "checkbox"])
  ) === true;
  const completedAt = toIsoFromNotionDate(
    firstDefinedField(raw, ["completed_at", "completed_time", "closed_at"])
      ?? firstDefinedField(props, ["completed_at", "completed_time", "closed_at"])
  );
  const status = mapNotionStatusToLocal(statusRaw, completedFlag, completedAt);

  const priorityRaw = stringField(raw, ["priority", "importance"])
    || stringField(props, ["priority", "importance", "urgency"]);
  const priority = normalizeNotionPriority(priorityRaw);

  const due = toIsoFromNotionDate(
    firstDefinedField(raw, ["due", "due_date", "deadline", "date", "target_date"])
      ?? firstDefinedField(props, ["due", "due_date", "deadline", "date", "target_date"])
  );
  const reminderAt = toIsoFromNotionDate(
    firstDefinedField(raw, ["reminder", "reminder_at", "reminder_date"])
      ?? firstDefinedField(props, ["reminder", "reminder_at", "reminder_date"])
  );
  const createdAt = toIsoFromNotionDate(
    firstDefinedField(raw, ["created_time", "created_at", "created"])
      ?? firstDefinedField(props, ["created_time", "created_at", "created"])
  );
  const updatedAt = toIsoFromNotionDate(
    firstDefinedField(raw, ["last_edited_time", "updated_at", "updated", "last_modified"])
      ?? firstDefinedField(props, ["last_edited_time", "updated_at", "updated", "last_modified"])
  );

  const assignees = normalizeTodoTags([
    ...splitDelimitedTags(firstDefinedField(raw, ["assignee", "assignees", "owner", "owners", "people"])),
    ...splitDelimitedTags(firstDefinedField(props, ["assignee", "assignees", "owner", "owners", "people"]))
  ]);
  const categoryTags = normalizeTodoTags([
    ...splitDelimitedTags(firstDefinedField(raw, ["tags", "labels", "categories", "category"])),
    ...splitDelimitedTags(firstDefinedField(props, ["tags", "labels", "categories", "category"]))
  ]);
  const tags = normalizeTodoTags([
    NOTION_SOURCE_TAG,
    sourceId ? `${NOTION_ID_TAG_PREFIX}${sourceId}` : "",
    databaseId ? `${NOTION_DB_TAG_PREFIX}${databaseId}` : "",
    columnName ? `${NOTION_COLUMN_TAG_PREFIX}${slugifyMicrosoftTagValue(columnName, "notion")}` : "",
    ...assignees.map(value => `owner:${slugifyMicrosoftTagValue(value, "owner")}`),
    ...categoryTags
  ]);

  const notes = [
    stringField(raw, ["notes", "note", "description", "details", "summary", "body"]),
    stringField(props, ["notes", "note", "description", "details", "summary", "body"])
  ].filter(Boolean).join("\n\n").trim();

  const checklistRaw = firstDefinedField(raw, ["subtasks", "checklist", "steps"])
    ?? firstDefinedField(props, ["subtasks", "checklist", "steps"]);
  const steps = parseChecklistSteps(checklistRaw);

  const sourceUrl = stringField(raw, ["url", "public_url", "link"])
    || stringField(props, ["url", "link"]);
  const detailsLines = [
    "Source: Notion (local import)",
    databaseId ? `Notion DB: ${databaseId}` : "",
    columnName ? `Notion Column: ${columnName}` : "",
    statusRaw ? `Notion Status: ${statusRaw}` : "",
    sourceUrl ? `Notion URL: ${sourceUrl}` : "",
    createdAt ? `Created: ${createdAt}` : "",
    updatedAt ? `Updated: ${updatedAt}` : ""
  ].filter(Boolean);

  const sortBase = new Date(updatedAt || createdAt || due || Date.now()).getTime();
  const sortOrder = Number.isFinite(sortBase) ? (sortBase - index) : (Date.now() - index);

  return {
    title,
    sourceId,
    databaseId,
    columnName,
    status,
    priority,
    due,
    reminderAt,
    createdAt,
    updatedAt,
    completedAt,
    notes,
    details: detailsLines.join("\n"),
    tags,
    steps,
    sortOrder
  };
}

function parseNotionImportPayload(rawText, formatHint = "") {
  const text = String(rawText || "").trim();
  if (!text) {
    const err = new Error("import_payload_empty");
    err.status = 400;
    throw err;
  }

  const lowerHint = String(formatHint || "").trim().toLowerCase();
  const looksJson = lowerHint === "json" || text.startsWith("{") || text.startsWith("[");
  const diagnostics = {
    inputHint: lowerHint || "auto",
    treatedAs: looksJson ? "json" : "csv",
    jsonTaskRecords: 0,
    csvRows: 0
  };

  let records = [];
  let jsonParsed = false;

  if (looksJson) {
    try {
      const parsed = JSON.parse(text);
      jsonParsed = true;
      const entries = collectNotionTaskRecords(parsed);
      records = entries
        .map((entry, idx) => normalizeNotionImportRecord(entry, idx))
        .filter(Boolean);
      diagnostics.jsonTaskRecords = records.length;
    } catch (err) {
      if (lowerHint === "json") {
        const parseErr = new Error(`invalid_json_import: ${err?.message || err}`);
        parseErr.status = 400;
        throw parseErr;
      }
    }
  }

  if (!records.length && (!looksJson || !jsonParsed)) {
    const csvRows = parseCsvObjectRows(text);
    diagnostics.csvRows = csvRows.length;
    records = csvRows
      .map((row, idx) => normalizeNotionImportRecord(row, idx))
      .filter(Boolean);
  }

  const seen = new Set();
  const deduped = [];
  for (const record of records) {
    const sourceIdKey = String(record?.sourceId || "").trim().toLowerCase();
    const dedupeKey = sourceIdKey
      ? `id:${sourceIdKey}`
      : `title:${normalizeTitleKey(record?.title)}|column:${normalizeListLabel(record?.columnName || NOTION_IMPORT_COLUMN_NAME)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(record);
  }

  return {
    records: deduped,
    diagnostics
  };
}

function findTagValueByPrefix(tags, prefix) {
  if (!Array.isArray(tags)) return "";
  const needle = String(prefix || "").trim().toLowerCase();
  if (!needle) return "";
  for (const rawTag of tags) {
    const tag = String(rawTag || "").trim();
    if (!tag) continue;
    if (tag.toLowerCase().startsWith(needle)) {
      return tag.slice(prefix.length).trim();
    }
  }
  return "";
}

function ensureMicrosoftTodoImportColumn(userId = TODO_USER_ID) {
  const existingLists = listTodoListsRecord({ userId });
  const match = existingLists.find(item => normalizeListLabel(item?.name) === normalizeListLabel(MS_TODO_IMPORT_COLUMN_NAME));
  if (match) {
    if (!String(match.color || "").trim()) {
      return updateTodoListRecord({
        id: match.id,
        color: MS_TODO_IMPORT_COLUMN_COLOR,
        userId
      });
    }
    return match;
  }
  const nextSortOrder = existingLists.reduce(
    (max, item) => Math.max(max, Number(item?.sortOrder || 0)),
    0
  ) + 1;
  return createTodoListRecord({
    name: MS_TODO_IMPORT_COLUMN_NAME,
    color: MS_TODO_IMPORT_COLUMN_COLOR,
    icon: "",
    sortOrder: nextSortOrder,
    userId
  });
}

function getRequestOrigin(req) {
  const protoRaw = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(protoRaw) ? protoRaw[0] : protoRaw;
  const hostRaw = req.headers["x-forwarded-host"] || req.headers.host || req.get("host");
  const host = Array.isArray(hostRaw) ? hostRaw[0] : hostRaw;
  if (!host) return "";
  return `${proto || req.protocol || "http"}://${host}`;
}

function buildTodoTextBody(todo) {
  const lines = [];
  if (todo.details) lines.push(`Details:\n${todo.details}`);
  if (todo.notes) lines.push(`Notes:\n${todo.notes}`);
  if (todo.repeatRule) lines.push(`Repeat:\n${todo.repeatRule}`);
  if (Array.isArray(todo.steps) && todo.steps.length) {
    lines.push(`Subtasks:\n${todo.steps.map(step => `- [${step.done ? "x" : " "}] ${step.title || step.text || ""}`).join("\n")}`);
  }
  if (Array.isArray(todo.tags) && todo.tags.length) {
    lines.push(`Categories: ${todo.tags.join(", ")}`);
  }
  return lines.join("\n\n").trim();
}

function buildMicrosoftTodoPayload(todo) {
  const dueDateTime = toGraphDateTime(todo?.due);
  const reminderDateTime = toGraphDateTime(todo?.reminderAt);
  const payload = {
    title: String(todo?.title || "Untitled task").trim(),
    status: "notStarted",
    importance: mapPriorityToMicrosoftImportance(todo?.priority),
    categories: Array.isArray(todo?.tags) ? todo.tags.slice(0, 25) : []
  };
  const bodyText = buildTodoTextBody(todo);
  if (bodyText) {
    payload.body = {
      contentType: "text",
      content: bodyText
    };
  }
  if (dueDateTime) payload.dueDateTime = dueDateTime;
  if (reminderDateTime) {
    payload.reminderDateTime = reminderDateTime;
    payload.isReminderOn = true;
  }
  return payload;
}

function getMicrosoftTodoSyncState(userId = TODO_USER_ID) {
  const stored = getProvider("microsoft_todo_sync_map", userId) || {};
  return {
    version: 1,
    updatedAt: stored.updatedAt || "",
    items: stored.items && typeof stored.items === "object" ? stored.items : {}
  };
}

function saveMicrosoftTodoSyncState(state, userId = TODO_USER_ID) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: state?.items && typeof state.items === "object" ? state.items : {}
  };
  setProvider("microsoft_todo_sync_map", payload, userId);
  return payload;
}

async function microsoftGraphRequest(pathname, { method = "GET", token, body = null } = {}) {
  const response = await fetch(`${MICROSOFT_GRAPH_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(text || `microsoft_graph_failed_${response.status}`);
    err.status = response.status;
    throw err;
  }
  if (!text) return {};
  return JSON.parse(text);
}

async function listMicrosoftTodoListsFromGraph(userId = TODO_USER_ID) {
  const token = await getMicrosoftAccessToken([MICROSOFT_TODO_SCOPE], userId);
  const payload = await microsoftGraphRequest("/me/todo/lists?$top=100", { token });
  return Array.isArray(payload?.value) ? payload.value : [];
}

async function listMicrosoftTodoTasksFromGraph(listId, userId = TODO_USER_ID) {
  const token = await getMicrosoftAccessToken([MICROSOFT_TODO_READ_SCOPE], userId);
  const query = encodeURIComponent("id,title,status,importance,categories,dueDateTime,lastModifiedDateTime");
  const payload = await microsoftGraphRequest(`/me/todo/lists/${encodeURIComponent(listId)}/tasks?$top=200&$select=${query}`, { token });
  return Array.isArray(payload?.value) ? payload.value : [];
}

async function syncMicrosoftChecklistItems({ listId, taskId, steps = [], token }) {
  if (!Array.isArray(steps) || !steps.length) return { created: 0, updated: 0 };
  const existingPayload = await microsoftGraphRequest(
    `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems?$top=100`,
    { token }
  );
  const existingItems = Array.isArray(existingPayload?.value) ? existingPayload.value : [];
  const byName = new Map(existingItems.map(item => [normalizeTitleKey(item?.displayName), item]));
  let created = 0;
  let updated = 0;
  for (const step of steps) {
    const title = String(step?.title || step?.text || "").trim();
    if (!title) continue;
    const key = normalizeTitleKey(title);
    const match = byName.get(key);
    if (match?.id) {
      await microsoftGraphRequest(
        `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(match.id)}`,
        {
          method: "PATCH",
          token,
          body: { isChecked: Boolean(step?.done) }
        }
      );
      updated += 1;
      continue;
    }
    await microsoftGraphRequest(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems`,
      {
        method: "POST",
        token,
        body: {
          displayName: title,
          isChecked: Boolean(step?.done)
        }
      }
    );
    created += 1;
  }
  return { created, updated };
}

function cleanupInlineText(value) {
  return String(value || "")
    .replace(/\*\*/g, "")
    .replace(/^[\-\u2022*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyPersonOwner(value) {
  const text = cleanupInlineText(value);
  if (!text || text.length > 48) return false;
  if (/^(unassigned|none|n\/a|unknown)$/i.test(text)) return false;
  if (/[,:;!?/]/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  return words.every(word => /^[A-Z][A-Za-z.'-]*$/.test(word));
}

function normalizeTaskTitle({ owner, text }) {
  const ownerText = cleanupInlineText(owner);
  const taskText = cleanupInlineText(text);
  const ownerLooksPerson = isLikelyPersonOwner(ownerText);
  let merged = taskText;
  if (!merged && ownerText) merged = ownerText;
  else if (ownerText && !ownerLooksPerson) merged = `${ownerText} ${taskText}`.trim();
  return cleanupInlineText(merged);
}

function isNoisyTaskTitle(value) {
  const text = cleanupInlineText(value);
  if (!text) return true;
  if (text.length < 8) return true;
  if (/^(unassigned|none|n\/a|unknown)$/i.test(text)) return true;
  if (/^[A-Z][A-Za-z.'-]*(\s+[A-Z][A-Za-z.'-]*){0,2}$/.test(text)) return true;
  return false;
}

function extractFirefliesTasks(row) {
  const parsedTasks = (() => {
    try {
      const fromTasks = JSON.parse(String(row?.tasks_json || "[]"));
      if (Array.isArray(fromTasks) && fromTasks.length) return fromTasks;
    } catch {
      // Ignore malformed tasks_json and fallback to summary_json.
    }
    try {
      const summary = JSON.parse(String(row?.summary_json || "{}"));
      const fromSummary = summary?.actionItems || summary?.tasks || [];
      return Array.isArray(fromSummary) ? fromSummary : [];
    } catch {
      return [];
    }
  })();
  return parsedTasks
    .map(item => {
      const owner = String(item?.owner || "").trim();
      const rawText = String(item?.task || item?.title || item?.text || "").trim();
      const title = normalizeTaskTitle({ owner, text: rawText });
      return {
        title,
        owner: cleanupInlineText(owner),
        ownerIsPerson: isLikelyPersonOwner(owner),
        due: String(item?.due || "").trim(),
        notes: String(item?.notes || item?.detail || "").trim()
      };
    })
    .filter(item => item.title && !isNoisyTaskTitle(item.title));
}

function buildFirefliesTaskCandidates(limitMeetings = 200) {
  const status = getVectorStoreStatus();
  const dbPath = status?.dbPath || "";
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { candidates: [], scannedMeetings: 0 };
  }
  const ragDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = ragDb.prepare(`
      SELECT
        m.id AS meeting_id,
        m.title,
        m.occurred_at,
        m.source_url,
        ms.tasks_json,
        ms.summary_json
      FROM meetings m
      LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
      WHERE m.id NOT LIKE 'memory:%'
        AND m.id NOT LIKE 'feedback:%'
        AND m.id NOT LIKE 'recording:%'
        AND m.id NOT LIKE 'trading:%'
        AND m.id NOT LIKE 'signals:%'
        AND m.id NOT LIKE 'rag:%'
        AND (COALESCE(ms.tasks_json, '') != '' OR COALESCE(ms.summary_json, '') != '')
      ORDER BY m.occurred_at DESC
      LIMIT ?
    `).all(Math.max(1, limitMeetings));
    const candidates = [];
    for (const row of rows) {
      const tasks = extractFirefliesTasks(row);
      for (const task of tasks) {
        candidates.push({
          meetingId: row.meeting_id,
          meetingTitle: row.title || "Fireflies Meeting",
          occurredAt: row.occurred_at || "",
          sourceUrl: row.source_url || "",
          title: task.title,
          owner: task.owner,
          due: task.due,
          notes: task.notes
        });
      }
    }
    return { candidates, scannedMeetings: rows.length };
  } finally {
    ragDb.close();
  }
}

function normalizeMeetingActionId(meetingId, index, title) {
  const safeMeetingId = String(meetingId || "meeting").trim() || "meeting";
  const safeIndex = Number.isFinite(Number(index)) ? Number(index) : 0;
  const slug = normalizeTitleKey(title).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `item-${safeIndex + 1}`;
  return `${safeMeetingId}:${safeIndex}:${slug}`;
}

function buildMeetingReviewActionItems(row, summary) {
  const extracted = extractFirefliesTasks(row);
  const merged = [];
  const seenTitles = new Set();
  const titleDedupKey = (value) => normalizeTitleKey(value).replace(/\s*\(\d{1,2}:\d{2}\)\s*$/i, "").trim();

  const pushTask = (task, source = "tasks_json") => {
    const title = String(task?.title || "").trim();
    if (!title) return;
    if (isNoisyTaskTitle(title)) return;
    const key = titleDedupKey(title);
    if (!key || seenTitles.has(key)) return;
    seenTitles.add(key);
    merged.push({
      title,
      owner: String(task?.owner || "").trim(),
      ownerIsPerson: Boolean(task?.ownerIsPerson),
      due: String(task?.due || "").trim(),
      notes: String(task?.notes || "").trim(),
      source
    });
  };

  extracted.forEach(task => pushTask(task, "tasks_json"));
  const summaryActionItems = Array.isArray(summary?.actionItems) ? summary.actionItems : [];
  for (const item of summaryActionItems) {
    const line = actionItemToLine(item);
    const parsed = parseSummaryActionItemLine(line);
    if (!parsed.title) continue;
    pushTask({
      title: parsed.title,
      owner: parsed.owner,
      ownerIsPerson: parsed.owner ? isLikelyPersonOwner(parsed.owner) : false,
      due: "",
      notes: ""
    }, "summary_action_item");
  }

  return merged;
}

function listFirefliesMeetingsForReview(limitMeetings = 200) {
  const status = getVectorStoreStatus();
  const dbPath = status?.dbPath || "";
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const ragDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = ragDb.prepare(`
      SELECT
        m.id AS meeting_id,
        m.title,
        m.occurred_at,
        m.source_url,
        m.raw_transcript,
        ms.summary_json,
        ms.tasks_json
      FROM meetings m
      LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
      WHERE m.id NOT LIKE 'memory:%'
        AND m.id NOT LIKE 'feedback:%'
        AND m.id NOT LIKE 'recording:%'
        AND m.id NOT LIKE 'trading:%'
        AND m.id NOT LIKE 'signals:%'
        AND m.id NOT LIKE 'rag:%'
      ORDER BY m.occurred_at DESC
      LIMIT ?
    `).all(Math.max(1, limitMeetings));

    return rows.map((row) => {
      const summary = parseSummaryJson(row.summary_json);
      const actions = buildMeetingReviewActionItems(row, summary).map((action, index) => ({
        id: normalizeMeetingActionId(row.meeting_id, index, action.title),
        meetingId: row.meeting_id,
        meetingTitle: row.title || "Fireflies Meeting",
        occurredAt: row.occurred_at || "",
        sourceUrl: row.source_url || "",
        title: action.title,
        owner: action.owner || "",
        ownerIsPerson: Boolean(action.ownerIsPerson),
        due: action.due || "",
        notes: action.notes || "",
        source: action.source || "tasks_json"
      }));

      const transcriptRaw = String(row.raw_transcript || "").trim();
      const transcriptPreview = transcriptRaw
        ? shortenLine(transcriptRaw, 1200)
        : "";

      return {
        id: row.meeting_id,
        title: row.title || "Fireflies Meeting",
        occurredAt: row.occurred_at || "",
        sourceUrl: row.source_url || "",
        summary: {
          tldr: String(summary?.tldr || "").trim(),
          overview: Array.isArray(summary?.overview) ? summary.overview : [],
          decisions: Array.isArray(summary?.decisions) ? summary.decisions : [],
          actionItems: Array.isArray(summary?.actionItems) ? summary.actionItems : [],
          nextSteps: Array.isArray(summary?.nextSteps) ? summary.nextSteps : []
        },
        transcriptPreview,
        actions
      };
    });
  } finally {
    ragDb.close();
  }
}

function graphSlug(value, fallback = "item") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function graphLineValue(item) {
  if (!item) return "";
  if (typeof item === "string") return cleanupInlineText(item);
  if (typeof item !== "object") return "";
  const direct = String(item.text || item.title || item.task || item.action || "").trim();
  if (direct) return cleanupInlineText(direct);
  return cleanupInlineText(actionItemToLine(item));
}

function parseGraphParticipants(rawValue) {
  let parsed = [];
  try {
    parsed = JSON.parse(String(rawValue || "[]"));
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const values = [];
  for (const item of parsed) {
    const name = typeof item === "string"
      ? cleanupInlineText(item)
      : cleanupInlineText(item?.name || item?.displayName || item?.email || item?.user || "");
    if (!name || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(name);
  }
  return values;
}

function extractGraphTopics({ title = "", summary = {}, actions = [], maxTopics = 6 } = {}) {
  const overview = Array.isArray(summary?.overview) ? summary.overview : [];
  const decisions = Array.isArray(summary?.decisions) ? summary.decisions : [];
  const nextSteps = Array.isArray(summary?.nextSteps) ? summary.nextSteps : [];
  const actionTitles = Array.isArray(actions) ? actions.map(item => item?.title || "") : [];
  const corpus = [
    title,
    summary?.tldr || "",
    ...overview.map(item => graphLineValue(item)),
    ...decisions.map(item => graphLineValue(item)),
    ...nextSteps.map(item => graphLineValue(item)),
    ...actionTitles
  ].filter(Boolean).join(" ");

  const tokens = String(corpus || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4 && !GRAPH_TOPIC_STOP_WORDS.has(token));
  if (!tokens.length) return [];

  const unigramCounts = new Map();
  const bigramCounts = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const word = tokens[i];
    unigramCounts.set(word, (unigramCounts.get(word) || 0) + 1);
    if (i < tokens.length - 1) {
      const next = tokens[i + 1];
      if (!next) continue;
      const bigram = `${word} ${next}`;
      bigramCounts.set(bigram, (bigramCounts.get(bigram) || 0) + 1);
    }
  }

  const candidates = [];
  for (const [phrase, count] of bigramCounts.entries()) {
    if (count < 2) continue;
    candidates.push({ topic: phrase, score: count * 2.5 });
  }
  for (const [word, count] of unigramCounts.entries()) {
    candidates.push({ topic: word, score: count });
  }
  candidates.sort((a, b) => b.score - a.score || b.topic.length - a.topic.length);

  const picked = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const topic = cleanupInlineText(candidate.topic);
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(topic);
    if (picked.length >= Math.max(1, maxTopics)) break;
  }
  return picked;
}

function buildKnowledgeGraph({
  limitMeetings = 60,
  maxActionsPerMeeting = 5,
  maxTopicsPerMeeting = 4,
  maxMeetingLinks = 260
} = {}) {
  const status = getVectorStoreStatus();
  const dbPath = status?.dbPath || "";
  if (!dbPath || !fs.existsSync(dbPath)) {
    return {
      nodes: [],
      links: [],
      stats: {
        meetings: 0,
        nodes: 0,
        links: 0,
        byType: {}
      }
    };
  }

  const ragDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = ragDb.prepare(`
      SELECT
        m.id AS meeting_id,
        m.title,
        m.occurred_at,
        m.source_url,
        m.participants_json,
        ms.summary_json,
        ms.tasks_json
      FROM meetings m
      LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
      WHERE m.id NOT LIKE 'memory:%'
        AND m.id NOT LIKE 'feedback:%'
        AND m.id NOT LIKE 'recording:%'
        AND m.id NOT LIKE 'trading:%'
        AND m.id NOT LIKE 'signals:%'
        AND m.id NOT LIKE 'rag:%'
      ORDER BY m.occurred_at DESC
      LIMIT ?
    `).all(Math.max(20, limitMeetings));

    const nodeById = new Map();
    const linkById = new Map();
    const personToMeetingIds = new Map();
    const topicToMeetingIds = new Map();

    const baseNodeSize = (type) => {
      if (type === "meeting") return 9;
      if (type === "action") return 6.5;
      if (type === "person") return 7.5;
      if (type === "topic") return 6;
      return 6;
    };

    const addNode = (node) => {
      const id = String(node?.id || "").trim();
      if (!id) return null;
      const existing = nodeById.get(id);
      if (existing) {
        existing.weight = Math.max(Number(existing.weight || 0), Number(node.weight || 0));
        existing.meta = { ...existing.meta, ...(node.meta || {}) };
        return existing;
      }
      const created = {
        id,
        label: shortenLine(node?.label || id, 84),
        type: String(node?.type || "unknown"),
        size: Number(node?.size || baseNodeSize(node?.type)),
        weight: Number(node?.weight || 1),
        degree: 0,
        meta: node?.meta && typeof node.meta === "object" ? node.meta : {}
      };
      nodeById.set(id, created);
      return created;
    };

    const addLink = (sourceRaw, targetRaw, type, weight = 1, meta = {}, undirected = false) => {
      const source = String(sourceRaw || "").trim();
      const target = String(targetRaw || "").trim();
      if (!source || !target || source === target) return;
      const linkType = String(type || "related");
      const sourceId = undirected && source > target ? target : source;
      const targetId = undirected && source > target ? source : target;
      const linkId = undirected
        ? `${linkType}:${sourceId}<->${targetId}`
        : `${linkType}:${sourceId}->${targetId}`;
      const existing = linkById.get(linkId);
      if (existing) {
        existing.weight += Number(weight || 0);
        if (Array.isArray(meta?.reasons)) {
          const merged = new Set([...(existing.meta?.reasons || []), ...meta.reasons.map(String)]);
          existing.meta.reasons = Array.from(merged).slice(0, 8);
        }
        return;
      }
      linkById.set(linkId, {
        id: linkId,
        source: sourceId,
        target: targetId,
        type: linkType,
        weight: Math.max(1, Number(weight || 1)),
        meta: meta && typeof meta === "object" ? meta : {}
      });
    };

    for (const row of rows) {
      const meetingId = String(row.meeting_id || "").trim();
      if (!meetingId) continue;
      const meetingNodeId = `meeting:${meetingId}`;
      const meetingTitle = cleanupInlineText(row.title || "Fireflies Meeting");
      const summary = parseSummaryJson(row.summary_json);
      const participants = parseGraphParticipants(row.participants_json);
      const actions = buildMeetingReviewActionItems(row, summary).slice(0, Math.max(1, maxActionsPerMeeting));
      const topics = extractGraphTopics({
        title: meetingTitle,
        summary,
        actions,
        maxTopics: Math.max(1, maxTopicsPerMeeting)
      });

      addNode({
        id: meetingNodeId,
        label: meetingTitle || meetingId,
        type: "meeting",
        size: 9.5,
        weight: 5,
        meta: {
          meetingId,
          occurredAt: row.occurred_at || "",
          sourceUrl: row.source_url || "",
          summary: shortenLine(summary?.tldr || "", 320),
          participants: participants,
          actionCount: actions.length
        }
      });

      for (const participant of participants) {
        const personLabel = cleanupInlineText(participant);
        if (!personLabel) continue;
        const personNodeId = `person:${graphSlug(personLabel)}`;
        addNode({
          id: personNodeId,
          label: personLabel,
          type: "person",
          size: 7.5,
          weight: 2,
          meta: { name: personLabel }
        });
        addLink(meetingNodeId, personNodeId, "meeting_participant", 1, {
          relation: "Participant"
        });
        if (!personToMeetingIds.has(personNodeId)) personToMeetingIds.set(personNodeId, new Set());
        personToMeetingIds.get(personNodeId).add(meetingNodeId);
      }

      actions.forEach((action, index) => {
        const actionNodeId = `action:${normalizeMeetingActionId(meetingId, index, action.title)}`;
        addNode({
          id: actionNodeId,
          label: action.title || `Action ${index + 1}`,
          type: "action",
          size: 6.8,
          weight: 2,
          meta: {
            meetingId,
            meetingTitle,
            owner: action.owner || "",
            due: action.due || "",
            notes: shortenLine(action.notes || "", 280),
            source: action.source || "tasks_json"
          }
        });
        addLink(meetingNodeId, actionNodeId, "meeting_action", 2, {
          relation: "Has action item"
        });

        const ownerName = cleanupInlineText(action.owner || "");
        if (ownerName) {
          const ownerNodeId = `person:${graphSlug(ownerName)}`;
          addNode({
            id: ownerNodeId,
            label: ownerName,
            type: "person",
            size: 7.6,
            weight: 2,
            meta: { name: ownerName }
          });
          addLink(actionNodeId, ownerNodeId, "action_owner", 1.5, {
            relation: "Assigned to"
          });
          if (!personToMeetingIds.has(ownerNodeId)) personToMeetingIds.set(ownerNodeId, new Set());
          personToMeetingIds.get(ownerNodeId).add(meetingNodeId);
        }
      });

      for (const topic of topics) {
        const topicLabel = cleanupInlineText(topic);
        if (!topicLabel) continue;
        const topicNodeId = `topic:${graphSlug(topicLabel)}`;
        addNode({
          id: topicNodeId,
          label: topicLabel,
          type: "topic",
          size: 6.2,
          weight: 1.5,
          meta: { topic: topicLabel }
        });
        addLink(meetingNodeId, topicNodeId, "meeting_topic", 1, {
          relation: "Discusses topic"
        });
        if (!topicToMeetingIds.has(topicNodeId)) topicToMeetingIds.set(topicNodeId, new Set());
        topicToMeetingIds.get(topicNodeId).add(meetingNodeId);
      }
    }

    const relatedMeetingWeights = new Map();
    const collectMeetingRelation = (meetingA, meetingB, reason, weight = 1) => {
      if (!meetingA || !meetingB || meetingA === meetingB) return;
      const source = meetingA < meetingB ? meetingA : meetingB;
      const target = meetingA < meetingB ? meetingB : meetingA;
      const key = `${source}|${target}`;
      const current = relatedMeetingWeights.get(key) || {
        source,
        target,
        weight: 0,
        reasons: []
      };
      current.weight += weight;
      if (reason && !current.reasons.includes(reason) && current.reasons.length < 8) {
        current.reasons.push(reason);
      }
      relatedMeetingWeights.set(key, current);
    };

    for (const [personNodeId, meetingsSet] of personToMeetingIds.entries()) {
      const personLabel = nodeById.get(personNodeId)?.label || "person";
      const meetings = Array.from(meetingsSet).slice(0, 18);
      for (let i = 0; i < meetings.length; i += 1) {
        for (let j = i + 1; j < meetings.length; j += 1) {
          collectMeetingRelation(meetings[i], meetings[j], `Shared person: ${personLabel}`, 3);
        }
      }
    }
    for (const [topicNodeId, meetingsSet] of topicToMeetingIds.entries()) {
      const topicLabel = nodeById.get(topicNodeId)?.label || "topic";
      const meetings = Array.from(meetingsSet).slice(0, 18);
      for (let i = 0; i < meetings.length; i += 1) {
        for (let j = i + 1; j < meetings.length; j += 1) {
          collectMeetingRelation(meetings[i], meetings[j], `Shared topic: ${topicLabel}`, 1);
        }
      }
    }

    const relatedMeetingLinks = Array.from(relatedMeetingWeights.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.max(10, maxMeetingLinks));
    for (const rel of relatedMeetingLinks) {
      addLink(rel.source, rel.target, "related_meeting", rel.weight, {
        relation: "Related meetings",
        reasons: rel.reasons
      }, true);
    }

    for (const link of linkById.values()) {
      const sourceNode = nodeById.get(link.source);
      const targetNode = nodeById.get(link.target);
      if (sourceNode) sourceNode.degree += Number(link.weight || 1);
      if (targetNode) targetNode.degree += Number(link.weight || 1);
    }

    const nodes = Array.from(nodeById.values()).map((node) => ({
      ...node,
      size: Number((baseNodeSize(node.type) + Math.min(9, Math.sqrt(node.degree || 0) * 1.3)).toFixed(2))
    }));
    const links = Array.from(linkById.values());

    const byType = nodes.reduce((acc, node) => {
      const key = String(node.type || "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const linkByType = links.reduce((acc, link) => {
      const key = String(link.type || "related");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return {
      nodes,
      links,
      stats: {
        meetings: rows.length,
        nodes: nodes.length,
        links: links.length,
        byType,
        linkByType,
        generatedAt: new Date().toISOString()
      }
    };
  } finally {
    ragDb.close();
  }
}

function parseTodoDetailField(details, label) {
  const lines = String(details || "").split(/\r?\n/);
  const needle = `${label.toLowerCase()}:`;
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line.toLowerCase().startsWith(needle)) continue;
    return line.slice(needle.length).trim();
  }
  return "";
}

function extractMeetingReferenceFromTodo(todo) {
  const tags = Array.isArray(todo?.tags) ? todo.tags : [];
  let meetingId = "";
  for (const tag of tags) {
    const value = String(tag || "").trim();
    if (!value) continue;
    const match = value.match(/^meeting-id:(.+)$/i);
    if (match?.[1]) {
      meetingId = match[1].trim();
      break;
    }
  }
  if (!meetingId) {
    meetingId = parseTodoDetailField(todo?.details, "Meeting ID");
  }
  const sourceUrl = parseTodoDetailField(todo?.details, "Source");
  const meetingTitle = parseTodoDetailField(todo?.details, "Meeting");
  return { meetingId, sourceUrl, meetingTitle };
}

function parseSummaryJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function actionItemToLine(item) {
  if (!item) return "";
  if (typeof item === "string") return String(item).trim();
  if (typeof item !== "object") return "";
  const owner = String(item.owner || item.assignee || "").trim();
  const text = String(item.task || item.title || item.action || item.text || "").trim();
  if (owner && text) return `${owner}: ${text}`;
  return text || owner;
}

function cleanSummaryActionText(value) {
  let text = String(value || "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  text = text.replace(/^[\-•*]+\s*/, "");
  text = text.replace(/^\(?\d{1,2}(?::\d{2})?\)?[.)-]\s*/, "");
  text = text.replace(/\s*\(\d{1,2}:\d{2}\)\s*$/i, "");
  return text.trim();
}

function isSummaryActionNoise(text) {
  const line = cleanSummaryActionText(text);
  if (!line) return true;
  if (line.length < 6) return true;
  if (/^[\d:().-]+$/.test(line)) return true;
  if (/^(unknown speaker|unassigned|speaker)$/i.test(line)) return true;
  const nameLike = /^[A-Za-z][A-Za-z .,'/-]{0,60}$/.test(line);
  const actionVerb = /\b(send|review|draft|create|update|prepare|finalize|coordinate|investigate|schedule|follow|confirm|build|deliver|share|analy[sz]e|document|complete|plan|sync|organize|call|email|meet)\b/i.test(line);
  if (nameLike && line.split(/\s+/).length <= 3 && !actionVerb) {
    return true;
  }
  return false;
}

function parseSummaryActionItemLine(value) {
  const line = cleanSummaryActionText(value);
  if (isSummaryActionNoise(line)) return { owner: "", title: "" };
  const ownerMatch = line.match(/^([A-Za-z][A-Za-z .,'/&-]{1,40}):\s+(.+)$/);
  if (ownerMatch) {
    const owner = cleanupInlineText(ownerMatch[1]);
    const title = cleanSummaryActionText(ownerMatch[2]);
    if (isSummaryActionNoise(title)) return { owner: "", title: "" };
    return { owner, title };
  }
  return { owner: "", title: line };
}

function isUsefulContextLine(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (text.length < 6) return false;
  if (/^[\d:.\-]+$/.test(text)) return false;
  return true;
}

function todoKeywordTokens(todo) {
  const raw = `${todo?.title || ""} ${todo?.notes || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ");
  const words = raw.split(/\s+/).filter(Boolean);
  const seen = new Set();
  const tokens = [];
  for (const word of words) {
    if (word.length < 4) continue;
    if (TASK_CONTEXT_STOP_WORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    tokens.push(word);
    if (tokens.length >= 10) break;
  }
  return tokens;
}

function bestMatchingLine(lines, tokens) {
  const normalizedLines = Array.isArray(lines)
    ? lines.map(item => String(item || "").trim()).filter(isUsefulContextLine)
    : [];
  if (!normalizedLines.length) return "";
  if (!tokens.length) return normalizedLines[0];

  let best = "";
  let bestScore = -1;
  for (const line of normalizedLines) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!lower.includes(token)) continue;
      score += token.length >= 8 ? 3 : 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = line;
      continue;
    }
    if (score === bestScore && score > 0 && best && line.length < best.length) {
      best = line;
    }
  }
  if (bestScore > 0) return best;
  return normalizedLines[0];
}

function transcriptSnippetForTokens(transcriptPreview, tokens) {
  const raw = String(transcriptPreview || "").trim();
  if (!raw || !tokens.length) return "";
  const lower = raw.toLowerCase();
  let hitIndex = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx < 0) continue;
    hitIndex = idx;
    break;
  }
  if (hitIndex < 0) return "";
  const start = Math.max(0, hitIndex - 120);
  const end = Math.min(raw.length, hitIndex + 180);
  return raw.slice(start, end).replace(/\s+/g, " ").trim();
}

function buildTaskSpecificContext(todo, context) {
  if (!context || typeof context !== "object") return { brief: "", next: "" };
  const summary = context.summary || {};
  const tokens = todoKeywordTokens(todo);
  const actionLines = (Array.isArray(summary.actionItems) ? summary.actionItems : [])
    .map(actionItemToLine)
    .filter(Boolean);
  const nextLines = (Array.isArray(summary.nextSteps) ? summary.nextSteps : [])
    .map(item => String(item || "").trim())
    .filter(Boolean);
  const decisionLines = (Array.isArray(summary.decisions) ? summary.decisions : [])
    .map(item => String(item || "").trim())
    .filter(Boolean);
  const overviewLines = (Array.isArray(summary.overview) ? summary.overview : [])
    .map(item => String(item || "").trim())
    .filter(Boolean);

  const briefCandidates = [
    ...actionLines,
    ...nextLines,
    ...decisionLines,
    ...overviewLines,
    String(summary.tldr || "").trim()
  ].filter(Boolean);
  let brief = bestMatchingLine(briefCandidates, tokens);
  if (!brief) {
    brief = transcriptSnippetForTokens(context?.transcript?.preview || "", tokens);
  }

  const nextCandidates = [...nextLines, ...actionLines].filter(Boolean);
  const next = bestMatchingLine(nextCandidates, tokens);
  return {
    brief: shortenLine(brief, 220),
    next: shortenLine(next, 140)
  };
}

function resolveTodoMeetingContext(todo) {
  const status = getVectorStoreStatus();
  const dbPath = status?.dbPath || "";
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const { meetingId, sourceUrl, meetingTitle } = extractMeetingReferenceFromTodo(todo);
  const ragDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let row = null;
    if (meetingId) {
      row = ragDb.prepare(`
        SELECT
          m.id AS meeting_id,
          m.title,
          m.occurred_at,
          m.source_url,
          m.raw_transcript,
          ms.summary_json,
          ms.tasks_json,
          ms.decisions_json,
          ms.next_steps_json
        FROM meetings m
        LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
        WHERE m.id = ?
        LIMIT 1
      `).get(meetingId);
    }
    if (!row && sourceUrl) {
      row = ragDb.prepare(`
        SELECT
          m.id AS meeting_id,
          m.title,
          m.occurred_at,
          m.source_url,
          m.raw_transcript,
          ms.summary_json,
          ms.tasks_json,
          ms.decisions_json,
          ms.next_steps_json
        FROM meetings m
        LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
        WHERE m.source_url = ?
        ORDER BY m.occurred_at DESC
        LIMIT 1
      `).get(sourceUrl);
    }
    if (!row && meetingTitle) {
      row = ragDb.prepare(`
        SELECT
          m.id AS meeting_id,
          m.title,
          m.occurred_at,
          m.source_url,
          m.raw_transcript,
          ms.summary_json,
          ms.tasks_json,
          ms.decisions_json,
          ms.next_steps_json
        FROM meetings m
        LEFT JOIN meeting_summaries ms ON ms.meeting_id = m.id
        WHERE LOWER(m.title) = LOWER(?)
        ORDER BY m.occurred_at DESC
        LIMIT 1
      `).get(meetingTitle);
    }
    if (!row) return null;
    const summary = parseSummaryJson(row.summary_json);
    const transcriptText = String(row.raw_transcript || "").trim();
    const transcriptLimit = 12000;
    const transcriptPreview = transcriptText.length > transcriptLimit
      ? `${transcriptText.slice(0, transcriptLimit)}\n\n[Transcript truncated for preview]`
      : transcriptText;
    const audioCandidates = [
      path.join(repoRoot, "data", "recordings", row.meeting_id, "recording.webm"),
      path.join(repoRoot, "data", "recordings", row.meeting_id, "recording.wav")
    ];
    const audioPath = audioCandidates.find(candidate => fs.existsSync(candidate)) || "";
    return {
      meetingId: row.meeting_id,
      title: row.title || "",
      occurredAt: row.occurred_at || "",
      sourceUrl: row.source_url || sourceUrl || "",
      summary: {
        tldr: String(summary?.tldr || "").trim(),
        overview: Array.isArray(summary?.overview) ? summary.overview : [],
        decisions: Array.isArray(summary?.decisions) ? summary.decisions : [],
        actionItems: Array.isArray(summary?.actionItems) ? summary.actionItems : [],
        nextSteps: Array.isArray(summary?.nextSteps) ? summary.nextSteps : []
      },
      transcript: {
        available: Boolean(transcriptText),
        totalChars: transcriptText.length,
        preview: transcriptPreview
      },
      audio: {
        available: Boolean(audioPath),
        path: audioPath
      }
    };
  } finally {
    ragDb.close();
  }
}

function getConfigSnapshot() {
  const microsoftStatus = getMicrosoftStatus(TODO_USER_ID);
  const microsoftScopes = new Set(Array.isArray(microsoftStatus?.scopes) ? microsoftStatus.scopes : []);
  const microsoftTodoReady = microsoftScopes.has("tasks.readwrite") || microsoftScopes.has("tasks.read");
  const reasoningProvider = String(
    process.env.RAG_REASONING_PROVIDER ||
    process.env.FIREFLIES_REASONING_PROVIDER ||
    "openai"
  ).trim().toLowerCase();
  const reasoningModel = String(
    process.env.RAG_REASONING_MODEL ||
    (reasoningProvider === "ollama"
      ? process.env.OLLAMA_MODEL || "qwen2.5:3b"
      : process.env.OPENAI_MODEL || process.env.OPENAI_PRIMARY_MODEL || "gpt-4o-mini")
  ).trim();
  return {
    firefliesConfigured: localOnlyMode
      ? (firefliesPullAllowed && Boolean(process.env.FIREFLIES_API_KEY))
      : Boolean(process.env.FIREFLIES_API_KEY),
    firefliesPullAllowed: !localOnlyMode || firefliesPullAllowed,
    openaiConfigured: !localOnlyMode && Boolean(process.env.OPENAI_API_KEY),
    localOnlyMode,
    insecureTlsEnabled,
    embeddingsProvider: process.env.RAG_EMBEDDINGS_PROVIDER || "local",
    sqlitePath: process.env.RAG_SQLITE_PATH || "",
    syncOnStartup: String(process.env.FIREFLIES_SYNC_ON_STARTUP || "0") === "1",
    syncIntervalMinutes: Number(process.env.FIREFLIES_SYNC_INTERVAL_MINUTES || 0),
    syncLimit: Number(process.env.FIREFLIES_SYNC_LIMIT || 0),
    syncWindowStartHour: String(process.env.FIREFLIES_SYNC_WINDOW_START_HOUR || "").trim(),
    syncWindowEndHour: String(process.env.FIREFLIES_SYNC_WINDOW_END_HOUR || "").trim(),
    syncWindowTimezone: String(process.env.FIREFLIES_SYNC_WINDOW_TIMEZONE || "").trim(),
    microsoftConnected: Boolean(microsoftStatus?.connected),
    microsoftTodoReady: Boolean(microsoftStatus?.connected && microsoftTodoReady),
    microsoftTodoBlockedByLocalOnly: localOnlyMode && !microsoftTodoSyncAllowed,
    microsoftTodoSyncAllowed,
    reasoningProvider,
    reasoningModel,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
  };
}

function getOverview() {
  const sync = getFirefliesSyncStatus();
  const ragCounts = getRagCounts();
  const vectorStore = getVectorStoreStatus();
  const coverage = getMeetingCoverage({ type: "fireflies" });
  return {
    generatedAt: new Date().toISOString(),
    config: getConfigSnapshot(),
    sync,
    ragCounts,
    vectorStore,
    coverage,
    lastRefreshAt: sync?.lastSyncAt || sync?.lastAttemptAt || ""
  };
}

try {
  initRagStore();
} catch (err) {
  console.error("Failed to initialize RAG store:", err?.message || err);
}

try {
  initDb();
  runMigrations();
} catch (err) {
  console.error("Failed to initialize Todo storage:", err?.message || err);
}

try {
  startFirefliesSyncLoop();
} catch (err) {
  console.error("Failed to start Fireflies sync loop:", err?.message || err);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/fireflies/config", (_req, res) => {
  res.json(getConfigSnapshot());
});

app.get("/api/fireflies/sync/status", (_req, res) => {
  const sync = getFirefliesSyncStatus();
  const coverage = getMeetingCoverage({ type: "fireflies" });
  res.json({ ...sync, coverage, localOnlyMode, firefliesPullAllowed: !localOnlyMode || firefliesPullAllowed });
});

app.post("/api/fireflies/sync", async (req, res) => {
  if (localOnlyMode && !firefliesPullAllowed) {
    return res.status(403).json({
      ok: false,
      error: "local_only_mode_sync_blocked",
      message: "LOCAL_ONLY_MODE is enabled and Fireflies pull is blocked. Set ALLOW_FIREFLIES_PULL=1 to allow inbound sync."
    });
  }
  try {
    const limit = parseSyncLimit(req.body?.limit);
    const force = Boolean(req.body?.force);
    const result = await syncFireflies({ limit, force });
    if (result?.ok === false) {
      const status =
        result.error === "fireflies_rate_limited"
          ? 429
          : result.error === "sync_in_progress"
            ? 409
            : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "fireflies_sync_failed" });
  }
});

app.post("/api/fireflies/sync/catchup", async (_req, res) => {
  if (localOnlyMode && !firefliesPullAllowed) {
    return res.status(403).json({
      ok: false,
      error: "local_only_mode_sync_blocked",
      message: "LOCAL_ONLY_MODE is enabled and Fireflies pull is blocked. Set ALLOW_FIREFLIES_PULL=1 to allow inbound sync."
    });
  }
  try {
    const result = await syncFireflies({ limit: 0, force: false });
    if (result?.ok === false) {
      const status =
        result.error === "fireflies_rate_limited"
          ? 429
          : result.error === "sync_in_progress"
            ? 409
            : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "fireflies_sync_failed" });
  }
});

app.get("/api/fireflies/overview", (_req, res) => {
  try {
    return res.json(getOverview());
  } catch (err) {
    return res.status(500).json({ error: err?.message || "fireflies_overview_failed" });
  }
});

app.get("/api/fireflies/meetings/details", (req, res) => {
  try {
    const limitMeetings = toInt(req.query?.limit, 250, 1, 2000);
    const meetings = listFirefliesMeetingsForReview(limitMeetings);
    return res.json({
      ok: true,
      meetings,
      count: meetings.length
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "fireflies_meetings_details_failed" });
  }
});

app.get("/api/rag/knowledge-graph", (req, res) => {
  try {
    const limitMeetings = toInt(req.query?.limitMeetings, 60, 20, 800);
    const maxActionsPerMeeting = toInt(req.query?.maxActionsPerMeeting, 5, 1, 30);
    const maxTopicsPerMeeting = toInt(req.query?.maxTopicsPerMeeting, 4, 1, 20);
    const maxMeetingLinks = toInt(req.query?.maxMeetingLinks, 260, 20, 2000);
    const graph = buildKnowledgeGraph({
      limitMeetings,
      maxActionsPerMeeting,
      maxTopicsPerMeeting,
      maxMeetingLinks
    });
    return res.json({
      ok: true,
      ...graph,
      params: {
        limitMeetings,
        maxActionsPerMeeting,
        maxTopicsPerMeeting,
        maxMeetingLinks
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "rag_knowledge_graph_failed" });
  }
});

app.get("/api/rag/status", (_req, res) => {
  try {
    initRagStore();
    return res.json({
      ...getRagCounts(),
      vectorStore: getVectorStoreStatus()
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "rag_status_failed" });
  }
});

app.post("/api/rag/ask", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "question_required" });
    const topK = toInt(req.body?.topK, 8, 1, 30);
    const result = await answerRagQuestion(question, {
      topK,
      filters: { meetingType: "fireflies" }
    });
    const answer = formatRagAnswer({
      answer: result?.answer || "",
      citations: result?.citations || []
    });
    return res.json({ ...result, answer });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "rag_query_failed" });
  }
});

app.get("/api/integrations/microsoft/todo/status", async (_req, res) => {
  try {
    const status = getMicrosoftStatus(TODO_USER_ID);
    const scopes = new Set(Array.isArray(status?.scopes) ? status.scopes : []);
    const todoScopeReady = scopes.has("tasks.readwrite") || scopes.has("tasks.read");
    const oauth = getMicrosoftOAuthConfigStatus();
    return res.json({
      ...status,
      todoScopeReady,
      localOnlyBlocked: localOnlyMode && !microsoftTodoSyncAllowed,
      oauthConfigured: oauth.oauthConfigured,
      oauthMissing: oauth.missing
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "microsoft_todo_status_failed" });
  }
});

app.get("/api/integrations/microsoft/connect", (req, res) => {
  try {
    if (localOnlyMode && !microsoftTodoSyncAllowed) {
      return res.status(403).send("microsoft_sync_blocked_in_local_only_mode");
    }
    const oauth = getMicrosoftOAuthConfigStatus();
    if (!oauth.oauthConfigured) {
      return res.status(400).send(`microsoft_oauth_not_configured: missing ${oauth.missing.join(", ")}`);
    }
    const preset = String(req.query.preset || "todo_manage");
    const redirectTo = String(req.query.redirect || "/");
    const uiBase = String(req.query.ui_base || req.query.uiBase || "") || getRequestOrigin(req) || `http://${host}:${port}`;
    const tenantId = String(req.query.tenantId || req.query.tenant || "");
    const prompt = String(req.query.prompt || "");
    const domainHint = String(req.query.domainHint || "");
    const loginHint = String(req.query.loginHint || "");
    const url = connectMicrosoft(preset, { redirectTo, uiBase, tenantId, prompt, domainHint, loginHint });
    return res.redirect(url);
  } catch (err) {
    return res.status(500).send(err?.message || "microsoft_connect_failed");
  }
});

app.get("/api/integrations/microsoft/callback", async (req, res) => {
  try {
    if (localOnlyMode && !microsoftTodoSyncAllowed) {
      return res.status(403).send("microsoft_sync_blocked_in_local_only_mode");
    }
    const code = req.query.code;
    const state = req.query.state;
    if (!code || !state) return res.status(400).send("missing_code_or_state");
    const token = await exchangeMicrosoftCode(String(code), String(state));
    const account = await resolveMicrosoftAccount({ accessToken: token.access_token, idToken: token.id_token });
    const userId = account?.email || `microsoft_${Date.now()}`;
    setProvider("microsoft", {
      ...token,
      email: account?.email || null,
      name: account?.name || null,
      tenantId: account?.tenantId || null,
      organization: account?.organization || null,
      connectedAt: new Date().toISOString()
    }, userId);
    const uiBase = token?.meta?.uiBase || getRequestOrigin(req) || `http://${host}:${port}`;
    const redirectTo = token?.meta?.redirectTo || "/";
    return res.redirect(`${uiBase}${redirectTo}?integration=microsoft&status=success`);
  } catch (_err) {
    const uiBase = getRequestOrigin(req) || `http://${host}:${port}`;
    return res.redirect(`${uiBase}/?integration=microsoft&status=error`);
  }
});

app.get("/api/integrations/microsoft/todo/lists", async (_req, res) => {
  try {
    if (localOnlyMode && !microsoftTodoSyncAllowed) {
      return res.status(403).json({
        error: "microsoft_sync_blocked_in_local_only_mode",
        message: "Microsoft To Do sync is blocked while LOCAL_ONLY_MODE=1. Set ALLOW_MICROSOFT_TODO_SYNC=1 to allow it."
      });
    }
    const lists = await listMicrosoftTodoListsFromGraph(TODO_USER_ID);
    return res.json({ ok: true, lists });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "microsoft_todo_lists_failed" });
  }
});

app.get("/api/todos/lists", (_req, res) => {
  try {
    const lists = listTodoListsRecord({ userId: TODO_USER_ID });
    return res.json({ ok: true, lists });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_lists_failed" });
  }
});

app.post("/api/todos/lists", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "list_name_required" });
    const color = String(req.body?.color || "").trim();
    const icon = String(req.body?.icon || "").trim();
    const sortOrder = toInt(req.body?.sortOrder, 0, -1000000, 1000000);
    const list = createTodoListRecord({ name, color, icon, sortOrder, userId: TODO_USER_ID });
    return res.json({ ok: true, list });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_list_create_failed" });
  }
});

app.patch("/api/todos/lists/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "list_id_required" });
    const list = updateTodoListRecord({
      id,
      name: req.body?.name,
      color: req.body?.color,
      icon: req.body?.icon,
      sortOrder: req.body?.sortOrder,
      userId: TODO_USER_ID
    });
    return res.json({ ok: true, list });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_list_update_failed" });
  }
});

app.get("/api/todos/items", (req, res) => {
  try {
    const status = String(req.query.status || "open").trim();
    const dueWithinDays = req.query.dueWithinDays === undefined || req.query.dueWithinDays === ""
      ? null
      : Number(req.query.dueWithinDays);
    const tag = req.query.tag ? String(req.query.tag) : null;
    const listId = req.query.listId ? String(req.query.listId) : null;
    const query = req.query.query ? String(req.query.query) : "";
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const todos = listTodosRecord({
      status,
      dueWithinDays: Number.isFinite(dueWithinDays) ? dueWithinDays : null,
      tag,
      listId,
      query,
      limit,
      userId: TODO_USER_ID
    });
    return res.json({ ok: true, todos });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_list_failed" });
  }
});

app.post("/api/todos/items", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "title_required" });
    const details = String(req.body?.details || "").trim();
    const notes = String(req.body?.notes || "").trim();
    const due = toIsoOrNull(req.body?.due);
    const reminderAt = toIsoOrNull(req.body?.reminderAt);
    const repeatRule = String(req.body?.repeatRule || "").trim();
    const priority = String(req.body?.priority || "medium").trim().toLowerCase();
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : parseCsv(req.body?.tags);
    const steps = Array.isArray(req.body?.steps)
      ? req.body.steps
      : parseCsv(req.body?.stepsText).map(item => ({ title: item, done: false }));
    const listId = req.body?.listId ? String(req.body.listId) : null;
    const pinned = Boolean(req.body?.pinned);
    const sortOrder = req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : null;
    const todo = createTodoRecord({
      title,
      details,
      notes,
      due,
      reminderAt,
      repeatRule,
      priority,
      tags,
      steps,
      listId,
      pinned,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : null,
      userId: TODO_USER_ID
    });
    try {
      const list = todo.listId ? getTodoListRecord({ id: todo.listId, userId: TODO_USER_ID }) : null;
      await ingestTodoToRag({ todo, listName: list?.name || "" });
    } catch {
      // Keep todo creation successful even if RAG ingestion fails.
    }
    return res.json({ ok: true, todo });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_create_failed" });
  }
});

app.patch("/api/todos/items/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const sortOrderRaw = req.body?.sortOrder;
    const sortOrder = sortOrderRaw === undefined ? undefined : Number(sortOrderRaw);
    const updates = {
      title: req.body?.title,
      details: req.body?.details,
      notes: req.body?.notes,
      due: req.body?.due,
      reminderAt: req.body?.reminderAt,
      repeatRule: req.body?.repeatRule,
      priority: req.body?.priority,
      tags: req.body?.tags !== undefined ? (Array.isArray(req.body.tags) ? req.body.tags : parseCsv(req.body.tags)) : undefined,
      steps: req.body?.steps !== undefined
        ? (Array.isArray(req.body.steps) ? req.body.steps : parseCsv(req.body.stepsText).map(item => ({ title: item, done: false })))
        : undefined,
      status: req.body?.status,
      listId: req.body?.listId,
      pinned: req.body?.pinned,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined
    };
    const todo = updateTodoRecord({ id, userId: TODO_USER_ID, ...updates });
    try {
      const list = todo.listId ? getTodoListRecord({ id: todo.listId, userId: TODO_USER_ID }) : null;
      await ingestTodoToRag({ todo, listName: list?.name || "" });
    } catch {
      // Ignore RAG update errors for Todo update flow.
    }
    return res.json({ ok: true, todo });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_update_failed" });
  }
});

app.post("/api/todos/items/:id/complete", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const todo = completeTodoRecord({ id, userId: TODO_USER_ID, completedAt: req.body?.completedAt || null });
    try {
      const list = todo.listId ? getTodoListRecord({ id: todo.listId, userId: TODO_USER_ID }) : null;
      await ingestTodoToRag({ todo, listName: list?.name || "" });
    } catch {
      // Ignore RAG update errors for Todo completion flow.
    }
    return res.json({ ok: true, todo });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_complete_failed" });
  }
});

app.post("/api/todos/items/:id/toggle", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const done = Boolean(req.body?.done);
    const todo = updateTodoRecord({ id, userId: TODO_USER_ID, status: done ? "done" : "open" });
    try {
      const list = todo.listId ? getTodoListRecord({ id: todo.listId, userId: TODO_USER_ID }) : null;
      await ingestTodoToRag({ todo, listName: list?.name || "" });
    } catch {
      // Ignore RAG update errors for toggle flow.
    }
    return res.json({ ok: true, todo });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_toggle_failed" });
  }
});

app.delete("/api/todos/items/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const todo = deleteTodoRecord({ id, userId: TODO_USER_ID });
    return res.json({ ok: true, todo });
  } catch (err) {
    if ((err?.message || "") === "todo_not_found") {
      return res.status(404).json({ error: "todo_not_found" });
    }
    return res.status(500).json({ error: err?.message || "todo_delete_failed" });
  }
});

app.post("/api/todos/import/fireflies", async (req, res) => {
  try {
    const limitMeetings = toInt(req.body?.limitMeetings, 300, 1, 5000);
    const listId = req.body?.listId ? String(req.body.listId).trim() : null;
    const existingTodos = listTodosRecord({
      status: "open",
      dueWithinDays: null,
      limit: 5000,
      userId: TODO_USER_ID
    });
    const existingKeys = new Set(existingTodos.map(item => normalizeTitleKey(item.title)));
    const { candidates, scannedMeetings } = buildFirefliesTaskCandidates(limitMeetings);
    const created = [];
    let skipped = 0;
    for (const candidate of candidates) {
      const title = String(candidate.title || "").trim();
      const titleKey = normalizeTitleKey(title);
      if (!titleKey || existingKeys.has(titleKey)) {
        skipped += 1;
        continue;
      }
      const due = toIsoOrNull(candidate.due);
      const tags = ["fireflies", "meeting-action-item"];
      if (candidate.meetingId) {
        tags.push(`meeting-id:${candidate.meetingId}`);
      }
      if (candidate.ownerIsPerson && candidate.owner) {
        tags.push(`owner:${candidate.owner.toLowerCase().replace(/\s+/g, "-")}`);
      }
      const details = [
        candidate.meetingId ? `Meeting ID: ${candidate.meetingId}` : "",
        `Meeting: ${candidate.meetingTitle}`,
        candidate.occurredAt ? `Occurred: ${candidate.occurredAt}` : "",
        candidate.sourceUrl ? `Source: ${candidate.sourceUrl}` : ""
      ].filter(Boolean).join("\n");
      const todo = createTodoRecord({
        title,
        details,
        notes: candidate.notes || "",
        due,
        reminderAt: null,
        repeatRule: "",
        priority: "medium",
        tags,
        steps: [],
        listId,
        userId: TODO_USER_ID
      });
      try {
        const list = todo.listId ? getTodoListRecord({ id: todo.listId, userId: TODO_USER_ID }) : null;
        await ingestTodoToRag({ todo, listName: list?.name || "" });
      } catch {
        // Keep imported todo even if RAG ingestion fails.
      }
      existingKeys.add(titleKey);
      created.push(todo);
    }
    return res.json({
      ok: true,
      scannedMeetings,
      totalCandidates: candidates.length,
      createdCount: created.length,
      skippedCount: skipped,
      noNewTasks: created.length === 0 && skipped > 0,
      dedupeMode: "open_title",
      created: created.slice(0, 50).map(item => ({
        id: item.id,
        title: item.title,
        due: item.due,
        priority: item.priority,
        listId: item.listId,
        tags: item.tags
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_import_fireflies_failed" });
  }
});

app.post("/api/todos/import/meeting-selections", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const hideExisting = req.body?.hideExisting === undefined ? true : Boolean(req.body?.hideExisting);
    if (!items.length) {
      return res.status(400).json({ error: "meeting_selection_items_required" });
    }

    const columns = ensureKanbanPriorityColumns(TODO_USER_ID);
    const backlogListId = String(columns?.backlog?.id || BACKLOG_LIST_FALLBACK_ID);
    const existingTodos = listTodosRecord({
      status: "all",
      dueWithinDays: null,
      limit: 10000,
      userId: TODO_USER_ID
    });

    let hiddenCount = 0;
    if (hideExisting) {
      for (const todo of existingTodos) {
        const tags = normalizeTodoTags(todo.tags);
        if (tags.some(tag => String(tag || "").toLowerCase() === KANBAN_HIDDEN_TAG)) continue;
        updateTodoRecord({
          id: todo.id,
          userId: TODO_USER_ID,
          tags: normalizeTodoTags([...tags, KANBAN_HIDDEN_TAG])
        });
        hiddenCount += 1;
      }
    }

    const seenTitles = new Set();
    const created = [];
    let skipped = 0;

    for (const rawItem of items) {
      const title = String(rawItem?.title || "").trim();
      const titleKey = normalizeTitleKey(title);
      if (!title || !titleKey || seenTitles.has(titleKey)) {
        skipped += 1;
        continue;
      }
      seenTitles.add(titleKey);

      const meetingId = String(rawItem?.meetingId || "").trim();
      const meetingTitle = String(rawItem?.meetingTitle || "Fireflies Meeting").trim();
      const occurredAt = String(rawItem?.occurredAt || "").trim();
      const sourceUrl = String(rawItem?.sourceUrl || "").trim();
      const owner = String(rawItem?.owner || "").trim();
      const notes = String(rawItem?.notes || "").trim();
      const due = toIsoOrNull(rawItem?.due);

      const tags = normalizeTodoTags([
        "fireflies",
        "meeting-action-item",
        MEETING_SELECTION_TAG,
        SELECTED_FOR_KANBAN_TAG,
        meetingId ? `meeting-id:${meetingId}` : "",
        owner ? `owner:${owner.toLowerCase().replace(/\s+/g, "-")}` : ""
      ]).filter(tag => String(tag || "").toLowerCase() !== KANBAN_HIDDEN_TAG);

      const details = [
        meetingId ? `Meeting ID: ${meetingId}` : "",
        `Meeting: ${meetingTitle}`,
        occurredAt ? `Occurred: ${occurredAt}` : "",
        sourceUrl ? `Source: ${sourceUrl}` : ""
      ].filter(Boolean).join("\n");

      const todo = createTodoRecord({
        title,
        details,
        notes,
        due,
        reminderAt: null,
        repeatRule: "",
        priority: "medium",
        tags,
        steps: [],
        listId: backlogListId,
        sortOrder: Date.now() + created.length,
        userId: TODO_USER_ID
      });

      try {
        const list = getTodoListRecord({ id: backlogListId, userId: TODO_USER_ID });
        await ingestTodoToRag({ todo, listName: list?.name || "" });
      } catch {
        // Keep import successful even if RAG ingestion fails.
      }
      created.push(todo);
    }

    return res.json({
      ok: true,
      hideExisting,
      hiddenCount,
      createdCount: created.length,
      skippedCount: skipped,
      listId: backlogListId,
      created: created.slice(0, 50).map(item => ({
        id: item.id,
        title: item.title,
        listId: item.listId,
        priority: item.priority,
        tags: item.tags
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "meeting_selection_import_failed" });
  }
});

app.post("/api/todos/import/microsoft-local", (req, res) => {
  try {
    const rawText = String(req.body?.rawText || "");
    const formatHint = String(req.body?.formatHint || "").trim().toLowerCase();
    const includeCompleted = req.body?.includeCompleted === undefined ? true : Boolean(req.body?.includeCompleted);
    const parsedResult = parseMicrosoftTodoImportPayload(rawText, formatHint);
    const parsed = Array.isArray(parsedResult?.records) ? parsedResult.records : [];
    const diagnostics = parsedResult?.diagnostics || {};
    if (!parsed.length) {
      const harDiag = diagnostics?.har || {};
      const noHarTodoApis = harDiag.detected && Number(harDiag.todoApiCount || 0) === 0;
      const noHarBodies = harDiag.detected && Number(harDiag.entryCount || 0) > 0 && Number(harDiag.responseBodyCount || 0) === 0;
      const noHarTaskRecords = harDiag.detected && Number(harDiag.parsedJsonCount || 0) > 0 && Number(harDiag.taskRecordCount || 0) === 0;
      let message = "No task-like records were found. Provide JSON or CSV with title/list/status fields.";
      if (noHarTodoApis) {
        message = "HAR is missing Microsoft To-Do API calls. In DevTools, keep Network open, enable Preserve log, filter Fetch/XHR, refresh To-Do, then export HAR with content.";
      } else if (noHarBodies) {
        message = "HAR file has no response bodies. Export as 'HAR with content', then retry.";
      } else if (noHarTaskRecords) {
        message = "HAR parsed, but no To-Do task records were detected. Capture list/task API calls in Network and retry.";
      } else if (Number(diagnostics?.csvRows || 0) > 0) {
        message = "CSV rows found, but required task fields were missing. Include at least 'title' plus optional list/status/importance.";
      }
      return res.status(400).json({
        error: "microsoft_local_import_no_tasks_detected",
        message,
        diagnostics
      });
    }

    const msTodoList = ensureMicrosoftTodoImportColumn(TODO_USER_ID);
    const existingTodos = listTodosRecord({
      status: "all",
      dueWithinDays: null,
      limit: 20000,
      userId: TODO_USER_ID
    });
    const existingByMsId = new Map();
    const existingByTitle = new Map();
    for (const todo of existingTodos) {
      const tags = normalizeTodoTags(todo.tags);
      const isMicrosoftSource = tags.some(tag => String(tag || "").toLowerCase() === MS_TODO_SOURCE_TAG);
      if (!isMicrosoftSource) continue;
      const sourceId = findTagValueByPrefix(tags, MS_TODO_ID_TAG_PREFIX);
      if (sourceId) {
        existingByMsId.set(sourceId.toLowerCase(), todo);
      }
      const titleKey = normalizeTitleKey(todo.title);
      if (titleKey && !existingByTitle.has(titleKey)) {
        existingByTitle.set(titleKey, todo);
      }
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let openCount = 0;
    let doneCount = 0;
    let taskCount = 0;
    let todoItemCount = 0;
    const touched = [];

    for (const record of parsed) {
      if (record.status === "done" && !includeCompleted) {
        skippedCount += 1;
        continue;
      }
      const title = String(record.title || "").trim();
      if (!title) {
        skippedCount += 1;
        continue;
      }
      const sourceIdKey = String(record.sourceId || "").trim().toLowerCase();
      const titleKey = normalizeTitleKey(title);

      const existing = (sourceIdKey && existingByMsId.get(sourceIdKey)) || existingByTitle.get(titleKey) || null;
      const updates = {
        title,
        details: record.details || "",
        notes: record.notes || "",
        due: record.due || null,
        reminderAt: record.reminderAt || null,
        repeatRule: "",
        priority: record.priority || "medium",
        tags: record.tags || [],
        steps: record.steps || [],
        listId: msTodoList.id,
        sortOrder: Number(record.sortOrder || Date.now())
      };

      let saved = null;
      if (existing?.id) {
        saved = updateTodoRecord({
          id: existing.id,
          userId: TODO_USER_ID,
          ...updates,
          status: record.status || "open"
        });
        if ((record.status || "open") === "done" && record.completedAt) {
          saved = completeTodoRecord({
            id: existing.id,
            userId: TODO_USER_ID,
            completedAt: record.completedAt
          });
        }
        updatedCount += 1;
      } else {
        saved = createTodoRecord({
          ...updates,
          userId: TODO_USER_ID
        });
        if ((record.status || "open") === "done") {
          saved = completeTodoRecord({
            id: saved.id,
            userId: TODO_USER_ID,
            completedAt: record.completedAt || null
          });
        }
        createdCount += 1;
      }

      if (sourceIdKey) existingByMsId.set(sourceIdKey, saved);
      if (titleKey) existingByTitle.set(titleKey, saved);
      touched.push(saved);

      if ((record.status || "open") === "done") doneCount += 1;
      else openCount += 1;
      if (record.kind === "todo-item") todoItemCount += 1;
      else taskCount += 1;
    }

    return res.json({
      ok: true,
      msTodoListId: msTodoList.id,
      msTodoListName: msTodoList.name,
      parsedCount: parsed.length,
      createdCount,
      updatedCount,
      skippedCount,
      openCount,
      doneCount,
      taskCount,
      todoItemCount,
      diagnostics,
      sample: touched.slice(0, 50).map(item => ({
        id: item.id,
        title: item.title,
        listId: item.listId,
        priority: item.priority,
        status: item.status,
        tags: item.tags
      }))
    });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err?.message || "microsoft_local_import_bad_request" });
    }
    return res.status(500).json({ error: err?.message || "microsoft_local_import_failed" });
  }
});

app.post("/api/todos/import/notion-local", async (req, res) => {
  try {
    const rawText = String(req.body?.rawText || "");
    const formatHint = String(req.body?.formatHint || "").trim().toLowerCase();
    const includeCompleted = req.body?.includeCompleted === undefined ? true : Boolean(req.body?.includeCompleted);
    const parsedResult = parseNotionImportPayload(rawText, formatHint);
    const parsed = Array.isArray(parsedResult?.records) ? parsedResult.records : [];
    const diagnostics = parsedResult?.diagnostics || {};

    if (!parsed.length) {
      let message = "No task-like records were found. Provide Notion JSON or CSV with at least a title/name column.";
      if (Number(diagnostics?.csvRows || 0) > 0) {
        message = "CSV rows found, but no task records detected. Include at least Name/Title and optional Status/Priority/Due fields.";
      } else if (diagnostics?.treatedAs === "json") {
        message = "JSON parsed, but no Notion task records were detected. Export a Notion database with task rows and retry.";
      }
      return res.status(400).json({
        error: "notion_local_import_no_tasks_detected",
        message,
        diagnostics
      });
    }

    const existingLists = listTodoListsRecord({ userId: TODO_USER_ID });
    const listByNormalizedName = new Map(existingLists.map(list => [normalizeListLabel(list?.name), list]));
    const listNameById = new Map(existingLists.map(list => [String(list?.id || ""), list?.name || ""]));
    let nextSortOrder = existingLists.reduce((max, item) => Math.max(max, Number(item?.sortOrder || 0)), 0) + 1;

    const ensureListForColumn = (columnNameRaw) => {
      const columnName = String(columnNameRaw || "").trim() || NOTION_IMPORT_COLUMN_NAME;
      const normalized = normalizeListLabel(columnName);
      let list = listByNormalizedName.get(normalized) || null;
      if (!list) {
        list = createTodoListRecord({
          name: columnName,
          color: NOTION_IMPORT_COLUMN_COLOR,
          icon: "",
          sortOrder: nextSortOrder,
          userId: TODO_USER_ID
        });
        nextSortOrder += 1;
        listByNormalizedName.set(normalized, list);
        listNameById.set(String(list.id), list.name || "");
      }
      return list;
    };

    const notionDefaultList = ensureListForColumn(NOTION_IMPORT_COLUMN_NAME);

    const existingTodos = listTodosRecord({
      status: "all",
      dueWithinDays: null,
      limit: 20000,
      userId: TODO_USER_ID
    });

    const existingByNotionId = new Map();
    const existingByTitleColumn = new Map();
    for (const todo of existingTodos) {
      const tags = normalizeTodoTags(todo.tags);
      const isNotionSource = tags.some(tag => String(tag || "").toLowerCase() === NOTION_SOURCE_TAG);
      if (!isNotionSource) continue;
      const notionId = findTagValueByPrefix(tags, NOTION_ID_TAG_PREFIX);
      if (notionId) existingByNotionId.set(notionId.toLowerCase(), todo);
      const listName = listNameById.get(String(todo?.listId || "")) || "";
      const key = `${normalizeTitleKey(todo?.title)}|${normalizeListLabel(listName || NOTION_IMPORT_COLUMN_NAME)}`;
      if (!existingByTitleColumn.has(key)) existingByTitleColumn.set(key, todo);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let openCount = 0;
    let doneCount = 0;
    const touched = [];
    const touchedColumns = new Set();

    for (const record of parsed) {
      if (record.status === "done" && !includeCompleted) {
        skippedCount += 1;
        continue;
      }
      const title = String(record.title || "").trim();
      if (!title) {
        skippedCount += 1;
        continue;
      }

      const list = ensureListForColumn(record.columnName || NOTION_IMPORT_COLUMN_NAME);
      if (!list?.id) {
        skippedCount += 1;
        continue;
      }
      touchedColumns.add(String(list.name || NOTION_IMPORT_COLUMN_NAME));

      const notionIdKey = String(record.sourceId || "").trim().toLowerCase();
      const titleColumnKey = `${normalizeTitleKey(title)}|${normalizeListLabel(list.name || NOTION_IMPORT_COLUMN_NAME)}`;
      const existing = (notionIdKey && existingByNotionId.get(notionIdKey)) || existingByTitleColumn.get(titleColumnKey) || null;

      const updates = {
        title,
        details: record.details || "",
        notes: record.notes || "",
        due: record.due || null,
        reminderAt: record.reminderAt || null,
        repeatRule: "",
        priority: record.priority || "medium",
        tags: record.tags || [],
        steps: record.steps || [],
        listId: list.id,
        sortOrder: Number(record.sortOrder || Date.now())
      };

      let saved = null;
      if (existing?.id) {
        saved = updateTodoRecord({
          id: existing.id,
          userId: TODO_USER_ID,
          ...updates,
          status: record.status || "open"
        });
        if ((record.status || "open") === "done") {
          saved = completeTodoRecord({
            id: existing.id,
            userId: TODO_USER_ID,
            completedAt: record.completedAt || null
          });
        }
        updatedCount += 1;
      } else {
        saved = createTodoRecord({
          ...updates,
          userId: TODO_USER_ID
        });
        if ((record.status || "open") === "done") {
          saved = completeTodoRecord({
            id: saved.id,
            userId: TODO_USER_ID,
            completedAt: record.completedAt || null
          });
        }
        createdCount += 1;
      }

      if (notionIdKey) existingByNotionId.set(notionIdKey, saved);
      existingByTitleColumn.set(titleColumnKey, saved);
      touched.push(saved);

      try {
        await ingestTodoToRag({ todo: saved, listName: list.name || NOTION_IMPORT_COLUMN_NAME });
      } catch {
        // Keep import successful even if RAG ingestion fails for individual tasks.
      }

      if ((record.status || "open") === "done") doneCount += 1;
      else openCount += 1;
    }

    return res.json({
      ok: true,
      notionDefaultListId: notionDefaultList?.id || null,
      notionDefaultListName: notionDefaultList?.name || NOTION_IMPORT_COLUMN_NAME,
      parsedCount: parsed.length,
      createdCount,
      updatedCount,
      skippedCount,
      openCount,
      doneCount,
      columnsTouched: Array.from(touchedColumns),
      diagnostics,
      sample: touched.slice(0, 50).map(item => ({
        id: item.id,
        title: item.title,
        listId: item.listId,
        priority: item.priority,
        status: item.status,
        tags: item.tags
      }))
    });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err?.message || "notion_local_import_bad_request" });
    }
    return res.status(500).json({ error: err?.message || "notion_local_import_failed" });
  }
});

app.post("/api/todos/kanban/organize", (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dryRun);
    const enrichContext = req.body?.enrichContext === undefined ? true : Boolean(req.body?.enrichContext);
    const columns = ensureKanbanPriorityColumns(TODO_USER_ID);
    const todos = listTodosRecord({
      status: "all",
      dueWithinDays: null,
      limit: 10000,
      userId: TODO_USER_ID
    });
    const managedListIds = new Set(
      Object.values(columns)
        .map(item => String(item?.id || "").trim())
        .filter(Boolean)
    );
    const contextCache = new Map();

    const countsByColumnKey = {};
    for (const spec of KANBAN_PRIORITY_COLUMNS) {
      countsByColumnKey[spec.key] = 0;
    }

    let movedCount = 0;
    let unchangedCount = 0;
    let reprioritizedCount = 0;
    let retaggedCount = 0;
    let contextUpdatedCount = 0;
    let skippedManualCount = 0;
    let skippedCustomColumnCount = 0;
    let nextSortOrder = Date.now();

    for (const todo of todos) {
      const columnKey = guessKanbanColumnKey(todo);
      const targetColumn = columns[columnKey] || columns.backlog;
      if (!targetColumn?.id) continue;

      countsByColumnKey[columnKey] = (countsByColumnKey[columnKey] || 0) + 1;
      const updates = {};
      const normalizedTags = normalizeTodoTags(todo.tags);
      const manualColumn = normalizedTags.some(tag => String(tag || "").toLowerCase() === MANUAL_COLUMN_TAG);
      const currentListId = String(todo.listId || "").trim();
      const currentInManagedColumn = !currentListId || managedListIds.has(currentListId);
      const shouldSkipMove = manualColumn || !currentInManagedColumn;

      if (manualColumn) skippedManualCount += 1;
      if (!currentInManagedColumn) skippedCustomColumnCount += 1;

      const desiredPriority = priorityFromColumnKey(columnKey, todo.priority);
      if (String(todo.priority || "").toLowerCase() !== desiredPriority) {
        updates.priority = desiredPriority;
        reprioritizedCount += 1;
      }

      const desiredTags = withPriorityTag(normalizedTags, desiredPriority);
      if (!sameTagSet(normalizedTags, desiredTags)) {
        updates.tags = desiredTags;
        retaggedCount += 1;
      }

      if (enrichContext) {
        const meetingRef = extractMeetingReferenceFromTodo(todo);
        const cacheKey =
          String(meetingRef.meetingId || "").trim() ||
          String(meetingRef.sourceUrl || "").trim() ||
          String(meetingRef.meetingTitle || "").trim() ||
          `todo:${todo.id}`;
        let context = contextCache.get(cacheKey);
        if (context === undefined) {
          context = resolveTodoMeetingContext(todo);
          contextCache.set(cacheKey, context || null);
        }
        if (context) {
          const taskContext = buildTaskSpecificContext(todo, context);
          if (taskContext.brief) {
            const mergedNotes = mergeContextBriefIntoNotes(todo.notes, taskContext.brief, taskContext.next);
            if (mergedNotes !== String(todo.notes || "")) {
              updates.notes = mergedNotes;
              contextUpdatedCount += 1;
            }
          }
        }
      }

      const alreadyInTarget = String(todo.listId || "") === String(targetColumn.id || "");
      if (alreadyInTarget || shouldSkipMove) {
        unchangedCount += 1;
      } else {
        movedCount += 1;
        if (!dryRun) {
          nextSortOrder += 1;
          updates.listId = targetColumn.id;
          updates.sortOrder = nextSortOrder;
        }
      }

      if (!dryRun && Object.keys(updates).length) {
        updateTodoRecord({
          id: todo.id,
          userId: TODO_USER_ID,
          ...updates
        });
      }
    }

    const countsByColumn = {};
    for (const spec of KANBAN_PRIORITY_COLUMNS) {
      const col = columns[spec.key];
      const label = col?.name || spec.name;
      countsByColumn[label] = countsByColumnKey[spec.key] || 0;
    }

    return res.json({
      ok: true,
      dryRun,
      enrichContext,
      totalTodos: todos.length,
      movedCount,
      unchangedCount,
      reprioritizedCount,
      retaggedCount,
      contextUpdatedCount,
      skippedManualCount,
      skippedCustomColumnCount,
      countsByColumnKey,
      countsByColumn,
      columns: Object.entries(columns).map(([key, col]) => ({
        key,
        id: col.id,
        name: col.name,
        color: col.color,
        sortOrder: col.sortOrder
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "kanban_organize_failed" });
  }
});

app.post("/api/todos/kanban/move", (req, res) => {
  try {
    const taskId = String(req.body?.taskId || "").trim();
    if (!taskId) return res.status(400).json({ error: "task_id_required" });

    const columns = ensureKanbanPriorityColumns(TODO_USER_ID);
    const fallbackListId = String(columns?.backlog?.id || BACKLOG_LIST_FALLBACK_ID);
    const targetListId = normalizeKanbanListId(req.body?.targetListId, fallbackListId);
    const beforeTaskId = String(req.body?.beforeTaskId || "").trim();

    const todos = listTodosRecord({
      status: "all",
      dueWithinDays: null,
      limit: 10000,
      userId: TODO_USER_ID
    });
    const byId = new Map(todos.map(item => [item.id, item]));
    const moving = byId.get(taskId);
    if (!moving) return res.status(404).json({ error: "todo_not_found" });
    const movingTags = normalizeTodoTags(moving.tags);
    if (!movingTags.some(tag => String(tag || "").toLowerCase() === MANUAL_COLUMN_TAG)) {
      movingTags.push(MANUAL_COLUMN_TAG);
    }

    const sourceListId = normalizeKanbanListId(moving.listId, fallbackListId);
    const targetLane = todos
      .filter(item => item.id !== taskId && normalizeKanbanListId(item.listId, fallbackListId) === targetListId)
      .sort(laneSortComparator);

    let insertAt = 0;
    if (beforeTaskId) {
      const idx = targetLane.findIndex(item => item.id === beforeTaskId);
      insertAt = idx >= 0 ? idx : 0;
    }

    const reorderedTargetLane = [...targetLane];
    reorderedTargetLane.splice(insertAt, 0, moving);

    let sortSeed = Date.now() + 100000;
    for (let idx = 0; idx < reorderedTargetLane.length; idx += 1) {
      const item = reorderedTargetLane[idx];
      const nextSort = sortSeed - idx;
      const desiredListId = targetListId;
      if (String(item.id) === taskId) {
        updateTodoRecord({
          id: item.id,
          userId: TODO_USER_ID,
          listId: desiredListId,
          sortOrder: nextSort,
          tags: movingTags
        });
        continue;
      }
      if (normalizeKanbanListId(item.listId, fallbackListId) !== desiredListId || Number(item.sortOrder || 0) !== nextSort) {
        updateTodoRecord({
          id: item.id,
          userId: TODO_USER_ID,
          listId: desiredListId,
          sortOrder: nextSort
        });
      }
    }

    if (sourceListId !== targetListId) {
      const sourceLane = todos
        .filter(item => item.id !== taskId && normalizeKanbanListId(item.listId, fallbackListId) === sourceListId)
        .sort(laneSortComparator);
      sortSeed = Date.now() + 50000;
      for (let idx = 0; idx < sourceLane.length; idx += 1) {
        const item = sourceLane[idx];
        const nextSort = sortSeed - idx;
        if (Number(item.sortOrder || 0) !== nextSort) {
          updateTodoRecord({
            id: item.id,
            userId: TODO_USER_ID,
            listId: sourceListId,
            sortOrder: nextSort
          });
        }
      }
    }

    const updated = updateTodoRecord({ id: taskId, userId: TODO_USER_ID });
    return res.json({
      ok: true,
      moved: {
        id: updated.id,
        listId: updated.listId,
        sortOrder: updated.sortOrder
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "kanban_move_failed" });
  }
});

app.get("/api/todos/context/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const todo = getTodoRecord({ id, userId: TODO_USER_ID });
    if (!todo) return res.status(404).json({ error: "todo_not_found" });
    const context = resolveTodoMeetingContext(todo);
    if (!context) {
      return res.json({ ok: true, todo: { id: todo.id, title: todo.title }, context: null });
    }
    const taskContext = buildTaskSpecificContext(todo, context);
    return res.json({
      ok: true,
      todo: {
        id: todo.id,
        title: todo.title,
        priority: todo.priority,
        tags: todo.tags || []
      },
      context: {
        meetingId: context.meetingId,
        title: context.title,
        occurredAt: context.occurredAt,
        sourceUrl: context.sourceUrl,
        summary: context.summary,
        taskBrief: taskContext.brief,
        taskNext: taskContext.next,
        transcript: context.transcript,
        audio: {
          available: context.audio.available,
          url: context.audio.available ? `/api/todos/context/${encodeURIComponent(todo.id)}/audio` : ""
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_context_failed" });
  }
});

app.get("/api/todos/context/:id/audio", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "todo_id_required" });
    const todo = getTodoRecord({ id, userId: TODO_USER_ID });
    if (!todo) return res.status(404).json({ error: "todo_not_found" });
    const context = resolveTodoMeetingContext(todo);
    if (!context?.audio?.available || !context.audio.path) {
      return res.status(404).json({ error: "todo_audio_not_found" });
    }
    const audioPath = context.audio.path;
    if (audioPath.endsWith(".wav")) res.type("audio/wav");
    else res.type("audio/webm");
    return res.sendFile(audioPath);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "todo_audio_failed" });
  }
});

app.post("/api/todos/sync/microsoft", async (req, res) => {
  try {
    if (localOnlyMode && !microsoftTodoSyncAllowed) {
      return res.status(403).json({
        error: "microsoft_sync_blocked_in_local_only_mode",
        message: "Microsoft To Do sync is blocked while LOCAL_ONLY_MODE=1. Set ALLOW_MICROSOFT_TODO_SYNC=1 to allow it."
      });
    }
    const microsoftStatus = getMicrosoftStatus(TODO_USER_ID);
    if (!microsoftStatus?.connected) {
      return res.status(400).json({ error: "microsoft_not_connected" });
    }
    const token = await getMicrosoftAccessToken([MICROSOFT_TODO_SCOPE], TODO_USER_ID);
    const listsPayload = await microsoftGraphRequest("/me/todo/lists?$top=100", { token });
    const lists = Array.isArray(listsPayload?.value) ? listsPayload.value : [];
    if (!lists.length) {
      return res.status(400).json({ error: "microsoft_todo_lists_not_found" });
    }
    const requestedListId = String(req.body?.listId || "").trim();
    const targetList = lists.find(item => item.id === requestedListId) || lists[0];
    const select = encodeURIComponent("id,title,status,importance,categories,dueDateTime,lastModifiedDateTime");
    const tasksPayload = await microsoftGraphRequest(
      `/me/todo/lists/${encodeURIComponent(targetList.id)}/tasks?$top=200&$select=${select}`,
      { token }
    );
    const remoteTasks = Array.isArray(tasksPayload?.value) ? tasksPayload.value : [];
    const remoteById = new Map(remoteTasks.map(item => [String(item?.id || ""), item]));
    const remoteByTitle = new Map();
    for (const item of remoteTasks) {
      if (String(item?.status || "").toLowerCase() === "completed") continue;
      const key = normalizeTitleKey(item?.title);
      if (!key || remoteByTitle.has(key)) continue;
      remoteByTitle.set(key, item);
    }

    const localTodos = listTodosRecord({
      status: "open",
      dueWithinDays: null,
      limit: 2000,
      userId: TODO_USER_ID
    });
    const syncState = getMicrosoftTodoSyncState(TODO_USER_ID);
    const nextItems = { ...(syncState.items || {}) };
    let created = 0;
    let updated = 0;
    let linked = 0;
    for (const todo of localTodos) {
      const key = normalizeTitleKey(todo.title);
      if (!key) continue;
      const payload = buildMicrosoftTodoPayload(todo);
      const mapped = nextItems[todo.id];
      const mappedTask = mapped?.taskId ? remoteById.get(mapped.taskId) : null;
      const existingByTitle = remoteByTitle.get(key);
      const targetTask = mappedTask || existingByTitle || null;
      let remoteTaskId = "";
      if (targetTask?.id) {
        remoteTaskId = String(targetTask.id);
        if (mappedTask) {
          await microsoftGraphRequest(
            `/me/todo/lists/${encodeURIComponent(targetList.id)}/tasks/${encodeURIComponent(remoteTaskId)}`,
            { method: "PATCH", token, body: payload }
          );
          updated += 1;
        } else {
          linked += 1;
        }
      } else {
        const createdTask = await microsoftGraphRequest(
          `/me/todo/lists/${encodeURIComponent(targetList.id)}/tasks`,
          { method: "POST", token, body: payload }
        );
        remoteTaskId = String(createdTask?.id || "");
        created += 1;
      }
      if (remoteTaskId && Array.isArray(todo.steps) && todo.steps.length) {
        try {
          await syncMicrosoftChecklistItems({
            listId: targetList.id,
            taskId: remoteTaskId,
            steps: todo.steps,
            token
          });
        } catch {
          // Ignore checklist sync errors and keep task-level sync successful.
        }
      }
      if (remoteTaskId) {
        nextItems[todo.id] = {
          taskId: remoteTaskId,
          listId: targetList.id,
          titleKey: key,
          updatedAt: new Date().toISOString()
        };
      }
    }
    const saved = saveMicrosoftTodoSyncState({ items: nextItems }, TODO_USER_ID);
    return res.json({
      ok: true,
      targetList: { id: targetList.id, displayName: targetList.displayName || targetList.wellknownListName || "Tasks" },
      processed: localTodos.length,
      created,
      updated,
      linkedExisting: linked,
      syncMapEntries: Object.keys(saved.items || {}).length
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "microsoft_todo_sync_failed" });
  }
});

app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large" || Number(err?.status || 0) === 413) {
    return res.status(413).json({
      error: "payload_too_large",
      message: "Import payload too large for this server. Use a smaller/split HAR export."
    });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: "invalid_json_body",
      message: "Request body is not valid JSON."
    });
  }
  return next(err);
});

app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  const htmlPath = path.join(publicDir, "index.html");
  if (!fs.existsSync(htmlPath)) {
    return res.status(500).send("UI not found");
  }
  return res.sendFile(htmlPath);
});

app.listen(port, host, () => {
  const base = `http://${host}:${port}`;
  console.log(`Fireflies RAG only server running on ${base}`);
  if (!process.env.FIREFLIES_API_KEY) {
    console.log("Warning: FIREFLIES_API_KEY is not set in fireflies-rag-only/.env");
  }
  console.log(`Open ${base}`);
});
