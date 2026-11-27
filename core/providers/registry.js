// @ts-check
// Provider registry. Providers are plain objects (see ./types.js). `providersFor(kind, {jurisdiction, keys})` returns the
// providers that cover the jurisdiction, primaries before fallbacks, then by priority, then registration order. A
// provider that needs a key and has none is not an error: it is reported in `skipped` as 'no API key'.

const KINDS = ['records', 'footprint', 'address', 'street', 'aerial'];
const ENTRY = { records: 'lookup', footprint: 'lookup', street: 'lookup', aerial: 'lookup', address: 'resolve' };

/** @param {any} p */
function validate(p) {
  if (!p || typeof p !== 'object') throw new TypeError('register: provider must be an object');
  if (typeof p.id !== 'string' || !p.id) throw new TypeError('register: provider.id is required');
  if (!KINDS.includes(p.kind)) throw new TypeError(`register(${p.id}): kind must be one of ${KINDS.join(', ')}`);
  if (typeof p.needsKey !== 'boolean') throw new TypeError(`register(${p.id}): needsKey must be a boolean`);
  if (typeof p[/** @type {Record<string,string>} */ (ENTRY)[p.kind]] !== 'function') throw new TypeError(`register(${p.id}): ${/** @type {Record<string,string>} */ (ENTRY)[p.kind]}() is required for kind '${p.kind}'`);
  if (!p.coverage || (p.coverage.national !== true && typeof p.coverage.state !== 'string')) throw new TypeError(`register(${p.id}): coverage must be {national:true} or {state, countyFips?}`);
}

/** @param {any} coverage @param {{state?:string, countyFips?:string}|undefined} j */
export function covers(coverage, j) {
  if (!j) return true;
  // {national:true, exceptCountyFips:[...]}: everywhere except counties another provider serves better (parcel-registry leaves out LA County)
  if (coverage.national) return !(j.countyFips && Array.isArray(coverage.exceptCountyFips) && coverage.exceptCountyFips.includes(j.countyFips));
  if (j.state && coverage.state.toUpperCase() !== j.state.toUpperCase()) return false;
  if (coverage.countyFips && j.countyFips && coverage.countyFips !== j.countyFips) return false;
  return true;
}

export function createRegistry() {
  /** @type {any[]} */
  const items = [];
  return {
    /** Add a provider. Throws on an invalid provider or a duplicate id. Returns the registry for chaining. */
    register(/** @type {any} */ provider) {
      validate(provider);
      if (items.some((x) => x.id === provider.id)) throw new Error(`register: duplicate provider id ${provider.id}`);
      items.push(provider);
      return this;
    },
    get: (/** @type {string} */ id) => items.find((x) => x.id === id) ?? null,
    list: (/** @type {string} [kind] */ kind) => items.filter((x) => !kind || x.kind === kind),
    /**
     * @param {string} kind
     * @param {{jurisdiction?:{state?:string,countyFips?:string}, keys?:Record<string,string|undefined>}} [opts]
     * @returns {{providers:any[], skipped:Array<{id:string, skipped:'no API key'}>}}
     */
    providersFor(kind, opts = {}) {
      const keys = opts.keys ?? {};
      const eligible = items.map((p, order) => ({ p, order })).filter(({ p }) => p.kind === kind && covers(p.coverage, opts.jurisdiction));
      eligible.sort((a, b) => (a.p.role === 'primary' ? 0 : 1) - (b.p.role === 'primary' ? 0 : 1) || (a.p.priority ?? 100) - (b.p.priority ?? 100) || a.order - b.order);
      const providers = [], skipped = [];
      for (const { p } of eligible) {
        if (p.needsKey && !(typeof keys[p.id] === 'string' && keys[p.id])) skipped.push({ id: p.id, skipped: /** @type {const} */ ('no API key') });
        else providers.push(p);
      }
      return { providers, skipped };
    },
  };
}

/** Process-wide registry for convenience; tests and servers should prefer createRegistry() / createDefaultRegistry(). */
const shared = createRegistry();
export const register = (/** @type {any} */ p) => shared.register(p);
export const get = (/** @type {string} */ id) => shared.get(id);
export const list = (/** @type {string} [kind] */ kind) => shared.list(kind);
export const providersFor = (/** @type {string} */ kind, /** @type {any} */ opts) => shared.providersFor(kind, opts);

/**
 * The built-in providers, in a fresh registry. Imported lazily so registry.js has no import cycle with adapters.
 * Footprints: in LA County the one provider is LARIAC wrapped by withOvertureFallback (LARIAC first; Overture only when LARIAC finds
 * nothing or fails); everywhere else it is Overture (coverage: national except LA County). Records: the keyed primary, then the LA
 * assessor (LA County only), then the nationwide parcel registry (national except LA County). The assembler needs no change to get this.
 */
export async function createDefaultRegistry() {
  const [{ laAssessor }, { lariacBuildings }, { laCamsAddress }, { censusAddress }, { rentcast }, { googleSolar }, { overtureBuildings, withOvertureFallback }, { parcelRegistry }, { overtureRoads }, { naipAerial }] = await Promise.all([
    import('./la-assessor.js'), import('./lariac-buildings.js'), import('./la-cams-address.js'), import('./census-address.js'),
    import('./rentcast.js'), import('./google-solar.js'), import('./overture-buildings.js'), import('./parcel-registry.js'), import('./overture-roads.js'), import('./naip-aerial.js'),
  ]);
  const r = createRegistry();
  for (const p of [laCamsAddress, censusAddress, rentcast, laAssessor, { ...parcelRegistry, needsPointInParcel: true }, googleSolar, { ...withOvertureFallback(lariacBuildings), needsParcel: true }, overtureBuildings, overtureRoads, naipAerial]) r.register(p);
  return r;
}
