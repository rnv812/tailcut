// The one place this program widens a browser type, and it is here rather than at the call site
// so that the reason can be written down beside it.
//
// WebCodecs has a per-frame quantizer for HEVC exactly as it has one for H.264 — Chrome takes
// `{ hevc: { quantizer } }` and honours it — but the DOM library shipped with TypeScript declares
// only `avc` and `keyFrame` on `VideoEncoderEncodeOptions`. Passing the HEVC one is therefore
// TS2353, and a cast at the call site would say "trust me" without saying what about. This says
// what about.
//
// No import and no export on purpose: a module would not merge with the global interface, and
// merging is the whole point. Delete it the day the library grows the field.

interface VideoEncoderEncodeOptionsForHevc {
  quantizer?: number | null
}

interface VideoEncoderEncodeOptions {
  hevc?: VideoEncoderEncodeOptionsForHevc
}
