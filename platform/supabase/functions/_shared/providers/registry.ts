// Finds the adapter for a channel. Adding a provider = one new file exporting an adapter + one `registerAdapter` call
// (see providers/index.ts). Removing or replacing one never touches the sync code.
//
// Lookup order for (channel, method): the channel's own adapter if it has that method, then the generic calendar-link
// adapter ('*'), then the manual file-import adapter ('manual'). Fallback adapters must never implement `verifyClosed`
// (they cannot know whether a site's export tells bookings from blocks), so an unknown site is never "verifiable".
import {
  CAPABILITY_KEYS, LEVELS, levelRank, NO_CAPABILITIES,
  type Capabilities, type MethodName, type ProviderAdapter,
} from './adapter.ts';

export const FALLBACK_KEYS: readonly string[] = ['*', 'manual'];
const KEY_RE = /^(\*|[a-z][a-z0-9_]*)$/;
const METHODS: readonly MethodName[] = ['importAvailability', 'exportAvailability', 'parseBookingFile', 'verifyClosed'];

export type WithMethod<M extends MethodName> = ProviderAdapter & Required<Pick<ProviderAdapter, M>>;

/** Rejects adapters that claim something they have no way to do. */
export function validateAdapter(a: ProviderAdapter): void {
  if (!a || typeof a.key !== 'string' || !KEY_RE.test(a.key)) throw new Error(`Invalid adapter key: ${String(a?.key)}`);
  if (typeof a.label !== 'string' || !a.label) throw new Error(`Adapter ${a.key} needs a label`);
  if (!Array.isArray(a.limits)) throw new Error(`Adapter ${a.key} needs a limits array`);
  for (const k of CAPABILITY_KEYS) {
    if (!LEVELS.includes(a.capabilities?.[k])) throw new Error(`Adapter ${a.key}: capability ${k} must be one of ${LEVELS.join(', ')}`);
  }
  for (const m of METHODS) if (a[m] !== undefined && typeof a[m] !== 'function') throw new Error(`Adapter ${a.key}: ${m} must be a function or absent`);
  const c = a.capabilities;
  if (c.calendar !== 'L0' && !a.importAvailability && !a.exportAvailability) throw new Error(`Adapter ${a.key} claims calendar ${c.calendar} but implements neither importAvailability nor exportAvailability`);
  if (c.booking !== 'L0' && !a.parseBookingFile) throw new Error(`Adapter ${a.key} claims booking ${c.booking} but has no parseBookingFile`);
}

export function createRegistry() {
  const adapters = new Map<string, ProviderAdapter>();
  const chain = (channelKey: string): ProviderAdapter[] => {
    const out: ProviderAdapter[] = [];
    const own = adapters.get(channelKey);
    if (own) out.push(own);
    for (const k of FALLBACK_KEYS) { const f = adapters.get(k); if (f && f !== own) out.push(f); }
    return out;
  };
  return {
    /** Adds an adapter, or replaces the one with the same key. */
    registerAdapter(adapter: ProviderAdapter): void { validateAdapter(adapter); adapters.set(adapter.key, adapter); },
    /** Removes an adapter. Returns false if there was none. Other adapters and fallbacks keep working. */
    unregisterAdapter(key: string): boolean { return adapters.delete(key); },
    /** The adapter that can do `method` for this channel, or undefined (callers feature-detect). */
    adapterFor<M extends MethodName>(channelKey: string, method: M): WithMethod<M> | undefined {
      return chain(channelKey).find((a) => typeof a[method] === 'function') as WithMethod<M> | undefined;
    },
    listAdapters(): ProviderAdapter[] { return [...adapters.values()].sort((a, b) => a.key.localeCompare(b.key)); },
    /** Best level per dimension over the channel's own adapter and the fallbacks (what Everyspace can really do for it). */
    capabilityOf(channelKey: string): Capabilities {
      const out: Capabilities = { ...NO_CAPABILITIES };
      for (const a of chain(channelKey)) for (const k of CAPABILITY_KEYS) if (levelRank(a.capabilities[k]) > levelRank(out[k])) out[k] = a.capabilities[k];
      return out;
    },
    /** Display name from the channel's own adapter; unknown channels show their key. */
    labelOf(channelKey: string): string { return adapters.get(channelKey)?.label ?? channelKey; },
    /** Caveats for hosts: the channel's own, then the fallbacks', without repeats. */
    limitsOf(channelKey: string): string[] { return [...new Set(chain(channelKey).flatMap((a) => a.limits))]; },
    /** True only if the channel's calendar can prove dates are closed there. */
    canVerifyClosed(channelKey: string): boolean { return typeof adapters.get(channelKey)?.verifyClosed === 'function'; },
  };
}

export type Registry = ReturnType<typeof createRegistry>;

const shared = createRegistry();
export const registerAdapter = shared.registerAdapter;
export const unregisterAdapter = shared.unregisterAdapter;
export const adapterFor = shared.adapterFor;
export const listAdapters = shared.listAdapters;
export const capabilityOf = shared.capabilityOf;
export const labelOf = shared.labelOf;
export const limitsOf = shared.limitsOf;
export const canVerifyClosed = shared.canVerifyClosed;
