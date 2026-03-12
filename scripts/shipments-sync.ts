import 'dotenv/config';
import { runShipmentsSyncJob } from '../src/jobs/shipmentsSyncJob';

const run = async () => {
  const result = await runShipmentsSyncJob();
  console.log('[shipments-sync]', result);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
