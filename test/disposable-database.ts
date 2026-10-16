export function requireDisposableDatabase(env: NodeJS.ProcessEnv = process.env) {
  const reject = () => { throw new Error('A disposable loopback test database or the existing isolated CI fixture is required'); };
  if (env.NODE_ENV !== 'test' || !env.MIGRATION_DATABASE_URL) reject();
  for (const value of [env.MIGRATION_DATABASE_URL, env.DATABASE_URL].filter(Boolean)) {
    let target: URL;
    try { target = new URL(value!); } catch { reject(); return; }
    const testName = /^\/[A-Za-z0-9_]+_test$/.test(target.pathname);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && testName;
    const isolatedCi = env.HOMEMIND_ISOLATED_CI === '1' && target.hostname === 'db'
      && (!target.port || target.port === '5432')
      && (testName || ['/homemind', '/homemind_upgrade'].includes(target.pathname));
    if (!['postgresql:', 'postgres:'].includes(target.protocol) || (!loopback && !isolatedCi)) reject();
  }
}
