// Admin commands. Run on the server, next to server.js:
//   node scripts/admin.js invite [uses] [note]   create an invite code (default: 1 use)
//   node scripts/admin.js invites                list invite codes
//   node scripts/admin.js users                  list accounts
//   node scripts/admin.js reset-password EMAIL   set a temporary password and sign the user out everywhere
//   node scripts/admin.js delete-user EMAIL      delete an account and all its data
//   node scripts/admin.js backup FILE            copy the database to FILE while the app runs
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";
import { openDb } from "../lib/db.js";
import { hashPassword, randomCode } from "../lib/auth.js";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(join(APP_DIR, ".env"));
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : join(APP_DIR, config.dataDir);
const db = openDb(join(dataDir, "unspoken.db"));

const date = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const [command, ...args] = process.argv.slice(2);

function need(value, usage) {
  if (!value) {
    console.error(`Usage: node scripts/admin.js ${usage}`);
    process.exit(1);
  }
  return value;
}

function userOrExit(email) {
  const user = db.userByEmail(email);
  if (!user) {
    console.error(`No account for ${email}`);
    process.exit(1);
  }
  return user;
}

switch (command) {
  case "invite": {
    const uses = Number(args[0] || 1);
    if (!Number.isInteger(uses) || uses < 1) need(null, "invite [uses] [note]");
    const code = randomCode(6).toUpperCase();
    db.createInvite(code, uses, args.slice(1).join(" "));
    console.log(`Invite code: ${code}  (${uses} use${uses > 1 ? "s" : ""})`);
    break;
  }
  case "invites":
    for (const i of db.listInvites()) console.log(`${i.code}  uses left: ${i.uses_left}  ${date(i.created_at)}  ${i.note}`);
    break;
  case "users":
    for (const u of db.listUsers()) console.log(`${u.email}  joined ${date(u.created_at)}  notes: ${u.notes}  materials: ${u.docs}`);
    break;
  case "reset-password": {
    const user = userOrExit(need(args[0], "reset-password EMAIL"));
    const temporary = randomCode(9);
    db.updatePassword(user.id, await hashPassword(temporary));
    db.deleteUserSessions(user.id);
    console.log(`Temporary password for ${user.email}: ${temporary}`);
    console.log("Send it privately; they should change it in Account settings after logging in.");
    break;
  }
  case "delete-user": {
    const user = userOrExit(need(args[0], "delete-user EMAIL"));
    db.deleteUser(user.id);
    console.log(`Deleted ${user.email} and all their notes, materials and progress.`);
    break;
  }
  case "backup": {
    const file = need(args[0], "backup FILE");
    db.backupTo(file);
    console.log(`Backed up to ${file}`);
    break;
  }
  default:
    console.log(`Commands:
  invite [uses] [note]   create an invite code (default: 1 use)
  invites                list invite codes
  users                  list accounts
  reset-password EMAIL   set a temporary password and sign the user out everywhere
  delete-user EMAIL      delete an account and all its data
  backup FILE            copy the database to FILE while the app runs`);
}
db.close();
