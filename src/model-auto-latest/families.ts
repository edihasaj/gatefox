/**
 * Pure model-ID helpers for auto-latest: which known family an ID belongs to, and which of two IDs is newer.
 *
 * Only exact, known ID shapes are recognized. Nothing is guessed from a prefix, a suffix or a similar name, and an ID
 * the helpers do not understand is never ranked. Numeric versions decide first (6.10 is newer than 6.9). A date only
 * separates two IDs that share the same semantic version, and only when both dates are known. The time the gateway
 * first saw a model is never an input. Nothing here logs, reads files or touches the network.
 */
import { maximumReleasedAt, minimumReleasedAt } from "./metadata.js";

export interface ParsedModelId {
  /** The exact known family, for example `gpt-sol` or `claude-opus`. */
  family: string;
  /** Numeric version segments, at most three; empty for a floating ID. */
  version: number[];
  /** UTC seconds at the start of the date in the ID, when the ID carries a valid `YYYYMMDD` date. */
  date?: number;
  /** A floating ID (`gpt-daybreak-blue-latest`): the family is recognized, but the ID is only ever matched exactly. */
  floating?: true;
}

export interface ComparableModel { id: string; releasedAt?: number }

const maximumIdLength = 128;
const segment = "(?:0|[1-9]\\d{0,2})";
// GPT: dotted version before the family. Claude: family before a dashed or dotted version (one separator style only).
const gpt = new RegExp(`^gpt-(${segment}(?:\\.${segment}){0,2})-(astra|sol|terra|luna)(?:-(\\d{8}))?$`);
const claudeDotted = new RegExp(`^claude-(fable|opus|sonnet|haiku)-(${segment}(?:\\.${segment}){0,2})(?:-(\\d{8}))?$`);
const claudeDashed = new RegExp(`^claude-(fable|opus|sonnet|haiku)-(${segment}(?:-${segment}){0,2})(?:-(\\d{8}))?$`);
/** The only floating ID: recognized as a family, never ranked, never auto-changed. */
const floatingIds = new Map<string, string>([["gpt-daybreak-blue-latest", "gpt-daybreak-blue"]]);

/** A valid calendar `YYYYMMDD` in the accepted release range, as UTC seconds; otherwise undefined. */
function idDate(digits: string): number | undefined {
  const year = Number(digits.slice(0, 4)), month = Number(digits.slice(4, 6)), day = Number(digits.slice(6, 8));
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return undefined;
  const seconds = value.getTime() / 1000;
  return seconds >= minimumReleasedAt && seconds < maximumReleasedAt ? seconds : undefined;
}

const numbers = (text: string): number[] => text.split(/[.-]/).map(Number);

/** The parsed form of an ID, or undefined for anything that is not an exact known shape. */
export function parseModelId(id: string): ParsedModelId | undefined {
  if (typeof id !== "string" || !id || id.length > maximumIdLength) return undefined;
  const floating = floatingIds.get(id);
  if (floating) return { family: floating, version: [], floating: true };
  let family: string, version: string, digits: string | undefined;
  const openai = gpt.exec(id);
  if (openai) { family = `gpt-${openai[2]}`; version = openai[1]!; digits = openai[3]; }
  else {
    const claude = claudeDotted.exec(id) ?? claudeDashed.exec(id);
    if (!claude) return undefined;
    family = `claude-${claude[1]}`; version = claude[2]!; digits = claude[3];
  }
  const parsed: ParsedModelId = { family, version: numbers(version) };
  if (digits !== undefined) {
    const date = idDate(digits);
    if (date === undefined) return undefined;
    parsed.date = date;
  }
  return parsed;
}

/** The exact known family of an ID, or undefined. */
export function familyOf(id: string): string | undefined {
  return parseModelId(id)?.family;
}

/** A release instant in UTC seconds, or undefined when it is absent, not finite, or outside the accepted range. */
function explicitDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimumReleasedAt && value < maximumReleasedAt ? Math.floor(value) : undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Positive when `a` is the newer model, negative when `b` is, and zero when they are the same, in different families,
 * unrecognized, floating, or cannot be told apart. Zero is never broken by ID order or by when a model was first seen.
 */
export function compareModels(a: ComparableModel, b: ComparableModel): number {
  if (!a || !b || a.id === b.id) return 0;
  const left = parseModelId(a.id), right = parseModelId(b.id);
  if (!left || !right || left.family !== right.family || left.floating || right.floating) return 0;
  const byVersion = compareVersions(left.version, right.version);
  if (byVersion !== 0) return byVersion;
  // Same semantic version: a date separates them only when both are known. An explicit release time wins over an ID date.
  const leftExplicit = explicitDate(a.releasedAt), rightExplicit = explicitDate(b.releasedAt);
  const leftDate = leftExplicit ?? left.date, rightDate = rightExplicit ?? right.date;
  if (leftDate === undefined || rightDate === undefined) return 0;
  // An ID date has day precision, so a comparison involving one is made on whole days.
  const days = leftExplicit === undefined || rightExplicit === undefined;
  const x = days ? Math.floor(leftDate / 86400) : leftDate, y = days ? Math.floor(rightDate / 86400) : rightDate;
  return x === y ? 0 : x > y ? 1 : -1;
}
