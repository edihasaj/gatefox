import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { validateNativeModelPicker, type NativeModelPickerPlacement } from "./config.js";

/** The two presentation fields of the gateway configuration that a running desktop session may re-read on `model/list`. */
export interface NativePickerPreferences { nativeModelPicker?: string[]; nativeModelPickerPlacement?: NativeModelPickerPlacement }

/** A configuration file larger than this is never read for picker preferences. */
export const maximumPickerConfigBytes = 2 * 1024 * 1024;
/** A read that has not finished by now is abandoned, so a stalled file can never hold up a `model/list`. */
export const pickerReadTimeoutMs = 2000;

/**
 * Reads `nativeModelPicker` and `nativeModelPickerPlacement` from the gateway's own configuration file, and nothing else:
 * routes, accounts, credentials and defaults are never taken from here. The file must be a regular file owned by this user
 * and not a symbolic link, at most 2 MiB. It is opened non-blocking and checked with `fstat` before any read, so a FIFO or
 * device placed at the path is refused instead of hanging the open; the whole read is also bounded by a timeout. Absent
 * fields are returned absent (the user cleared them); an unreadable file or an invalid value throws, and the caller keeps
 * its last valid preferences. Errors never carry file content.
 */
export async function readNativePickerPreferences(path: string, timeoutMs = pickerReadTimeoutMs): Promise<NativePickerPreferences> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Picker preferences read timed out")), timeoutMs); timer.unref(); });
  const read = readBounded(path);
  // If the timeout wins, the abandoned read still closes its handle when it settles; its late outcome is ignored.
  read.catch(() => {});
  let text: string;
  try { text = await Promise.race([read, expired]); } finally { clearTimeout(timer); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Picker preferences file is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Picker preferences file must hold an object");
  const config = parsed as Record<string, unknown>;
  const placement = config.nativeModelPickerPlacement;
  if (placement !== undefined && placement !== "first" && placement !== "last" && placement !== "hidden") throw new Error("nativeModelPickerPlacement must be first, last or hidden");
  return {
    ...(config.nativeModelPicker === undefined ? {} : { nativeModelPicker: validateNativeModelPicker(config.nativeModelPicker) }),
    ...(placement === undefined ? {} : { nativeModelPickerPlacement: placement }),
  };
}

async function readBounded(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumPickerConfigBytes || (process.platform !== "win32" && info.uid !== process.getuid?.())) throw new Error("Picker preferences file is not a readable owned regular file");
    const bytes = Buffer.alloc(Math.min(info.size, maximumPickerConfigBytes) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // The file grew past the size it had at fstat: refuse rather than parse a partial or oversized document.
    if (length >= bytes.length) throw new Error("Picker preferences file changed while it was read");
    return bytes.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}
