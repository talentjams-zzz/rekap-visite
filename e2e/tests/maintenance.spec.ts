// v1 test_monthly_cleanup.py counterpart.
// v2's monthly maintenance job (backup + archived-row removal +
// lastMaintenance bookkeeping) is planned in P9 (hardening). The spec body
// marks itself fixme until that lands, keeping the port mapping explicit.
import { test } from '../helpers/fixture.js';

test('monthly maintenance: backup, verify, remove archived, record lastMaintenance (P9)', () => {
  // v2 monthly maintenance job lands in P9.
  test.fixme();
});
