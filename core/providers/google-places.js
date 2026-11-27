// @ts-check
// Google Places (New) -- ONLY the pure, server-independent part: turn a place object into Everyspace's normalised address.
// No network, no key, no script loading here; the browser autocomplete widget is wired separately once a key exists.
// Accepts the REST shape ({id, formattedAddress, location:{latitude,longitude}, addressComponents:[{longText,shortText,types}]}),
// the shape in the brief ({location:{lat,lng}}), and the JS library shape (location.lat()/lng(), long_name/short_name).

/** @param {any} v @param {'lat'|'lng'} axis */
function coord(v, axis) {
  if (!v) return null;
  const long = axis === 'lat' ? 'latitude' : 'longitude';
  const raw = typeof v[axis] === 'function' ? v[axis]() : v[axis] ?? v[long];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * @param {any} place
 * @returns {{ok:true, address:string, lat:number, lng:number, placeId:string, components:{houseNumber:string|null, street:string|null, city:string|null, county:string|null, state:string|null, zip:string|null, country:string|null}}|{ok:false, reason:string}}
 */
export function normalizePlace(place) {
  if (!place || typeof place !== 'object') return { ok: false, reason: 'no place object' };
  const placeId = typeof place.id === 'string' && place.id ? place.id : typeof place.place_id === 'string' && place.place_id ? place.place_id : null;
  const address = typeof place.formattedAddress === 'string' && place.formattedAddress.trim() ? place.formattedAddress.trim()
    : typeof place.formatted_address === 'string' && place.formatted_address.trim() ? place.formatted_address.trim() : null;
  const lat = coord(place.location, 'lat'), lng = coord(place.location, 'lng');
  if (!placeId) return { ok: false, reason: 'place has no id' };
  if (!address) return { ok: false, reason: 'place has no formatted address' };
  if (lat === null || lng === null) return { ok: false, reason: 'place has no location' };
  const comps = Array.isArray(place.addressComponents) ? place.addressComponents : Array.isArray(place.address_components) ? place.address_components : [];
  const get = (/** @type {string} */ type, /** @type {'long'|'short'} */ form = 'long') => {
    const c = comps.find((x) => Array.isArray(x?.types) && x.types.includes(type));
    if (!c) return null;
    const v = form === 'long' ? c.longText ?? c.long_name : c.shortText ?? c.short_name;
    return typeof v === 'string' && v ? v : null;
  };
  return { ok: true, address, lat, lng, placeId, components: {
    houseNumber: get('street_number'), street: get('route'), city: get('locality') ?? get('sublocality'), county: get('administrative_area_level_2'),
    state: get('administrative_area_level_1', 'short'), zip: get('postal_code'), country: get('country', 'short') } };
}
