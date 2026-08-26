import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Write the deterministic subprocess hook consumed only by transaction race tests.
 *
 * @param root - Private test directory that receives the hook script.
 * @returns Absolute pathname of the written hook script.
 */
export async function writeTransactionRaceHook(root: string): Promise<string> {
  const path = join(root, 'transaction-race-hook.py')
  await writeFile(path, `#!/usr/bin/env python3
import os
import sys

stage, subject = sys.argv[1:3]
if stage != os.environ["RACE_STAGE"] or subject != os.environ["RACE_SUBJECT"]:
    raise SystemExit(0)
sentinel = os.environ["RACE_SENTINEL"]
try:
    descriptor = os.open(sentinel, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit(0)
else:
    os.close(descriptor)
action = os.environ["RACE_ACTION"]
if action == "swap-directory":
    os.rename(os.environ["RACE_SOURCE"], os.environ["RACE_DISPLACED"])
    os.symlink(os.environ["RACE_OUTSIDE"], os.environ["RACE_SOURCE"], target_is_directory=True)
elif action == "swap-marker":
    os.rename(os.environ["RACE_SOURCE"], os.environ["RACE_DISPLACED"])
    os.symlink(os.environ["RACE_OUTSIDE"], os.environ["RACE_SOURCE"])
else:
    raise RuntimeError("unknown race action")
`)
  await chmod(path, 0o700)
  return path
}
