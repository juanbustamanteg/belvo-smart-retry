// Copies the two challenge CSVs into the GitHub Pages demo build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(web, "..", "..");
mkdirSync(join(web, "dist-demo", "data"), { recursive: true });
for (const f of ["PaymentsPM_Challenge_payment_requests.csv", "PaymentsPM_Challenge_loan_info.csv"])
  copyFileSync(join(root, f), join(web, "dist-demo", "data", f));
console.log("copied challenge data into dist-demo/data");
