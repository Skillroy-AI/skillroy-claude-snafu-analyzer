/**
 * Heuristic signal extraction. These regexes are deliberately generous — the tool is a triage aid,
 * so a few false positives are acceptable; a human (or the optional Claude pass) makes the call.
 */
import type { Signal, SignalType, Role } from "./types.js";

interface Rule {
  type: SignalType;
  re: RegExp;
}

const RULES: Rule[] = [
  // Things that were going to happen but might not have.
  { type: "todo", re: /\bTODO\b/i },
  { type: "todo", re: /^\s*[-*]\s+\[ \]\s+/m },
  { type: "todo", re: /\bnext step\b/i },
  { type: "todo", re: /\bfollow[- ]?up\b/i },
  { type: "todo", re: /\bcircle back\b/i },
  { type: "todo", re: /\b(?:defer(?:red)?|punt(?:ed)?)\b/i },
  { type: "todo", re: /\bI(?:'ll| will)\b[^.?!\n]{0,60}\b(?:next|later|afterwards?|once)\b/i },

  // Decisions (the things most worth persisting).
  { type: "decision", re: /\bdecision\b/i },
  { type: "decision", re: /\bwe(?:'ve| have)? (?:decided|agreed|chose|settled on)\b/i },
  { type: "decision", re: /\blet'?s go with\b/i },
  { type: "decision", re: /\bgoing with\b/i },
  { type: "decision", re: /\bI recommend\b/i },
  { type: "decision", re: /\b(?:dec)-[a-z0-9]+/i },

  // Questions / choices kicked back to the human.
  { type: "open_question", re: /\bOPEN (?:DECISION|QUESTION)\b/i },
  { type: "open_question", re: /\bwaiting on (?:you|the human)\b/i },
  { type: "open_question", re: /\bdo you (?:have a preference|want|prefer)\b/i },
  { type: "open_question", re: /\b(?:question|decisions?) (?:for|waiting on) you\b/i },
  { type: "open_question", re: /\byour call\b/i },
  { type: "open_question", re: /\bneeds? (?:your|human|a human)\b/i },

  // Strong assertions — the raw material for spotting drift/contradiction across sessions.
  { type: "claim", re: /\bsingle source of truth\b/i },
  { type: "claim", re: /\bsource of truth\b/i },
  { type: "claim", re: /\bauthoritative\b/i },
  { type: "claim", re: /\bis now\b[^.?!\n]{0,50}\b(?:enforced?|the|a|complete|canonical)\b/i },
  { type: "claim", re: /\bno longer\b/i },
  { type: "claim", re: /\bcanonical\b/i },

  { type: "commit", re: /\bgit commit\b/i },
  { type: "commit", re: /\bcommitted\b/i },
  { type: "commit", re: /\bpushed (?:to|up)\b/i },

  { type: "memory_write", re: /\bMEMORY\.md\b/ },
  { type: "memory_write", re: /\b(?:saved|wrote|persist(?:ed)?) (?:it )?to memory\b/i },

  { type: "file_move", re: /\bgit mv\b/i },
  { type: "file_move", re: /\b(?:moved?|relocat(?:e|ed)|rename[d]?)\b[^.?!\n]{0,40}\b(?:folder|directory|repo|file|to)\b/i },
  { type: "file_move", re: /\bmv\s+\S+\s+\S+/ },

  { type: "handover", re: /\bHANDOVER\b/ },
  { type: "handover", re: /\bhand[- ]?off\b/i },
  { type: "handover", re: /\brestart instructions\b/i },

  { type: "wrong_folder", re: /\bwrong (?:folder|directory|repo)\b/i },
  { type: "wrong_folder", re: /\borphan(?:ed)?\b/i },
  { type: "wrong_folder", re: /\brunning (?:from|in)\b[^.?!\n]{0,40}\b(?:wrong|moved|old|orphan)\b/i },
  { type: "wrong_folder", re: /\bmoved folder\b/i },
];

const ID_RE = /\b(?:dec|t|q|b|wish|task)-[a-z0-9]{2,}/gi;
const FILE_RE = /\b[\w.-]+\.(?:ts|js|tsx|jsx|py|md|json|html|css|sql|yaml|yml|sh)\b/gi;

function keywordsFrom(text: string): string[] {
  const ids = text.match(ID_RE) || [];
  const files = text.match(FILE_RE) || [];
  return Array.from(new Set([...ids, ...files].map((s) => s.toLowerCase()))).slice(0, 8);
}

/** Return the line containing index `i`, collapsed and capped. */
function lineAround(text: string, i: number, cap = 240): string {
  let start = text.lastIndexOf("\n", i);
  let end = text.indexOf("\n", i);
  start = start === -1 ? 0 : start + 1;
  end = end === -1 ? text.length : end;
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (s.length > cap) s = s.slice(0, cap - 1) + "…";
  return s;
}

export function extractSignals(
  text: string,
  role: Role,
  sessionId: string,
  round: number,
  ts?: string,
): Signal[] {
  if (!text) return [];
  const out: Signal[] = [];
  const seen = new Set<string>();
  for (const { type, re } of RULES) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    let perRule = 0;
    while ((m = rx.exec(text)) && perRule < 4) {
      perRule++;
      const snippet = lineAround(text, m.index);
      const dedupe = type + "|" + snippet;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ type, role, text: snippet, sessionId, round, ts, keywords: keywordsFrom(snippet) });
      if (rx.lastIndex === m.index) rx.lastIndex++; // guard against zero-width matches
    }
  }
  return out;
}
