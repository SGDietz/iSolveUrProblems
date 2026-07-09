import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { EXPORT_TABLES, type ExportTable } from "./dataInventory";

/**
 * Per-user data export (Privacy Policy §14 "ask for a copy of your
 * information" / §15 CCPA right-to-know). Ported from aiASAP's proven
 * design 2026-07-08:
 *
 * - gatherUserExport pulls every per-user row via service-role PostgREST
 *   (RLS keeps several of these tables invisible to the user's own
 *   session client — export MUST run server-side).
 * - The chooser page renders NO data — just two checkboxes. A leaked or
 *   intercepted link shows nothing until someone deliberately clicks
 *   Download, and the file comes from the same token-gated route.
 * - Category 1 (default ON): what 6 keeps FOR you — profile, memory,
 *   lists, appointments, contracts, disputes, and the rest.
 * - Category 2 (opt-in): the full conversation history — "this can be a
 *   lot" (the Google/Meta profile-first pattern).
 */

export type UserExport = {
  export_format: "iSolveUrProblems-user-data-v1";
  exported_at: string;
  account: { user_id: string; email: string | null };
  data: Partial<
    Record<ExportTable | "account_email_links", Array<Record<string, unknown>>>
  >;
};

type Row = Record<string, unknown>;

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_TABLE = 20; // 20k rows/table — far past any beta account

// user_memory_facts carries a 1536-dim embedding vector — machine data,
// never useful in a human-readable copy. account_email_links holds a
// token_hash that must never leave the server. Everything else exports
// whole.
const TABLE_SELECT: Partial<Record<ExportTable | "account_email_links", string>> = {
  user_memory_facts: "id,kind,content,session_id,created_at",
  account_email_links: "id,email,session_id,captured_lists,expires_at,used_at,created_at",
};

// Two tables link the user under a different column name — a plain
// user_id filter would 400 and silently export nothing (caught in the
// 2026-07-09 pre-commit review).
const FILTER_COLUMN: Record<string, string> = {
  users: "id",
  crew_requests: "requester_user_id",
  contractor_claim_attempts: "attempted_by_user_id",
  account_email_links: "email",
};

