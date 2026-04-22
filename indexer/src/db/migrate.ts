// Running `tsx src/db/migrate.ts` is sufficient to create the SQLite DB —
// importing `./index.js` applies `schema.sql` on boot.
import { db } from "./index.js";
console.log("migrate: schema applied to", db.name);
db.close();
