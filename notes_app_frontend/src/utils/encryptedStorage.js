const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ENCRYPTED_STORAGE_KEY = "retro_notes_encrypted_v1";
const LEGACY_NOTES_KEY = "retro_notes_v1";
const LEGACY_TRASH_KEY = "retro_notes_trash_v1";

const PBKDF2_ITERATIONS = 250000;
const PBKDF2_HASH = "SHA-256";
const KEY_LENGTH_BITS = 256;
const AES_GCM_IV_BYTES = 12;
const SALT_BYTES = 16;

function randomBytes(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

function bytesToBase64(bytes) {
  // Browser-safe base64 conversion for Uint8Array
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveAesKeyFromPassphrase(passphrase, saltBytes) {
  const passphraseBytes = textEncoder.encode(String(passphrase || ""));
  const material = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    material,
    { name: "AES-GCM", length: KEY_LENGTH_BITS },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJsonToPayload(passphrase, jsonString) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(AES_GCM_IV_BYTES);

  const key = await deriveAesKeyFromPassphrase(passphrase, salt);
  const plaintextBytes = textEncoder.encode(String(jsonString || ""));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes
  );

  return {
    schema: "enc_notes_v1",
    kdf: { name: "PBKDF2", hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS },
    cipher: { name: "AES-GCM" },
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: Date.now(),
  };
}

async function decryptPayloadToJson(passphrase, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid encrypted payload.");
  }
  if (payload.schema !== "enc_notes_v1") {
    throw new Error("Unknown encrypted schema.");
  }

  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const data = base64ToBytes(payload.data);

  const key = await deriveAesKeyFromPassphrase(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  return textDecoder.decode(new Uint8Array(plaintext));
}

function readLegacyNotesFromLocalStorage() {
  /** Reads legacy unencrypted keys to support migration. */
  try {
    const rawNotes = localStorage.getItem(LEGACY_NOTES_KEY);
    const rawTrash = localStorage.getItem(LEGACY_TRASH_KEY);

    const notes = rawNotes ? JSON.parse(rawNotes) : [];
    const trashedNotes = rawTrash ? JSON.parse(rawTrash) : [];

    return {
      activeNotes: Array.isArray(notes) ? notes : [],
      trashedNotes: Array.isArray(trashedNotes) ? trashedNotes : [],
      hadLegacyData: Boolean(rawNotes || rawTrash),
    };
  } catch {
    return { activeNotes: [], trashedNotes: [], hadLegacyData: false };
  }
}

function clearLegacyUnencryptedStorage() {
  /** Deletes legacy unencrypted keys after successful migration (best-effort). */
  try {
    localStorage.removeItem(LEGACY_NOTES_KEY);
    localStorage.removeItem(LEGACY_TRASH_KEY);
  } catch {
    // ignore
  }
}

function isWebCryptoSupported() {
  return Boolean(
    typeof window !== "undefined" &&
      window.crypto &&
      window.crypto.subtle &&
      typeof window.crypto.subtle.encrypt === "function"
  );
}

// PUBLIC_INTERFACE
export function encryptedNotesStorageKey() {
  /** Returns the localStorage key used for encrypted notes storage. */
  return ENCRYPTED_STORAGE_KEY;
}

// PUBLIC_INTERFACE
export function canUseEncryptedStorage() {
  /** Whether WebCrypto is available for encryption/decryption. */
  return isWebCryptoSupported();
}

// PUBLIC_INTERFACE
export function hasEncryptedPayload() {
  /** True if an encrypted payload exists in localStorage. */
  try {
    return Boolean(localStorage.getItem(ENCRYPTED_STORAGE_KEY));
  } catch {
    return false;
  }
}

// PUBLIC_INTERFACE
export function hasLegacyUnencryptedNotes() {
  /** True if legacy (unencrypted) notes keys exist. */
  try {
    return Boolean(localStorage.getItem(LEGACY_NOTES_KEY) || localStorage.getItem(LEGACY_TRASH_KEY));
  } catch {
    return false;
  }
}

// PUBLIC_INTERFACE
export async function unlockEncryptedNotes(passphrase) {
  /**
   * Decrypts stored notes using passphrase.
   * Returns { activeNotes, trashedNotes } as raw arrays (normalization is handled by App).
   */
  if (!isWebCryptoSupported()) {
    throw new Error("Encryption is not supported in this browser.");
  }
  const raw = localStorage.getItem(ENCRYPTED_STORAGE_KEY);
  if (!raw) {
    // Treat as empty vault.
    return { activeNotes: [], trashedNotes: [] };
  }

  const payload = JSON.parse(raw);
  const json = await decryptPayloadToJson(passphrase, payload);
  const parsed = JSON.parse(json);

  // Stored format: { activeNotes: [], trashedNotes: [] }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Decrypted data was invalid.");
  }

  return {
    activeNotes: Array.isArray(parsed.activeNotes) ? parsed.activeNotes : [],
    trashedNotes: Array.isArray(parsed.trashedNotes) ? parsed.trashedNotes : [],
  };
}

// PUBLIC_INTERFACE
export async function saveEncryptedNotes(passphrase, { activeNotes, trashedNotes }) {
  /**
   * Encrypts and persists notes payload to localStorage.
   * Does not touch legacy keys.
   */
  if (!isWebCryptoSupported()) {
    throw new Error("Encryption is not supported in this browser.");
  }
  const json = JSON.stringify(
    {
      schemaVersion: 1,
      activeNotes: Array.isArray(activeNotes) ? activeNotes : [],
      trashedNotes: Array.isArray(trashedNotes) ? trashedNotes : [],
    },
    null,
    0
  );

  const payload = await encryptJsonToPayload(passphrase, json);
  localStorage.setItem(ENCRYPTED_STORAGE_KEY, JSON.stringify(payload));
}

// PUBLIC_INTERFACE
export async function createEncryptedVaultFromLegacy(passphrase) {
  /**
   * One-time migration helper:
   * - reads legacy unencrypted notes+trash
   * - saves them encrypted
   * - removes legacy keys (best-effort)
   */
  if (!isWebCryptoSupported()) {
    throw new Error("Encryption is not supported in this browser.");
  }

  const legacy = readLegacyNotesFromLocalStorage();
  await saveEncryptedNotes(passphrase, {
    activeNotes: legacy.activeNotes,
    trashedNotes: legacy.trashedNotes,
  });

  clearLegacyUnencryptedStorage();

  return {
    migrated: legacy.hadLegacyData,
    activeNotes: legacy.activeNotes,
    trashedNotes: legacy.trashedNotes,
  };
}
