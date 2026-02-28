import crypto from "node:crypto";

export const WECOM_TEXT_BYTE_LIMIT = 2000;
export const INBOUND_DEDUPE_TTL_MS = 5 * 60 * 1000;

const inboundMessageDedupe = new Map();

export function buildWecomSessionId(userId) {
  return `wecom:${String(userId ?? "").trim().toLowerCase()}`;
}

export function buildInboundDedupeKey(msgObj, namespace = "default") {
  const ns = String(namespace ?? "default").trim().toLowerCase() || "default";
  const msgId = String(msgObj?.MsgId ?? "").trim();
  if (msgId) return `${ns}:id:${msgId}`;
  const fromUser = String(msgObj?.FromUserName ?? "").trim().toLowerCase();
  const createTime = String(msgObj?.CreateTime ?? "").trim();
  const msgType = String(msgObj?.MsgType ?? "").trim().toLowerCase();
  const stableHint = String(
    msgObj?.Content ?? msgObj?.MediaId ?? msgObj?.EventKey ?? msgObj?.Event ?? "",
  )
    .trim()
    .slice(0, 160);
  if (!fromUser && !createTime && !msgType && !stableHint) return null;
  return `${ns}:${fromUser}|${createTime}|${msgType}|${stableHint}`;
}

export function markInboundMessageSeen(msgObj, namespace = "default") {
  const dedupeKey = buildInboundDedupeKey(msgObj, namespace);
  if (!dedupeKey) return true;

  const now = Date.now();
  for (const [key, expiresAt] of inboundMessageDedupe) {
    if (expiresAt <= now) inboundMessageDedupe.delete(key);
  }

  const existingExpiry = inboundMessageDedupe.get(dedupeKey);
  if (typeof existingExpiry === "number" && existingExpiry > now) return false;

  inboundMessageDedupe.set(dedupeKey, now + INBOUND_DEDUPE_TTL_MS);
  return true;
}

export function resetInboundMessageDedupeForTests() {
  inboundMessageDedupe.clear();
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return sha1(arr.join(""));
}

export function getByteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

export function splitWecomText(text, byteLimit = WECOM_TEXT_BYTE_LIMIT) {
  if (getByteLength(text) <= byteLimit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (getByteLength(remaining) <= byteLimit) {
      chunks.push(remaining);
      break;
    }

    let low = 1;
    let high = remaining.length;

    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (getByteLength(remaining.slice(0, mid)) <= byteLimit) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    let splitIndex = low;

    const searchStart = Math.max(0, splitIndex - 200);
    const searchText = remaining.slice(searchStart, splitIndex);

    let naturalBreak = searchText.lastIndexOf("\n\n");
    if (naturalBreak === -1) {
      naturalBreak = searchText.lastIndexOf("\n");
    }
    if (naturalBreak === -1) {
      naturalBreak = searchText.lastIndexOf("。");
      if (naturalBreak !== -1) naturalBreak += 1;
    }
    if (naturalBreak !== -1 && naturalBreak > 0) {
      splitIndex = searchStart + naturalBreak;
    }

    if (splitIndex <= 0) {
      splitIndex = Math.min(remaining.length, Math.floor(byteLimit / 3));
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export function pickAccountBySignature({ accounts, msgSignature, timestamp, nonce, encrypt }) {
  if (!msgSignature || !encrypt) return null;
  for (const account of accounts) {
    if (!account?.callbackToken || !account?.callbackAesKey) continue;
    const expected = computeMsgSignature({
      token: account.callbackToken,
      timestamp,
      nonce,
      encrypt,
    });
    if (expected === msgSignature) return account;
  }
  return null;
}
