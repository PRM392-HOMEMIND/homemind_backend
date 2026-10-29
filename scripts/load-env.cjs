// Shell settings win; local secrets win over public defaults. Tests/CI never
// read a developer's private environment, including when Prisma is invoked.
function loadEnvironment() {
  if (['production', 'test'].includes(process.env.NODE_ENV) || process.env.CI || process.env.VITEST) return;
  const { config } = require('dotenv');
  config({ path: '.env.local' });
  config({ path: '.env' });
}
module.exports = { loadEnvironment };