async function fetchTableRows(
  table: string,
  filterValue: string,
  cfg: { url: string; serviceRoleKey: string },
): Promise<Row[]> {
  const headers = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  };
  const select = TABLE_SELECT[table as ExportTable] ?? "*";
  const filterColumn = FILTER_COLUMN[table] ?? "user_id";
  const base =
    `${cfg.url}/rest/v1/${table}?${filterColumn}=eq.${encodeURIComponent(filterValue)}` +
    `&select=${encodeURIComponent(select)}`;
  const rows: Row[] = [];
  // Deterministic paging needs a stable ORDER BY — limit/offset over an
  // unordered query can skip or duplicate rows across pages. Legacy
  // tables that lack created_at fall back to a single unordered page.
  let ordered = true;
  for (let page = 0; page < MAX_PAGES_PER_TABLE; page++) {
    try {
      const url =
        base +
        (ordered ? "&order=created_at.asc" : "") +
        `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (ordered && page === 0) {
          ordered = false;
          const retry = await fetch(`${base}&limit=${PAGE_SIZE}`, { headers });
          if (!retry.ok) break;
          rows.push(...((await retry.json().catch(() => [])) as Row[]));
        }
        break;
      }
      const batch = (await res.json().catch(() => [])) as Row[];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    } catch {
      break;
    }
  }
  return rows;
}

/**
 * Never throws mid-gather: a table that errors exports as an empty list
 * rather than sinking the whole download.
 */
export async function gatherUserExport(
  userId: string,
  email: string | null,
): Promise<UserExport> {
  const payload: UserExport = {
    export_format: "iSolveUrProblems-user-data-v1",
    exported_at: new Date().toISOString(),
    account: { user_id: userId, email },
    data: {},
  };
  let cfg: { url: string; serviceRoleKey: string };
  try {
    cfg = getSupabaseAdminConfig();
  } catch {
    return payload;
  }
  for (const table of EXPORT_TABLES) {
    payload.data[table] = await fetchTableRows(table, userId, cfg);
  }
  // Email-keyed magic-link records — part of "a complete copy of exactly
  // what deletion erases" (token_hash excluded via TABLE_SELECT).
  if (email) {
    payload.data.account_email_links = await fetchTableRows(
      "account_email_links",
      email,
      cfg,
    );
  }
  return payload;
}

// ─── Rendering helpers ──────────────────────────────────────────────

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-07-08T…" → "Jul 8, 2026" — string math, no timezone surprises. */
export function fmtDay(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso.slice(0, 10);
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? m[2]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function money(cents: unknown): string {
  return typeof cents === "number" && Number.isFinite(cents)
    ? `$${(cents / 100).toFixed(2)}`
    : "";
}

function section(title: string, lines: string[]): string[] {
  return [title, ...(lines.length > 0 ? lines : ["  (nothing saved yet)"]), ""];
}

function byCreatedAt(a: Row, b: Row): number {
  return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
}

/**
 * The "what 6 keeps for you" text — everything except conversation
 * history, in plain words.
 */
export function renderProfileText(payload: UserExport): string {
  const d = payload.data;
  const out: string[] = [
    "YOUR iSOLVEURPROBLEMS DATA",
    `Downloaded ${fmtDay(payload.exported_at)} for ${payload.account.email ?? "your account"}`,
    "This is what 6 keeps for you. You can tell 6 to forget any of it, any time.",
    "",
  ];

  const profile = (d.users ?? [])[0];
  out.push(
    ...section("ABOUT YOUR ACCOUNT", [
      profile ? `  Name: ${str(profile.full_name) || "(not saved)"}` : "  (no profile row)",
      ...(profile
        ? [
            `  Email: ${str(profile.email) || "(not saved)"}`,
            `  Phone: ${str(profile.phone) || "(not saved)"}`,
          ]
        : []),
    ]),
  );

  out.push(
    ...section(
      "WHAT 6 REMEMBERS ABOUT YOU",
      (d.user_memory_facts ?? [])
        .slice()
        .sort(byCreatedAt)
        .map((f) => `  - ${str(f.content)}`)
        .filter((line) => line.trim() !== "-"),
    ),
  );

  const contactLines: string[] = [];
  const seenContacts = new Set<string>();
  for (const c of d.contact_entities ?? []) {
    const name = str(c.full_name) || str(c.name) || "Someone";
    const cEmail = str(c.email);
    const key = `${name}|${cEmail}`.toLowerCase();
    if (seenContacts.has(key)) continue;
    seenContacts.add(key);
    if (cEmail && cEmail.toLowerCase() === (payload.account.email ?? "").toLowerCase()) {
      continue; // the account's own address isn't a "person you told 6 about"
    }
    const detail = [cEmail, str(c.phone)].filter(Boolean).join(", ");
    contactLines.push(`  - ${name}${detail ? ` (${detail})` : ""}`);
  }
  out.push(...section("PEOPLE YOU TOLD 6 ABOUT", contactLines));

  const listItems = d.list_items ?? [];
  const listLines: string[] = [];
  for (const list of (d.lists ?? []).slice().sort(byCreatedAt)) {
    listLines.push(`  ${str(list.title) || "Untitled list"}`);
    const items = listItems
      .filter((i) => i.list_id === list.id)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
    for (const item of items) listLines.push(`    - ${str(item.title)}`);
    if (items.length === 0) listLines.push("    (empty)");
  }
  out.push(...section("YOUR LISTS", listLines));

  out.push(
    ...section(
      "YOUR APPOINTMENTS",
      (d.appointments ?? [])
        .slice()
        .sort(byCreatedAt)
        .map(
          (a) =>
            `  - ${fmtDay(a.scheduled_at)} — ${str(a.agenda) || "appointment"} (${str(a.status) || "scheduled"})`,
        ),
    ),
  );

  out.push(
    ...section(
      "YOUR RECURRING JOBS",
      (d.recurring_jobs ?? []).map((r) => `  - ${str(r.title) || "recurring job"}`),
    ),
  );

  out.push(
    ...section(
      "YOUR CONTRACTS",
      (d.contracts ?? [])
        .slice()
        .sort(byCreatedAt)
        .map(
          (c) =>
            `  - ${fmtDay(c.created_at)} — ${str(c.category) || "work"}${
              money(c.amount_cents) ? `, ${money(c.amount_cents)}` : ""
            } (${str(c.status) || "created"})`,
        ),
    ),
  );

  out.push(
    ...section(
      "YOUR ESTIMATES",
      (d.estimates ?? []).map(
        (e) =>
          `  - ${str(e.scope_summary) || "estimate"}${
            money(e.total_cents) ? ` — ${money(e.total_cents)}` : ""
          }`,
      ),
    ),
  );

  out.push(
    ...section(
      "YOUR DISPUTES",
      (d.disputes ?? []).map(
        (x) => `  - ${fmtDay(x.created_at)} — ${str(x.complaint).slice(0, 120) || "dispute"} (${str(x.status)})`,
      ),
    ),
  );

  out.push(
    ...section(
      "YOUR FIX-IT REPORTS",
      (d.reports ?? [])
        .slice()
        .sort(byCreatedAt)
        .map((r) => `  - ${fmtDay(r.created_at)} — ${str(r.title) || "report"}`),
    ),
  );

  out.push(
    ...section(
      "CALLS 6 MADE FOR YOU",
      (d.calls ?? [])
        .slice()
        .sort(byCreatedAt)
        .map((c) => `  - ${fmtDay(c.created_at)} — ${str(c.status) || "call"}`),
    ),
  );

  out.push(
    ...section(
      "MESSAGES WE'VE SENT YOU",
      (d.notifications_sent ?? [])
        .slice()
        .sort(byCreatedAt)
        .map(
          (n) =>
            `  - ${fmtDay(n.created_at)} — ${str(n.channel)} ${str(n.template_id)} (${str(n.status)})`,
        ),
    ),
  );

  // Completeness: every remaining gathered table renders here raw, so
  // the download really is a full copy of what deletion erases — not
  // just the pretty sections above. (Conversation tables live in the
  // separate history download.)
  const renderedElsewhere = new Set([
    "users",
    "user_memory_facts",
    "contact_entities",
    "lists",
    "list_items",
    "appointments",
    "recurring_jobs",
    "contracts",
    "estimates",
    "disputes",
    "reports",
    "calls",
    "notifications_sent",
    "transcripts",
    "conversation_messages",
  ]);
  const rawLines: string[] = [];
  for (const [table, rows] of Object.entries(d)) {
    if (renderedElsewhere.has(table)) continue;
    if (!Array.isArray(rows) || rows.length === 0) continue;
    rawLines.push(`  ${table} — ${rows.length} record${rows.length === 1 ? "" : "s"}`);
    for (const row of rows) {
      const compact = Object.fromEntries(
        Object.entries(row).filter(([, v]) => v !== null && v !== undefined),
      );
      rawLines.push(`    ${JSON.stringify(compact)}`);
    }
  }
  if (rawLines.length > 0) {
    out.push(...section("MORE RECORDS WE KEEP (raw)", rawLines));
  }

  out.push(
    "Note: this is everything 6 keeps for you — your full word-for-word",
    "chat history is a separate download you can pick on the download page.",
    "",
    "That's everything iSolveUrProblems keeps about you. — 6",
  );
  return out.join("\n");
}

/**
 * The opt-in conversation history. Two pipelines store voice turns
 * (transcripts = per-utterance; conversation_messages = the LiveAvatar
 * sync feed) — both render, honestly labeled, since neither alone is the
 * complete record.
 */
export function renderHistoryText(payload: UserExport): string {
  const out: string[] = [
    "YOUR CONVERSATION HISTORY WITH 6",
    `For ${payload.account.email ?? "your account"}`,
    "(Two recorders run during a session, so some lines can appear in both parts.)",
    "",
    "— PART 1: VOICE TURNS —",
  ];
  // Batch-synced rows can share one created_at (a single INSERT stamps
  // the whole batch) — la_absolute_timestamp then id break the tie so
  // turns render in spoken order, deterministically.
  const byTurnOrder = (a: Row, b: Row): number =>
    byCreatedAt(a, b) ||
    String(a.la_absolute_timestamp ?? "").localeCompare(
      String(b.la_absolute_timestamp ?? ""),
    ) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""));
  const renderTurns = (
    rows: Row[],
    speakerOf: (r: Row) => string,
    textOf: (r: Row) => string,
  ) => {
    let lastDay = "";
    const lines: string[] = [];
    for (const r of rows.slice().sort(byTurnOrder)) {
      const text = textOf(r);
      if (!text) continue;
      if (/^\s*\[[^\]]{0,120}not spoken by user\]/i.test(text)) continue; // machine-injected
      const day = fmtDay(r.created_at);
      if (day && day !== lastDay) {
        lines.push("", `[${day}]`);
        lastDay = day;
      }
      lines.push(`  ${speakerOf(r)}: ${text}`);
    }
    return lines.length > 0 ? lines : ["  (no saved conversation yet)"];
  };
  out.push(
    ...renderTurns(
      payload.data.transcripts ?? [],
      (r) => (r.speaker === "user" ? "You" : "6 "),
      (r) => str(r.text),
    ),
  );
  out.push("", "— PART 2: SESSION FEED —");
  out.push(
    ...renderTurns(
      payload.data.conversation_messages ?? [],
      (r) => (r.role === "user" ? "You" : "6 "),
      (r) => str(r.message),
    ),
  );
  return out.join("\n");
}

export function buildExportFile(
  payload: UserExport,
  include: { profile: boolean; history: boolean },
): string {
  const parts: string[] = [];
  if (include.profile) parts.push(renderProfileText(payload));
  if (include.history) parts.push(renderHistoryText(payload));
  if (parts.length === 0) parts.push("Nothing was selected to download.");
  return parts.join(`\n\n${"=".repeat(56)}\n\n`);
}

function escHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The checkbox chooser page. Deliberately renders NO user data — only
 * the account email in the subtitle. The button's JS fetches the chosen
 * categories from this same token-gated route and saves the file
 * client-side. Self-contained inline styles: brand gold-on-dark-brown,
 * no external assets.
 */
export function renderChooserHtml(email: string | null): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Your iSolveUrProblems data</title>
<style>
  body{margin:0;padding:40px 16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    background:radial-gradient(circle at 50% 20%,#341d07 0%,#130a03 70%);min-height:100vh;color:#ffe9c2}
  .card{max-width:480px;margin:0 auto;border:2px solid rgba(224,170,98,.85);border-radius:14px;
    background:linear-gradient(180deg,rgba(52,29,7,.92),rgba(19,10,3,.92));padding:28px 24px;
    box-shadow:inset 0 1px 10px rgba(255,255,255,.08),0 10px 28px rgba(0,0,0,.5)}
  h1{margin:0 0 4px;font-size:24px;background:linear-gradient(180deg,#ffe9c2 0%,#d7a05a 55%,#b07a3e 100%);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .sub{margin:0 0 20px;font-size:13px;color:rgba(232,185,106,.85)}
  label{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:10px;cursor:pointer;
    border:1px solid rgba(224,170,98,.35);margin-bottom:10px;font-size:14px;line-height:1.45}
  label b{display:block;color:#ffe9c2}
  label span{color:rgba(255,233,194,.75);font-size:12.5px}
  input[type=checkbox]{margin-top:3px;accent-color:#d7a05a;width:16px;height:16px}
  button{width:100%;margin-top:8px;padding:13px 20px;border-radius:999px;border:2px solid rgba(224,170,98,.85);
    background:linear-gradient(180deg,#ffe9c2,#d7a05a 55%,#9e6a35);color:#2a1606;font-weight:700;
    font-size:15px;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .foot{margin-top:18px;font-size:12px;color:rgba(255,233,194,.6);text-align:center;line-height:1.5}
</style></head><body>
<div class="card">
  <h1>Your data, your copy</h1>
  <p class="sub">${escHtml(email ?? "Your iSolveUrProblems account")}</p>
  <label><input type="checkbox" id="profile" checked>
    <span><b>What 6 keeps for you</b><span>Your profile, memory notes, lists, appointments, contracts, disputes, and reports.</span></span></label>
  <label><input type="checkbox" id="history">
    <span><b>Your full conversation history</b><span>Every saved word between you and 6. This can be a lot.</span></span></label>
  <button id="dl">Download my data</button>
  <p class="foot">Nothing shows on this page and nothing downloads until you click.
    We never sell your data. To delete any of it, just ask 6.</p>
</div>
<script>
(function(){
  var btn=document.getElementById("dl");
  btn.addEventListener("click",function(){
    var inc=[];
    if(document.getElementById("profile").checked)inc.push("profile");
    if(document.getElementById("history").checked)inc.push("history");
    if(inc.length===0){btn.textContent="Pick at least one above";return;}
    var token=new URLSearchParams(location.search).get("token")||"";
    btn.disabled=true;btn.textContent="Preparing your file...";
    fetch("/api/account/download?token="+encodeURIComponent(token)+"&format=file&include="+inc.join(","))
      .then(function(r){if(!r.ok)throw new Error("bad status");return r.text();})
      .then(function(t){
        var blob=new Blob([t],{type:"text/plain;charset=utf-8"});
        var a=document.createElement("a");
        a.href=URL.createObjectURL(blob);
        a.download="iSolveUrProblems-my-data.txt";
        document.body.appendChild(a);a.click();a.remove();
        btn.disabled=false;btn.textContent="Downloaded — need it again?";
      })
      .catch(function(){btn.disabled=false;btn.textContent="Hmm — try again";});
  });
})();
</script>
</body></html>`;
}
