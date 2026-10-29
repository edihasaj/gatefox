import { AdmissionRegistry } from "./admission-registry.js";

/** Structural and versioned: hot-swapped modules have different class identities. */
export interface HandlerAdmissionState { version: 1; registry: AdmissionRegistry }
interface Participant { admissionState?: HandlerAdmissionState; isIdle(): boolean }
const key = Symbol.for("harness-gateway.server-admission.v1");
type Owner = { [key]?: HandlerAdmissionState };

/** A listener owns its queue budget across handler/release generations. */
export function bindServerAdmission(server: object, proposed: HandlerAdmissionState | undefined, previous: readonly Participant[]):
  { state: HandlerAdmissionState; legacyBusy: () => boolean } | undefined {
  if (!proposed) return;
  const owner = server as Owner;
  const state = owner[key] ?? proposed;
  owner[key] = state;
  // A pre-contract handler's private counters cannot be guessed. Providers using
  // discovered capacity wait for it to finish before increasing their budgets.
  const legacy = previous.filter(handler => handler.admissionState?.registry !== state.registry);
  return { state, legacyBusy: () => legacy.some(handler => !handler.isIdle()) };
}
