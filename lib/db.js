// SQLite storage (Node's built-in node:sqlite). Every user-owned row is keyed by user_id,
// and every query below filters on it, so one account can never read another's data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT '',
     lang TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE invites (
     code TEXT PRIMARY KEY,
     uses_left INTEGER NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   );
   CREATE TABLE notes (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE docs (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE progress (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     course_id TEXT NOT NULL,
     done_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, course_id)
   );`,
];

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  return createRepo(db);
}

/** All database access goes through these functions. */
function createRepo(db) {
  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  const stmts = {
    userByEmail: q("SELECT * FROM users WHERE email = ?"),
    userById: q("SELECT * FROM users WHERE id = ?"),
    insertUser: q("INSERT INTO users (email, password_hash, role, lang, created_at) VALUES (?, ?, '', ?, ?)"),
    updatePassword: q("UPDATE users SET password_hash = ? WHERE id = ?"),
    updateProfile: q("UPDATE users SET role = ?, lang = ? WHERE id = ?"),
    deleteUser: q("DELETE FROM users WHERE id = ?"),
    listUsers: q(`SELECT u.id, u.email, u.created_at,
                    (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS notes,
                    (SELECT COUNT(*) FROM docs d WHERE d.user_id = u.id) AS docs
                  FROM users u ORDER BY u.created_at`),

    insertSession: q("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    sessionUser: q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: q("DELETE FROM sessions WHERE token_hash = ?"),
    deleteUserSessions: q("DELETE FROM sessions WHERE user_id = ?"),
    deleteOtherSessions: q("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?"),
    purgeSessions: q("DELETE FROM sessions WHERE expires_at <= ?"),

    insertInvite: q("INSERT INTO invites (code, uses_left, note, created_at) VALUES (?, ?, ?, ?)"),
    useInvite: q("UPDATE invites SET uses_left = uses_left - 1 WHERE code = ? AND uses_left > 0"),
    listInvites: q("SELECT * FROM invites ORDER BY created_at DESC"),

    listNotes: q("SELECT id, title, body, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC"),
    countNotes: q("SELECT COUNT(*) AS n FROM notes WHERE user_id = ?"),
    noteExists: q("SELECT 1 AS x FROM notes WHERE user_id = ? AND id = ?"),
    upsertNote: q(`INSERT INTO notes (user_id, id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, body = excluded.body,
                     updated_at = excluded.updated_at`),
    deleteNote: q("DELETE FROM notes WHERE user_id = ? AND id = ?"),

    listDocs: q("SELECT id, title, name, text, added_at FROM docs WHERE user_id = ? ORDER BY added_at DESC"),
    countDocs: q("SELECT COUNT(*) AS n FROM docs WHERE user_id = ?"),
    docExists: q("SELECT 1 AS x FROM docs WHERE user_id = ? AND id = ?"),
    upsertDoc: q(`INSERT INTO docs (user_id, id, title, name, text, added_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (user_id, id) DO UPDATE SET title = excluded.title, name = excluded.name,
                    text = excluded.text`),
    deleteDoc: q("DELETE FROM docs WHERE user_id = ? AND id = ?"),

    listProgress: q("SELECT course_id FROM progress WHERE user_id = ? ORDER BY done_at"),
    addProgress: q("INSERT INTO progress (user_id, course_id, done_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    removeProgress: q("DELETE FROM progress WHERE user_id = ? AND course_id = ?"),
  };

  const exists = (row) => row !== undefined;

  return {
    close: () => db.close(),
    /** Online copy to `file` (used by the backup script). */
    backupTo: (file) => db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`),

    // users
    userByEmail: (email) => stmts.userByEmail.get(email),
    userById: (id) => stmts.userById.get(id),
    listUsers: () => stmts.listUsers.all(),
    updatePassword: (userId, hash) => stmts.updatePassword.run(hash, userId),
    updateProfile: (userId, { role, lang }) => stmts.updateProfile.run(role, lang, userId),
    deleteUser: (userId) => stmts.deleteUser.run(userId).changes > 0,

    /** Creates the user and spends one invite use atomically. Returns the user id, or an error code. */
    registerWithInvite({ email, passwordHash, lang, invite }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (exists(stmts.userByEmail.get(email))) {
          db.exec("ROLLBACK");
          return { error: "email_taken" };
        }
        if (stmts.useInvite.run(invite).changes !== 1) {
          db.exec("ROLLBACK");
          return { error: "invite_invalid" };
        }
        const { lastInsertRowid } = stmts.insertUser.run(email, passwordHash, lang, now());
        db.exec("COMMIT");
        return { userId: Number(lastInsertRowid) };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    // sessions (only hashes of tokens are stored)
    insertSession: (tokenHash, userId, expiresAt) => stmts.insertSession.run(tokenHash, userId, now(), expiresAt),
    sessionUser: (tokenHash) => stmts.sessionUser.get(tokenHash, now()),
    deleteSession: (tokenHash) => stmts.deleteSession.run(tokenHash),
    deleteUserSessions: (userId) => stmts.deleteUserSessions.run(userId),
    deleteOtherSessions: (userId, keepHash) => stmts.deleteOtherSessions.run(userId, keepHash),
    purgeExpiredSessions: () => stmts.purgeSessions.run(now()),

    // invites
    createInvite: (code, uses, note) => stmts.insertInvite.run(code, uses, note, now()),
    listInvites: () => stmts.listInvites.all(),

    // notes
    listNotes: (userId) => stmts.listNotes.all(userId),
    countNotes: (userId) => stmts.countNotes.get(userId).n,
    noteExists: (userId, id) => exists(stmts.noteExists.get(userId, id)),
    upsertNote: (userId, n) => stmts.upsertNote.run(userId, n.id, n.title, n.body, n.createdAt, n.updatedAt),
    deleteNote: (userId, id) => stmts.deleteNote.run(userId, id).changes > 0,

    // uploaded materials
    listDocs: (userId) => stmts.listDocs.all(userId),
    countDocs: (userId) => stmts.countDocs.get(userId).n,
    docExists: (userId, id) => exists(stmts.docExists.get(userId, id)),
    upsertDoc: (userId, d) => stmts.upsertDoc.run(userId, d.id, d.title, d.name, d.text, d.addedAt),
    deleteDoc: (userId, id) => stmts.deleteDoc.run(userId, id).changes > 0,

    // course progress
    listProgress: (userId) => stmts.listProgress.all(userId).map((r) => r.course_id),
    addProgress: (userId, courseId) => stmts.addProgress.run(userId, courseId, now()),
    removeProgress: (userId, courseId) => stmts.removeProgress.run(userId, courseId),
  };
}
