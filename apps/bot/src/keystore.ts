import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** On-disk format of the encrypted bot wallet. Contains no secret in plain text. */
export type EncryptedKey = {
  version: 1;
  publicKey: string;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export function encryptSecretKey(secretKey: Uint8Array, publicKey: string, passphrase: string): EncryptedKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const data = Buffer.concat([cipher.update(secretKey), cipher.final()]);
  return {
    version: 1,
    publicKey,
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  };
}

/** Throws if the passphrase is wrong or the file was tampered with (GCM authentication). */
export function decryptSecretKey(file: EncryptedKey, passphrase: string): Uint8Array {
  const key = scryptSync(passphrase, Buffer.from(file.salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(file.data, 'hex')), decipher.final()]));
  } catch {
    throw new Error('Could not decrypt the bot wallet: BOT_KEY_PASSPHRASE is wrong or the wallet file is damaged.');
  }
}
