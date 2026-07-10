// injection.mjs — эвристики prompt-injection для контента, попадающего в единственный
// писабельный тир (inbox/<agent>.md). Мы НИКОГДА не отбрасываем и не отклоняем контент —
// подозрительный текст помечается (quarantine) и оборачивается в fence-блок, чтобы память
// не терялась, но ни один нижестоящий агент/читатель не исполнил её вслепую.

const PATTERNS = [
  { label: 'ignore-previous-instructions', re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?)\b/i },
  { label: 'new-instructions', re: /\bnew\s+instructions?\s*:/i },
  { label: 'system-tag', re: /<\s*\/?\s*system\s*>/i },
  { label: 'role-tag', re: /<\|?\s*(system|assistant|user)\s*\|?>/i },
  { label: 'tool-use-marker', re: /\btool_use\b|\btool_result\b/i },
  { label: 'run-execute-command', re: /\b(run|execute)\s+(the\s+following\s+|this\s+|the\s+)?(command|script|code|shell)\b/i },
  { label: 'shell-injection', re: /\b(sudo\s+rm\s+-rf|curl\s+\S+\s*\|\s*sh|wget\s+\S+\s*\|\s*sh)\b/i },
  { label: 'role-override', re: /^\s*(system|assistant)\s*:/im },
];

/** Сканирует текст на паттерны prompt-injection. Возвращает { flagged, matches }. */
export function scanForInjection(text) {
  const s = String(text ?? '');
  const matches = [];
  for (const { label, re } of PATTERNS) {
    if (re.test(s)) matches.push(label);
  }
  return { flagged: matches.length > 0, matches };
}
