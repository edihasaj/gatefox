// Experimental native-picker catalog for a COPY of Claude.app. Builds Anthropic-shaped catalog entries for locally
// declared gateway routes and patches two exact anchors in the app's bundled model-picker asset so those entries merge
// into the surface's raw model list before the app's own normalization. Pure string/data work: no network, no
// credentials, no signature, authentication, permission or managed-effort-cap changes. Anchors fail closed.
const ROUTE_ID = /^claude-hg-route-[0-9]+$/;
const MAX_MODELS = 200;
const MAX_SCANNED = 64; // reasoning levels or service tiers inspected per model
const MAX_ID = 64;
const MAX_LABEL = 80;
const MAX_CONTEXT = 10_000_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const EFFORTS = new Map([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]);
const PATCH_MARKER = '__hgNativeCatalog';

export class CatalogError extends Error {
  constructor(message) {
    super(`native catalog: ${message}`);
    this.name = 'CatalogError';
    this.code = 'ERR_NATIVE_CATALOG';
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function label(value, what) {
  if (typeof value !== 'string') throw new CatalogError(`${what} must be a string`);
  const text = value.trim();
  if (!text || text.length > MAX_LABEL || CONTROL.test(text)) throw new CatalogError(`${what} must be 1-${MAX_LABEL} printable characters`);
  return text;
}

function effortId(level) {
  const id = typeof level === 'string' ? level : isObject(level) && typeof level.effort === 'string' ? level.effort : undefined;
  return EFFORTS.has(id) ? id : undefined;
}

function effortOptions(levels) {
  if (!Array.isArray(levels)) return [];
  const seen = new Set();
  for (const level of levels.slice(0, MAX_SCANNED)) {
    const id = effortId(level);
    if (id) seen.add(id);
  }
  return [...EFFORTS].filter(([id]) => seen.has(id)).map(([id, name]) => ({ id, name, description: `${name} reasoning effort` }));
}

const hasPriorityTier = tiers => Array.isArray(tiers) && tiers.slice(0, MAX_SCANNED).some(tier => isObject(tier) && tier.id === 'priority');

/** Native catalog entries for the locally declared `claude-hg-route-N` models only. Unknown efforts and tiers are dropped. */
export function buildNativeCatalog(input) {
  if (!isObject(input) || !Array.isArray(input.models)) throw new CatalogError('input must be { models: [...] }');
  if (input.models.length > MAX_MODELS) throw new CatalogError(`at most ${MAX_MODELS} models are accepted`);
  const seen = new Set();
  const entries = [];
  for (const model of input.models) {
    if (!isObject(model)) throw new CatalogError('every model must be an object');
    if (typeof model.slug !== 'string' || !ROUTE_ID.test(model.slug)) continue;
    if (model.slug.length > MAX_ID) throw new CatalogError('model id is too long');
    if (seen.has(model.slug)) throw new CatalogError(`duplicate model id ${model.slug}`);
    seen.add(model.slug);
    const entry = { id: model.slug, name: label(model.display_name, `${model.slug} display_name`) };
    const options = effortOptions(model.supported_reasoning_levels);
    if (options.length) entry.thinking = { type: 'effort', always_on: true, effort_options: options };
    if (Number.isSafeInteger(model.context_window) && model.context_window > 0 && model.context_window <= MAX_CONTEXT) entry.context_window = model.context_window;
    if (hasPriorityTier(model.service_tiers)) entry.fast_mode = { type: 'toggle', options: [{ id: 'off', name: 'Standard' }, { id: 'fast', name: 'Fast' }] };
    entries.push(entry);
  }
  return entries;
}

const exactKeys = (value, allowed, what) => {
  if (!isObject(value)) throw new CatalogError(`${what} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new CatalogError(`${what} has unexpected field ${JSON.stringify(key)}`);
};

/** Re-validates an already built entry list so patching never embeds anything buildNativeCatalog would not produce. */
function validateBuilt(entries) {
  if (entries.length > MAX_MODELS) throw new CatalogError(`at most ${MAX_MODELS} entries are accepted`);
  const seen = new Set();
  for (const entry of entries) {
    exactKeys(entry, ['id', 'name', 'thinking', 'context_window', 'fast_mode'], 'entry');
    if (typeof entry.id !== 'string' || !ROUTE_ID.test(entry.id) || entry.id.length > MAX_ID) throw new CatalogError('entry id is not an eligible route id');
    if (seen.has(entry.id)) throw new CatalogError(`duplicate entry id ${entry.id}`);
    seen.add(entry.id);
    if (label(entry.name, 'entry name') !== entry.name) throw new CatalogError('entry name must be trimmed');
    if (entry.thinking !== undefined) {
      exactKeys(entry.thinking, ['type', 'always_on', 'effort_options'], 'thinking');
      if (entry.thinking.type !== 'effort' || entry.thinking.always_on !== true || !Array.isArray(entry.thinking.effort_options) || !entry.thinking.effort_options.length || entry.thinking.effort_options.length > EFFORTS.size) {
        throw new CatalogError('thinking is not a valid effort control');
      }
      const ids = new Set();
      for (const option of entry.thinking.effort_options) {
        exactKeys(option, ['id', 'name', 'description'], 'effort option');
        if (!EFFORTS.has(option.id) || ids.has(option.id)) throw new CatalogError('effort option is unknown or repeated');
        ids.add(option.id);
        if (option.name !== EFFORTS.get(option.id) || option.description !== `${option.name} reasoning effort`) throw new CatalogError('effort option labels are not the canonical ones');
      }
    }
    if (entry.context_window !== undefined && !(Number.isSafeInteger(entry.context_window) && entry.context_window > 0 && entry.context_window <= MAX_CONTEXT)) {
      throw new CatalogError('context_window is out of range');
    }
    if (entry.fast_mode !== undefined) {
      exactKeys(entry.fast_mode, ['type', 'options'], 'fast_mode');
      const options = entry.fast_mode.options;
      if (entry.fast_mode.type !== 'toggle' || !Array.isArray(options) || options.length !== 2
        || options[0]?.id !== 'off' || options[0].name !== 'Standard' || options[1]?.id !== 'fast' || options[1].name !== 'Fast'
        || Object.keys(options[0]).length !== 2 || Object.keys(options[1]).length !== 2) throw new CatalogError('fast_mode is not the standard on/off toggle');
    }
  }
  return entries;
}

function resolveEntries(catalog) {
  const entries = Array.isArray(catalog) ? validateBuilt(catalog) : buildNativeCatalog(catalog);
  if (!entries.length) throw new CatalogError('no eligible claude-hg-route models to expose');
  return entries;
}

// Exact minified anchors of the verified Claude build. Each must occur once or patching refuses.
const MERGE_ANCHOR = 'l=e?.models,u=UR(HR(l?.map(e=>MR(e,i))??[],o)';
const MERGE_REPLACEMENT = 'l=__hgMergeModels(e?.models),u=UR(HR(l?.map(e=>MR(e,i))??[],o)';
const CAPABILITY_ANCHOR = 'hasCapability:(e,t)=>{let n=m(e);return!!n&&n.capabilities?.[t]!==!1}';
const CAPABILITY_REPLACEMENT = 'hasCapability:(e,t)=>{let n=m(e);return!!n&&(l?.some(r=>r?.id===n.id&&__hgInjected.has(r))?n.capabilities?.[t]===!0:n.capabilities?.[t]!==!1)}';

function countOf(source, anchor) {
  let count = 0;
  for (let at = source.indexOf(anchor); at !== -1; at = source.indexOf(anchor, at + anchor.length)) count += 1;
  return count;
}

function replaceOnce(source, anchor, replacement, what) {
  const found = countOf(source, anchor);
  if (found !== 1) throw new CatalogError(`${what} anchor must appear exactly once in the asset (found ${found})`);
  const at = source.indexOf(anchor);
  return source.slice(0, at) + replacement + source.slice(at + anchor.length);
}

/** A JS string literal that is also safe inside HTML and old line-terminator rules. */
const jsLiteral = text => JSON.stringify(text).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

function helperSource(entries) {
  return `/*${PATCH_MARKER}*/const __hgEntries=JSON.parse(${jsLiteral(JSON.stringify(entries))});`
    + 'const __hgInjected=new WeakSet(),__hgMemo=new WeakMap();let __hgFallback;'
    + 'function __hgAdd(a){const h=new Set();for(const e of a)if(e&&typeof e==="object")h.add(e.id);'
    + 'const x=__hgEntries.filter(e=>!h.has(e.id));for(const e of x)__hgInjected.add(e);return x.length?[...a,...x]:a}'
    + 'function __hgMergeModels(a){if(a===undefined||a===null)return __hgFallback??(__hgFallback=__hgAdd([]));'
    + 'if(!Array.isArray(a))return a;let r=__hgMemo.get(a);if(r===undefined){r=__hgAdd(a);__hgMemo.set(a,r)}return r}\n';
}

/**
 * Patch the picker asset text. `catalog` is the array from buildNativeCatalog or raw `{ models }`. The helper is
 * prepended (imports are hoisted, so this is valid module code) and the two anchors are rewritten in place.
 */
export function patchNativeCatalogAsset(source, catalog) {
  if (typeof source !== 'string' || !source) throw new CatalogError('asset source must be a non-empty string');
  if (source.includes('__hg')) throw new CatalogError('asset already contains native catalog helper names');
  const entries = resolveEntries(catalog);
  let next = replaceOnce(source, MERGE_ANCHOR, MERGE_REPLACEMENT, 'model-list');
  next = replaceOnce(next, CAPABILITY_ANCHOR, CAPABILITY_REPLACEMENT, 'capability');
  return helperSource(entries) + next;
}
