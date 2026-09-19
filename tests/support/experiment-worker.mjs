import { createExperimentDelivery } from '../../worker/experiments/delivery.mjs';
import { experimentFixture, experimentConfig } from './experiment-fixture.mjs';

// LOCAL workerd fixture, never imported by an application Worker or deployed.
let initialized;
export default {
  async fetch(request, env) {
    if (env.LOCAL_EXPERIMENT_FIXTURE !== 'true' || new URL(request.url).hostname !== 'experiment.invalid') {
      return new Response(null, {status:404});
    }
    if (!initialized) initialized = (async () => {
      const candidate = await experimentFixture();
      const config = experimentConfig(candidate, candidate, {
        enabled:env.EXPERIMENT_ENABLED === 'true', trafficB:Number(env.EXPERIMENT_TEST_PERCENT),
      });
      return createExperimentDelivery(config, {[candidate.descriptor.packageSha256]:candidate});
    })();
    return (await initialized).fetch(request);
  },
};
