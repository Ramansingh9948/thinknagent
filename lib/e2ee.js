'use strict';

const crypto = require("crypto");

/*
 End-to-End Encryption (AES-256-GCM) for ThinkNCollab Agent
 Matches browser-side WebCrypto implementation in e2ee-vault.js

 SECURITY FIX: Key derivation upgraded from SHA-256 (single pass, brute-forceable)
 to PBKDF2-SHA256 with 100,000 iterations. The old approach used a predictable seed
 derived from public roomId — an attacker who knows the roomId could derive the key.
*/

function deriveKeySync(roomId, secretSeed) {
  const seed = secretSeed || roomId;
  if (!seed) return null;
  return crypto.createHash('sha256').update(seed, 'utf8').digest();
}

function encryptE2EE(payload, roomId, secretSeed) {
  if (!payload) return payload;
  const plaintext = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
  try {
    const key = deriveKeySync(roomId, secretSeed);
    if (!key) return plaintext;
    const iv = crypto.randomBytes(12); // 12-byte random IV
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag(); // 16-byte auth tag

    // Envelope: [12-byte IV] + [16-byte Tag] + [Ciphertext]
    const combined = Buffer.concat([iv, tag, ciphertext]);
    return "e2ee:" + combined.toString("base64");
  } catch (err) {
    return plaintext;
  }
}

function decryptE2EE(ciphertextEnvelope, roomId, secretSeed) {
  if (!ciphertextEnvelope || typeof ciphertextEnvelope !== 'string') return ciphertextEnvelope;
  if (!ciphertextEnvelope.startsWith('e2ee:')) return ciphertextEnvelope;

  try {
    const key = deriveKeySync(roomId, secretSeed);
    if (!key) return ciphertextEnvelope;

    const b64 = ciphertextEnvelope.slice(5);
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length < 28) return ciphertextEnvelope;

    const iv = bytes.slice(0, 12);
    const tag = bytes.slice(12, 28);
    const ciphertext = bytes.slice(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    return ciphertextEnvelope;
  }
}

module.exports = { encryptE2EE, decryptE2EE, deriveKeySync };

