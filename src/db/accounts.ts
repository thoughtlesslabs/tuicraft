import { getDB } from "./client";

export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

export interface Account {
  id: string;
  username: string;
  password_hash: string | null;
  created_at: string;
}

export interface SSHKey {
  id: number;
  account_id: string;
  fingerprint: string;
  public_key: string | null;
  created_at: string;
}

export function getAccountByUsername(username: string): Account | null {
  const db = getDB();
  const res = db.query("SELECT * FROM accounts WHERE username = $username").get({
    $username: username.toLowerCase().trim()
  }) as Account | null;
  return res;
}

export function getAccountByFingerprint(fingerprint: string): Account | null {
  const db = getDB();
  const res = db.query(`
    SELECT a.* FROM accounts a
    JOIN ssh_keys k ON a.id = k.account_id
    WHERE k.fingerprint = $fingerprint
  `).get({
    $fingerprint: fingerprint
  }) as Account | null;
  return res;
}

export async function createAccount(username: string, password?: string): Promise<Account> {
  const db = getDB();
  const id = crypto.randomUUID();
  const passwordHash = password ? await hashPassword(password) : null;
  const createdAt = new Date().toISOString();

  db.query(`
    INSERT INTO accounts (id, username, password_hash, created_at)
    VALUES ($id, $username, $passwordHash, $createdAt)
  `).run({
    $id: id,
    $username: username.toLowerCase().trim(),
    $passwordHash: passwordHash,
    $createdAt: createdAt
  });

  return { id, username, password_hash: passwordHash, created_at: createdAt };
}

export function linkSSHKey(accountId: string, fingerprint: string, publicKey?: string) {
  const db = getDB();
  const createdAt = new Date().toISOString();
  db.query(`
    INSERT OR IGNORE INTO ssh_keys (account_id, fingerprint, public_key, created_at)
    VALUES ($accountId, $fingerprint, $publicKey, $createdAt)
  `).run({
    $accountId: accountId,
    $fingerprint: fingerprint,
    $publicKey: publicKey || null,
    $createdAt: createdAt
  });
}

export function isAccountBanned(accountId: string): { bannedAt: string; reason: string } | null {
  const db = getDB();
  const res = db.query("SELECT banned_at, reason FROM bans WHERE account_id = $accountId").get({
    $accountId: accountId
  }) as { banned_at: string; reason: string } | null;
  if (res) {
    return { bannedAt: res.banned_at, reason: res.reason };
  }
  return null;
}

export function banAccount(accountId: string, reason: string) {
  const db = getDB();
  const bannedAt = new Date().toISOString();
  db.query("INSERT OR REPLACE INTO bans (account_id, banned_at, reason) VALUES ($accountId, $bannedAt, $reason)").run({
    $accountId: accountId,
    $bannedAt: bannedAt,
    $reason: reason
  });
}

export function unbanAccount(accountId: string) {
  const db = getDB();
  db.query("DELETE FROM bans WHERE account_id = $accountId").run({
    $accountId: accountId
  });
}
