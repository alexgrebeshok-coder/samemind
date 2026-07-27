// inject.mjs — one shared marker-block injector for every generated block samemind writes into
// an engine's instruction file (identity brief, install protocol, projected facts). brief.mjs's
// injectBrief and install.mjs's injectInstallBlock were byte-identical bar their marker names;
// this is the single implementation all three (+ project.mjs) call.
//
// Contract (unchanged from the originals):
//  - START/END markers present and END after START → replace the block in place, tail preserved.
//  - file missing or blank → written as just the block + trailing newline.
//  - file has foreign content but no markers → block appended after a blank-line separator.
// Text outside the markers is never touched. Atomic write (temp + rename). Parent dirs created
// by atomicWriteFileSync. Returns { file, created, replaced }.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from '../../lib/atomic-write.mjs';

export function injectBetweenMarkers(filePath, block, startMark, endMark) {
  const target = resolve(filePath);
  const exists = existsSync(target);
  const original = exists ? readFileSync(target, 'utf8') : '';

  const startIdx = original.indexOf(startMark);
  const endIdx = original.indexOf(endMark);

  let next;
  let replaced = false;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const tail = original.slice(endIdx + endMark.length);
    next = original.slice(0, startIdx) + block + tail;
    replaced = true;
  } else if (!exists || !original.trim()) {
    next = `${block}\n`;
  } else {
    next = `${original.replace(/\n*$/, '\n\n')}${block}\n`;
  }

  atomicWriteFileSync(target, next);
  return { file: target, created: !exists, replaced };
}
