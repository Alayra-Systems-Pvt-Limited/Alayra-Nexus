// The dashboard's view of the provider presets.
//
// Imports the gateway's own table rather than restating it. That import crosses out of web/src on
// purpose: src/data/providers.ts is pure data with no Node dependency, so Vite bundles it and tsc
// typechecks it, and the alternative — a second copy kept honest by a fixture test — is exactly the
// arrangement this table was created to end. The dashboard's defaults and the gateway's defaults
// are the same defaults; if they can drift, one of them is wrong on somebody's screen.
export {
  PROVIDER_PRESETS, presetFor, providerDefaultUrl, providerLabel, publishesPricing,
  type ProviderPreset,
} from '../../../src/data/providers';
