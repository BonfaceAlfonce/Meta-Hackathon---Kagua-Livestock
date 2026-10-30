import { demoImageUrls } from '../../supabase/functions/_shared/demo-images.js';
// Ordered Das Farm gallery references supplied by the farm owner.
export const dasDemoGallery = demoImageUrls.map((src, index) => ({
  id: `das-gallery-${index + 1}`, src,
  zone: `Das Farm · reference ${index + 1}`, time: 'Demo reference photo',
  is_night: false, isDemo: true,
  note: 'Owner-supplied reference image for demonstration; not a Das Farm camera capture or AI assessment.',
}));
