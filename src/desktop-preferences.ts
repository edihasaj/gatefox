type Settings = Record<string, unknown>;
type Validator = (value: unknown) => boolean;

const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);
const boolean: Validator = value => typeof value === "boolean";
const string: Validator = value => typeof value === "string" && value.length <= 4096;
const nullableString: Validator = value => value === null || string(value);
const oneOf = (...values: string[]): Validator => value => typeof value === "string" && values.includes(value);
const number = (minimum: number, maximum: number, integer = false): Validator => value =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isInteger(value));
const strings: Validator = value => Array.isArray(value) && value.length <= 256 && value.every(string);

// Public desktop display keys from the installed app's SettingsStore schema.
// No engine, provider, permission, authentication, or command-handler settings.
const validators: Record<string, Validator> = {
  "enabled-reasoning-efforts": value => Array.isArray(value) && value.length <= efforts.size &&
    new Set(value).size === value.length && value.every(item => typeof item === "string" && efforts.has(item)),
  "show-ultra-in-model-picker-slider": boolean,
  followUpQueueMode: oneOf("queue", "steer", "interrupt"),
  conversationDetailMode: oneOf("STEPS_PROSE", "STEPS_COMMANDS", "STEPS_EXECUTION"),
  appearanceTheme: oneOf("system", "light", "dark"),
  appearanceDiffMarkerStyle: oneOf("color", "symbols"),
  "reduced-motion-preference": oneOf("system", "on", "off"),
  "confirm-before-close": oneOf("never", "keyboardOnly", "always"),
  composerEnterBehavior: oneOf("enter", "cmdIfMultiline", "cmdAlways"),
  reviewDelivery: oneOf("inline", "detached"),
  "notifications-turn-mode": oneOf("off", "unfocused", "always"),
  "primary-number-shortcut-target": oneOf("sidebar", "tabs"),
  "open-link-in-target-preference": oneOf("in-app-browser", "external-browser"),
  "open-local-url-in-target-preference": oneOf("in-app-browser", "external-browser"),
  "external-browser-link-shortcut": oneOf("unassigned", "primary", "alt", "primary-shift"),
  appshotDestination: oneOf("automatic", "last-chat", "new-chat"),
  "code-review-sidebar-layout": oneOf("compact", "detailed"),
  "code-review-github-link-target": oneOf("code-review-tab", "github"),
  "pet-visibility": oneOf("always-visible", "on-demand"),
  defaultTerminalLocation: oneOf("bottom", "right"),
  integratedTerminalShell: oneOf("powershell", "commandPrompt", "gitBash", "wsl"),
  sansFontSize: number(11, 16),
  codeFontSize: number(8, 24),
  pagesFontSize: number(12, 24),
  "browser-annotation-screenshots-mode": oneOf("always", "necessary"),
  "avatar-overlay-mascot-width-px": number(80, 224, true),
  localeOverride: nullableString,
  "selected-avatar-id": nullableString,
  microphoneInputDeviceId: value => value === null || (string(value) && value !== ""),
  dictationDictionary: strings,
  "browser-disabled-site-annotation-hostnames": strings,
  "browser-site-annotation-permission-answered-hostnames": strings,
};
for (const key of [
  "useOpenAISans", "useFontSmoothing", "usePointerCursors",
  "appshotAlwaysSendToMini", "appshotSoundEnabled", "browser-annotation-markers-visible",
  "browser-extensions-toolbar-visible", "browser-show-device-toolbar-in-new-tabs", "browser-show-full-url",
  "code-review-activity-notifications", "codex-micro-single-tap-agent-keys", "computerUseAlwaysHidePictureInPicture",
  "composer-predictions-enabled", "default-workspace-full-view", "mac-menu-bar-enabled",
  "chronicle-menu-bar-indicator-enabled", "latex-auto-compile", "sidebar-show-projects-in-recents", "dictationSoundsEnabled",
  "composerPlainTextMode", "show-context-window-usage", "show-educational-tips", "preventSleepWhileRunning",
  "keepRemoteControlAwakeWhilePluggedIn", "hotkey-window-projectless-default-enabled", "notifications-permissions-enabled",
  "notifications-questions-enabled", "notifications-dot-enabled", "pagesFullWidth", "pagesSmartPunctuationEnabled",
  "avatar-overlay-pet-visible", "realtimeVoiceScreenContextEnabled", "toys-audio-visualizer-enabled", "toys-confetti-enabled",
  "sidebarShowYourDotInRecents",
]) validators[key] = boolean;

