// The one place this program widens a browser type, and it is here rather than at the call site
// so that the reason can be written down beside it.
//
// WebCodecs has a per-frame quantizer for HEVC and VP9 exactly as it has one for H.264 — Chrome
// takes `{ hevc: { quantizer } }` and `{ vp9: { quantizer } }` and honours them, the VP9 one on
// libvpx's 0–63 scale — but the DOM library shipped with TypeScript declares only `avc` and
// `keyFrame` on `VideoEncoderEncodeOptions`. Passing either of the others is therefore TS2353,
// and a cast at the call site would say "trust me" without saying what about. This says what
// about.
//
// No import and no export on purpose: a module would not merge with the global interface, and
// merging is the whole point. Delete it the day the library grows the fields.

interface VideoEncoderEncodeOptionsForHevc {
  quantizer?: number | null
}

interface VideoEncoderEncodeOptionsForVp9 {
  quantizer?: number | null
}

interface VideoEncoderEncodeOptions {
  hevc?: VideoEncoderEncodeOptionsForHevc
  vp9?: VideoEncoderEncodeOptionsForVp9
}
