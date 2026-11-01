// Shared by the browser and Edge Function. Add public image paths here, then redeploy both.
export const catalogue = [
  {
    id: 'das-chicks', revision: 1, title: 'Chicks on open ground',
    path: '/images/chicks-free-range.jpg', zone: 'Das demonstration area',
    credit: 'Existing project reference photo; original attribution pending', sourceUrl: null,
    sample: {
      observations: ['Several chicks are visible on bare ground; the foreground chick is clearer than the background birds.', 'No feeder or drinker is clearly identifiable in this frame.'],
      concerns: ['Resource access cannot be assessed from this close-up.'],
      next_checks: ['Take a wider photograph that includes the flock and its feeders and drinkers.'],
      limitations: ['Prepared sample, not model-generated analysis.', 'One still cannot establish movement, feeding frequency, temperature, ammonia, disease or flock health.']
    }
  },
  {
    id: 'das-shelter', revision: 1, title: 'Flock beneath a shelter',
    path: '/images/flock-house.jpg', zone: 'Das demonstration shelter',
    credit: 'Existing project reference photo; original attribution pending', sourceUrl: null,
    sample: {
      observations: ['Many white chickens are visible beneath a covered mesh-sided shelter.', 'Birds overlap, grass is visible, and parts of the image are out of focus.'],
      concerns: ['Overlap limits visibility of individual birds. This frame alone does not establish abnormal crowding.'],
      next_checks: ['Obtain a wider, sharper view showing resource locations and the full usable floor area.'],
      limitations: ['Prepared sample, not model-generated analysis.', 'No stocking-density measurement, drinking activity or health diagnosis can be established from this frame alone.']
    }
  }
];
export const resultKeys = ['observations', 'concerns', 'next_checks', 'limitations'];
export function validateResult(value) {
  if (!value || typeof value !== 'object' || resultKeys.some(key => !Array.isArray(value[key]) || value[key].length > 12 || value[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 2000))) {
    throw new Error('The model returned an invalid analysis. Please try again.');
  }
  return Object.fromEntries(resultKeys.map(key => [key, value[key]]));
}
export function resolveDasFarmId(memberships, userId, configuredId) {
  if (configuredId) return memberships.some(m => m.farm_id === configuredId) ? configuredId : null;
  // Compatibility with the existing seeded Das account, until its farm ID is configured.
  if (userId !== '6f43ca55-ce1b-46b1-be32-f55c117bc3be') return null;
  const matches = memberships.filter(m => m.role === 'owner' && m.farm?.name === 'Das Farm');
  return matches.length === 1 ? matches[0].farm_id : null;
}
export function sampleRecord(image, farmId, userId, id, now) {
  return { id, farm_id: farmId, created_by: userId, image_id: image.id, image_revision: image.revision,
    image_title: image.title, image_path: image.path, mode: 'sample', status: 'complete',
    model: null, created_at: now, result: validateResult(image.sample) };
}