// Appearance schemas vary between app builds. Bound JSON only for these known
// display keys; never permit arbitrary desktop names or executable handlers.
const structured = new Set([
  "appearanceLightChromeTheme", "appearanceDarkChromeTheme", "appearanceLightCodeThemeId", "appearanceDarkCodeThemeId",
  "code-review-sidebar-sections", "profile-pets-by-account", "profile-display-options-by-user-id", "preferred-file-viewers",
  "notifications-sound",
  "open-in-target-preferences",
]);
const prohibitedFields = /^(?:__proto__|prototype|constructor|auth(?:entication)?|authorization|credentials?|secrets?|password|api[_-]?key|(?:access|refresh|id|client|session)[_-]?token|token|model_providers?|sandbox(?:_policy|_mode)?|approval_policy|command|args)$/i;

function record(value: unknown): value is Settings {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedJson(value: unknown, depth = 0, budget = { entries: 2048, characters: 65536 }, ancestors = new Set<object>()): boolean {
  if (depth > 8 || --budget.entries < 0) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") { budget.characters -= value.length; return value.length <= 4096 && budget.characters >= 0; }
  if (typeof value !== "object" || ancestors.has(value) || (!Array.isArray(value) && !record(value))) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.length <= 256 && value.every(item => boundedJson(item, depth + 1, budget, ancestors))
    : Object.entries(value).length <= 256 && Object.entries(value).every(([key, item]) =>
      key.length <= 128 && !prohibitedFields.test(key) && boundedJson(item, depth + 1, budget, ancestors));
  ancestors.delete(value); return valid;
}
function supported(key: string): boolean {
  return Object.hasOwn(validators, key) || structured.has(key) || /^browser-family-enabled:[a-z][a-z0-9-]{0,63}$/.test(key);
}
function validate(key: string, value: unknown): void {
  if (!supported(key)) throw new Error("Unsupported private desktop setting");
  const valid = key.startsWith("browser-family-enabled:") ? boolean(value) : structured.has(key) ? boundedJson(value) : validators[key]!(value);
  if (!valid) throw new Error(`Invalid value for private desktop setting ${key}`);
}

export function isDesktopPreferenceKey(keyPath: unknown): boolean {
  return typeof keyPath === "string" && keyPath.startsWith("desktop.") && supported(keyPath.slice(8));
}

/** Validate the desktop subtree of private preferences, independently of model. */
export function readDesktopPreferences(value: unknown): Settings {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 128) throw new Error("Private desktop settings must be an object");
  for (const [key, item] of Object.entries(value)) validate(key, item);
  return structuredClone(value);
}

/** Validate the entire batch before returning a new desktop subtree. */
export function applyDesktopEdits(current: Settings, edits: Settings[]): Settings {
  if (edits.length > 128) throw new Error("Too many private desktop setting edits");
  const result = readDesktopPreferences(current);
  for (const edit of edits) {
    if (typeof edit.keyPath !== "string" || !edit.keyPath.startsWith("desktop.")) throw new Error("Expected a private desktop setting edit");
    if (edit.mergeStrategy !== "replace" && edit.mergeStrategy !== "upsert") throw new Error("Private desktop settings require replace or upsert merge strategy");
    const key = edit.keyPath.slice(8); validate(key, edit.value);
    result[key] = structuredClone(edit.value);
  }
  return result;
}

/** Overlay app display preferences without discarding native desktop settings. */
export function mergeDesktopPreferences(config: Settings, desktop: Settings): Settings {
  const saved = readDesktopPreferences(desktop);
  return Object.keys(saved).length ? { ...config, desktop: { ...(record(config.desktop) ? config.desktop : {}), ...saved } } : { ...config };
}
