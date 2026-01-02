// check_accessible_sites.js
import fs from "fs";
import fetch from "node-fetch";
import { setTimeout as delay } from "timers/promises";

const INPUT_FILE = "sites.txt";       // input: list of domains
const OUTPUT_FILE = "accessible.txt";   // output: reachable ones
const TIMEOUT_MS = 5000;                // request timeout (5s)
const CONCURRENCY = 50;                 // number of parallel checks

// Helper: timeout wrapper
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Check one domain with HTTPS → HTTP fallback
async function checkDomain(domain) {
  domain = domain.trim();
  if (!domain) return null;

  const urls = domain.startsWith("http")
    ? [domain]
    : [`https://${domain}`, `http://${domain}`];

  for (const url of urls) {
    const ok = await fetchWithTimeout(url, TIMEOUT_MS);
    if (ok) return domain;
  }
  return null;
}

// Concurrency control (simple queue)
async function processDomains(domains) {
  const results = [];
  let index = 0;
  const total = domains.length;

  async function worker() {
    while (index < total) {
      const i = index++;
      const domain = domains[i];
      const result = await checkDomain(domain);
      if (result) {
        console.log(`✅ ${result}`);
        results.push(result);
      } else {
        console.log(`❌ ${domain}`);
      }
      await delay(50); // small delay to avoid hammering
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const domains = fs
    .readFileSync(INPUT_FILE, "utf8")
    .split("\n")
    .map((d) => d.trim())
    .filter(Boolean);

  console.log(`🔍 Checking ${domains.length} domains...`);

  const accessible = await processDomains(domains);

  fs.writeFileSync(OUTPUT_FILE, accessible.join("\n"), "utf8");
  console.log(`\n✅ Found ${accessible.length} accessible domains out of ${domains.length}.`);
  console.log(`📄 Saved results to ${OUTPUT_FILE}`);
}

main();
