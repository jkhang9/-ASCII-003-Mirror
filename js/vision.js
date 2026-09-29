// MediaPipe Tasks (vision): a hand landmarker for gestures and a selfie
// segmenter for a clean silhouette. Both run locally via WebAssembly.

export const MP_VERSION = '1.0.1';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

let pending = null;

export function loadVision() {
  if (!pending) pending = load();
  return pending;
}

async function load() {
  const vision = await import(`${MP_BASE}/vision_bundle.mjs`);
  const { FilesetResolver, HandLandmarker, ImageSegmenter } = vision;
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);

  const create = async (Task, options) => {
    try {
      return await Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
    } catch (err) {
      console.warn('[ascii-camera] GPU delegate unavailable, using CPU', err);
      return Task.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    }
  };

  const [hands, segmenter] = await Promise.allSettled([
    create(HandLandmarker, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    create(ImageSegmenter, {
      baseOptions: { modelAssetPath: SEG_MODEL },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    }),
  ]);

  if (hands.status === 'rejected') console.warn('[ascii-camera] hand model failed', hands.reason);
  if (segmenter.status === 'rejected') console.warn('[ascii-camera] segmenter failed', segmenter.reason);
  if (hands.status === 'rejected' && segmenter.status === 'rejected') throw hands.reason;

  return {
    hands: hands.status === 'fulfilled' ? hands.value : null,
    segmenter: segmenter.status === 'fulfilled' ? segmenter.value : null,
  };
}
