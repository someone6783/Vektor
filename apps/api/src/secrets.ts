import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error("Secret key must be 32 bytes.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(value: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error("Secret key must be 32 bytes.");
  }

  const [version, ivValue, tagValue, ciphertextValue] = value.split(":");

  if (version !== VERSION || !ivValue || !tagValue || ciphertextValue === undefined) {
    throw new Error("Unsupported secret format.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
