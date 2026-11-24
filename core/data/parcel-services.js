// @ts-check
// Data-driven registry of public parcel services. Add a jurisdiction by adding an object here; no code changes.
//
// Entry shape:
//  id, coverage {state:'CA', countyFips?:'06037'}  (an entry with countyFips is tried before a statewide entry)
//  kind 'arcgis-feature'; url = the layer's /query endpoint
//  fields: map from our names to the service's field names:
//    apn, address, useType, yearBuilt, bedrooms, livingAreaSqft, units, lotAreaSqft?  (all but apn optional)
//    useCode, useDescription optional extras used for classification
//  useCodeScheme?: 'la-assessor' enables LA use-code rules in property_type classification
//  publisher, termsUrl, license
//
// Provenance of this file: the LA entry is copied from index.html:19399-19400 (url + field names). The other CA
// entries are the county services listed in City Pretty app/data/parcel_services.json at commit ac7faf3, with only
// the APN and address fields (the rest were not mapped). Their termsUrl is City Pretty's `terms`, which is a
// service page, not a licence grant. Licences were not verified.

const NOT_VERIFIED = 'not verified 2026-11-24';

/** @typedef {{id:string, coverage:{state:string, countyFips?:string}, kind:'arcgis-feature', url:string,
 *   fields:{apn:string, address?:string, useType?:string, useCode?:string, useDescription?:string, yearBuilt?:string,
 *   bedrooms?:string, livingAreaSqft?:string, units?:string, lotAreaSqft?:string}, useCodeScheme?:string,
 *   publisher:string, termsUrl:string, license:string}} ParcelService */

/** @type {ParcelService[]} */
export const PARCEL_SERVICES = [
  {
    id: 'la-county-assessor',
    coverage: { state: 'CA', countyFips: '06037' },
    kind: 'arcgis-feature',
    url: 'https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query',
    fields: {
      apn: 'AIN', address: 'SitusFullAddress', useCode: 'UseCode', useType: 'UseType', useDescription: 'UseDescription',
      livingAreaSqft: 'SQFTmain1', units: 'Units1', yearBuilt: 'YearBuilt1', bedrooms: 'Bedrooms1',
    },
    useCodeScheme: 'la-assessor',
    publisher: 'LA County Assessor (via LA County GIS)',
    termsUrl: 'https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer',
    license: NOT_VERIFIED,
  },
  {
    id: 'kern-bakersfield-cadastre',
    coverage: { state: 'CA', countyFips: '06029' },
    kind: 'arcgis-feature',
    url: 'https://gis.bakersfieldcity.us/webmaps/rest/services/General/Cadastre/MapServer/1/query',
    fields: { apn: 'APN_ID', address: 'ADDR_ID' },
    publisher: 'City of Bakersfield & Kern County Cadastre Parcels',
    termsUrl: 'https://gis.bakersfieldcity.us/webmaps/rest/services/General/Cadastre/MapServer',
    license: NOT_VERIFIED,
  },
  {
    id: 'san-diego-sangis',
    coverage: { state: 'CA', countyFips: '06073' },
    kind: 'arcgis-feature',
    url: 'https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0/query',
    fields: { apn: 'apn', address: 'situs_address' },
    publisher: 'SanGIS Parcels (hosted by SANDAG)',
    termsUrl: 'https://geo.sandag.org/server/rest/services/Hosted/Parcels/FeatureServer/0?f=json',
    license: NOT_VERIFIED,
  },
  {
    id: 'orange-county-gis',
    coverage: { state: 'CA', countyFips: '06059' },
    kind: 'arcgis-feature',
    url: 'https://ocgis.com/arcpub/rest/services/Map_Layers/Parcels/MapServer/0/query',
    fields: { apn: 'ASSESSMENT_NO', address: 'SITE_ADDRESS' },
    publisher: 'Orange County GIS Parcels',
    termsUrl: 'https://ocgis.com/arcpub/rest/services/Map_Layers/Parcels/MapServer/0',
    license: NOT_VERIFIED,
  },
  {
    id: 'riverside-county-gis',
    coverage: { state: 'CA', countyFips: '06065' },
    kind: 'arcgis-feature',
    url: 'https://gis.countyofriverside.us/arcgis_mapping/rest/services/OpenData/Assessor/MapServer/50/query',
    fields: { apn: 'APN', address: 'SITUS_STREET' },
    publisher: 'Riverside County GIS Parcels',
    termsUrl: 'https://gis.countyofriverside.us/arcgis_mapping/rest/services/OpenData/Assessor/MapServer/50',
    license: NOT_VERIFIED,
  },
  {
    id: 'san-bernardino-county-gis',
    coverage: { state: 'CA', countyFips: '06071' },
    kind: 'arcgis-feature',
    url: 'https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/San_Bernardino_County_Parcel_Dataset/FeatureServer/0/query',
    fields: { apn: 'APN' },
    publisher: 'San Bernardino County GIS Parcels',
    termsUrl: 'https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/San_Bernardino_County_Parcel_Dataset/FeatureServer/0',
    license: NOT_VERIFIED,
  },
];
