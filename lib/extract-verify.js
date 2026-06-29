// extract-verify: the shared proof used by every protocol phase.
//
// "Embed + inspect" verification means: after a muxer embeds protobuf bytes
// into a container (TS data PID, FLV AMF tag, ID3 frame), we pull those bytes
// back out and assert they still decode to a valid Hawkeye Frame. This module
// is that final assertion — independent of how the bytes were carried.

import { loadMessageType, toNum } from './data-tap.js';

// Returns a verify(bytes) function. Throws if the bytes are not a decodable
// Message carrying a Frame; otherwise returns a small summary of the frame.
export async function makeVerifier() {
  const Message = await loadMessageType();
  return function verify(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const msg = Message.decode(u8);
    if (!msg.frame) throw new Error('decoded Message has no frame payload');
    const f = msg.frame;
    return {
      ok: true,
      frameId: toNum(f.frameId),
      captureTs: toNum(f.captureTimestampMs),
      people: f.people?.length ?? 0,
      hasBall: !!f.ball,
      bytes: u8.length,
    };
  };
}
