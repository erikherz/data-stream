// spatial-normalize: convert an experiencematters.cloud pose payload into the
// project's internal frame shape — a Hawkeye protobuf `Message{frame}`.
//
// The whole point: by normalizing to the SAME protobuf the Hawkeye feed emits,
// every downstream stage (KLV/ID3/AMF embedding, extract-verify, the browser
// player) works UNCHANGED. Only the source is swapped (see lib/frame-source.js).
//
// Mapping notes:
//  - joints: the NBA feed's 29 named joints -> the Hawkeye JointType enum. The
//    player indexes joints[i] by enum value, so we emit a DENSE, in-order array
//    of 29 joints (synthesizing the 4 spine/head points the NBA feed lacks).
//  - units: NBA positions are inches from center court; Hawkeye is meters from a
//    corner. meters = in*0.0254; then shift by half-court so origin is a corner.
//  - team/jersey: not in the pose frame — looked up once from the game index.

import { loadMessageType } from './data-tap.js';
import { SPATIAL_GAME } from './spatial-tap.js';

const INDEX_BASE = process.env.SPATIAL_INDEX_BASE ?? 'https://experiencematters.cloud';
export const indexUrlFor = (game = SPATIAL_GAME) =>
  `${INDEX_BASE}/api/spatial/games/${game}/index`;

// NBA court: 94 ft x 50 ft. Hawkeye court frame origin is a corner (meters).
const IN_TO_M = 0.0254;
const HALF_LEN_M = 28.65 / 2; // 14.325  (x, along length)
const HALF_WID_M = 15.24 / 2; // 7.62    (y, along width)
const toCourt = ([x, y, z]) => ({
  x: x * IN_TO_M + HALF_LEN_M,
  y: y * IN_TO_M + HALF_WID_M,
  z: z * IN_TO_M,
});

// NBA joint name -> Hawkeye JointType enum value (0..28).
const JOINT_MAP = {
  nose: 1,        // HEAD
  neck: 2,        // NECK
  lShoulder: 3, rShoulder: 4,
  lElbow: 5, rElbow: 6,
  lWrist: 7, rWrist: 8,
  lPinky: 9, rPinky: 10,   // LEFT_HAND / RIGHT_HAND (approx)
  lThumb: 11, rThumb: 12,
  midHip: 16,     // PELVIS
  lHip: 17, rHip: 18,
  lKnee: 19, rKnee: 20,
  lAnkle: 21, rAnkle: 22,
  lHeel: 23, rHeel: 24,
  lBigToe: 25, rBigToe: 26,
  lSmallToe: 27, rSmallToe: 28, // LEFT_FOOT / RIGHT_FOOT (approx)
};
// Enum slots the NBA feed has no direct joint for; we synthesize them.
const SYNTH = new Set([0, 13, 14, 15]); // HEAD_TOP, THORAX, STERNUM, SPINE_MID

// Build a dense 29-entry joints array (index == JointType) from one NBA person's
// joint dict ({ lWrist: [x,y,z], ... } in inches).
function buildJoints(nba) {
  const m = new Array(29).fill(null);
  for (const [name, idx] of Object.entries(JOINT_MAP)) {
    const v = nba[name];
    if (Array.isArray(v) && v.length === 3) m[idx] = toCourt(v);
  }
  // HEAD_TOP (0): eyes midpoint, else nose.
  const le = nba.lEye, re = nba.rEye;
  if (le && re) m[0] = toCourt([(le[0] + re[0]) / 2, (le[1] + re[1]) / 2, (le[2] + re[2]) / 2]);
  else if (nba.nose) m[0] = toCourt(nba.nose);
  // Spine points (13,14,15): interpolate NECK(2) -> PELVIS(16) so the torso draws.
  const neck = m[2], pel = m[16];
  if (neck && pel) {
    const lerp = (t) => ({ x: neck.x + (pel.x - neck.x) * t, y: neck.y + (pel.y - neck.y) * t, z: neck.z + (pel.z - neck.z) * t });
    m[13] = lerp(0.25); m[14] = lerp(0.45); m[15] = lerp(0.70);
  }
  // Keep the array dense + index-aligned: fill any remaining gap with the
  // pelvis/neck fallback so joints[i] always exists for the renderer.
  const fallback = m[16] || m[2] || m.find(Boolean) || { x: HALF_LEN_M, y: HALF_WID_M, z: 0 };
  const joints = [];
  for (let i = 0; i < 29; i++) {
    const pos = m[i] || fallback;
    joints.push({ type: i, pos, confidence: m[i] ? (SYNTH.has(i) ? 0.5 : 1) : 0 });
  }
  return joints;
}

const tsMs = (payload) => {
  const t = Date.parse(payload?.time?.timeUTC ?? '');
  return Number.isFinite(t) ? t : Date.now();
};

// Fetch the game index once to map nbaId -> { team enum, jersey }. Best-effort:
// on failure everyone renders TEAM_UNKNOWN (still valid, just one color).
async function loadRoster(game) {
  const team = new Map();
  const jersey = new Map();
  try {
    const res = await fetch(indexUrlFor(game));
    if (res.ok) {
      const idx = await res.json();
      const players = idx.players || {};
      const tricodes = [...new Set(Object.values(players).map((p) => p.team).filter(Boolean))].sort();
      // deterministic 2-color split (HOME=1, AWAY=2, others OFFICIALS=3)
      const tri2enum = new Map(tricodes.map((t, i) => [t, i === 0 ? 1 : i === 1 ? 2 : 3]));
      for (const [pid, p] of Object.entries(players)) {
        if (p.team) team.set(String(pid), tri2enum.get(p.team) ?? 0);
        const hit = (p.aliases || []).map((a) => /^#(\d+)$/.exec(a)).find(Boolean);
        if (hit) jersey.set(String(pid), Number(hit[1]));
      }
    }
  } catch { /* best-effort */ }
  return { team, jersey };
}

// Returns { normalize(payload) -> Uint8Array } producing encoded Message bytes.
export async function makeSpatialNormalizer({ game = SPATIAL_GAME } = {}) {
  const Message = await loadMessageType();
  const { team, jersey } = await loadRoster(game);

  function normalize(payload) {
    const s = payload?.samples ?? {};
    const people = (s.people ?? []).map((pr) => {
      const id = pr.playerId?.nbaId ?? 0;
      const key = String(id);
      return {
        id: id | 0,
        team: team.get(key) ?? 0,
        role: 1, // PLAYER
        jersey: jersey.get(key) ?? 0,
        joints: buildJoints(pr.joints?.[0] ?? {}),
      };
    });
    const ballPos = s.ball?.[0]?.pos;
    const frame = {
      frameId: payload?.sequences?.frame ?? payload?.feedNumber?.frame ?? 0,
      captureTimestampMs: tsMs(payload),
      people,
      ...(Array.isArray(ballPos) ? { ball: { pos: toCourt(ballPos) } } : {}),
    };
    return Message.encode({ frame }).finish();
  }

  return { normalize, rosterSize: team.size };
}
